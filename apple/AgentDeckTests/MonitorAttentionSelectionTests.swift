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

    func testInspectionFollowsDeclaredFoldMembershipWhenRepresentativeChanges() throws {
        let hardware = waitingSession("hardware", question: "Hardware question")
        var original = waitingSession("group-first", question: "First group question")
        original.foldedSessionIds = ["group-first", "group-next"]
        var state = DashboardState()
        state.siblingSessions = [hardware, original]
        state.focusedSessionId = hardware.id
        let inspection = DashboardInspection()
        inspection.select(original.id, state: state)

        var replacement = waitingSession("group-next", question: "Next group question")
        replacement.foldedSessionIds = original.foldedSessionIds
        state.siblingSessions = [hardware, replacement]
        let featured = try XCTUnwrap(MonitorAttentionSelection.featuredSession(
            in: state.siblingSessions,
            inspectedSessionID: inspection.sessionId,
            controlFocusedSessionID: state.focusedSessionId))

        XCTAssertEqual(inspection.sessionId, original.id, "The existing local selection survives roster updates")
        XCTAssertEqual(featured.id, replacement.id)
        XCTAssertEqual(featured.question, "Next group question")
        XCTAssertEqual(state.focusedSessionId, hardware.id)
    }

    func testExactInspectionWinsOverAliasesAndControlFocusNeverFollowsAliases() {
        let fallback = waitingSession("fallback", question: "First sorted question")
        let exact = waitingSession("member", question: "Exact question")
        var folded = waitingSession("representative", question: "Folded question")
        folded.foldedSessionIds = [folded.id, exact.id]

        XCTAssertEqual(MonitorAttentionSelection.featuredSession(
            in: [fallback, folded, exact], inspectedSessionID: exact.id,
            controlFocusedSessionID: fallback.id)?.id, exact.id)
        XCTAssertEqual(MonitorAttentionSelection.featuredSession(
            in: [fallback, folded], inspectedSessionID: nil,
            controlFocusedSessionID: exact.id)?.id, fallback.id,
                       "A folded display alias cannot make another session the control-focused card")
    }

    private func waitingSession(_ id: String, question: String) -> SessionInfo {
        var session = SessionInfo(id: id, port: 9120, projectName: "Same project")
        session.alive = true
        session.state = "awaiting_permission"
        session.question = question
        return session
    }
}
