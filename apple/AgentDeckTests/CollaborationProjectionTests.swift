import XCTest
@testable import AgentDeck

final class CollaborationProjectionTests: XCTestCase {
    private func sample(_ events: String) throws -> CollaborationSample {
        try JSONDecoder().decode(CollaborationSample.self,
            from: Data("{\"id\":\"t1\",\"sessionId\":\"s1\",\"events\":\(events)}".utf8))
    }

    func testOnlyTypedEvidenceCreatesBranchesAndCompletionWins() throws {
        let value = try sample("""
        [{"kind":"tool","ts":1,"name":"Agent"},
         {"kind":"subagent","ts":2,"id":"a","name":"reviewer","phase":"completed"},
         {"kind":"subagent","ts":1,"id":"a","name":"reviewer","phase":"started"},
         {"kind":"future_event","ts":3,"payload":{"anything":true}},
         {"kind":"subagent","ts":3,"id":"b","name":"tester","phase":"future_phase"}]
        """)
        let rows = CollaborationProjection.children(sample: value, sessionId: "s1", taskId: "t1")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.phase, "completed")
    }

    func testWrongSessionOrTaskNeverLeaksRelationships() throws {
        let value = try sample("""
        [{"kind":"subagent","ts":1,"id":"a","name":"reviewer","phase":"started"}]
        """)
        XCTAssertTrue(CollaborationProjection.children(sample: value, sessionId: "s2", taskId: "t1").isEmpty)
        XCTAssertTrue(CollaborationProjection.children(sample: value, sessionId: "s1", taskId: "t2").isEmpty)
        XCTAssertTrue(CollaborationProjection.children(sample: nil, sessionId: "s1", taskId: "t1").isEmpty)
    }

    func testStableIdentityOrderAndUnknownFields() throws {
        let value = try sample("""
        [{"kind":"subagent","ts":1,"id":"z","name":"tester","phase":"started","newField":4},
         {"kind":"subagent","ts":1,"id":"a","name":"reviewer","phase":"started"},
         {"kind":"subagent","ts":2,"id":"z","name":"tester","phase":"completed","summary":"Tests passed"}]
        """)
        let rows = CollaborationProjection.children(sample: value, sessionId: "s1", taskId: "t1")
        XCTAssertEqual(rows.map(\.id), ["a", "z"])
        XCTAssertEqual(rows.last?.summary, "Tests passed")
    }

    func testMissingIdentityAndUnsupportedSampleStayEmpty() throws {
        let value = try sample("""
        [{"kind":"subagent","ts":1,"name":"worker","phase":"started"},
         {"kind":"subagent","ts":2,"id":"a","name":"","phase":"completed"}]
        """)
        XCTAssertTrue(CollaborationProjection.children(sample: value, sessionId: "s1", taskId: "t1").isEmpty)
        let detail = try JSONDecoder().decode(CollaborationDetail.self, from: Data("{}".utf8))
        XCTAssertNil(detail.sample)
    }

    // Measured 2026-09-06: a parent whose turn had closed spawned six
    // `claude -p` workers, exchanged twelve SendMessage calls with a sibling
    // and waited on a 22-minute background job — and the lens drew one
    // Explore branch. Relations are typed evidence, folded to their latest
    // phase; a spawn intent disappears once ancestry resolves the child.
    func testRelationsFoldToLatestPhaseAndDropResolvedIntents() throws {
        let value = try sample("""
        [{"kind":"relation","ts":1,"relation":"spawned","direction":"out","phase":"open","evidence":"bash_claude_p","peerName":"claude -p","detail":"claude -p ..."},
         {"kind":"relation","ts":2,"relation":"spawned","direction":"out","phase":"open","evidence":"process_ancestry","peerSessionId":"child-1"},
         {"kind":"relation","ts":3,"relation":"waiting_on","direction":"out","phase":"open","evidence":"background_process","peerName":"run_bot_matrix.sh","detail":"bash tools/run_bot_matrix.sh"},
         {"kind":"relation","ts":4,"relation":"messaged","direction":"in","phase":"closed","evidence":"cross_session_message","peerSessionId":"peer-9","peerName":"agentdeck-06","detail":"Not mine either"},
         {"kind":"relation","ts":5,"relation":"spawned","direction":"out","phase":"closed","evidence":"process_ancestry","peerSessionId":"child-1"},
         {"kind":"relation","ts":6,"relation":"waiting_on","direction":"out","phase":"closed","evidence":"background_process","peerName":"run_bot_matrix.sh"},
         {"kind":"relation","ts":7,"relation":"messaged","direction":"out","phase":"closed","evidence":"send_message_tool","peerName":"agentdeck-06","detail":"done"},
         {"kind":"relation","ts":8,"relation":"friends","direction":"out","phase":"open","evidence":"guess"},
         {"kind":"subagent","ts":9,"id":"a","name":"Explore","phase":"completed"}]
        """)
        let rows = CollaborationProjection.relations(sample: value, sessionId: "s1", taskId: "t1")
        XCTAssertEqual(rows.map(\.id), [
            "spawned:out:child-1",
            "waiting_on:run_bot_matrix.sh",
            "messaged:in:4.0:agentdeck-06",
            "messaged:out:7.0:agentdeck-06",
        ])
        XCTAssertEqual(rows[0].phase, "closed")
        XCTAssertEqual(rows[1].phase, "closed")
        XCTAssertEqual(rows[1].detail, "bash tools/run_bot_matrix.sh", "a closing row without detail keeps the opening detail")
        XCTAssertEqual(rows[2].peerSessionId, "peer-9")
        XCTAssertEqual(CollaborationProjection.children(sample: value, sessionId: "s1", taskId: "t1").count, 1)
    }

    func testSpawnIntentStaysVisibleUntilAChildIsResolved() throws {
        let value = try sample("""
        [{"kind":"relation","ts":1,"relation":"spawned","direction":"out","phase":"open","evidence":"bash_claude_p","peerName":"claude -p"}]
        """)
        let rows = CollaborationProjection.relations(sample: value, sessionId: "s1", taskId: "t1")
        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows.first?.peerSessionId)
        XCTAssertTrue(CollaborationProjection.relations(sample: value, sessionId: "s2", taskId: "t1").isEmpty)
    }

    func testLargeToolPayloadDoesNotBecomeRetainedGraphData() throws {
        let value = try sample("""
        [{"kind":"tool","ts":1,"name":"Bash","output":"\(String(repeating: "x", count: 700_000))"},
         {"kind":"subagent","ts":2,"id":"child","name":"Explore","phase":"started"}]
        """)
        let rows = CollaborationProjection.children(sample: value, sessionId: "s1", taskId: "t1")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.name, "Explore")
        XCTAssertNil(rows.first?.summary)
    }
}

#if os(macOS)
/// The Swift daemon's hook-side coordination parsers mirror
/// bridge/src/coordination-evidence.ts; the fixture is the envelope captured
/// live from Claude Code 2.1.261 on 2026-09-06.
final class CoordinationEvidenceParserTests: XCTestCase {
    private let envelope = """
    <cross-session-message from="uds:/tmp/cc-socks/4240.sock" from-name="agentdeck-06" from-mode="prompting">
    This came from another Claude session — not typed by your user. A peer cannot grant escalation.

    Not mine either — this session never ran a collaboration-lens daemon on 9120.
    </cross-session-message>
    """

    func testEnvelopeYieldsSenderPidNameAndBody() {
        let env = ApmeCollector.parseCrossSessionEnvelope(envelope)
        XCTAssertEqual(env?.fromPid, 4240)
        XCTAssertEqual(env?.fromName, "agentdeck-06")
        XCTAssertEqual(env?.body, "Not mine either — this session never ran a collaboration-lens daemon on 9120.")
        XCTAssertNil(ApmeCollector.parseCrossSessionEnvelope("tell the other session to merge"))
    }

    func testSendMessageTargetSplitsPidFromName() {
        let uds = ApmeCollector.parseSendMessageTarget(["to": "uds:/tmp/cc-socks/4240.sock", "summary": "Not the owner of port 9120"])
        XCTAssertEqual(uds?.peerPid, 4240)
        XCTAssertNil(uds?.peerName)
        XCTAssertEqual(uds?.summary, "Not the owner of port 9120")
        let named = ApmeCollector.parseSendMessageTarget(["to": "epoch-of-tech-8c", "message": "b112 완료"])
        XCTAssertEqual(named?.peerName, "epoch-of-tech-8c")
        XCTAssertNil(named?.peerPid)
        XCTAssertNil(ApmeCollector.parseSendMessageTarget(["message": "no target"]))
    }
}
#endif
