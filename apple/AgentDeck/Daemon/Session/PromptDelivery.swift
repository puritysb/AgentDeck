import Foundation

/// What happens to a prompt (a deck dictation, a typed deck prompt) sent to a
/// session through `session_command` — the route `DaemonServer.handleCommand`
/// takes for it, stated so the log can say where the prompt went.
///
/// The Node daemon logs `delivered=… via … (reason)` for every dictated prompt.
/// This daemon logged only the command name, so a prompt that went nowhere left
/// no trace at all (#541: an observed session it has no prompt path for looked
/// exactly like one that received it). Kept pure so the classification is
/// testable without a running server; the predicates mirror the routing order
/// in `handleCommand`, and a new route there needs a case here.
enum PromptDelivery: Equatable, Sendable {
    /// Observed Claude Code: queued and handed over by the session's Stop hook
    /// when its current turn ends. An idle session receives it only after its
    /// next turn — there is no terminal this app may type into.
    case turnEndQueue
    /// Observed OpenCode: queued for the AgentDeck observer plugin to submit.
    case openCodeQueue
    /// The OpenClaw Gateway row: `chat.send` on the connected Gateway.
    case gateway
    /// The OpenClaw Gateway row while no Gateway is connected.
    case gatewayUnavailable
    /// A managed session bridge, reached over the focus relay.
    case sessionBridge
    /// An observed session of an agent this app has no prompt path for.
    case noPath(agent: String)
    /// No session with that id is known.
    case sessionNotFound

    static let gatewaySessionId = "openclaw-gateway"

    static func classify(
        sessionId: String,
        controlMode: String?,
        agentType: String?,
        knownSession: Bool,
        gatewayConnected: Bool
    ) -> PromptDelivery {
        if sessionId == gatewaySessionId {
            return gatewayConnected ? .gateway : .gatewayUnavailable
        }
        if controlMode == "observed" {
            switch agentType {
            case "claude-code": return .turnEndQueue
            case "opencode": return .openCodeQueue
            default: return .noPath(agent: agentType ?? "unknown")
            }
        }
        return knownSession ? .sessionBridge : .sessionNotFound
    }

    /// `true`, `false`, or `queued` — the same field the Node daemon logs.
    var delivered: String {
        switch self {
        case .turnEndQueue, .openCodeQueue: return "queued"
        case .gateway, .sessionBridge: return "true"
        case .gatewayUnavailable, .noPath, .sessionNotFound: return "false"
        }
    }

    var via: String? {
        switch self {
        case .turnEndQueue: return "turn-end directive"
        case .openCodeQueue: return "opencode observer queue"
        case .gateway: return "gateway"
        case .sessionBridge: return "session bridge"
        case .gatewayUnavailable, .noPath, .sessionNotFound: return nil
        }
    }

    var reason: String? {
        switch self {
        case .turnEndQueue: return "delivered when the session's current turn ends"
        case .gatewayUnavailable: return "gateway_unavailable"
        case .noPath(let agent): return "no prompt path for an observed \(agent) session in this app"
        case .sessionNotFound: return "session not found"
        case .openCodeQueue, .gateway, .sessionBridge: return nil
        }
    }

    /// One log line in the Node daemon's shape:
    /// `<label>: "<first 40 chars>" -> <session> delivered=<…> via <…> (<reason>)`.
    func logLine(label: String, text: String, sessionId: String) -> String {
        var line = "\(label): \"\(text.prefix(40))\" -> \(sessionId.prefix(32)) delivered=\(delivered)"
        if let via { line += " via \(via)" }
        if let reason { line += " (\(reason))" }
        return line
    }
}
