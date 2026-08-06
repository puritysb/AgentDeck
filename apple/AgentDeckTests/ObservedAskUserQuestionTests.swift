#if os(macOS)
import XCTest
@testable import AgentDeck

final class ObservedAskUserQuestionTests: XCTestCase {
    func testParsesStructuredQuestionOptionsAndToolUseId() {
        let parsed = DaemonServer.askUserQuestionPresentation(from: [
            "tool_name": "AskUserQuestion",
            "tool_use_id": "toolu-ask-1",
            "tool_input": [
                "questions": [[
                    "question": "  응답 대기 PR/이슈에   stale nudge를 게시할까요? ",
                    "header": "유예기간",
                    "options": [
                        ["label": "14일 유예 후 close", "description": "표준 유예"],
                        ["label": "7일 유예 후 close", "description": "빠른 정리"],
                    ],
                    "multiSelect": false,
                ]],
            ],
        ])

        XCTAssertEqual(parsed?.toolUseId, "toolu-ask-1")
        XCTAssertEqual(parsed?.question, "응답 대기 PR/이슈에 stale nudge를 게시할까요?")
        XCTAssertEqual(parsed?.options.count, 2)
        XCTAssertEqual(parsed?.options[0]["index"]?.value as? Int, 0)
        XCTAssertEqual(parsed?.options[0]["label"]?.value as? String, "14일 유예 후 close")
        XCTAssertEqual(parsed?.options[1]["index"]?.value as? Int, 1)
        XCTAssertEqual(parsed?.options[1]["label"]?.value as? String, "7일 유예 후 close")
        XCTAssertNil(parsed?.promptType)
    }

    func testRejectsMissingToolUseIdOrChoices() {
        XCTAssertNil(DaemonServer.askUserQuestionPresentation(from: [
            "tool_name": "AskUserQuestion",
            "tool_input": [
                "questions": [[
                    "question": "Choose one",
                    "options": [["label": "A"]],
                ]],
            ],
        ]))
        XCTAssertNil(DaemonServer.askUserQuestionPresentation(from: [
            "tool_name": "AskUserQuestion",
            "tool_use_id": "toolu-empty",
            "tool_input": [
                "questions": [[
                    "question": "Choose one",
                    "options": [],
                ]],
            ],
        ]))
    }

    /// A single call may carry up to four question groups. They are kept whole
    /// and presented in sequence — flattening them into one index space is what
    /// let a press aimed at group 1 select an option of group 2.
    func testKeepsEveryQuestionGroupForSequentialPresentation() {
        let parsed = DaemonServer.askUserQuestionGroups(from: [
            "tool_name": "AskUserQuestion",
            "tool_use_id": "toolu-multi",
            "tool_input": [
                "questions": [
                    ["question": "Pick a language", "options": [["label": "TypeScript"], ["label": "Swift"]]],
                    ["question": "   ", "options": [["label": "dropped"]]],          // no question text
                    ["question": "Pick a target", "options": [["label": "macOS"]], "multiSelect": true],
                    ["question": "No usable options", "options": [["label": "  "]]], // no labels
                ],
            ],
        ])

        XCTAssertEqual(parsed?.toolUseId, "toolu-multi")
        XCTAssertEqual(parsed?.groups.count, 2)
        XCTAssertEqual(parsed?.groups[0].question, "Pick a language")
        XCTAssertNil(parsed?.groups[0].promptType)
        XCTAssertEqual(parsed?.groups[1].question, "Pick a target")
        XCTAssertEqual(parsed?.groups[1].promptType, "multi_select")
        // Each group re-indexes from 0 — indices are only ever meaningful
        // within the group currently on screen.
        XCTAssertEqual(parsed?.groups[1].options[0]["index"]?.value as? Int, 0)

        // The wire projection is the FIRST group, so single-question payloads
        // and the first step of a multi-question one look identical to devices.
        let projection = DaemonServer.askUserQuestionPresentation(from: [
            "tool_name": "AskUserQuestion",
            "tool_use_id": "toolu-multi",
            "tool_input": [
                "questions": [
                    ["question": "Pick a language", "options": [["label": "TypeScript"]]],
                    ["question": "Pick a target", "options": [["label": "macOS"]]],
                ],
            ],
        ])
        XCTAssertEqual(projection?.question, "Pick a language")
    }

    /// The hook contract has no field for supplying a chosen option, so an
    /// answered question resolves as a denial whose reason states the answer.
    /// It has to read as the user's own words, or the model treats the denial
    /// as an obstacle and asks again.
    func testAnswerReasonStatesEveryPairAndForbidsReasking() {
        let reason = ObservedSteering.askAnswerReason(answers: [
            (question: "Pick a language", label: "Swift"),
            (question: "Ship it?", label: "Yes"),
            (question: "Never answered", label: ""),
        ])
        XCTAssertTrue(reason.contains("Q: Pick a language\nA: Swift"))
        XCTAssertTrue(reason.contains("Q: Ship it?\nA: Yes"))
        XCTAssertFalse(reason.contains("Never answered"))
        XCTAssertTrue(reason.contains("do not call AskUserQuestion again"))
        XCTAssertTrue(reason.contains("user's own answers"))
    }

    /// The permission gate's precision guards exist because PreToolUse fires for
    /// calls Claude auto-approves silently. AskUserQuestion always prompts, so
    /// the ask-gate skips them — which is also why it survives the App Store
    /// sandbox, where the rule predictor cannot read ~/.claude and disables the
    /// permission gate outright.
    func testAskGateHoldsWithoutThePermissionPredictorAndKeepsOneGatePerSession() async {
        let steering = ObservedSteering()
        let first = await steering.beginAskGate(sessionId: "sid-ask", clientCount: 1)
        XCTAssertNotNil(first)
        let kind = await steering.gateKind(requestId: first!)
        XCTAssertEqual(kind, .ask)

        // One gate per session, in both directions.
        let second = await steering.beginAskGate(sessionId: "sid-ask", clientCount: 1)
        XCTAssertNil(second)
        let permission = await steering.beginGate(
            sessionId: "sid-ask", tool: "Bash", commandText: "git push",
            permissionMode: "default", cwd: nil, clientCount: 1)
        XCTAssertNil(permission)

        // Nobody to answer ⇒ no hold: a device-less daemon must not stall a
        // question the user is about to answer in their terminal anyway.
        let noClients = await steering.beginAskGate(sessionId: "sid-other", clientCount: 0)
        XCTAssertNil(noClients)
    }

    func testAskGateResolvesAsAnsweredAndReleasesTheSession() async {
        let steering = ObservedSteering()
        let requestId = await steering.beginAskGate(sessionId: "sid-ask", clientCount: 1)
        let held = Task { await steering.awaitGate(requestId: requestId!) }
        // Give awaitGate a moment to install its continuation.
        try? await Task.sleep(nanoseconds: 50_000_000)
        let affected = await steering.resolveGate(requestId: requestId!, decision: "answered")
        XCTAssertEqual(affected, "sid-ask")
        let decision = await held.value
        XCTAssertEqual(decision, "answered")

        // Released — the next question can hold again.
        let again = await steering.beginAskGate(sessionId: "sid-ask", clientCount: 1)
        XCTAssertNotNil(again)
    }

    func testMapsFailureHookToExplicitToolFailureBoundary() {
        XCTAssertEqual(
            DaemonServer.mapHookEventName("PostToolUseFailure"),
            "tool_failure"
        )
    }
}
#endif
