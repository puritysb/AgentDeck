#if AGENTDECK_CLOUDKIT_POC
import XCTest
@testable import AgentDeck

final class RemoteGlanceTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func summary(age: TimeInterval, working: Int, waiting: Int) -> RemoteRosterSummary {
        RemoteRosterSummary(schemaVersion: 1, observedAt: now.addingTimeInterval(-age),
                            workingCount: working, waitingCount: waiting)
    }

    func testWaitOutranksWorkAndKeepsWorkingCount() {
        let glance = RemoteGlance.make(summary(age: 10, working: 3, waiting: 2), at: now)
        XCTAssertEqual(glance.headline, .needsYou(2))
        XCTAssertEqual(glance.workingCount, 3)
        XCTAssertFalse(glance.historical)
    }

    func testAllClearRequiresAnObservedEmptyRoster() {
        XCTAssertEqual(RemoteGlance.make(summary(age: 10, working: 0, waiting: 0), at: now).headline, .allClear)
        XCTAssertEqual(RemoteGlance.make(nil, at: now), .unavailable)
    }

    func testOldObservationIsHistoricalNotRefreshed() {
        let old = summary(age: RemoteObservationPolicy.historicalAfter + 1, working: 1, waiting: 0)
        let glance = RemoteGlance.make(old, at: now)
        XCTAssertEqual(glance.headline, .working(1))
        XCTAssertTrue(glance.historical)
        XCTAssertEqual(glance.observedAt, old.observedAt)
    }

    func testExpiredOrFutureEvidenceShowsNoCounts() {
        let expired = summary(age: RemoteObservationPolicy.readerLifetime, working: 0, waiting: 4)
        XCTAssertEqual(RemoteGlance.make(expired, at: now), .unavailable)
        let future = summary(age: -60, working: 0, waiting: 4)
        XCTAssertEqual(RemoteGlance.make(future, at: now), .unavailable)
    }

    func testTimelineTransitionsFollowTheSameSummary() {
        let fresh = summary(age: 30, working: 1, waiting: 1)
        let points = RemoteGlance.transitions(for: fresh, after: now)
        XCTAssertEqual(points.count, 2)
        XCTAssertTrue(RemoteGlance.make(fresh, at: points[0]).historical)
        XCTAssertEqual(RemoteGlance.make(fresh, at: points[1]), .unavailable)
        let old = summary(age: RemoteObservationPolicy.historicalAfter + 5, working: 1, waiting: 0)
        XCTAssertEqual(RemoteGlance.transitions(for: old, after: now).count, 1)
        XCTAssertTrue(RemoteGlance.transitions(for: nil, after: now).isEmpty)
    }
}
#endif
