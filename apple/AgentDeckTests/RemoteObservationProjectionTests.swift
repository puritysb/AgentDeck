#if AGENTDECK_CLOUDKIT_POC
import XCTest
@testable import AgentDeck

final class RemoteObservationProjectionTests: XCTestCase {
    private func session(_ id: String, waiting: Bool, alive: Bool = true) -> RemoteSessionEvidence {
        .init(localID: id, alive: alive, working: !waiting, waitingForResponse: waiting)
    }

    func testWaitEpisodesBaselineRepeatResolveAndReenter() {
        var tracker = RemoteWaitTracker()
        let now = Date()
        XCTAssertTrue(tracker.observe([session("existing", waiting: true)], at: now).started.isEmpty)
        XCTAssertEqual(tracker.currentWaitIDs.count, 1)
        let baselineIDs = tracker.currentWaitIDs
        _ = tracker.observe([session("existing", waiting: true)], at: now)
        XCTAssertEqual(tracker.currentWaitIDs, baselineIDs)
        let entered = tracker.observe([session("new", waiting: true)], at: now)
        XCTAssertEqual(entered.started.count, 1)
        XCTAssertEqual(entered.resolved.count, 1)
        XCTAssertTrue(tracker.observe([session("new", waiting: true)], at: now).started.isEmpty)
        let closed = tracker.observe([], at: now)
        XCTAssertEqual(closed.resolved, entered.started)
        XCTAssertNotEqual(tracker.observe([session("new", waiting: true)], at: now).started, entered.started)
    }

    func testUnknownGapDoesNotResolveOrReplayWait() {
        var tracker = RemoteWaitTracker()
        let now = Date()
        _ = tracker.observe([], at: now)
        let entered = tracker.observe([session("a", waiting: true)], at: now)
        tracker.invalidate()
        let recovered = tracker.observe([session("a", waiting: true)], at: now)
        XCTAssertTrue(recovered.started.isEmpty)
        XCTAssertTrue(recovered.resolved.isEmpty)
        XCTAssertEqual(tracker.observe([], at: now).resolved, entered.started)
    }

    func testSummaryOmitsPrivateIdentifiersAndPreservesSourceAge() throws {
        var tracker = RemoteWaitTracker()
        let original = Date(timeIntervalSince1970: 1000)
        let summary = tracker.observe([session("private-path-or-session", waiting: false),
            session("dead", waiting: true, alive: false)], at: original).summary
        let bytes = try JSONEncoder().encode(summary)
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("private-path-or-session"))
        let fetched = try JSONDecoder().decode(RemoteRosterSummary.self, from: bytes)
        XCTAssertEqual(fetched.workingCount, 1)
        XCTAssertEqual(fetched.waitingCount, 0)
        XCTAssertEqual(fetched.freshness(at: original.addingTimeInterval(181)), .historical)
        XCTAssertEqual(fetched.freshness(at: original.addingTimeInterval(-1)), .unknown)
        XCTAssertEqual(fetched.freshness(at: original.addingTimeInterval(604800)), .expired)
    }
}
#endif
