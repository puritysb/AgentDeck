// OpenClawAdapter.swift — OpenClaw Gateway WebSocket client
// Ported from bridge/src/adapters/openclaw.ts

import Foundation

enum OpenClawGatewayTokenParser {
    /// SSOT for pulling the gateway token out of an OpenClaw `openclaw.json`
    /// object. The token can sit at any of three paths depending on how
    /// OpenClaw was set up — walked in canonical-first order. Returns the
    /// first non-empty trimmed string, or nil.
    static func extractToken(from json: [String: Any]) -> String? {
        let candidates: [[String]] = [
            ["gateway", "auth", "token"],
            ["auth", "token"],
            ["gateway", "token"],
        ]
        for path in candidates {
            var node: Any = json
            for (i, key) in path.enumerated() {
                guard let dict = node as? [String: Any], let next = dict[key] else { break }
                if i == path.count - 1 {
                    if let str = next as? String {
                        let trimmed = str.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty { return trimmed }
                    }
                    break
                }
                node = next
            }
        }
        return nil
    }
}

#if os(macOS)
import CryptoKit
import Security

enum OpenClawGatewayTokenStore {
    private static let service = "bound.serendipity.agent.deck.openclaw.gateway-token"
    private static let account = "default"

    static func loadToken() -> String? {
        var query = keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    static func saveToken(_ token: String) throws {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            try deleteToken()
            return
        }
        let data = Data(trimmed.utf8)
        let query = keychainQuery()
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(addStatus), userInfo: nil)
        }
    }

    static func deleteToken() throws {
        let status = SecItemDelete(keychainQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
        }
    }

    private static func keychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    static func extractToken(from json: [String: Any]) -> String? {
        OpenClawGatewayTokenParser.extractToken(from: json)
    }

    /// Re-read the gateway token from the user-selected `openclaw.json`
    /// (if a security-scoped bookmark was granted during "Import token") and
    /// persist it to Keychain. Lets a rotated `gateway.auth.token` flow back
    /// in automatically on the next gateway (re)connect without the user
    /// re-running the import. No-op when no bookmark exists or the file can't
    /// be read/parsed — the previously-saved Keychain value stays in effect.
    /// App-Store-safe: access is via the existing security-scoped bookmark
    /// (`files.user-selected.read-write` + `files.bookmarks.app-scope`); no
    /// subprocess, no path outside the user's original selection.
    static func refreshFromConfigBookmark() {
        _ = AppPreferences.shared.withOpenClawConfigAccess { url -> Bool? in
            guard
                let data = try? Data(contentsOf: url),
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let token = extractToken(from: json)
            else { return nil }
            // Only write when changed — avoids needless Keychain churn on every reconnect.
            if token != loadToken() {
                try? saveToken(token)
            }
            return true
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// Manages the self-generated Ed25519 pairing identity stored in Keychain.
/// Exposed so Settings can offer a "reset pairing" action for users stuck on
/// `DEVICE_AUTH_SIGNATURE_INVALID` — wiping the identity forces the next
/// connect to generate a fresh key pair and re-enter the pairing flow.
enum OpenClawDeviceIdentityStore {
    private static let service = "bound.serendipity.agent.deck.openclaw.identity"
    private static let account = "default"

    static func hasIdentity() -> Bool {
        var query = keychainQuery()
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    /// Removes the stored Ed25519 key pair + cached deviceToken. The next
    /// adapter start regenerates a fresh identity and re-runs pairing.
    static func deleteIdentity() throws {
        let status = SecItemDelete(keychainQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
        }
    }

    private static func keychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

/// Connects to OpenClaw Gateway via WebSocket, handles Ed25519 auth handshake,
/// and relays events to the daemon.
actor OpenClawAdapter {
    private struct DeviceIdentity {
        let deviceId: String
        let publicKeyBase64Url: String
        let privateKey: Curve25519.Signing.PrivateKey
    }

    private struct DeviceAuthToken {
        let token: String
        let role: String
        let scopes: [String]
    }

    private var wsTask: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private var sessionsPollTask: Task<Void, Never>?
    private let gatewayUrl: String
    private var isConnected = false
    private var isStopping = false
    private var pairingRequired = false
    /// Set after a `DEVICE_AUTH_INVALID` response with a shared token configured.
    /// Suppresses device-auth on the next connect so a Gateway running in
    /// shared-token-only mode (which rejects unknown Ed25519 keys) can succeed
    /// using the shared token alone. Reset on `start()` lifecycle.
    private var disableDeviceAuthForNextConnect = false
    /// Tagged with the specific `wsTask` whose close we initiated ourselves
    /// (e.g. fallback path after a `connect` RPC error). The cancel produces
    /// a `.failure` in receiveLoop, and the resulting `handleDisconnect`
    /// would otherwise re-classify the same failed handshake's close reason —
    /// re-blocking the very fallback we just scheduled. Storing the task
    /// reference (instead of a plain Bool) keeps the suppression scoped to
    /// the exact close it was set for: if a replacement socket's legitimate
    /// close arrives first, identity comparison rejects this flag and the
    /// reason is classified normally. Cleared on consume or on adapter
    /// stop/start.
    private var clientInitiatedCloseTask: URLSessionWebSocketTask?
    private var sessionsSubscribed = false
    private var reconnectDelay: TimeInterval = 1
    private let maxReconnectDelay: TimeInterval = 30
    private let protocolVersion = 4
    private let connectRPCResponseTimeoutNanoseconds: UInt64 = 10_000_000_000
    private let standardRPCResponseTimeoutNanoseconds: UInt64 = 20_000_000_000

    private var currentSessionKey: String?
    private var currentRunId: String?
    private var promptCapturedForRunId: String? // guard: emit prompt entry once per runId
    private var automatedRunId: String? // runId whose prompt was a scheduled (cron) turn — flagged automated
    private var pendingApprovalId: String?
    private struct RPCResponse: @unchecked Sendable {
        let ok: Bool
        let payload: [String: Any]?
        let error: [String: Any]?
    }
    private struct PendingRPC {
        let method: String
        // Task this RPC was sent on. Used by handleResponse to detect a stale
        // response: if the current `wsTask` no longer matches `task`, the
        // socket was canceled and replaced (e.g. fallback path). Acting on
        // such a response would tag/cancel the live replacement.
        weak var task: URLSessionWebSocketTask?
        let continuation: CheckedContinuation<RPCResponse, Never>?
    }
    private var pendingMethods: [String: PendingRPC] = [:]
    private var deviceIdentity: DeviceIdentity?
    private var deviceAuthToken: DeviceAuthToken?
    private let clientId = "gateway-client"
    private let clientDisplayName = "AgentDeck Dashboard"
    private let clientMode = "backend"
    private let clientPlatform = "darwin"
    private let clientDeviceFamily = "mac"
    private let defaultRole = "operator"
    private let defaultScopes = ["operator.read", "operator.write", "operator.approvals"]

    private var _onEvent: (@Sendable ([String: Any]) -> Void)?
    private var _onConnectionChanged: (@Sendable (Bool) -> Void)?

    func setOnEvent(_ handler: @escaping @Sendable ([String: Any]) -> Void) { _onEvent = handler }
    func setOnConnectionChanged(_ handler: @escaping @Sendable (Bool) -> Void) { _onConnectionChanged = handler }

    var isConnectedSnapshot: Bool { isConnected }

    /// Snapshot of the locally-generated Ed25519 public-key SHA-256 hex that
    /// identifies this Mac to the Gateway's pairing flow. Dashboard surfaces
    /// the first few hex chars when auth is stuck on "device signature
    /// invalid" so the user knows which deviceId to approve in the OpenClaw
    /// Web UI. Returns nil when the identity has not been loaded yet.
    func currentDeviceId() -> String? { deviceIdentity?.deviceId }

    init(gatewayUrl: String = "ws://127.0.0.1:18789") {
        self.gatewayUrl = gatewayUrl
    }

    func start() {
        isStopping = false
        pairingRequired = false
        disableDeviceAuthForNextConnect = false
        clientInitiatedCloseTask = nil
        // Make every fresh-cycle visible in the file log. Without this, an
        // observer inspecting daemon.log can't tell whether a new attempt is
        // running on a brand-new adapter instance (state reset to defaults)
        // or whether it's a reconnect on a stuck instance carrying stale
        // `pairingRequired` / `disableDeviceAuthForNextConnect` flags from a
        // prior cycle. Both cases produce identical "WebSocket opened…" lines.
        DaemonLogger.shared.error("OpenClaw adapter start: state reset (pairingRequired=false, disableDeviceAuthForNextConnect=false)")
        loadDeviceIdentity()
        connect()
    }

    func stop() {
        isStopping = true
        reconnectTask?.cancel()
        reconnectTask = nil
        sessionsPollTask?.cancel()
        sessionsPollTask = nil
        if let task = wsTask {
            task.cancel(with: .goingAway, reason: nil)
            // Resolve any RPC continuations bound to this task before nil-ing.
            // Without this, an in-flight `await sendRPC(...)` from another
            // path (e.g. session shutdown) would dangle because the cancel
            // bypasses the receiveLoop's normal response handling.
            clearPendingRPCs(for: task, reason: "Adapter stopped")
        }
        wsTask = nil
        let wasConnected = isConnected
        isConnected = false
        sessionsSubscribed = false
        promptCapturedForRunId = nil
        automatedRunId = nil
        if wasConnected {
            self._onConnectionChanged?(false)
        }
    }

    // MARK: - Connection

    private func connect() {
        guard let url = URL(string: gatewayUrl) else { return }
        reconnectTask?.cancel()
        reconnectTask = nil
        // Cancel any pre-existing wsTask before allocating a new one.
        // Without this guard, a concurrent reconnect path (handleDisconnect →
        // scheduleReconnect → connect()) overwrites the just-set-up wsTask
        // while the previous socket's pending sendConnectRequest is still in
        // flight — producing "Socket is not connected" Send failures and a
        // visible duplicate "WebSocket opened" line in the daemon log.
        if let existing = wsTask {
            existing.cancel(with: .goingAway, reason: nil)
            // Drain any RPC continuations bound to the about-to-die task so
            // their `await sendRPC(...)` callers don't dangle. The replacement
            // task hasn't been installed yet, so this catches every pending
            // RPC that the old socket would never get to answer.
            clearPendingRPCs(for: existing, reason: "Socket replaced before response")
            wsTask = nil
        }
        let task = URLSession.shared.webSocketTask(with: url)
        self.wsTask = task
        task.resume()

        receiveLoop(task)

        // Wait a moment then attempt handshake
        Task {
            try? await Task.sleep(for: .milliseconds(500))
            performHandshake()
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task {
                guard let self else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        // Pass the receiving task so handleMessage can drop
                        // any payload that arrived on a socket we already
                        // replaced. Otherwise a stale event/response could
                        // re-enter handleResponse → fallback path and
                        // tag/cancel the live replacement task.
                        await self.handleMessage(text, source: task)
                    default:
                        break
                    }
                    await self.receiveLoop(task)
                case .failure:
                    // URLSessionWebSocketTask retains the close code + reason
                    // after the server closes the connection. Capture both so
                    // handleDisconnect can pivot on transport-level rejections
                    // (e.g. 1008 "device signature invalid" — never surfaces as
                    // an RPC response, so the RPC-error fallback can't see it).
                    let closeCode = task.closeCode
                    let closeReason = task.closeReason
                        .flatMap { String(data: $0, encoding: .utf8) }
                    // Pass the closing task so handleDisconnect can identity-
                    // check it against the current `wsTask`. A stale .failure
                    // (e.g. from a task we canceled in the fallback path)
                    // arriving after `connect()` already installed a fresh
                    // replacement socket would otherwise wipe `wsTask = nil`,
                    // leaving the live socket stranded with no receive loop
                    // hooked up.
                    await self.handleDisconnect(
                        closingTask: task,
                        closeCode: closeCode,
                        reason: closeReason
                    )
                }
            }
        }
    }

    private func handleMessage(_ text: String, source: URLSessionWebSocketTask) {
        // Parse the envelope first — even for stale messages, because we may
        // need to resolve a hanging RPC continuation before discarding.
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        // Stale-message gate. Once `wsTask` has been replaced (e.g. fallback
        // path canceled the prior socket and connect() installed a fresh
        // task), any in-flight `.success` from the prior receiveLoop must
        // not flow into handleEvent / sessions.list re-issue / fallback
        // tag/cancel of `wsTask` / status emits — those side effects would
        // hit the live replacement socket. handleDisconnect already gates
        // the close path; this gate covers the open path.
        //
        // Exception: an RPC `res` carrying a known pending id must be
        // resolved here, otherwise an `await sendRPC(...)` caller would
        // dangle forever and the continuation would leak. Resolve with a
        // synthetic STALE_TASK error so the caller can react if needed,
        // then discard without invoking the regular handleResponse path
        // (which would race the fallback/cancel branches against the live
        // task).
        if wsTask !== source {
            if let type = json["type"] as? String, type == "res",
               let responseId = json["id"] as? String,
               let pending = pendingMethods.removeValue(forKey: responseId) {
                DaemonLogger.shared.debug(
                    "OpenClaw",
                    "Resolving stale RPC response \(responseId) (method=\(pending.method)) before drop"
                )
                pending.continuation?.resume(returning: RPCResponse(
                    ok: false,
                    payload: nil,
                    error: [
                        "code": "STALE_TASK",
                        "message": "Response arrived after socket was replaced",
                    ]
                ))
            }
            DaemonLogger.shared.debug("OpenClaw", "Dropping stale message (task replaced)")
            return
        }

        // Envelope parse via generated ADGatewayFrame — this anchors the Swift
        // adapter to shared/src/gateway-protocol.ts. Field extraction still
        // reads the raw dict because quicktype flattens the payload union,
        // but `.type` / `.event` come from the generated enums so any rename
        // in the single source fails compilation here.
        let frame = try? JSONDecoder().decode(ADGatewayFrame.self, from: data)
        let rawType = json["type"] as? String

        switch (frame?.type, rawType) {
        case (.event, _), (_, "event"):
            handleGatewayEvent(frame?.event, rawEvent: json["event"] as? String,
                               payload: json["payload"] as? [String: Any] ?? [:])
        case (.res, _), (_, "res"):
            handleResponse(json)
        case (.req, _), (_, "req"), (.none, _):
            break
        }
    }

    private func handleGatewayEvent(_ event: ADGatewayEventName?, rawEvent: String?, payload: [String: Any]) {
        let eventName = rawEvent ?? event?.rawValue ?? ""
        switch eventName {
        case ADGatewayEventName.connectChallenge.rawValue:
            guard let nonce = payload["nonce"] as? String, !nonce.isEmpty else {
                DaemonLogger.shared.debug("OpenClaw", "connect.challenge missing nonce")
                return
            }
            DaemonLogger.shared.debug("OpenClaw", "Challenge nonce: \(String(nonce.prefix(8)))...")
            sendConnectRequest(nonce: nonce)
        case ADGatewayEventName.chat.rawValue:
            if let runId = payload["runId"] as? String, !runId.isEmpty {
                currentRunId = runId
            }
            if let sessionKey = payload["sessionKey"] as? String, !sessionKey.isEmpty {
                currentSessionKey = sessionKey
            }
            let chatState = payload["state"] as? String

            // Gateway echoes the user's prompt in the first delta's `prompt` field.
            // Capture it here so timeline shows the actual text regardless of whether
            // sessions.messages.subscribe is working.
            if let prompt = payload["prompt"] as? String, !prompt.isEmpty,
               promptCapturedForRunId != currentRunId {
                promptCapturedForRunId = currentRunId
                // Scheduled (cron) turns echo the entire instruction prompt — often
                // a multi-KB blob whose text contains shell verbs like `ls -lt` /
                // `tail -50`. Dumping it verbatim made the timeline read as if
                // OpenClaw were running bash. Cap `detail` (mirrors the Node path's
                // ~1000-char cap) and flag cron turns `automated` so the dashboard
                // can dim/collapse them instead of surfacing the raw prompt.
                let isCron = prompt.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("[cron:")
                if isCron { automatedRunId = currentRunId }
                let promptRaw = isCron ? DaemonTimelineStore.summarizeOpenClawCronPrompt(prompt) : String(prompt.prefix(200))
                let promptDetail = isCron ? nil : String(prompt.prefix(1000))
                let entry = DaemonTimelineEntry(
                    ts: Self.payloadTimestamp(payload),
                    type: "model_call",
                    raw: promptRaw,
                    detail: promptDetail,
                    approvalId: nil, status: nil,
                    agentType: "openclaw", repeatCount: nil, automated: isCron ? true : nil,
                    runId: currentRunId,
                    summaryKind: isCron ? "heuristic" : nil
                )
                emitTimelineEntry(entry)
            }

            // Capture full assembled response on final so timeline shows real content.
            if chatState == "final", let response = payload["response"] as? String, !response.isEmpty {
                let isAutomated = automatedRunId == currentRunId
                let entry = DaemonTimelineEntry(
                    ts: Self.payloadTimestamp(payload),
                    type: "model_response",
                    raw: String(response.prefix(200)),
                    detail: String(response.prefix(1000)),
                    approvalId: nil, status: nil,
                    agentType: "openclaw", repeatCount: nil, automated: isAutomated ? true : nil,
                    runId: currentRunId
                )
                emitTimelineEntry(entry)
            }

            // Chat events (delta, final, aborted, error).
            // runId is promoted to the top level so DaemonServer can route it
            // to the APME collector without unwrapping the nested payload.
            var chatEvent: [String: Any] = ["type": "gateway_chat", "event": eventName, "payload": payload]
            if let runId = currentRunId { chatEvent["runId"] = runId }
            self._onEvent?(chatEvent)
        case ADGatewayEventName.execApprovalRequested.rawValue:
            pendingApprovalId = payload["id"] as? String
            self._onEvent?(["type": "gateway_approval", "payload": payload])
        case ADGatewayEventName.execApprovalResolved.rawValue:
            pendingApprovalId = nil
            self._onEvent?(["type": "gateway_approval_resolved", "payload": payload])
        case ADGatewayEventName.presence.rawValue, ADGatewayEventName.systemPresence.rawValue:
            self._onEvent?(["type": "gateway_presence", "payload": payload])
        case ADGatewayEventName.health.rawValue:
            self._onEvent?(["type": "gateway_health", "payload": payload])
        case ADGatewayEventName.sessionsChanged.rawValue:
            requestSessionsList()
        case ADGatewayEventName.sessionMessage.rawValue:
            emitTimelineEntry(fromSessionMessage: payload)
        case ADGatewayEventName.sessionTool.rawValue:
            emitTimelineEntry(fromSessionTool: payload)
        case ADGatewayEventName.tick.rawValue:
            break // Heartbeat, ignore
        case ADGatewayEventName.shutdown.rawValue:
            handleDisconnect()
        default:
            break
        }
    }

    private func handleResponse(_ json: [String: Any]) {
        let responseId = json["id"] as? String ?? "unknown"
        let pending = pendingMethods.removeValue(forKey: responseId)
        let method = pending?.method
        let ok = json["ok"] as? Bool ?? false
        let payload = json["payload"] as? [String: Any]
        let errorInfo = json["error"] as? [String: Any]
        pending?.continuation?.resume(returning: RPCResponse(ok: ok, payload: payload, error: errorInfo))

        DaemonLogger.shared.debug("OpenClaw", "Response: \(responseId) method=\(method ?? "?") ok=\(ok)")

        // Stale-response guard. If this RPC was sent on a task that no longer
        // matches the current `wsTask`, the socket was canceled and replaced
        // (e.g. fallback path racing with a new connect()). Acting on the
        // response now — especially in the failure branch below, which
        // tags + cancels `wsTask` — would tag/cancel the live replacement
        // instead of the dead originator. Drop the message after consuming
        // its continuation.
        if let pendingTask = pending?.task,
           let current = wsTask,
           pendingTask !== current {
            DaemonLogger.shared.debug("OpenClaw", "Dropping stale response \(responseId) (task replaced)")
            return
        }

        guard ok else {
            if method == "connect" {
                let errorCode = errorInfo?["code"] as? String
                    ?? (errorInfo?["details"] as? [String: Any])?["code"] as? String
                DaemonLogger.shared.error("OpenClaw handshake failed: \(json["error"] ?? "unknown" as Any)")

                let authStatus = classifyAuthFailure(errorCode: errorCode, error: errorInfo)

                // Always log the classification + fallback decision inputs.
                // Without this line a stuck `gateway_reachable` is undebuggable
                // — past sessions hit a state where `Response ok=false` printed
                // but every subsequent ERROR line was missing from the file
                // logger. Forcing one line per decision covers all branches.
                DaemonLogger.shared.error(
                    "OpenClaw fallback decision: status=\(authStatus.status)" +
                    " disableDeviceAuthForNextConnect=\(disableDeviceAuthForNextConnect)"
                )

                // Auto-fallback on DEVICE_AUTH_INVALID: retry once with device
                // auth suppressed regardless of whether a shared token is set.
                //  - If a shared token is configured and the Gateway is in
                //    shared-token-only mode, the retry authenticates with token
                //    alone and succeeds.
                //  - If no shared token is set (or the token can't be loaded —
                //    e.g. Debug vs App Store builds use different keychain
                //    access groups so a token saved in one build is invisible
                //    to the other), the retry sends no auth at all. The Gateway
                //    will respond with an explicit "device identity required"
                //    or "unauthorized" status that surfaces correctly in the UI
                //    instead of looping on the same signature rejection.
                if authStatus.status == "device_auth_invalid"
                    && !disableDeviceAuthForNextConnect {
                    disableDeviceAuthForNextConnect = true
                    DaemonLogger.shared.info("OpenClaw: DEVICE_AUTH_INVALID — retrying without device auth")
                    // Keep amber "Connecting…" while we retry; don't surface
                    // device_auth_invalid red on a state we'll auto-recover from.
                    emitAuthStatus("gateway_reachable", requestId: nil, message: nil)
                    reconnectDelay = 1
                    // Mark the upcoming close as client-initiated, scoped to
                    // THIS specific wsTask, so handleDisconnect doesn't
                    // re-classify the server's "device signature invalid"
                    // reason that we already turned into a fallback retry.
                    // Task-scoping keeps this from leaking onto a replacement
                    // socket installed by a concurrent connect().
                    clientInitiatedCloseTask = wsTask
                    wsTask?.cancel(with: .goingAway, reason: nil)
                    wsTask = nil
                    return
                }

                // Block reconnect only for states that require action in the Gateway Web UI.
                // Token config errors (missing/mismatch) are fixable from Settings — let the
                // adapter keep reconnecting so saving the token takes effect automatically.
                let requiresWebUIAction = ["pairing_required", "device_auth_invalid",
                                           "approval_pending", "unsupported_protocol"]
                    .contains(authStatus.status)
                if requiresWebUIAction {
                    pairingRequired = true
                }
                emitAuthStatus(authStatus.status, requestId: authStatus.requestId, message: authStatus.message)
                DaemonLogger.shared.error("OpenClaw: auth status \(authStatus.status) — reconnect \(requiresWebUIAction ? "blocked" : "allowed")")
                // Same suppression applies here: we just emitted the canonical
                // status, so the post-cancel handleDisconnect must not double-
                // classify the same close. Tag this exact task so a stale
                // close from a prior cycle can't accidentally consume the flag.
                clientInitiatedCloseTask = wsTask
                wsTask?.cancel(with: .goingAway, reason: nil)
                wsTask = nil
            } else {
                let code = errorInfo?["code"] as? String
                let message = errorInfo?["message"] as? String
                let detail: String
                switch (code, message) {
                case let (c?, m?): detail = "\(c): \(m)"
                case let (c?, nil): detail = c
                case let (nil, m?): detail = m
                default: detail = "unknown"
                }
                DaemonLogger.shared.error("OpenClaw RPC '\(method ?? "?")' failed: \(detail)")
            }
            return
        }

        switch method {
        case "connect":
            guard validateHelloOk(payload) else {
                pairingRequired = true
                emitAuthStatus("unsupported_protocol", requestId: nil, message: "OpenClaw Gateway version not supported")
                clientInitiatedCloseTask = wsTask
                wsTask?.cancel(with: .goingAway, reason: nil)
                wsTask = nil
                return
            }
            persistHelloAuth(payload)
            disableDeviceAuthForNextConnect = false // Reset fallback flag on successful connect!
            markConnectedIfNeeded()
            emitAuthStatus("connected", requestId: nil, message: nil)
            requestBaselineState()
            requestSessionsList()
            Task { await self.emitModelCatalog() }
        case "sessions.subscribe":
            let subscribed = payload?["subscribed"] as? Bool ?? false
            sessionsSubscribed = subscribed
            DaemonLogger.shared.debug("OpenClaw", "sessions.subscribe: subscribed=\(subscribed)")
            if !subscribed {
                // Gateway didn't acknowledge subscription — fall back to periodic polling
                // so session changes are still detected (e.g., shared-token mode without
                // device auth may limit subscription access).
                startSessionsPolling()
            }
        case "sessions.list":
            if let payload {
                applySessionsPayload(payload)
            }
        case "health":
            if let payload {
                self._onEvent?(["type": "gateway_health", "payload": payload])
            }
        default:
            break
        }
    }

    private func handleDisconnect(
        closingTask: URLSessionWebSocketTask? = nil,
        closeCode: URLSessionWebSocketTask.CloseCode = .invalid,
        reason: String? = nil
    ) {
        // Stale-close guard. If the caller identifies the closing task and it
        // no longer matches `wsTask`, the .failure is for a socket we already
        // canceled and replaced (e.g. fallback path → cancel old → connect()
        // installed newTask → cancelled task's deferred .failure now arrives).
        // Without this guard the handler would clear `wsTask = nil`, stranding
        // the live replacement socket with no receive loop and no reconnect
        // ever firing — the daemon would silently lose the Gateway link.
        //
        // Also clear the task-scoped suppression flag IFF it was tagged for
        // this same stale task — leaves any flag set for a still-live task
        // alone.
        if let closingTask, let current = wsTask, closingTask !== current {
            if clientInitiatedCloseTask === closingTask {
                clientInitiatedCloseTask = nil
            }
            // Drain any RPCs still bound to the stale task. Otherwise their
            // `await sendRPC(...)` callers would dangle because no later code
            // path will see a response for a socket that's already gone.
            clearPendingRPCs(for: closingTask, reason: "Stale-close: socket already replaced")
            return
        }

        let wasConnected = isConnected
        // Drain pending RPCs bound to the closing task before nilling wsTask.
        // Picks up any in-flight RPCs the server didn't get to answer.
        if let closingTask {
            clearPendingRPCs(for: closingTask, reason: "Socket disconnected")
        } else if let current = wsTask {
            // shutdown-event path doesn't supply closingTask; fall back to
            // current wsTask which is the one being torn down.
            clearPendingRPCs(for: current, reason: "Socket disconnected (shutdown event)")
        }
        isConnected = false
        wsTask = nil
        sessionsSubscribed = false
        sessionsPollTask?.cancel()
        sessionsPollTask = nil

        if wasConnected {
            self._onConnectionChanged?(false)
        }

        guard !isStopping else { return }

        // Task-scoped suppression: this close suppresses reason classification
        // ONLY if `clientInitiatedCloseTask` was set to the same task we're
        // now disconnecting. A flag tagged for an older task that already
        // went stale (or for the still-live task — but that branch never
        // reaches here) won't accidentally swallow this close's classification.
        // Treat the absence of a closingTask param (e.g. the shutdown event
        // path that calls handleDisconnect()) as "no identity check", so the
        // flag still consumes if it was set for the current wsTask before
        // it was nilled above.
        let suppressReason: Bool
        if let closingTask {
            suppressReason = clientInitiatedCloseTask === closingTask
        } else {
            suppressReason = clientInitiatedCloseTask != nil
        }
        clientInitiatedCloseTask = nil

        // Map known transport-level close reasons to authStatus and decide on
        // auto-fallback. The server side closes the WebSocket with code 1008
        // ("policy violation") + a `reason` string for every authentication
        // outcome — these never surface as RPC responses, so the RPC-error
        // fallback in `handleResponse` can't see them.
        if !suppressReason, let reason, !reason.isEmpty {
            DaemonLogger.shared.error("OpenClaw ws closed: code=\(closeCode.rawValue) reason=\(reason)")
            let lc = reason.lowercased()

            if lc.contains("device signature invalid")
                && !disableDeviceAuthForNextConnect {
                // Crypto-level signature rejection: retry once without device
                // auth regardless of shared-token presence (same rationale as
                // the RPC fallback — see handleResponse). The retry will land
                // on a more specific status (connected, device identity
                // required, unauthorized) that the UI can act on.
                disableDeviceAuthForNextConnect = true
                emitAuthStatus("gateway_reachable", requestId: nil, message: nil)
                DaemonLogger.shared.info("OpenClaw: signature rejected — retrying without device auth")
                reconnectDelay = 1
            } else if lc.contains("device identity required") {
                emitAuthStatus("pairing_required", requestId: nil, message: reason)
                pairingRequired = true
            } else if lc.contains("gateway token missing") {
                emitAuthStatus("gateway_token_missing", requestId: nil, message: reason)
            } else if lc.contains("device signature invalid") {
                // No shared token (or fallback already exhausted) — surface as
                // device_auth_invalid so the UI directs the user to Web UI.
                emitAuthStatus("device_auth_invalid", requestId: nil, message: reason)
                pairingRequired = true
            } else if lc.contains("unauthorized") {
                emitAuthStatus("token_mismatch", requestId: nil, message: reason)
            } else if lc.contains("invalid handshake")
                || lc.contains("invalid connect params") {
                emitAuthStatus("unsupported_protocol", requestId: nil, message: reason)
                pairingRequired = true
            }
            // Any other reason: leave the existing reconnect logic to handle it.
        }

        guard !pairingRequired else {
            return
        }

        // Reconnect with exponential backoff
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, maxReconnectDelay)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.connect()
        }
    }

    // MARK: - Ed25519 Handshake

    private func performHandshake() {
        // Handshake starts only when Gateway emits connect.challenge.
        // Keep this method to document that the connection is intentionally idle until challenged.
        DaemonLogger.shared.debug("OpenClaw", "WebSocket opened, awaiting connect.challenge")
    }

    private func markConnectedIfNeeded() {
        guard !isConnected else { return }
        isConnected = true
        reconnectDelay = 1
        self._onConnectionChanged?(true)
    }

    private func loadDeviceIdentity() {
        loadAppStoreDeviceIdentity()
    }

    private struct StoredAppStoreIdentity: Codable {
        var privateKey: String
        var deviceId: String
        var deviceToken: String?
        var role: String?
        var scopes: [String]?
    }

    private static let appStoreIdentityService = "bound.serendipity.agent.deck.openclaw.identity"
    private static let appStoreIdentityAccount = "default"

    private func loadAppStoreDeviceIdentity() {
        do {
            let stored = try loadOrCreateStoredAppStoreIdentity()
            guard let rawPrivateKey = Data(base64Encoded: stored.privateKey) else {
                throw NSError(domain: "OpenClawIdentityStore", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid stored private key"])
            }
            let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: rawPrivateKey)
            let publicKeyRaw = privateKey.publicKey.rawRepresentation
            let deviceId = Data(SHA256.hash(data: publicKeyRaw)).hexString
            let canonical = StoredAppStoreIdentity(
                privateKey: stored.privateKey,
                deviceId: deviceId,
                deviceToken: stored.deviceToken,
                role: stored.role,
                scopes: stored.scopes
            )
            if canonical.deviceId != stored.deviceId {
                try saveStoredAppStoreIdentity(canonical)
            }
            deviceIdentity = DeviceIdentity(
                deviceId: deviceId,
                publicKeyBase64Url: publicKeyRaw.base64URLEncodedString(),
                privateKey: privateKey
            )
            if let token = canonical.deviceToken, !token.isEmpty {
                deviceAuthToken = DeviceAuthToken(
                    token: token,
                    role: canonical.role ?? defaultRole,
                    scopes: canonical.scopes?.isEmpty == false ? canonical.scopes ?? defaultScopes : defaultScopes
                )
            } else {
                deviceAuthToken = nil
            }
            DaemonLogger.shared.debug("OpenClaw", "App Store identity ready: \(String(deviceId.prefix(16)))...")
        } catch {
            deviceIdentity = nil
            deviceAuthToken = nil
            emitAuthStatus("auth_failed", requestId: nil, message: "OpenClaw identity unavailable")
            DaemonLogger.shared.error("OpenClaw App Store identity load failed: \(error)")
        }
    }

    private func loadOrCreateStoredAppStoreIdentity() throws -> StoredAppStoreIdentity {
        if let stored = try loadStoredAppStoreIdentity() {
            return stored
        }
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKeyRaw = privateKey.publicKey.rawRepresentation
        let stored = StoredAppStoreIdentity(
            privateKey: privateKey.rawRepresentation.base64EncodedString(),
            deviceId: Data(SHA256.hash(data: publicKeyRaw)).hexString,
            deviceToken: nil,
            role: defaultRole,
            scopes: defaultScopes
        )
        try saveStoredAppStoreIdentity(stored)
        return stored
    }

    private func loadStoredAppStoreIdentity() throws -> StoredAppStoreIdentity? {
        var query = Self.appStoreKeychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
        }
        return try JSONDecoder().decode(StoredAppStoreIdentity.self, from: data)
    }

    private func saveStoredAppStoreIdentity(_ stored: StoredAppStoreIdentity) throws {
        let data = try JSONEncoder().encode(stored)
        let query = Self.appStoreKeychainQuery()
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
        }
    }

    private static func appStoreKeychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: appStoreIdentityService,
            kSecAttrAccount as String: appStoreIdentityAccount,
        ]
    }

    // MARK: - RPC

    func sendRPC(method: String, params: [String: Any]) {
        sendRPC(method: method, params: params, continuation: nil)
    }

    private func rpcRequest(method: String, params: [String: Any]) async -> RPCResponse {
        await withCheckedContinuation { continuation in
            sendRPC(method: method, params: params, continuation: continuation)
        }
    }

    private func sendRPC(
        method: String,
        params: [String: Any],
        continuation: CheckedContinuation<RPCResponse, Never>?
    ) {
        guard let wsTask else {
            DaemonLogger.shared.debug("OpenClaw", "Skipping RPC \(method): gateway socket is not connected")
            continuation?.resume(returning: RPCResponse(
                ok: false,
                payload: nil,
                error: ["code": "NOT_CONNECTED", "message": "gateway socket is not connected"]
            ))
            return
        }
        var resolvedParams = params
        switch method {
        case "chat.send":
            if resolvedParams["sessionKey"] == nil, let sessionKey = currentSessionKey {
                resolvedParams["sessionKey"] = sessionKey
            }
            if resolvedParams["idempotencyKey"] == nil {
                resolvedParams["idempotencyKey"] = UUID().uuidString
            }
        case "chat.abort":
            if resolvedParams["sessionKey"] == nil, let sessionKey = currentSessionKey {
                resolvedParams["sessionKey"] = sessionKey
            }
            if resolvedParams["runId"] == nil, let runId = currentRunId {
                resolvedParams["runId"] = runId
            }
        case "exec.approval.resolve":
            if resolvedParams["id"] == nil, let pendingApprovalId {
                resolvedParams["id"] = pendingApprovalId
            }
        default:
            break
        }

        if method == "sessions.messages.subscribe",
           resolvedParams["key"] == nil,
           let sessionKey = currentSessionKey {
            resolvedParams["key"] = sessionKey
        }

        let requestId = UUID().uuidString
        let frame: [String: Any] = [
            "type": "req",
            "id": requestId,
            "method": method,
            "params": resolvedParams,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8) else {
            DaemonLogger.shared.error("OpenClaw RPC \(method) serialization failed")
            continuation?.resume(returning: RPCResponse(
                ok: false,
                payload: nil,
                error: ["code": "SERIALIZATION_FAILED", "message": "Could not encode RPC frame"]
            ))
            return
        }
        pendingMethods[requestId] = PendingRPC(method: method, task: wsTask, continuation: continuation)
        let timeoutNanoseconds = rpcResponseTimeoutNanoseconds(for: method)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: timeoutNanoseconds)
            guard !Task.isCancelled else { return }
            await self?.completeRPCTimeout(requestId: requestId)
        }
        wsTask.send(.string(text)) { error in
            if let error {
                DaemonLogger.shared.debug("OpenClaw", "RPC \(method) send failed: \(error)")
                Task { await self.completeRPCSendFailure(requestId: requestId, message: String(describing: error)) }
            }
        }
    }

    private func rpcResponseTimeoutNanoseconds(for method: String) -> UInt64 {
        method == "connect"
            ? connectRPCResponseTimeoutNanoseconds
            : standardRPCResponseTimeoutNanoseconds
    }

    private func completeRPCSendFailure(requestId: String, message: String) {
        guard let pending = pendingMethods.removeValue(forKey: requestId) else { return }
        pending.continuation?.resume(returning: RPCResponse(
            ok: false,
            payload: nil,
            error: ["code": "SEND_FAILED", "message": message]
        ))
    }

    private func completeRPCTimeout(requestId: String) {
        guard let pending = pendingMethods.removeValue(forKey: requestId) else { return }
        let code = pending.method == "connect" ? "CONNECT_TIMEOUT" : "RPC_TIMEOUT"
        DaemonLogger.shared.error("OpenClaw RPC '\(pending.method)' timed out waiting for response")
        pending.continuation?.resume(returning: RPCResponse(
            ok: false,
            payload: nil,
            error: ["code": code, "message": "Gateway did not answer before timeout"]
        ))
        if pending.method == "connect" {
            handleConnectTimeout(task: pending.task)
        }
    }

    private func handleConnectTimeout(task: URLSessionWebSocketTask?) {
        guard let task, let current = wsTask, task === current, !isStopping else { return }

        if disableDeviceAuthForNextConnect {
            DaemonLogger.shared.error("OpenClaw token-only connect timed out — reconnecting gateway adapter")
            emitAuthStatus(
                "connect_timeout",
                requestId: nil,
                message: "Gateway did not answer token-only connect before timeout"
            )
        } else {
            disableDeviceAuthForNextConnect = true
            reconnectDelay = 1
            DaemonLogger.shared.info("OpenClaw connect timed out — retrying without device auth")
            emitAuthStatus(
                "gateway_reachable",
                requestId: nil,
                message: "Gateway connect timed out; retrying without device auth"
            )
        }

        clientInitiatedCloseTask = task
        task.cancel(with: .goingAway, reason: nil)
    }

    /// Resolves and removes every pending RPC bound to `task`. Used at every
    /// task-replacement point so awaiting `sendRPC(...)` callers never dangle:
    /// (1) `connect()` cancelling the previous `wsTask` before installing a
    /// replacement, (2) `handleDisconnect` for the closing task whether it's
    /// the current `wsTask` or a stale one. Each continuation gets a synthetic
    /// `STALE_TASK` error so caller-side error handling treats the absence
    /// of a server response as an explicit failure rather than a hang.
    private func clearPendingRPCs(for task: URLSessionWebSocketTask, reason: String) {
        let toResolve = pendingMethods.filter { $0.value.task === task }
        guard !toResolve.isEmpty else { return }
        for (id, _) in toResolve {
            pendingMethods.removeValue(forKey: id)
        }
        DaemonLogger.shared.debug(
            "OpenClaw",
            "Clearing \(toResolve.count) pending RPC(s) for replaced/closed task: \(reason)"
        )
        for (_, pending) in toResolve {
            pending.continuation?.resume(returning: RPCResponse(
                ok: false,
                payload: nil,
                error: ["code": "STALE_TASK", "message": reason]
            ))
        }
    }

    private func sendConnectRequest(nonce: String) {
        // In fallback mode every device-derived value is suppressed so the
        // request is genuinely token-only. Otherwise scopes inherit from the
        // stored device token (so re-connects keep the operator scopes that
        // were granted at pairing time) and fall back to defaults if empty.
        var scopes: [String]
        if disableDeviceAuthForNextConnect {
            scopes = defaultScopes
        } else {
            scopes = deviceAuthToken?.scopes ?? defaultScopes
            if scopes.isEmpty { scopes = defaultScopes }
        }

        var params: [String: Any] = [
            "minProtocol": protocolVersion,
            "maxProtocol": protocolVersion,
            "client": [
                "id": clientId,
                "displayName": clientDisplayName,
                "version": "0.3.0",
                "platform": clientPlatform,
                "deviceFamily": clientDeviceFamily,
                "mode": clientMode,
            ],
            "role": defaultRole,
            "scopes": scopes,
            "caps": ["tool-events"],
        ]

        // Pull in a rotated token from the bookmarked openclaw.json (if the
        // user granted file access during "Import token") before reading the
        // Keychain copy, so a changed gateway.auth.token reconnects cleanly.
        OpenClawGatewayTokenStore.refreshFromConfigBookmark()
        let sharedToken = OpenClawGatewayTokenStore.loadToken()

        // Default: attach device auth so dmPolicy=pairing Gateways can route to
        // the device-pair plugin (silent-drop otherwise). `buildDeviceAuth` signs
        // with `token=""` on first pairing.
        //
        // Exception: `disableDeviceAuthForNextConnect` is set when a previous
        // attempt got `DEVICE_AUTH_INVALID` while a shared token is configured —
        // i.e. Gateway is in shared-token-only mode and rejects unknown Ed25519
        // keys. Skip device auth on this attempt so the shared token alone
        // authenticates without forcing the user to manually pair in Web UI.
        // The flag is reset on adapter restart and on connected handshake.
        if !disableDeviceAuthForNextConnect,
           let device = buildDeviceAuth(nonce: nonce, requestScopes: scopes) {
            params["device"] = device
        }

        var auth: [String: Any] = [:]
        if let token = sharedToken, !token.isEmpty {
            auth["token"] = token
        }
        // Suppress deviceToken in fallback mode too. The Gateway just rejected
        // our device identity; re-sending any device-derived credential
        // (signature OR previously-issued deviceToken — same Ed25519 key behind
        // both) would earn another rejection. Token-only means the shared
        // token alone, with no device material in `params` or `auth`.
        if !disableDeviceAuthForNextConnect,
           let deviceToken = deviceAuthToken?.token, !deviceToken.isEmpty {
            auth["deviceToken"] = deviceToken
        }
        if !auth.isEmpty {
            params["auth"] = auth
        }

        // Wire-shape diagnostic — exact composition of every connect attempt.
        // Lets a single log tail prove which auth credentials were actually
        // attached, so a `gateway_reachable` stuck-state can be distinguished
        // between "fallback ran and Gateway silent-dropped token-only" vs
        // "fallback never ran and we kept resending device auth that the
        // Gateway already rejected." Token presence is logged as a boolean
        // only — never the value itself.
        let hasDeviceParam = params["device"] != nil
        let hasSharedToken = (auth["token"] as? String).map { !$0.isEmpty } ?? false
        let hasDeviceToken = (auth["deviceToken"] as? String).map { !$0.isEmpty } ?? false
        DaemonLogger.shared.error(
            "OpenClaw connect.RPC: fallback=\(disableDeviceAuthForNextConnect)" +
            " hasDevice=\(hasDeviceParam) hasSharedToken=\(hasSharedToken)" +
            " hasDeviceToken=\(hasDeviceToken) scopes=\(scopes.count)"
        )

        sendRPC(method: "connect", params: params)
    }

    private func requestSessionsList() {
        sendRPC(method: "sessions.list", params: [:])
    }

    private func startSessionsPolling() {
        sessionsPollTask?.cancel()
        sessionsPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { break }
                await self?.requestSessionsList()
            }
        }
    }

    private func requestBaselineState() {
        sendRPC(method: "sessions.subscribe", params: [:])
        sendRPC(method: "health", params: [:])
        sendRPC(method: "system-presence", params: [:])
        Task { await requestInitialLogTail() }
    }

    private func applySessionsPayload(_ payload: [String: Any]) {
        guard let sessions = payload["sessions"] as? [[String: Any]], !sessions.isEmpty else {
            DaemonLogger.shared.debug("OpenClaw", "No sessions available")
            return
        }

        let sorted = sessions.sorted { lhs, rhs in
            let left = (lhs["updatedAt"] as? NSNumber)?.doubleValue ?? (lhs["updatedAt"] as? Double) ?? 0
            let right = (rhs["updatedAt"] as? NSNumber)?.doubleValue ?? (rhs["updatedAt"] as? Double) ?? 0
            return left > right
        }
        currentSessionKey = sorted.first?["key"] as? String
        DaemonLogger.shared.debug("OpenClaw", "Active session: \(currentSessionKey ?? "nil")")
        if let currentSessionKey {
            sendRPC(method: "sessions.messages.subscribe", params: ["key": currentSessionKey])
        }
    }

    private func buildDeviceAuth(nonce: String, requestScopes: [String]) -> [String: Any]? {
        guard let deviceIdentity else { return nil }
        let signedAt = Int(Date().timeIntervalSince1970 * 1000)
        let scopes = requestScopes.joined(separator: ",")

        let token = deviceAuthToken?.token ?? ""
        let payload = [
            "v3",
            deviceIdentity.deviceId,
            clientId,
            clientMode,
            defaultRole,
            scopes,
            String(signedAt),
            token,
            nonce,
            clientPlatform,
            clientDeviceFamily,
        ].joined(separator: "|")

        guard let signature = try? deviceIdentity.privateKey.signature(for: Data(payload.utf8)) else {
            DaemonLogger.shared.error("OpenClaw: device auth signing failed")
            return nil
        }

        return [
            "id": deviceIdentity.deviceId,
            "publicKey": deviceIdentity.publicKeyBase64Url,
            "signature": signature.base64URLEncodedString(),
            "signedAt": signedAt,
            "nonce": nonce,
        ]
    }

    private func validateHelloOk(_ payload: [String: Any]?) -> Bool {
        guard let payload else { return false }
        let protocolNumber = (payload["protocol"] as? NSNumber)?.intValue ?? payload["protocol"] as? Int
        if let protocolNumber, protocolNumber > protocolVersion {
            return false
        }
        guard let features = payload["features"] as? [String: Any],
              let methods = features["methods"] as? [String] else {
            return true
        }
        let required = ["health", "models.list", "logs.tail", "sessions.list", "sessions.subscribe", "sessions.messages.subscribe"]
        return required.allSatisfy { methods.contains($0) }
    }

    private func persistHelloAuth(_ payload: [String: Any]?) {
        guard let auth = payload?["auth"] as? [String: Any],
              let token = auth["deviceToken"] as? String,
              !token.isEmpty else { return }
        let role = auth["role"] as? String ?? defaultRole
        let scopes = (auth["scopes"] as? [String]) ?? defaultScopes
        deviceAuthToken = DeviceAuthToken(token: token, role: role, scopes: scopes)

        do {
            guard var stored = try loadStoredAppStoreIdentity() else { return }
            stored.deviceToken = token
            stored.role = role
            stored.scopes = scopes
            try saveStoredAppStoreIdentity(stored)
        } catch {
            DaemonLogger.shared.error("OpenClaw device token persist failed: \(error)")
        }
    }

    private func classifyAuthFailure(
        errorCode: String?,
        error: [String: Any]?
    ) -> (status: String, requestId: String?, message: String?) {
        let details = error?["details"] as? [String: Any]
        let detailCode = (details?["code"] as? String ?? errorCode ?? "").uppercased()
        let requestId = details?["requestId"] as? String
            ?? details?["pendingRequestId"] as? String
            ?? details?["pairingRequestId"] as? String
        let message = error?["message"] as? String
        if detailCode.contains("PAIRING") || detailCode == "NOT_PAIRED" || detailCode == "DEVICE_IDENTITY_REQUIRED" {
            if let requestId, !requestId.isEmpty {
                return ("approval_pending", requestId, message)
            }
            return ("pairing_required", requestId, message)
        }
        if detailCode.contains("TOKEN_MISMATCH") {
            return ("token_mismatch", requestId, message)
        }
        if detailCode.contains("TOKEN_MISSING") || (message ?? "").localizedCaseInsensitiveContains("gateway token missing") {
            return ("gateway_token_missing", requestId, message)
        }
        if detailCode.contains("DEVICE_AUTH") {
            return ("device_auth_invalid", requestId, message)
        }
        if detailCode.contains("PROTOCOL") {
            return ("unsupported_protocol", requestId, message)
        }
        return ("auth_failed", requestId, message)
    }

    private func emitAuthStatus(_ status: String, requestId: String?, message: String?) {
        var event: [String: Any] = ["type": "gateway_auth", "status": status]
        if let requestId, !requestId.isEmpty { event["requestId"] = requestId }
        if let message, !message.isEmpty { event["message"] = message }
        _onEvent?(event)
    }

    private func emitModelCatalog(retry: Bool = true) async {
        guard let (entries, defaultModel) = await fetchModelCatalog() else {
            if retry && !isStopping {
                DaemonLogger.shared.debug("OpenClaw", "Model catalog empty — retrying in 10s")
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled, !isStopping else { return }
                await emitModelCatalog(retry: false)
            }
            return
        }
        _onEvent?([
            "type": "model_catalog",
            "models": entries,
            "defaultModel": defaultModel as Any,
        ])
    }

    private func fetchModelCatalog() async -> ([[String: Any]], String?)? {
        let response = await rpcRequest(method: "models.list", params: [:])
        guard response.ok, let payload = response.payload,
              let models = payload["models"] as? [[String: Any]] else {
            DaemonLogger.shared.debug("OpenClaw", "Model catalog RPC failed: \(response.error ?? [:])")
            return nil
        }
        let entries = models.compactMap { model -> [String: Any]? in
            let key = model["key"] as? String
                ?? model["id"] as? String
                ?? [model["provider"] as? String, model["name"] as? String].compactMap { $0 }.joined(separator: "/")
            let name = model["name"] as? String
                ?? model["title"] as? String
                ?? model["id"] as? String
                ?? key
            guard !key.isEmpty, !name.isEmpty else { return nil }
            let tags = model["tags"] as? [String] ?? []
            let missing = model["missing"] as? Bool ?? false
            let available = (model["available"] as? Bool ?? true) && !missing
            return [
                "key": key,
                "name": name,
                "role": Self.parseModelRole(tags: tags),
                "available": available,
            ]
        }
        let defaultModel = entries.first(where: { ($0["role"] as? String) == "default" })?["name"] as? String
            ?? entries.first(where: { ($0["available"] as? Bool) != false })?["name"] as? String
        return (entries, defaultModel)
    }

    func fetchHealthHasError() async -> Bool? {
        let response = await rpcRequest(method: "health", params: [:])
        guard response.ok, let payload = response.payload else {
            return nil
        }
        _onEvent?(["type": "gateway_health", "payload": payload])
        if let ok = payload["ok"] as? Bool {
            return !ok
        }
        if let checks = payload["checks"] as? [[String: Any]] {
            return checks.contains {
                let status = ($0["status"] as? String)?.lowercased()
                return status == "error" || status == "warn" || status == "degraded"
            }
        }
        if let status = (payload["status"] as? String)?.lowercased() {
            return status == "error" || status == "warn" || status == "degraded" || status == "unhealthy"
        }
        return false
    }

    private func requestInitialLogTail() async {
        let response = await rpcRequest(method: "logs.tail", params: ["limit": 80, "maxBytes": 64_000])
        guard response.ok,
              let payload = response.payload,
              let lines = payload["lines"] as? [String] else { return }
        for line in lines {
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data),
                  let entry = BridgeLogStream.parseLogLine(json) else { continue }
            emitTimelineEntry(entry)
        }
    }

    private func emitTimelineEntry(fromSessionMessage payload: [String: Any]) {
        let text = payload["text"] as? String
            ?? payload["content"] as? String
            ?? (payload["message"] as? [String: Any])?["text"] as? String
            ?? (payload["message"] as? [String: Any])?["content"] as? String
            ?? ""
        guard !text.isEmpty else { return }
        let role = payload["role"] as? String ?? "message"
        // Mirror the chat-event path: cap `detail` (cron/instruction prompts can be
        // multi-KB blobs of shell-verb text) and flag scheduled turns `automated`
        // so the dashboard can dim/collapse the raw prompt instead of surfacing it.
        let isCron = role != "assistant"
            && text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("[cron:")
        let raw = isCron ? DaemonTimelineStore.summarizeOpenClawCronPrompt(text) : String(text.prefix(200))
        let detail = isCron ? nil : String(text.prefix(1000))
        let entry = DaemonTimelineEntry(
            ts: Self.payloadTimestamp(payload),
            type: role == "assistant" ? "model_response" : "model_call",
            raw: raw,
            detail: detail,
            approvalId: nil,
            status: nil,
            agentType: "openclaw",
            repeatCount: nil,
            automated: isCron ? true : nil,
            runId: currentRunId,
            summaryKind: isCron ? "heuristic" : nil
        )
        emitTimelineEntry(entry)
    }

    /// Resolve a session.tool payload's tool name, returning nil if every
    /// candidate (top-level + nested) is absent / NSNull. Exposed as a
    /// static helper so the placeholder-row drop predicate is testable
    /// without spinning up a full adapter actor.
    static func resolveToolName(_ payload: [String: Any]) -> String? {
        let nested = payload["message"] as? [String: Any]
            ?? payload["item"] as? [String: Any]
            ?? payload["call"] as? [String: Any]
        return firstJSONValue([
            payload["name"], payload["tool"], payload["toolName"],
            nested?["name"], nested?["tool"],
        ]) as? String
    }

    /// True when a session.tool payload carries zero user-visible signal —
    /// no name (would fall back to the literal "tool" placeholder), no
    /// input, no output. The producer guard in
    /// `emitTimelineEntry(fromSessionTool:)` calls this to drop such rows
    /// at source so they never reach disk, broadcast, or APME hook
    /// routing.
    static func isPlaceholderOnlySessionTool(_ payload: [String: Any]) -> Bool {
        let nested = payload["message"] as? [String: Any]
            ?? payload["item"] as? [String: Any]
            ?? payload["call"] as? [String: Any]
        let name = resolveToolName(payload)
        let input = firstJSONValue([
            payload["input"], payload["arguments"], payload["args"],
            payload["tool_input"], nested?["input"], nested?["arguments"],
        ])
        let output = firstJSONValue([
            payload["output"], payload["result"], payload["error"],
            nested?["output"], nested?["result"], nested?["error"],
        ])
        return name == nil && input == nil && output == nil
    }

    private func emitTimelineEntry(fromSessionTool payload: [String: Any]) {
        let nested = payload["message"] as? [String: Any]
            ?? payload["item"] as? [String: Any]
            ?? payload["call"] as? [String: Any]
        // Resolve tool name and remember whether we hit the literal "tool"
        // fallback so the placeholder guard below can drop rows that carry
        // zero useful signal.
        let resolvedName = Self.resolveToolName(payload)
        let toolName = resolvedName ?? "tool"
        let status = (payload["status"] as? String)
            ?? (payload["state"] as? String)
            ?? (nested?["status"] as? String)
        // Include tool input summary in detail so the timeline row shows what
        // the tool was actually called with, not just its name.
        //
        // `??` short-circuits on `Optional.some(NSNull())`, so a JSON
        // `"input": null` payload would still "succeed" the first
        // candidate and propagate NSNull downstream. `Self.firstJSONValue`
        // unwraps NSNull as absent, so the fallback chain skips past
        // explicit-null fields the way the field-not-present case does.
        let input = Self.firstJSONValue([
            payload["input"], payload["arguments"], payload["args"],
            payload["tool_input"], nested?["input"], nested?["arguments"],
        ])
        let output = Self.firstJSONValue([
            payload["output"], payload["result"], payload["error"],
            nested?["output"], nested?["result"], nested?["error"],
        ])
        // Placeholder-only row drop. When OpenClaw upstream sends a
        // session.tool event with no usable name and no input/output, the
        // resulting timeline row is "tool · running" / "tool · complete"
        // with an empty detail — pure noise that pushes real chat/turn
        // rows off the visible window. Drop at source so the noise
        // never reaches disk, broadcast, or APME hook routing. Mirrors
        // `Self.isPlaceholderOnlySessionTool(_:)` (the testable predicate).
        //
        // Real tool calls (e.g. `name="shell"` + `input={command:...}`)
        // still pass through because either `resolvedName` is non-nil or
        // `input`/`output` carries content.
        if resolvedName == nil, input == nil, output == nil {
            return
        }
        var detailParts: [String] = []
        if let status { detailParts.append("status: \(status)") }
        if let inputSummary = Self.compactDebugValue(input, max: 600) {
            detailParts.append("input: \(inputSummary)")
        }
        if let outputSummary = Self.compactDebugValue(output, max: 600) {
            detailParts.append("output: \(outputSummary)")
        }
        let detail: String? = detailParts.joined(separator: "\n").nonEmpty
        let raw = [toolName, status].compactMap { $0 }.joined(separator: " · ")
        let entry = DaemonTimelineEntry(
            ts: Self.payloadTimestamp(payload),
            type: "tool_exec",
            raw: String(raw.prefix(200)),
            detail: detail,
            approvalId: nil,
            status: status,
            agentType: "openclaw",
            repeatCount: nil,
            automated: nil,
            runId: currentRunId
        )
        // Expose structured tool fields alongside the placeholder `raw` so
        // downstream consumers (DaemonServer → APME hook → steps table)
        // get the real tool name + input/output instead of parsing
        // "{name} · {status}" out of `raw`. Without these the steps table
        // was capturing tool_name="tool" placeholder and an empty payload,
        // making OpenClaw runs uneval­uable on the dashboard and in APME.
        //
        // `firstJSONValue` upstream already strips NSNull, so `input` /
        // `output` are guaranteed nil-or-value here — preventing an
        // `output: null` JSON payload from leaking through as a
        // non-nil `Optional.some(NSNull())` extras value that the router
        // would then mis-classify as "has output → tool_end".
        var extras: [String: Any] = ["toolName": toolName]
        if let input, JSONSerialization.isValidJSONObject(["v": input]) {
            extras["toolInput"] = input
        } else if let inputSummary = Self.compactDebugValue(input, max: 4000) {
            extras["toolInput"] = inputSummary
        }
        if let output, JSONSerialization.isValidJSONObject(["v": output]) {
            extras["toolOutput"] = output
        } else if let outputSummary = Self.compactDebugValue(output, max: 4000) {
            extras["toolOutput"] = outputSummary
        }
        emitTimelineEntry(entry, extras: extras)
    }

    /// Walk an ordered list of `Any?` candidates and return the first one
    /// that is genuinely present — neither Swift `nil` (key absent) nor a
    /// JSON-decoded `NSNull` placeholder (key present with explicit
    /// `null`). `??` alone treats `Optional.some(NSNull())` as "set" and
    /// short-circuits the fallback chain, which is exactly the bug Codex
    /// flagged for tool routing.
    private static func firstJSONValue(_ candidates: [Any?]) -> Any? {
        for c in candidates {
            guard let v = c else { continue }
            if v is NSNull { continue }
            return v
        }
        return nil
    }

    private func emitTimelineEntry(_ entry: DaemonTimelineEntry, extras: [String: Any] = [:]) {
        var entryDict: [String: Any] = [
            "ts": entry.ts,
            "type": entry.type,
            "raw": entry.raw,
        ]
        if let detail = entry.detail { entryDict["detail"] = detail }
        if let approvalId = entry.approvalId { entryDict["approvalId"] = approvalId }
        if let status = entry.status { entryDict["status"] = status }
        if let agentType = entry.agentType { entryDict["agentType"] = agentType }
        if let repeatCount = entry.repeatCount { entryDict["repeatCount"] = repeatCount }
        if let automated = entry.automated { entryDict["automated"] = automated }
        if let runId = entry.runId { entryDict["runId"] = runId }
        if let projectName = entry.projectName { entryDict["projectName"] = projectName }
        if let sessionId = entry.sessionId { entryDict["sessionId"] = sessionId }
        if let startedAt = entry.startedAt { entryDict["startedAt"] = startedAt }
        if let endedAt = entry.endedAt { entryDict["endedAt"] = endedAt }
        // Out-of-band keys (e.g. structured tool name/input/output) that
        // aren't part of the canonical `DaemonTimelineEntry` schema but
        // the immediate consumer (DaemonServer's gateway_timeline_entry
        // handler) needs for APME wiring. WS clients that don't recognize
        // these keys ignore them.
        for (k, v) in extras { entryDict[k] = v }
        _onEvent?([
            "type": "gateway_timeline_entry",
            "entry": entryDict,
        ])
    }

    private static func compactDebugValue(_ value: Any?, max: Int) -> String? {
        guard let value else { return nil }
        let text: String
        if JSONSerialization.isValidJSONObject(value),
           let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            text = json
        } else {
            text = String(describing: value)
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed.count > max ? String(trimmed.prefix(max - 1)) + "…" : trimmed
    }

    private static func payloadTimestamp(_ payload: [String: Any]) -> Double {
        if let ts = payload["ts"] as? NSNumber { return ts.doubleValue }
        if let ts = payload["ts"] as? Double { return ts }
        if let ts = payload["timestamp"] as? NSNumber { return ts.doubleValue }
        return Date().timeIntervalSince1970 * 1000
    }

    private static func parseModelRole(tags: [String]) -> String {
        if tags.contains("default") { return "default" }
        for tag in tags {
            if let suffix = tag.split(separator: "#").last, tag.hasPrefix("fallback#") {
                return "fallback-\(suffix)"
            }
        }
        return "configured"
    }
}

private extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
#endif
