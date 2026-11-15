import XCTest
@testable import AgentDeck

final class WatchGlanceTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func snapshot(age: TimeInterval = 20, state: RemoteSourceState = .observed, working: Int = 1, waiting: Int = 1,
                          rows: [RemoteSessionDetail] = [], usage: [RemoteUsageWindow] = [],
                          expiresIn: TimeInterval = 3_600) -> RemoteObservationSnapshot {
        let observed = state == .observed
        let observedAt = now.addingTimeInterval(-age)
        return RemoteObservationSnapshot(installationID: UUID(), revision: 1, sourceState: state,
            observedAt: observed ? observedAt : nil, publishedAt: observedAt, expiresAt: now.addingTimeInterval(expiresIn),
            workingCount: observed ? working : nil, waitingCount: observed ? waiting : nil, activeEventIDs: [],
            details: observed ? RemoteObservationDetails(sessions: rows, sessionCount: max(rows.count, working + waiting), usage: usage) : nil)
    }

    private func row(_ agent: RemoteSessionDetail.Agent, _ phase: RemoteSessionDetail.Phase) -> RemoteSessionDetail {
        RemoteSessionDetail(agent: agent, phase: phase, startedAt: now.addingTimeInterval(-60), activeSubagents: nil, backgroundJobs: nil)
    }

    private func window(remaining: Double, resetIn: TimeInterval, validFor: TimeInterval? = nil) -> RemoteUsageWindow {
        RemoteUsageWindow(provider: .codex, quantity: .allowance, durationMinutes: 300, remainingPercent: remaining,
                          observedAt: now.addingTimeInterval(-10), resetsAt: now.addingTimeInterval(resetIn),
                          validUntil: validFor.map { now.addingTimeInterval($0) })
    }

    func testWaitOutranksWorkAndOrdersWaitingRowsFirst() {
        let glance = WatchGlance.make(snapshot(working: 2, waiting: 1,
            rows: [row(.codexCLI, .working), row(.claude, .idle), row(.openCode, .response), row(.claude, .working)]), at: now)
        XCTAssertEqual(glance.mode, .needsYou)
        XCTAssertEqual(glance.orderedSessions.map(\.phase), [.response, .working, .working, .idle])
        XCTAssertEqual(glance.orderedSessions[1].agent, .codexCLI, "equal phases keep publisher order")
        XCTAssertEqual(glance.waitingAgents, [.openCode])
    }

    func testAllClearNeedsAnObservedEmptyRosterNeverAMissingOne() {
        XCTAssertEqual(WatchGlance.make(snapshot(working: 0, waiting: 0), at: now).mode, .allClear)
        XCTAssertEqual(WatchGlance.make(nil, at: now), .unavailable)
        let unavailable = WatchGlance.make(snapshot(state: .unavailable), at: now)
        XCTAssertEqual(unavailable.mode, .sourceUnavailable)
        XCTAssertFalse(unavailable.hasCounts)
        XCTAssertEqual(WatchGlance.make(snapshot(state: .disabled), at: now).mode, .sharingStopped)
    }

    func testOldObservationIsHistoricalWithItsOriginalTime() {
        let old = snapshot(age: RemoteObservationPolicy.historicalAfter + 1, working: 3, waiting: 0)
        let glance = WatchGlance.make(old, at: now)
        XCTAssertEqual(glance.mode, .working)
        XCTAssertTrue(glance.historical)
        XCTAssertEqual(glance.observedAt, old.observedAt)
    }

    func testExpiredOrFutureEvidenceShowsNoCounts() {
        XCTAssertEqual(WatchGlance.make(snapshot(expiresIn: 0), at: now), .unavailable)
        XCTAssertEqual(WatchGlance.make(snapshot(age: -60), at: now), .unavailable)
    }

    func testEndedAllowanceDisappearsAndTightestRemainsForTheCorner() {
        let snap = snapshot(usage: [window(remaining: 70, resetIn: 600), window(remaining: 20, resetIn: 900, validFor: 120),
                                    window(remaining: 45, resetIn: 1_200)])
        XCTAssertEqual(WatchGlance.make(snap, at: now).lowestUsage?.remainingPercent, 20)
        let later = WatchGlance.make(snap, at: now.addingTimeInterval(300))
        XCTAssertEqual(later.usage.map(\.remainingPercent), [70, 45], "a window past validity is gone, not full")
        XCTAssertEqual(later.lowestUsage?.remainingPercent, 45)
    }

    func testTimelineTransitionsAgeTheSameSnapshot() {
        let snap = snapshot(age: 30, usage: [window(remaining: 50, resetIn: 600)], expiresIn: 7_200)
        let points = WatchGlance.transitions(for: snap, after: now)
        XCTAssertEqual(points, points.sorted())
        XCTAssertTrue(points.contains { WatchGlance.make(snap, at: $0).historical })
        XCTAssertTrue(points.contains { WatchGlance.make(snap, at: $0).usage.isEmpty })
        XCTAssertEqual(WatchGlance.make(snap, at: points.last!), .unavailable)
        XCTAssertTrue(WatchGlance.transitions(for: nil, after: now).isEmpty)
    }
}
