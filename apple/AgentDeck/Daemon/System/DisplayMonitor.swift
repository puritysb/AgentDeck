#if os(macOS)
// DisplayMonitor.swift — macOS display + presence state aggregator
//
// Signals fused into a single `displayOn` boolean for downstream consumers
// (Pixoo, D200H, ESP32, Android, WS clients):
//   1. NSWorkspace display sleep/wake notifications (2s CG polling repairs misses)
//   2. Screen locked (com.apple.screenIsLocked DistributedNotification)
//   3. Screensaver running (com.apple.screensaver.didstart DistributedNotification)
//   4. Fast User Switching — session resigned active (NSWorkspace)
//
// "displayOn = true" means the user is actively present AND the monitor is on.
// Any of the four going negative flips displayOn false. All APIs are public /
// App Store safe — no CGSSessionScreenIsLocked or other private APIs.

import Foundation
import AppKit
import CoreGraphics

actor DisplayMonitor {
    private let workspaceNotifications: NotificationCenter
    private let readDisplayAsleep: @Sendable () -> Bool

    init(workspaceNotifications: NotificationCenter = NSWorkspace.shared.notificationCenter,
         readDisplayAsleep: @escaping @Sendable () -> Bool = { CGDisplayIsAsleep(CGMainDisplayID()) != 0 }) {
        self.workspaceNotifications = workspaceNotifications
        self.readDisplayAsleep = readDisplayAsleep
    }
    private var isDisplayAsleep = false
    private var isScreenLocked = false
    private var isScreensaverActive = false
    private var isSessionInactive = false

    private var lastBroadcastOn = true
    private var pollTask: Task<Void, Never>?
    private var _onStateChanged: (@Sendable (Bool) -> Void)?

    private var observerHandles: [NSObjectProtocol] = []
    private var generation = 0

    func setOnStateChanged(_ handler: @escaping @Sendable (Bool) -> Void) {
        _onStateChanged = handler
    }

    func start() {
        guard pollTask == nil else { return }
        generation += 1
        installPresenceObservers()
        checkDisplayState()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) }
                catch { return }
                await self?.checkDisplayState()
            }
        }
        DaemonLogger.shared.debug("Display", "Monitor started (display+lock+screensaver+session)")
    }

    func stop() {
        generation += 1
        pollTask?.cancel()
        pollTask = nil
        removePresenceObservers()
    }

    var displayOn: Bool { computeDisplayOn() }

    // MARK: - Composite

    private func computeDisplayOn() -> Bool {
        !isDisplayAsleep && !isScreenLocked && !isScreensaverActive && !isSessionInactive
    }

    private func emitIfChanged(reason: String) {
        let newOn = computeDisplayOn()
        if newOn != lastBroadcastOn {
            lastBroadcastOn = newOn
            DaemonLogger.shared.debug(
                "Display",
                "State changed: \(newOn ? "ON" : "OFF") (cause=\(reason)) "
                + "[displayAsleep=\(isDisplayAsleep) locked=\(isScreenLocked) "
                + "screensaver=\(isScreensaverActive) sessionInactive=\(isSessionInactive)]"
            )
            _onStateChanged?(newOn)
        }
    }

    // MARK: - Poll (hardware display)

    private func checkDisplayState() {
        let isAsleep = readDisplayAsleep()
        if isAsleep != isDisplayAsleep {
            isDisplayAsleep = isAsleep
            emitIfChanged(reason: "display\(isAsleep ? "Sleep" : "Wake")")
        }
    }

    // MARK: - Presence observers (lock / screensaver / session)

    private func installPresenceObservers() {
        let dnc = DistributedNotificationCenter.default()
        let wsc = workspaceNotifications
        let epoch = generation
        let displaySleep = wsc.addObserver(
            forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: nil
        ) { [weak self] _ in
            Task { await self?.setDisplayAsleep(true, generation: epoch) }
        }
        let displayWake = wsc.addObserver(
            forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: nil
        ) { [weak self] _ in
            Task { await self?.setDisplayAsleep(false, generation: epoch) }
        }

        let lockObs = dnc.addObserver(
            forName: Notification.Name("com.apple.screenIsLocked"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.setLocked(true) }
        }
        let unlockObs = dnc.addObserver(
            forName: Notification.Name("com.apple.screenIsUnlocked"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.setLocked(false) }
        }
        let ssStartObs = dnc.addObserver(
            forName: Notification.Name("com.apple.screensaver.didstart"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.setScreensaver(true) }
        }
        let ssStopObs = dnc.addObserver(
            forName: Notification.Name("com.apple.screensaver.didstop"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.setScreensaver(false) }
        }
        let sessionOut = wsc.addObserver(
            forName: NSWorkspace.sessionDidResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.setSessionInactive(true) }
        }
        let sessionIn = wsc.addObserver(
            forName: NSWorkspace.sessionDidBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.setSessionInactive(false) }
        }

        observerHandles = [displaySleep, displayWake, lockObs, unlockObs, ssStartObs, ssStopObs, sessionOut, sessionIn]
    }

    private func removePresenceObservers() {
        let dnc = DistributedNotificationCenter.default()
        let wsc = workspaceNotifications
        for handle in observerHandles {
            dnc.removeObserver(handle)
            wsc.removeObserver(handle)
        }
        observerHandles.removeAll()
    }

    private func setLocked(_ locked: Bool) {
        guard locked != isScreenLocked else { return }
        isScreenLocked = locked
        emitIfChanged(reason: locked ? "screenLock" : "screenUnlock")
    }

    private func setDisplayAsleep(_ asleep: Bool, generation epoch: Int) {
        guard epoch == generation, pollTask != nil, asleep != isDisplayAsleep else { return }
        isDisplayAsleep = asleep
        emitIfChanged(reason: asleep ? "workspaceDisplaySleep" : "workspaceDisplayWake")
    }

    private func setScreensaver(_ active: Bool) {
        guard active != isScreensaverActive else { return }
        isScreensaverActive = active
        emitIfChanged(reason: active ? "screensaverStart" : "screensaverStop")
    }

    private func setSessionInactive(_ inactive: Bool) {
        guard inactive != isSessionInactive else { return }
        isSessionInactive = inactive
        emitIfChanged(reason: inactive ? "sessionResign" : "sessionResume")
    }
}
#endif
