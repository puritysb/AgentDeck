// SessionFocusRelay.swift — Subscribe to a focused session bridge's WS,
// relay its state events to daemon clients and route commands to it.
// Ported from bridge/src/session-focus-relay.ts

import Foundation

#if os(macOS)
/// Events relayed from focused session to daemon clients
private let relayedEvents: Set<String> = [
    "state_update", "prompt_options", "usage_update"
]

/// Commands routed from daemon clients to focused session
private let routedCommands: Set<String> = [
    "respond", "interrupt", "escape", "select_option",
    "send_prompt", "navigate_option", "switch_mode"
]

/// Relay for interacting with a specific focused session via daemon.
/// Only one session can be focused at a time.
actor SessionFocusRelay {
    private var wsTask: URLSessionWebSocketTask?
    private(set) var focusedSessionId: String?
    private var focusedPort: Int?
    private var focusedLocalOnly = false
    private var broadcast: ((@Sendable (SendableDict) -> Void))?
    private var onUsageRelayed: ((@Sendable (SendableDict) -> Void))?

    init() {}

    func setBroadcast(_ handler: @escaping @Sendable (SendableDict) -> Void) {
        self.broadcast = handler
    }

    /// Called when a usage_update is received from the focused session,
    /// BEFORE it is broadcast to clients. Allows daemon to sync its cache.
    func setOnUsageRelayed(_ handler: @escaping @Sendable (SendableDict) -> Void) {
        self.onUsageRelayed = handler
    }

    /// Focus a session by ID. Disconnects from previous session.
    func focus(sessionId: String) {
        // Already focused
        if focusedSessionId == sessionId, !focusedLocalOnly, wsTask?.state == .running {
            DaemonLogger.shared.debug("FocusRelay", "Already focused on \(sessionId)")
            return
        }

        unfocus()

        let sessions = SessionRegistry.shared.listActive()
        guard let session = sessions.first(where: { $0.id == sessionId && $0.agentType != "daemon" }) else {
            DaemonLogger.shared.debug("FocusRelay", "Session \(sessionId) not found")
            return
        }

        focusedSessionId = sessionId
        focusedPort = session.port
        focusedLocalOnly = false
        DaemonLogger.shared.info("FocusRelay: Focusing \(session.projectName):\(session.port)")
        connect()
    }

    /// Select a daemon-local observed session. Hook/OTel-only sessions have no
    /// child bridge WebSocket to connect to, but UI surfaces still need a
    /// stable focused id so session cycling and detail panes don't try to
    /// relay through a nonexistent registry entry.
    func focusLocal(sessionId: String) {
        if focusedSessionId == sessionId, focusedLocalOnly {
            DaemonLogger.shared.debug("FocusRelay", "Already selected local session \(sessionId)")
            return
        }

        unfocus()
        focusedSessionId = sessionId
        focusedPort = nil
        focusedLocalOnly = true
        DaemonLogger.shared.debug("FocusRelay", "Selected local observed session \(sessionId)")
    }

    /// Unfocus current session.
    func unfocus() {
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        if let id = focusedSessionId {
            DaemonLogger.shared.debug("FocusRelay", "Unfocused \(id)")
        }
        focusedSessionId = nil
        focusedPort = nil
        focusedLocalOnly = false
    }

    /// Route a command to the focused session. Returns true if handled.
    func routeCommand(_ cmd: [String: Any]) -> Bool {
        guard let type = cmd["type"] as? String,
              routedCommands.contains(type),
              focusedSessionId != nil else {
            return false
        }

        if focusedLocalOnly {
            DaemonLogger.shared.debug("FocusRelay", "Ignoring \(type) for local observed session \(focusedSessionId ?? "?")")
            return true
        }

        guard let task = wsTask, task.state == .running else { return false }

        DaemonLogger.shared.debug("FocusRelay", "Routing \(type) → session \(focusedSessionId ?? "?")")
        if let data = try? JSONSerialization.data(withJSONObject: cmd),
           let text = String(data: data, encoding: .utf8) {
            task.send(.string(text)) { error in
                if let error {
                    DaemonLogger.shared.debug("FocusRelay", "Send error: \(error)")
                }
            }
        }
        return true
    }

    /// Route a command that names its session, and only to that session (#632).
    /// `routeCommand` reads the focus at send time, so a session-addressed
    /// command deferred past a focus change went to the newly focused session.
    /// Refuse instead when the focus has moved off `sessionId`.
    func routeCommand(_ cmd: [String: Any], to sessionId: String) -> Bool {
        guard focusedSessionId == sessionId else {
            DaemonLogger.shared.debug(
                "FocusRelay",
                "Not routing \(cmd["type"] as? String ?? "?") → \(sessionId): focus moved to \(focusedSessionId ?? "none")")
            return false
        }
        return routeCommand(cmd)
    }

    /// Stop relay entirely.
    func stop() {
        unfocus()
    }

    // MARK: - Private

    private func connect() {
        guard let port = focusedPort else { return }

        guard let url = URL(string: "ws://127.0.0.1:\(port)") else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        wsTask = task
        task.resume()
        let capturedSessionId = focusedSessionId
        receiveLoop(task: task, sessionId: capturedSessionId)
        DaemonLogger.shared.debug("FocusRelay", "Connected to port \(port)")
    }

    private func receiveLoop(task: URLSessionWebSocketTask, sessionId: String?) {
        task.receive { [weak self] result in
            Task {
                guard let self else { return }

                // Only relay if still focused on the same session
                let currentId = await self.focusedSessionId
                guard currentId == sessionId else { return }

                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        if let data = text.data(using: .utf8),
                           var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                           let type = json["type"] as? String,
                           relayedEvents.contains(type) {
                            DaemonLogger.shared.debug("FocusRelay", "Relay \(type)")
                            if type == "prompt_options", let sessionId {
                                json["sessionId"] = sessionId
                                json["focusedSessionId"] = sessionId
                            }
                            // Sync daemon cache before broadcasting to avoid oscillation
                            if type == "usage_update" {
                                await self.onUsageRelayed?(SendableDict(json))
                            }
                            await self.broadcast?(SendableDict(json))
                        }
                    default:
                        break
                    }
                    await self.receiveLoop(task: task, sessionId: sessionId)
                case .failure:
                    DaemonLogger.shared.debug("FocusRelay", "Session WS closed")
                    // Don't auto-reconnect — session may have ended
                }
            }
        }
    }
}
#else
/// Sendable wrapper for non-macOS stub
struct SendableDict: @unchecked Sendable {
    let value: [String: Any]
    init(_ value: [String: Any]) { self.value = value }
}

/// No-op stub for non-macOS targets so shared source references remain buildable.
actor SessionFocusRelay {
    private(set) var focusedSessionId: String?

    init() {}

    func setBroadcast(_ handler: @escaping @Sendable (SendableDict) -> Void) {}
    func setOnUsageRelayed(_ handler: @escaping @Sendable (SendableDict) -> Void) {}

    func focus(sessionId: String) {
        focusedSessionId = sessionId
    }

    func focusLocal(sessionId: String) {
        focusedSessionId = sessionId
    }

    func unfocus() {
        focusedSessionId = nil
    }

    func routeCommand(_ cmd: [String: Any]) -> Bool {
        false
    }

    func routeCommand(_ cmd: [String: Any], to sessionId: String) -> Bool {
        false
    }

    func stop() {}
}
#endif
