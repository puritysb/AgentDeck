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
}
