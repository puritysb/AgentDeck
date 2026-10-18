import XCTest
@testable import AgentDeck

@MainActor
final class MonitorAttentionSelectionTests: XCTestCase {
    func testInspectingSecondWaitingSessionShowsItsQuestionWithoutMovingControlFocus() throws {
        let first = waitingSession("first", question: "Approve first task?")
        let second = waitingSession("second", question: "Approve second task?")
        var state = DashboardState()
        state.siblingSessions = [first, second]
        state.focusedSessionId = first.id
        let inspection = DashboardInspection()

        inspection.select(second.id, state: state)
        let featured = try XCTUnwrap(MonitorAttentionSelection.featuredSession(
            in: state.siblingSessions,
            inspectedSessionID: inspection.sessionId,
            controlFocusedSessionID: state.focusedSessionId))

        XCTAssertEqual(featured.id, second.id)
        XCTAssertEqual(featured.question, "Approve second task?")
        XCTAssertEqual(state.focusedSessionId, first.id)
        XCTAssertNotEqual(featured.id, state.focusedSessionId,
                          "The inspected card must not qualify for another session's aggregate prompt options")

        inspection.select(nil, state: state)
        XCTAssertEqual(MonitorAttentionSelection.featuredSession(
            in: state.siblingSessions,
            inspectedSessionID: inspection.sessionId,
            controlFocusedSessionID: state.focusedSessionId)?.id, first.id)
    }

    func testInspectionOutsideAwaitingRosterPreservesControlAndSortedFallbacks() {
        let first = waitingSession("first", question: "First question")
        let focused = waitingSession("focused", question: "Focused question")
        let waiting = [first, focused]

        XCTAssertEqual(MonitorAttentionSelection.featuredSession(
            in: waiting, inspectedSessionID: "answered", controlFocusedSessionID: focused.id)?.id, focused.id)
        XCTAssertEqual(MonitorAttentionSelection.featuredSession(
            in: waiting, inspectedSessionID: "answered", controlFocusedSessionID: "working")?.id, first.id)
        XCTAssertNil(MonitorAttentionSelection.featuredSession(
            in: [], inspectedSessionID: first.id, controlFocusedSessionID: focused.id))
    }

    private func waitingSession(_ id: String, question: String) -> SessionInfo {
        var session = SessionInfo(id: id, port: 9120, projectName: "Same project")
        session.alive = true
        session.state = "awaiting_permission"
        session.question = question
        return session
    }
}
