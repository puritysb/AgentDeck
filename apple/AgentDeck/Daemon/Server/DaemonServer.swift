#if os(macOS)
// DaemonServer.swift — Main daemon orchestrator
// Ported from bridge/src/daemon-server.ts — FULL wiring of all modules
//
// Runs in two modes:
//   1. In-process (no CLI present) — owns port 9120, serves pairing/device
//      I/O to iPads, Pixoo, ESP32, D200H. Session count is effectively zero
//      because the Swift daemon does not spawn PTYs (see DaemonService.swift
//      header for the role split).
//   2. External-proxy (CLI is running) — the CLI binds 9120 first; this
//      DaemonServer never starts. DaemonService instead transitions to
//      `isUsingExternalDaemon = true` and the Swift app becomes a WS client
//      of the CLI daemon. Hardware rows are shown only from the external
//      daemon's `state_update.moduleHealth` payload.
//
// Gateway flags (`gatewayAvailable`, `gatewayConnected`, `gatewayHasError`)
// on broadcast events mean:
//   - gatewayAvailable: OpenClaw process reachable on localhost:18789.
//                       Drives topology row visibility.
//   - gatewayConnected: OpenClaw Gateway authenticated (shared token
//                       accepted). Drives crayfish creature rendering
//                       across Mac UI, Android, ESP32 firmware, Pixoo64.
//   - gatewayHasError:  Auth attempt failed or protocol error — surfaces
//                       SICK crayfish + error row in topology.

import Foundation
import IOKit
import IOKit.ps
import Network

private let kIOMessageSystemHasPoweredOn: UInt32 = 0xe0000300

extension Notification.Name {
    static let pixooSettingsChanged = Notification.Name("dev.agentdeck.pixooSettingsChanged")
    /// Posted by IDotMatrixSheet after the user adds/removes/edits an iDotMatrix
    /// device so the BLE module hot-reloads without waiting for the 5s poll.
    static let idotmatrixSettingsChanged = Notification.Name("dev.agentdeck.idotmatrixSettingsChanged")
    /// Posted by TimeboxSheet after the user adds/removes/edits a BLE Timebox
    /// device so the BLE module hot-reloads without waiting for the 5s poll.
    static let timeboxSettingsChanged = Notification.Name("dev.agentdeck.timeboxSettingsChanged")
    /// Posted by AppPreferences after the user changes the display-sleep dim
    /// setting. DaemonServer refreshes `cachedDimConfig` and, if the display
    /// is already asleep, re-broadcasts so devices re-dim to the new level live.
    static let displaySettingsChanged = Notification.Name("dev.agentdeck.displaySettingsChanged")
}

enum CodexHookIdentity {
    /// Codex hook payloads are documented to expose `session_id` and a
    /// thread id under one of several keys (`thread-id`, `thread_id`,
    /// `codex.thread_id`, …). In mixed Codex Desktop / companion-task
    /// environments some turn-scoped hooks have arrived with short numeric
    /// values in BOTH fields — promoting them creates nameless
    /// `codex:8`/`codex:11` rows that survive in `pushedSessionsById` and
    /// render as ghost cloud creatures alongside the real thread.
    /// Apply `isDurableSessionId` to every candidate (thread key first,
    /// `session_id` fallback) so only proper UUID-shaped thread ids become
    /// session rows.
    static func sessionKey(from json: [String: Any]) -> String? {
        if let existing = threadIdSessionKey(from: json) {
            return existing
        }
        guard let raw = (json["session_id"] as? String).flatMap({ $0.isEmpty ? nil : $0 }) else {
            return nil
        }
        let normalized = raw.hasPrefix("codex:") ? String(raw.dropFirst("codex:".count)) : raw
        guard isDurableSessionId(normalized) else { return nil }
        return "codex:\(normalized)"
    }

    static func threadIdSessionKey(from json: [String: Any]) -> String? {
        for key in ["thread-id", "thread_id", "threadId", "codex.thread_id", "thread.id"] {
            if let value = json[key] as? String, !value.isEmpty {
                let normalized = value.hasPrefix("codex:") ? String(value.dropFirst("codex:".count)) : value
                guard isDurableSessionId(normalized) else { continue }
                return "codex:\(normalized)"
            }
        }
        return nil
    }

    static func isDurableSessionId(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 12 else { return false }
        guard trimmed.rangeOfCharacter(from: CharacterSet.decimalDigits.inverted) != nil else {
            return false
        }
        return true
    }
}

enum CodexRolloutResponseReader {
    private static let maxDayDirs = 30
    private static let tailBytes = 128 * 1024

    static func lastAgentMessage(sessionId: String, sessionsRoot: URL? = nil) -> String? {
        guard let file = locateRollout(sessionId: sessionId, sessionsRoot: sessionsRoot) else { return nil }
        let text = readTail(file, maxBytes: tailBytes)
        guard !text.isEmpty else { return nil }
        var lastAgentMessage: String?
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: true).reversed() {
            guard let data = rawLine.data(using: .utf8),
                  let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  record["type"] as? String == "event_msg",
                  let payload = record["payload"] as? [String: Any],
                  let payloadType = payload["type"] as? String else {
                continue
            }
            if payloadType == "task_complete",
               let message = payload["last_agent_message"] as? String,
               !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return message.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if lastAgentMessage == nil,
               payloadType == "agent_message",
               let message = payload["message"] as? String,
               !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                lastAgentMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
                break
            }
        }
        return lastAgentMessage
    }

    static func locateRollout(sessionId: String, sessionsRoot: URL? = nil) -> URL? {
        let normalized = sessionId.hasPrefix("codex:")
            ? String(sessionId.dropFirst("codex:".count))
            : sessionId
        guard normalized.range(of: #"^[0-9a-fA-F-]{8,}$"#, options: .regularExpression) != nil else {
            return nil
        }
        let root = sessionsRoot ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex")
            .appendingPathComponent("sessions")
        let suffix = "-\(normalized).jsonl"
        var checked = 0
        for year in numericDescending(contentsOf: root) {
            let yearURL = root.appendingPathComponent(year, isDirectory: true)
            for month in numericDescending(contentsOf: yearURL) {
                let monthURL = yearURL.appendingPathComponent(month, isDirectory: true)
                for day in numericDescending(contentsOf: monthURL) {
                    checked += 1
                    if checked > maxDayDirs { return nil }
                    let dayURL = monthURL.appendingPathComponent(day, isDirectory: true)
                    for name in safeContents(of: dayURL) {
                        if name.hasPrefix("rollout-"), name.hasSuffix(suffix) {
                            return dayURL.appendingPathComponent(name, isDirectory: false)
                        }
                    }
                }
            }
        }
        return nil
    }

    private static func numericDescending(contentsOf url: URL) -> [String] {
        safeContents(of: url)
            .filter { $0.range(of: #"^\d+$"#, options: .regularExpression) != nil }
            .sorted { (Int($0) ?? 0) > (Int($1) ?? 0) }
    }

    private static func safeContents(of url: URL) -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
    }

    private static func readTail(_ url: URL, maxBytes: Int) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let offset = size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0
        do {
            try handle.seek(toOffset: offset)
            return String(data: handle.readDataToEndOfFile(), encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }
}

/// ESP32 heartbeat callbacks run from the `ESP32Serial` actor, not from the
/// daemon's `@MainActor` context. Store serial-facing event snapshots here so
/// heartbeat code never reaches back into `DaemonServer` actor state.
private final class SerialEventSnapshot: @unchecked Sendable {
    private let lock = NSLock()
    private var stateEvent: [String: Any]?
    private var usageEvent: [String: Any]?
    private var sessionsEvent: [String: Any]?
    private var displayOn = true
    private var displayDim: [String: Any] = ["enabled": true, "mode": "off", "level": 10]

    func setStateEvent(_ event: [String: Any]?) {
        lock.lock()
        stateEvent = event
        lock.unlock()
    }

    func setSessionsEvent(_ event: [String: Any]?) {
        lock.lock()
        sessionsEvent = event
        lock.unlock()
    }

    func setUsageEvent(_ event: [String: Any]?) {
        lock.lock()
        usageEvent = event
        lock.unlock()
    }

    func setDisplayOn(_ value: Bool) {
        lock.lock()
        displayOn = value
        lock.unlock()
    }

    func setDisplayDim(_ value: [String: Any]) {
        lock.lock()
        displayDim = value
        lock.unlock()
    }

    func currentStateEvent() -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        return stateEvent
    }

    func currentSessionsEvent() -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        return sessionsEvent
    }

    func currentUsageEvent() -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        return usageEvent
    }

    func currentDisplayStateEvent() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return ["type": "display_state", "displayOn": displayOn, "dim": displayDim]
    }

    func initialEvents() -> [[String: Any]] {
        lock.lock()
        let state = stateEvent
        let usage = usageEvent
        let sessions = sessionsEvent
        let display = displayOn
        let dim = displayDim
        lock.unlock()

        var events: [[String: Any]] = []
        if let state { events.append(state) }
        if let usage { events.append(usage) }
        // A newly-connected serial board (or one that reconnected across a
        // daemon handoff) must receive the current session roster in its
        // on-connect snapshot — otherwise it renders "no active sessions" until
        // the next unrelated sessions_list change happens to broadcast.
        if let sessions { events.append(sessions) }
        events.append(["type": "display_state", "displayOn": display, "dim": dim])
        return events
    }
}

/// Sendable snapshot of judge backend status for /health endpoint.
/// Matches CLI daemon's `JudgeBackendStatus` interface.
struct JudgeBackendStatus: Sendable {
    let backend: String
    let status: String
    let model: String?
    let endpoint: String?
    let checkedAt: Int
    let reason: String?
}

@MainActor
final class DaemonServer {
    let port: UInt16
    let sessionId = UUID().uuidString
    var onShutdown: (() -> Void)?
    /// Invoked when a CLI (Node) daemon POSTs `/stand-down` to take over the
    /// canonical port. Wired to `DaemonService.standDownForTakeover()`.
    var onStandDownRequested: (() -> Void)?
    private let wsServer = WebSocketServer()
    private let httpServer = HTTPServer()
    private let stateMachine = StateMachine()
    private let registry = SessionRegistry.shared
    private let auth = AuthManager.shared

    // Modules
    private let moduleManager = ModuleManager()
    private let displayMonitor = DisplayMonitor()
    private let gatewayProbe = GatewayProbe()
    private let voiceAssistant = DaemonVoiceAssistant()
    private let openCodeObserver = OpenCodeObserver()
    private let timelineRelay: TimelineRelay
    private let focusRelay: SessionFocusRelay
    private let timelineStore = DaemonTimelineStore()
    private let logStream = BridgeLogStream()
    private let usageAPI = UsageAPIClient.shared
    private var serialModule: SerialModule?
    private var pixooModule: PixooModule?
    private var pixooSettingsObserver: NSObjectProtocol?
    private var idotMatrixModule: IDotMatrixModule?
    private var idotmatrixSettingsObserver: NSObjectProtocol?
    private var timeboxModule: TimeboxModule?
    private var timeboxSettingsObserver: NSObjectProtocol?
    private var displaySettingsObserver: NSObjectProtocol?
    private var adbModule: AdbModule?
    private var d200hModule: D200hHidModule?

    // APME
    private var apmeStore: ApmeStore?
    private var apmeCollector: ApmeCollector?        // Claude Code hooks
    private var apmeCollectorGateway: ApmeCollector? // OpenClaw gateway (separate to avoid activeHookSession collision)
    private var apmeRunner: ApmeRunner?
    private var apmeEvalTimerTask: Task<Void, Never>?

    // Gateway
    private var gatewayAdapter: OpenClawAdapter?
    private var gatewayConnecting = false
    private var cachedGatewayHasError = false
    private var cachedGatewayConnected = false
    /// Wall-clock moment the OpenClaw gateway transitioned to "connected".
    /// Used as the virtual `openclaw-gateway` session's `startedAt` so the
    /// menubar's relative-time chip reads as elapsed-since-connect rather
    /// than the previous 1970-epoch placeholder (which rendered as a
    /// nonsense "20582d"). Cleared on disconnect so the chip disappears
    /// instead of freezing on the prior connect timestamp.
    private var gatewayConnectedAt: Date?
    /// Consecutive probe failures before committing to "unavailable".
    /// Requires 2 consecutive misses (≈10s) before triggering disconnect
    /// so transient glitches don't flash "Not configured" in the UI.
    private var gatewayProbeFailCount = 0
    private static let gatewayProbeDisconnectThreshold = 2
    private var cachedGatewayAuthStatus: String = "gateway_not_found"
    private var cachedGatewayAuthRequestId: String?
    private var cachedGatewayAuthMessage: String?
    /// Locally-generated Gateway identity (Ed25519 public-key SHA-256 hex).
    /// Surfaced in state_update so dashboards can render "approve this
    /// deviceId in OpenClaw Web UI" when pairing is still pending.
    private var cachedGatewayDeviceId: String?

    // Gateway session state — updated ONLY from OpenClaw adapter events.
    // Never written by Claude Code hook events so the two don't cross-contaminate.
    // The shared `stateMachine` tracks Claude Code / hook-driven sessions only.
    private var gatewaySessionState: String = "idle"
    private var gatewayCurrentTool: String? = nil
    private var gatewayModelName: String? = nil

    // State caches
    private var cachedSessions: [DaemonSessionEntry] = []
    private let serialEventSnapshot = SerialEventSnapshot()

    /// Sessions advertised over WS via `session_push_register` from CLI
    /// session bridges. Kept separate from `cachedSessions` so that
    /// `refreshSessions()` — which sources entries from the filesystem
    /// registry — can merge both without clobbering push-based registrations.
    ///
    /// Why this exists: the App Store Swift daemon and the Node CLI use
    /// different data dirs (group container vs `~/.agentdeck`) and the
    /// sandbox blocks Swift from reading `~/.agentdeck/sessions.json`. CLI
    /// session bridges therefore can't be discovered via filesystem — they
    /// register themselves over the daemon WS. Without this map the Swift
    /// daemon stays at 0 sessions even when `agentdeck claude` is running,
    /// which shows up as empty `sessions_list` broadcasts and blank
    /// terrariums on every surface.
    private var pushedSessionsById: [String: DaemonSessionEntry] = [:]

    // Observed-session attention history: the held PreToolUse device-approval
    // gate was removed on 2026-06-27 and stays removed — PreToolUse fires even
    // for tools Claude auto-approves, so gating on it produced false attention
    // + a fabricated Allow/Deny. The *display-only* Notification overlay was
    // restored on 2026-07-05: Claude emits `notification_type:
    // "permission_prompt"` only when a permission prompt is actually shown to
    // the user, so it is a genuine "waiting for explicit response" signal.
    // Observed sessions surface awaiting + question with NO options/requestId
    // (respond-in-terminal UX); accurate steering with real options still
    // exists only on PTY-managed sessions (the CLI).

    // Debounce state for tool-boundary sessions_list broadcasts. State /
    // question transitions never ride this — see scheduleSessionsListBroadcast.
    private var lastSessionsListBroadcastAt: Date = .distantPast
    private var pendingSessionsListFlushTask: Task<Void, Never>?
    private static let sessionsListDebounceSeconds: TimeInterval = 2

    /// Last hook-event wall-clock timestamp per pushed session, keyed on
    /// sessionId. Used to evict sessions whose Claude Code process died
    /// without delivering a `session_end` hook — Claude Code's Stop/End
    /// hooks are ~18% reliable, so without a TTL sweep the sessions list
    /// accumulates ghost entries whose creatures keep swimming (or
    /// "floating") indefinitely. A fresh start-like hook from the same
    /// sessionId resurrects the entry; see `handleHookEvent` and
    /// `evictStaleHookSessions`.
    private var lastHookAtByPushedSession: [String: Date] = [:]

    /// Codex lifecycle hooks can miss the final Stop/turnEnd signal, especially
    /// when the event source is a short-lived companion task. Track the last
    /// processing progress separately so a no-tool Codex row can fall back to
    /// idle without waiting for the much longer session eviction TTL.
    private var codexProcessingTouchedAtBySession: [String: Date] = [:]

    /// Wall-clock timestamp of the last terminal Codex event (`codex_stop`,
    /// `codex_turn_complete`, OTel `turnEnd`) per session. Each Claude Code
    /// rescue/stop-gate run spawns a fresh codex thread (single-turn
    /// "Companion Task") that finishes in 30 s – 2 min; the global
    /// `pushedSessionStaleTTL` of 180 s then keeps each finished thread
    /// visible as its own creature for several minutes after it died, so a
    /// burst of 5 companion tasks shows up as 5 simultaneous codex creatures.
    /// We evict ended threads after `codexPostTerminalTTL` instead, while
    /// keeping the longer no-hook TTL as a safety net for never-terminated
    /// zombies. Cleared only on explicit new-turn signals so late tool/stream
    /// callbacks from a finished turn cannot reanimate the row.
    private var lastTerminalCodexEventBySession: [String: Date] = [:]

    /// Wall-clock timestamp of the last Claude Code `UserPromptSubmit` per
    /// session, used by `appendClaudeCodeChatEnd` to compute the turn
    /// duration shown on the dimmed chat_end row. Mirrors the Node bridge's
    /// `ccChatStart` accounting; without it, chat_end fell back to the same
    /// response prefix as chat_response and the dashboard rendered the turn
    /// as two near-identical lines (one bright ◇, one dimmed ■).
    /// FIFO queue of in-flight chat_start ts per session. A single `Double`
    /// slot used to suffice, but it allowed `chat_start2` to overwrite
    /// `chat_start1`'s ts before the (delayed) Stop hook for Q1 could
    /// stamp `chat_end1.startedAt` — the stamp then anchored to Q2 and
    /// the Timeline-side `sameTurnAnchor` guard accepted the cross-turn
    /// attach as legit (Codex stop-time review #8, 2026-05-17). Queue:
    /// append on every UserPromptSubmit, pop-first on every Stop hook —
    /// FIFO matches Claude Code's serial turn semantics and tolerates
    /// hook-arrival reorderings. Access only through
    /// `enqueueClaudeChatStartTs(sid:ts:)`, `dequeueClaudeChatStartTs(sid:)`
    /// and `clearClaudeChatStartQueue(sid:)`. Backing storage is the
    /// reusable `ChatStartTsQueue` struct so the queue mechanics
    /// themselves are unit-testable without spinning the daemon.
    private var claudeChatStartQueue = ChatStartTsQueue()

    /// Bounded topic prefix (≤80 chars) extracted from the last Claude Code
    /// prompt per session. Mirrors the Node bridge's `ccLastPromptText` use
    /// in `emitCompletion` but stores only the already-extracted topic — not
    /// the full prompt — so we never retain unbounded sensitive user input
    /// in memory. Cleared on chat_end, session_end, and stale eviction so a
    /// later Stop without a fresh UserPromptSubmit cannot reuse a stale
    /// label from a different turn.
    private var claudeLastPromptTopicBySession: [String: String] = [:]
    /// Codex FIFO mirror of `claudeChatStartQueue`. Same race shape:
    /// `appendCodexChatStart` overwrote the per-session slot, so a burst
    /// of new turns could shift the anchor before the matching Stop
    /// arrived. Access through the codex-prefixed enqueue/dequeue helpers.
    private var codexChatStartQueue = ChatStartTsQueue()
    private var codexLastPromptTopicBySession: [String: String] = [:]
    private var codexCurrentToolBySession: [String: String] = [:]

    /// Codex threads that re-engaged after a terminal event (second prompt on
    /// the same thread id). Companion tasks are single-turn by construction,
    /// so re-engagement is the one signal that cleanly separates a long-lived
    /// interactive `codex` CLI session from an ephemeral rescue thread —
    /// interactive threads skip the post-terminal fast evict and get
    /// `codexInteractiveIdleTTL`. Survives eviction (the whole point);
    /// cleared on `session_end`.
    private var codexInteractiveSessionIds: Set<String> = []

    /// Terminal timestamps preserved across eviction (eviction moves
    /// `lastTerminalCodexEventBySession[sid]` here instead of dropping it).
    /// Consulted by the mid-turn resurrection gate; pruned after
    /// `codexTerminalTombstoneTTL`, cleared by explicit new-turn signals.
    private var codexTerminalTombstoneBySession: [String: Date] = [:]

    /// Last non-empty projectName resolved for a Codex thread. Timeline rows
    /// emitted after the session entry was evicted (late Stop hooks, rollout
    /// responses) fall back to this so chat_response/chat_end never lose
    /// their `[project]` attribution to the `[Codex CLI]` agent-tag fallback.
    /// Kept across eviction; cleared on `session_end`, size-capped as a
    /// runaway backstop.
    private var codexProjectNameBySession: [String: String] = [:]

    /// TTL for hook-driven pushed sessions. 3 minutes balances tolerating
    /// long "user is thinking" pauses against clearing ghost entries within
    /// the same coffee break. When a hook arrives after this window, the
    /// `session_start` synthesis path will recreate the entry.
    private static let pushedSessionStaleTTL: TimeInterval = 180

    /// TTL for a pushed session that is currently `awaiting_permission`. A real
    /// permission prompt fires exactly ONE Notification hook and then goes
    /// silent while the user decides — which can legitimately take hours if they
    /// stepped away. Under the ordinary 180 s `pushedSessionStaleTTL` such a
    /// session was evicted mid-wait and its creature vanished from every surface
    /// even though it was still genuinely pending (reported bug). Answering fires
    /// a follow-up hook (PreToolUse/Stop) that clears awaiting instantly, so this
    /// long window only ever covers a true away-wait (kept) or a rare
    /// crash-at-prompt ghost (eventually reaped). Mirrors the Node
    /// `awaiting-overlay` TTL.
    private static let awaitingHookStaleTTL: TimeInterval = 6 * 60 * 60  // 6 hours

    /// A Codex session that is still marked processing but has no active tool
    /// after this window is probably missing its Stop/turnEnd signal. Keep this
    /// short so menubar/D200H status does not show stale WORKING rows.
    private static let codexNoToolProcessingIdleTTL: TimeInterval = 30

    /// A Codex session that is still marked processing with an active tool after
    /// this window has almost certainly missed the tool-end/turn-end callback.
    /// Clear the tool and settle it to idle rather than letting a permanent
    /// "Bash"/"exec" label keep every display in WORKING state.
    private static let codexToolProcessingIdleTTL: TimeInterval = 120

    /// Evict a Codex session this many seconds after its last terminal event
    /// (`codex_stop`, `codex_turn_complete`, OTel `turnEnd`). Companion-task
    /// bursts otherwise stack up under the 180 s no-hook TTL — 60 s is the
    /// shortest window that still leaves room for a follow-up prompt to
    /// re-engage the same thread without forcing a fresh `codex_session_start`.
    private static let codexPostTerminalTTL: TimeInterval = 60

    /// Codex hook/OTel sources are turn-scoped and can die without a session-end
    /// event. Once a non-terminal Codex row has been quiet this long, it is a
    /// display observation rather than a live session.
    private static let codexIdleObservationStaleTTL: TimeInterval = 90

    /// Tool-bearing rows get a longer stale window because long local commands
    /// are normal, but they still need a hard cap for missing end events.
    private static let codexToolObservationStaleTTL: TimeInterval = 240

    /// Idle TTL for a Codex thread promoted to *interactive* (it re-engaged
    /// after a terminal event, so it is a long-lived `codex` CLI conversation,
    /// not a single-turn companion task). The sandbox blocks `ps`, so unlike
    /// the Node daemon we cannot ground liveness in the process table — this
    /// long window is the compromise between the 60/90 s companion TTLs
    /// (which made interactive creatures flap on every turn boundary) and
    /// never reaping a Ctrl-C'd ghost.
    private static let codexInteractiveIdleTTL: TimeInterval = 30 * 60

    /// How long an evicted Codex thread's terminal timestamp survives as a
    /// tombstone. Mid-turn events (`codex_tool_start`/`codex_tool_end`) may
    /// resurrect an unknown session ONLY when no tombstone exists — a live
    /// turn whose row was reaped mid-thinking has none, a finished companion
    /// task's leftover callbacks do.
    private static let codexTerminalTombstoneTTL: TimeInterval = 60 * 60

    /// Singleton row used when Codex OTLP spans have a trace id but no durable
    /// thread id. Keep this in sync with CodexTelemetryModule's fallback id.
    /// `nonisolated` so `hasRealCodexSession(in:)` (also nonisolated) and the
    /// XCTest target — which run off the main actor — can read the literal
    /// without a Swift 6 strict-concurrency violation. The value is an
    /// immutable `let`, so the relaxation is pure compile-time visibility.
    nonisolated private static let codexAnonymousOtelSessionId = "codex:otel-active"
    nonisolated private static let codexCliAgentType = "codex-cli"
    nonisolated private static let codexAppAgentType = "codex-app"
    nonisolated private static let codexAppFallbackProjectName = "Codex App"

    /// Session id of the most recent hook event that carried one. Used to
    /// stamp state_update broadcasts so dashboard clients can attribute
    /// timeline entries + primary-creature state to the right session
    /// when multiple claude sessions are running concurrently.
    private var currentHookSessionId: String?
    /// Session explicitly focused by the user. Kept separate from
    /// `currentHookSessionId` so a new hook from another session does not
    /// move the dashboard's visual selection halo.
    private var userFocusedSessionId: String?
    private var cachedModelCatalog: [[String: Any]] = []
    private var cachedOllamaStatus: [String: Any]?
    /// Cached serial module snapshot — `buildModuleHealthSync` can't
    /// `await` SerialModule.statusSnapshot() (the module is async because
    /// ESP32Serial is an actor), so we pre-fetch into this cache via a
    /// 5s poll. Without this, every state_update arrived with
    /// `serial: {available: true}` and no `connections` array, hiding
    /// every ESP32 board from the Dashboard USB serial section even
    /// though `/health` HTTP showed them correctly via the async path.
    private var cachedSerialStatus: [String: Any]?

    /// Stream Deck plugin self-registration. The Elgato plugin sends a
    /// `client_register` WS command right after connect with the physical
    /// devices it sees — we cache that here so the Dashboard's Downstream
    /// rail can render a Stream Deck row without having to duplicate
    /// Elgato's device enumeration. `connectionId` lets us evict the
    /// entry the moment the plugin's WS closes (see
    /// `handleClientDisconnect`); `updatedAt` is the TTL safety net for
    /// the kill -9 / OS crash cases where we never get a close frame.
    private struct StreamDeckRegistration {
        var connectionId: UUID
        var devices: [[String: Any]]
        var updatedAt: Date
    }
    private var cachedStreamDeck: StreamDeckRegistration?
    /// Wi-Fi WebSocket e-ink panels (XTeink X3 …) that registered as
    /// `clientType:"eink-device"`. Same volunteer-roster + evict-on-close model
    /// as `cachedStreamDeck`. Keyed by WS connection so several panels on the LAN
    /// each survive independently and are evicted the moment their own WS closes.
    private var cachedEinkDevices: [UUID: StreamDeckRegistration] = [:]
    /// Android dashboard apps (tablet / e-ink launcher) connected over Wi-Fi WS
    /// that registered as `clientType:"android-dashboard"`. Same volunteer-roster
    /// + evict-on-close model as `cachedEinkDevices` — without this a WiFi-
    /// connected tablet is an anonymous consumer with no topology row (ADB
    /// classification only covers USB-bridged devices, and only on the CLI tier).
    private var cachedAndroidDashboards: [UUID: StreamDeckRegistration] = [:]
    /// Foundation Models per-session activity summaries, keyed by session id.
    /// `sig` invalidates the cache when the session's tool/state/question changes.
    /// Filled asynchronously; the next sessions_list broadcast surfaces it.
    private var sessionActivityCache: [String: (sig: String, summary: String)] = [:]
    private var sessionActivityInflight: Set<String> = []
    /// Connection that registered as the Ulanzi Studio plugin. While present,
    /// the in-process D200H module stands down (Ulanzi Studio drives the device).
    private var ulanziPluginConnectionId: UUID?
    private var activeWSConnectionIds = Set<UUID>()
    private static let streamDeckStaleTTL: TimeInterval = 120
    private var cachedMlxModels: [String] = []
    private var cachedMlxModelCatalog: [String] = []
    private var cachedJudgeBackendStatus: JudgeBackendStatus?
    private var preferredMlxModelsEndpoint: String?

    // Backoff state for local LLM discovery. Probe functions read/update these;
    // the polling task reads `nextInterval` on every iteration so the sleep
    // stretches exponentially while the service is absent (e.g. right after a
    // PC restart before `ollama serve` / mlx is up). See plan
    // unified-dreaming-gray.md + memory/bug_local_llm_probe_no_backoff.md.
    private var ollamaFailureCount: Int = 0
    private var ollamaNextInterval: TimeInterval = 5
    private var mlxFailureCount: Int = 0
    private var mlxNextInterval: TimeInterval = 5
    private static let probeBaseInterval: TimeInterval = 5
    private static let probeMaxInterval: TimeInterval = 300
    private static let probeStaleThreshold = 3
    private var cachedDisplayOn = true
    /// Resolved display-sleep dim instruction, read from settings.json
    /// (`displaySleepDim`). Defaults reproduce legacy behavior: dim enabled,
    /// full-off. Refreshed on startup and on `.displaySettingsChanged`.
    private var cachedDimConfig: (enabled: Bool, mode: String, level: Int) = (true, "off", 10)
    private var cachedGatewayAvailable = false
    private var cachedPairingUrl: String?
    private var lastStateEvent: [String: Any]?
    private var cachedApiUsage: ApiUsageData?
    /// Codex ChatGPT auth metadata relayed by an unsandboxed sibling bridge.
    /// The App Store daemon cannot read `~/.codex/auth.json` directly, but a
    /// user-started terminal bridge can read it and include the non-secret
    /// plan/expiry fields in `usage_update`. Cache those fields so subsequent
    /// daemon-owned state/usage broadcasts keep the subscription row alive.
    private var relayedCodexAuthStatus: CodexAuthStatus?
    private var lastApiFetchTime: Date = .distantPast
    private static let usageStaleTTL: TimeInterval = 600  // 10 minutes
    private var apiUsageStale = false

    // Anthropic Admin API (Console) usage — independent from subscription
    // OAuth path above. User pastes an admin API key in Settings and the
    // daemon polls `/v1/organizations/usage_report/messages` for today +
    // last 30 days. Cache 10 min TTL, identical stale semantics.
    private var cachedAdminApiUsage: AnthropicAdminUsage?
    private var lastAdminApiFetchTime: Date = .distantPast
    private var adminApiPollTask: Task<Void, Never>?
    private static let adminApiPollInterval: TimeInterval = 600  // 10 minutes
    /// True when cachedApiUsage was synced from relay's already-adjusted values
    private var apiUsagePreAdjusted = false
    private var oauthConnected = false

    // Voice TTS flow: track previous state for PROCESSING→IDLE detection
    private var previousDaemonState: AgentState?

    // Voice assistant state cache for piggybacking on state_update
    private var cachedVoiceAssistantState: String = "disabled"
    private var cachedVoiceAssistantText: String?
    private var cachedVoiceAssistantResponseText: String?

    // Network monitoring
    private var networkMonitor: NWPathMonitor?
    private var lastKnownIP: String?
    private var networkDebounceTask: Task<Void, Never>?

    // App Nap guard. A backgrounded menubar (LSUIElement) daemon with the display
    // asleep is a prime App Nap target — macOS suspends the process and the
    // NWListener stops accepting, so a device request (Stream Deck plugin, iOS
    // companion, serial/Pixoo push) times out and the surface goes stale.
    // Holding a userInitiatedAllowingIdleSystemSleep activity keeps the listener
    // responsive while the Mac is awake; the trailing …AllowingIdleSystemSleep
    // still lets the Mac sleep normally (no laptop-drain).
    private var backgroundActivity: NSObjectProtocol?

    // Polling tasks
    private var sessionPollTask: Task<Void, Never>?
    private var usagePollTask: Task<Void, Never>?
    private var ollamaPollTask: Task<Void, Never>?
    private var mlxPollTask: Task<Void, Never>?
    private var judgeBackendPollTask: Task<Void, Never>?
    private var gatewayPollTask: Task<Void, Never>?
    private var gatewayHealthTask: Task<Void, Never>?
    private var usageTickTask: Task<Void, Never>?
    private var initialUsageTask: Task<Void, Never>?
    private var antigravityPollTask: Task<Void, Never>?

    // Antigravity cache
    private var cachedAntigravityStatus: AntigravityStatus?

    // MARK: - Init

    init(port: Int?, debug: Bool) async throws {
        self.timelineRelay = TimelineRelay(selfPort: port ?? SessionRegistry.defaultPort)
        self.focusRelay = SessionFocusRelay()

        let requestedPort = port ?? SessionRegistry.defaultPort
        var resolvedPort = UInt16(requestedPort)

        // Singleton guard — only when using default port
        if port == nil {
            if let existing = registry.readDaemonInfo() {
                if let health = await registry.probeDaemonHealth(port: existing.port),
                   health["mode"] as? String == "daemon" {
                    DaemonLogger.shared.info("Daemon already running on port \(existing.port) (PID \(existing.pid))")
                    throw DaemonError.alreadyRunning(port: existing.port)
                }
                if !(await registry.isPortBindable(existing.port)) {
                    DaemonLogger.shared.info("Daemon registry exists on port \(existing.port) but health probe is not ready yet; treating as startup race")
                    throw DaemonError.alreadyRunning(port: existing.port)
                }
                DaemonLogger.shared.debug("Daemon", "Stale daemon.json found for PID \(existing.pid) on port \(existing.port); removing")
                registry.removeDaemonInfo()
            }
            if let existing = registry.findExistingDaemon() {
                if let health = await registry.probeDaemonHealth(port: existing.port),
                   health["mode"] as? String == "daemon" {
                    DaemonLogger.shared.info("Daemon already running on port \(existing.port)")
                    throw DaemonError.alreadyRunning(port: existing.port)
                }
                if !(await registry.isPortBindable(existing.port)) {
                    DaemonLogger.shared.info("Daemon session entry exists on port \(existing.port) but health probe is not ready yet; treating as startup race")
                    throw DaemonError.alreadyRunning(port: existing.port)
                }
                DaemonLogger.shared.debug("Daemon", "Stale daemon session entry found for \(existing.id) on port \(existing.port); deregistering")
                registry.deregister(existing.id)
            }
            // Port-scan fallback: a sibling daemon (e.g. the Node CLI daemon)
            // may be alive on a fallback port (9121-9139) while its
            // daemon.json sits in a data dir this sandboxed process can't
            // read (`~/.agentdeck` vs the group container). Without this scan
            // the app would bind 9120 and two daemons would coexist.
            // `requestedPort` is excluded — it gets its own probe below.
            if let scannedPort = await registry.scanForDaemonPort(excluding: [requestedPort]) {
                DaemonLogger.shared.info("Daemon discovered via port scan on \(scannedPort) — connecting as client")
                throw DaemonError.alreadyRunning(port: scannedPort)
            }
            if let health = await registry.probeDaemonHealth(port: requestedPort) {
                if health["mode"] as? String == "daemon" {
                    throw DaemonError.alreadyRunning(port: requestedPort)
                }
                if let alt = await registry.findAvailablePort() {
                    resolvedPort = UInt16(alt)
                } else {
                    throw DaemonError.noPortAvailable
                }
            } else if !(await registry.isPortBindable(requestedPort)) {
                // No health response + pre-check says not bindable. NWListener
                // sets `allowLocalEndpointReuse` (SO_REUSEADDR), so the bind is
                // usually fine despite TIME_WAIT — but the bind+listen probe
                // can still report false right after an abrupt shutdown. Give
                // the kernel a brief moment to reap the previous socket, then
                // commit: either use the requested port (letting NWListener
                // make the final call) or fall back to an alt port. The prior
                // implementation slept up to 15 s here, which turned a fast
                // relaunch-after-kill flow into a perceived freeze on the
                // Dashboard.
                DaemonLogger.shared.info("Port \(requestedPort) not immediately bindable — brief recheck")
                try? await Task.sleep(for: .milliseconds(400))
                // A real daemon may have finished starting during the pause.
                if let health = await registry.probeDaemonHealth(port: requestedPort),
                   health["mode"] as? String == "daemon" {
                    throw DaemonError.alreadyRunning(port: requestedPort)
                }
                if await registry.isPortBindable(requestedPort) {
                    DaemonLogger.shared.info("Port \(requestedPort) reclaimed after 400ms")
                } else if let alt = await registry.findAvailablePort() {
                    DaemonLogger.shared.info("Port \(requestedPort) still held, falling back to \(alt)")
                    resolvedPort = UInt16(alt)
                } else {
                    throw DaemonError.noPortAvailable
                }
            }
        }

        self.port = resolvedPort
        self.cachedPairingUrl = auth.getWsUrl(port: Int(resolvedPort))
    }

    // MARK: - Start (non-blocking)

    /// Register a handler for fatal listener failures (e.g. EADDRINUSE after bind).
    /// Should be called before `startServices()`.
    func setListenerFailedHandler(_ handler: @escaping @Sendable (Error) -> Void) async {
        await wsServer.setListenerFailedHandler(handler)
    }

    func startServices() async throws {
        // 0. Initialize APME store + collector + runner
        let store = ApmeStore()
        if await store.openWithTimeout() {
            apmeStore = store
            let collector = ApmeCollector(store: store)
            apmeCollector = collector
            let gatewayCollector = ApmeCollector(store: store)
            apmeCollectorGateway = gatewayCollector
            // Runner wraps the judge pipeline. In Phase 1 the only backend
            // is Apple Foundation Models (on-device, zero-config). If it's
            // unavailable (Intel Mac, Apple Intelligence off), turn_judge
            // evals silently skip — collector still records everything.
            let runner = ApmeRunner(store: store)
            apmeRunner = runner
            collector.runner = runner
            gatewayCollector.runner = runner

            // Wire task lifecycle → timeline. The collector mints task_start /
            // task_end DaemonTimelineEntry rows on TodoWrite-complete /
            // /clear / session_end. The closure persists them via the same
            // path as chat/tool rows: append to the on-disk store and push
            // through the live WS broadcast (`claudeCodeEntryDict` carries
            // the new taskId/boundarySignal keys added in F1). Without this
            // the dashboard never sees a task_end and the leading task icon
            // spins forever after `/clear`. Mirrors emitTimeline in
            // bridge/src/apme/index.ts:72-103.
            let timelineEmit: (DaemonTimelineEntry) -> Void = { [weak self] entry in
                guard let self else { return }
                Task { await self.timelineStore.add(entry) }
                self.broadcastRaw([
                    "type": "timeline_event",
                    "entry": self.claudeCodeEntryDict(entry),
                ] as [String: Any])
            }
            collector.emitTimelineEntry = timelineEmit
            gatewayCollector.emitTimelineEntry = timelineEmit

            // Phase 6 cutover (default OFF): when AGENTDECK_TIMELINE_PROJECTION=1,
            // the timeline becomes a projection of the SessionSample — locally
            // emitted chat/tool rows are suppressed and re-derived from sample
            // events (added with bypassSuppression). Mirrors the bridge wiring.
            if ProcessInfo.processInfo.environment["AGENTDECK_TIMELINE_PROJECTION"] == "1" {
                Task { await self.timelineStore.setSuppressLocalChatTool(true) }
                let projectedEmit: (DaemonTimelineEntry) -> Void = { [weak self] entry in
                    guard let self else { return }
                    Task { await self.timelineStore.add(entry, bypassSuppression: true) }
                    self.broadcastRaw([
                        "type": "timeline_event",
                        "entry": self.claudeCodeEntryDict(entry),
                    ] as [String: Any])
                }
                collector.emitProjectedTimelineEntry = projectedEmit
                gatewayCollector.emitProjectedTimelineEntry = projectedEmit
                DaemonLogger.shared.info("[APME] timeline projection ENABLED — chat/tool rows derive from SessionSample")
            }

            // Register the eval-result broadcaster. Mirrors the TS daemon's
            // `apme.runner.onResult` handler in bridge/src/daemon-server.ts
            // (lines 902-974). Persists turn-level outcome/composite, emits
            // apmeEval WS events, and appends ★ eval_result timeline entries.
            Task {
                await runner.onResult { [weak self] result in
                    guard let self else { return }
                    Task { @MainActor in
                        self.handleApmeResult(result)
                    }
                }
            }

            // Register the task-evaluated handler. When the task_judge writes
            // its rollup (5–30 s after the original task_end emit), upsert the
            // existing `task_end` timeline row by taskId so dashboard task
            // headers gain a score + outcome badge without a duplicate row.
            // Mirrors `runner.onTaskEvaluated` wiring in
            // bridge/src/apme/index.ts.
            Task {
                await runner.onTaskEvaluated { [weak self] event in
                    guard let self else { return }
                    // The actor listener runs in a nonisolated context but
                    // both `broadcastRaw` and `claudeCodeEntryDict` live on
                    // the main actor — hop via `Task { @MainActor in ... }`
                    // for parity with the `onResult` wiring above.
                    Task { @MainActor in
                        let signalLabel: String
                        switch event.boundarySignal {
                        case "todo_complete": signalLabel = "TODO done"
                        case "clear":         signalLabel = "/clear"
                        case "session_end":   signalLabel = "Session end"
                        case "manual":        signalLabel = "Manual"
                        case "idle_gap":      signalLabel = "Idle gap"
                        default:              signalLabel = "Task end"
                        }
                        let durationSec = max(0, (event.endedAt - event.startedAt) / 1000)
                        let updated = DaemonTimelineEntry(
                            ts: Double(event.endedAt),
                            type: "task_end",
                            raw: "\(signalLabel) · \(durationSec)s",
                            agentType: event.agentType,
                            projectName: event.projectName,
                            sessionId: event.sessionId,
                            startedAt: Double(event.startedAt),
                            endedAt: Double(event.endedAt),
                            runId: event.runId,
                            taskId: event.taskId,
                            boundarySignal: event.boundarySignal,
                            taskScore: event.compositeScore,
                            taskOutcome: event.outcome,
                            taskCategory: event.taskCategory,
                            taskSummary: event.summary
                        )
                        Task { await self.timelineStore.upsert(updated) }
                        self.broadcastRaw([
                            "type": "timeline_event",
                            "entry": self.claudeCodeEntryDict(updated),
                            "upsert": true,
                        ] as [String: Any])
                    }
                }
            }

            let fmReady = ApmeJudgeFoundationModels.isAvailable
            DaemonLogger.shared.info("APME enabled — data will be logged to \(store.dbPath); judge=\(fmReady ? "foundationModels ready" : ApmeJudgeFoundationModels.unavailableReason)")
        }

        // 1. Setup HTTP routes + Bonjour, then start unified server
        await setupHTTPRoutes()
        await wsServer.setHTTPHandler(httpServer)

        // Bonjour mDNS advertisement on the same listener
        let txtRecord = NWTXTRecord([
            "project": "daemon",
            "agent": "daemon",
            "port": "\(port)",
            "ip": AuthManager.getLanIP() ?? "127.0.0.1",
            "token": auth.token,
            "v": "3",
        ])
        await wsServer.setBonjourService(NWListener.Service(
            name: "daemon-\(port)",
            type: "_agentdeck._tcp",
            txtRecord: txtRecord
        ))

        // Await listener `.ready` — throws on bind failure (EADDRINUSE etc).
        // Registry writes must NOT happen before this succeeds.
        try await wsServer.start(port: port)

        // 2. Register session (only after listener is actually bound)
        let entry = DaemonSessionEntry(
            id: sessionId, port: Int(port),
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            projectName: "daemon", agentType: "daemon",
            startedAt: ISO8601DateFormatter().string(from: Date())
        )
        registry.register(entry)
        registry.writeDaemonInfo(DaemonInfo(
            port: Int(port),
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            startedAt: ISO8601DateFormatter().string(from: Date()),
            httpPort: nil
        ))

        // 3. Setup WS handlers
        await setupWSHandlers()

        // 4. Wire state machine
        stateMachine.onStateChanged = { [weak self] oldState, newState in
            self?.handleStateChanged()
        }

        // 5. Start timeline store
        await timelineStore.start()
        // Orphan task_start reaper. The dashboard's `timelineIsInFlightTask`
        // gate spins the leading task icon until a matching `task_end` with
        // the same `taskId` appears in the visible siblings — but a previous
        // daemon process can leave the on-disk timeline with `task_start`
        // rows whose `task_end` was never emitted (force-quit, hook
        // delivery race, closeTask early-return because the active task
        // was already cleared). On startup, walk the persisted entries
        // and upsert a synthetic `task_end` for every orphan so the
        // restored UI doesn't lie about in-flight work that ended with
        // the prior process. `boundarySignal="interrupted"` keeps the row
        // distinguishable from real closes (todo_complete / clear /
        // session_end / idle_gap) in case it ends up downstream of the
        // tuner or judge.
        await reapOrphanTaskStarts()

        // 6. Start display monitor
        loadDisplaySleepDimFromSettings()
        serialEventSnapshot.setDisplayDim(currentDimDict())
        await displayMonitor.start()
        await displayMonitor.setOnStateChanged { [weak self] displayOn in
            Task { @MainActor in
                guard let self else { return }
                self.cachedDisplayOn = displayOn
                self.serialEventSnapshot.setDisplayOn(displayOn)
                self.serialEventSnapshot.setDisplayDim(self.currentDimDict())
                self.broadcastRaw([
                    "type": "display_state",
                    "displayOn": displayOn,
                    "dim": self.currentDimDict(),
                ] as [String: Any])
                if displayOn {
                    DaemonLogger.shared.info("Display wake — recovering modules and state")
                    // Atomic refresh-then-broadcast: refreshSessions() updates
                    // cachedSessions from the live registry AND broadcasts.
                    // Calling broadcastSessionsList() here directly (after a
                    // discard-only registry.listActive()) would publish the
                    // pre-sleep cachedSessions snapshot — stale.
                    Task {
                        await self.refreshSessions()
                        await self.moduleManager.wakeAll()
                    }
                    self.broadcastStateUpdate()
                }
            }
        }

        // 7. Start device modules
        DaemonLogger.shared.info("startServices: step7 startDeviceModules begin")
        await startDeviceModules()
        DaemonLogger.shared.info("startServices: step7 startDeviceModules done")

        // 8. Start timeline relay (subscribes to sibling WS)
        await timelineRelay.setEventHandler { [weak self] event in
            let box = SendableDict(event)
            Task { @MainActor in
                self?.handleRelayedEvent(box.value)
            }
        }
        await timelineRelay.start()
        DaemonLogger.shared.info("startServices: step8 timelineRelay done")

        // 8b. Set up focus relay event callback — merge daemon metadata before broadcasting
        await focusRelay.setBroadcast { [weak self] (box: SendableDict) in
            Task { @MainActor in
                guard let self else { return }
                var event = box.value
                if (event["type"] as? String) == "state_update" {
                    // Preserve daemon-level metadata that session bridges don't have
                    if event["modelCatalog"] == nil, !self.cachedModelCatalog.isEmpty {
                        event["modelCatalog"] = self.cachedModelCatalog
                    }
                    event["gatewayAvailable"] = self.cachedGatewayAvailable
                    event["gatewayConnected"] = self.cachedGatewayConnected
                    event["gatewayAuthStatus"] = self.cachedGatewayAuthStatus
                    if let requestId = self.cachedGatewayAuthRequestId { event["gatewayAuthRequestId"] = requestId }
                    if let message = self.cachedGatewayAuthMessage { event["gatewayAuthMessage"] = message }
                    if event["ollamaStatus"] == nil, let cached = self.cachedOllamaStatus {
                        event["ollamaStatus"] = cached
                    }
                    // Inject focused session's ID so clients can dedup the promoted
                    // session from the siblings list (prevents duplicate creatures).
                    let focusedId = await self.focusRelay.focusedSessionId
                    if let fid = focusedId {
                        event["sessionId"] = fid
                        event["focusedSessionId"] = self.userFocusedSessionId == fid ? fid : ""
                    }

                    // Always override mlxModels with daemon's filtered cache — sibling bridges may
                    // run older/unfiltered code that leaks nanoLLaVA into the list, causing flicker.
                    if !self.cachedMlxModels.isEmpty {
                        event["mlxModels"] = self.cachedMlxModels
                        event["mlxModelCatalog"] = self.cachedMlxModelCatalog
                    } else {
                        event.removeValue(forKey: "mlxModels")
                        event.removeValue(forKey: "mlxModelCatalog")
                    }
                }
                self.broadcastRaw(event)
            }
        }

        // 8c. Sync daemon usage cache when relay receives usage_update (prevents oscillation)
        await focusRelay.setOnUsageRelayed { [weak self] (box: SendableDict) in
            Task { @MainActor in
                guard let self else { return }
                let usage = box.value
                self.updateRelayedCodexAuthStatus(from: usage)
                // Sync rate-limit values (already adjusted by bridge's adjustUsagePercent)
                if self.cachedApiUsage != nil {
                    if let fh = usage["fiveHourPercent"] as? Double {
                        self.cachedApiUsage?.fiveHourPercent = fh
                    }
                    if let sd = usage["sevenDayPercent"] as? Double {
                        self.cachedApiUsage?.sevenDayPercent = sd
                    }
                    self.cachedApiUsage?.fiveHourResetsAt = usage["fiveHourResetsAt"] as? String
                    self.cachedApiUsage?.sevenDayResetsAt = usage["sevenDayResetsAt"] as? String
                    self.apiUsagePreAdjusted = true
                }
            }
        }

        DaemonLogger.shared.info("startServices: step8c focusRelay done")

        // 9. Start polling
        startAllPolling()
        DaemonLogger.shared.info("startServices: step9 startAllPolling done")

        // 10. Initial delayed usage fetch
        initialUsageTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            await self?.fetchUsageRelayed()
        }

        DaemonLogger.shared.info("startServices: step10 initialUsageTask scheduled")

        // 11. Claude Code hooks — HookInstaller now requires explicit user
        // consent (App Store guideline 2.5.2). This call is a no-op unless
        // the user opted in via Settings → "Enable Claude Code Hooks…".
        HookInstaller.installIfNeeded()
        if AppPreferences.shared.hookInstallConsent != .accepted {
            DaemonLogger.shared.info("startServices: step11 HookInstaller skipped (no consent)")
        } else {
            DaemonLogger.shared.info("startServices: step11 HookInstaller done")
        }

        // 11b. Codex observation — same consent model as the Claude
        // hook installer above. We call this on every daemon startup
        // so the OTel `endpoint` baked into ~/.codex/config.toml stays
        // in sync with whichever httpPort the daemon actually bound to
        // (the preferred port can be taken by another process and
        // `DaemonServer` falls back within 9120-9139). Without this,
        // a Codex turn started after a fallback-startup would push
        // OTel spans to a stale port and the dashboard would go dark.
        CodexConfigInstaller.installIfNeeded(daemonHttpPort: Int(port))
        if AppPreferences.shared.codexConfigConsent != .accepted {
            DaemonLogger.shared.info("startServices: step11b CodexConfigInstaller skipped (no consent)")
        } else {
            DaemonLogger.shared.info("startServices: step11b CodexConfigInstaller done")
        }

        // 12. Voice assistant
        voiceAssistant.sendPrompt = { [weak self] text in
            guard let self else { return }
            // Route to gateway or session bridge
            if let gw = self.gatewayAdapter {
                Task { await gw.sendRPC(method: "chat.send", params: ["message": text]) }
                _ = self.stateMachine.transition(trigger: "user_prompt_submit", source: .hook)
                self.broadcastStateUpdate()
            } else {
                self.forwardCommandToSession(AgentCommand.sendPrompt(text: text).dictionary)
            }
        }
        voiceAssistant.onStateChanged = { [weak self] state, text, responseText in
            guard let self else { return }
            // Cache voice state for piggybacking on state_update
            self.cachedVoiceAssistantState = state.rawValue
            self.cachedVoiceAssistantText = text
            self.cachedVoiceAssistantResponseText = responseText
            self.broadcastRaw([
                "type": "voice_assistant_state",
                "state": state.rawValue,
                "deviceId": "mac-builtin",
                "text": text as Any,
                "responseText": responseText as Any,
            ])
            // Also trigger state_update so all clients get voice state
            self.broadcastStateUpdate()
        }
        voiceAssistant.onWakeWordDetected = { [weak self] deviceId, timestamp in
            self?.broadcastRaw([
                "type": "wake_word_detected",
                "deviceId": deviceId,
                "timestamp": timestamp,
            ])
        }
        _ = voiceAssistant.start()
        DaemonLogger.shared.info("startServices: step12 voiceAssistant done")

        // 12.5. OpenCode observer — opt-in (Settings → Integrations, default
        // OFF ⇒ zero probes). Read-only SSE client to a user-run
        // `opencode serve`; updates merge into pushedSessionsById via the
        // same contract as the Codex OTel path.
        openCodeObserver.start(callbacks: OpenCodeObserver.Callbacks(
            onUpdate: { [weak self] update in
                self?.handleOpenCodeObserverUpdate(update)
            },
            onDisconnect: { [weak self] in
                self?.handleOpenCodeObserverDisconnect()
            },
            onKeepalive: { [weak self] in
                self?.touchOpenCodeSessions()
            }
        ))

        // 13. System sleep/wake handling — immediate cleanup on wake
        // Use Darwin notification (IOKit power assertion) — works without AppKit
        let wakePort = IONotificationPortCreate(kIOMainPortDefault)
        if let wakePort {
            IONotificationPortSetDispatchQueue(wakePort, DispatchQueue.main)
            var notifier: io_object_t = 0
            let rootDomain = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
            IOServiceAddInterestNotification(wakePort, rootDomain, kIOGeneralInterest, { (refcon, _, messageType, _) in
                guard messageType == UInt32(kIOMessageSystemHasPoweredOn) else { return }
                guard let refcon else { return }
                let server = Unmanaged<DaemonServer>.fromOpaque(refcon).takeUnretainedValue()
                DaemonLogger.shared.info("System wake — recovering sessions and devices")
                // Atomic refresh-then-broadcast: pulls live registry +
                // pushed sessions, enriches state, then broadcasts the
                // freshly-rebuilt cachedSessions. Calling
                // broadcastSessionsList() directly after a discard-only
                // registry.listActive() would publish the pre-sleep snapshot.
                Task { await server.refreshSessions() }
                // Re-sync timeline relay (drops dead subscriptions)
                Task { await server.timelineRelay.sync() }
                // Re-advertise Bonjour (mDNSResponder may have stale state)
                Task { await server.wsServer.republishBonjour() }
                // Wake all device modules (D200H re-scan, ESP32 reconnect, Pixoo re-sync)
                Task { await server.moduleManager.wakeAll() }
                // Broadcast full state so reconnected devices get fresh data
                Task { @MainActor in server.broadcastStateUpdate() }
                // Refresh usage after network stabilizes (clears stale "!" indicator)
                Task {
                    try? await Task.sleep(for: .seconds(4))
                    await server.fetchUsageRelayed()
                    await MainActor.run { server.broadcastUsage() }
                }
            }, Unmanaged.passUnretained(self).toOpaque(), &notifier)
        }

        // 14. Network change detection — WiFi/VPN/IP changes trigger Bonjour re-publish + module recovery
        lastKnownIP = AuthManager.getLanIP()
        let monitor = NWPathMonitor()
        self.networkMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.networkDebounceTask?.cancel()
                self.networkDebounceTask = Task {
                    try? await Task.sleep(for: .seconds(2))  // 2s debounce
                    guard !Task.isCancelled else { return }

                    if path.status == .satisfied {
                        let newIP = AuthManager.getLanIP()
                        let ipChanged = newIP != self.lastKnownIP
                        if ipChanged {
                            DaemonLogger.shared.info("Network changed — IP: \(self.lastKnownIP ?? "none") → \(newIP ?? "none")")
                            self.lastKnownIP = newIP
                            // Full wake: re-advertise Bonjour, reconnect modules, re-sync timelines
                            await self.wsServer.republishBonjour()
                            await self.moduleManager.wakeAll()
                            await self.timelineRelay.sync()
                            self.broadcastStateUpdate()
                        } else {
                            // IP unchanged — likely WiFi flicker during display sleep or
                            // transient route change. Skip module churn; just refresh timeline
                            // relay (lightweight, drops dead sibling subscriptions).
                            DaemonLogger.shared.debug("Network", "Path update (IP unchanged, skipping wake)")
                            await self.timelineRelay.sync()
                        }
                    } else {
                        DaemonLogger.shared.info("Network unsatisfied — waiting for recovery")
                    }
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "dev.agentdeck.networkmonitor"))

        // 15. Hold a process activity so App Nap can't suspend the listener while the
        // app is backgrounded + the display is asleep (dashboard clients and device
        // modules keep talking to the listener; a napped daemon drops them).
        backgroundActivity = ProcessInfo.processInfo.beginActivity(
            options: .userInitiatedAllowingIdleSystemSleep,
            reason: "Serving local dashboard devices (HTTP/WS)")

        DaemonLogger.shared.info("Daemon running on port \(port) — all modules wired")
    }

    // MARK: - Device Modules

    private func startDeviceModules() async {
        let portInt = Int(port)

        // mDNS: Bonjour is attached to unified WebSocketServer listener — no separate module needed

        // ADB (reverse tunnel only — D200H uses HID now)
        let adb = AdbModule(daemonPort: portInt)
        adb.commandHandler = { [weak self] cmd in
            Task { @MainActor in self?.handleCommand(cmd) }
        }
        self.adbModule = adb
        moduleManager.register(adb)

        // D200H Deck Dock — direct-HID fallback retired; the device is driven
        // exclusively by the Ulanzi Studio plugin (`ulanzi-plugin`). The daemon
        // never opens it over IOKit HID. Flip to re-enable if ever needed.
        let enableD200hDirectHID = false
        if enableD200hDirectHID {
            let d200h = D200hHidModule()
            d200h.commandHandler = { [weak self] cmd in
                Task { @MainActor in self?.handleCommand(cmd) }
            }
            self.d200hModule = d200h
            moduleManager.register(d200h)
        }

        // Serial (ESP32)
        let serial = SerialModule()
        self.serialModule = serial
        moduleManager.register(serial)

        // ESP32 state providers — initial state on connect + heartbeat
        let serialEventSnapshot = serialEventSnapshot
        serial.serial.setStateProviderFn { serialEventSnapshot.currentStateEvent() }
        serial.serial.setUsageProviderFn { serialEventSnapshot.currentUsageEvent() }
        serial.serial.setSessionsListProviderFn { serialEventSnapshot.currentSessionsEvent() }
        serial.serial.setDisplayStateProviderFn { serialEventSnapshot.currentDisplayStateEvent() }
        serial.serial.setInitialStateProviderFn { serialEventSnapshot.initialEvents() }

        // Wire external client count (ESP32 serial connections count as clients for polling guards)
        await wsServer.setExternalClientCountProvider { await serial.serial.connectionCount }

        // Pixoo
        let pixoo = PixooModule()
        self.pixooModule = pixoo
        moduleManager.register(pixoo)
        await pixoo.setOnStateChanged { [weak self] in
            Task { @MainActor [weak self] in
                self?.broadcastStateUpdate()
            }
        }
        pixooSettingsObserver = NotificationCenter.default.addObserver(
            forName: .pixooSettingsChanged, object: nil, queue: .main
        ) { _ in
            Task { await pixoo.reloadFromSettingsExternal() }
        }

        // iDotMatrix (Bluetooth LE — native CoreBluetooth, App Store legal)
        let idotmatrix = IDotMatrixModule()
        self.idotMatrixModule = idotmatrix
        moduleManager.register(idotmatrix)
        await idotmatrix.setOnStateChanged { [weak self] in
            Task { @MainActor [weak self] in
                self?.broadcastStateUpdate()
            }
        }
        idotmatrixSettingsObserver = NotificationCenter.default.addObserver(
            forName: .idotmatrixSettingsChanged, object: nil, queue: .main
        ) { _ in
            Task { await idotmatrix.reloadFromSettingsExternal() }
        }

        // Timebox Mini (BLE — native CoreBluetooth, App Store legal).
        let timebox = TimeboxModule()
        self.timeboxModule = timebox
        moduleManager.register(timebox)
        await timebox.setOnStateChanged { [weak self] in
            Task { @MainActor [weak self] in
                self?.broadcastStateUpdate()
            }
        }
        timeboxSettingsObserver = NotificationCenter.default.addObserver(
            forName: .timeboxSettingsChanged, object: nil, queue: .main
        ) { _ in
            Task { await timebox.reloadFromSettingsExternal() }
        }

        // Display-sleep dim setting changed: refresh cache and, if the display
        // is already asleep, re-broadcast the current state so devices re-dim
        // to the new level/mode without waiting for a wake/sleep cycle.
        displaySettingsObserver = NotificationCenter.default.addObserver(
            forName: .displaySettingsChanged, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.loadDisplaySleepDimFromSettings()
                self.serialEventSnapshot.setDisplayDim(self.currentDimDict())
                if !self.cachedDisplayOn {
                    self.broadcastRaw([
                        "type": "display_state",
                        "displayOn": false,
                        "dim": self.currentDimDict(),
                    ] as [String: Any])
                }
            }
        }

        // Start all
        await moduleManager.startAll()
        DaemonLogger.shared.info("startDeviceModules: moduleManager.startAll done")

        // Seed initial state so serial heartbeat has data from the start
        // (without this, lastStateEvent is nil until first WS client or hook event)
        let gwAlive = cachedGatewayConnected
        lastStateEvent = buildFullStateEvent(agentType: gwAlive ? "openclaw" : "daemon")
        DaemonLogger.shared.info("startDeviceModules: seed state done")

        // Wire serial broadcast hook
        let serialRef = serial
        let pixooRef = pixoo
        let idotmatrixRef = idotmatrix
        let timeboxRef = timebox
        // D200H direct-HID is retired (enableD200hDirectHID == false), so this is
        // nil and the broadcast fan-out below no-ops — the Ulanzi plugin drives it.
        let d200hRef = self.d200hModule
        await wsServer.onBroadcast { [weak self] data in
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

            // Mirror creature agent state in local state machine for metadata persistence
            if let type = json["type"] as? String, type == "state_update" {
                let jsonBox = SendableDict(json)
                Task { @MainActor in
                    guard let self else { return }
                    let json = jsonBox.value
                    if let model = json["model"] as? String ?? json["modelName"] as? String {
                        self.stateMachine.modelName = model
                    }
                    if let project = json["projectName"] as? String {
                        self.stateMachine.projectName = project
                    }
                    if let effort = json["effortLevel"] as? String {
                        self.stateMachine.effortLevel = effort
                    }
                }
            }

            adb.handleBroadcast(json)
            serialRef.wireBroadcast(json)
            // PixooModule is an actor — hop onto its executor via a Task.
            // Box `json` through SendableDict so the Task closure doesn't
            // capture a non-Sendable `[String: Any]`. Broadcast ordering
            // matches Task launch order because the actor serializes
            // incoming calls.
            let pixooEventBox = SendableDict(json)
            Task { await pixooRef.handleEvent(pixooEventBox.value) }
            // iDotMatrix module is also an actor — same SendableDict boxing.
            let idmEventBox = SendableDict(json)
            Task { await idotmatrixRef.handleEvent(idmEventBox.value) }
            // Timebox (BLE) module is also an actor — same SendableDict boxing.
            let timeboxEventBox = SendableDict(json)
            Task { await timeboxRef.handleEvent(timeboxEventBox.value) }
            d200hRef?.handleBroadcast(json)
        }
        DaemonLogger.shared.info("startDeviceModules: wsServer.onBroadcast done")

        // Wire ESP32 WiFi auto-provisioning
        if let wifiConfig = WifiConfigManager.load(), wifiConfig.autoProvision {
            let lanIp = AuthManager.getLanIP() ?? "127.0.0.1"
            let provisionMsg = SendableDict([
                "type": "wifi_provision",
                "ssid": wifiConfig.ssid,
                "password": wifiConfig.password,
                "bridgeIp": lanIp,
                "bridgePort": Int(port),
                "authToken": auth.token,
            ])
            await serial.serial.setOnMessage { [weak self] portPath, msg in
                guard let self else { return }
                if let type = msg["type"] as? String {
                    if type == "device_info", msg["wifiConnected"] as? Bool != true {
                        Task {
                            let sent = await self.serialModule?.serial.sendWifiProvisionToAll(provisionMsg.value) ?? 0
                            if sent > 0 {
                                DaemonLogger.shared.info("WiFi provision sent to \(sent) ESP32 connection(s); trigger port \(portPath)")
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - HTTP Routes

    private func setupHTTPRoutes() async {
        let daemonPort = self.port

        await httpServer.get("/health") { [weak self] _ in
            let health = await self?.buildModuleHealth().value ?? ["state": "disconnected"]
            let state = health["state"] as? String ?? "disconnected"
            // Surface focused session's model + effort on /health so sibling
            // bridges and external dashboards can mirror them without a
            // separate state_update subscription.
            let focus: (model: String?, effort: String?) = await MainActor.run { [weak self] in
                (self?.stateMachine.modelName, self?.stateMachine.effortLevel)
            }
            // Get judge backend status as Sendable value
            let judgeBackend = await MainActor.run { [weak self] in self?.cachedJudgeBackendStatus }
            var payload: [String: Any] = [
                "status": "ok", "mode": "daemon", "port": daemonPort,
                "pid": ProcessInfo.processInfo.processIdentifier,
                "uptime": ProcessInfo.processInfo.systemUptime,
                "state": state,
                "pairingToken": AuthManager.shared.token,
                "modules": health["modules"] as Any,
                "isSwift": true,
            ]
            if let m = focus.model { payload["modelName"] = m }
            if let e = focus.effort { payload["effortLevel"] = e }
            // Add APME/MLX backend status for parity with CLI daemon
            if let jb = judgeBackend {
                var judgeStatus: [String: Any] = [
                    "backend": jb.backend,
                    "status": jb.status,
                    "checkedAt": jb.checkedAt
                ]
                if let model = jb.model { judgeStatus["model"] = model }
                if let endpoint = jb.endpoint { judgeStatus["endpoint"] = endpoint }
                if let reason = jb.reason { judgeStatus["reason"] = reason }
                payload["apme"] = [
                    "enabled": true,
                    "judgeBackend": judgeStatus
                ]
            }
            return .json(payload)
        }

        await httpServer.get("/status") { [weak self] _ in
            let payload = await self?.buildStatusPayload().value
                ?? ["status": "error", "error": "daemon unavailable"]
            return .json(payload)
        }

        await httpServer.get("/usage") { [weak self] _ in
            let usage = await self?.buildUsageEndpointPayload().value
            return .json([
                "status": "ok",
                "usage": usage?["usage"] as Any,
                "fetchedAt": usage?["fetchedAt"] as? Int ?? 0,
            ] as [String: Any])
        }

        await httpServer.get("/devices") { [weak self] _ in
            let devices = await self?.buildDevicesPayload().value ?? ["devices": []]
            return .json(devices)
        }

        await httpServer.post("/d200h/refresh") { [weak self] _ in
            let payload = await self?.forceD200hRefreshPayload().value
                ?? ["status": "error", "error": "daemon unavailable"]
            return .json(payload)
        }

        await httpServer.get("/diag") { [weak self] request in
            let tail = Int(request.queryParams["tail"] ?? "") ?? 200
            let diag = await self?.buildDiagPayload(tail: max(1, min(tail, 1000))).value ?? ["error": "daemon unavailable"]
            return .json(diag)
        }

        await httpServer.post("/shutdown") { [weak self] _ in
            Task { @MainActor in await self?.shutdown() }
            return .json(["status": "shutting_down"])
        }

        // Takeover handshake: a CLI (Node) daemon that wants the canonical port
        // (full Tier-2 feature set) POSTs here first. We yield the port and
        // become a client of the incoming daemon. Ack immediately; the actual
        // stand-down runs async so the caller can proceed to bind.
        await httpServer.post("/stand-down") { [weak self] _ in
            Task { @MainActor in self?.onStandDownRequested?() }
            return .json(["status": "standing_down"])
        }

        // Manual APME task-close endpoint — mirrors the Node bridge
        // POST /task/close route. Drives `closeTaskExternal` on the Swift
        // collector. Body: { sessionId?: string, signal?: "manual",
        // outcome?: "success"|"fail"|"partial"|"abandoned" }. The
        // sessionId defaults to the daemon's active APME session id (which
        // for the App Store build is the daemon meta-session — collector
        // currently tracks a single active task per process).
        await httpServer.post("/task/close") { [weak self] request in
            guard let self else { return .json(["error": "daemon offline"], status: 503) }
            var signal = "manual"
            var outcome: String? = nil
            if let body = request.body,
               let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                if let s = json["signal"] as? String { signal = s }
                if let o = json["outcome"] as? String,
                   ["success", "fail", "partial", "abandoned"].contains(o) {
                    outcome = o
                }
            }
            // Both APME collectors track their own active task (Claude Code
            // hooks vs OpenClaw Gateway). Try gateway first because the
            // macOS app's most common use is OpenClaw chats; fall back to
            // the Claude collector when no gateway task is active. Returns
            // 404 only when neither collector has anything to close.
            let result: (closed: Bool, where: String) = await MainActor.run {
                if let gw = self.apmeCollectorGateway,
                   gw.closeTaskExternal(boundarySignal: signal, outcome: outcome) {
                    return (true, "gateway")
                }
                if let cc = self.apmeCollector,
                   cc.closeTaskExternal(boundarySignal: signal, outcome: outcome) {
                    return (true, "claude")
                }
                return (false, "none")
            }
            var responseBody: [String: Any] = ["closed": result.closed, "signal": signal, "source": result.where]
            if let outcome = outcome { responseBody["outcome"] = outcome }
            return .json(responseBody, status: result.closed ? 200 : 404)
        }

        await httpServer.post("/hook") { [weak self] request in
            guard let body = request.body,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
                return .json(["status": "error"], status: 400)
            }
            Task { @MainActor in await self?.handleHookEvent(json) }
            return .json(["status": "ok"])
        }

        // Claude Code hooks POST to /hooks/:eventName (event name in URL path).
        // Prefix match: /hooks/* captures all hook events.
        await httpServer.post("/hooks/*") { [weak self] request in
            // "/hooks/PreToolUse" → "PreToolUse". Body crosses as Sendable `Data`;
            // deserialization happens inside the MainActor hop so `[String: Any]`
            // never crosses an isolation boundary as a closure parameter (Swift 6
            // sending check). See `daemon-entry-dict-roundtrip` memory.
            let rawName = String(request.path.dropFirst("/hooks/".count))
            let bodyData = request.body ?? Data()
            guard let self else { return .json(["received": true]) }
            if rawName == "PreToolUse" {
                // PreToolUse returns an empty body → Claude's normal permission flow
                // runs untouched. The daemon no longer holds the response for a
                // device gate: hooks carry no real permission options, and PreToolUse
                // fires even for tools Claude auto-approves, so a gate produced false
                // attention + a fabricated Allow/Deny. Genuine waits surface via the
                // display-only Notification overlay (permission_prompt) instead;
                // steering with real options exists only on PTY-managed sessions.
                Task { @MainActor [weak self] in await self?.handleHookPost(rawName: rawName, body: bodyData) }
                return .text("")
            }
            Task { @MainActor [weak self] in await self?.handleHookPost(rawName: rawName, body: bodyData) }
            return .json(["received": true])
        }

        await httpServer.get("/sse") { _ in
            .text("event: connected\ndata: {}\n\n")
        }

        // Pixoo endpoints
        await httpServer.get("/pixoo/preview") { [weak self] _ in
            guard let self else { return .text("No frame available", status: 204) }
            return await self.pixooPngResponse()
        }

        await httpServer.get("/pixoo/frame") { [weak self] _ in
            guard let self else { return .text("No frame available", status: 204) }
            return await self.pixooFrameResponse()
        }

        await httpServer.stream("/pixoo/stream") { [weak self] _, conn in
            guard let self else {
                let raw = Data((HTTPServer.formatHTTPHeaders(status: 503, headers: ["Content-Type": "text/plain"]) + "Connection: close\r\n\r\nPreview unavailable").utf8)
                conn.send(raw) { _ in conn.cancel() }
                return
            }
            await self.streamPixooFrames(on: conn)
        }

        await httpServer.get("/pixoo") { [weak self] _ in
            guard let self else { return .text("Preview unavailable", status: 503) }
            return await self.pixooPreviewResponse()
        }

        // APME routes
        if let store = apmeStore {
            await ApmeHttpRoutes.register(on: httpServer, store: store)
        }

        // Codex OTel HTTP exporter target. Codex (when registered via
        // CodexConfigInstaller) POSTs OTLP/HTTP JSON spans here, which we
        // translate into per-session state transitions on the same
        // pushedSessionsById table the /hooks/* path uses. Body crosses
        // as Sendable `Data`; deserialization happens inside the
        // MainActor hop so `[String: Any]` never crosses an isolation
        // boundary as a closure parameter.
        await CodexOtelRoutes.register(on: httpServer) { [weak self] body in
            Task { @MainActor in await self?.handleCodexTrace(body) }
        }
    }

    private func pixooFrameResponse() -> HTTPServer.HTTPResponse {
        guard let rgb = pixooModule?.currentFrame(),
              let bmp = Self.rgbToBmp(rgb, width: 64, height: 64) else {
            return .text("No frame available", status: 204)
        }
        return HTTPServer.HTTPResponse(
            status: 200,
            headers: [
                "Content-Type": "image/bmp",
                "Cache-Control": "no-store",
            ],
            body: bmp
        )
    }

    private func pixooPngResponse() -> HTTPServer.HTTPResponse {
        guard let rgb = pixooModule?.currentFrame(),
              let png = Self.rgbToPng(rgb, width: 64, height: 64) else {
            return .text("No frame available", status: 204)
        }
        return HTTPServer.HTTPResponse(
            status: 200,
            headers: [
                "Content-Type": "image/png",
                "Cache-Control": "no-store",
            ],
            body: png
        )
    }

    private func pixooPreviewResponse() -> HTTPServer.HTTPResponse {
        let html = Self.pixooPreviewHtml()
        return HTTPServer.HTTPResponse(
            status: 200,
            headers: ["Content-Type": "text/html; charset=utf-8"],
            body: Data(html.utf8)
        )
    }

    private func streamPixooFrames(on conn: HTTPServer.StreamConnection) async {
        let header = HTTPServer.formatHTTPHeaders(status: 200, headers: [
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        ]) + "\r\n"

        let sentHeader = await Self.send(conn, data: Data(header.utf8))
        guard sentHeader else {
            conn.cancel()
            return
        }

        var lastFrameHash: Int?
        while true {
            let frame = await MainActor.run { pixooModule?.currentFrame() }
            if let frame, let bmp = Self.rgbToBmp(frame, width: 64, height: 64) {
                let frameHash = bmp.hashValue
                if frameHash != lastFrameHash {
                    lastFrameHash = frameHash
                    let payload = "event: frame\ndata: \(bmp.base64EncodedString())\n\n"
                    let ok = await Self.send(conn, data: Data(payload.utf8))
                    if !ok { break }
                }
            } else {
                let ok = await Self.send(conn, data: Data(":heartbeat\n\n".utf8))
                if !ok { break }
            }

            try? await Task.sleep(for: .milliseconds(250))
        }

        conn.cancel()
    }

    nonisolated private static func send(_ conn: HTTPServer.StreamConnection, data: Data) async -> Bool {
        await withCheckedContinuation { continuation in
            conn.send(data) { ok in continuation.resume(returning: ok) }
        }
    }

    nonisolated private static func rgbToBmp(_ rgb: Data, width: Int, height: Int) -> Data? {
        let expectedLength = width * height * 3
        guard rgb.count == expectedLength else { return nil }

        let rowBytes = width * 3
        let rowPadding = (4 - (rowBytes % 4)) % 4
        let paddedRowBytes = rowBytes + rowPadding
        let imageSize = paddedRowBytes * height
        let fileSize = 54 + imageSize

        var buffer = Data(count: fileSize)

        buffer.withUnsafeMutableBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }

            base[0] = 0x42
            base[1] = 0x4D
            writeLE32(UInt32(fileSize), to: base, offset: 2)
            writeLE32(54, to: base, offset: 10)
            writeLE32(40, to: base, offset: 14)
            writeLE32(UInt32(width), to: base, offset: 18)
            writeLE32(UInt32(height), to: base, offset: 22)
            writeLE16(1, to: base, offset: 26)
            writeLE16(24, to: base, offset: 28)
            writeLE32(UInt32(imageSize), to: base, offset: 34)

            rgb.withUnsafeBytes { sourceBuffer in
                guard let src = sourceBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
                for y in 0..<height {
                    let srcRow = (height - 1 - y) * rowBytes
                    let dstRow = 54 + (y * paddedRowBytes)
                    for x in 0..<width {
                        let srcIndex = srcRow + (x * 3)
                        let dstIndex = dstRow + (x * 3)
                        base[dstIndex] = src[srcIndex + 2]
                        base[dstIndex + 1] = src[srcIndex + 1]
                        base[dstIndex + 2] = src[srcIndex]
                    }
                }
            }
        }

        return buffer
    }

    nonisolated private static func writeLE16(_ value: UInt16, to base: UnsafeMutablePointer<UInt8>, offset: Int) {
        base[offset] = UInt8(value & 0x00ff)
        base[offset + 1] = UInt8((value >> 8) & 0x00ff)
    }

    nonisolated private static func writeLE32(_ value: UInt32, to base: UnsafeMutablePointer<UInt8>, offset: Int) {
        base[offset] = UInt8(value & 0x000000ff)
        base[offset + 1] = UInt8((value >> 8) & 0x000000ff)
        base[offset + 2] = UInt8((value >> 16) & 0x000000ff)
        base[offset + 3] = UInt8((value >> 24) & 0x000000ff)
    }

    /// Encode raw RGB bytes to PNG (no CoreGraphics dependency).
    /// Uses zlib (Foundation's built-in compression) for IDAT deflate.
    nonisolated private static func rgbToPng(_ rgb: Data, width: Int, height: Int) -> Data? {
        let expectedLength = width * height * 3
        guard rgb.count == expectedLength else { return nil }

        // Build raw IDAT payload: filter byte (0) + RGB row data for each row
        let rowBytes = width * 3
        var rawIDAT = Data(capacity: height * (1 + rowBytes))
        rgb.withUnsafeBytes { src in
            guard let base = src.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for y in 0..<height {
                rawIDAT.append(0) // filter: None
                rawIDAT.append(UnsafeBufferPointer(start: base + y * rowBytes, count: rowBytes))
            }
        }

        // Compress with zlib deflate
        guard let compressed = try? (rawIDAT as NSData).compressed(using: .zlib) as Data else { return nil }

        // Build PNG file
        var png = Data()

        // PNG signature
        png.append(contentsOf: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

        // IHDR chunk
        var ihdr = Data()
        ihdr.appendBE32(UInt32(width))
        ihdr.appendBE32(UInt32(height))
        ihdr.append(8)  // bit depth
        ihdr.append(2)  // color type: RGB
        ihdr.append(0)  // compression
        ihdr.append(0)  // filter
        ihdr.append(0)  // interlace
        png.appendPNGChunk(type: [0x49, 0x48, 0x44, 0x52], data: ihdr)

        // IDAT chunk (zlib-wrapped: CMF + FLG header + deflate + Adler32)
        var idat = Data()
        idat.append(0x78)  // CMF: deflate, window size 32K
        idat.append(0x01)  // FLG: no dict, check bits
        idat.append(compressed)
        // Adler-32 checksum of uncompressed data
        let adler = adler32(rawIDAT)
        idat.appendBE32(adler)
        png.appendPNGChunk(type: [0x49, 0x44, 0x41, 0x54], data: idat)

        // IEND chunk
        png.appendPNGChunk(type: [0x49, 0x45, 0x4E, 0x44], data: Data())

        return png
    }

    nonisolated private static func adler32(_ data: Data) -> UInt32 {
        var a: UInt32 = 1
        var b: UInt32 = 0
        data.withUnsafeBytes { buffer in
            guard let bytes = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for i in 0..<data.count {
                a = (a + UInt32(bytes[i])) % 65521
                b = (b + a) % 65521
            }
        }
        return (b << 16) | a
    }

    nonisolated private static func pixooPreviewHtml() -> String {
        """
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Pixoo Preview</title>
        <style>
        *{box-sizing:border-box}
        body{margin:0;min-height:100vh;background:#09090b;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center}
        .wrap{display:flex;flex-direction:column;gap:14px;align-items:center;padding:24px}
        h1{margin:0;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#a1a1aa}
        .frame{width:320px;height:320px;border-radius:18px;border:1px solid #27272a;background:#000;box-shadow:0 20px 60px rgba(0,0,0,0.45);image-rendering:pixelated}
        .meta{font-size:12px;color:#a1a1aa}
        </style>
        </head>
        <body>
        <div class="wrap">
        <h1>Pixoo 64x64 Preview</h1>
        <img id="frame" class="frame" alt="Pixoo frame" width="320" height="320">
        <div class="meta" id="meta">Waiting for first frame...</div>
        </div>
        <script>
        const img = document.getElementById('frame');
        const meta = document.getElementById('meta');
        let frameNumber = 0;
        let fallbackTimer = null;
        async function refresh() {
          const url = '/pixoo/frame?ts=' + Date.now();
          const res = await fetch(url, { cache: 'no-store' });
          if (res.status === 204) {
            meta.textContent = 'No frame available yet';
            return;
          }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          img.src = URL.createObjectURL(blob);
          frameNumber += 1;
          meta.textContent = 'Frames loaded: ' + frameNumber;
        }
        function startPolling(reason) {
          if (fallbackTimer) return;
          meta.textContent = reason;
          refresh().catch(err => {
            meta.textContent = 'Preview error: ' + (err && err.message ? err.message : err);
          });
          fallbackTimer = setInterval(() => {
            refresh().catch(err => {
              meta.textContent = 'Preview error: ' + (err && err.message ? err.message : err);
            });
          }, 250);
        }
        if (window.EventSource) {
          const es = new EventSource('/pixoo/stream');
          es.addEventListener('frame', e => {
            img.src = 'data:image/bmp;base64,' + e.data;
            frameNumber += 1;
            meta.textContent = 'Frames loaded: ' + frameNumber + ' (SSE)';
          });
          es.onerror = () => {
            es.close();
            startPolling('SSE unavailable, using polling preview');
          };
        } else {
          startPolling('EventSource unavailable, using polling preview');
        }
        </script>
        </body>
        </html>
        """
    }

    @MainActor
    private func buildUsageEndpointPayload() -> SendableDict {
        SendableDict([
            "usage": buildUsageEvent().map { event in
                var payload = event
                payload.removeValue(forKey: "type")
                return payload
            } as Any,
            "fetchedAt": cachedApiUsage == nil ? 0 : Int(lastApiFetchTime.timeIntervalSince1970 * 1000),
        ])
    }

    @MainActor
    private func buildStatusPayload() async -> SendableDict {
        let sessionPayloads = buildSessionsListEvent()["sessions"] as? [[String: Any]] ?? []
        let registrySessions = SessionRegistry.shared.listActive().map {
            [
                "id": $0.id,
                "port": $0.port,
                "projectName": $0.projectName,
                "agentType": $0.agentType as Any,
            ] as [String: Any]
        }
        let health = await buildModuleHealth().value
        return SendableDict([
            "status": "ok",
            "sessions": sessionPayloads,
            "registrySessions": registrySessions,
            "daemon": ["port": Int(port)],
            "modules": health["modules"] as Any,
        ])
    }

    @MainActor
    private func buildDevicesPayload() async -> SendableDict {
        var devices: [[String: Any]] = []

        if let serialModule {
            let serial = await serialModule.statusSnapshot()
            devices.append([
                "type": "esp32_serial",
                "detectedPorts": serial["detectedPorts"] as Any,
                "connections": serial["connections"] as Any,
                "lastOpenError": serial["lastOpenError"] as Any,
                "lastReadError": serial["lastReadError"] as Any,
                "lastWriteError": serial["lastWriteError"] as Any,
            ])
        }

        if let adbModule {
            let adb = adbModule.statusSnapshot()
            devices.append([
                "type": "adb",
                "devices": adb["devices"] as Any,
                "reverseReadyCount": adb["reverseReadyCount"] as Any,
                "lastError": adb["lastError"] as Any,
            ])
        }

        if let pixooModule {
            let pixoo = pixooModule.statusSnapshot()
            devices.append([
                "type": "pixoo",
                "deviceIps": pixoo["deviceIps"] as Any,
                "configuredDeviceCount": pixoo["configuredDeviceCount"] as Any,
                "hasFrame": pixoo["hasFrame"] as Any,
                "lastPushError": pixoo["lastPushError"] as Any,
            ])
        }

        if let idotMatrixModule {
            let idotMatrix = idotMatrixModule.statusSnapshot()
            devices.append([
                "type": "idotmatrix",
                "configuredDeviceCount": idotMatrix["configuredDeviceCount"] as Any,
                "connected": idotMatrix["connected"] as Any,
                "deviceName": idotMatrix["deviceName"] as Any,
                "lastError": idotMatrix["lastError"] as Any,
                "statusReason": idotMatrix["statusReason"] as Any,
                "displayDimmed": idotMatrix["displayDimmed"] as Any,
                "hasFrame": idotMatrix["hasFrame"] as Any,
                "lastPushAtMs": idotMatrix["lastPushAtMs"] as Any,
            ])
        }

        if let timeboxModule {
            let timebox = timeboxModule.statusSnapshot()
            devices.append([
                "type": "timebox",
                "configuredDeviceCount": timebox["configuredDeviceCount"] as Any,
                "connected": timebox["connected"] as Any,
                "deviceName": timebox["deviceName"] as Any,
                "lastError": timebox["lastError"] as Any,
                "statusReason": timebox["statusReason"] as Any,
                "displayDimmed": timebox["displayDimmed"] as Any,
                "hasFrame": timebox["hasFrame"] as Any,
                "lastPushAtMs": timebox["lastPushAtMs"] as Any,
            ])
        }

        if let d200hModule {
            let d200h = d200hModule.statusSnapshot()
            devices.append([
                "type": "d200h",
                "connected": d200h["connected"] as Any,
                "hasConsumerDevice": d200h["hasConsumerDevice"] as Any,
                "hasKeyboardDevice": d200h["hasKeyboardDevice"] as Any,
            ])
        }

        return SendableDict(["devices": devices])
    }

    @MainActor
    private func forceD200hRefreshPayload() -> SendableDict {
        guard let d200hModule else {
            return SendableDict(["status": "error", "error": "d200h module unavailable"])
        }
        return SendableDict([
            "status": "ok",
            "d200h": d200hModule.forceFullRefresh(reason: "HTTP /d200h/refresh"),
        ])
    }

    @MainActor
    private func buildDiagPayload(tail: Int) async -> SendableDict {
        let modules = await buildModuleHealth().value["modules"] as? [String: Any] ?? [:]
        let recentLog = await DaemonLogger.shared.recentLines(limit: tail)
        return SendableDict([
            "status": "ok",
            "state": stateMachine.state.rawValue,
            "sessionId": sessionId,
            "gatewayConnected": cachedGatewayConnected,
            "gatewayAvailable": cachedGatewayAvailable,
            "logStreamRunning": await logStream.isRunning,
            "modules": modules,
            "recentLog": recentLog,
        ])
    }

    // MARK: - WebSocket Handlers

    private func setupWSHandlers() async {
        await wsServer.setCommandHandler { [weak self] cmd, conn in
            let box = SendableDict(cmd)
            Task { @MainActor in self?.handleWSCommand(box.value, from: conn) }
        }

        await wsServer.setConnectHandler { [weak self] conn in
            Task { @MainActor in self?.handleClientConnect(conn) }
        }

        await wsServer.setDisconnectHandler { [weak self] conn in
            Task { @MainActor in self?.handleClientDisconnect(conn) }
        }
    }

    /// WS-only entry point. Intercepts commands that need the originating
    /// connection's identity (`client_register`, so we can evict the
    /// registration when that exact connection closes); everything else
    /// falls through to the connection-agnostic `handleCommand`. Module
    /// callers (ADB, D200H) keep using `handleCommand` directly.
    @MainActor
    private func handleWSCommand(_ cmd: [String: Any], from conn: WebSocketConnection) {
        if cmd["type"] as? String == "client_register" {
            handleClientRegister(cmd, from: conn)
            return
        }
        // Per-session timeline poll: reply (to this requester only) with the
        // session's recent entries so a device that connected mid-session can fill
        // its Detail view without waiting for live events.
        if cmd["type"] as? String == "query_session_timeline" {
            guard let sid = cmd["sessionId"] as? String, !sid.isEmpty else { return }
            let since = cmd["since"] as? Double
            Task { @MainActor [weak self] in
                guard let self else { return }
                let entries = await self.timelineStore.historyForSession(sid, since: since)
                let dicts = entries.map { self.claudeCodeEntryDict($0) }
                let msg: [String: Any] = ["type": "timeline_history", "sessionId": sid, "entries": dicts]
                if let data = msg.jsonData { conn.send(data) }
            }
            return
        }
        handleCommand(cmd)
    }

    // MARK: - Client Connect

    @MainActor
    private func handleClientConnect(_ conn: WebSocketConnection) {
        activeWSConnectionIds.insert(conn.id)
        Task { @MainActor [weak self] in
            guard let self = self else { return }

            let connectionEvent: [String: Any] = [
                "type": "connection",
                "status": "connected",
                "sessionId": self.sessionId,
            ]
            if let data = connectionEvent.jsonData { conn.send(data) }

            try? await Task.sleep(for: .milliseconds(100))
            guard !conn.isDisconnected else { return }

            let gwAlive = self.cachedGatewayConnected
            let stateEvent = self.buildFullStateEvent(agentType: gwAlive ? "openclaw" : "daemon")
            self.lastStateEvent = stateEvent
            if let data = stateEvent.jsonData { conn.send(data) }

            try? await Task.sleep(for: .milliseconds(100))
            guard !conn.isDisconnected else { return }

            // Sessions list
            let sessionsEvent = self.buildSessionsListEvent()
            if let data = sessionsEvent.jsonData { conn.send(data) }

            try? await Task.sleep(for: .milliseconds(100))
            guard !conn.isDisconnected else { return }

            // Timeline history snapshot — Node-daemon parity (bridge-core's
            // connect burst always pushes `timeline_history`, empty included,
            // because clients REPLACE their local store on it). Without this
            // an Android dashboard attached to the Swift daemon (a) started
            // with an empty timeline and (b) never flipped its
            // "receivingBridgeTimeline" suppression flag, so its client-side
            // StateTimelineGenerator kept fabricating "Connected"/"Prompt
            // sent"/tool rows that no Apple surface shows.
            let recentEntries = await self.timelineStore.getRecent(100)
            let historyEvent: [String: Any] = [
                "type": "timeline_history",
                "entries": recentEntries.map { Self.daemonTimelineEntryDict($0) },
            ]
            if let data = historyEvent.jsonData { conn.send(data) }

            try? await Task.sleep(for: .milliseconds(100))
            guard !conn.isDisconnected else { return }

            // Usage
            let usageEvent = self.buildUsageEvent()
            if let data = usageEvent?.jsonData { conn.send(data) }

            // Fetch usage if stale
            if self.cachedApiUsage == nil || Date().timeIntervalSince(self.lastApiFetchTime) > 300 {
                await self.fetchUsageRelayed()
            }
        }
    }

    /// Evict per-connection caches the moment the WS closes. Today the
    /// only such cache is the Stream Deck plugin's `client_register`
    /// roster — without this the row would survive until
    /// `evictStaleClientRegistrations` (120 s TTL) catches up. The TTL
    /// stays as the safety net for kill -9 / OS crash cases where the
    /// close frame never arrives.
    @MainActor
    private func handleClientDisconnect(_ conn: WebSocketConnection) {
        activeWSConnectionIds.remove(conn.id)
        if let sd = cachedStreamDeck, sd.connectionId == conn.id {
            cachedStreamDeck = nil
            DaemonLogger.shared.debug("Daemon", "Evicted streamdeck registration: WS closed")
            broadcastStateUpdate()
        }
        if cachedEinkDevices.removeValue(forKey: conn.id) != nil {
            DaemonLogger.shared.debug("Daemon", "Evicted eink-device registration: WS closed")
            broadcastStateUpdate()
        }
        if cachedAndroidDashboards.removeValue(forKey: conn.id) != nil {
            DaemonLogger.shared.debug("Daemon", "Evicted android-dashboard registration: WS closed")
            broadcastStateUpdate()
        }
        if ulanziPluginConnectionId == conn.id {
            ulanziPluginConnectionId = nil
            DaemonLogger.shared.debug("Daemon", "Ulanzi plugin disconnected — D200H may resume")
            if let d200hModule {
                Task { await d200hModule.setExternalOwner(false) }
            }
            broadcastStateUpdate()
        }
    }

    // MARK: - Session push (from CLI session bridges via WS)

    /// Register a CLI session bridge's advertised identity. The session
    /// bridge lives outside the sandbox (Node process, `~/.agentdeck` world)
    /// and the sandbox blocks the Swift daemon from reading its sessions.json;
    /// this WS-pushed registration is the sole discovery path. Duplicate
    /// registrations for the same `sessionId` just update the existing entry
    /// (idempotent — session bridges re-register on WS reconnect).
    @MainActor
    private func handleSessionPushRegister(_ cmd: [String: Any]) {
        guard let sessionId = cmd["sessionId"] as? String,
              let port = cmd["port"] as? Int else {
            DaemonLogger.shared.debug("Daemon", "session_push_register missing sessionId or port: \(cmd)")
            return
        }
        let agentType = cmd["agentType"] as? String
        let projectName = cmd["projectName"] as? String ?? ""
        var entry = pushedSessionsById[sessionId] ?? DaemonSessionEntry(
            id: sessionId,
            port: port,
            pid: 0, // CLI does not send pid; liveness is inferred from /health probes
            projectName: projectName,
            agentType: agentType,
            tmuxSession: nil,
            tty: nil,
            parentTty: nil,
            startedAt: nil
        )
        // Update mutable fields on re-register (port drift, agent type change).
        if entry.port != port || entry.agentType != agentType || entry.projectName != projectName {
            entry = DaemonSessionEntry(
                id: sessionId,
                port: port,
                pid: 0,
                projectName: projectName,
                agentType: agentType,
                tmuxSession: entry.tmuxSession,
                tty: entry.tty,
                parentTty: entry.parentTty,
                startedAt: entry.startedAt
            )
        }
        evictCodexAnonymousIfNeeded(forIncomingSid: sessionId, agentType: entry.agentType)
        pushedSessionsById[sessionId] = entry
        DaemonLogger.shared.debug("Daemon", "session_push_register: \(sessionId) port=\(port) agent=\(agentType ?? "?")")

        // Merge into cachedSessions immediately so the next sessions_list
        // broadcast reflects the new session without waiting for a probe tick.
        upsertIntoCachedSessions(entry)
        broadcastSessionsList()
    }

    /// Update state/modelName for a previously-registered push session.
    /// Silently ignored when the sessionId isn't known — session bridges
    /// race the initial register vs first state event and push_state may
    /// arrive before the first register.
    @MainActor
    private func handleSessionPushState(_ cmd: [String: Any]) {
        guard let sessionId = cmd["sessionId"] as? String else { return }
        guard var entry = pushedSessionsById[sessionId] else {
            DaemonLogger.shared.debug("Daemon", "session_push_state: unknown sessionId \(sessionId)")
            return
        }
        if let state = cmd["state"] as? String { entry.state = state }
        if let modelName = cmd["modelName"] as? String { entry.modelName = modelName }
        if let effortLevel = cmd["effortLevel"] as? String { entry.effortLevel = effortLevel }
        if let projectName = cmd["projectName"] as? String, !projectName.isEmpty {
            entry = DaemonSessionEntry(
                id: entry.id,
                port: entry.port,
                pid: entry.pid,
                projectName: projectName,
                agentType: entry.agentType,
                tmuxSession: entry.tmuxSession,
                tty: entry.tty,
                parentTty: entry.parentTty,
                startedAt: entry.startedAt
            )
        }
        evictCodexAnonymousIfNeeded(forIncomingSid: sessionId, agentType: entry.agentType)
        pushedSessionsById[sessionId] = entry

        upsertIntoCachedSessions(entry)
        broadcastSessionsList()
    }

    /// Insert-or-update a session entry in `cachedSessions`, preserving sort
    /// order. Used by both `handleSessionPushRegister` and `handleSessionPushState`.
    @MainActor
    private func upsertIntoCachedSessions(_ entry: DaemonSessionEntry) {
        cachedSessions.removeAll { $0.id == entry.id }
        cachedSessions.append(entry)
        cachedSessions = DashboardDataRules.sortSessions(cachedSessions)
    }

    /// Drop every per-session map entry keyed on `sessionId`. Mirrors the
    /// `session_end` cleanup so the anonymous-OTel evict path leaves no
    /// stale `processing`-touched / chat-topic / current-tool residue
    /// behind. Caller decides whether to broadcast.
    @MainActor
    private func purgeCodexSessionState(_ sessionId: String) {
        pushedSessionsById.removeValue(forKey: sessionId)
        cachedSessions.removeAll { $0.id == sessionId }
        codexProcessingTouchedAtBySession.removeValue(forKey: sessionId)
        lastTerminalCodexEventBySession.removeValue(forKey: sessionId)
        codexTerminalTombstoneBySession.removeValue(forKey: sessionId)
        codexInteractiveSessionIds.remove(sessionId)
        codexProjectNameBySession.removeValue(forKey: sessionId)
        clearCodexChatStartQueue(sid: sessionId)
        codexLastPromptTopicBySession.removeValue(forKey: sessionId)
        codexCurrentToolBySession.removeValue(forKey: sessionId)
        lastHookAtByPushedSession.removeValue(forKey: sessionId)
    }

    /// Returns true when at least one real (non-anonymous) Codex session is
    /// being tracked. `nonisolated` so XCTest can call it directly without
    /// hopping onto the main actor.
    nonisolated static func hasRealCodexSession(in entries: [String: DaemonSessionEntry]) -> Bool {
        for (sid, entry) in entries {
            if sid == codexAnonymousOtelSessionId { continue }
            if entry.agentType == codexCliAgentType || entry.agentType == codexAppAgentType { return true }
        }
        return false
    }

    nonisolated private static func hasRealCodexAppSession(in entries: [String: DaemonSessionEntry]) -> Bool {
        for (sid, entry) in entries {
            if sid == codexAnonymousOtelSessionId { continue }
            if entry.agentType == codexAppAgentType { return true }
        }
        return false
    }

    /// Drop the OTel anonymous placeholder (`codex:otel-active`) only when a
    /// real-thread-id Codex App entry is about to be inserted. CLI hook
    /// sessions are a different source and must coexist with the Codex App
    /// observation row.
    @MainActor
    private func evictCodexAnonymousIfNeeded(forIncomingSid sid: String, agentType: String?) {
        guard agentType == Self.codexAppAgentType else { return }
        guard sid != Self.codexAnonymousOtelSessionId else { return }
        guard pushedSessionsById[Self.codexAnonymousOtelSessionId] != nil else { return }
        purgeCodexSessionState(Self.codexAnonymousOtelSessionId)
    }

    // MARK: - Commands

    @MainActor
    private func handleCommand(_ cmd: [String: Any]) {
        guard let type = cmd["type"] as? String else { return }
        DaemonLogger.shared.debug("Daemon", "cmd: \(type)")

        // Session bridge self-registration — must run BEFORE the gateway
        // adapter dispatch so that a gateway-driven mode doesn't swallow
        // the push. Mirrors the `onRawMessage` interception used by the
        // Node daemon in `bridge/src/daemon-server.ts`.
        if type == "session_push_register" {
            handleSessionPushRegister(cmd)
            return
        }
        if type == "session_push_state" {
            handleSessionPushState(cmd)
            return
        }

        // Gateway exec approval (OpenClaw) — resolve the held RPC approval. The
        // observed-Claude device-approval gate was removed, so this only serves
        // the OpenClaw exec-approval path now.
        if type == "permission_decision" {
            guard let requestId = cmd["requestId"] as? String,
                  let decision = cmd["decision"] as? String,
                  decision == "allow" || decision == "deny" else { return }
            if let gw = gatewayAdapter {
                let cmdBox = SendableDict(cmd)
                Task { await gw.sendRPC(method: "exec.approval.resolve", params: cmdBox.value) }
                return
            }
            DaemonLogger.shared.debug("Daemon", "permission_decision: no gateway for request \(requestId)")
            return
        }

        // `client_register` is intercepted in `handleWSCommand` (it needs
        // the originating WS connection identity for close-driven eviction).
        // Module callers (ADB, D200H) never send it.

        // Gateway adapter handles command if alive
        if let gw = gatewayAdapter {
            let cmdBox = SendableDict(cmd)
            switch type {
            case "respond": Task { await gw.sendRPC(method: "exec.approval.resolve", params: cmdBox.value) }
                _ = stateMachine.transition(trigger: "user_response", source: .user); broadcastStateUpdate()
            case "interrupt": Task { await gw.sendRPC(method: "chat.abort", params: [:]) }
                _ = stateMachine.transition(trigger: "interrupt", source: .user); broadcastStateUpdate()
            case "select_option": Task { await gw.sendRPC(method: "exec.approval.resolve", params: cmdBox.value) }
                _ = stateMachine.transition(trigger: "user_sㅈelection", source: .user); broadcastStateUpdate()
            case "send_prompt": Task { await gw.sendRPC(method: "chat.send", params: cmdBox.value) }
                _ = stateMachine.transition(trigger: "user_prompt_submit", source: .hook); broadcastStateUpdate()
            case "escape": Task { await gw.sendRPC(method: "chat.abort", params: [:]) }
                _ = stateMachine.transition(trigger: "interrupt", source: .user); broadcastStateUpdate()
            default: break
            }
            if type != "switch_agent" && type != "query_usage" && type != "focus_session"
                && type != "clear_session_focus"
                && type != "mode_toggle" && type != "session_switch" && type != "usage_toggle" { return }
        }

        switch type {
        case "focus_session":
            if let sessionId = cmd["sessionId"] as? String {
                focusSession(sessionId)
            }
            return
        case "clear_session_focus":
            clearSessionFocus()
            return
        case "session_command":
            guard let sessionId = cmd["sessionId"] as? String,
                  let innerCommand = cmd["command"] as? [String: Any] else { return }
            let sessions = cachedSessions
            guard let targetSession = sessions.first(where: { $0.id == sessionId }) else {
                DaemonLogger.shared.debug("Daemon", "session_command: session \(sessionId) not found")
                return
            }
            userFocusedSessionId = sessionId
            broadcastStateUpdate()
            let cmdBox = SendableDict(innerCommand)
            let focusLocally = isLocalObservedSession(targetSession)
            Task {
                if focusLocally {
                    await self.focusRelay.focusLocal(sessionId: sessionId)
                } else {
                    await self.focusRelay.focus(sessionId: sessionId)
                }
                try? await Task.sleep(for: .milliseconds(100))
                _ = await self.focusRelay.routeCommand(cmdBox.value)
            }
            return
        case "respond", "interrupt", "escape", "select_option", "send_prompt", "navigate_option", "switch_mode":
            // Session-scoped option select from a multi-up panel (IPS10 D1 mosaic):
            // any awaiting cell can be answered, not just the focused one. Focus the
            // named session first, then route a plain select_option to its bridge.
            if type == "select_option",
               let sessionId = cmd["sessionId"] as? String,
               let target = cachedSessions.first(where: { $0.id == sessionId }) {
                userFocusedSessionId = sessionId
                broadcastStateUpdate()
                let inner = SendableDict(["type": "select_option", "index": cmd["index"] ?? 0])
                let focusLocally = isLocalObservedSession(target)
                Task {
                    if focusLocally {
                        await self.focusRelay.focusLocal(sessionId: sessionId)
                    } else {
                        await self.focusRelay.focus(sessionId: sessionId)
                    }
                    try? await Task.sleep(for: .milliseconds(100))
                    _ = await self.focusRelay.routeCommand(inner.value)
                }
                return
            }
            // Route to focused session if available, otherwise legacy forwarding
            let cmdBox = SendableDict(cmd)
            Task {
                let routed = await self.focusRelay.routeCommand(cmdBox.value)
                if !routed {
                    await MainActor.run { self.forwardCommandToSession(cmdBox.value) }
                }
            }
            // Update local state machine
            switch type {
            case "respond":
                if stateMachine.state == .awaitingPermission || stateMachine.state == .awaitingDiff {
                    _ = stateMachine.transition(trigger: "user_response", source: .user); broadcastStateUpdate()
                }
            case "select_option":
                if stateMachine.state == .awaitingOption {
                    _ = stateMachine.transition(trigger: "user_selection", source: .user); broadcastStateUpdate()
                }
            case "interrupt":
                _ = stateMachine.transition(trigger: "interrupt", source: .user); broadcastStateUpdate()
            default: break
            }
            return
        case "query_usage":
            Task {
                await fetchUsageRelayed()
                await MainActor.run { self.broadcastUsage() }
            }
        case "switch_agent":
            userFocusedSessionId = nil
            Task { await focusRelay.unfocus() }
            handleSwitchAgent(cmd["agent"] as? String ?? "")
        case "mode_toggle":
            // D200H button 0: cycle mode via focused session (sends Shift+Tab to PTY)
            let modeCmd = SendableDict(AgentCommand.switchMode(mode: nil).dictionary)
            Task {
                let routed = await self.focusRelay.routeCommand(modeCmd.value)
                if !routed {
                    await MainActor.run { self.forwardCommandToSession(modeCmd.value) }
                }
            }
        case "session_switch":
            // D200H button 1: cycle focus to next session
            let sessions = cachedSessions
            guard !sessions.isEmpty else { break }
            let selfPort = Int(port)
            Task {
                let currentId = await self.focusRelay.focusedSessionId
                let currentIdx = sessions.firstIndex(where: { $0.id == currentId }) ?? -1
                let nextIdx = (currentIdx + 1) % sessions.count
                let nextSession = sessions[nextIdx]
                await MainActor.run {
                    self.userFocusedSessionId = nextSession.id
                    self.broadcastStateUpdate()
                }
                if nextSession.port == selfPort || nextSession.pid == 0 {
                    await self.focusRelay.focusLocal(sessionId: nextSession.id)
                } else {
                    await self.focusRelay.focus(sessionId: nextSession.id)
                }
            }
        case "usage_toggle":
            // D200H button 2: trigger usage fetch
            Task { await fetchUsageRelayed() }
        case "utility":
            let util = UtilityProxy()
            util.handleCommand(cmd["action"] as? String ?? "", value: cmd["value"] as? Int)
        default:
            DaemonLogger.shared.debug("Daemon", "Unknown command: \(type)")
        }
    }

    @MainActor
    private func focusSession(_ sessionId: String) {
        if sessionId == "openclaw-gateway", cachedGatewayConnected || cachedGatewayHasError {
            userFocusedSessionId = sessionId
            Task { await focusRelay.unfocus() }
            broadcastStateUpdate()
            return
        }

        guard let session = cachedSessions.first(where: { $0.id == sessionId }) else {
            DaemonLogger.shared.debug("Daemon", "focus_session ignored stale session \(sessionId)")
            return
        }

        userFocusedSessionId = sessionId
        broadcastStateUpdate()

        if isLocalObservedSession(session) {
            Task { await focusRelay.focusLocal(sessionId: sessionId) }
        } else {
            Task { await focusRelay.focus(sessionId: sessionId) }
        }
    }

    @MainActor
    private func clearSessionFocus() {
        userFocusedSessionId = nil
        Task { await focusRelay.unfocus() }
        broadcastStateUpdate()
    }

    private func isLocalObservedSession(_ session: DaemonSessionEntry) -> Bool {
        session.port == Int(port) || session.pid == 0
    }

    private func handleSwitchAgent(_ target: String) {
        if target == "openclaw", cachedGatewayConnected {
            let event = buildFullStateEvent(agentType: "openclaw")
            lastStateEvent = event
            broadcastRaw(event)
        } else if target == "claude-code" {
            let event = buildFullStateEvent(agentType: "daemon")
            lastStateEvent = event
            broadcastRaw(event)
        }
    }

    // MARK: - Hook Events

    @MainActor
    private func handleHookEvent(_ json: [String: Any]) async {
        guard let event = json["event"] as? String else { return }
        DaemonLogger.shared.debug("Hook", "Received: \(event)")

        // opencode_* lifecycle hooks (posted by AgentDeck's OpenCode observer
        // plugin) are consumed by the Node daemon's observed-session pipeline.
        // The Swift daemon has no OpenCode turn pipeline yet — without this
        // guard the generic Claude fallbacks below would synthesize a phantom
        // claude-typed session row for every OpenCode session id and route
        // opencode_* steps into the Claude-keyed ApmeCollector (the same
        // mis-attribution hazard the codex_ filter guards). Standalone
        // OpenCode visibility on the Swift daemon still comes from
        // PassiveSessionObserver; timeline parity is a documented follow-up.
        if event.hasPrefix("opencode_") { return }

        // Per-session id extraction. The global state_machine transitions
        // below remain for backwards compatibility with surfaces that read
        // the aggregate state (menubar badge, D200H). The authoritative
        // per-session state lives on `pushedSessionsById` entries so that
        // multi-session terrariums render each creature independently —
        // without this a Stop in one session drags the other session's
        // creature to idle too, because the terrarium falls back to global
        // state when session.state is nil.
        //
        // Codex lifecycle hooks document `session_id` as the current thread,
        // but some turn-scoped companion events have surfaced short numeric
        // values there. Route Codex ids through CodexHookIdentity so only
        // durable thread ids become `codex:<id>` session rows.
        let isCodexEvent = event.hasPrefix("codex_")
        let sessionId: String? = {
            if isCodexEvent {
                return CodexHookIdentity.sessionKey(from: json)
            }
            return (json["session_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? CodexHookIdentity.threadIdSessionKey(from: json)
        }()

        // Resurrection: Claude Code only fires `session_start` once per
        // claude process lifetime. If the AgentDeck daemon restarts mid-
        // session, the next event from that ongoing process (tool_start,
        // user_prompt_submit, stop, notification) is the first hook we
        // see — without an entry, `updateSessionHookState` would no-op
        // and the sessions list would stay empty until the user killed
        // and restarted every claude. Synthesize a minimal entry on any
        // non-end event when the sessionId is unknown; the subsequent
        // per-event `updateSessionHookState` then sets the right state.
        // Codex mid-turn events may resurrect an unknown session ONLY when no
        // terminal tombstone exists: a live turn whose row was reaped by the
        // idle-observation TTL mid-thinking keeps streaming tool events with
        // no terminal record, while a finished companion task's leftover
        // callbacks always trail a codex_stop/turnEnd tombstone. Without this
        // gate an actively-working `codex` CLI session stayed invisible from
        // the moment of eviction until the user's NEXT prompt.
        let codexMidTurnResurrection = isCodexEvent
            && (event == "codex_tool_start" || event == "codex_tool_end")
            && sessionId.map {
                codexTerminalTombstoneBySession[$0] == nil
                    && lastTerminalCodexEventBySession[$0] == nil
            } == true
        if let sessionId,
           Self.shouldSynthesizeUnknownHookSession(event: event, isCodexEvent: isCodexEvent)
               || codexMidTurnResurrection,
           pushedSessionsById[sessionId] == nil {
            // Codex hooks use the `codex_*` event prefix and synthesize
            // sessionIds as `codex:<thread-id>`; tag those entries with
            // the matching agentType so creature renderers downstream
            // (Pixoo, D200H, Terrarium, SessionListPanel) pick the Codex
            // brand instead of mis-painting them as Claude Code.
            let resurrectedAgentType = isCodexEvent ? "codex-cli" : "claude-code"
            let resurrectedProjectName = Self.nonEmptyString(ProjectNameResolver.projectName(fromHookPayload: json))
                ?? (isCodexEvent ? codexProjectNameBySession[sessionId] : nil)
                ?? ""
            var entry = DaemonSessionEntry(
                id: sessionId,
                port: Int(port),
                pid: 0,
                projectName: resurrectedProjectName,
                agentType: resurrectedAgentType,
                tmuxSession: nil,
                tty: nil,
                parentTty: nil,
                startedAt: ISO8601DateFormatter().string(from: Date())
            )
            entry.state = "idle"
            pushedSessionsById[sessionId] = entry
            upsertIntoCachedSessions(entry)
            DaemonLogger.shared.debug("Hook", "Resurrected session entry for \(sessionId) on \(event)")
            // Intentionally no broadcast here — the event's own
            // updateSessionHookState (or session_start path) will broadcast.
        }

        if shouldIgnorePostTerminalCodexProgress(sessionId: sessionId, event: event) {
            DaemonLogger.shared.debug("Hook", "Ignored late Codex progress event \(event) for finished session \(sessionId ?? "(nil)")")
            return
        }

        // For `user_prompt_submit`, run the APME collector BEFORE the switch's
        // `appendClaudeCodeChatStart` so the chat row can be tagged with the
        // task it belongs to — consecutive prompts then nest under one task
        // header instead of each reading as a separate task. Only this event is
        // hoisted; every other event keeps the post-switch collector call below
        // so, e.g., `session_end`'s `task_end` still emits after the turn's
        // `chat_end` (natural order). `apmeHandledEarly` prevents a double-run.
        var apmeHandledEarly = false
        if event == "user_prompt_submit" {
            apmeCollector?.handleHook(event: event, data: json)
            apmeHandledEarly = true
        }

        switch event {
        case "codex_session_start":
            _ = stateMachine.transition(trigger: "session_start", source: .hook)
            let projectName = ProjectNameResolver.projectName(fromHookPayload: json)
            if !projectName.isEmpty { stateMachine.projectName = projectName }
            if let sessionId {
                var entry: DaemonSessionEntry
                if let existing = pushedSessionsById[sessionId] {
                    entry = existing.projectName.isEmpty && !projectName.isEmpty
                        ? DaemonSessionEntry(
                            id: existing.id,
                            port: existing.port,
                            pid: existing.pid,
                            projectName: projectName,
                            agentType: "codex-cli",
                            tmuxSession: existing.tmuxSession,
                            tty: existing.tty,
                            parentTty: existing.parentTty,
                            startedAt: existing.startedAt
                        )
                        : existing
                } else {
                    entry = DaemonSessionEntry(
                        id: sessionId,
                        port: Int(port),
                        pid: 0,
                        projectName: projectName,
                        agentType: "codex-cli",
                        tmuxSession: nil,
                        tty: nil,
                        parentTty: nil,
                        startedAt: ISO8601DateFormatter().string(from: Date())
                    )
                }
                entry.agentType = "codex-cli"
                entry.state = "idle"
                pushedSessionsById[sessionId] = entry
                upsertIntoCachedSessions(entry)
                codexRegisterNewTurnSignal(sessionId: sessionId)
                broadcastSessionsList()
            }
        case "session_start":
            _ = stateMachine.transition(trigger: "session_start", source: .hook)
            let projectName = ProjectNameResolver.projectName(fromHookPayload: json)
            if !projectName.isEmpty { stateMachine.projectName = projectName }
            // App Store standalone: hook POST is the only Claude Code session
            // signal (sandbox blocks sessions.json; no WS push arrives without
            // the external Node bridge). Synthesize an entry keyed on Claude's
            // session_id so dashboards populate — a later session_push_register
            // with the same id merges cleanly via upsertIntoCachedSessions.
            //
            // agentType MUST be "claude-code" — it's the canonical value every
            // downstream creature renderer allowlists (Pixoo Swift/Node, plugin,
            // Android). Using bare "claude" here made hook-only sessions invisible
            // on every surface except the macOS Terrarium (which uses a denylist).
            if let sessionId {
                var entry = DaemonSessionEntry(
                    id: sessionId,
                    port: Int(port),
                    pid: 0,
                    projectName: projectName,
                    agentType: "claude-code",
                    tmuxSession: nil,
                    tty: nil,
                    parentTty: nil,
                    startedAt: ISO8601DateFormatter().string(from: Date())
                )
                entry.state = "idle"
                pushedSessionsById[sessionId] = entry
                upsertIntoCachedSessions(entry)
                broadcastSessionsList()
            }
        case "user_prompt_submit":
            _ = stateMachine.transition(trigger: "user_prompt_submit", source: .hook)
            updateSessionHookState(sessionId: sessionId, state: "processing")
            // Timeline: user's question opens a chat turn so the dashboard
            // renders Claude Code activity alongside OpenClaw/OpenCode. Before
            // this, only tool_start/tool_end entries appeared (via OpenClaw
            // path) and Claude Code conversations looked empty on the timeline.
            // The collector already ran (apmeHandledEarly) so `activeTaskId`
            // reflects the task THIS prompt belongs to — tag the row with it so
            // follow-up prompts nest under one task header.
            appendClaudeCodeChatStart(json: json, sessionId: sessionId, taskId: apmeCollector?.activeTaskId)
        case "stop":
            _ = stateMachine.transition(trigger: "stop", source: .hook)
            updateSessionHookState(sessionId: sessionId, state: "idle", clearTool: true)
            // Timeline: close the turn. `last_assistant_message` is the hook
            // payload field Claude Code populates (~18% reliable per DEV log
            // note) — when present we emit a chat_response; otherwise just
            // chat_end. Tool-only turns fall through to empty chat_end.
            appendClaudeCodeChatEnd(json: json, sessionId: sessionId)
        case "session_end":
            _ = stateMachine.transition(trigger: "session_end", source: .hook)
            if let sessionId {
                let expiredEntry = pushedSessionsById[sessionId]
                let isCodex = expiredEntry.map { Self.isCodexSession(sessionId: sessionId, entry: $0) } ?? false
                if isCodex {
                    if codexChatStartQueue.depth(sid: sessionId) > 0 {
                        appendCodexChatEnd(json: [:], sessionId: sessionId)
                    }
                } else {
                    if claudeChatStartQueue.depth(sid: sessionId) > 0 {
                        appendClaudeCodeChatEnd(json: [:], sessionId: sessionId)
                    }
                }

                pushedSessionsById.removeValue(forKey: sessionId)
                cachedSessions.removeAll { $0.id == sessionId }
                codexProcessingTouchedAtBySession.removeValue(forKey: sessionId)
                lastTerminalCodexEventBySession.removeValue(forKey: sessionId)
                codexTerminalTombstoneBySession.removeValue(forKey: sessionId)
                codexInteractiveSessionIds.remove(sessionId)
                codexProjectNameBySession.removeValue(forKey: sessionId)
                clearCodexChatStartQueue(sid: sessionId)
                codexLastPromptTopicBySession.removeValue(forKey: sessionId)
                codexCurrentToolBySession.removeValue(forKey: sessionId)
                clearClaudeChatStartQueue(sid: sessionId)
                claudeLastPromptTopicBySession.removeValue(forKey: sessionId)
                broadcastSessionsList()
            }
        case "tool_start":
            stateMachine.currentTool = json["tool_name"] as? String
            stateMachine.toolInput = json["tool_input"] as? String
            updateSessionHookState(
                sessionId: sessionId,
                state: "processing",
                currentTool: json["tool_name"] as? String
            )
        case "tool_end":
            stateMachine.currentTool = nil; stateMachine.toolInput = nil
            stateMachine.toolCalls += 1
            // Stay "processing" between tool boundaries — `stop` drops the
            // session back to idle when the turn finishes.
            updateSessionHookState(sessionId: sessionId, state: "processing", clearTool: true)
        case "notification":
            // Display-only attention: Claude emits a Notification hook with
            // `notification_type: "permission_prompt"` only when it actually
            // renders a permission prompt to the user (auto-approved tools fire
            // PreToolUse but never a permission Notification — the failure mode
            // that killed the old PreToolUse gate). The hook carries free-text
            // `message` and no structured options, so we surface
            // "awaiting + question" only; every surface renders the
            // respond-in-terminal path (no fabricated Allow/Deny, no requestId).
            // Cleared naturally by the next tool/stop/prompt hook via
            // updateSessionHookState; 180s evictStaleHookSessions is the backstop.
            let message = json["message"] as? String ?? ""
            let notificationType = json["notification_type"] as? String
            if Self.isPermissionNotification(notificationType: notificationType, message: message), let sessionId,
               var entry = pushedSessionsById[sessionId] {
                let q = String(message.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
                if entry.state != "awaiting_permission" || entry.question != q {
                    entry.state = "awaiting_permission"
                    entry.question = q
                    pushedSessionsById[sessionId] = entry
                    upsertIntoCachedSessions(entry)
                    broadcastSessionsList()
                }
            }
        case "codex_user_prompt_submit":
            _ = stateMachine.transition(trigger: "user_prompt_submit", source: .hook)
            updateSessionHookState(sessionId: sessionId, state: "processing")
            appendCodexChatStart(json: json, sessionId: sessionId)
            // Re-engage: a new prompt on a thread that previously hit
            // codex_stop should not still be reaped by codexPostTerminalTTL,
            // and marks the thread interactive (multi-turn ≠ companion task).
            if let sessionId { codexRegisterNewTurnSignal(sessionId: sessionId) }
        case "codex_tool_start":
            stateMachine.currentTool = json["tool_name"] as? String
            stateMachine.toolInput = json["tool_input"] as? String
            appendCodexToolEvent(json: json, sessionId: sessionId, completed: false)
            updateSessionHookState(
                sessionId: sessionId,
                state: "processing",
                currentTool: json["tool_name"] as? String
            )
        case "codex_tool_end":
            stateMachine.currentTool = nil
            stateMachine.toolInput = nil
            stateMachine.toolCalls += 1
            appendCodexToolEvent(json: json, sessionId: sessionId, completed: true)
            updateSessionHookState(sessionId: sessionId, state: "processing", clearTool: true)
        case "codex_stop":
            _ = stateMachine.transition(trigger: "stop", source: .hook)
            updateSessionHookState(sessionId: sessionId, state: "idle", clearTool: true)
            appendCodexChatEnd(json: json, sessionId: sessionId)
            // Stamp terminal time so codexPostTerminalTTL can reap the
            // ephemeral companion-task entry well before pushedSessionStaleTTL.
            if let sessionId { lastTerminalCodexEventBySession[sessionId] = Date() }
        case "codex_turn_complete":
            // Codex notify currently emits exactly one event per turn:
            // `agent-turn-complete`. There's no matching `turn_start` on
            // the notify channel — OTel covers progress in-flight; notify
            // just confirms the close. Treat it like Claude's `stop`:
            // global processing → idle, per-session idle, count the turn.
            //
            // The resurrection path above already populated agentType +
            // projectName when this is the first time we've seen the
            // thread; here we only need to make sure agentType is right
            // (notify can race ahead of the OTel turn_start span when
            // both signals are configured).
            if let sessionId, var entry = pushedSessionsById[sessionId] {
                entry.agentType = "codex-cli"
                pushedSessionsById[sessionId] = entry
                upsertIntoCachedSessions(entry)
            }
            _ = stateMachine.transition(trigger: "stop", source: .hook)
            stateMachine.toolCalls += 1
            updateSessionHookState(sessionId: sessionId, state: "idle", clearTool: true)
            appendCodexChatEnd(json: json, sessionId: sessionId)
            if let sessionId { lastTerminalCodexEventBySession[sessionId] = Date() }
        default: break
        }

        // APME: route every Claude Code hook event through the collector.
        // The collector manages its own session lifecycle (session_start opens
        // a run, session_end closes it, everything in between is a step).
        //
        // Codex events (codex_turn_complete, plus future codex_* signals)
        // are deliberately excluded: ApmeCollector keys steps off
        // `activeHookSession`, which is set by Claude's `session_start` —
        // routing Codex events through it would mis-attribute a Codex turn
        // to whichever Claude session happened to be active. APME for
        // Codex needs a distinct collector path (out of scope for this
        // observation pass).
        if !event.hasPrefix("codex_") && !apmeHandledEarly {
            apmeCollector?.handleHook(event: event, data: json)
        }

        // Attribute the next state_update + timeline entries to the session
        // that fired this hook: remember the sessionId, and mirror the
        // session's projectName onto the global StateMachine so downstream
        // timeline generators (client-side StateTimelineGenerator) label
        // events with the correct project. Without this the global
        // projectName stays stuck on whichever session most recently fired
        // `session_start`, so cross-session interleaving mislabels entries.
        if let sessionId {
            lastHookAtByPushedSession[sessionId] = Date()
            currentHookSessionId = sessionId
            if let proj = pushedSessionsById[sessionId]?.projectName, !proj.isEmpty {
                stateMachine.projectName = proj
            }
        }
        if event == "session_end", let sessionId {
            lastHookAtByPushedSession.removeValue(forKey: sessionId)
            codexProcessingTouchedAtBySession.removeValue(forKey: sessionId)
            if currentHookSessionId == sessionId { currentHookSessionId = nil }
        }

        broadcastStateUpdate()
    }

    /// Handle a `client_register` announcement from a rich UI surface
    /// (currently: Elgato Stream Deck plugin). Updates `cachedStreamDeck`
    /// with the device roster the plugin claims to drive so the Dashboard
    /// Downstream rail can render a Stream Deck row. The conn id is stored
    /// so `handleClientDisconnect` can evict the entry the moment that
    /// exact WS closes; only `streamdeck-plugin` is recognized for now,
    /// future client types slot in here.
    @MainActor
    private func handleClientRegister(_ cmd: [String: Any], from conn: WebSocketConnection) {
        // Refuse registrations from a connection that has already
        // closed. Network.framework can deliver a final data packet
        // and the FIN in the same receive callback, which schedules a
        // `handleClientRegister` Task and a `handleClientDisconnect`
        // Task back-to-back. Swift concurrency does not guarantee
        // FIFO ordering across independent MainActor Tasks, so the
        // disconnect can run first — leaving us about to write a
        // registration that nothing will ever evict (no further close
        // events come for a dead conn, so it would survive until the
        // 120 s TTL). The synchronous `markDisconnected` flag set in
        // the WS receive callback prevents that regardless of which
        // order the Tasks land in.
        if conn.isDisconnected {
            DaemonLogger.shared.debug("Daemon", "client_register dropped: WS already closed")
            return
        }
        guard let clientType = cmd["clientType"] as? String else { return }
        switch clientType {
        case "streamdeck-plugin":
            let devices = (cmd["devices"] as? [[String: Any]]) ?? []
            cachedStreamDeck = StreamDeckRegistration(
                connectionId: conn.id,
                devices: devices,
                updatedAt: Date()
            )
            DaemonLogger.shared.debug("Daemon", "client_register streamdeck-plugin devices=\(devices.count)")
            broadcastStateUpdate()
        case "eink-device":
            // Wi-Fi WebSocket e-ink panel (XTeink X3 …). Pure self-rendered LAN
            // client like an ESP32 board — it just volunteers its roster so the
            // dashboard can show an E-ink row. Evicted when this WS closes.
            let devices = (cmd["devices"] as? [[String: Any]]) ?? []
            cachedEinkDevices[conn.id] = StreamDeckRegistration(
                connectionId: conn.id,
                devices: devices,
                updatedAt: Date()
            )
            DaemonLogger.shared.debug("Daemon", "client_register eink-device devices=\(devices.count)")
            broadcastStateUpdate()
        case "android-dashboard":
            // Android dashboard app (tablet / e-ink launcher) over Wi-Fi WS —
            // volunteers its device identity so the topology can show an
            // Android row on both tiers (ADB covers only USB + CLI daemon).
            let devices = (cmd["devices"] as? [[String: Any]]) ?? []
            cachedAndroidDashboards[conn.id] = StreamDeckRegistration(
                connectionId: conn.id,
                devices: devices,
                updatedAt: Date()
            )
            DaemonLogger.shared.debug("Daemon", "client_register android-dashboard devices=\(devices.count)")
            broadcastStateUpdate()
        case "ulanzi-plugin":
            // Ulanzi Studio drives the D200H — stand down direct-HID so the two
            // don't fight over the device. Reacquired on disconnect.
            ulanziPluginConnectionId = conn.id
            DaemonLogger.shared.debug("Daemon", "client_register ulanzi-plugin — D200H standing down")
            if let d200hModule {
                Task { await d200hModule.setExternalOwner(true) }
            }
            broadcastStateUpdate()
        default:
            DaemonLogger.shared.debug("Daemon", "client_register ignored clientType=\(clientType)")
        }
    }

    /// Expire the Stream Deck cache when the plugin has gone silent for
    /// `streamDeckStaleTTL`. The plugin's connection-manager reconnect
    /// loop keeps sending `client_register` every connect, so a live
    /// plugin naturally keeps the timestamp fresh; a killed/uninstalled
    /// plugin stops refreshing and the row disappears on its own.
    @MainActor
    private func evictStaleClientRegistrations() async {
        let cutoff = Date().addingTimeInterval(-Self.streamDeckStaleTTL)
        if let sd = cachedStreamDeck, !activeWSConnectionIds.contains(sd.connectionId), sd.updatedAt < cutoff {
            DaemonLogger.shared.debug("Daemon", "Evicted stale streamdeck client registration")
            cachedStreamDeck = nil
            broadcastStateUpdate()
        }
        let staleEink = cachedEinkDevices.filter { _, reg in
            !activeWSConnectionIds.contains(reg.connectionId) && reg.updatedAt < cutoff
        }
        if !staleEink.isEmpty {
            for key in staleEink.keys { cachedEinkDevices.removeValue(forKey: key) }
            DaemonLogger.shared.debug("Daemon", "Evicted \(staleEink.count) stale eink-device registration(s)")
            broadcastStateUpdate()
        }
        let staleAndroid = cachedAndroidDashboards.filter { _, reg in
            !activeWSConnectionIds.contains(reg.connectionId) && reg.updatedAt < cutoff
        }
        if !staleAndroid.isEmpty {
            for key in staleAndroid.keys { cachedAndroidDashboards.removeValue(forKey: key) }
            DaemonLogger.shared.debug("Daemon", "Evicted \(staleAndroid.count) stale android-dashboard registration(s)")
            broadcastStateUpdate()
        }
    }

    /// Evict hook-driven sessions whose last hook is older than
    /// `pushedSessionStaleTTL`. Claude Code's `session_end` hook is
    /// unreliable, so without this a `claude` process that crashed or was
    /// Ctrl-C'd leaves a ghost entry whose creature keeps swimming or
    /// floating forever. A fresh start-like hook for the same sessionId
    /// re-creates the entry through the synthesis path.
    @MainActor
    private func evictStaleHookSessions() async {
        let now = Date()
        let codexTerminalCutoff = now.addingTimeInterval(-Self.codexPostTerminalTTL)

        // Expire terminal tombstones so a thread id reused hours later isn't
        // permanently barred from mid-turn resurrection.
        let tombstoneCutoff = now.addingTimeInterval(-Self.codexTerminalTombstoneTTL)
        codexTerminalTombstoneBySession = codexTerminalTombstoneBySession.filter { $0.value >= tombstoneCutoff }

        var expired = Set(lastHookAtByPushedSession.compactMap { (sid, ts) -> String? in
            guard let entry = pushedSessionsById[sid] else { return sid }
            let ttl: TimeInterval
            if Self.isCodexSession(sessionId: sid, entry: entry) {
                if codexInteractiveSessionIds.contains(sid) {
                    // Multi-turn interactive `codex` CLI conversation — the
                    // user is thinking between turns, not a dead companion
                    // thread. Companion TTLs made this creature flap on
                    // every turn boundary (evict 60-90 s after each stop,
                    // resurrect on the next prompt).
                    ttl = Self.codexInteractiveIdleTTL
                } else {
                    ttl = (entry.currentTool?.isEmpty == false)
                        ? Self.codexToolObservationStaleTTL
                        : Self.codexIdleObservationStaleTTL
                }
            } else if (entry.state ?? "").hasPrefix("awaiting") {
                // A genuinely-awaiting session is quiet by nature (one Notification
                // then it waits on the user) — don't reap it in the 180 s ghost
                // window or its creature vanishes mid-decision. Answering fires a
                // hook that clears awaiting well before this long backstop.
                ttl = Self.awaitingHookStaleTTL
            } else {
                ttl = Self.pushedSessionStaleTTL
            }
            return ts < now.addingTimeInterval(-ttl) ? sid : nil
        })
        // Faster eviction for Codex sessions whose terminal event (codex_stop /
        // codex_turn_complete / OTel turnEnd) is past the post-terminal TTL.
        // Without this, a burst of single-turn Codex Companion Tasks each
        // stays visible for the full 180 s no-hook TTL even though they
        // already finished, stacking up as multiple "acting" creatures on
        // the dashboard.
        for (sid, ts) in lastTerminalCodexEventBySession where ts < codexTerminalCutoff {
            // Interactive threads idle between turns after every stop — the
            // fast post-terminal reaper only exists for single-turn companion
            // bursts, so it must not touch them.
            if codexInteractiveSessionIds.contains(sid) { continue }
            expired.insert(sid)
        }
        guard !expired.isEmpty else { return }

        for sid in expired {
            let expiredEntry = pushedSessionsById[sid]
            let isPostTerminal = lastTerminalCodexEventBySession[sid]
                .map { $0 < codexTerminalCutoff } ?? false

            // Auto-emit fallbacks for any active/uncompleted turns in the queues
            // before clearing their backing queue structures.
            let isCodex = expiredEntry.map { Self.isCodexSession(sessionId: sid, entry: $0) } ?? false
            if isCodex {
                if codexChatStartQueue.depth(sid: sid) > 0 {
                    appendCodexChatEnd(json: [:], sessionId: sid)
                }
            } else {
                if claudeChatStartQueue.depth(sid: sid) > 0 {
                    appendClaudeCodeChatEnd(json: [:], sessionId: sid)
                }
            }

            pushedSessionsById.removeValue(forKey: sid)
            cachedSessions.removeAll { $0.id == sid }
            lastHookAtByPushedSession.removeValue(forKey: sid)
            // Preserve the terminal timestamp as a tombstone: it is the only
            // signal that distinguishes a finished companion thread's late
            // tool callbacks (must stay dead) from a live turn whose row was
            // reaped mid-thinking (may resurrect on codex_tool_start).
            if let terminalTs = lastTerminalCodexEventBySession[sid] {
                codexTerminalTombstoneBySession[sid] = terminalTs
            }
            lastTerminalCodexEventBySession.removeValue(forKey: sid)
            codexProcessingTouchedAtBySession.removeValue(forKey: sid)
            clearCodexChatStartQueue(sid: sid)
            codexLastPromptTopicBySession.removeValue(forKey: sid)
            codexCurrentToolBySession.removeValue(forKey: sid)
            clearClaudeChatStartQueue(sid: sid)
            claudeLastPromptTopicBySession.removeValue(forKey: sid)
            if currentHookSessionId == sid { currentHookSessionId = nil }
            if userFocusedSessionId == sid { userFocusedSessionId = nil }
            if isPostTerminal {
                DaemonLogger.shared.debug("Hook", "Evicted finished codex session \(sid) (post-terminal \(Int(Self.codexPostTerminalTTL))s)")
            } else if let entry = expiredEntry,
                      Self.isCodexSession(sessionId: sid, entry: entry) {
                let ttl = (entry.currentTool?.isEmpty == false)
                    ? Self.codexToolObservationStaleTTL
                    : Self.codexIdleObservationStaleTTL
                DaemonLogger.shared.debug("Hook", "Evicted stale codex session \(sid) (no hook in \(Int(ttl))s)")
            } else {
                DaemonLogger.shared.debug("Hook", "Evicted stale session \(sid) (no hook in \(Int(Self.pushedSessionStaleTTL))s)")
            }
        }
        broadcastSessionsList()
        broadcastStateUpdate()
    }

    // MARK: - OpenCode observer integration

    private static let openCodeSessionPrefix = "opencode:"
    private static let openCodeFallbackProjectName = "OpenCode"

    /// Merge one classified OpenCode SSE update into `pushedSessionsById`.
    /// Same integration contract as the Codex OTel path: upsert + cached
    /// sessions + eviction timestamp + broadcast-on-change. Display-only —
    /// `options`/`requestId` are never set, so awaiting renders the
    /// respond-in-terminal path on every surface.
    @MainActor
    private func handleOpenCodeObserverUpdate(_ update: OpenCodeSessionUpdate) {
        let sid = Self.openCodeSessionPrefix + update.sessionID
        let existing = pushedSessionsById[sid]

        // Project name: session title beats directory basename beats fallback.
        let resolvedProject = Self.nonEmptyString(update.title)
            ?? update.directory.flatMap { Self.nonEmptyString(ProjectNameResolver.resolve(cwd: $0)) }
        let projectName = resolvedProject
            ?? existing.flatMap { Self.nonEmptyString($0.projectName) }
            ?? Self.openCodeFallbackProjectName

        // `projectName` is immutable on DaemonSessionEntry — rebuild.
        var entry = DaemonSessionEntry(
            id: sid,
            port: existing?.port ?? Int(port),
            pid: existing?.pid ?? 0,
            projectName: projectName,
            agentType: "opencode",
            tmuxSession: existing?.tmuxSession,
            tty: existing?.tty,
            parentTty: existing?.parentTty,
            startedAt: existing?.startedAt ?? ISO8601DateFormatter().string(from: Date())
        )
        entry.state = existing?.state ?? "idle"
        entry.modelName = update.modelName ?? existing?.modelName
        entry.currentTool = existing?.currentTool
        entry.question = existing?.question

        switch update.kind {
        case .upsert, .metadata:
            break
        case .processing:
            entry.state = "processing"
            if let tool = update.currentTool { entry.currentTool = tool }
            entry.question = nil
        case .idle:
            entry.state = "idle"
            entry.currentTool = nil
            entry.question = nil
        case .awaitingPermission:
            entry.state = "awaiting_permission"
            entry.question = update.question.map { String($0.prefix(120)) }
        }

        lastHookAtByPushedSession[sid] = Date()
        let changed = existing == nil
            || existing?.state != entry.state
            || existing?.question != entry.question
            || existing?.currentTool != entry.currentTool
            || existing?.projectName != entry.projectName
            || existing?.modelName != entry.modelName
        pushedSessionsById[sid] = entry
        upsertIntoCachedSessions(entry)
        if changed { broadcastSessionsList() }
    }

    /// SSE stream dropped (server quit / network) — flip tracked OpenCode
    /// sessions idle immediately; TTL eviction removes them once keepalive
    /// stamps stop.
    @MainActor
    private func handleOpenCodeObserverDisconnect() {
        var changed = false
        for (sid, var entry) in pushedSessionsById where sid.hasPrefix(Self.openCodeSessionPrefix) {
            if entry.state != "idle" || entry.question != nil || entry.currentTool != nil {
                entry.state = "idle"
                entry.question = nil
                entry.currentTool = nil
                pushedSessionsById[sid] = entry
                upsertIntoCachedSessions(entry)
                changed = true
            }
        }
        if changed { broadcastSessionsList() }
    }

    /// Connection-healthy tick: refresh eviction timestamps so idle-but-alive
    /// OpenCode sessions aren't reaped between SSE events (the 180s
    /// `evictStaleHookSessions` sweep only sees hook/SSE activity).
    @MainActor
    private func touchOpenCodeSessions() {
        let now = Date()
        for sid in pushedSessionsById.keys where sid.hasPrefix(Self.openCodeSessionPrefix) {
            lastHookAtByPushedSession[sid] = now
        }
    }

    /// Translate a batch of Codex OTLP/HTTP spans into per-session state
    /// transitions. Shares `pushedSessionsById` and `lastHookAtByPushedSession`
    /// with the /hooks/* path so notify and OTel converge on a single
    /// session entry per Codex thread; either signal alone is sufficient
    /// to drive the dashboard, both together is idempotent.
    @MainActor
    private func handleCodexTrace(_ body: Data) async {
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: body)
        } catch {
            // Diagnostic: capture both ends of the body so we can tell
            // whether the JSON is truncated mid-stream vs Transfer-Encoding
            // chunked wrapping vs simply malformed.
            let pHex = body.prefix(80).map { String(format: "%02x", $0) }.joined()
            let sHex = body.suffix(80).map { String(format: "%02x", $0) }.joined()
            DaemonLogger.shared.debug(
                "CodexOTel",
                "JSONSerialization failed: \(error.localizedDescription); len=\(body.count) prefix=\(pHex) suffix=\(sHex)"
            )
            return
        }
        guard let json = parsed as? [String: Any] else {
            let prefix = body.prefix(80).map { String(format: "%02x", $0) }.joined()
            DaemonLogger.shared.debug(
                "CodexOTel",
                "Parsed but root is \(type(of: parsed)), not [String:Any]; len=\(body.count) prefix=\(prefix)"
            )
            return
        }
        let events = CodexTelemetryModule.parse(json)
        guard !events.isEmpty else {
            let topKeys = Array(json.keys).joined(separator: ",")
            let spanNames = CodexTelemetryModule.spanNameSummary(json)
            DaemonLogger.shared.debug(
                "CodexOTel",
                "JSON parsed but no recognized spans; len=\(body.count) topKeys=\(topKeys) spanNames=\(spanNames)"
            )
            return
        }

        var didTouchSessionsList = false
        func codexProjectName(from cwd: String?, sessionId: String) -> String {
            if let cwd, let projectName = Self.nonEmptyString(ProjectNameResolver.resolve(cwd: cwd)) {
                return projectName
            }
            // OTel anonymous session (cwd unknown): leave projectName empty
            // rather than borrowing a sibling Claude/OpenClaw session's name.
            // Borrowing was the macOS dashboard regression where codex showed
            // a neighbouring agent's project label (e.g. AgentDeck claude →
            // codex tagged "AgentDeck" even when running elsewhere, or worse
            // the other way around). `ensureCodexSession`'s upgrade path
            // fills the entry when a later hook event arrives with cwd.
            _ = sessionId
            return ""
        }

        func ensureCodexSession(_ sid: String, projectName: String = "") {
            // Anonymous OTel placeholder (`codex:otel-active`) is only useful
            // when no real Codex App session is tracked yet — its job is to
            // keep the dashboard creature alive while OTel emits progress
            // spans without a durable thread id. CLI hook sessions are a
            // separate source and must coexist with Codex App observation.
            if sid == Self.codexAnonymousOtelSessionId {
                if Self.hasRealCodexAppSession(in: pushedSessionsById) {
                    return
                }
            } else if pushedSessionsById[Self.codexAnonymousOtelSessionId] != nil {
                purgeCodexSessionState(Self.codexAnonymousOtelSessionId)
                didTouchSessionsList = true
            }
            let resolvedProjectName = Self.nonEmptyString(projectName) ?? ""
            let displayProjectName = resolvedProjectName.isEmpty
                ? Self.codexAppFallbackProjectName
                : resolvedProjectName
            if let existing = pushedSessionsById[sid] {
                let existingName = existing.projectName.trimmingCharacters(in: .whitespacesAndNewlines)
                if (existingName.isEmpty || existingName == Self.codexAppFallbackProjectName),
                   !resolvedProjectName.isEmpty {
                    var updated = DaemonSessionEntry(
                        id: existing.id,
                        port: existing.port,
                        pid: existing.pid,
                        projectName: resolvedProjectName,
                        agentType: Self.codexAppAgentType,
                        tmuxSession: existing.tmuxSession,
                        tty: existing.tty,
                        parentTty: existing.parentTty,
                        startedAt: existing.startedAt
                    )
                    updated.state = existing.state
                    updated.modelName = existing.modelName
                    updated.effortLevel = existing.effortLevel
                    updated.currentTool = existing.currentTool
                    updated.options = existing.options
                    updated.navigable = existing.navigable
                    pushedSessionsById[sid] = updated
                    upsertIntoCachedSessions(updated)
                    trackCodexProcessingState(sessionId: sid, entry: updated)
                    didTouchSessionsList = true
                    DaemonLogger.shared.debug("CodexOTel", "Updated \(sid) project=\(resolvedProjectName)")
                }
                return
            }
            var entry = DaemonSessionEntry(
                id: sid,
                port: Int(port),
                pid: 0,
                projectName: displayProjectName,
                agentType: Self.codexAppAgentType,
                tmuxSession: nil,
                tty: nil,
                parentTty: nil,
                startedAt: ISO8601DateFormatter().string(from: Date())
            )
            entry.state = "processing"
            pushedSessionsById[sid] = entry
            upsertIntoCachedSessions(entry)
            trackCodexProcessingState(sessionId: sid, entry: entry)
            didTouchSessionsList = true
            DaemonLogger.shared.debug("CodexOTel", "Opened \(sid) project=\(displayProjectName)")
        }

        func sessionIdForCodexOtelThread(_ threadId: String) -> (sid: String, observedProjectName: String?)? {
            if !Self.shouldUseCodexOtelThreadForSessionState(threadId: threadId) {
                return nil
            }
            return ("codex:\(threadId)", nil)
        }

        for event in events {
            switch event {
            case .turnStart(let threadId, _, let cwd):
                guard let resolved = sessionIdForCodexOtelThread(threadId) else {
                    DaemonLogger.shared.debug("CodexOTel", "Ignored anonymous turnStart without durable thread id")
                    continue
                }
                let sid = resolved.sid
                let projectName = resolved.observedProjectName ?? codexProjectName(from: cwd, sessionId: sid)
                if pushedSessionsById[sid] == nil {
                    ensureCodexSession(sid, projectName: projectName)
                } else {
                    ensureCodexSession(sid, projectName: projectName)
                    updateSessionHookState(sessionId: sid, state: "processing")
                }
                if !projectName.isEmpty { stateMachine.projectName = projectName }
                _ = stateMachine.transition(trigger: "user_prompt_submit", source: .hook)
                lastHookAtByPushedSession[sid] = Date()
                codexRegisterNewTurnSignal(sessionId: sid)

            case .toolCall(let threadId, _, let tool, let cwd):
                guard let resolved = sessionIdForCodexOtelThread(threadId) else {
                    DaemonLogger.shared.debug("CodexOTel", "Ignored anonymous toolCall without durable thread id")
                    continue
                }
                let sid = resolved.sid
                guard lastTerminalCodexEventBySession[sid] == nil else {
                    DaemonLogger.shared.debug("CodexOTel", "Ignored late toolCall for finished session \(sid)")
                    continue
                }
                ensureCodexSession(sid, projectName: resolved.observedProjectName ?? codexProjectName(from: cwd, sessionId: sid))
                let usefulTool = Self.usefulCodexToolName(tool)
                updateSessionHookState(sessionId: sid, state: "processing", currentTool: usefulTool)
                lastHookAtByPushedSession[sid] = Date()

            case .toolResult(let threadId, _):
                guard let sid = sessionIdForCodexOtelThread(threadId)?.sid else {
                    DaemonLogger.shared.debug("CodexOTel", "Ignored anonymous toolResult without durable thread id")
                    continue
                }
                guard lastTerminalCodexEventBySession[sid] == nil else {
                    DaemonLogger.shared.debug("CodexOTel", "Ignored late toolResult for finished session \(sid)")
                    continue
                }
                updateSessionHookState(sessionId: sid, state: "processing", clearTool: true)
                lastHookAtByPushedSession[sid] = Date()

            case .turnEnd(let threadId, _):
                guard let sid = sessionIdForCodexOtelThread(threadId)?.sid else {
                    DaemonLogger.shared.debug("CodexOTel", "Ignored anonymous turnEnd without durable thread id")
                    continue
                }
                updateSessionHookState(sessionId: sid, state: "idle", clearTool: true)
                _ = stateMachine.transition(trigger: "stop", source: .hook)
                stateMachine.toolCalls += 1
                appendCodexChatEnd(json: [:], sessionId: sid)
                lastHookAtByPushedSession[sid] = Date()
                lastTerminalCodexEventBySession[sid] = Date()

            case .activity(let threadId, _, let name, let cwd):
                guard let resolved = sessionIdForCodexOtelThread(threadId) else {
                    DaemonLogger.shared.debug("CodexOTel", "Ignored anonymous activity \(name) without durable thread id")
                    continue
                }
                let sid = resolved.sid
                guard lastTerminalCodexEventBySession[sid] == nil else {
                    DaemonLogger.shared.debug("CodexOTel", "Ignored late activity \(name) for finished session \(sid)")
                    continue
                }
                guard let existing = pushedSessionsById[sid] else {
                    DaemonLogger.shared.debug("CodexOTel", "Ignored activity \(name) without active turn for \(sid)")
                    continue
                }
                ensureCodexSession(sid, projectName: resolved.observedProjectName ?? codexProjectName(from: cwd, sessionId: sid))
                guard Self.shouldUseCodexOtelActivityForState(existingState: existing.state) else {
                    DaemonLogger.shared.debug("CodexOTel", "Ignored activity \(name) for idle session \(sid)")
                    continue
                }
                codexProcessingTouchedAtBySession[sid] = Date()
                lastHookAtByPushedSession[sid] = Date()
            }
        }

        if didTouchSessionsList {
            // Newly-synthesized session needs a sessions-list broadcast;
            // updateSessionHookState already pushes the list when it touches
            // an existing entry, but the create/project-update path above
            // can bypass that.
            broadcastSessionsList()
        }
        broadcastStateUpdate()
    }

    /// Test-only proxy for `shouldSynthesizeUnknownHookSession` so the codex
    /// branch can be exercised from XCTest without exposing the predicate's
    /// `isCodexEvent` parameter to non-codex code paths. Mirrors the codex
    /// dispatch in `handleHookEvent` (event prefix == "codex_"). The
    /// underlying predicate is pure (no actor state), so the helper is
    /// `nonisolated` and callable from the test runner's default context.
    nonisolated static func shouldSynthesizeUnknownHookSessionForTest(event: String) -> Bool {
        shouldSynthesizeUnknownHookSession(event: event, isCodexEvent: event.hasPrefix("codex_"))
    }

    nonisolated static func shouldIgnorePostTerminalCodexProgressForTest(event: String) -> Bool {
        shouldIgnorePostTerminalCodexProgressEvent(event)
    }

    nonisolated static func shouldUseCodexOtelActivityForState(existingState: String?) -> Bool {
        existingState == "processing"
    }

    nonisolated static func shouldUseCodexOtelThreadForSessionState(threadId: String) -> Bool {
        threadId != "otel-active"
    }

    /// Decide which unknown hook events are allowed to create a session row.
    /// The caller still requires a durable session id; completion-only events
    /// and low-quality Codex ids are ignored before they reach this path.
    nonisolated private static func shouldSynthesizeUnknownHookSession(event: String, isCodexEvent: Bool) -> Bool {
        if isCodexEvent {
            // Allow resurrection on `codex_session_start` AND
            // `codex_user_prompt_submit` so an interactive Codex session that
            // got reaped by `codexPostTerminalTTL` (60 s after the previous
            // turn finished) reappears the moment the user submits a
            // follow-up prompt — without this the dashboard would show the
            // creature vanish during a "long thinking" pause and never come
            // back even though the codex process is alive.
            //
            // `codex_tool_start`/`codex_tool_end` stay excluded from THIS
            // predicate because they are mid-turn — but the hook call site
            // layers a tombstone-gated bypass on top: when the thread has no
            // recorded terminal event, a tool event is a live turn whose row
            // was reaped mid-thinking and MAY resurrect. Leftover callbacks
            // from finished companion tasks always trail a terminal
            // tombstone and stay dead. The single-Codex creature visibility
            // is preserved by Layer 1 fold (`TerrariumState` groups by
            // projectName), which collapses ephemeral companion tasks even
            // if mid-event resurrection does fire.
            return event == "codex_session_start" || event == "codex_user_prompt_submit"
        }
        return event != "session_end" && event != "session_start"
    }

    nonisolated private static func shouldIgnorePostTerminalCodexProgressEvent(_ event: String) -> Bool {
        event == "codex_tool_start" || event == "codex_tool_end"
    }

    /// Does a Notification `message` look like an ACTUAL permission prompt rather
    /// than an idle-timeout reminder? Claude's Notification hook fires for both
    /// "Claude needs your permission to use Bash" (a real decision) and "Claude
    /// is waiting for your input" (a 60s idle ping); only the former is an
    /// awaiting state. Matches genuine permission phrasing ONLY — the earlier
    /// broad alternatives (`waiting for your`, `wants to`, `confirm`, `to proceed`)
    /// caught the idle ping and were the root cause of false "Attention" popups.
    /// Mirrors the Node `looksLikePermissionMessage` regex.
    nonisolated static func looksLikePermissionMessage(_ message: String) -> Bool {
        guard !message.isEmpty else { return false }
        let pattern = "needs? your permission|permission to use|requesting permission"
        return message.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Is a Notification hook an actual permission prompt (awaiting decision)?
    /// Current Claude Code carries an authoritative `notification_type`
    /// (`permission_prompt` | `idle_prompt` | `auth_success` | `elicitation_*`);
    /// only `permission_prompt` is an awaiting state — idle pings, auth toasts,
    /// and elicitation must never flip a session to attention. Falls back to the
    /// brittle free-text `message` regex only when the field is absent (older
    /// Claude). Mirrors the Node `isPermissionNotification`.
    nonisolated static func isPermissionNotification(notificationType: String?, message: String) -> Bool {
        if let t = notificationType, !t.isEmpty {
            return t == "permission_prompt"
        }
        return looksLikePermissionMessage(message)
    }

    /// Edit-family tools that Claude auto-approves in `acceptEdits` mode.
    nonisolated static let editFamilyTools: Set<String> = ["Write", "Edit", "MultiEdit", "NotebookEdit"]

    /// Should the daemon HOLD a gated PreToolUse for device approval, given the
    /// session's `permission_mode`? Claude's PreToolUse hook fires for EVERY tool
    /// call regardless of mode or allowlist — even when Claude will auto-approve
    /// and never prompt the user. Gate only in modes where Claude could still
    /// surface its own prompt; otherwise the device nags for a decision the agent
    /// never asked for (the reported false-attention bug). Mirrors the Node
    /// `shouldGatePreToolUse`.
    ///
    ///  - `bypassPermissions` / `dontAsk` → never prompts            → don't gate
    ///  - `plan`                          → tools don't execute       → don't gate
    ///  - `acceptEdits`                   → edits auto-approved, Bash still prompts
    ///  - `default` / `auto` / unknown    → Claude may prompt         → gate
    nonisolated static func shouldGate(permissionMode: String?, tool: String) -> Bool {
        switch (permissionMode ?? "default").trimmingCharacters(in: .whitespaces) {
        case "bypassPermissions", "dontAsk", "plan":
            return false
        case "acceptEdits":
            return !editFamilyTools.contains(tool)
        default:
            return true
        }
    }

    @MainActor
    private func shouldIgnorePostTerminalCodexProgress(sessionId: String?, event: String) -> Bool {
        guard let sessionId,
              Self.shouldIgnorePostTerminalCodexProgressEvent(event),
              lastTerminalCodexEventBySession[sessionId] != nil else {
            return false
        }
        return true
    }

    private static func isCodexSession(sessionId: String, entry: DaemonSessionEntry) -> Bool {
        sessionId.hasPrefix("codex:") || entry.agentType == codexCliAgentType || entry.agentType == codexAppAgentType
    }

    private static func usefulCodexToolName(_ raw: String?) -> String? {
        guard let trimmed = nonEmptyString(raw) else { return nil }
        let lowered = trimmed.lowercased()
        guard lowered != "tool" && lowered != "unknown" else { return nil }
        return trimmed
    }

    /// Apply a per-session state/tool update coming from a hook event and
    /// broadcast the refreshed sessions list. No-op when the sessionId is
    /// nil or refers to a session we never registered via `session_start`.
    @MainActor
    private func updateSessionHookState(
        sessionId: String?,
        state newState: String,
        currentTool: String? = nil,
        clearTool: Bool = false
    ) {
        guard let sessionId, var entry = pushedSessionsById[sessionId] else { return }
        let oldState = entry.state
        let oldTool = entry.currentTool
        let oldQuestion = entry.question
        entry.state = newState
        // Any non-awaiting transition means a pending prompt was answered — drop
        // the awaiting question so it doesn't linger.
        if newState != "awaiting_permission" {
            entry.question = nil
        }
        if clearTool {
            entry.currentTool = nil
        } else if let currentTool {
            entry.currentTool = currentTool
        }
        pushedSessionsById[sessionId] = entry
        upsertIntoCachedSessions(entry)
        trackCodexProcessingState(sessionId: sessionId, entry: entry)
        // State / question transitions are rare and UX-critical
        // (awaiting_permission must reach devices instantly) → immediate.
        // currentTool flips happen 2× per tool call (set on tool_start,
        // clear on tool_end) — a 20-tool turn would emit ~40 full
        // sessions_list rebuilds — so tool-only changes ride the debounce.
        if oldState != entry.state || oldQuestion != entry.question {
            broadcastSessionsList()
        } else if oldTool != entry.currentTool {
            scheduleSessionsListBroadcast()
        }
    }

    // MARK: - Hook dispatch

    /// Generic hook entry: deserialize the body and dispatch. All events
    /// (including PreToolUse) route here; the daemon no longer holds PreToolUse
    /// for a device gate.
    @MainActor
    private func handleHookPost(rawName: String, body: Data) async {
        var json = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
        json["event"] = Self.mapHookEventName(rawName)
        await handleHookEvent(json)
    }

    nonisolated static func mapHookEventName(_ rawName: String) -> String {
        switch rawName {
        case "SessionStart": return "session_start"
        case "SessionEnd":   return "session_end"
        case "PreToolUse":   return "tool_start"
        case "PostToolUse":  return "tool_end"
        case "Stop":         return "stop"
        case "UserPromptSubmit": return "user_prompt_submit"
        case "Notification": return "notification"
        default: return rawName.lowercased()
        }
    }

    @MainActor
    private func trackCodexProcessingState(sessionId: String, entry: DaemonSessionEntry, now: Date = Date()) {
        guard Self.isCodexSession(sessionId: sessionId, entry: entry) else { return }
        if entry.state == "processing" {
            codexProcessingTouchedAtBySession[sessionId] = now
        } else {
            codexProcessingTouchedAtBySession.removeValue(forKey: sessionId)
        }
    }

    @discardableResult
    @MainActor
    private func settleStaleCodexProcessingSessions(now: Date = Date(), broadcast: Bool = true) -> Bool {
        let noToolCutoff = now.addingTimeInterval(-Self.codexNoToolProcessingIdleTTL)
        let toolCutoff = now.addingTimeInterval(-Self.codexToolProcessingIdleTTL)
        var changed = false

        for (sid, touchedAt) in Array(codexProcessingTouchedAtBySession) {
            guard var entry = pushedSessionsById[sid] else {
                codexProcessingTouchedAtBySession.removeValue(forKey: sid)
                continue
            }
            guard Self.isCodexSession(sessionId: sid, entry: entry) else {
                codexProcessingTouchedAtBySession.removeValue(forKey: sid)
                continue
            }
            guard entry.state == "processing" else {
                codexProcessingTouchedAtBySession.removeValue(forKey: sid)
                continue
            }
            let hasTool = entry.currentTool?.isEmpty == false
            guard touchedAt < (hasTool ? toolCutoff : noToolCutoff) else { continue }

            entry.state = "idle"
            entry.currentTool = nil
            pushedSessionsById[sid] = entry
            upsertIntoCachedSessions(entry)
            codexProcessingTouchedAtBySession.removeValue(forKey: sid)
            changed = true
            DaemonLogger.shared.debug(
                "Hook",
                "Settled stale Codex processing session \(sid) to idle (no progress in \(Int(hasTool ? Self.codexToolProcessingIdleTTL : Self.codexNoToolProcessingIdleTTL))s)"
            )
        }

        if changed && broadcast {
            broadcastSessionsList()
            broadcastStateUpdate()
        }
        return changed
    }

    // MARK: - State Changed (cascade)

    @MainActor
    private func handleStateChanged() {
        let currentState = stateMachine.state
        let gwAlive = cachedGatewayConnected
        let event = buildFullStateEvent(agentType: gwAlive ? "openclaw" : "daemon")
        lastStateEvent = event
        broadcastRaw(event)
        broadcastSessionsList()
        broadcastUsage()

        // Voice assistant: reset timeout on any activity during processing
        if currentState == .processing && voiceAssistant.state == .processing {
            voiceAssistant.resetResponseTimeout()
        }

        // PROCESSING→IDLE edge: agent finished a turn.
        // (1) Voice assistant TTS — existing behavior.
        // (2) APME turn-response capture — hands the response text to the
        //     collector, which persists it on the active turn, inline-classifies
        //     if needed, and fires a turn_judge eval for non-code categories.
        let wasProcessing = previousDaemonState == .processing
        previousDaemonState = currentState
        if wasProcessing && currentState == .idle {
            Task { [weak self] in
                guard let self else { return }
                let lastEntry = await self.timelineStore.getLastEntry(type: "chat_end")
                let responseText = (lastEntry?.detail ?? lastEntry?.raw) ?? ""
                let chatEndTs = lastEntry?.ts
                await MainActor.run {
                    // APME: record the response even when voice assistant is inactive.
                    // `chatEndTs` lets the collector reject the late-callback
                    // race where a follow-up user_prompt_submit has already
                    // rotated activeTurn to a fresh turn — without it, this
                    // response would clobber the wrong turn's record.
                    if !responseText.isEmpty {
                        self.apmeCollector?.setTurnResponse(responseText, chatEndTs: chatEndTs)
                    }
                    if self.voiceAssistant.state == .processing {
                        self.voiceAssistant.handleResponse(responseText.isEmpty ? "완료했습니다." : responseText)
                    }
                }
            }
        }
    }

    // MARK: - Gateway Lifecycle

    private func connectGatewayAdapter() {
        guard gatewayAdapter == nil, !gatewayConnecting else { return }
        gatewayConnecting = true
        DaemonLogger.shared.info("OpenClaw Gateway detected, connecting...")

        let adapter = OpenClawAdapter()
        Task {
            await adapter.setOnEvent { [weak self] event in
                let box = SendableDict(event)
                Task { @MainActor in self?.handleGatewayEvent(box.value) }
            }
            await adapter.setOnConnectionChanged { [weak self] connected in
                Task { @MainActor in
                    if connected {
                        self?.cachedGatewayConnected = true
                        self?.gatewayConnectedAt = Date()
                        self?.cachedGatewayAuthStatus = "connected"
                        self?.cachedGatewayAuthRequestId = nil
                        self?.cachedGatewayAuthMessage = nil
                        DaemonLogger.shared.info("OpenClaw Gateway connected")
                        if self?.stateMachine.state == .disconnected {
                            _ = self?.stateMachine.transition(trigger: "session_start", source: .hook)
                        }
                        // APME: open a run for this Gateway connection
                        self?.apmeCollectorGateway?.handleHook(event: "session_start", data: [
                            "session_id": "openclaw-gateway",
                            "project_name": "OpenClaw",
                            "agent_type": "openclaw",
                        ])
                        self?.handleStateChanged()
                    } else {
                        self?.cachedGatewayConnected = false
                        self?.gatewayConnectedAt = nil
                        if self?.cachedGatewayAvailable == true, self?.cachedGatewayAuthStatus == "connected" {
                            // WebSocket dropped but Gateway TCP port is still open —
                            // adapter will reconnect internally with backoff. Show
                            // "reconnecting" instead of "Approve in Web UI" or
                            // "Not configured" so the user doesn't act on a false state.
                            self?.cachedGatewayAuthStatus = "reconnecting"
                        }
                        DaemonLogger.shared.info("OpenClaw Gateway disconnected")
                        await self?.logStream.stop()
                        _ = self?.stateMachine.transition(trigger: "session_end", source: .hook)
                        self?.gatewaySessionState = "idle"
                        self?.gatewayCurrentTool = nil
                        // APME: close the gateway run on disconnect
                        self?.apmeCollectorGateway?.handleHook(event: "session_end", data: [
                            "session_id": "openclaw-gateway",
                        ])
                        self?.handleStateChanged()
                    }
                }
            }
            await adapter.start()
            // Cache the locally-generated deviceId so state_update can carry
            // it even before the first successful handshake (which is when
            // pairing UI most needs to show the id). `currentDeviceId()` is
            // populated by `loadDeviceIdentity()` inside `start()`.
            let deviceId = await adapter.currentDeviceId()
            await MainActor.run {
                self.cachedGatewayDeviceId = deviceId
            }
            self.gatewayAdapter = adapter
            self.gatewayConnecting = false
        }
    }

    /// Bounce the OpenClaw Gateway adapter without restarting the entire
    /// daemon. Used after Settings changes that only affect the gateway client
    /// (shared token saved/cleared, pairing identity reset). The 5s gateway
    /// probe ticks past `gatewayAdapter == nil` and re-runs `connectGatewayAdapter`,
    /// so we only need to ensure a fresh adapter instance picks up the new
    /// keychain values. Crucially does NOT touch Claude/Codex session bridges,
    /// device modules, or the WS server.
    @MainActor
    func reconnectGatewayAdapter() {
        if gatewayAdapter != nil {
            disconnectGatewayAdapter()
        }
        // Force the next probe tick to re-create the adapter even if its
        // cached availability hasn't changed.
        if cachedGatewayAvailable {
            connectGatewayAdapter()
        }
    }

    private func disconnectGatewayAdapter() {
        guard let adapter = gatewayAdapter else { return }
        DaemonLogger.shared.info("OpenClaw Gateway lost, cleaning up...")
        Task { await adapter.stop() }
        gatewayAdapter = nil
        cachedGatewayConnected = false
        gatewayConnectedAt = nil
        cachedGatewayAuthStatus = cachedGatewayAvailable ? "gateway_reachable" : "gateway_not_found"
        cachedGatewayAuthRequestId = nil
        cachedGatewayAuthMessage = nil
        gatewaySessionState = "idle"
        gatewayCurrentTool = nil
        // Note: gatewayModelName is intentionally preserved across brief disconnects
        // so the model row doesn't flash empty on reconnect.
        _ = stateMachine.transition(trigger: "session_end", source: .hook)
        apmeCollectorGateway?.handleHook(event: "session_end", data: [
            "session_id": "openclaw-gateway",
        ])
        broadcastSessionsList()
        broadcastStateUpdate()
        broadcastUsage()
    }

    @MainActor
    private func handleGatewayEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "gateway_chat":
            let chatPayload = event["payload"] as? [String: Any] ?? [:]
            let chatState = chatPayload["state"] as? String
            switch chatState {
            case "final", "aborted":
                gatewaySessionState = "idle"
                gatewayCurrentTool = nil
                // APME: record response text → triggers inline classification + eval
                let response = chatPayload["response"] as? String ?? ""
                if !response.isEmpty {
                    apmeCollectorGateway?.setTurnResponse(response)
                }
            case "error":
                gatewaySessionState = "idle"
                gatewayCurrentTool = nil
            default:
                gatewaySessionState = "processing"
            }
            broadcastStateUpdate()
        case "gateway_approval":
            gatewaySessionState = "awaiting_permission"
            if let payload = event["payload"] as? [String: Any] {
                gatewayCurrentTool = payload["tool"] as? String
            }
            broadcastStateUpdate()
        case "gateway_approval_resolved":
            let resolvedPayload = event["payload"] as? [String: Any]
            let decision = resolvedPayload?["decision"] as? String
            // "deny" means tool execution was blocked — agent returns to idle.
            // "allow" (or any other value) means execution resumes → processing.
            gatewaySessionState = (decision == "deny") ? "idle" : "processing"
            gatewayCurrentTool = nil
            broadcastStateUpdate()
        case "gateway_presence":
            break // Heartbeat
        case "gateway_auth":
            cachedGatewayAuthStatus = event["status"] as? String ?? cachedGatewayAuthStatus
            cachedGatewayAuthRequestId = event["requestId"] as? String
            cachedGatewayAuthMessage = event["message"] as? String
            if cachedGatewayAuthStatus != "connected" {
                cachedGatewayConnected = false
            }
            handleStateChanged()
        case "gateway_timeline_entry":
            if let entry = event["entry"] as? [String: Any] {
                appendGatewayTimelineEntry(entry)
                let entryType = entry["type"] as? String

                if entryType == "model_call" {
                    // session.message role=user → turn start: record prompt for APME
                    let prompt = (entry["detail"] as? String) ?? (entry["raw"] as? String) ?? ""
                    if !prompt.isEmpty {
                        apmeCollectorGateway?.handleHook(event: "user_prompt_submit", data: [
                            "session_id": "openclaw-gateway",
                            "prompt": prompt,
                        ])
                    }
                } else if entryType == "tool_exec" {
                    // session.tool entries arrive via sessions.messages.subscribe.
                    // Routing + payload extraction lives in the static helper
                    // below so it stays unit-testable and so the start/end
                    // discrimination logic is in one explicit place. State
                    // machine bookkeeping (gatewayCurrentTool / processing
                    // transition) is the only handler-local concern left here.
                    let routed = Self.gatewayToolHookFromEntry(entry)
                    let toolName = routed.data["tool_name"] as? String ?? ""
                    if routed.event == "tool_end" {
                        if gatewayCurrentTool == toolName { gatewayCurrentTool = nil }
                    } else {
                        gatewayCurrentTool = toolName
                        if gatewaySessionState == "idle" { gatewaySessionState = "processing" }
                    }
                    apmeCollectorGateway?.handleHook(event: routed.event, data: routed.data)
                    broadcastStateUpdate()
                }
            }
        case "gateway_health":
            let payload = event["payload"] as? [String: Any]
            let hasError = !((payload?["ok"] as? Bool) ?? false)
            let changed = hasError != cachedGatewayHasError
            cachedGatewayHasError = hasError
            if changed {
                handleStateChanged()
            }
        case "model_catalog":
            // Gateway sends full model catalog — replace entirely (same as Node.js)
            if let models = event["models"] as? [[String: Any]] {
                let defaultModel = event["defaultModel"] as? String
                if let defaultModel, !defaultModel.isEmpty {
                    gatewayModelName = defaultModel
                }
                let catalogChanged = updateModelCatalog(from: models, source: "gateway", replaceExisting: true)
                if catalogChanged || defaultModel != nil {
                    broadcastStateUpdate()
                    broadcastUsage()
                }
            }
        default:
            break
        }
    }

    // MARK: - Relayed Events (from sibling timelines)

    @MainActor
    private func handleRelayedEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "timeline_event":
            broadcastRaw(event)
        case "timeline_history":
            broadcastRaw(event)
        case "state_update":
            // Extract model catalog from sibling
            if let catalog = event["modelCatalog"] as? [[String: Any]] {
                updateModelCatalog(from: catalog, source: "sibling relay")
            }
        default:
            break
        }
    }

    static func normalizedModelCatalog(_ models: [[String: Any]]) -> [[String: Any]] {
        DashboardDataRules.canonicalizeModelCatalog(models)
    }

    static func mergedModelCatalog(existing: [[String: Any]], incoming: [[String: Any]]) -> [[String: Any]] {
        DashboardDataRules.mergedModelCatalog(existing: existing, incoming: incoming)
    }

    @discardableResult
    private func updateModelCatalog(from models: [[String: Any]], source: String, replaceExisting: Bool = false) -> Bool {
        let merged = replaceExisting
            ? Self.normalizedModelCatalog(models)
            : Self.mergedModelCatalog(existing: cachedModelCatalog, incoming: models)
        let changed = !(merged as NSArray).isEqual(cachedModelCatalog)
        guard changed else { return false }
        cachedModelCatalog = merged
        DaemonLogger.shared.debug("Daemon", "Model catalog updated from \(source): \(merged.count) models")
        broadcastStateUpdate()
        broadcastUsage()
        return true
    }

    // MARK: - Polling

    private func startAllPolling() {
        // Stale hook-session eviction — 30s. See `lastHookAtByPushedSession`
        // and `pushedSessionStaleTTL` for rationale. Also doubles as the
        // cadence for expiring stale client_register cache entries
        // (Stream Deck plugin TTL) since both care about minute-scale
        // cleanup rather than immediate reaction.
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self else { break }
                await self.evictStaleHookSessions()
                self.settleStaleCodexProcessingSessions()
                await self.evictStaleClientRegistrations()
            }
        }

        // Serial status refresh — 5s. Pre-fetches the ESP32/Serial module's
        // async snapshot into `cachedSerialStatus` so the sync broadcast
        // path (`buildModuleHealthSync`) can emit full `connections`
        // payloads. Without this the Dashboard USB serial section stays
        // empty even with boards physically connected.
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self else { break }
                if let snap = await self.serialStatusSnapshot() {
                    await MainActor.run { self.cachedSerialStatus = snap }
                }
            }
        }

        // Sessions — 10s (also self-heals daemon.json if deleted)
        sessionPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard let self else { break }
                await self.refreshSessions()
                // Self-heal: re-write daemon.json if it was deleted externally
                // (bridge instances may remove it due to PID-check race conditions)
                if self.registry.readDaemonInfo() == nil {
                    let info = DaemonInfo(
                        port: Int(self.port),
                        pid: Int(ProcessInfo.processInfo.processIdentifier),
                        startedAt: ISO8601DateFormatter().string(from: Date()),
                        httpPort: nil
                    )
                    self.registry.writeDaemonInfo(info)
                    DaemonLogger.shared.debug("Daemon", "Self-healed daemon.json (was deleted externally)")
                }
            }
        }

        // Usage — 60s
        usagePollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard let self, await self.wsServer.hasClients() else { continue }
                await self.fetchUsageRelayed()
            }
        }

        // Anthropic Admin API — 10 min. Independent from the subscription
        // usage poll above. Skipped entirely when the user hasn't pasted
        // an admin API key (common case for subscription users).
        adminApiPollTask = Task { [weak self] in
            // Initial kick right after startup so Settings preview shows
            // something without waiting the full interval.
            if AnthropicAdminApiClient.shared.hasKey() {
                await self?.refreshAdminApiUsage()
            }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.adminApiPollInterval))
                guard let self else { break }
                guard AnthropicAdminApiClient.shared.hasKey() else { continue }
                guard await self.wsServer.hasClients() else { continue }
                await self.refreshAdminApiUsage()
            }
        }

        // Ollama — dynamic interval (5s base, exponential backoff up to 5m
        // when the service is absent). See probeOllama() for the backoff
        // state machine.
        ollamaPollTask = Task { [weak self] in
            while !Task.isCancelled {
                let interval = await MainActor.run { self?.ollamaNextInterval ?? 5 }
                try? await Task.sleep(for: .seconds(interval))
                guard let self, await self.wsServer.hasClients() else { continue }
                await self.probeOllama()
            }
        }

        // MLX — dynamic interval, same backoff pattern as ollama.
        mlxPollTask = Task { [weak self] in
            while !Task.isCancelled {
                let interval = await MainActor.run { self?.mlxNextInterval ?? 5 }
                try? await Task.sleep(for: .seconds(interval))
                guard let self, await self.wsServer.hasClients() else { continue }
                await self.probeMLX()
            }
        }

        // Judge backend probe — 30s periodic, slowed to 120s when no WS
        // clients are connected. The probe result only feeds dashboard UI
        // (Settings pill + state event fields); APME resolves its judge
        // backend per-eval independently, so a slower idle cadence costs
        // nothing but staleness nobody is looking at.
        judgeBackendPollTask = Task { [weak self] in
            // Initial probe on startup
            if let initial = await self?.probeJudgeBackend() {
                await MainActor.run { self?.cachedJudgeBackendStatus = initial }
            }
            while !Task.isCancelled {
                let hasClients = await self?.wsServer.hasClients() ?? false
                try? await Task.sleep(for: .seconds(hasClients ? 30 : 120))
                guard let self else { break }
                let fresh = await self.probeJudgeBackend()
                await MainActor.run {
                    let previous = self.cachedJudgeBackendStatus
                    self.cachedJudgeBackendStatus = fresh
                    // Compare key fields for change detection
                    let previousStatus = previous?.status
                    let previousModel = previous?.model
                    let freshStatus = fresh.status
                    let freshModel = fresh.model
                    if previousStatus != freshStatus || previousModel != freshModel {
                        self.broadcastStateUpdate()
                    }
                }
            }
        }

        // Gateway probe — 5s with hysteresis
        // A single TCP miss does NOT trigger disconnect — transient network
        // glitches (< 10s) are invisible to the user. Only 2+ consecutive
        // failures (≈10s of confirmed unavailability) cause a state change.
        gatewayPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self else { break }
                let available = await self.gatewayProbe.isAvailable

                if available {
                    self.gatewayProbeFailCount = 0
                    let wasUnavailable = !self.cachedGatewayAvailable
                    self.cachedGatewayAvailable = true
                    if self.cachedGatewayAuthStatus == "gateway_not_found" {
                        self.cachedGatewayAuthStatus = "gateway_reachable"
                    }
                    if self.gatewayAdapter == nil {
                        self.connectGatewayAdapter()
                    }
                    if wasUnavailable { self.broadcastStateUpdate() }
                } else {
                    self.gatewayProbeFailCount += 1
                    if self.gatewayProbeFailCount >= Self.gatewayProbeDisconnectThreshold {
                        // Confirmed unavailable: flip state and disconnect
                        let wasAvailable = self.cachedGatewayAvailable
                        self.cachedGatewayAvailable = false
                        self.cachedGatewayAuthStatus = "gateway_not_found"
                        self.cachedGatewayAuthRequestId = nil
                        self.cachedGatewayAuthMessage = nil
                        if self.gatewayAdapter != nil { self.disconnectGatewayAdapter() }
                        if wasAvailable { self.broadcastStateUpdate() }
                    }
                    // First miss: silently wait. Adapter handles WebSocket reconnect internally.
                }
            }
        }
        Task { await gatewayProbe.start() }

        // Gateway health — 30s
        gatewayHealthTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self else { break }
                let adapterHealth = await self.gatewayAdapter?.fetchHealthHasError()
                let hasError: Bool
                if let adapterHealth {
                    hasError = adapterHealth
                } else {
                    hasError = await self.gatewayProbe.hasErrorSnapshot()
                }
                if hasError != self.cachedGatewayHasError {
                    self.cachedGatewayHasError = hasError
                    self.broadcastStateUpdate()
                }
            }
        }

        // APME eval loop — 30s, mirrors bridge/src/daemon-server.ts:951-990
        // Picks up runs that closed without eval, computes outcome on closed
        // runs, classifies stragglers, and backfills turn outcomes for
        // code-category turns that never go through turn_judge.
        apmeEvalTimerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self else { break }
                await self.apmeEvalTick()
            }
        }

        // Antigravity — 15s (local SQLite read for plan/credit status),
        // slowed to 60s when no WS clients are connected: the status only
        // feeds the dashboard Subscriptions footer, and the broadcast below
        // is change-gated anyway.
        cachedAntigravityStatus = usageAPI.antigravityStatus
        antigravityPollTask = Task { [weak self] in
            while !Task.isCancelled {
                let hasClients = await self?.wsServer.hasClients() ?? false
                try? await Task.sleep(for: .seconds(hasClients ? 15 : 60))
                guard let self else { break }
                let next = self.usageAPI.antigravityStatus
                let changed: Bool
                if let prev = self.cachedAntigravityStatus, let next {
                    changed = prev.planName != next.planName
                        || prev.availableCredits != next.availableCredits
                        || prev.minimumCreditAmountForUsage != next.minimumCreditAmountForUsage
                        || prev.subscriptionActiveUntil != next.subscriptionActiveUntil
                } else {
                    changed = (self.cachedAntigravityStatus == nil) != (next == nil)
                }
                self.cachedAntigravityStatus = next
                if changed { self.broadcastStateUpdate() }
            }
        }

        // Usage tick — 5s (for session duration display + stale TTL)
        usageTickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, await self.wsServer.hasClients() else { continue }
                // TTL: keep last good cache, but mark it stale after 10 minutes.
                // Clearing to nil makes the HUD look like usage disappeared entirely.
                if self.cachedApiUsage != nil,
                   self.lastApiFetchTime != .distantPast,
                   Date().timeIntervalSince(self.lastApiFetchTime) > Self.usageStaleTTL {
                    if !self.apiUsageStale {
                        DaemonLogger.shared.debug("Daemon", "API usage cache expired, keeping last good values as stale")
                        self.apiUsageStale = true
                    }
                }
                self.broadcastUsage()
            }
        }
    }

    // MARK: - Sessions

    @MainActor
    private func refreshSessions() async {
        settleStaleCodexProcessingSessions(broadcast: false)

        // Pull filesystem-registered sessions (our own group container) first.
        let registryEntries = await registry.listActiveAndReachable().filter { $0.id != sessionId }

        // Merge with push-registered sessions (CLI bridges over WS). Pushed
        // sessions are authoritative for App Store builds because Swift
        // can't read `~/.agentdeck/sessions.json`.
        var merged = registryEntries
        let knownIds = Set(merged.map { $0.id })
        for (_, pushed) in pushedSessionsById where !knownIds.contains(pushed.id) {
            merged.append(pushed)
        }

        let hasObservedCodexAppSession = merged.contains { entry in
            entry.id.hasPrefix("observed:codex-app:")
        }
        if hasObservedCodexAppSession,
           pushedSessionsById[Self.codexAnonymousOtelSessionId] != nil {
            purgeCodexSessionState(Self.codexAnonymousOtelSessionId)
            merged.removeAll { $0.id == Self.codexAnonymousOtelSessionId }
        }

        let hasDurableCodexAppSession = merged.contains { entry in
            entry.agentType == Self.codexAppAgentType
                && entry.id != Self.codexAnonymousOtelSessionId
        }
        let observedCodexAppSessions = hasDurableCodexAppSession
            ? []
            : LocalCodexAppObserver.collect()
        if !observedCodexAppSessions.isEmpty,
           pushedSessionsById[Self.codexAnonymousOtelSessionId] != nil {
            purgeCodexSessionState(Self.codexAnonymousOtelSessionId)
        }
        let observedIds = Set(observedCodexAppSessions.map(\.id))
        let mergedIds = Set(merged.map(\.id))
        for observed in observedCodexAppSessions where !mergedIds.contains(observed.id) {
            merged.append(observed)
        }

        let enriched = await enrichSessionsWithState(merged)

        // Prune pushed sessions whose /health probe failed repeatedly — the
        // bridge is gone. `enrichSessionsWithState` leaves `state = nil` when
        // the probe errors; we catch those and drop the local push entry.
        let livePushedIds = Set(enriched.filter { $0.state != nil }.map { $0.id })
        let stalePushed = pushedSessionsById.keys.filter { id in
            registryEntries.contains(where: { $0.id == id }) == false
                && livePushedIds.contains(id) == false
        }
        for id in stalePushed {
            DaemonLogger.shared.debug("Daemon", "Pruning stale pushed session \(id)")
            pushedSessionsById.removeValue(forKey: id)
            codexProcessingTouchedAtBySession.removeValue(forKey: id)
        }

        cachedSessions = DashboardDataRules.sortSessions(enriched.filter { entry in
            // Keep filesystem entries unconditionally; drop pushed entries
            // whose probe failed (already pruned above, double-gate for safety).
            if registryEntries.contains(where: { $0.id == entry.id }) { return true }
            if observedIds.contains(entry.id) { return true }
            return livePushedIds.contains(entry.id)
        })
        broadcastSessionsList()
    }

    private func enrichSessionsWithState(_ sessions: [DaemonSessionEntry]) async -> [DaemonSessionEntry] {
        // Hook-synthesized sessions share this daemon's port, so probing
        // `/health` would loop back to us and every entry would end up
        // carrying our *global* stateMachine.state — which makes every
        // creature mirror the most recently active session and fire
        // "idle" on another session's Stop. Skip the self-probe; the
        // per-session state we set in handleHookEvent is already right.
        let selfPort = Int(self.port)
        return await withTaskGroup(of: DaemonSessionEntry.self) { group in
            for session in sessions {
                group.addTask {
                    var s = session
                    guard session.port > 0 else { return s }
                    guard session.port != selfPort else { return s }
                    if let health = await SessionRegistry.shared.probeDaemonHealth(port: session.port) {
                        s.agentType = health["agentType"] as? String ?? s.agentType
                        s.state = health["state"] as? String
                        s.modelName = health["modelName"] as? String
                        s.effortLevel = health["effortLevel"] as? String
                        s.currentTool = health["currentTool"] as? String
                        s.navigable = health["navigable"] as? Bool
                        s.question = health["question"] as? String
                        if let rawOptions = health["options"] as? [[String: Any]] {
                            s.options = rawOptions.map { option in
                                option.mapValues(AnyCodable.init)
                            }
                        } else {
                            s.options = nil
                        }
                    }
                    return s
                }
            }
            var result: [DaemonSessionEntry] = []
            for await session in group { result.append(session) }
            return result
        }
    }

    @MainActor
    private func broadcastSessionsList() {
        // Broadcast unconditionally — late joiners (recovered ESP32, newly
        // connecting Android / SD plugin / iOS clients that don't ride the
        // WS connect handshake) need every emit to land or they end up
        // showing a stale or empty list. Fingerprint dedupe was added to
        // protect serial writers from sub-second storms, but
        // `ESP32Serial.write` now absorbs that pressure via EAGAIN-tolerant
        // retry (DEVELOPMENT_LOG 2026-05-10), so the dedupe was redundant
        // and locked recovered boards out.
        lastSessionsListBroadcastAt = Date()
        pendingSessionsListFlushTask?.cancel()
        pendingSessionsListFlushTask = nil
        let event = buildSessionsListEvent()
        // Cache for the serial on-connect snapshot + heartbeat re-sync so a
        // board that (re)connects during a quiet window still gets the roster.
        serialEventSnapshot.setSessionsEvent(event)
        broadcastRaw(event)
    }

    /// Debounced sessions_list broadcast for high-frequency cosmetic updates
    /// (currentTool set/clear at every tool boundary). Mirrors the Node hub's
    /// `maybeBroadcastSessionsList` 2 s window (bridge/src/bridge-core.ts:572)
    /// and adds a trailing flush so the LAST update always lands — devices and
    /// late joiners rely on the settled state being broadcast eventually.
    /// State / question transitions must call `broadcastSessionsList()`
    /// directly instead.
    private func scheduleSessionsListBroadcast() {
        let now = Date()
        let elapsed = now.timeIntervalSince(lastSessionsListBroadcastAt)
        if elapsed >= Self.sessionsListDebounceSeconds {
            broadcastSessionsList()
            return
        }
        guard pendingSessionsListFlushTask == nil else { return }
        let delay = Self.sessionsListDebounceSeconds - elapsed
        pendingSessionsListFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.pendingSessionsListFlushTask = nil
            self.broadcastSessionsList()
        }
    }

    private func buildSessionsListEvent() -> [String: Any] {
        var sessions = cachedSessions.map { sessionToDict($0) }
        // Inject virtual OpenClaw session iff Gateway is authenticated. SSOT:
        // DashboardDataRules.isOpenClawSessionActive (mirror of
        // shared/src/session-utils.ts). Identical predicate to the Node bridge.
        if DashboardDataRules.isOpenClawSessionActive(gatewayConnected: cachedGatewayConnected) {
            if !DashboardDataRules.hasOpenClawSession(sessions)
                && !sessions.contains(where: { ($0["id"] as? String) == "openclaw-gateway" }) {
                // Only authenticated Gateway connections should materialize as
                // a virtual OpenClaw session. Reachability/auth failures stay
                // in the topology/status rows so the terrarium does not render
                // a crayfish that looks like an active integration.
                var gatewaySession: [String: Any] = [
                    "id": "openclaw-gateway", "port": 18789,
                    "projectName": "OpenClaw", "agentType": "openclaw",
                    "alive": true, "state": gatewaySessionState,
                ]
                // Emit `startedAt` only when we have a real connect timestamp.
                // Previously this slot held a 1970-epoch placeholder, which the
                // menubar's relative-time chip rendered as "20582d".
                if let connectedAt = gatewayConnectedAt {
                    gatewaySession["startedAt"] = ISO8601DateFormatter().string(from: connectedAt)
                }
                if let tool = gatewayCurrentTool { gatewaySession["currentTool"] = tool }
                if let modelName = gatewayModelName { gatewaySession["modelName"] = modelName }
                sessions.append(gatewaySession)
            }
        }
        sessions = DashboardDataRules.foldCodexSessionPayloadsForDisplay(sessions)
        sessions = DashboardDataRules.sortSessionPayloads(sessions)
        return ["type": "sessions_list", "sessions": sessions]
    }

    // MARK: - Usage (3-tier relay)

    @MainActor
    private func fetchUsageRelayed() async {
        let sessions = await registry.listActiveAndReachable().filter { $0.agentType != "daemon" && $0.id != sessionId }
        DaemonLogger.shared.sampledDebug("Daemon", key: "usage-relay:start", every: 10, "fetchUsageRelayed: \(sessions.count) siblings")

        // Tier 1: HTTP relay from sibling
        for sibling in sessions {
            DaemonLogger.shared.sampledDebug("Daemon", key: "usage-relay:tier1-port-\(sibling.port)", every: 10, "Usage Tier 1: HTTP relay from port \(sibling.port)")
            if let usage = await fetchUsageViaHTTP(port: sibling.port) {
                updateRelayedCodexAuthStatus(from: usage)
                // Parse relayed dict back into ApiUsageData for caching
                cachedApiUsage = parseRelayedUsage(usage)
                if let fetchedAt = cachedApiUsage?.fetchedAt {
                    lastApiFetchTime = Date(timeIntervalSince1970: fetchedAt)
                } else {
                    lastApiFetchTime = Date()
                }
                apiUsageStale = cachedApiUsage?.stale ?? false
                apiUsagePreAdjusted = false  // raw data from HTTP, needs adjustment
                oauthConnected = usage["oauthConnected"] as? Bool ?? true
                // Infer billing type
                if let inferred = cachedApiUsage?.inferredBillingType {
                    stateMachine.billingType = inferred
                }
                DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier1-ok", "Usage Tier 1 OK: 5h=\(cachedApiUsage?.fiveHourPercent ?? -1)%", minInterval: 30)
                broadcastUsage()
                return
            }
        }

        // Siblings exist but relay failed — do NOT call direct API (429 prevention)
        // But still broadcast cached data so clients aren't left empty
        if !sessions.isEmpty {
            DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier1-failed", "Usage Tier 1 failed for all \(sessions.count) siblings", minInterval: 30)
            if usageAPI.isDirectOAuthUsageSupported {
                oauthConnected = usageAPI.hasOAuthToken()
            }
            // Don't mark stale here — usageTick's 10-min TTL handles staleness.
            // A transient relay failure with fresh cached data isn't stale.
            broadcastUsage()
            return
        }

        // Tier 3: Direct API (only if no siblings)
        guard usageAPI.isDirectOAuthUsageSupported else {
            DaemonLogger.shared.throttledDebug(
                "Daemon",
                key: "usage-relay:tier3-unavailable",
                "Usage Tier 3 skipped: direct OAuth usage unavailable in Swift daemon",
                minInterval: 300
            )
            if cachedApiUsage != nil {
                apiUsageStale = true
            }
            broadcastUsage()
            return
        }

        DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier3-start", "Usage Tier 3: direct API", minInterval: 30)
        if let usage = await usageAPI.fetchUsage() {
            cachedApiUsage = usage
            if let fetchedAt = usage.fetchedAt {
                lastApiFetchTime = Date(timeIntervalSince1970: fetchedAt)
            } else {
                lastApiFetchTime = Date()
            }
            apiUsageStale = usage.stale
            apiUsagePreAdjusted = false  // raw data from API, needs adjustment
            oauthConnected = usageAPI.tokenStatus == .valid
            if let inferred = usage.inferredBillingType {
                stateMachine.billingType = inferred
            }
            DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier3-ok", "Usage Tier 3 OK: 5h=\(usage.fiveHourPercent ?? -1)%", minInterval: 30)
            broadcastUsage()
        } else {
            DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier3-failed:\(usageAPI.tokenStatus.rawValue)", "Usage Tier 3 failed (token: \(usageAPI.tokenStatus.rawValue))", minInterval: 30)
            oauthConnected = usageAPI.hasOAuthToken()
            // Don't mark stale here for transient failures — usageTick's
            // 10-min TTL handles temporary outages. BUT: if the token is
            // definitively missing or expired (App Store sandbox with no
            // ~/.claude OAuth access, or post-logout), no fresh fetch will
            // ever land through this daemon — flag stale immediately so
            // every downstream surface collapses its usage region instead
            // of showing cached numbers during the 10-min grace.
            switch usageAPI.tokenStatus {
            case .missing, .expired:
                if !apiUsageStale {
                    DaemonLogger.shared.debug("Daemon", "Token \(usageAPI.tokenStatus.rawValue) — marking cached usage stale so UI hides instead of showing frozen values")
                    apiUsageStale = true
                }
            default: break
            }
            broadcastUsage()
        }
    }

    private func fetchUsageViaHTTP(port: Int) async -> [String: Any]? {
        let url = URL(string: "http://127.0.0.1:\(port)/usage")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  var usage = json["usage"] as? [String: Any] else { return nil }
            // Validate fetchedAt — skip stale data (>5 min)
            if let fetchedAt = json["fetchedAt"] as? Int, fetchedAt > 0 {
                let ageMs = Int(Date().timeIntervalSince1970 * 1000) - fetchedAt
                if ageMs > 5 * 60 * 1000 { return nil }
                usage["fetchedAt"] = Double(fetchedAt) / 1000.0
            }
            usage["type"] = "usage_update"
            return usage
        } catch { return nil }
    }

    /// Parse a relayed usage dict back into ApiUsageData for local caching
    private func parseRelayedUsage(_ dict: [String: Any]) -> ApiUsageData {
        ApiUsageData(
            fiveHourPercent: dict["fiveHourPercent"] as? Double,
            fiveHourResetsAt: dict["fiveHourResetsAt"] as? String,
            sevenDayPercent: dict["sevenDayPercent"] as? Double,
            sevenDayResetsAt: dict["sevenDayResetsAt"] as? String,
            extraUsageEnabled: dict["extraUsageEnabled"] as? Bool ?? false,
            extraUsageMonthlyLimit: dict["extraUsageMonthlyLimit"] as? Double,
            extraUsageUsedCredits: dict["extraUsageUsedCredits"] as? Double,
            extraUsageUtilization: dict["extraUsageUtilization"] as? Double,
            inferredBillingType: dict["fiveHourPercent"] != nil ? "subscription" : "api",
            fetchedAt: dict["fetchedAt"] as? Double,
            stale: dict["usageStale"] as? Bool ?? false
        )
    }

    @MainActor
    private func updateRelayedCodexAuthStatus(from event: [String: Any]) {
        let hasCodexAuthField = [
            "codexAuthMode",
            "codexWebAuthConnected",
            "codexPlanType",
            "codexAccountId",
            "codexSubscriptionActiveUntil",
            "codexLastRefreshAt",
        ].contains { event[$0] != nil }
        guard hasCodexAuthField else { return }

        let webAuthConnected = event["codexWebAuthConnected"] as? Bool ?? false
        let current = CodexAuthStatus(
            authMode: Self.nonEmptyString(event["codexAuthMode"]),
            webAuthConnected: webAuthConnected,
            accessTokenPresent: webAuthConnected,
            planType: Self.nonEmptyString(event["codexPlanType"]),
            accountId: Self.nonEmptyString(event["codexAccountId"]),
            subscriptionActiveUntil: Self.nonEmptyString(event["codexSubscriptionActiveUntil"]),
            lastRefreshAt: Self.nonEmptyString(event["codexLastRefreshAt"])
        )

        relayedCodexAuthStatus = UsageAPIClient.stabilizeCodexAuthStatus(
            previous: relayedCodexAuthStatus,
            current: current
        )
    }

    @MainActor
    private func codexAuthStatusSnapshot() -> CodexAuthStatus? {
        Self.mergeCodexAuthStatus(
            primary: usageAPI.codexAuthStatus,
            fallback: relayedCodexAuthStatus
        )
    }

    private static func mergeCodexAuthStatus(
        primary: CodexAuthStatus?,
        fallback: CodexAuthStatus?
    ) -> CodexAuthStatus? {
        guard let primary else { return fallback }
        guard let fallback else { return primary }
        return CodexAuthStatus(
            authMode: primary.authMode ?? fallback.authMode,
            webAuthConnected: primary.webAuthConnected || fallback.webAuthConnected,
            accessTokenPresent: primary.accessTokenPresent || fallback.accessTokenPresent,
            planType: primary.planType ?? fallback.planType,
            accountId: primary.accountId ?? fallback.accountId,
            subscriptionActiveUntil: primary.subscriptionActiveUntil ?? fallback.subscriptionActiveUntil,
            lastRefreshAt: primary.lastRefreshAt ?? fallback.lastRefreshAt
        )
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: - Broadcasting

    @MainActor
    private func broadcastStateUpdate() {
        let gwAlive = cachedGatewayConnected
        let event = buildFullStateEvent(agentType: gwAlive ? "openclaw" : "daemon")
        lastStateEvent = event
        serialEventSnapshot.setStateEvent(event)
        broadcastRaw(event)
    }

    @MainActor
    private func broadcastUsage() {
        if let event = buildUsageEvent() {
            serialEventSnapshot.setUsageEvent(event)
            broadcastRaw(event)
        } else {
            serialEventSnapshot.setUsageEvent(nil)
        }
    }

    @MainActor
    private func broadcastRaw(_ event: [String: Any]) {
        if let data = event.jsonData {
            Task { await wsServer.broadcastRaw(data) }
        }
    }

    /// Read the `displaySleepDim` object from settings.json into
    /// `cachedDimConfig`. Missing object or fields fall back to legacy
    /// behavior (enabled, off, 10) so an un-migrated settings.json keeps
    /// dimming devices to full-off exactly as before. Same clobber-resistant
    /// read as `AppPreferences.writeDisplaySleepDimToSettingsJson`.
    @MainActor
    private func loadDisplaySleepDimFromSettings() {
        let url = AgentDeckPaths.settingsJson
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let dim = root["displaySleepDim"] as? [String: Any] else {
            cachedDimConfig = (true, "off", 10)
            return
        }
        let enabled = dim["enabled"] as? Bool ?? true
        let mode = (dim["mode"] as? String) == "min" ? "min" : "off"
        let rawLevel = dim["level"] as? Int ?? 10
        let level = max(1, min(100, rawLevel))
        cachedDimConfig = (enabled, mode, level)
    }

    /// Build the `dim` sub-dict embedded in every `display_state` broadcast so
    /// Pixoo / D200H / ESP32 apply one consistent snapshot.
    @MainActor
    private func currentDimDict() -> [String: Any] {
        return [
            "enabled": cachedDimConfig.enabled,
            "mode": cachedDimConfig.mode,
            "level": cachedDimConfig.level,
        ]
    }

    /// In-process accessor for D200H module status. Same-process callers
    /// (e.g. `DaemonService` health monitor) must use this instead of HTTP
    /// self-probing `/health` — routing a loopback query through
    /// `URLSession.shared` creates a negative-feedback loop under connection
    /// pool contention (see memory: `bug_daemon_self_http_probe.md`).
    /// Returns the same dict that `/health` → `modules.d200h` would return,
    /// or `nil` if the D200H module isn't initialized.
    @MainActor
    func d200hStatusSnapshot() -> [String: Any]? {
        return d200hHealthSnapshot()
    }

    /// Node parity (bridge `moduleHealthProvider`): the D200H is driven
    /// exclusively by the Ulanzi Studio plugin, so its connectivity is that
    /// plugin's WS presence. The dormant direct-HID module stays authoritative
    /// if it is ever re-enabled. Returns nil when neither is present so users
    /// without a D200H never see a ghost row.
    @MainActor
    private func d200hHealthSnapshot() -> [String: Any]? {
        if let d200hModule { return d200hModule.statusSnapshot() }
        guard ulanziPluginConnectionId != nil else { return nil }
        return [
            "connected": true,
            "externalOwner": true,
            "managerOpened": true,
        ]
    }

    /// In-process accessors for the other device modules. Same rationale as
    /// `d200hStatusSnapshot()` — callers inside the app (menu bar devices
    /// section) must not HTTP-probe `/health`. All return `nil` when the
    /// underlying module isn't initialized for this session.
    @MainActor
    func adbStatusSnapshot() -> [String: Any]? {
        return adbModule?.statusSnapshot()
    }

    @MainActor
    func pixooStatusSnapshot() -> [String: Any]? {
        return pixooModule?.statusSnapshot()
    }

    @MainActor
    func serialStatusSnapshot() async -> [String: Any]? {
        guard let serialModule else { return nil }
        return await serialModule.statusSnapshot()
    }

    @MainActor
    private func buildModuleHealth() async -> SendableDict {
        var gateway: [String: Any] = [
            "available": cachedGatewayAvailable,
            "connected": cachedGatewayConnected,
            "hasError": cachedGatewayHasError,
            "authStatus": cachedGatewayAuthStatus,
        ]
        if let requestId = cachedGatewayAuthRequestId { gateway["authRequestId"] = requestId }
        if let message = cachedGatewayAuthMessage { gateway["authMessage"] = message }
        var modules: [String: Any] = [
            "gateway": gateway
        ]
        if let adbModule {
            modules["adb"] = adbModule.statusSnapshot()
        }
        if let d200h = d200hHealthSnapshot() {
            modules["d200h"] = d200h
        }
        if let pixooModule {
            modules["pixoo"] = pixooModule.statusSnapshot()
        }
        if let idotMatrixModule {
            modules["idotmatrix"] = idotMatrixModule.statusSnapshot()
        }
        if let timeboxModule {
            modules["timebox"] = timeboxModule.statusSnapshot()
        }
        if serialModule != nil {
            // HTTP /health is used by tiny hook scripts and must answer even
            // while the serial actor is busy pushing frames to physical boards.
            // The poll cache is refreshed out-of-band and is sufficient for
            // liveness/device diagnostics.
            modules["serial"] = cachedSerialStatus ?? ["available": true, "connections": [] as [Any]]
        }
        if let sd = cachedStreamDeck {
            modules["streamDeck"] = [
                "available": true,
                "devices": sd.devices,
            ] as [String: Any]
        }
        if !cachedEinkDevices.isEmpty {
            modules["einkDevices"] = [
                "available": true,
                "devices": cachedEinkDevices.values.flatMap { $0.devices },
            ] as [String: Any]
        }
        if !cachedAndroidDashboards.isEmpty {
            modules["androidDashboards"] = [
                "available": true,
                "devices": cachedAndroidDashboards.values.flatMap { $0.devices },
            ] as [String: Any]
        }
        return SendableDict([
            "state": stateMachine.state.rawValue,
            "modules": modules,
        ])
    }

    // MARK: - Event Builders

    @MainActor
    private func buildFullStateEvent(agentType: String) -> [String: Any] {
        var e: [String: Any] = [
            "type": "state_update",
            "state": stateMachine.state.rawValue,
            "permissionMode": stateMachine.permissionMode,
            "agentType": agentType,
        ]
        if let t = stateMachine.currentTool { e["currentTool"] = t }
        if let t = stateMachine.toolInput { e["toolInput"] = t }
        if let t = stateMachine.toolProgress { e["toolProgress"] = t }
        if let p = stateMachine.projectName { e["projectName"] = p }
        // Stamp the event with the session id that most recently produced a
        // hook so timeline / primary-creature attribution picks the right
        // session when several are running concurrently.
        if let sid = currentHookSessionId { e["sessionId"] = sid }
        e["focusedSessionId"] = userFocusedSessionId ?? ""
        if let m = stateMachine.modelName { e["modelName"] = m }
        if let ef = stateMachine.effortLevel { e["effortLevel"] = ef }
        e["billingType"] = stateMachine.billingType
        if !stateMachine.options.isEmpty { e["options"] = stateMachine.options }
        if let pt = stateMachine.promptType { e["promptType"] = pt }
        if let q = stateMachine.question { e["question"] = q }
        if stateMachine.navigable { e["navigable"] = true }
        e["cursorIndex"] = stateMachine.cursorIndex
        if let sp = stateMachine.suggestedPrompt { e["suggestedPrompt"] = sp }
        // Per-session awaiting overlay. The aggregate state machine can't
        // attribute a pushed (PTY-managed) session's awaiting state to a specific
        // session, so when the FOCUSED session carries an awaiting state in
        // pushedSessionsById, surface its state/question/promptType here so the
        // encoder/HUD reflect it. Options arrive via the focus relay's real
        // state_update for that session.
        if let fid = userFocusedSessionId, let entry = pushedSessionsById[fid],
           let st = entry.state, st.hasPrefix("awaiting") {
            e["state"] = st
            if let q = entry.question { e["question"] = q }
            if let pt = entry.promptType { e["promptType"] = pt }
            e["navigable"] = entry.navigable ?? false
        }
        mergeEngineSnapshot(into: &e)
        e["gatewayAvailable"] = cachedGatewayAvailable
        e["gatewayConnected"] = cachedGatewayConnected
        e["gatewayHasError"] = cachedGatewayHasError
        e["gatewayAuthStatus"] = cachedGatewayAuthStatus
        if let id = cachedGatewayDeviceId { e["gatewayDeviceId"] = id }
        e["daemonPort"] = Int(port)
        if let requestId = cachedGatewayAuthRequestId { e["gatewayAuthRequestId"] = requestId }
        if let message = cachedGatewayAuthMessage { e["gatewayAuthMessage"] = message }
        if let url = cachedPairingUrl { e["pairingUrl"] = url }
        if let r = stateMachine.remoteUrl { e["remoteUrl"] = r }
        e["oauthConnected"] = effectiveOauthConnected()
        // Voice assistant state (piggyback on state_update for all clients)
        if cachedVoiceAssistantState != "disabled" {
            e["voiceAssistantState"] = cachedVoiceAssistantState
            e["voiceAssistantText"] = cachedVoiceAssistantText as Any
            e["voiceAssistantResponseText"] = cachedVoiceAssistantResponseText as Any
        }
        // Module health for device diagnostic panel
        e["moduleHealth"] = buildModuleHealthSync()
        // Subscription rows belong on every state_update — the SwiftUI rail
        // reads `state.subscriptions` from this event, not from usage_update.
        if let codex = codexAuthStatusSnapshot() {
            Self.writeCodexAuthStatus(codex, into: &e)
        }
        e["subscriptions"] = buildSubscriptions()
        return e
    }

    /// Refresh cached Anthropic Console Admin API usage. No-op when
    /// no key is configured. On failure the previous cached value is
    /// flagged stale so the UI can show "last known" values.
    @MainActor
    private func refreshAdminApiUsage() async {
        guard AnthropicAdminApiClient.shared.hasKey() else { return }
        if let fresh = await AnthropicAdminApiClient.shared.fetchUsage() {
            cachedAdminApiUsage = fresh
            lastAdminApiFetchTime = Date()
        } else if var stale = cachedAdminApiUsage {
            stale.stale = true
            cachedAdminApiUsage = stale
        }
        broadcastUsage()
    }

    /// In App Store sandbox, `usageAPI.hasOAuthToken()` always returns
    /// false because Anthropic does not publish a Keychain Access Group
    /// for the Claude Code OAuth entry (see `UsageAPIClient.swift` —
    /// `getOAuthCredentials()` is hard-nil). When a Claude Code session
    /// is actively producing hooks against this daemon it is, by
    /// construction, holding a valid OAuth token; lift the broadcast
    /// flag so the Android tablet / Stream Deck topology row reflects
    /// reality instead of "Not connected".
    @MainActor
    private func effectiveOauthConnected() -> Bool {
        if oauthConnected { return true }
        return cachedSessions.contains { $0.agentType == "claude-code" }
    }

    private func buildModuleHealthSync() -> [String: Any] {
        var modules: [String: Any] = [:]
        if let adb = adbModule { modules["adb"] = adb.statusSnapshot() }
        if let d200h = d200hHealthSnapshot() { modules["d200h"] = d200h }
        if let pixoo = pixooModule { modules["pixoo"] = pixoo.statusSnapshot() }
        if let idotMatrix = idotMatrixModule { modules["idotmatrix"] = idotMatrix.statusSnapshot() }
        if let timebox = timeboxModule { modules["timebox"] = timebox.statusSnapshot() }
        // SerialModule.statusSnapshot() is async — read the 5s-polled
        // cache so Dashboard USB serial section sees connected boards
        // without us having to awaitly-pre-fetch on every broadcast.
        if let cachedSerial = cachedSerialStatus {
            modules["serial"] = cachedSerial
        } else if serialModule != nil {
            modules["serial"] = ["available": true, "connections": [] as [Any]] as [String: Any]
        }
        if let sd = cachedStreamDeck {
            modules["streamDeck"] = [
                "available": true,
                "devices": sd.devices,
            ] as [String: Any]
        }
        if !cachedEinkDevices.isEmpty {
            modules["einkDevices"] = [
                "available": true,
                "devices": cachedEinkDevices.values.flatMap { $0.devices },
            ] as [String: Any]
        }
        if !cachedAndroidDashboards.isEmpty {
            modules["androidDashboards"] = [
                "available": true,
                "devices": cachedAndroidDashboards.values.flatMap { $0.devices },
            ] as [String: Any]
        }
        return modules
    }

    private func buildUsageEvent() -> [String: Any]? {
        var e: [String: Any] = ["type": "usage_update"]

        // Session fields from StateMachine
        e["sessionDurationSec"] = stateMachine.sessionDurationSec
        e["inputTokens"] = stateMachine.inputTokens
        e["outputTokens"] = stateMachine.outputTokens
        e["toolCalls"] = stateMachine.toolCalls
        if let v = stateMachine.estimatedCostUsd { e["estimatedCostUsd"] = v }
        if let v = stateMachine.sessionPercent { e["sessionPercent"] = v }
        if let v = stateMachine.costSpent { e["costSpent"] = v }
        if let v = stateMachine.costLimit { e["costLimit"] = v }
        if let v = stateMachine.resetTime { e["resetTime"] = v }
        if let v = stateMachine.resetDate { e["resetDate"] = v }

        // API usage data — skip adjustUsagePercent when values were synced from relay.
        // When the data is stale (no live fetch succeeded recently, e.g. App Store
        // sandbox with no relay path), emit neither percentages nor reset times so
        // every downstream surface — macOS dashboard, Stream Deck plugin, Android,
        // Pixoo, D200H — collapses its usage region instead of rendering a stale
        // number that looks authoritative. `usageStale` flag is still sent so
        // callers that want to distinguish "never fetched" from "had data, now
        // stale" can, but no numbers ride along with it.
        if let u = cachedApiUsage {
            let usageIsStale = apiUsageStale || u.stale
            if !usageIsStale {
                if apiUsagePreAdjusted {
                    e["fiveHourPercent"] = u.fiveHourPercent as Any
                    e["sevenDayPercent"] = u.sevenDayPercent as Any
                } else {
                    e["fiveHourPercent"] = adjustUsagePercent(u.fiveHourPercent, resetsAt: u.fiveHourResetsAt) as Any
                    e["sevenDayPercent"] = adjustUsagePercent(u.sevenDayPercent, resetsAt: u.sevenDayResetsAt) as Any
                }
                if let v = u.fiveHourResetsAt { e["fiveHourResetsAt"] = v }
                if let v = u.sevenDayResetsAt { e["sevenDayResetsAt"] = v }
            }
            e["extraUsageEnabled"] = u.extraUsageEnabled
            if let v = u.extraUsageMonthlyLimit { e["extraUsageMonthlyLimit"] = v }
            if let v = u.extraUsageUsedCredits { e["extraUsageUsedCredits"] = v }
            if let v = u.extraUsageUtilization { e["extraUsageUtilization"] = v }
        }

        e["oauthConnected"] = effectiveOauthConnected()
        e["usageStale"] = apiUsageStale || cachedApiUsage?.stale == true
        mergeEngineSnapshot(into: &e)
        let ts = usageAPI.tokenStatus
        if ts != .unknown { e["tokenStatus"] = ts.rawValue }
        if let codex = codexAuthStatusSnapshot() {
            Self.writeCodexAuthStatus(codex, into: &e)
        }
        if let rateLimits = usageAPI.codexRateLimits {
            e["codexRateLimits"] = Self.codexRateLimitsPayload(rateLimits)
        }
        if let antigravity = cachedAntigravityStatus {
            e["antigravityStatus"] = antigravityPayload(antigravity)
        }
        e["subscriptions"] = buildSubscriptions()

        e["adminApiKeyPresent"] = AnthropicAdminApiClient.shared.hasKey()
        if let admin = cachedAdminApiUsage {
            e["adminApiTodayInputTokens"] = admin.today.input
            e["adminApiTodayOutputTokens"] = admin.today.output
            e["adminApiTodayCacheReadTokens"] = admin.today.cacheRead
            e["adminApiTodayCacheCreationTokens"] = admin.today.cacheCreation
            e["adminApiMonthInputTokens"] = admin.month.input
            e["adminApiMonthOutputTokens"] = admin.month.output
            e["adminApiMonthCacheReadTokens"] = admin.month.cacheRead
            e["adminApiMonthCacheCreationTokens"] = admin.month.cacheCreation
            e["adminApiTopModels"] = admin.topModels.map {
                ["model": $0.model, "totalTokens": $0.totalTokens]
            }
            e["adminApiFetchedAt"] = admin.fetchedAt
            e["adminApiStale"] = admin.stale
        }

        return e
    }

    @MainActor
    private func mergeEngineSnapshot(into event: inout [String: Any]) {
        if !cachedModelCatalog.isEmpty { event["modelCatalog"] = cachedModelCatalog }
        if let ollama = cachedOllamaStatus { event["ollamaStatus"] = ollama }
        if !cachedMlxModels.isEmpty { event["mlxModels"] = cachedMlxModels }
        if !cachedMlxModelCatalog.isEmpty { event["mlxModelCatalog"] = cachedMlxModelCatalog }
        event["subscriptions"] = buildSubscriptions()
        if let antigravity = cachedAntigravityStatus {
            event["antigravityStatus"] = antigravityPayload(antigravity)
        }
    }

    @MainActor
    private func buildSubscriptions() -> [[String: Any]] {
        var subscriptions: [[String: Any]] = []
        // ChatGPT/Codex plan metadata comes from local Codex auth files and
        // is not a live subscription source for the App Store daemon. Keep it
        // out of the subscription footer; the external CLI daemon may still
        // relay this row when it owns the full developer bridge.
        if cachedApiUsage?.inferredBillingType == "subscription" || stateMachine.billingType == "subscription" {
            subscriptions.append(["name": "Claude"])
        }
        return subscriptions
    }

    private static func writeCodexAuthStatus(_ codex: CodexAuthStatus, into event: inout [String: Any]) {
        if let mode = codex.authMode { event["codexAuthMode"] = mode }
        event["codexWebAuthConnected"] = codex.webAuthConnected
        if let plan = codex.planType { event["codexPlanType"] = plan }
        if let accountId = codex.accountId { event["codexAccountId"] = accountId }
        if let until = codex.subscriptionActiveUntil { event["codexSubscriptionActiveUntil"] = until }
        if let refresh = codex.lastRefreshAt { event["codexLastRefreshAt"] = refresh }
    }

    /// A Codex rolling-window snapshot is stale once its window has ended:
    /// `resetsAt` is in the past beyond a short grace (5m). Mirrors the TS
    /// `isCodexWindowStale` — Codex usage is read passively from local rollout
    /// files, so once Codex stops being used the snapshot freezes and a "now"
    /// countdown would mislead. Grace keeps a just-reset window briefly showing "now".
    private static func isCodexWindowStale(_ resetsAt: String?, graceSeconds: Double = 300) -> Bool {
        guard let resetsAt, let date = ISO8601DateFormatter().date(from: resetsAt) else { return false }
        return -date.timeIntervalSinceNow > graceSeconds
    }

    private static func codexRateLimitsPayload(_ limits: CodexRateLimitsLocal) -> [String: Any] {
        func window(_ w: CodexRateLimitWindowLocal?) -> [String: Any]? {
            guard let w else { return nil }
            var d: [String: Any] = ["usedPercent": w.usedPercent, "windowMinutes": w.windowMinutes]
            // Expired window: keep last-known usedPercent but drop resetsAt (so no
            // downstream formatter prints "now") and flag stale so surfaces dim it.
            if isCodexWindowStale(w.resetsAt) {
                d["stale"] = true
            } else if let resetsAt = w.resetsAt {
                d["resetsAt"] = resetsAt
            }
            return d
        }
        var payload: [String: Any] = [:]
        if let p = window(limits.primary) { payload["primary"] = p }
        if let s = window(limits.secondary) { payload["secondary"] = s }
        if let plan = limits.planType { payload["planType"] = plan }
        return payload
    }

    private static func chatGptSubscriptionName(_ codex: CodexAuthStatus) -> String? {
        if let plan = codex.planType {
            return chatGptPlanDisplay(plan)
        }
        if codex.webAuthConnected || codex.authMode == "chatgpt" || codex.subscriptionActiveUntil != nil {
            return "ChatGPT"
        }
        return nil
    }

    /// Returns 0 if the usage window has already reset.
    /// Added 'sticky' 5-min buffer for high usage to avoid premature '0% (now)'.
    private static func chatGptPlanDisplay(_ raw: String) -> String {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "plus": return "ChatGPT Plus"
        case "pro": return "ChatGPT Pro"
        case "team": return "ChatGPT Team"
        case "enterprise": return "ChatGPT Enterprise"
        default: return "ChatGPT \(raw)"
        }
    }

    private func antigravityPayload(_ status: AntigravityStatus) -> [String: Any] {
        var payload: [String: Any] = [:]
        if let planName = status.planName { payload["planName"] = planName }
        if let availableCredits = status.availableCredits { payload["availableCredits"] = availableCredits }
        if let minimumCreditAmountForUsage = status.minimumCreditAmountForUsage {
            payload["minimumCreditAmountForUsage"] = minimumCreditAmountForUsage
        }
        if let subscriptionActiveUntil = status.subscriptionActiveUntil {
            payload["subscriptionActiveUntil"] = subscriptionActiveUntil
        }
        return payload
    }

    private func adjustUsagePercent(_ percent: Double?, resetsAt: String?) -> Double? {
        guard let percent else { return nil }
        guard let resetsAt else { return percent }

        // Robust parsing
        let resetDate: Date?
        if let d = ISO8601DateFormatter().date(from: resetsAt) {
            resetDate = d
        } else {
            let pattern = #"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})"#
            if let regex = try? NSRegularExpression(pattern: pattern),
               let match = regex.firstMatch(in: resetsAt, range: NSRange(resetsAt.startIndex..., in: resetsAt)),
               let dateRange = Range(match.range(at: 1), in: resetsAt) {
                let baseDate = String(resetsAt[dateRange])
                let tz: String
                if match.range(at: 3).location != NSNotFound,
                   let tzRange = Range(match.range(at: 3), in: resetsAt) {
                    tz = String(resetsAt[tzRange])
                } else {
                    tz = "Z"
                }
                resetDate = ISO8601DateFormatter().date(from: baseDate + tz)
            } else {
                resetDate = nil
            }
        }

        guard let resetDate else {
            DaemonLogger.shared.debug("Daemon", "Failed to parse resetsAt: \(resetsAt)")
            return percent
        }

        let now = Date()
        let elapsed = now.timeIntervalSince(resetDate)

        // If time hasn't passed yet, show current percent
        if elapsed < 0 { return percent }

        // Far-past resets_at (>1h) means Anthropic's /oauth/usage is returning
        // a prior window's final value because no new window is active — or the
        // bridge cache is stuck in a 429 backoff loop. In either case, zeroing
        // would underreport real usage; keep the last-known percent and let the
        // `usageStale` flag surface uncertainty to the UI.
        if elapsed > 3600 { return percent }

        // High-usage sticky: hold 90%+ values for 5 minutes post-reset to mask
        // server propagation lag / clock skew. Note: percent is on a 0–100 scale,
        // so the threshold is 90.0 (prior code used 0.90 and silently behaved
        // like a 0.9% threshold).
        if percent > 90.0 {
            if elapsed < 300 {
                return percent
            }
        } else {
            if elapsed < 60 {
                return percent
            }
        }

        return 0
    }

    // MARK: - Ollama

    @MainActor
    private func probeOllama() async {
        let previous = cachedOllamaStatus as NSDictionary?
        var success = false

        // `/api/tags` returns every installed model with details (family,
        // parameter_size); `/api/ps` returns only models currently resident
        // in VRAM. We need both: tags is the source of truth for "what's
        // available", ps overlays runtime VRAM usage. Embedding models
        // (bert family, bge-*/e5-*/gte-* names, etc.) never sit in VRAM
        // between requests — surfacing them as "not loaded" is misleading,
        // so we classify each row as "chat" vs "embed" so the UI can
        // group them without the loaded/not-loaded framing.
        async let tagsData = fetchOllamaData(path: "/api/tags")
        async let psData = fetchOllamaData(path: "/api/ps")
        let tags = (await tagsData).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let ps = (await psData).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }

        if let tags, let tagModels = tags["models"] as? [[String: Any]] {
            var vramByName: [String: Int] = [:]
            if let ps, let psModels = ps["models"] as? [[String: Any]] {
                for m in psModels {
                    guard let name = m["name"] as? String else { continue }
                    vramByName[name] = m["size_vram"] as? Int ?? m["sizeVram"] as? Int ?? 0
                }
            }
            cachedOllamaStatus = [
                "available": true,
                "models": tagModels.map { m -> [String: Any] in
                    let name = m["name"] as? String ?? ""
                    let family = (m["details"] as? [String: Any])?["family"] as? String
                    return [
                        "name": name,
                        "size": m["size"] ?? 0,
                        "sizeVram": vramByName[name] ?? 0,
                        "kind": Self.classifyOllamaKind(name: name, family: family),
                    ]
                }
            ]
            success = true
        } else if let ps, let psModels = ps["models"] as? [[String: Any]] {
            // /api/tags failed but /api/ps succeeded — still report Ollama
            // as available (we just won't know about unloaded installed
            // models this cycle).
            cachedOllamaStatus = [
                "available": true,
                "models": psModels.map { m -> [String: Any] in
                    let name = m["name"] as? String ?? ""
                    let family = (m["details"] as? [String: Any])?["family"] as? String
                    return [
                        "name": name,
                        "size": m["size"] ?? 0,
                        "sizeVram": m["size_vram"] ?? m["sizeVram"] ?? 0,
                        "kind": Self.classifyOllamaKind(name: name, family: family),
                    ]
                }
            ]
            success = true
        }

        if success {
            ollamaFailureCount = 0
            ollamaNextInterval = Self.probeBaseInterval
        } else {
            ollamaFailureCount += 1
            ollamaNextInterval = min(ollamaNextInterval * 2, Self.probeMaxInterval)
            // Preserve the last-known cache until we've seen N consecutive
            // failures — a single blip (e.g. URLSession contention) should not
            // flip the UI to "unavailable". Once stale, flip to unavailable.
            if ollamaFailureCount >= Self.probeStaleThreshold {
                cachedOllamaStatus = ["available": false, "models": [] as [Any]]
            }
        }

        if previous == nil || !(previous?.isEqual(to: cachedOllamaStatus ?? [:]) ?? false) {
            broadcastStateUpdate()
            broadcastUsage()
        }
    }

    /// Fetch `http://127.0.0.1:11434<path>` as raw Data with a 2s timeout.
    /// Parsing is deferred to the caller so the return type stays Sendable
    /// across the `async let` parallelism boundary in `probeOllama`.
    /// Returns nil on any network error.
    private nonisolated func fetchOllamaData(path: String) async -> Data? {
        guard let url = URL(string: "http://127.0.0.1:11434\(path)") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        guard let (data, _) = try? await LocalProbeSession.shared.data(for: request) else {
            return nil
        }
        return data
    }

    /// Classify an Ollama model as "chat" (text generation) or "embed"
    /// (embedding-only). Uses `details.family` as the primary signal and
    /// falls back to well-known embed name patterns for older Ollama
    /// builds that don't surface family. Embedding families Ollama
    /// produces: `bert`, `nomic-bert`, `distilbert`, `roberta`.
    private static func classifyOllamaKind(name: String, family: String?) -> String {
        if let family = family?.lowercased(),
           ["bert", "nomic-bert", "distilbert", "roberta"].contains(family) {
            return "embed"
        }
        let lower = name.lowercased()
        let embedMarkers = [
            "bge-", "-embed", "embed-", "nomic-embed", "mxbai-embed",
            "snowflake-arctic-embed", "all-minilm", "gte-",
        ]
        if embedMarkers.contains(where: { lower.contains($0) }) { return "embed" }
        if lower.hasPrefix("e5-") || lower.hasPrefix("e5:") { return "embed" }
        return "chat"
    }

    @MainActor
    private func probeMLX() async {
        let previous = cachedMlxModels
        let previousCatalog = cachedMlxModelCatalog
        let fallbackCandidates = [
            "http://127.0.0.1:8800/v1/models",
            "http://127.0.0.1:8800/models",
        ]
        // Once an endpoint has been resolved, prefer it exclusively. Only when
        // discovery keeps failing do we broaden the search back to all
        // fallbacks — this avoids burning 2 × N seconds on every poll cycle
        // while the service is absent.
        let candidates: [String]
        if let preferred = preferredMlxModelsEndpoint, mlxFailureCount < Self.probeStaleThreshold {
            candidates = [preferred]
        } else {
            candidates = Array(Set(([preferredMlxModelsEndpoint].compactMap { $0 }) + fallbackCandidates))
        }
        var resolved: [String] = []
        var success = false

        for endpoint in candidates {
            guard let url = URL(string: endpoint) else { continue }
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 2
                let (data, response) = try await LocalProbeSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard status == 200,
                      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let rows = json["data"] as? [[String: Any]] else {
                    continue
                }
                resolved = Array(Set(rows.compactMap { row in
                    if let id = row["id"] as? String, !id.isEmpty { return id }
                    if let name = row["name"] as? String, !name.isEmpty { return name }
                    return nil
                }.filter { !$0.lowercased().contains("nanollava") })).sorted()
                if !resolved.isEmpty {
                    preferredMlxModelsEndpoint = endpoint
                    success = true
                    break
                }
            } catch {
                continue
            }
        }

        if success {
            mlxFailureCount = 0
            mlxNextInterval = Self.probeBaseInterval
            let pin = ApmeSettings.loadMlxConfig().model
            cachedMlxModelCatalog = resolved
            cachedMlxModels = Self.pickMlxModels(catalog: resolved, pin: pin)
        } else {
            mlxFailureCount += 1
            mlxNextInterval = min(mlxNextInterval * 2, Self.probeMaxInterval)
            // Keep last-known model list until we've seen N consecutive
            // failures; then clear so the UI reflects unavailability.
            if mlxFailureCount >= Self.probeStaleThreshold {
                cachedMlxModels = []
                cachedMlxModelCatalog = []
            }
        }

        if previous != cachedMlxModels || previousCatalog != cachedMlxModelCatalog {
            broadcastStateUpdate()
            broadcastUsage()
        }
    }

    private static func pickMlxModels(catalog: [String], pin: String?) -> [String] {
        if let pin, catalog.contains(pin) {
            return [pin]
        }
        let fallback = "mlx-community/Qwen3-1.7B-4bit"
        if catalog.contains(fallback) {
            return [fallback]
        }
        if let first = catalog.first {
            return [first]
        }
        return []
    }

    /// Probe the APME judge backend status. Returns a Sendable snapshot
    /// compatible with the CLI daemon's `JudgeBackendStatus` interface.
    @MainActor
    private func probeJudgeBackend() async -> JudgeBackendStatus {
        let config = ApmeSettings.load()
        let backend = config.judge.backend
        let checkedAt = Int(Date().timeIntervalSince1970 * 1000)

        if backend == .mlx {
            let mlxConfig = ApmeSettings.loadMlxConfig()
            let endpoint = mlxConfig.endpoint

            // Reuse cached MLX models if available
            if !cachedMlxModels.isEmpty {
                return JudgeBackendStatus(
                    backend: backend.rawValue,
                    status: "ready",
                    model: cachedMlxModels.first ?? "unknown",
                    endpoint: endpoint,
                    checkedAt: checkedAt,
                    reason: nil
                )
            } else if await ApmeJudgeMlx.isReachable() {
                // Probe will have populated cachedMlxModels
                let model = cachedMlxModels.first ?? "unknown"
                return JudgeBackendStatus(
                    backend: backend.rawValue,
                    status: "ready",
                    model: model,
                    endpoint: endpoint,
                    checkedAt: checkedAt,
                    reason: nil
                )
            } else {
                return JudgeBackendStatus(
                    backend: backend.rawValue,
                    status: "unavailable",
                    model: nil,
                    endpoint: endpoint,
                    checkedAt: checkedAt,
                    reason: "MLX server unreachable. Start with `mlx_lm.server` or configure endpoint."
                )
            }
        } else if backend == .foundationModels {
            if ApmeJudgeFoundationModels.isAvailable {
                return JudgeBackendStatus(
                    backend: backend.rawValue,
                    status: "ready",
                    model: "foundation-models",
                    endpoint: nil,
                    checkedAt: checkedAt,
                    reason: nil
                )
            }
            return JudgeBackendStatus(
                backend: backend.rawValue,
                status: "unavailable",
                model: nil,
                endpoint: nil,
                checkedAt: checkedAt,
                reason: ApmeJudgeFoundationModels.unavailableReason
            )
        } else if backend == .api {
            if ApmeJudgeApi.isConfigured {
                return JudgeBackendStatus(
                    backend: backend.rawValue,
                    status: "ready",
                    model: ApmeJudgeApi.judgeModelLabel,
                    endpoint: nil,
                    checkedAt: checkedAt,
                    reason: nil
                )
            }
            return JudgeBackendStatus(
                backend: backend.rawValue,
                status: "unavailable",
                model: nil,
                endpoint: nil,
                checkedAt: checkedAt,
                reason: "API backend requires Anthropic key configuration"
            )
        }

        return JudgeBackendStatus(
            backend: backend.rawValue,
            status: "unknown",
            model: nil,
            endpoint: nil,
            checkedAt: checkedAt,
            reason: nil
        )
    }

    // MARK: - Command Forwarding

    private func forwardCommandToSession(_ cmd: [String: Any]) {
        guard let session = cachedSessions.first(where: { $0.agentType == "claude-code" }) else { return }
        Task {
            let url = URL(string: "http://127.0.0.1:\(session.port)/command")!
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: cmd)
            request.timeoutInterval = 2
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    // MARK: - Shutdown

    func shutdown() async {
        DaemonLogger.shared.info("Daemon shutting down...")
        if let backgroundActivity { ProcessInfo.processInfo.endActivity(backgroundActivity) }
        backgroundActivity = nil
        networkMonitor?.cancel()
        networkMonitor = nil
        networkDebounceTask?.cancel()
        sessionPollTask?.cancel(); usagePollTask?.cancel(); adminApiPollTask?.cancel()
        ollamaPollTask?.cancel(); mlxPollTask?.cancel(); gatewayPollTask?.cancel()
        gatewayHealthTask?.cancel(); usageTickTask?.cancel()
        antigravityPollTask?.cancel()
        initialUsageTask?.cancel()

        voiceAssistant.stop()
        openCodeObserver.stop()
        await focusRelay.stop()
        await timelineRelay.stop()
        await logStream.stop()
        await gatewayProbe.stop()
        await displayMonitor.stop()
        if let observer = pixooSettingsObserver {
            NotificationCenter.default.removeObserver(observer)
            pixooSettingsObserver = nil
        }
        if let observer = idotmatrixSettingsObserver {
            NotificationCenter.default.removeObserver(observer)
            idotmatrixSettingsObserver = nil
        }
        if let observer = displaySettingsObserver {
            NotificationCenter.default.removeObserver(observer)
            displaySettingsObserver = nil
        }
        await moduleManager.stopAll()
        if let gw = gatewayAdapter { await gw.stop() }

        registry.deregister(sessionId)
        registry.removeDaemonInfo()

        await wsServer.stop()
        await httpServer.stop()

        DaemonLogger.shared.info("Daemon stopped")
        onShutdown?()
    }

    // MARK: - Helpers

    /// Convert an OpenClaw Gateway `tool_exec` timeline entry dict into the
    /// `(event, data)` shape the APME collector hook expects.
    ///
    /// Two responsibilities concentrated here so the routing decision stays
    /// testable and the call site stays small:
    ///
    /// 1. **Field extraction.** OpenClawAdapter exposes the real tool
    ///    name/input/output as out-of-band dict keys (`toolName`,
    ///    `toolInput`, `toolOutput`) alongside the human-readable `raw`
    ///    placeholder ("{name} · {status}"). Prefer the structured fields;
    ///    fall back to splitting `raw` on " · " for legacy entries that
    ///    pre-date the extras dict. Mirror the Claude Code hook payload
    ///    shape so existing ApmeCollector branches (recordStep,
    ///    allTodosCompleted, mergeEfficiencyJson) read the same keys.
    ///
    /// 2. **Start vs end routing.** OpenClaw's start-of-tool emit carries
    ///    `status="running"` plus an `input` payload — the adapter builds
    ///    that into a non-empty `detail` blob, so an `entry["detail"] != nil`
    ///    "has output" heuristic mis-routes every tool start as `tool_end`
    ///    (Codex stop-time review #5, 2026-05-16, surfaced in sqlite as
    ///    `tool · running` rows being marked `tool_end`). Strict rules:
    ///    - `status in {"complete","error","failed"}` → end (agent declared finish)
    ///    - non-nil `toolOutput` → end (real result captured)
    ///    - everything else (`status="running"/"pending"`, nil status, etc.) → start
    ///
    /// Static + nonisolated so unit tests can drive the function with any
    /// dict shape without instantiating the full daemon.
    static nonisolated func gatewayToolHookFromEntry(_ entry: [String: Any]) -> (event: String, data: [String: Any]) {
        let rawString = (entry["raw"] as? String) ?? ""
        let toolName: String = {
            if let explicit = entry["toolName"] as? String, !explicit.isEmpty { return explicit }
            // Fall back to splitting the legacy "{name} · {status}" shape.
            return rawString.components(separatedBy: " · ").first ?? rawString
        }()
        let status = entry["status"] as? String
        // Swift dicts that come from JSON wrap explicit nulls as `NSNull`,
        // so `dict["k"]` returns `Optional.some(NSNull())` — non-nil at the
        // Optional level. The fast `entry["toolOutput"] != nil` check used
        // to misread `"toolOutput": null` as "real output present" and
        // route a still-running tool as `tool_end` (Codex stop-time review
        // #6, 2026-05-16). Treat NSNull as absent here defensively even
        // though `OpenClawAdapter.firstJSONValue` already filters it on
        // the producer side — keeps the router robust to any future
        // emitter that forgets the same sanitization.
        let toolInput = Self.unwrapJSONValue(entry["toolInput"])
        let toolOutput = Self.unwrapJSONValue(entry["toolOutput"])

        var data: [String: Any] = [
            "session_id": "openclaw-gateway",
            "tool_name": toolName,
        ]
        if let toolInput { data["tool_input"] = toolInput }
        if let toolOutput { data["tool_response"] = toolOutput }
        if let status { data["status"] = status }

        let isEnd: Bool = {
            if status == "complete" || status == "error" || status == "failed" { return true }
            if toolOutput != nil { return true }
            return false
        }()
        return (event: isEnd ? "tool_end" : "tool_start", data: data)
    }

    /// Return the dictionary value only when it's a real Swift value —
    /// nil for both "key absent" and "key present with JSON `null`"
    /// (which arrives as `NSNull`). Used by `gatewayToolHookFromEntry`
    /// so a null `toolOutput` from a producer that forgot to filter NSNull
    /// doesn't trip the routing or leak into the APME payload.
    static nonisolated func unwrapJSONValue(_ value: Any?) -> Any? {
        guard let value else { return nil }
        if value is NSNull { return nil }
        return value
    }

    // MARK: - chat_start ts FIFO queues
    //
    // sessionId-keyed FIFO queue: append on each UserPromptSubmit, pop-first
    // on each Stop hook. Replaces the previous single-slot dict which let a
    // fast follow-up chat_start overwrite the anchor that the next Stop
    // hook should have stamped on the still-pending turn (Codex review #8).

    // Wrapper accessors for the two `ChatStartTsQueue` instances. Kept
    // as methods (not direct queue access) so the call sites read as
    // "enqueue/dequeue per session" rather than "mutate this struct in
    // place" — which is the historic naming the test target asserts on.
    func enqueueClaudeChatStartTs(sid: String, ts: Double) {
        claudeChatStartQueue.enqueue(sid: sid, ts: ts)
    }

    func dequeueClaudeChatStartTs(sid: String) -> Double? {
        claudeChatStartQueue.dequeue(sid: sid)
    }

    func clearClaudeChatStartQueue(sid: String) {
        claudeChatStartQueue.clear(sid: sid)
    }

    func claudeChatStartQueueDepth(sid: String) -> Int {
        claudeChatStartQueue.depth(sid: sid)
    }

    func enqueueCodexChatStartTs(sid: String, ts: Double) {
        codexChatStartQueue.enqueue(sid: sid, ts: ts)
    }

    /// **Latest** in-flight Codex chat_start ts (tail, not head). Used
    /// by mid-turn stamps like `tool_exec.startedAt` — the tool belongs
    /// to whatever turn is currently generating, which is the most
    /// recently enqueued one. Returning the head (oldest pending)
    /// caused follow-up turn events to attach to the previous turn's
    /// row (Codex stop-time review #10, 2026-05-17).
    private func peekLatestCodexChatStartTs(sid: String) -> Double? {
        codexChatStartQueue.peekTail(sid: sid)
    }

    /// **Latest** in-flight Claude Code chat_start ts. Same role as the
    /// Codex variant — used wherever a mid-turn row needs to anchor to
    /// the currently active turn, not the oldest pending one.
    private func peekLatestClaudeChatStartTs(sid: String) -> Double? {
        claudeChatStartQueue.peekTail(sid: sid)
    }

    func dequeueCodexChatStartTs(sid: String) -> Double? {
        codexChatStartQueue.dequeue(sid: sid)
    }

    func clearCodexChatStartQueue(sid: String) {
        codexChatStartQueue.clear(sid: sid)
    }

    func codexChatStartQueueDepth(sid: String) -> Int {
        codexChatStartQueue.depth(sid: sid)
    }

    private func sessionToDict(_ s: DaemonSessionEntry) -> [String: Any] {
        var d: [String: Any] = ["id": s.id, "port": s.port, "alive": true, "projectName": s.projectName]
        if let a = s.agentType { d["agentType"] = a }
        if let st = s.state { d["state"] = st }
        if let mn = s.modelName { d["modelName"] = mn }
        if let ef = s.effortLevel { d["effortLevel"] = ef }
        if let tool = s.currentTool { d["currentTool"] = tool }
        if let options = s.options {
            d["options"] = options.map { option in
                option.mapValues { $0.value }
            }
        }
        if let navigable = s.navigable, navigable { d["navigable"] = true }
        if let q = s.question { d["question"] = q }
        if let pt = s.promptType { d["promptType"] = pt }
        if let sa = s.startedAt {
            d["startedAt"] = sa
            // Per-session elapsed (seconds) for NTP-less devices (ESP32 D1 mosaic).
            if let elapsed = s.elapsedSec {
                d["elapsedSec"] = elapsed
            } else if let started = ISO8601DateFormatter().date(from: sa) {
                d["elapsedSec"] = max(0, Int(Date().timeIntervalSince(started)))
            }
        } else if let elapsed = s.elapsedSec {
            d["elapsedSec"] = elapsed
        }
        if let activity = sessionActivitySummary(s) { d["activity"] = activity }
        return d
    }

    /// Compact "what is this agent doing right now" one-liner — a single shared
    /// source so glance surfaces (XTeink X3 rows, device lists) all render the same
    /// text instead of each synthesizing its own. Awaiting sessions surface the
    /// pending question; working sessions surface the current tool. Returns nil
    /// when there's nothing meaningful to show (callers omit the line).
    /// Present-tense verb for a tool name so the heuristic reads naturally.
    private static func verbForm(_ tool: String) -> String {
        switch tool {
        case "Edit", "MultiEdit", "Write", "NotebookEdit": return "Editing"
        case "Read": return "Reading"
        case "Bash": return "Running"
        case "Grep", "WebSearch": return "Searching"
        case "Glob": return "Finding"
        case "Task": return "Delegating"
        case "WebFetch": return "Fetching"
        case "TodoWrite": return "Planning"
        default: return tool
        }
    }

    /// Synchronous heuristic floor for the activity line.
    private static func quickActivity(_ s: DaemonSessionEntry) -> String? {
        let state = s.state ?? ""
        if state.hasPrefix("awaiting"), let q = s.question, !q.isEmpty {
            return String(q.prefix(72))
        }
        if let tool = s.currentTool, !tool.isEmpty {
            return verbForm(tool)
        }
        return nil
    }

    /// Resolve the per-session activity one-liner: a cached Foundation Models
    /// summary when current, else the heuristic — kicking off an async FM
    /// labeling whose result surfaces on a later sessions_list broadcast.
    @MainActor
    private func sessionActivitySummary(_ s: DaemonSessionEntry) -> String? {
        let sig = "\(s.state ?? "")|\(s.currentTool ?? "")|\(s.question ?? "")"
        if let cached = sessionActivityCache[s.id], cached.sig == sig {
            return cached.summary
        }
        refreshSessionActivity(s, sig: sig)
        return Self.quickActivity(s)
    }

    /// Fire-and-forget FM labeling. Caches the result and re-broadcasts so the
    /// natural-language summary replaces the heuristic on the next paint.
    @MainActor
    private func refreshSessionActivity(_ s: DaemonSessionEntry, sig: String) {
        guard !sessionActivityInflight.contains(s.id) else { return }
        // Nothing meaningful to label yet → keep the heuristic, don't spin up FM.
        guard (s.currentTool?.isEmpty == false) || (s.state?.hasPrefix("awaiting") == true) else { return }
        sessionActivityInflight.insert(s.id)
        let context = [
            s.projectName.isEmpty ? nil : "Project: \(s.projectName)",
            s.agentType.map { "Agent: \($0)" },
            s.currentTool.map { "Current tool: \($0)" },
            (s.state?.hasPrefix("awaiting") == true) ? s.question.map { "Awaiting answer to: \($0)" } : nil,
        ].compactMap { $0 }.joined(separator: "\n")
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.sessionActivityInflight.remove(s.id) }
            let summary = await TimelineSummarizer.labelActivity(context)
            guard let summary, !summary.isEmpty else { return }
            self.sessionActivityCache[s.id] = (sig, summary)
            self.broadcastSessionsList()
        }
    }

    // MARK: - APME eval result handling

    /// Called on the main actor when ApmeRunner finishes an eval job.
    /// Persists turn-level outcome/composite and broadcasts an `apme_eval` WS
    /// event so the scorecard surfaces update. The timeline is an activity log
    /// only — eval results are no longer projected onto it (de-noise).
    @MainActor
    private func handleApmeResult(_ result: ApmeEvalJobResult) {
        guard let store = apmeStore else { return }

        // Task-level branch (task_rollup eval — TodoWrite all-completed /
        // /clear / session_end boundary). Writes composite on the tasks row
        // (already done in runTaskEval) and emits a timeline/WS surface so
        // dashboards show the completed-task summary.
        if let taskId = result.taskId {
            guard let run = store.getRun(id: result.runId),
                  store.getTask(id: taskId) != nil
            else { return }
            let taskEvals = store.listEvalsForTask(taskId)
            let overall = taskEvals.first(where: { $0.metric == "overall" })?.score
                ?? result.overall ?? 0

            broadcastApmeEval(
                run: run,
                evals: taskEvals,
                overallScore: overall,
                outcome: "committed",
                compositeScore: overall,
                layer1SkippedReason: result.layer1SkippedReason
            )
            return
        }

        // Turn-level branch
        if let turnId = result.turnId {
            guard let run = store.getRun(id: result.runId) else { return }
            let turnEvals = store.listEvalsForTurn(turnId)
            guard let overall = turnEvals.first(where: { $0.metric == "overall" }) else { return }

            // Persist turn outcome + composite so category scorecards aggregate.
            store.updateTurn(id: turnId, fields: [
                "outcome": "committed",
                "compositeScore": overall.score,
            ])

            // WS broadcast — turn eval
            broadcastApmeEval(
                run: run,
                evals: turnEvals,
                overallScore: overall.score,
                outcome: "committed",
                compositeScore: overall.score,
                layer1SkippedReason: result.layer1SkippedReason
            )
            return
        }

        // Run-level branch
        guard let run = store.getRun(id: result.runId) else { return }
        let evals = store.listEvalsForRun(result.runId)
        let overall = evals.first(where: { $0.layer == "llm_judge" && $0.metric == "overall" })?.score
            ?? result.overall

        broadcastApmeEval(
            run: run,
            evals: evals,
            overallScore: overall,
            outcome: run.outcome,
            compositeScore: run.compositeScore,
            layer1SkippedReason: result.layer1SkippedReason
        )
    }

    /// Build + broadcast an `apme_eval` WebSocket event. Matches the JSON
    /// shape of `ADApmeRunSummary` (codegen'd from shared protocol.ts) so
    /// every viewer target — Android, Stream Deck+, ESP32, iOS, TUI — decodes
    /// it with the same struct.
    @MainActor
    private func broadcastApmeEval(
        run: ApmeRun,
        evals: [ApmeEval],
        overallScore: Double?,
        outcome: String?,
        compositeScore: Double?,
        layer1SkippedReason: String? = nil
    ) {
        var runDict: [String: Any] = [
            "runId": run.id,
            "sessionId": run.sessionId,
            "agentType": run.agentType,
            "startedAt": run.startedAt,
            "evals": evals.map { e -> [String: Any] in
                var d: [String: Any] = [
                    "layer": e.layer,
                    "metric": e.metric,
                    "score": e.score,
                    "createdAt": e.createdAt,
                ]
                if let jm = e.judgeModel { d["judgeModel"] = jm }
                return d
            },
        ]
        if let v = run.modelId { runDict["modelId"] = v }
        if let v = run.projectName { runDict["projectName"] = v }
        if let v = run.taskPrompt { runDict["taskPrompt"] = v }
        if let v = run.taskCategory { runDict["taskCategory"] = v }
        if let v = outcome { runDict["outcome"] = v }
        if let v = compositeScore { runDict["compositeScore"] = v }
        if let v = overallScore { runDict["overallScore"] = v }
        if let v = run.endedAt { runDict["endedAt"] = v }
        if let v = run.inputTokens { runDict["inputTokens"] = v }
        if let v = run.outputTokens { runDict["outputTokens"] = v }
        if let v = run.costUsd { runDict["costUsd"] = v }
        if let v = run.exitCode { runDict["exitCode"] = v }
        if let v = layer1SkippedReason { runDict["layer1SkippedReason"] = v }

        let event: [String: Any] = [
            "type": "apme_eval",
            "run": runDict,
        ]
        broadcastRaw(event)
    }

    /// Resolve the projectName to stamp on a Codex timeline row. Falls back
    /// through the payload's cwd and the eviction-surviving per-thread cache
    /// so late rows (post-evict Stop hooks, rollout responses) keep their
    /// `[project]` attribution instead of degrading to the `[Codex CLI]`
    /// agent-tag fallback on every client.
    @MainActor
    private func codexTimelineProjectName(sessionId: String, json: [String: Any]) -> String? {
        if let p = Self.nonEmptyString(pushedSessionsById[sessionId]?.projectName),
           p != Self.codexAppFallbackProjectName {
            codexProjectNameBySession[sessionId] = p
            return p
        }
        if let p = Self.nonEmptyString(ProjectNameResolver.projectName(fromHookPayload: json)) {
            if codexProjectNameBySession.count > 1024 { codexProjectNameBySession.removeAll() }
            codexProjectNameBySession[sessionId] = p
            return p
        }
        return codexProjectNameBySession[sessionId]
            ?? Self.nonEmptyString(pushedSessionsById[sessionId]?.projectName)
    }

    /// Explicit new-turn signal for a Codex thread (`codex_session_start`,
    /// `codex_user_prompt_submit`, OTel `turnStart`). Clears the terminal
    /// record AND its tombstone (late progress from the *finished* turn can
    /// no longer reanimate the row), and promotes the thread to interactive
    /// when it re-engages after a terminal event — companion tasks are
    /// single-turn by construction, so a second turn on the same thread id
    /// is the interactive signature. Interactive threads skip the
    /// post-terminal fast evict and get `codexInteractiveIdleTTL`.
    @MainActor
    private func codexRegisterNewTurnSignal(sessionId: String) {
        if lastTerminalCodexEventBySession[sessionId] != nil
            || codexTerminalTombstoneBySession[sessionId] != nil,
           !codexInteractiveSessionIds.contains(sessionId) {
            codexInteractiveSessionIds.insert(sessionId)
            DaemonLogger.shared.debug("Hook", "Promoted codex session \(sessionId) to interactive (re-engaged after terminal event)")
        }
        lastTerminalCodexEventBySession.removeValue(forKey: sessionId)
        codexTerminalTombstoneBySession.removeValue(forKey: sessionId)
    }

    @MainActor
    private func appendCodexChatStart(json: [String: Any], sessionId: String?) {
        guard let sessionId else { return }
        let prompt = claudeCodePromptText(from: json)
        guard !prompt.isEmpty, prompt != "Codex turn started" else { return }
        // Every prompt-bearing chat_start event opens a fresh turn.
        // Codex's turnStarted span carries `raw == "Codex turn started"`
        // and is filtered by the guard above, so this function only ever
        // sees the prompt event itself — one per turn.
        //
        // The previous "peek queue head → upsert" branch overwrote Q1's
        // pending row with Q2's prompt whenever a follow-up arrived
        // before Q1's Stop hook drained the queue: `peek` always returns
        // the oldest pending ts, so the upsert mutated the wrong row
        // (Codex stop-time review #9, 2026-05-17). Dropped entirely;
        // each prompt enqueues a new ts and emits a new row, and the
        // FIFO `ChatStartTsQueue` keeps every in-flight turn's anchor
        // intact for its own Stop hook to claim.
        codexLastPromptTopicBySession.removeValue(forKey: sessionId)

        let ts = Date().timeIntervalSince1970 * 1000
        let raw = String(prompt.prefix(200))
        let detail = prompt.count > 100 ? String(prompt.prefix(1000)) : nil
        var entry = DaemonTimelineEntry(
            ts: ts,
            type: "chat_start",
            raw: raw,
            detail: detail,
            approvalId: nil,
            status: nil,
            agentType: "codex-cli",
            repeatCount: nil,
            automated: nil
        )
        entry.sessionId = sessionId
        entry.projectName = codexTimelineProjectName(sessionId: sessionId, json: json)
        entry.startedAt = ts
        enqueueCodexChatStartTs(sid: sessionId, ts: ts)
        if let topic = Self.extractTopicHint(from: prompt) {
            codexLastPromptTopicBySession[sessionId] = topic
        }
        Task { await timelineStore.add(entry) }
        broadcastRaw(["type": "timeline_event", "entry": claudeCodeEntryDict(entry)] as [String: Any])
    }

    @MainActor
    private func appendCodexToolEvent(json: [String: Any], sessionId: String?, completed: Bool) {
        guard let sessionId else { return }
        guard let tool = Self.usefulCodexToolName(json["tool_name"] as? String)
            ?? Self.usefulCodexToolName(json["tool"] as? String)
            ?? Self.usefulCodexToolName(codexCurrentToolBySession[sessionId]) else {
            if completed {
                codexCurrentToolBySession.removeValue(forKey: sessionId)
            }
            return
        }
        if completed {
            codexCurrentToolBySession.removeValue(forKey: sessionId)
        } else {
            codexCurrentToolBySession[sessionId] = tool
        }
        let toolInput = json["tool_input"] ?? json["input"] ?? json["arguments"] ?? json["args"]
        let inputSummary = Self.compactDebugValue(toolInput, max: 600)
        let status = completed ? "complete" : (json["status"] as? String)
        let rowSummary = Self.codexToolTimelineSummary(tool: tool, inputSummary: inputSummary, completed: completed)
        var detailParts: [String] = []
        if let status { detailParts.append("status: \(status)") }
        if let inputSummary, !inputSummary.isEmpty { detailParts.append(inputSummary) }
        var entry = DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: "tool_exec",
            raw: rowSummary,
            detail: detailParts.isEmpty ? nil : detailParts.joined(separator: "\n"),
            approvalId: nil,
            status: status,
            agentType: "codex-cli",
            repeatCount: nil,
            automated: nil
        )
        entry.sessionId = sessionId
        entry.projectName = codexTimelineProjectName(sessionId: sessionId, json: json)
        // tool_exec rows are intra-turn, so peek the **latest** pending
        // chat_start ts (tail). The Stop hook owns the dequeue (head).
        // Returning the head here would attach this tool to a previous
        // turn whose Stop hook hasn't fired yet.
        entry.startedAt = peekLatestCodexChatStartTs(sid: sessionId)
        Task { await timelineStore.add(entry) }
        broadcastRaw(["type": "timeline_event", "entry": claudeCodeEntryDict(entry)] as [String: Any])
    }

    @MainActor
    private func appendCodexChatEnd(json: [String: Any], sessionId: String?) {
        guard let sessionId else { return }
        let now = Date().timeIntervalSince1970 * 1000
        // Dequeue the active turn's ts up front so both chat_response
        // and chat_end stamp the same anchor and a delayed peer Stop
        // hook can't reach in mid-handler.
        let startTs = dequeueCodexChatStartTs(sid: sessionId)
        let assistantText = (json["last_assistant_message"] as? String)
            ?? (json["response"] as? String)
            ?? (json["output"] as? String)
            ?? (json["result"] as? String)
            ?? CodexRolloutResponseReader.lastAgentMessage(sessionId: sessionId)
            ?? ""
        guard startTs != nil || !assistantText.isEmpty else {
            // No matching turn AND no response body — nothing to anchor;
            // wipe only the session-scoped topic / tool to clear stale
            // labels. The queue head was already popped above.
            codexLastPromptTopicBySession.removeValue(forKey: sessionId)
            codexCurrentToolBySession.removeValue(forKey: sessionId)
            return
        }
        let projectName = codexTimelineProjectName(sessionId: sessionId, json: json)
        if !assistantText.isEmpty {
            var respEntry = DaemonTimelineEntry(
                ts: now - 1,
                type: "chat_response",
                raw: String(assistantText.prefix(200)),
                detail: assistantText.count > 100 ? String(assistantText.prefix(1000)) : nil,
                approvalId: nil,
                status: nil,
                agentType: "codex-cli",
                repeatCount: nil,
                automated: nil
            )
            respEntry.sessionId = sessionId
            respEntry.projectName = projectName
            respEntry.startedAt = startTs
            respEntry.endedAt = now
            // Same active task as the matching chat_start so a Q&A turn's
            // prompt + response group together instead of splitting.
            respEntry.taskId = apmeCollector?.activeTaskId
            Task { await timelineStore.add(respEntry) }
            broadcastRaw(["type": "timeline_event", "entry": claudeCodeEntryDict(respEntry)] as [String: Any])
        }

        let topicFromPrompt = codexLastPromptTopicBySession[sessionId]
        let providerRaw = AppPreferences.shared.timelineSummaryProvider
        let provider = TimelineSummarizer.SummaryProvider(rawValue: providerRaw) ?? .auto

        // Mirror appendClaudeCodeChatEnd: chat_end build + broadcast hops
        // into a Task so the LLM call doesn't block the Stop-hook handler.
        Task {
            let summary = assistantText.isEmpty
                ? nil
                : await TimelineSummarizer.summarize(assistantText, provider: provider)
            let topic = summary?.text ?? topicFromPrompt
            let durationSec = startTs.map { Int(((now - $0) / 1000).rounded()) }
            var parts = ["Completed"]
            if let durationSec { parts.append("\(durationSec)s") }
            if let topic { parts.append(topic) }
            var endEntry = DaemonTimelineEntry(
                ts: now,
                type: "chat_end",
                raw: parts.joined(separator: " · "),
                detail: assistantText.isEmpty ? nil : String(assistantText.prefix(1000)),
                approvalId: nil,
                status: nil,
                agentType: "codex-cli",
                repeatCount: nil,
                automated: nil
            )
            endEntry.sessionId = sessionId
            endEntry.projectName = projectName
            endEntry.startedAt = startTs
            endEntry.endedAt = now
            endEntry.summaryKind = summary?.kind ?? (topic == nil ? nil : "heuristic")
            await timelineStore.add(endEntry)
            broadcastRaw(["type": "timeline_event", "entry": claudeCodeEntryDict(endEntry)] as [String: Any])
        }

        // Cache cleanup synchronous on main actor — captured values above
        // are by-value so the in-flight Task is unaffected. The chat_start
        // ts queue was already popped at the top of this handler.
        codexLastPromptTopicBySession.removeValue(forKey: sessionId)
        codexCurrentToolBySession.removeValue(forKey: sessionId)
    }

    /// Append a `chat_start` timeline entry for a Claude Code UserPromptSubmit
    /// hook. Without this, Claude Code conversations appeared empty on the
    /// dashboard timeline while OpenClaw/OpenCode sessions showed full turns.
    @MainActor
    private func appendClaudeCodeChatStart(json: [String: Any], sessionId: String?, taskId: String? = nil) {
        // Reset the per-session topic cache so a stale label from an
        // abnormally-closed prior turn doesn't leak into this row. We do
        // NOT wipe the chat_start ts queue here — that would discard an
        // in-flight turn's anchor before its Stop hook arrives. The
        // chat_end handler pops the queue itself, and session_end /
        // stale-session paths call `clearClaudeChatStartQueue` explicitly.
        if let sid = sessionId {
            claudeLastPromptTopicBySession.removeValue(forKey: sid)
        }
        let prompt = claudeCodePromptText(from: json)
        guard !prompt.isEmpty else { return }
        let snippet = String(prompt.prefix(200))
        let detail: String? = prompt.count > 100
            ? String(prompt.prefix(1000))
            : nil
        let ts = Date().timeIntervalSince1970 * 1000
        var entry = DaemonTimelineEntry(
            ts: ts,
            type: "chat_start",
            raw: snippet,
            detail: detail,
            approvalId: nil,
            status: nil,
            agentType: "claude-code",
            repeatCount: nil,
            automated: nil
        )
        entry.sessionId = sessionId
        entry.projectName = pushedSessionsById[sessionId ?? ""]?.projectName
        entry.startedAt = ts
        // Nest this chat row under its task header (deferred `task_start`).
        // Consecutive prompts share one taskId, so they group instead of each
        // rendering as a separate task. Parity with the Node daemon's chat_start.
        entry.taskId = taskId
        if let sid = sessionId {
            // FIFO append — a delayed Stop hook for a prior turn pops
            // *that* turn's ts off the head, not this fresh one.
            enqueueClaudeChatStartTs(sid: sid, ts: ts)
            if let topic = Self.extractTopicHint(from: prompt) {
                claudeLastPromptTopicBySession[sid] = topic
            }
        }
        Task { await timelineStore.add(entry) }
        broadcastRaw([
            "type": "timeline_event",
            "entry": claudeCodeEntryDict(entry),
        ] as [String: Any])
    }

    /// Append a `chat_response` (when `last_assistant_message` arrived) + a
    /// terminating `chat_end` for a Claude Code Stop hook.
    @MainActor
    private func appendClaudeCodeChatEnd(json: [String: Any], sessionId: String?) {
        let assistantText = (json["last_assistant_message"] as? String) ?? ""
        let now = Date().timeIntervalSince1970 * 1000
        let projectName = pushedSessionsById[sessionId ?? ""]?.projectName
        // Pop the queue **once** at the top of the handler so both
        // chat_response and chat_end stamp the same anchor — and so a
        // delayed follow-up Stop hook for a previous turn can't reach in
        // and pull the active turn's ts out from under us mid-handler.
        // Captured by value into the async Task body below; the daemon's
        // queue is no longer mutated after this point in the current
        // turn's emit flow.
        let startTs: Double? = sessionId.flatMap { dequeueClaudeChatStartTs(sid: $0) }
        if !assistantText.isEmpty {
            let snippet = String(assistantText.prefix(200))
            let detail: String? = assistantText.count > 100
                ? String(assistantText.prefix(1000))
                : nil
            var respEntry = DaemonTimelineEntry(
                ts: now - 1,
                type: "chat_response",
                raw: snippet,
                detail: detail,
                approvalId: nil,
                status: nil,
                agentType: "claude-code",
                repeatCount: nil,
                automated: nil
            )
            respEntry.sessionId = sessionId
            respEntry.projectName = projectName
            respEntry.startedAt = startTs
            respEntry.endedAt = now
            // Tag the response with the same active task as its chat_start
            // (which carries `apmeCollector.activeTaskId`). Without this the
            // answer row had no taskId, so a Q&A turn's prompt and response
            // landed in different task buckets and rendered as separate tasks.
            respEntry.taskId = apmeCollector?.activeTaskId
            Task { await timelineStore.add(respEntry) }
            broadcastRaw([
                "type": "timeline_event",
                "entry": claudeCodeEntryDict(respEntry),
            ] as [String: Any])
        }
        // Only emit a chat_end turn-close row when there is NO chat_response to
        // act as the turn's completion row (a tool-only turn, or a Stop hook
        // with no last_assistant_message). When a chat_response was emitted
        // above it already marks the turn complete; the extra dimmed
        // "Completed · Ns · topic" row is redundant metadata that the dashboard
        // drops on render, and on the flat surfaces (Stream Deck plugin / TUI /
        // persisted timeline.json) it fragmented every Claude turn into three
        // rows. Keeping chat_start + chat_response matches the cleaner OpenClaw
        // turn shape and mirrors the Node bridge's emitCompletion.
        let topicFromPrompt = sessionId.flatMap { claudeLastPromptTopicBySession[$0] }

        // chat_end build + broadcast hops into a Task so it doesn't block the
        // Stop-hook handler. Reached only for response-less turns, so there is
        // no assistant text to summarize — the label is the prompt topic.
        if assistantText.isEmpty {
        Task {
            let topic = topicFromPrompt
            let durationSec: Int? = startTs.map { Int(((now - $0) / 1000).rounded()) }
            // "Completed · {duration}s · {prompt topic}" is the single
            // turn-close row for a response-less turn. High-entropy label
            // (duration + topic) keeps DaemonTimelineStore's 8 s exact-dedup
            // from collapsing two legitimate quick turns.
            var endRawParts: [String] = ["Completed"]
            if let d = durationSec { endRawParts.append("\(d)s") }
            if let t = topic { endRawParts.append(t) }
            let endRaw = endRawParts.joined(separator: " · ")
            var endEntry = DaemonTimelineEntry(
                ts: now,
                type: "chat_end",
                raw: endRaw,
                detail: topicFromPrompt.map { "Prompt: \($0)" },
                approvalId: nil,
                status: nil,
                agentType: "claude-code",
                repeatCount: nil,
                automated: nil
            )
            endEntry.sessionId = sessionId
            endEntry.projectName = projectName
            endEntry.startedAt = startTs
            endEntry.endedAt = now
            endEntry.summaryKind = topic == nil ? nil : "heuristic"
            await timelineStore.add(endEntry)
            broadcastRaw([
                "type": "timeline_event",
                "entry": claudeCodeEntryDict(endEntry),
            ] as [String: Any])
        }
        } // if assistantText.isEmpty

        // Cache cleanup runs synchronously so a follow-up turn that fires
        // before the Task above completes still gets a clean session state.
        // The Task captured `startTs` / `topicFromPrompt` by value, so
        // mutating the dict here doesn't affect the in-flight chat_end
        // entry. We don't touch the chat_start ts queue — `dequeueClaude
        // ChatStartTs` at the top already consumed exactly this turn's
        // slot, and wiping the whole queue would discard pending peers'
        // anchors (the race shape Codex #8 surfaced).
        if let sid = sessionId {
            claudeLastPromptTopicBySession.removeValue(forKey: sid)
        }
    }

    private static func codexToolTimelineSummary(tool: String, inputSummary: String?, completed: Bool) -> String {
        let suffix = completed ? " completed" : ""
        guard let inputSummary, !inputSummary.isEmpty else {
            return "\(tool)\(suffix)"
        }
        let compact = inputSummary
            .replacingOccurrences(of: #"^\{"command":"([^"]+)".*$"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"^\{"file_path":"([^"]+)".*$"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"^\{"path":"([^"]+)".*$"#, with: "$1", options: .regularExpression)
        let trimmed = compact.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "\(tool)\(suffix)" }
        let capped = trimmed.count > 120 ? String(trimmed.prefix(119)) + "…" : trimmed
        return "\(tool)\(suffix): \(capped)"
    }

    /// Pull the user's prompt from either Claude Code's legacy `prompt` field
    /// or the newer `message.content` shape. Mirrors the collector's parsing.
    private func claudeCodePromptText(from json: [String: Any]) -> String {
        if let s = json["prompt"] as? String, !s.isEmpty { return s }
        if let s = json["text"] as? String, !s.isEmpty { return s }
        if let message = json["message"] as? [String: Any],
           let content = message["content"] as? String {
            return content
        }
        return ""
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

    private static func doubleValue(_ value: Any?) -> Double? {
        if let n = value as? NSNumber { return n.doubleValue }
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        return nil
    }

    /// Extract a short, high-entropy topic label from a response or prompt.
    /// Swift port of `extractTopicHint` in
    /// `shared/src/timeline-summarizer.ts:18`. Used by
    /// `appendClaudeCodeChatEnd` to keep `chat_end` rows distinct in the
    /// dashboard timeline so quick turns with the same rounded duration are
    /// not collapsed by the timeline store's exact-raw dedup.
    private static func extractTopicHint(from text: String) -> String? {
        guard text.count >= 5 else { return nil }
        var inCodeFence = false
        var candidate: String? = nil
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if line.hasPrefix("```") {
                inCodeFence.toggle()
                continue
            }
            if inCodeFence { continue }

            // Heading-only (e.g. "##" with no text)
            if line.range(of: #"^#{1,6}\s*$"#, options: .regularExpression) != nil { continue }

            // Strip leading markdown decorators
            var stripped = line
            // Remove leading list bullets / blockquote markers
            stripped = stripped.replacingOccurrences(
                of: #"^[\-\*]\s+"#, with: "", options: .regularExpression
            )
            stripped = stripped.replacingOccurrences(
                of: #"^>\s+"#, with: "", options: .regularExpression
            )
            // Strip leading heading hashes
            stripped = stripped.replacingOccurrences(
                of: #"^#{1,6}\s+"#, with: "", options: .regularExpression
            )
            // Strip surrounding bold/italic markers
            stripped = stripped.replacingOccurrences(
                of: #"\*\*([^*]+)\*\*"#,
                with: "$1",
                options: .regularExpression
            )
            stripped = stripped.replacingOccurrences(
                of: #"`([^`]+)`"#,
                with: "$1",
                options: .regularExpression
            )
            stripped = stripped.trimmingCharacters(in: .whitespaces)
            if stripped.count >= 3 {
                candidate = stripped
                break
            }
        }
        guard var snippet = candidate else { return nil }
        if snippet.count > 80 {
            snippet = String(snippet.prefix(77)) + "..."
        }
        // Drop common Korean filler prefixes so the label carries information.
        snippet = snippet.replacingOccurrences(
            of: #"^네[,.]?\s*"#, with: "", options: .regularExpression
        )
        snippet = snippet.replacingOccurrences(
            of: #"^(완료했습니다\.\s*|알겠습니다\.\s*|확인했습니다\.\s*)"#,
            with: "",
            options: .regularExpression
        )
        snippet = snippet.trimmingCharacters(in: .whitespaces)
        return snippet.isEmpty ? nil : snippet
    }

    /// Encode a DaemonTimelineEntry into the dict shape broadcastRaw expects —
    /// matches the key set `appendGatewayTimelineEntry` uses for round-trip.
    private func claudeCodeEntryDict(_ e: DaemonTimelineEntry) -> [String: Any] {
        Self.daemonTimelineEntryDict(e)
    }

    static func buildTimelineHistoryEventForTest(from entries: [DaemonTimelineEntry]) -> [String: Any] {
        [
            "type": "timeline_history",
            "entries": entries.map { daemonTimelineEntryDict($0) },
        ]
    }

    private static func daemonTimelineEntryDict(_ e: DaemonTimelineEntry) -> [String: Any] {
        var dict: [String: Any] = [
            "ts": e.ts,
            "type": e.type,
            "raw": e.raw,
        ]
        if let v = e.detail { dict["detail"] = v }
        if let v = e.approvalId { dict["approvalId"] = v }
        if let v = e.status { dict["status"] = v }
        if let v = e.agentType { dict["agentType"] = v }
        if let v = e.repeatCount { dict["repeatCount"] = v }
        if let v = e.automated { dict["automated"] = v }
        if let v = e.sessionId { dict["sessionId"] = v }
        if let v = e.projectName { dict["projectName"] = v }
        if let v = e.startedAt { dict["startedAt"] = v }
        if let v = e.endedAt { dict["endedAt"] = v }
        if let v = e.runId { dict["runId"] = v }
        // Without this, the daemon writes summaryKind into timeline.json
        // (Codable round-trip) but dashboards see nil over the live WS feed —
        // their own UI checks against summaryKind ("none" suppression, future
        // backend pill) silently no-op.
        if let v = e.summaryKind { dict["summaryKind"] = v }
        // Task hierarchy keys — `timelineIsInFlightTask` in the dashboard
        // pairs task_start ↔ task_end on `taskId`. Drop them from the live
        // broadcast and the pair lookup fails (UI guard returns false on
        // nil) so the leading task icon keeps spinning after /clear.
        if let v = e.taskId { dict["taskId"] = v }
        if let v = e.boundarySignal { dict["boundarySignal"] = v }
        // Task-judge verdict, attached on the SECOND `task_end` emit (5–30 s
        // after the boundary). Without these on the broadcast dict, the
        // dashboard task header never gets a score badge even though the
        // judge wrote the row to disk. Mirrors the four task* fields on
        // shared/src/timeline.ts::TimelineEntry.
        if let v = e.taskScore { dict["taskScore"] = v }
        if let v = e.taskOutcome { dict["taskOutcome"] = v }
        if let v = e.taskCategory { dict["taskCategory"] = v }
        if let v = e.taskSummary { dict["taskSummary"] = v }
        return dict
    }

    /// Pure-function core of the orphan reaper: scan a snapshot of timeline
    /// entries and return the synthetic `task_end` rows that need to be
    /// upserted to close every `task_start` lacking a matching pair. Side-
    /// effect-free so tests can drive it without standing up an actor or
    /// the disk path; the live wrapper `reapOrphanTaskStarts()` calls
    /// this, then applies each result via `timelineStore.upsert` +
    /// `broadcastRaw`.
    static func computeOrphanTaskEnds(from snapshot: [DaemonTimelineEntry]) -> [DaemonTimelineEntry] {
        var closedTaskIds = Set<String>()
        for e in snapshot where e.type == "task_end" {
            if let id = e.taskId, !id.isEmpty { closedTaskIds.insert(id) }
        }
        var result: [DaemonTimelineEntry] = []
        for start in snapshot where start.type == "task_start" {
            guard let taskId = start.taskId, !taskId.isEmpty else { continue }
            if closedTaskIds.contains(taskId) { continue }
            let startedAtMs = start.startedAt ?? start.ts
            // ts: nudge 1ms past the task_start so the synthetic end
            // sorts immediately after the orphaned start in chronological
            // views. endedAt: leave nil — duration is genuinely unknown
            // (daemon died between start and end), and the UI renders
            // "Interrupted · –" for that case rather than guessing.
            result.append(DaemonTimelineEntry(
                ts: startedAtMs + 1,
                type: "task_end",
                raw: "Interrupted · –",
                agentType: start.agentType,
                projectName: start.projectName,
                sessionId: start.sessionId,
                startedAt: startedAtMs,
                endedAt: nil,
                runId: start.runId,
                taskId: taskId,
                boundarySignal: "interrupted"
            ))
            // Track so a second orphaned `task_start` with the same taskId
            // (which would be a producer bug, not a normal state) doesn't
            // produce two synthetics for one logical task.
            closedTaskIds.insert(taskId)
        }
        return result
    }

    /// Walk the persisted timeline and synthesize a `task_end` for every
    /// `task_start` whose pair was never written. Called once at startup,
    /// after `timelineStore.start()` has loaded entries from disk.
    ///
    /// The producer guarantees `task_start`/`task_end` pair emission within
    /// a single daemon lifetime via `ApmeCollector.closeTask` +
    /// `timelineEmitted` flag, but that flag is in-memory. If the daemon
    /// is killed mid-task, the next process boots with task_start rows
    /// on disk and no `activeTask` to close. The UI guard
    /// `timelineIsInFlightTask` (TimelineStripView.swift) treats those
    /// as in-flight and spins their leading icon forever — exactly the
    /// "/session-end 했는데 진행중처럼 나옴" report. This reaper closes
    /// the loop on the daemon side so the deception is bounded to a
    /// single startup, not a permanent UI lie.
    ///
    /// Idempotent: the upsert path matches by (type="task_end", taskId),
    /// so re-running the reaper on the next startup finds the synthetic
    /// task_end already there and is a no-op.
    @MainActor
    private func reapOrphanTaskStarts() async {
        let snapshot = await timelineStore.getAll()
        let synthetics = Self.computeOrphanTaskEnds(from: snapshot)
        for synthetic in synthetics {
            await timelineStore.upsert(synthetic)
            broadcastRaw([
                "type": "timeline_event",
                "entry": claudeCodeEntryDict(synthetic),
                "upsert": true,
            ] as [String: Any])
        }
        if !synthetics.isEmpty {
            DaemonLogger.shared.info("Timeline reaper: synthesized \(synthetics.count) task_end row(s) for orphaned task_start entries")
        }
    }

    @MainActor
    private func appendGatewayTimelineEntry(_ rawEntry: [String: Any]) {
        var entry = DaemonTimelineEntry(
            ts: (rawEntry["ts"] as? NSNumber)?.doubleValue ?? rawEntry["ts"] as? Double ?? Date().timeIntervalSince1970 * 1000,
            type: rawEntry["type"] as? String ?? "event",
            raw: rawEntry["raw"] as? String ?? "",
            detail: rawEntry["detail"] as? String,
            approvalId: rawEntry["approvalId"] as? String,
            status: rawEntry["status"] as? String,
            agentType: rawEntry["agentType"] as? String ?? "openclaw",
            repeatCount: rawEntry["repeatCount"] as? Int,
            automated: rawEntry["automated"] as? Bool
        )
        entry.runId = rawEntry["runId"] as? String
        entry.projectName = rawEntry["projectName"] as? String
        entry.sessionId = rawEntry["sessionId"] as? String
        entry.startedAt = (rawEntry["startedAt"] as? NSNumber)?.doubleValue ?? rawEntry["startedAt"] as? Double
        entry.endedAt = (rawEntry["endedAt"] as? NSNumber)?.doubleValue ?? rawEntry["endedAt"] as? Double
        entry.summaryKind = rawEntry["summaryKind"] as? String
        entry.taskId = rawEntry["taskId"] as? String
        entry.boundarySignal = rawEntry["boundarySignal"] as? String
        // Task-judge verdict fields — mirror the four task* keys on the
        // encode side (`claudeCodeEntryDict`). Without these, Gateway-origin
        // task_end rows with score data would silently drop their badge
        // metadata on the way into the store.
        entry.taskScore = (rawEntry["taskScore"] as? NSNumber)?.doubleValue ?? rawEntry["taskScore"] as? Double
        entry.taskOutcome = rawEntry["taskOutcome"] as? String
        entry.taskCategory = rawEntry["taskCategory"] as? String
        entry.taskSummary = rawEntry["taskSummary"] as? String
        // Gateway-origin task_end rows may arrive twice (initial boundary +
        // judge follow-up). Route through `upsert` so the score-bearing
        // follow-up merges with the existing row by (type, taskId) instead
        // of stacking a duplicate. Non-task entries fall through to `add`
        // because their stable key is (ts, type).
        if entry.type == "task_end", entry.taskId != nil {
            Task { await timelineStore.upsert(entry) }
        } else {
            // Gateway entries originate from the Node side (already projected /
            // external) — bypass the Phase 6 suppression so they're never
            // dropped when projection mode is on.
            Task { await timelineStore.add(entry, bypassSuppression: true) }
        }
        broadcastRaw(["type": "timeline_event", "entry": rawEntry] as [String: Any])
    }

    // MARK: - APME eval tick (30s loop)

    /// Runs once every 30s. Mirrors bridge/src/daemon-server.ts:951-990.
    @MainActor
    private func apmeEvalTick() async {
        guard let store = apmeStore, let runner = apmeRunner else { return }

        // 1. Enqueue unevaluated runs (run-level layer-2 judge).
        let pending = store.listUnevaluatedRuns(limit: 5)
        for p in pending {
            runner.enqueue(runId: p.id)
        }

        // 2. Outcome detection on closed runs that don't have an outcome yet.
        //    Wait at least 10s after close so A/B + iteration windows resolve.
        let closedRuns = store.listRuns(limit: 20)
        let now = Int(Date().timeIntervalSince1970 * 1000)
        for r in closedRuns {
            guard let ended = r.endedAt, r.outcome == nil else { continue }
            if now - ended > 10_000 {
                if let eval = ApmeOutcomeEngine.evaluateOutcome(store: store, runId: r.id) {
                    await propagateOutcomeToTimeline(run: r, eval: eval)
                }
            }
        }

        // 3. Re-classify runs the session bridge didn't finish classifying.
        //    Phase 2: uses classifyRunSmart — rules first, LLM fallback when
        //    rules return .unknown. Default backend is on-device Foundation
        //    Models so the LLM path is free and cost-safe.
        let unclassified = store.listUnclassifiedRuns(limit: 5)
        for r in unclassified {
            let result = await ApmeClassifier.classifyRunSmart(store: store, runId: r.id)
            if result.category != .unknown {
                if let data = try? JSONEncoder().encode(result.signals),
                   let json = String(data: data, encoding: .utf8) {
                    store.updateRun(id: r.id, fields: [
                        "taskSignals": json,
                        "taskCategory": result.category.rawValue,
                        "taskCategorySource": result.source,
                    ])
                }
            }
        }

        // 4. Backfill turn outcome for code-category turns that never went
        //    through turn_judge. Keeps v_category_scorecard populated even
        //    when no judge ran on the turn.
        let needOutcome = store.listTurnsNeedingOutcome(limit: 20)
        for t in needOutcome {
            let evs = store.listEvalsForTurn(t.id)
            let overall = evs.first(where: { $0.layer == "turn_judge" && $0.metric == "overall" })
            var fields: [String: Any?] = ["outcome": "committed"]
            if let o = overall { fields["compositeScore"] = o.score }
            store.updateTurn(id: t.id, fields: fields)
        }

        // 5. Clean up orphaned runs — started long ago, never closed.
        let orphans = store.listOrphanedRuns(staleSec: 1800)
        for id in orphans {
            store.updateRun(id: id, fields: [
                "endedAt": now,
                "taskCategory": "_empty",
            ])
        }
    }

    /// Propagates APME outcome evaluation results directly to the task_end timeline row.
    /// Ensures real-time UI badge ("...") update synchronization right after SQLite commits.
    @MainActor
    private func propagateOutcomeToTimeline(
        run: ApmeRun,
        eval: (
            outcome: ApmeOutcomeResult,
            efficiency: ApmeEfficiencyMetrics,
            composite: ApmeCompositeBreakdown
        )
    ) async {
        let snapshot = await timelineStore.getAll()
        // Seek the matching task_end row by taskId, runId or session-ended match
        if let existingIndex = snapshot.firstIndex(where: { e in
            e.type == "task_end" && (e.taskId == run.id || e.runId == run.id || (e.sessionId == run.sessionId && abs(e.ts - Double(run.endedAt ?? 0)) < 5000))
        }) {
            var updated = snapshot[existingIndex]
            updated.taskScore = eval.composite.composite
            updated.taskOutcome = eval.outcome.outcome.rawValue
            updated.taskCategory = run.taskCategory
            updated.taskSummary = eval.outcome.reason

            await timelineStore.upsert(updated)
            broadcastRaw([
                "type": "timeline_event",
                "entry": claudeCodeEntryDict(updated),
                "upsert": true
            ] as [String: Any])
            DaemonLogger.shared.debug("APME", "Propagated outcome to timeline row for run \(run.id.prefix(8)): score=\(eval.composite.composite)")
        }
    }
}

// MARK: - chat_start ts FIFO queue (per-session)
//
// Pulled out of `DaemonServer` so the queue mechanics can be unit-tested
// in isolation. The bug shape Codex stop-time review #8 surfaced is a
// pure data-structure concern (per-session FIFO vs single slot) — gating
// its correctness on the full daemon constructor would have made the
// regression test prohibitively heavy.

struct ChatStartTsQueue: Equatable, Sendable {
    private struct QueueEntry: Equatable, Sendable {
        let ts: Double
        let wallClock: Double
    }

    private var queues: [String: [QueueEntry]] = [:]

    mutating func enqueue(sid: String, ts: Double) {
        let entry = QueueEntry(ts: ts, wallClock: Date().timeIntervalSince1970 * 1000)
        queues[sid, default: []].append(entry)
    }

    /// Pop the *oldest* pending ts for `sid`. nil if the queue is empty.
    /// Safely filters out stale/orphaned entries based on real-world elapsed time (10 minutes).
    mutating func dequeue(sid: String) -> Double? {
        guard var queue = queues[sid], !queue.isEmpty else { return nil }
        let now = Date().timeIntervalSince1970 * 1000
        let ttlMs: Double = 600_000 // 10 minutes

        while !queue.isEmpty {
            let entry = queue.removeFirst()
            if now - entry.wallClock < ttlMs {
                if queue.isEmpty {
                    queues.removeValue(forKey: sid)
                } else {
                    queues[sid] = queue
                }
                return entry.ts
            }
        }
        queues.removeValue(forKey: sid)
        return nil
    }

    /// Look at the head (oldest pending) without consuming.
    /// Enforces the same 10-minute safety TTL.
    func peek(sid: String) -> Double? {
        guard let entry = queues[sid]?.first else { return nil }
        let now = Date().timeIntervalSince1970 * 1000
        let ttlMs: Double = 600_000
        return (now - entry.wallClock < ttlMs) ? entry.ts : nil
    }

    /// Look at the tail (most-recently enqueued) without consuming.
    /// Enforces the same 10-minute safety TTL.
    func peekTail(sid: String) -> Double? {
        guard let entry = queues[sid]?.last else { return nil }
        let now = Date().timeIntervalSince1970 * 1000
        let ttlMs: Double = 600_000
        return (now - entry.wallClock < ttlMs) ? entry.ts : nil
    }

    mutating func clear(sid: String) {
        queues.removeValue(forKey: sid)
    }

    func depth(sid: String) -> Int {
        queues[sid]?.count ?? 0
    }
}

// MARK: - Errors

enum DaemonError: Error {
    case alreadyRunning(port: Int)
    case noPortAvailable
}

struct SendableDict: @unchecked Sendable {
    let value: [String: Any]
    init(_ value: [String: Any]) { self.value = value }
}

extension [String: Any] {
    var jsonData: Data? {
        try? JSONSerialization.data(withJSONObject: self)
    }
}

// MARK: - PNG helpers

private extension Data {
    mutating func appendBE32(_ value: UInt32) {
        append(UInt8((value >> 24) & 0xFF))
        append(UInt8((value >> 16) & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8(value & 0xFF))
    }

    mutating func appendPNGChunk(type: [UInt8], data: Data) {
        appendBE32(UInt32(data.count))
        append(contentsOf: type)
        append(data)
        // CRC32 over type + data
        var crcData = Data(type)
        crcData.append(data)
        appendBE32(crc32(crcData))
    }
}

private func crc32(_ data: Data) -> UInt32 {
    var crc: UInt32 = 0xFFFFFFFF
    data.withUnsafeBytes { buffer in
        guard let bytes = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
        for i in 0..<data.count {
            let idx = Int((crc ^ UInt32(bytes[i])) & 0xFF)
            crc = crc32Table[idx] ^ (crc >> 8)
        }
    }
    return crc ^ 0xFFFFFFFF
}

private let crc32Table: [UInt32] = {
    var table = [UInt32](repeating: 0, count: 256)
    for i in 0..<256 {
        var c = UInt32(i)
        for _ in 0..<8 {
            if c & 1 != 0 {
                c = 0xEDB88320 ^ (c >> 1)
            } else {
                c = c >> 1
            }
        }
        table[i] = c
    }
    return table
}()
#endif
