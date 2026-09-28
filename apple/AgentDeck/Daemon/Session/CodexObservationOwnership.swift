#if os(macOS)
import Foundation

/// Lifecycle hooks own a thread once seen. OTel spans may be exported only
/// after Stop, so their arrival order cannot establish a new hook-owned turn.
/// Notify-only installations still need OTel to observe work between replies.
struct CodexObservationOwnership {
    private var lastHookAt: [String: Date] = [:]

    mutating func receiveHook(event: String, sessionId: String, now: Date) {
        switch event {
        case "codex_session_start", "codex_user_prompt_submit",
             "codex_tool_start", "codex_tool_end", "codex_permission_request",
             "codex_stop", "codex_interrupt":
            lastHookAt[sessionId] = now
        default:
            break
        }
    }

    /// Applied to the parsed batch before any roster, turn-anchor, global
    /// state or freshness mutation. Rejected spans do not renew ownership.
    func admittingOtel(_ events: [CodexSpanEvent]) -> [CodexSpanEvent] {
        events.filter { event in
            let threadId: String
            switch event {
            case .turnStart(let id, _, _), .toolCall(let id, _, _, _),
                 .toolResult(let id, _), .turnEnd(let id, _), .activity(let id, _, _, _):
                threadId = id
            }
            return lastHookAt["codex:\(threadId)"] == nil
        }
    }

    /// Use the daemon's existing terminal-tombstone window, keeping ownership
    /// while a row or terminal record still exists. This also bounds hooks
    /// (e.g. a lone Stop) that never created a visible row.
    mutating func prune(before cutoff: Date, retaining sessionIds: Set<String>) {
        lastHookAt = lastHookAt.filter { sessionIds.contains($0.key) || $0.value >= cutoff }
    }
}
#endif
