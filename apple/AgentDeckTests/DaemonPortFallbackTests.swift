// DaemonPortFallbackTests.swift — the daemon must not retry a dead port while
// a free one is already known.
//
// Observed 2026-07-19. The user stopped the CLI daemon; the app tried to take
// over, failed to bind, burned its whole retry budget and gave up — with the
// preferred port sitting free the entire time. Its own diagnostic said so:
//
//   retryOrFallback diag: userExplicitPort=9120 onDefault=false
//                         fallbackAttempted=false
//                         findAvailable=9120 attemptedPort=9121
//
// Both escape hatches were gated off at once. `onDefault` was false because a
// session override was set; `fallbackAttempted` was false because the override
// came from `syncResolvedPortState` (a previous successful bind or external
// connect on a non-configured port), not from this retry path choosing a
// fallback. Nothing advanced the port, so every retry hit 9121 again.
//
// 9121 is in the session-bridge range (9121-9139), so falling back there and
// then finding it taken is a recurring shape, not a one-off.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class DaemonPortFallbackTests: XCTestCase {

    // MARK: - The stall

    /// The exact state from the incident: on a fallback port, override set by
    /// `syncResolvedPortState` so `fallbackAttempted` is false, and the
    /// configured port free. It must advance rather than retry 9121.
    func testAdvancesOffADeadFallbackPortWhenOverrideCameFromASuccessfulBind() {
        let next = DaemonService.advancedFallbackPort(
            attemptedPort: 9121,
            sessionOverridePort: 9121,
            fallbackAttempted: false,   // the stale flag that caused the stall
            availablePort: 9120
        )
        XCTAssertEqual(next, 9120, "must reclaim the free port instead of retrying the dead one")
    }

    /// The path that already worked: this retry loop chose the fallback, so the
    /// flag is set. Still advances.
    func testAdvancesWhenFallbackWasChosenByTheRetryPath() {
        let next = DaemonService.advancedFallbackPort(
            attemptedPort: 9122,
            sessionOverridePort: nil,
            fallbackAttempted: true,
            availablePort: 9123
        )
        XCTAssertEqual(next, 9123)
    }

    // MARK: - Cases that must NOT advance

    /// On the user's configured port with no override: advancing here would
    /// skip the squatter-cleanup and user-messaging path that owns this case.
    func testDoesNotAdvanceWhileStillOnTheConfiguredPort() {
        let next = DaemonService.advancedFallbackPort(
            attemptedPort: 9120,
            sessionOverridePort: nil,
            fallbackAttempted: false,
            availablePort: 9125
        )
        XCTAssertNil(next, "the configured-port case is handled by the fallback fast path, not here")
    }

    func testDoesNotAdvanceWhenTheOnlyFreePortIsTheOneThatJustFailed() {
        let next = DaemonService.advancedFallbackPort(
            attemptedPort: 9121,
            sessionOverridePort: 9121,
            fallbackAttempted: true,
            availablePort: 9121
        )
        XCTAssertNil(next, "no point re-selecting the port we just failed on")
    }

    func testDoesNotAdvanceWhenNoPortIsAvailable() {
        let next = DaemonService.advancedFallbackPort(
            attemptedPort: 9121,
            sessionOverridePort: 9121,
            fallbackAttempted: true,
            availablePort: nil
        )
        XCTAssertNil(next)
    }

    // MARK: - The invariant behind the bug

    /// `fallbackAttempted` must track `sessionOverridePort`. They drifted apart
    /// in `syncResolvedPortState`, which set the override and left the flag
    /// alone — that drift *is* the bug above.
    func testFallbackFlagTracksTheSessionOverride() {
        // Bound the configured port → no override, not a fallback.
        XCTAssertNil(DaemonService.resolvedSessionOverridePort(configuredPort: 9120, actualPort: 9120))
        XCTAssertFalse(DaemonService.resolvedFallbackAttempted(configuredPort: 9120, actualPort: 9120))

        // Ended up elsewhere → override recorded, and the flag must say so.
        XCTAssertEqual(DaemonService.resolvedSessionOverridePort(configuredPort: 9120, actualPort: 9121), 9121)
        XCTAssertTrue(DaemonService.resolvedFallbackAttempted(configuredPort: 9120, actualPort: 9121))
    }

    // MARK: - Bind-failure memory (the reclaim thrash, 2026-08-06)

    // The app spent 40s in this loop, ~7s per cycle:
    //
    //   Daemon ready ... ws://127.0.0.1:9122
    //   Canonical port 9120 is free — reclaiming it from fallback port 9122
    //   Daemon stopped
    //   ERROR Daemon listener bind failed: POSIXErrorCode(48): Address already in use
    //   → falls back to 9122 → repeat
    //
    // `isPortBindable` (raw BSD socket) said 9120 was free; NWListener applied
    // NECP on top and disagreed. `failedBindPorts` is what remembers that, and
    // `standDownServer` was clearing it on every cycle — so reclaim re-attempted
    // the same unbindable port forever, tearing down a working hub each time and
    // stranding a serial-reader generation per cycle.
    //
    // The memory must therefore survive a stand-down, but not the whole launch:
    // never forgetting would pin us to a fallback port after one transient
    // failure. Hence a TTL, driven here with an injected clock.

    private let memory: TimeInterval = 120

    /// A port we just watched fail must be believed over the raw-socket probe.
    func testAFreshBindFailureSuppressesReclaim() {
        let now = Date()
        let active = DaemonService.activeFailedBindPorts([9120: now], now: now, memory: memory)
        XCTAssertTrue(active.contains(9120), "reclaim must not re-attempt a port NWListener just rejected")
    }

    /// ...but the block has to expire, or one transient EADDRINUSE strands the
    /// app on a fallback port for the rest of the launch.
    func testTheBindFailureIsForgottenAfterTheMemoryWindow() {
        let now = Date()
        let stale = now.addingTimeInterval(-(memory + 1))
        let active = DaemonService.activeFailedBindPorts([9120: stale], now: now, memory: memory)
        XCTAssertFalse(active.contains(9120), "an expired failure must allow the canonical port to be retried")
    }

    /// Each port is remembered independently — a wedged 9120 must not suppress
    /// a retry of some other port.
    func testExpiryIsPerPort() {
        let now = Date()
        let active = DaemonService.activeFailedBindPorts(
            [9120: now, 9122: now.addingTimeInterval(-(memory + 1))],
            now: now,
            memory: memory
        )
        XCTAssertEqual(active, [9120])
    }

    // MARK: - Which port to look for an external daemon on (#305)

    /// The wedge: the in-process server's `onShutdown` handler calls
    /// `connectToExternalDaemon()` with NO port, at the one moment the registry
    /// is guaranteed empty — our own daemon.json row is going away and the
    /// incoming CLI daemon has not bound yet. Resolving that to nil was a
    /// terminal dead end (no rescheduled `start()`, and `port = 0` neutered the
    /// health monitor's own `currentPort > 0` guard), so the app sat daemonless
    /// AND clientless for 23 hours. Measured 2026-09-09; same signature 09-07
    /// and 09-10.
    func testEmptyRegistryFallsBackToTheCanonicalPortRatherThanNil() {
        XCTAssertEqual(
            DaemonService.resolveExternalDaemonPort(
                knownPort: nil, registryPort: nil, canonicalPort: 9120),
            9120
        )
    }

    /// A caller that KNOWS the port (the stand-down path passes the canonical
    /// one explicitly) outranks both, and the registry outranks the fallback —
    /// the fallback is a last resort, not a preference.
    func testKnownPortOutranksRegistryWhichOutranksTheCanonicalFallback() {
        XCTAssertEqual(
            DaemonService.resolveExternalDaemonPort(
                knownPort: 9131, registryPort: 9122, canonicalPort: 9120),
            9131
        )
        XCTAssertEqual(
            DaemonService.resolveExternalDaemonPort(
                knownPort: nil, registryPort: 9122, canonicalPort: 9120),
            9122
        )
    }

    /// Zero is not a port. It is what `port` is set to on every teardown path,
    /// so it reaches here as a plausible-looking number; treating it as an
    /// answer would probe port 0 forever instead of falling through.
    func testZeroIsNotAnAnswerOnAnyOfTheThreeInputs() {
        XCTAssertEqual(
            DaemonService.resolveExternalDaemonPort(
                knownPort: 0, registryPort: 0, canonicalPort: 9120),
            9120
        )
        XCTAssertNil(
            DaemonService.resolveExternalDaemonPort(
                knownPort: nil, registryPort: nil, canonicalPort: 0)
        )
    }

}

// MARK: - withBudget

/// Teardown must survive a subsystem that never finishes.
///
/// Observed 2026-08-06: the daemon logged "Canonical port 9120 is free —
/// reclaiming it from fallback port 9121", entered `shutdown()`, and never came
/// out. `ModuleManager.stopAll()` is a task group over every module's `stop()`,
/// and a task group awaits ALL of its children — so one wedged module (a BLE
/// stop parked on a reply that never came) meant the listener release below it
/// was never reached. The daemon served from the fallback port for the rest of
/// its life, and `isReclaimingPort` — cleared only by a `defer` in that
/// suspended call — latched, so no later health tick ever retried.
final class WithBudgetTests: XCTestCase {
    func testReturnsTrueWhenWorkFinishesInsideTheBudget() async {
        let finished = await withBudget(seconds: 2, "fast") {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(finished)
    }

    func testReturnsFalseWithoutHangingWhenWorkNeverFinishes() async {
        // The regression gate. Before the fix this call site was a bare
        // `await`, and this test would never return at all — the assertion is
        // secondary to the fact that control comes back.
        let started = Date()
        let finished = await withBudget(seconds: 0.3, "wedged") {
            // Not merely slow: unresponsive to cancellation too, which is what
            // a continuation awaiting a reply that never arrives looks like.
            while true { try? await Task.sleep(nanoseconds: 50_000_000) }
        }
        XCTAssertFalse(finished)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3.0)
    }

    func testDoesNotWaitOutTheWholeBudgetForFastWork() async {
        // A budget is a ceiling, not a delay — teardown runs on the quit path
        // too, where 4s of dead time would be user-visible.
        let started = Date()
        _ = await withBudget(seconds: 5, "fast") { }
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.0)
    }
}
#endif
