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
import AppKit
import Foundation
import UserNotifications

@MainActor
final class AttentionNotifier {
    static let shared = AttentionNotifier()
    nonisolated static let referenceKey = "agentdeck.attentionSession"

    private struct Wait {
        let state: AgentConnectionState
        let question: String
        let requestID: String?
    }

    private var notified: [String: Wait] = [:]
    private let playSound: @MainActor () -> Void
    private let post: @MainActor (String, UNNotificationContent) -> Void
    private let clear: @MainActor (String) -> Void

    init(playSound: @escaping @MainActor () -> Void = { NSSound.beep() },
         post: @escaping @MainActor (String, UNNotificationContent) -> Void = AttentionNotifier.post,
         clear: @escaping @MainActor (String) -> Void = AttentionNotifier.clear) {
        self.playSound = playSound
        self.post = post
        self.clear = clear
    }

    /// Diff the latest sessions_list against what we've notified:
    /// newly-awaiting sessions post, no-longer-awaiting (or vanished)
    /// sessions clear.
    func sync(snapshot: AttentionSessionSnapshot, playPermissionWaitSound: Bool) {
        var stillAwaiting: Set<String> = []

        for session in snapshot.sessions {
            guard session.alive, let stateRaw = session.state,
                  let state = AgentConnectionState(rawValue: stateRaw), state.isAwaiting,
                  let question = session.question?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !question.isEmpty
            else { continue }

            let reference = AttentionSessionReference(endpoint: snapshot.endpoint, sessionID: session.id)
            stillAwaiting.insert(reference.id)
            let previous = notified[reference.id]
            // Older daemons can omit the ID. Keep the last one during the same wait.
            let requestID = session.requestId ?? (previous?.state == state ? previous?.requestID : nil)
            let replacedRequest = previous?.requestID != nil && requestID != previous?.requestID
            let startedWait = previous?.state != state || replacedRequest
            let useDedicatedSound = playPermissionWaitSound && state == .awaitingPermission
            notified[reference.id] = Wait(state: state, question: question, requestID: requestID)
            if useDedicatedSound && startedWait {
                playSound()
            }
            if startedWait || previous?.question != question {
                post(reference.id, Self.content(
                    reference: reference,
                    projectName: session.projectName ?? session.agentType ?? "Agent",
                    question: question,
                    notificationSound: !useDedicatedSound))
            }
        }

        for sessionId in notified.keys where !stillAwaiting.contains(sessionId) {
            notified.removeValue(forKey: sessionId)
            clear(sessionId)
        }
    }

    static func content(reference: AttentionSessionReference, projectName: String, question: String,
                        notificationSound: Bool = true) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "\(projectName) needs your response"
        content.body = question
        content.sound = notificationSound ? .default : nil
        content.threadIdentifier = reference.id
        content.userInfo = [referenceKey: reference.id]
        return content
    }

    private static func post(sessionID: String, content: UNNotificationContent) {
        // Endpoint-scoped identity means a re-post (question changed) replaces the
        // delivered notification instead of stacking a second banner.
        let request = UNNotificationRequest(
            identifier: sessionID,
            content: content,
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
