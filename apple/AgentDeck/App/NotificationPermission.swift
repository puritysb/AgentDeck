// NotificationPermission.swift — User-initiated notification authorization flow.
//
// AgentDeck posts local notifications when a session needs the user's
// explicit response (`AttentionNotifier`) via `UNUserNotificationCenter`.
// Without a `requestAuthorization` call those posts silently drop, so the
// request is offered — never forced — from the two places the user chooses
// it: the last onboarding step and Settings ("Choose Notifications…").
// Nothing asks at launch: an unexplained system prompt before the user has
// seen what AgentDeck does is the antipattern App Review and the HIG warn
// against, and the button the user pressed is already the explanation, so
// it goes straight to the system dialog.
//
// Once the system has an answer, requestAuthorization can no longer change
// it, so a second press shows the real state and — when notifications are
// off — opens AgentDeck's page in System Settings, the only place to undo it.

#if os(macOS)
import Foundation
import UserNotifications
import AppKit

enum NotificationPermission {
    /// What a user-initiated "Choose Notifications…" press should do for a
    /// given system authorization state.
    enum Action: Equatable {
        /// The system has not asked yet: show its dialog now.
        case requestAuthorization
        /// Notifications are off: say so and offer System Settings.
        case explainDenied
        /// Notifications are on (fully or provisionally).
        case confirmEnabled
    }

    static func action(for status: UNAuthorizationStatus) -> Action {
        switch status {
        case .notDetermined: return .requestAuthorization
        case .denied: return .explainDenied
        default: return .confirmEnabled
        }
    }

    /// AgentDeck's own page in System Settings → Notifications. Opening a
    /// settings URL is a plain LaunchServices call, not a subprocess.
    static func settingsURL(bundleIdentifier: String? = Bundle.main.bundleIdentifier) -> URL {
        var components = URLComponents(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!
        if let bundleIdentifier, !bundleIdentifier.isEmpty {
            components.queryItems = [URLQueryItem(name: "id", value: bundleIdentifier)]
        }
        return components.url!
    }

    @MainActor
    static func chooseFromUserAction() async {
        // xctest host runs our @main App without a user present; a modal
        // NSAlert or the system dialog would deadlock the test runner.
        let env = ProcessInfo.processInfo.environment
        if env["XCTestConfigurationFilePath"] != nil
            || env["XCTestBundlePath"] != nil
            || env["XCTestSessionIdentifier"] != nil {
            return
        }

        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch action(for: settings.authorizationStatus) {
        case .requestAuthorization:
            AppPreferences.shared.hasRequestedNotifications = true
            do {
                _ = try await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound, .badge])
            } catch {
                NSLog("[AgentDeck] requestAuthorization failed: \(error.localizedDescription)")
            }
        case .explainDenied:
            let alert = NSAlert()
            alert.messageText = "Notifications are off"
            alert.informativeText = "Turn on notifications for AgentDeck in System Settings to hear when a session needs your attention."
            alert.addButton(withTitle: "Open System Settings")
            alert.addButton(withTitle: "Not Now")
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(settingsURL())
            }
        case .confirmEnabled:
            let alert = NSAlert()
            alert.messageText = "Notifications are on"
            alert.informativeText = "AgentDeck will notify you when a session needs your attention. You can change this in System Settings → Notifications → AgentDeck."
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }
}
#endif
