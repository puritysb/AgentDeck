import XCTest
@testable import AgentDeck

#if os(macOS)
/// #632: a session-addressed command deferred past a focus change must reach
/// the session it named, or nothing — never the session focused at send time.
final class SessionFocusRelayTargetTests: XCTestCase {
    func testRefusesWhenFocusMovedToAnotherSession() async {
        let relay = SessionFocusRelay()
        await relay.focusLocal(sessionId: "sess-a")
        await relay.focusLocal(sessionId: "sess-b") // arrives before A's deferred route

        let routed = await relay.routeCommand(["type": "send_prompt", "text": "for A"], to: "sess-a")

        XCTAssertFalse(routed)
        let focused = await relay.focusedSessionId
        XCTAssertEqual(focused, "sess-b")
    }

    func testRoutesWhenTargetIsStillFocused() async {
        let relay = SessionFocusRelay()
        await relay.focusLocal(sessionId: "sess-a")

        // A local observed focus consumes routed commands (no bridge to write to).
        let routed = await relay.routeCommand(["type": "interrupt"], to: "sess-a")

        XCTAssertTrue(routed)
    }

    func testRefusesWithNoFocus() async {
        let relay = SessionFocusRelay()
        let routed = await relay.routeCommand(["type": "interrupt"], to: "sess-a")
        XCTAssertFalse(routed)
    }
}
#endif
