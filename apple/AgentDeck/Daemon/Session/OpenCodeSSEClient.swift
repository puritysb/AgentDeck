#if os(macOS)
// OpenCodeSSEClient.swift — HTTP + SSE client for a user-run OpenCode server.
//
// Swift port of `bridge/src/opencode-client.ts`, read-only subset: health,
// session listing/status, and the `/global/event` SSE stream. Used by
// OpenCodeObserver (opt-in, Settings → Integrations) to monitor OpenCode
// sessions from the sandboxed App Store daemon — plain URLSession to a
// localhost server the USER started (`opencode serve`); no subprocess, no
// port scanning. Steering deliberately not ported: the observer is
// display-only, so `respondPermission`/`sendMessage` stay CLI-territory.
//
// The SSE wire format is `data: <json>\n` frames where the JSON envelope is
// `{directory?, payload: {type, properties}}`. Frame parsing and event
// classification are `nonisolated static` pure functions so XCTest can cover
// them without a live server (mirrors bridge/src/__tests__/opencode-client
// fixtures).

import Foundation

// MARK: - Event classification (pure)

/// One state-relevant update distilled from an OpenCode SSE event.
/// Mirrors the semantics of `opencode-adapter.ts wireSSEEvents`, generalized
/// to multi-session (the adapter tracks one active session; the observer
/// tracks every session the server reports).
struct OpenCodeSessionUpdate: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// session.created / session.updated — refresh title/directory only.
        case upsert
        /// Work signal (assistant message in flight, part update/delta,
        /// status:busy) — the model is generating. `spinner_start` semantics.
        case processing
        /// session.idle — turn finished.
        case idle
        /// permission.requested — display-only awaiting + question.
        case awaitingPermission
        case awaitingQuestion
        case permissionReplied
        case questionReplied
        /// Field-only refresh (e.g. modelID on a completed assistant message)
        /// with no state transition.
        case metadata
    }

    var sessionID: String
    var kind: Kind
    var title: String?
    var directory: String?
    var currentTool: String?
    var modelName: String?
    var question: String?
    var waitID: String?
}

enum OpenCodeEventClassifier {
    /// `data: <json>` → envelope dictionary. Returns nil for keep-alives,
    /// comments (`:`), non-data lines, and malformed JSON.
    nonisolated static func parseSSEDataLine(_ line: String) -> [String: Any]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("data:") else { return nil }
        let jsonStr = String(trimmed.dropFirst("data:".count)).trimmingCharacters(in: .whitespaces)
        guard !jsonStr.isEmpty, let data = jsonStr.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// Classify an SSE envelope into a session update. Unknown event types are
    /// dropped silently (tolerant posture, same as CodexTelemetryModule —
    /// OpenCode's event surface is unversioned).
    nonisolated static func classify(envelope: [String: Any]) -> OpenCodeSessionUpdate? {
        guard let payload = envelope["payload"] as? [String: Any],
              let type = payload["type"] as? String else { return nil }
        var update = classifyPayload(type: type, props: payload["properties"] as? [String: Any] ?? [:])
        // Status/question frames carry their location on the global envelope,
        // not in properties. Keep it for subsequent directory-scoped REST.
        if update?.directory == nil { update?.directory = envelope["directory"] as? String }
        return update
    }

    nonisolated private static func classifyPayload(type: String, props: [String: Any]) -> OpenCodeSessionUpdate? {

        switch type {
        case "session.created", "session.updated":
            guard let info = props["info"] as? [String: Any],
                  let id = info["id"] as? String else { return nil }
            return OpenCodeSessionUpdate(
                sessionID: id,
                kind: .upsert,
                title: info["title"] as? String,
                directory: info["directory"] as? String
            )

        case "session.status":
            guard let id = props["sessionID"] as? String,
                  let status = props["status"] as? [String: Any],
                  (status["type"] as? String) == "busy" else { return nil }
            return OpenCodeSessionUpdate(sessionID: id, kind: .processing)

        case "session.idle":
            guard let id = props["sessionID"] as? String else { return nil }
            return OpenCodeSessionUpdate(sessionID: id, kind: .idle)

        case "message.updated":
            guard let info = props["info"] as? [String: Any],
                  let id = info["sessionID"] as? String else { return nil }
            let role = info["role"] as? String
            let time = info["time"] as? [String: Any]
            let modelID = info["modelID"] as? String
            guard role == "assistant" else { return nil }
            // An assistant message that hasn't completed is the most precise
            // work-start signal OpenCode emits (`session.status:busy` is not
            // reliably sent — see opencode-adapter.ts beginChatIfNeeded).
            if time?["completed"] == nil {
                return OpenCodeSessionUpdate(sessionID: id, kind: .processing, modelName: modelID)
            }
            guard let modelID else { return nil }
            return OpenCodeSessionUpdate(sessionID: id, kind: .metadata, modelName: modelID)

        case "message.part.updated":
            guard let part = props["part"] as? [String: Any],
                  let id = part["sessionID"] as? String else { return nil }
            let tool = (part["type"] as? String) == "tool" ? part["tool"] as? String : nil
            return OpenCodeSessionUpdate(sessionID: id, kind: .processing, currentTool: tool)

        case "message.part.delta":
            // Streamed token delta = model actively generating.
            guard let id = props["sessionID"] as? String else { return nil }
            return OpenCodeSessionUpdate(sessionID: id, kind: .processing)

        case "permission.requested", "permission.asked", "permission.updated":
            guard let id = props["sessionID"] as? String else { return nil }
            let tool = (props["permission"] as? String) ?? (props["tool"] as? String) ?? "tool"
            let question = ((props["title"] as? String) ?? (props["description"] as? String))?.trimmingCharacters(in: .whitespacesAndNewlines)
            return OpenCodeSessionUpdate(
                sessionID: id,
                kind: .awaitingPermission,
                question: (question?.isEmpty == false ? question : nil) ?? "Allow \(tool)?",
                waitID: (props["id"] as? String) ?? (props["permissionID"] as? String)
            )

        case "permission.replied", "question.replied", "question.rejected":
            guard let id = props["sessionID"] as? String, let request = (props["requestID"] as? String) ?? (props["permissionID"] as? String) ?? (props["id"] as? String) else { return nil }
            return OpenCodeSessionUpdate(sessionID: id,
                kind: type == "permission.replied" ? .permissionReplied : .questionReplied, waitID: request)
        case "question.asked":
            guard let id = props["sessionID"] as? String, let request = props["id"] as? String else { return nil }
            let questions = props["questions"] as? [[String: Any]] ?? []
            let text = questions.compactMap { ($0["question"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? ($0["header"] as? String) }.joined(separator: " / ")
            return OpenCodeSessionUpdate(sessionID: id, kind: .awaitingQuestion,
                question: text.isEmpty ? "Answer in OpenCode" : text, waitID: request)

        default:
            return nil
        }
    }
}

/// A hook-owned row cannot be mutated or kept alive by the optional SSE source.
struct OpenCodeObservationOwnership {
    private(set) var sse = Set<String>()
    mutating func acceptSSE(_ id: String, rowExists: Bool) -> Bool {
        guard !rowExists || sse.contains(id) else { return false }
        sse.insert(id)
        return true
    }
    mutating func claimHook(_ id: String) -> Bool { sse.remove(id) != nil }
    mutating func prune(live: Set<String>) { sse.formIntersection(live) }
    mutating func disconnect() -> Set<String> {
        let owned = sse
        sse.removeAll()
        return owned
    }
}

/// Identity-scoped waits shared by the Swift hook and SSE projections.
/// Mirrors HookOpenCodeSessions; shared/opencode-wait-vectors.json gates transitions.
struct OpenCodeWaitState {
    struct Pending {
        var kind: String
        var id: String
        var title: String
    }
    private(set) var pending: [Pending] = []
    var first: Pending? { pending.first }

    @discardableResult
    mutating func consume(event: String, id: String?, title: String?) -> Bool {
        if event == "opencode_stop" || event == "opencode_user_prompt_submit" || event == "opencode_session_end" {
            pending.removeAll()
            return true
        }
        guard let id, !id.isEmpty else { return false }
        let kind = event.contains("permission") ? "permission" : "question"
        if event.hasSuffix("_asked") {
            let flat = (title ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
            let value = Pending(kind: kind, id: id, title: String((flat.isEmpty ? (kind == "permission" ? "Permission requested" : "Answer in OpenCode") : flat).prefix(120)))
            if let index = pending.firstIndex(where: { $0.kind == kind && $0.id == id }) { pending[index] = value }
            else if pending.count < ObservedAgentRules.openCodePendingRequestLimit { pending.append(value) }
            return false
        }
        if event.hasSuffix("_replied") || event.hasSuffix("_rejected"),
           let index = pending.firstIndex(where: { $0.kind == kind && $0.id == id }) {
            pending.remove(at: index)
            return true
        }
        return false
    }
}

// MARK: - Client

/// Read-only OpenCode server client. All REST awaits carry an explicit
/// timeout (external-peer async I/O rule); the SSE stream itself is
/// long-lived by design and terminates via task cancellation.
struct OpenCodeSSEClient: Sendable {
    static let reconnectDirectoryLimit = 32
    private static let inventoryLimit = 200
    private static let reconnectConcurrency = 4

    struct Health: Equatable {
        let healthy: Bool
        let version: String?
    }

    struct SessionSummary: Sendable {
        let id: String
        let title: String?
        let directory: String?
    }

    let baseURL: URL
    private let transport: URLSession?

    init(baseURL: URL, transport: URLSession? = nil) {
        self.baseURL = baseURL
        self.transport = transport
    }

    private func endpoint(_ path: String, directory: String? = nil) -> URL? {
        guard let url = URL(string: path, relativeTo: baseURL),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return nil }
        if let directory {
            components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "directory", value: directory)]
        }
        return components.url
    }

    private static let restTimeout: TimeInterval = 2

    private func restSession() -> URLSession {
        if let transport { return transport }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = Self.restTimeout
        cfg.timeoutIntervalForResource = Self.restTimeout
        return URLSession(configuration: cfg)
    }

    func health() async -> Health? {
        guard let url = URL(string: "/global/health", relativeTo: baseURL) else { return nil }
        let session = restSession()
        defer { if transport == nil { session.finishTasksAndInvalidate() } }
        guard let (data, resp) = try? await session.data(from: url),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return nil }
        return Health(
            healthy: json["healthy"] as? Bool ?? false,
            version: json["version"] as? String
        )
    }

    /// sessionID → "busy"/"idle". Used at connect to seed sessions already
    /// mid-turn (their SSE work signals fired before we attached).
    func sessionStatus(directory: String? = nil) async -> [String: String] {
        guard let url = endpoint("/session/status", directory: directory) else { return [:] }
        let session = restSession()
        defer { if transport == nil { session.finishTasksAndInvalidate() } }
        guard let (data, resp) = try? await session.data(from: url),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return [:] }
        var out: [String: String] = [:]
        for (sid, value) in json {
            if let dict = value as? [String: Any], let type = dict["type"] as? String {
                out[sid] = type
            }
        }
        return out
    }

    /// Pending requests at attachment time. A failed read supplies no evidence
    /// and never resolves a wait. Stream frames are buffered while this runs.
    func pendingRequests(directory: String? = nil) async -> [OpenCodeSessionUpdate] {
        var out: [OpenCodeSessionUpdate] = []
        for kind in ["permission", "question"] {
            guard !Task.isCancelled else { break }
            guard let url = endpoint("/\(kind)", directory: directory) else { continue }
            let session = restSession()
            defer { if transport == nil { session.finishTasksAndInvalidate() } }
            guard let (data, response) = try? await session.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let requests = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { continue }
            for request in requests {
                if let update = OpenCodeEventClassifier.classify(envelope: ["payload": ["type": "\(kind).asked", "properties": request]]) {
                    var located = update
                    located.directory = directory
                    out.append(located)
                }
            }
        }
        return out
    }

    /// Bound cold-attachment discovery; previously observed locations take
    /// priority over the newest 200 stored sessions. No filesystem access.
    func reconnectSnapshot(knownDirectories: [String] = []) async -> [OpenCodeSessionUpdate] {
        let inventory = await recentSessions()
        var directories: [String?] = [nil] // Preserve older-server/default-directory support.
        var seen = Set<String>()
        for directory in knownDirectories + inventory.compactMap(\.directory) {
            guard !directory.isEmpty, seen.insert(directory).inserted else { continue }
            directories.append(directory)
            if directories.count == Self.reconnectDirectoryLimit + 1 { break }
        }
        var updates: [OpenCodeSessionUpdate] = []
        // At most four locations at once, with bounded REST requests. Reading
        // status before waits ensures pending attention wins in each location.
        for start in stride(from: 0, to: directories.count, by: Self.reconnectConcurrency) {
            guard !Task.isCancelled else { break }
            let batch = Array(directories[start..<min(start + Self.reconnectConcurrency, directories.count)])
            let collected = await withTaskGroup(of: [OpenCodeSessionUpdate].self) { group in
                for directory in batch {
                    group.addTask { await snapshot(directory: directory, inventory: inventory) }
                }
                var result: [OpenCodeSessionUpdate] = []
                for await resultForDirectory in group { result += resultForDirectory }
                return result
            }
            updates += collected
        }
        // Default scope may duplicate an explicit directory. Deliver all busy
        // seeds before any pending seeds so duplicate busy never clears a wait.
        var unique = Set<String>()
        return (updates.filter { $0.kind == .processing } + updates.filter { $0.kind != .processing })
            .filter { unique.insert("\($0.sessionID)|\($0.kind)|\($0.waitID ?? "")").inserted }
    }

    private func recentSessions() async -> [SessionSummary] {
        guard let url = endpoint("/experimental/session?limit=\(Self.inventoryLimit)") else { return [] }
        let session = restSession()
        defer { if transport == nil { session.finishTasksAndInvalidate() } }
        guard let (data, response) = try? await session.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return [] }
        return rows.prefix(Self.inventoryLimit).compactMap { row in
            guard let id = row["id"] as? String else { return nil }
            return SessionSummary(id: id, title: row["title"] as? String, directory: row["directory"] as? String)
        }
    }

    private func snapshot(directory: String?, inventory: [SessionSummary]) async -> [OpenCodeSessionUpdate] {
        let status = await sessionStatus(directory: directory)
        guard !Task.isCancelled else { return [] }
        let pending = await pendingRequests(directory: directory)
        var updates = status.filter { $0.value == "busy" }.map { sid, _ in
            let summary = inventory.first { $0.id == sid }
            return OpenCodeSessionUpdate(sessionID: sid, kind: .processing,
                title: summary?.title, directory: summary?.directory ?? directory)
        }
        updates += pending
        return updates
    }

    /// Long-lived SSE read loop over `GET /global/event`. Delivers each
    /// classified update via `onUpdate`; returns when the stream ends or the
    /// surrounding task is cancelled. The caller owns reconnect policy.
    func streamEvents(onConnected: @Sendable () async -> Void, onUpdate: @Sendable (OpenCodeSessionUpdate) async -> Void) async throws {
        guard let url = URL(string: "/global/event", relativeTo: baseURL) else { return }
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // Streaming request: no per-request timeout (the stream is idle
        // between events by design); liveness is the connection itself and
        // the observer's discovery loop re-probes health independently.
        request.timeoutInterval = 24 * 60 * 60

        let session = URLSession(configuration: .ephemeral)
        defer { session.finishTasksAndInvalidate() }
        let (bytes, response) = try await session.bytes(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }

        await onConnected()
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard let envelope = OpenCodeEventClassifier.parseSSEDataLine(line),
                  let update = OpenCodeEventClassifier.classify(envelope: envelope)
            else { continue }
            await onUpdate(update)
        }
    }
}
#endif
