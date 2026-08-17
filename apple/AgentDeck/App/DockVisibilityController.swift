#if os(macOS)
// DockVisibilityController.swift — "Menu bar only" mode (issue #221).
//
// Runs AgentDeck without a Dock icon while no AgentDeck window is open, and
// restores the icon while one is. Deliberately NOT a permanent `.accessory`
// policy and deliberately NOT an Info.plist `LSUIElement`:
//
//   * The Dashboard is a full 1280×840 app window (session list, tank status,
//     device diagnostics, timeline strip) and for App Store users running
//     without the Node CLI it IS the app. A permanent accessory policy drops
//     that window out of ⌘Tab and Mission Control, so the moment it goes
//     behind another app the only way back is the menu bar icon — a failure
//     that reads as "AgentDeck is broken in ⌘Tab", not as "the setting I
//     enabled". Permanent accessory suits utilities whose only window is a
//     preferences sheet; this isn't one.
//   * `LSUIElement` cannot be toggled without a relaunch and would default the
//     behavior on, which contradicts the issue's "default off" requirement.
//
// While in the hidden state macOS also removes the global menu bar, so Quit /
// Settings / Start at Login are reachable only from the menu bar panel. All
// three already live in ControlTowerPanel, which is why the menu bar icon
// itself stays non-hideable — it is the escape hatch.

import AppKit
import Combine
import Foundation

/// Pure decision layer, split out from the AppKit plumbing so the policy is
/// testable without a running NSApplication.
enum DockVisibilityPolicy {
    /// Scene ids that count as "a real AgentDeck window".
    ///
    /// This is an ALLOW-LIST on purpose. `NSApp.windows` is not a list of the
    /// app's document windows — it also contains the panel backing
    /// `MenuBarExtra`'s `.window` style, status-item windows, and assorted
    /// AppKit-internal windows. Counting `NSApp.windows` (or filtering by
    /// anything other than an explicit id set) means the count never reaches
    /// zero, the demote never fires, and the whole feature silently does
    /// nothing: the toggle flips and the Dock icon stays put.
    ///
    /// Must list every `Window(id:)` scene declared in `AgentDeckApp.body`.
    /// SwiftUI sets `NSWindow.identifier` to the scene id (already relied on by
    /// `ControlTowerPanel.closeDashboard()`).
    static let trackedWindowIDs: Set<String> = [
        "dashboard",
        "apme-dashboard",
        "device-preview",
        "pairing-qr",
        "settings",
    ]

    /// The subset of an `NSWindow` we actually decide on. Lets tests drive the
    /// policy without constructing real windows.
    struct WindowSnapshot: Equatable {
        let identifier: String?
        let isVisible: Bool
        let isMiniaturized: Bool

        init(identifier: String?, isVisible: Bool, isMiniaturized: Bool = false) {
            self.identifier = identifier
            self.isVisible = isVisible
            self.isMiniaturized = isMiniaturized
        }
    }

    /// Tracked windows that are currently "open" from the user's point of view.
    ///
    /// A minimized window counts as open: `isVisible` is false while
    /// miniaturized, and demoting to `.accessory` in that state strands the
    /// window's Dock tile — the user minimizes the Dashboard and can never
    /// restore it. A closed SwiftUI `Window` scene, by contrast, stays in
    /// `NSApp.windows` with `isVisible == false`, so the id alone is not
    /// enough to tell "closed" from "open".
    static func openTrackedWindowIDs(in windows: [WindowSnapshot]) -> Set<String> {
        var open: Set<String> = []
        for window in windows {
            guard let id = window.identifier, trackedWindowIDs.contains(id) else { continue }
            guard window.isVisible || window.isMiniaturized else { continue }
            open.insert(id)
        }
        return open
    }

    static func desiredPolicy(
        menuBarOnly: Bool,
        openTrackedWindowIDs: Set<String>
    ) -> NSApplication.ActivationPolicy {
        guard menuBarOnly else { return .regular }
        return openTrackedWindowIDs.isEmpty ? .accessory : .regular
    }
}

/// Coalescing window for demote checks. Closing Settings and opening the
/// Dashboard is one user gesture but two window events; without a beat between
/// them the policy flaps `.regular` → `.accessory` → `.regular` and the Dock
/// icon visibly blinks. File scope rather than a `@MainActor` static so it can
/// be a default argument value (Swift 6 rejects the isolated form there).
private let dockRecomputeDebounce: TimeInterval = 0.25

/// First recompute is deferred so a launch that is about to open the Dashboard
/// doesn't hide the icon and immediately show it again.
private let dockLaunchSettleDelay: TimeInterval = 1.0

/// Owns the live activation policy. Singleton because the window-opening call
/// sites (`ControlTowerPanel`, the Settings command in `AgentDeckApp`) are
/// SwiftUI views with no path to the `AppDelegate`.
@MainActor
final class DockVisibilityController {
    static let shared = DockVisibilityController()

    /// Posted by a second instance that `SingletonGuard` is about to kill.
    /// `NSRunningApplication.activate()` is a no-op for an app with no Dock
    /// icon and no windows, so relaunching AgentDeck from Finder/Spotlight
    /// while in the hidden state would otherwise appear to do nothing at all.
    static let showDashboardNotification = Notification.Name(
        "bound.serendipity.agent.deck.showDashboard"
    )

    /// Installed by the MenuBarExtra label, which is the only view guaranteed
    /// to exist from launch onward — `configureDaemonConnection()` runs in the
    /// Dashboard window's `.task` and so never fires for a user who runs
    /// menu-bar-only and never opens the Dashboard.
    var openDashboard: (() -> Void)?

    private var preferences: AppPreferences?
    private var cancellables = Set<AnyCancellable>()
    private var pendingRecompute: DispatchWorkItem?
    private var started = false

    private init() {}

    func start(preferences: AppPreferences) {
        guard !started else { return }
        // Never touch the activation policy under xctest — the test host is a
        // regular app and demoting it mid-run confuses the runner's XPC
        // handshake (same reasoning as SingletonGuard's xctest bypass).
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        started = true
        self.preferences = preferences
        let center = NotificationCenter.default
        for name: Notification.Name in [
            NSWindow.willCloseNotification,
            NSWindow.didMiniaturizeNotification,
            NSWindow.didDeminiaturizeNotification,
        ] {
            center.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                // willClose fires while the window is still visible, so every
                // one of these has to settle before we look at the window list.
                MainActor.assumeIsolated { self?.scheduleRecompute() }
            }
        }

        preferences.$menuBarOnlyMode
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.recomputeNow() }
            .store(in: &cancellables)

        if preferences.menuBarOnlyMode && !preferences.openDashboardOnLaunch {
            // Pure background launch — the configuration the feature exists
            // for. Try to hide immediately rather than showing the icon for a
            // second.
            recomputeNow()
        }
        // Always re-check once SwiftUI has settled, and never treat the
        // first pass as authoritative: at applicationDidFinishLaunching the
        // Dashboard's NSWindow already exists and still reports
        // `isVisible == true` even when its scene is `.suppressed`, so an
        // early-only read decides `.regular` and nothing ever revisits it.
        scheduleRecompute(after: dockLaunchSettleDelay)
    }

    /// Call BEFORE `openWindow(id:)`. Promoting after the window already
    /// exists makes AppKit drop key focus and the new window lands behind the
    /// app the user came from.
    func prepareToShowWindow() {
        pendingRecompute?.cancel()
        pendingRecompute = nil
        apply(.regular)
    }

    func scheduleRecompute(after delay: TimeInterval = dockRecomputeDebounce) {
        pendingRecompute?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.recomputeNow() }
        }
        pendingRecompute = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    func recomputeNow() {
        pendingRecompute?.cancel()
        pendingRecompute = nil
        guard started else { return }
        let snapshots = NSApp.windows.map {
            DockVisibilityPolicy.WindowSnapshot(
                identifier: $0.identifier?.rawValue,
                isVisible: $0.isVisible,
                isMiniaturized: $0.isMiniaturized
            )
        }
        apply(DockVisibilityPolicy.desiredPolicy(
            menuBarOnly: preferences?.menuBarOnlyMode ?? false,
            openTrackedWindowIDs: DockVisibilityPolicy.openTrackedWindowIDs(in: snapshots)
        ))
    }

    private func apply(_ policy: NSApplication.ActivationPolicy) {
        guard NSApp.activationPolicy() != policy else { return }
        NSApp.setActivationPolicy(policy)
        if policy == .regular {
            // Coming back from .accessory the app is not frontmost, so without
            // this the restored Dock icon sits inactive behind whatever the
            // user was in.
            NSApp.activate(ignoringOtherApps: true)
        }
        NSLog("[AgentDeck] Activation policy → \(policy == .accessory ? "accessory (no Dock icon)" : "regular")")
    }
}
#endif
