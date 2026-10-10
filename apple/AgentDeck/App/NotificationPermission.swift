// NotificationPermission.swift — User-initiated notification authorization flow.
//
// AgentDeck posts local notifications when a session needs the user's
// explicit response (`AttentionNotifier`) via `UNUserNotificationCenter`.
// Without a prior `requestAuthorization` call those posts silently drop on
// the floor and App Store users never see them. This helper shows a
// one-time explanatory `NSAlert` on first launch, then defers to the real
// system dialog only if the user consents — avoiding the classic "blind
// system prompt" antipattern while staying idempotent via
// `AppPreferences.hasRequestedNotifications`.
//
// The flag flips to `true` in BOTH branches (primary = "Enable", secondary
// = "Not Now") because the goal is "don't nag". Settings provides a
// "Request Again" escape hatch for users who change their mind.

#if os(macOS)
import Foundation
import UserNotifications
import AppKit

enum NotificationPermission {
    /// Reopening setup must not pretend an OS-level denial can be retried
    /// through requestAuthorization. Show the actual state and recovery path.
    @MainActor
    static func chooseFromUserAction() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            AppPreferences.shared.hasRequestedNotifications = false
            await requestIfNeeded()
            return
        }
        let alert = NSAlert()
        alert.messageText = settings.authorizationStatus == .denied
            ? "Notifications are off" : "Notifications are enabled"
        alert.informativeText = "You can change AgentDeck's notification settings in System Settings → Notifications → AgentDeck."
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    /// Show an explanatory NSAlert on first launch, then call
    /// UNUserNotificationCenter.requestAuthorization only if the user
    /// says yes. Idempotent — guarded by AppPreferences.hasRequestedNotifications.
    @MainActor
    static func requestIfNeeded() async {
        // xctest host runs our @main App without a user present; a modal
        // NSAlert would deadlock the test runner. Match SingletonGuard's
        // environment-based bypass so `xcodebuild test` never hangs here.
        let env = ProcessInfo.processInfo.environment
        if env["XCTestConfigurationFilePath"] != nil
            || env["XCTestBundlePath"] != nil
            || env["XCTestSessionIdentifier"] != nil {
            return
        }

        let prefs = AppPreferences.shared
        if prefs.hasRequestedNotifications {
            return
        }

        let alert = NSAlert()
        alert.messageText = "Enable AgentDeck notifications?"
        alert.informativeText = "AgentDeck can notify you when sessions complete, APME reports are ready, or usage limits approach. You can change this later in System Settings → Notifications."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Enable Notifications")
        alert.addButton(withTitle: "Not Now")

        let response = alert.runModal()
        // Mark asked regardless — the system prompt (or the user's decline)
        // is the real signal. A subsequent call to requestAuthorization on
        // an already-decided authorization status is a no-op, but we still
        // want to avoid re-showing our pre-prompt.
        prefs.hasRequestedNotifications = true

        if response == .alertFirstButtonReturn {
            do {
                _ = try await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound, .badge])
            } catch {
                NSLog("[AgentDeck] requestAuthorization failed: \(error.localizedDescription)")
            }
        }
    }
}
#endif
