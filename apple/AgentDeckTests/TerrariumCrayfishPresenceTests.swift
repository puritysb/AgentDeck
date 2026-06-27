#if os(macOS)
import XCTest
@testable import AgentDeck

/// Presence-driven SSOT parity with Android `TerrariumStateTest`: the crayfish
/// (OpenClaw) tracks the emitted OpenClaw SESSION, never raw gateway flags. No
/// session row ⇒ dormant (hidden), regardless of reachability/auth/error — the
/// regression lock for the "OpenClaw won't go away" phantom trace.
final class TerrariumCrayfishPresenceTests: XCTestCase {

    private func openClawSession(state: String = "idle") -> SessionInfo {
        SessionInfo(id: "openclaw-gateway", port: 18789, projectName: "OpenClaw",
                    agentType: "openclaw", alive: true, state: state)
    }

    func testReachableWithoutSessionHidesCrayfish() {
        var s = DashboardState()
        s.state = .idle
        s.gatewayAvailable = true
        s.gatewayConnected = false
        let t = s.toTerrariumState()
        XCTAssertFalse(t.crayfishVisible)
        XCTAssertEqual(t.crayfishState, .dormant)
    }

    func testStuckConnectedWithoutSessionHidesCrayfish() {
        // Phantom-trace scenario: a stale gatewayConnected=true but the daemon
        // emitted no openclaw session — the crayfish must stay hidden.
        var s = DashboardState()
        s.state = .idle
        s.gatewayConnected = true
        s.siblingSessions = []
        let t = s.toTerrariumState()
        XCTAssertFalse(t.crayfishVisible)
        XCTAssertEqual(t.crayfishState, .dormant)
    }

    func testEmittedSessionShowsCrayfishAtRest() {
        var s = DashboardState()
        s.state = .idle
        s.gatewayConnected = true
        s.siblingSessions = [openClawSession()]
        let t = s.toTerrariumState()
        XCTAssertTrue(t.crayfishVisible)
        XCTAssertEqual(t.crayfishState, .sitting)
    }

    func testProcessingSessionRoutesCrayfish() {
        var s = DashboardState()
        s.state = .processing
        s.gatewayConnected = true
        s.siblingSessions = [openClawSession(state: "processing")]
        let t = s.toTerrariumState()
        XCTAssertEqual(t.crayfishState, .routing)
    }

    func testErrorWithLiveSessionIsSick() {
        var s = DashboardState()
        s.state = .idle
        s.gatewayConnected = true
        s.gatewayHasError = true
        s.siblingSessions = [openClawSession()]
        let t = s.toTerrariumState()
        XCTAssertEqual(t.crayfishState, .sick)
    }

    func testErrorWithoutSessionDoesNotSpawnCrayfish() {
        var s = DashboardState()
        s.state = .idle
        s.gatewayAvailable = true
        s.gatewayConnected = false
        s.gatewayHasError = true
        let t = s.toTerrariumState()
        XCTAssertFalse(t.crayfishVisible)
        XCTAssertEqual(t.crayfishState, .dormant)
    }
}
#endif
