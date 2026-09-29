#if os(macOS)
import XCTest
import SwiftUI
@testable import AgentDeck

/// Presence-driven SSOT parity with Android `TerrariumStateTest`: the crayfish
/// (OpenClaw) tracks the emitted OpenClaw SESSION, never raw gateway flags. No
/// session row ⇒ dormant (hidden), regardless of reachability/auth/error — the
/// regression lock for the "OpenClaw won't go away" phantom trace.
final class TerrariumCrayfishPresenceTests: XCTestCase {

    @MainActor
    func testTransparentHabitatRetainsLiveCreaturePixels() throws {
        var state = DashboardState()
        state.state = .idle
        state.siblingSessions = [openClawSession()]
        let renderer = TerrariumRenderer()
        for _ in 0..<120 { renderer.update(dt: 1.0 / 60, state: state.toTerrariumState()) }
        let image = ImageRenderer(content: Canvas { context, size in
            renderer.draw(context: &context, size: size, includeHabitat: false)
        }.frame(width: 400, height: 300))
        image.scale = 1
        let bitmap = NSBitmapImageRep(cgImage: try XCTUnwrap(image.cgImage))
        XCTAssertEqual(try XCTUnwrap(bitmap.colorAt(x: 0, y: 0)).alphaComponent, 0, accuracy: 0.01)
        var painted = 0
        for y in stride(from: 0, to: 300, by: 4) {
            for x in stride(from: 0, to: 400, by: 4) {
                if (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 { painted += 1 }
            }
        }
        XCTAssertGreaterThan(painted, 10, "The transparent 3D overlay must still render the live session creature")
    }

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
