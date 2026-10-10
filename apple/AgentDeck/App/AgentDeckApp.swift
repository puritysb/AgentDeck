// AgentDeckApp.swift — Universal app entry point (iOS + macOS)

import SwiftUI
#if os(macOS)
import ServiceManagement
import UserNotifications
#endif

@main
struct AgentDeckApp: App {
    @StateObject private var stateHolder = AgentStateHolder()
    @StateObject private var preferences = AppPreferences.shared
    #if os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var daemonService: DaemonService
    @Environment(\.openWindow) private var openWindow

    init() {
        // Enforce single-instance: activate existing instance and exit if one is running.
        // Install cleanup handlers to remove daemon.json on any exit path (crash, signal).
        _ = SingletonGuard.enforce()
        SingletonGuard.installCleanupHandlers()
        // One-shot migration from legacy ~/.agentdeck/ (pre-sandbox builds) into
        // the App Store data container. Best-effort; per-file errors are logged but
        // never thrown so startup never blocks on migration.
        _ = AgentDeckPaths.migrateLegacyDataIfNeeded()
        _daemonService = StateObject(wrappedValue: DaemonService())
    }
    #endif

    var body: some Scene {
        #if os(macOS)
        Window("AgentDeck Dashboard", id: "dashboard") {
            ContentView()
                .environmentObject(stateHolder)
                .environmentObject(preferences)
                .environmentObject(daemonService)
                // First-launch onboarding sheet. Shown once per install; the
                // xctest guard in AppPreferences ensures tests never block
                // on a modal. Safe to render unconditionally — the sheet
                // itself checks `hasSeenOnboarding` and returns a no-op on
                // subsequent launches.
                .sheet(isPresented: Binding(
                    get: {
                        !preferences.hasSeenOnboarding
                            && ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil
                    },
                    set: { newValue in
                        if !newValue {
                            preferences.hasSeenMonitorEmptyGuide = true
                            preferences.hasSeenOnboarding = true
                        }
                    }
                )) {
                    OnboardingSheet()
                        .environmentObject(preferences)
                        .environmentObject(stateHolder)
                        .environmentObject(daemonService)
                }
        }
        .defaultPosition(.center)
        .defaultSize(width: 1280, height: 840)

        // APME evaluation dashboard — embedded WKWebView pointing at the
        // in-process daemon's /apme HTTP endpoint. Opens from the menu bar
        // without launching an external browser.
        Window("APME Dashboard", id: "apme-dashboard") {
            ApmeDashboardWindow()
                .environmentObject(daemonService)
        }
        .defaultPosition(.center)
        .defaultSize(width: 1100, height: 760)
        // Never auto-open at app launch, even if macOS state-restoration
        // remembers a prior open instance. The Evaluation window is opt-in
        // from the menu bar.
        .defaultLaunchBehavior(.suppressed)

        // Device Preview window — sidebar-driven gallery of every device type
        // AgentDeck can drive. Users without hardware can see what sessions
        // look like on each surface; everyone can debug rendering tweaks
        // without touching a physical device.
        Window("Device Preview", id: "device-preview") {
            DevicePreviewScreen()
                .environmentObject(preferences)
                .environmentObject(daemonService)
                // Live-follow mode reads the daemon's aggregate state so the
                // preview can mirror what devices are rendering right now.
                .environmentObject(stateHolder)
        }
        .defaultPosition(.center)
        .defaultSize(width: 1100, height: 760)

        // Device pairing window — a QR of the daemon's ws:// URL for devices
        // with a camera, and a six-digit pairing code for devices without one
        // (e-ink readers). Covers the case where mDNS fails (Local Network
        // permission denied, different subnets, etc.).
        // id stays "pairing-qr": openWindow() call sites and
        // DockVisibilityController.trackedWindowIDs key off it.
        Window("Pair a Device", id: "pairing-qr") {
            DevicePairingWindow()
                .environmentObject(daemonService)
                .environmentObject(preferences)
        }
        .defaultPosition(.center)
        .defaultSize(width: 400, height: 480)
        .windowResizability(.contentSize)
        #else
        WindowGroup("AgentDeck Dashboard", id: "dashboard") {
            // iOS: show full-screen onboarding on first launch; dashboard
            // takes over once `hasSeenOnboarding` flips. Preserves the
            // environment objects so the onboarding pane 3 can reference
            // the shared `stateHolder` for live mDNS feedback if needed.
            Group {
                if preferences.hasSeenOnboarding {
                    ContentView()
                } else {
                    OnboardingScreen()
                }
            }
            .environmentObject(stateHolder)
            .environmentObject(preferences)
        }
        #endif
        #if os(macOS)
        // Preferences live in a regular `Window` scene instead of the
        // system `Settings` scene so the chrome matches Device Preview +
        // Pair iPad: NavigationSplitView's auto sidebar-toggle
        // lands in the titlebar toolbar instead of drifting into the
        // sidebar header. The trade-off is that we wire up the
        // `App → Settings…` menu item and ⌘, shortcut ourselves via
        // `.commands`, which is cheap.
        Window("AgentDeck Settings", id: "settings") {
            SettingsScreen()
                .environmentObject(stateHolder)
                .environmentObject(preferences)
                .environmentObject(daemonService)
        }
        .defaultPosition(.center)
        .defaultSize(width: 820, height: 580)
        // Never auto-open at app launch. Settings is opened deliberately
        // via ⌘, or the menu bar gear button; macOS shouldn't restore it
        // for a returning user.
        .defaultLaunchBehavior(.suppressed)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") {
                    // Promote BEFORE the window exists — see prepareToShowWindow().
                    DockVisibilityController.shared.prepareToShowWindow()
                    NSApp.activate(ignoringOtherApps: true)
                    openWindow(id: "settings")
                }
                .keyboardShortcut(",", modifiers: .command)
            }
        }
        MenuBarExtra {
            ControlTowerPanel()
                .environmentObject(stateHolder)
                .environmentObject(daemonService)
                .environmentObject(preferences)
        } label: {
            AgentStatusIcon(
                sessions: stateHolder.state.siblingSessions,
                bridgeConnected: stateHolder.state.bridgeConnected,
                style: preferences.menuBarIconStyle
            )
            .onAppear {
                DockVisibilityController.shared.openDashboard = { openWindow(id: "dashboard") }
                configureDaemonConnection()
            }
        }
        .menuBarExtraStyle(.window)
        #endif
    }

    #if os(macOS)
    /// `configureDaemonConnection()` used to ride the Dashboard's `.task`, so it
    /// ran exactly once because the window opened exactly once. Its new host is
    /// the MenuBarExtra label's `.onAppear`, which SwiftUI may call again when
    /// the label re-renders — hence an explicit one-shot.
    @MainActor private static var didConfigureDaemonConnection = false

    private func configureDaemonConnection() {
        guard !Self.didConfigureDaemonConnection else { return }
        Self.didConfigureDaemonConnection = true

        // Wire AppDelegate to daemon service for clean shutdown
        appDelegate.daemonService = daemonService
        appDelegate.stateHolder = stateHolder

        daemonService.onReady = { [stateHolder] wsUrl in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                stateHolder.setPreferredLocalBridge(url: wsUrl)
            }
        }

        // On external→owner promotion, purge Node-relayed usage/subscription
        // cache so unsupported-in-self-daemon data doesn't linger as a stale
        // trace (Claude quota, ChatGPT/Google subscription rows). Self-daemon
        // re-emits any locally-producible data (Codex limits, Antigravity plan)
        // within one usage tick.
        daemonService.onPromotedToOwner = { [stateHolder] in
            DispatchQueue.main.async { stateHolder.clearRelayedUsageState() }
        }

        // SwiftUI ALWAYS shows the first `Window` scene at launch, and
        // `.defaultLaunchBehavior(.suppressed)` does not apply to it — measured
        // 2026-08-18 with no saved application state present, the Dashboard's
        // NSWindow is created and `isVisible` regardless. So the preference
        // could not be honoured by declining to open the window; it has to
        // close the one macOS opened for us. `ControlTowerPanel.closeDashboard()`
        // already closes this window the same way and SwiftUI reopens the scene
        // cleanly afterwards.
        if preferences.openDashboardOnLaunch {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                openWindow(id: "dashboard")
            }
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                NSApp.windows.first { $0.identifier?.rawValue == "dashboard" }?.close()
            }
        }

        // Notifications are requested only from an explicit onboarding or Settings action.

    }

    // Dashboard visibility / toggle helpers moved to ControlTowerPanel
    #endif
}

#if os(macOS)
/// AppDelegate handles app lifecycle events that SwiftUI doesn't cover,
/// particularly applicationWillTerminate for clean daemon shutdown.
class AppDelegate: NSObject, NSApplicationDelegate {
    var daemonService: DaemonService?
    weak var stateHolder: AgentStateHolder?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Foreground-banner presentation for attention notifications
        // (see UNUserNotificationCenterDelegate extension below).
        UNUserNotificationCenter.current().delegate = self

        // "Menu bar only" mode (issue #221) — no-op unless the preference is on.
        DockVisibilityController.shared.start(preferences: AppPreferences.shared)

        // A second instance can't raise us by activation alone once the Dock
        // icon is gone, so SingletonGuard hands the request over as a
        // distributed notification instead. Name-only: App Sandbox strips
        // userInfo from distributed notifications and we don't need any.
        DistributedNotificationCenter.default().addObserver(
            forName: DockVisibilityController.showDashboardNotification,
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                DockVisibilityController.shared.prepareToShowWindow()
                DockVisibilityController.shared.openDashboard?()
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    /// Intercept termination to run daemon cleanup without blocking the main
    /// thread. The previous `applicationWillTerminate` implementation pumped
    /// `RunLoop.main.run(before:)` in 50ms slices for up to 3 s while waiting
    /// on a MainActor `Task`; that kept the Dashboard window on screen and
    /// the Dock icon bouncing for the whole cleanup. Using `.terminateLater`
    /// lets us orderOut the windows immediately, run the async shutdown
    /// naturally on its MainActor continuation, and reply back to AppKit
    /// when it's done. The 3 s fallback is preserved as a force-exit
    /// safety net for pathological cases (e.g. USB endpoint hang).
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Visually dismiss the app right now — user sees Cmd+Q → instant close.
        for window in sender.windows {
            window.orderOut(nil)
        }

        // Stop dashboard-side reconnect loops before bringing the daemon down.
        // Otherwise the UI client can keep reconnecting to 127.0.0.1 after
        // the in-process server has already closed, producing connection
        // refused spam during Quit.
        stateHolder?.prepareForTermination()

        // Remove daemon.json FIRST — fast, idempotent, and prevents stale-guard
        // deadlocks on the next launch even if the async shutdown below hangs.
        SingletonGuard.removeDaemonInfoFile()

        // Kick off cleanup on MainActor and reply when finished. DaemonServer
        // shutdown includes farewell frames to D200H / Pixoo / ESP32 so we
        // don't want to drop it, but we also don't want to hold the UI
        // hostage while it runs.
        var replied = false
        let reply: (_: Bool) -> Void = { success in
            if !replied {
                replied = true
                sender.reply(toApplicationShouldTerminate: success)
            }
        }

        Task { @MainActor [weak daemonService] in
            await daemonService?.stop()
            reply(true)
        }

        // Hard fallback — if cleanup stalls beyond 3s (e.g. HID endpoint
        // not responding), reply anyway so the process exits instead of
        // leaving the user stuck with no window and no Dock icon.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
            if !replied {
                NSLog("[AgentDeck] Shutdown exceeded 3s — forcing exit")
                reply(true)
            }
        }

        return .terminateLater
    }

    /// Ensure clean exit when the last window closes if the app was launched
    /// as a regular app (not via login item). Prevents zombie processes.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // MenuBarExtra keeps the app running — this only affects cases where no
        // menu bar icon is active. Return false to keep the menu bar alive.
        return false
    }
}

/// Present attention notifications as banners even while AgentDeck is the
/// frontmost app — without a delegate, UNUserNotificationCenter suppresses
/// foreground notifications entirely and the "needs your response" banner
/// (AttentionNotifier) would only ever appear when the app is backgrounded.
extension AppDelegate: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
#endif
