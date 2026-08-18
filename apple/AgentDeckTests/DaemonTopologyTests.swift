#if os(macOS)
// The three daemon topologies, driven as sequences.
//
// A Mac running AgentDeck is in exactly one of three states — no daemon, the
// in-process Swift daemon, or a terminal-managed Node daemon with this app as
// its client — and every feature has to behave in all three. Before this file
// the transitions between them had no test at all: `DaemonService` carried the
// topology as two independent booleans and inferred the promotion edge from a
// `didSet` on one of them, across ten write sites.
//
// These tests drive TRANSITION SEQUENCES rather than asking the predicate what
// it returns for a given pair, because the defect this file was written for is
// only visible as a sequence: `client → settings restart → client` reported a
// promotion in the middle, and a promotion purges the usage state the external
// daemon relayed.

import XCTest
@testable import AgentDeck

final class DaemonTopologyTests: XCTestCase {

    /// Replays a run and returns how many promotions it reported.
    private func promotions(_ changes: [DaemonOwnershipChange],
                            from start: DaemonOwnership = .none) -> Int {
        var state = start
        var count = 0
        for change in changes {
            if state.promotes(change) { count += 1 }
            state = state.applying(change)
        }
        return count
    }

    private func finalState(_ changes: [DaemonOwnershipChange],
                            from start: DaemonOwnership = .none) -> DaemonOwnership {
        changes.reduce(start) { $0.applying($1) }
    }

    // MARK: - The three topologies are three states

    func testTheThreeTopologiesAreMutuallyExclusive() {
        // Tier 1 (app alone), Tier 2 (Node daemon + app as client), and neither.
        // No state may claim both tiers, and none may claim neither-nor.
        for state in [DaemonOwnership.none, .selfOwned, .external] {
            XCTAssertFalse(state.isSelfDaemon && state.isUsingExternalDaemon,
                           "\(state) claims to be both tiers at once")
        }
        XCTAssertTrue(DaemonOwnership.selfOwned.isSelfDaemon)
        XCTAssertTrue(DaemonOwnership.external.isUsingExternalDaemon)
        XCTAssertFalse(DaemonOwnership.none.isSelfDaemon)
        XCTAssertFalse(DaemonOwnership.none.isUsingExternalDaemon)
    }

    // MARK: - Cold start into each topology

    func testColdStartIntoTheSwiftDaemonIsNotAPromotion() {
        // App launches with nothing on the port and binds. There was no
        // external daemon and therefore no relayed state to invalidate, so
        // firing the promotion callback here would purge nothing and mean
        // nothing.
        XCTAssertEqual(promotions([.tookOwnership]), 0)
        XCTAssertEqual(finalState([.tookOwnership]), .selfOwned)
    }

    func testColdStartIntoClientModeIsNotAPromotion() {
        // App launches, finds a Node daemon already on the port, becomes its
        // WebSocket client. Tier 2 surfaces light up; nothing is promoted.
        XCTAssertEqual(promotions([.becameClient]), 0)
        XCTAssertEqual(finalState([.becameClient]), .external)
    }

    // MARK: - The one real promotion

    func testExternalDaemonDisappearingPromotesExactlyOnce() {
        // The Node daemon goes away mid-session and the app takes the port.
        // This is the only edge that must fire `onPromotedToOwner`: the app
        // cannot produce Claude quota or subscription rows itself, so the
        // relayed copies have to be cleared rather than left as a stale trace.
        XCTAssertEqual(promotions([.becameClient, .tookOwnership]), 1)
        XCTAssertEqual(finalState([.becameClient, .tookOwnership]), .selfOwned)
    }

    func testHealthCheckPromotionFollowedByABindDoesNotFireTwice() {
        // `checkDaemonHealth` records the promotion and then calls `start()`,
        // which records `.tookOwnership` again when the bind succeeds. The
        // second one is already-owner → already-owner and must be silent, or
        // the usage state would be purged twice for one event.
        XCTAssertEqual(promotions([.becameClient, .tookOwnership, .tookOwnership]), 1)
    }

    // MARK: - Teardown is not a promotion  (the regression this file exists for)

    func testTearingDownWhileInClientModeReportsNoPromotion() {
        // `stop()` used to write the same `false` a promotion writes, so
        // quitting or restarting while connected to a Node daemon fired
        // `onPromotedToOwner` and blanked every usage gauge.
        XCTAssertEqual(promotions([.becameClient, .toreDown]), 0)
        XCTAssertEqual(finalState([.becameClient, .toreDown]), .none)
    }

    func testSettingsRestartWhileOnAnExternalDaemonNeverPromotes() {
        // The exact user-visible path: the app is a client, the user changes
        // the daemon port or the network posture in Settings, `restart()` runs
        // `stop()` then `start()`, and the app reconnects to the same external
        // daemon. Nothing was ever promoted, so the Claude quota, Codex rate
        // limits, subscriptions and Antigravity status must survive it.
        let restart: [DaemonOwnershipChange] = [.becameClient, .toreDown, .becameClient]
        XCTAssertEqual(promotions(restart), 0)
        XCTAssertEqual(finalState(restart), .external)
    }

    func testListenerFailureAndRetryAsOwnerNeverPromotes() {
        // Owning the port, the listener dies, we tear down and rebind. We were
        // never a client, so there is no relayed state and no promotion.
        let flap: [DaemonOwnershipChange] = [.tookOwnership, .toreDown, .tookOwnership]
        XCTAssertEqual(promotions(flap), 0)
        XCTAssertEqual(finalState(flap), .selfOwned)
    }

    // MARK: - Longer runs

    func testAFullDayOfHandoversPromotesOncePerTakeover() {
        // Node daemon starts and stops repeatedly under the app: each time the
        // app takes the port back it is a fresh promotion, and each teardown
        // in between is not.
        let day: [DaemonOwnershipChange] = [
            .tookOwnership,                 // app boots alone
            .toreDown, .becameClient,       // user starts `agentdeck daemon start`
            .tookOwnership,                 // CLI daemon quits, app takes over   ← 1
            .toreDown, .becameClient,       // CLI daemon comes back
            .toreDown,                      // user quits the app while it is a client
        ]
        XCTAssertEqual(promotions(day), 1)
        XCTAssertEqual(finalState(day), .none)
    }

    func testEveryChangeLandsInADefinedState() {
        // Exhaustive over states × changes: no transition may leave the
        // topology undefined, which is what would let a fourth state exist.
        for state in [DaemonOwnership.none, .selfOwned, .external] {
            for change in [DaemonOwnershipChange.tookOwnership, .becameClient, .toreDown] {
                let next = state.applying(change)
                XCTAssertTrue([.none, .selfOwned, .external].contains(next),
                              "\(state) + \(change) landed outside the three topologies")
                // A promotion is only ever reported when the result actually
                // owns the daemon.
                if state.promotes(change) {
                    XCTAssertEqual(next, .selfOwned)
                    XCTAssertEqual(state, .external)
                }
            }
        }
    }
}
#endif
