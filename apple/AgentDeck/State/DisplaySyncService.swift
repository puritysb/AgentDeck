// DisplaySyncService.swift — Sync device brightness with host Mac display sleep/wake
//
// When the Mac display sleeps (hostDisplayOn=false), dims the device screen.
// When it wakes (hostDisplayOn=true), restores the previous brightness.
// Safety: auto-restores after timeout to prevent permanently dimmed screen.

import Foundation
import Combine
#if canImport(UIKit)
import UIKit
#endif

final class DisplaySyncService: ObservableObject, @unchecked Sendable {
    @Published var enabled = true

    #if os(iOS)
    private var savedBrightness: CGFloat?
    private var pendingDim = false
    private var dimTimer: Timer?
    /// True while the screen is held dimmed by us — gates brightness capture so
    /// a live dim-level change (re-apply while host stays asleep) doesn't save
    /// the already-dimmed value as the "original".
    private var isDimmed = false
    /// Last dim instruction from the host (mode/level), retained so a
    /// foreground-return re-dim uses the configured target, not a hardcoded 0.
    private var lastDimMode = "off"
    private var lastDimLevel = 10
    /// Maximum time to keep screen dimmed (safety net — prevents stuck dim)
    private static let maxDimDuration: TimeInterval = 300  // 5 minutes
    #endif

    /// Call when hostDisplayOn changes. `dim` carries the host's instruction
    /// (enabled / off vs min / level); absent ⇒ legacy full-off.
    func handleDisplayState(displayOn: Bool, dim: DisplayDimInstruction?) {
        guard enabled else { return }

        #if os(iOS)
        Task { @MainActor [weak self] in
            self?.applyDisplayState(displayOn: displayOn, dim: dim)
        }
        #endif
    }

    #if os(iOS)
    /// Call when app returns to foreground
    func handleForegroundReturn(hostDisplayOn: Bool) {
        guard enabled else { return }
        Task { @MainActor [weak self] in
            self?.applyForegroundReturn(hostDisplayOn: hostDisplayOn)
        }
    }

    /// Restore brightness on disconnect (safety net)
    func restoreOnDisconnect() {
        Task { @MainActor [weak self] in
            self?.cancelDimTimer()
            self?.pendingDim = false
            self?.restoreBrightness()
        }
    }

    /// Resolve the target screen brightness (0.0-1.0) from the host's dim
    /// instruction. `min` ⇒ level percent; `off`/absent ⇒ fully dark.
    @MainActor
    private func dimTarget() -> CGFloat {
        return lastDimMode == "min" ? CGFloat(lastDimLevel) / 100.0 : 0.0
    }

    @MainActor
    private func applyDisplayState(displayOn: Bool, dim: DisplayDimInstruction?) {
        // Resolve the instruction (absent ⇒ legacy enabled/full-off) and retain
        // mode/level for foreground-return re-dim.
        let dimEnabled = dim?.enabled ?? true
        lastDimMode = (dim?.mode == "min") ? "min" : "off"
        lastDimLevel = max(1, min(100, dim?.level ?? 10))

        if !displayOn && dimEnabled {
            if !isDimmed {
                // First dim — capture the user's brightness to restore later.
                // The isDimmed guard prevents a live level change (re-apply
                // while asleep) from saving the already-dimmed value.
                let current = UIScreen.main.brightness
                if current > 0.01 { savedBrightness = current }
                isDimmed = true
            }
            UIScreen.main.brightness = dimTarget()
            pendingDim = false
            startDimTimer()
        } else {
            // Display awake OR host disabled device dimming → restore.
            cancelDimTimer()
            pendingDim = false
            restoreBrightness()
        }
    }

    @MainActor
    private func applyForegroundReturn(hostDisplayOn: Bool) {
        if pendingDim && !hostDisplayOn {
            if !isDimmed {
                let current = UIScreen.main.brightness
                if current > 0.01 { savedBrightness = current }
                isDimmed = true
            }
            UIScreen.main.brightness = dimTarget()
            pendingDim = false
            startDimTimer()
        }
    }

    @MainActor
    private func restoreBrightness() {
        if let saved = savedBrightness {
            UIScreen.main.brightness = saved
            savedBrightness = nil
        }
        isDimmed = false
    }

    /// Safety timer — auto-restore brightness after maxDimDuration
    @MainActor
    private func startDimTimer() {
        cancelDimTimer()
        dimTimer = Timer.scheduledTimer(withTimeInterval: Self.maxDimDuration, repeats: false) { [weak self] _ in
            print("[DisplaySync] safety timeout — restoring brightness")
            Task { @MainActor in
                self?.restoreBrightness()
            }
        }
    }

    @MainActor
    private func cancelDimTimer() {
        dimTimer?.invalidate()
        dimTimer = nil
    }
    #endif
}
