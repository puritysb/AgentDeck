import XCTest
@testable import AgentDeck

/// Phase-resolution truth table. This covers what the overlay *renders* for a
/// given state — it deliberately cannot cover whether that state is ever
/// reached, which is what `ForegroundSearchBoundTests` below is for.
final class ConnectionOverlayTests: XCTestCase {
    func testForegroundSearchShowsActivity() {
        let phase = ConnectionOverlayPhase.resolve(
            localNetworkDenied: false,
            isReconnecting: false,
            isConnecting: false,
            isAutoConnecting: true
        )

        XCTAssertEqual(phase, .searching)
        XCTAssertEqual(phase.statusText, ConnectionLexicon.searching)
        XCTAssertTrue(phase.showsActivityIndicator)
    }

    func testConnectingToKnownAddressShowsActivity() {
        let phase = ConnectionOverlayPhase.resolve(
            localNetworkDenied: false,
            isReconnecting: false,
            isConnecting: true,
            isAutoConnecting: false
        )

        XCTAssertEqual(phase, .connecting)
        XCTAssertTrue(phase.showsActivityIndicator)
    }

    func testCompletedEmptySearchIsTerminalAndDoesNotSpin() {
        let phase = ConnectionOverlayPhase.resolve(
            localNetworkDenied: false,
            isReconnecting: false,
            isConnecting: false,
            isAutoConnecting: false
        )

        XCTAssertEqual(phase, .notFound)
        XCTAssertEqual(phase.statusText, ConnectionLexicon.nothingDiscovered)
        XCTAssertFalse(phase.showsActivityIndicator)
    }

    func testPermissionDenialOutranksSearchAndDoesNotSpin() {
        let phase = ConnectionOverlayPhase.resolve(
            localNetworkDenied: true,
            isReconnecting: false,
            isConnecting: false,
            isAutoConnecting: true
        )

        XCTAssertEqual(phase, .localNetworkDenied)
        XCTAssertFalse(phase.showsActivityIndicator)
    }

    func testReconnectOutranksOtherConnectionWork() {
        let phase = ConnectionOverlayPhase.resolve(
            localNetworkDenied: false,
            isReconnecting: true,
            isConnecting: true,
            isAutoConnecting: true
        )

        XCTAssertEqual(phase, .reconnecting)
        XCTAssertEqual(phase.statusText, ConnectionLexicon.reconnecting)
        XCTAssertFalse(phase.showsActivityIndicator)
    }

    /// The frame before `ContentView.onAppear` starts the waterfall must not
    /// advertise a failed search that never ran.
    func testNotYetStartedSearchDoesNotClaimNothingFound() {
        let phase = ConnectionOverlayPhase.resolve(
            localNetworkDenied: false,
            isReconnecting: false,
            isConnecting: false,
            isAutoConnecting: false,
            hasStartedForegroundSearch: false
        )

        XCTAssertEqual(phase, .searching)
    }
}

/// The invariant the 2.1(a) rejection was actually about: the visible search
/// indicator must be *bounded*, and every exit must land on a state the user can
/// act from.
///
/// `ConnectionOverlayPhase.resolve` cannot express this — it mirrors its inputs,
/// so it stays green even if `isAutoConnecting` is stuck true forever. These
/// tests drive the real `AgentStateHolder`, with the Bonjour browser suppressed
/// (`isBrowserEnabled = false`) so the empty-network path is deterministic and no
/// Local Network prompt reaches CI.
final class ForegroundSearchBoundTests: XCTestCase {
    private var holder: AgentStateHolder!

    override func setUpWithError() throws {
        try super.setUpWithError()
        #if !DEBUG
        // The browser kill-switch is Debug-only, and a live NWBrowser would find
        // the developer machine's own daemon and connect — there would be no
        // empty network left to assert on.
        throw XCTSkip("empty-network waterfall assertions require the Debug browser kill-switch")
        #else
        // The waterfall tries this before falling back to mDNS; a value left by
        // another test (or a real run on the dev machine) would change the path.
        UserDefaults.standard.removeObject(forKey: "lastBridgeUrl")
        holder = AgentStateHolder(foregroundSearchDeadlineSec: 0.4)
        holder.discovery.isBrowserEnabled = false
        #endif
    }

    override func tearDown() {
        holder?.prepareForTermination()
        holder = nil
        UserDefaults.standard.removeObject(forKey: "lastBridgeUrl")
        super.tearDown()
    }

    private func phase() -> ConnectionOverlayPhase {
        .resolve(
            localNetworkDenied: holder.discovery.localNetworkDenied,
            isReconnecting: holder.connection.isReconnecting,
            isConnecting: holder.connection.status == .connecting,
            isAutoConnecting: holder.isAutoConnecting,
            hasStartedForegroundSearch: holder.hasStartedForegroundSearch
        )
    }

    /// Spin the main run loop — `Timer` and `DispatchQueue.main.asyncAfter` work
    /// inside the waterfall, and neither fires under a plain sleep.
    private func settle(_ seconds: TimeInterval) {
        let done = expectation(description: "run loop settled")
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { done.fulfill() }
        wait(for: [done], timeout: seconds + 5)
    }

    func testIndicatorStopsWithoutAnyBridge() {
        holder.startConnectionWaterfall()
        XCTAssertTrue(holder.isAutoConnecting, "waterfall should light the indicator")
        XCTAssertEqual(phase(), .searching)

        settle(1.0)

        XCTAssertFalse(holder.isAutoConnecting, "the bounded search must end on its own")
        XCTAssertEqual(phase(), .notFound, "and settle on the actionable terminal state")
        XCTAssertFalse(phase().showsActivityIndicator)
    }

    /// A stop the user can see must be a stop the state machine agrees with.
    /// Tearing down only the socket used to leave the indicator running with no
    /// work behind it and no recovery affordance — the rejected screen.
    func testUserStopLandsOnTerminalStateImmediately() {
        holder.startConnectionWaterfall()
        XCTAssertTrue(holder.isAutoConnecting)

        holder.stopConnectionAttempts()

        XCTAssertFalse(holder.isAutoConnecting)
        XCTAssertEqual(phase(), .notFound)
    }

    /// Search Again must never be a no-op. `startConnectionWaterfall()` alone
    /// returns early whenever a stage is left over, so the button routes through
    /// `retryConnectionWaterfall()` instead.
    func testRetryRearmsSearchAfterAStop() {
        holder.startConnectionWaterfall()
        holder.stopConnectionAttempts()
        XCTAssertEqual(phase(), .notFound)

        holder.retryConnectionWaterfall()

        XCTAssertTrue(holder.isAutoConnecting, "Search Again must restart the search")
        XCTAssertEqual(phase(), .searching)

        settle(1.0)
        XCTAssertEqual(phase(), .notFound, "and the restarted search is bounded too")
    }

    /// The deadline is a backstop for exits that forget to report, so it must
    /// hold even when the waterfall is re-entered.
    func testRepeatedStartsDoNotLeakAnUnboundedIndicator() {
        holder.startConnectionWaterfall()
        holder.startConnectionWaterfall()  // no-ops on the stage guard
        settle(1.0)

        XCTAssertFalse(holder.isAutoConnecting)
        XCTAssertEqual(phase(), .notFound)
    }
}
