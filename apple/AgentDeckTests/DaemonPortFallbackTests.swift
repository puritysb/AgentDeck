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
}
#endif
