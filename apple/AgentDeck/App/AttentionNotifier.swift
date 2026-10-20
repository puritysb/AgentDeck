// AttentionNotifier.swift — System notification for sessions awaiting an
// explicit user response.
//
// Posts a local UNUserNotification when a session enters an awaiting state
// with a question (Claude's permission prompt via the display-only
// Notification overlay, a PTY-parsed prompt, or OpenCode permission.requested)
// and clears it the moment the session stops waiting — so Notification Center
// never accumulates stale "needs your response" entries.
//
// Lives in the app layer (fed from AgentStateHolder's sessions_list handler),
// NOT in DaemonServer: that way it works identically in both tiers — Tier 1
// where the in-process Swift daemon produces the sessions_list, and Tier 2
// where the app is a WS client of the external Node daemon.
//
// Authorization rides the existing NotificationPermission first-launch flow;
// if the user never granted it, `add` silently no-ops (by design — no extra
// gating here).

#if os(macOS)
import Foundation
import UserNotifications

@MainActor
enum AttentionNotifier {
    nonisolated static let referenceKey = "agentdeck.attentionSession"
    /// Endpoint-scoped session reference → question we last notified for. Repeated sessions_list
    /// frames with the same awaiting state must not re-fire the banner.
    private static var notified: [String: String] = [:]

    /// Diff the latest sessions_list against what we've notified:
    /// newly-awaiting sessions post, no-longer-awaiting (or vanished)
    /// sessions clear.
    static func sync(snapshot: AttentionSessionSnapshot) {
        var stillAwaiting: Set<String> = []

        for session in snapshot.sessions {
            guard session.alive, let stateRaw = session.state,
                  AgentConnectionState(rawValue: stateRaw)?.isAwaiting == true,
                  let question = session.question?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !question.isEmpty
            else { continue }

            let reference = AttentionSessionReference(endpoint: snapshot.endpoint, sessionID: session.id)
            stillAwaiting.insert(reference.id)
            if notified[reference.id] != question {
                notified[reference.id] = question
                post(reference: reference,
                     projectName: session.projectName ?? session.agentType ?? "Agent",
                     question: question)
            }
        }

        for sessionId in notified.keys where !stillAwaiting.contains(sessionId) {
            notified.removeValue(forKey: sessionId)
            clear(sessionId: sessionId)
        }
    }

    static func content(reference: AttentionSessionReference, projectName: String, question: String) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "\(projectName) needs your response"
        content.body = question
        content.sound = .default
        content.threadIdentifier = reference.id
        content.userInfo = [referenceKey: reference.id]
        return content
    }

    private static func post(reference: AttentionSessionReference, projectName: String, question: String) {

        // Endpoint-scoped identity means a re-post (question changed) replaces the
        // delivered notification instead of stacking a second banner.
        let request = UNNotificationRequest(
            identifier: reference.id,
            content: content(reference: reference, projectName: projectName, question: question),
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                NSLog("[AgentDeck] attention notification failed: \(error.localizedDescription)")
            }
        }
    }

    private static func clear(sessionId: String) {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [sessionId])
        center.removePendingNotificationRequests(withIdentifiers: [sessionId])
    }
}
#endif
