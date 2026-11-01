import XCTest
@testable import AgentDeck

final class OpenCodeDeviceQuestionTests: XCTestCase {
    func testPermissionDecisionRejectsStaleQuestionInvalidIndicesAndBooleans() {
        XCTAssertEqual(OpenCodeDevicePermission.decision(command: ["index": 0, "question": "bash: harmless probe"], question: "bash: harmless probe"), "allow")
        XCTAssertEqual(OpenCodeDevicePermission.decision(command: ["index": 1, "question": "bash: harmless probe"], question: "bash: harmless probe"), "deny")
        for index in [-1, 2, true, "0"] as [Any] {
            XCTAssertNil(OpenCodeDevicePermission.decision(command: ["index": index, "question": "bash: harmless probe"], question: "bash: harmless probe"))
        }
        XCTAssertNil(OpenCodeDevicePermission.decision(command: ["index": 0, "question": "Choose target"], question: "bash: harmless probe"))
        XCTAssertNil(OpenCodeDevicePermission.decision(command: ["index": 0], question: "bash: harmless probe"))
    }

    func testPendingAnswerRequiresUpstreamResolutionAndFailedReplyCanRetry() throws {
        let prompt = try XCTUnwrap(OpenCodeDeviceQuestion.parse([["question": "Target?", "options": [["label": "Local"], ["label": "Review"]]]]))
        var state = OpenCodeWaitState()
        state.consume(event: "opencode_question_asked", id: "q", title: "Target?", prompt: prompt, answerable: true)
        state.markSending(id: "q")
        XCTAssertEqual(state.first?.sending, true)
        state.consume(event: "opencode_question_asked", id: "q", title: "Target?", prompt: prompt, answerable: true)
        XCTAssertEqual(state.first?.sending, true, "a duplicate hook is not an acknowledgement")
        state.consume(event: "opencode_question_asked", id: "q", title: "Target?", prompt: prompt, answerable: true, replyFailed: true)
        XCTAssertEqual(state.first?.sending, false)
        XCTAssertEqual(state.first?.replyError, true)
        state.consume(event: "opencode_question_replied", id: "old", title: nil)
        XCTAssertEqual(state.first?.id, "q")
        state.consume(event: "opencode_question_unavailable", id: "q", title: nil)
        XCTAssertNil(state.first)
    }

    func testSharedRequestVectors() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/opencode-question-vectors.json"))
        let cases = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        for row in cases {
            let name = row["name"] as? String ?? "vector"
            let prompt = OpenCodeDeviceQuestion.parse(row["questions"])
            guard let expected = row["expected"] as? [String: Any] else {
                XCTAssertNil(prompt, name)
                continue
            }
            XCTAssertEqual(prompt?.question, expected["question"] as? String, name)
            XCTAssertEqual(prompt?.options.map(\.label), expected["labels"] as? [String], name)
            XCTAssertEqual(prompt?.replyable, expected["replyable"] as? Bool, name)
        }
    }
}
