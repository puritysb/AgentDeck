#if AGENTDECK_CLOUDKIT_POC
import XCTest
@testable import AgentDeck

final class RemoteObservationPersistenceTests: XCTestCase {
    #if os(macOS)
    private final class ProbeCount: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func note() { lock.lock(); value += 1; lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    }
    @MainActor
    func testHostedAppDoesNotResumeRealSavedConsentOrContactCloudKit() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let disk = RemoteProbeDisk(directory: root)
        var saved = RemotePublisherState(account: "a"); saved.enabled = true
        try disk.write(saved, to: "publisher.json")
        let calls = ProbeCount()
        let store = CloudKitProbeStore(accountStatus: { calls.note(); $0.finish(.success(.noAccount)) })
        let model = LocalRosterProbeModel(disk: disk, store: store)
        await model.restoreWhenReady()
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertFalse(model.automatic)
        XCTAssertEqual(calls.count, 0, "a hosted XCTest root must not adopt saved sharing consent")
        XCTAssertEqual(disk.read("publisher.json", as: RemotePublisherState.self)?.enabled, true)
        model.stop(cancelWrites: false)
    }
    #endif

    func testReaderSurvivesRestartWithOriginalTimeAndRejectsAnotherAccount() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let disk = RemoteProbeDisk(directory: root)
        let time = Date(timeIntervalSince1970: 1_000)
        let value = RemoteRosterSummary(schemaVersion: 1, observedAt: time, workingCount: 2, waitingCount: 1)
        try RemoteReaderCache(disk: disk).save(value, account: "account-a", localIdentity: "local-a")
        let afterRestart = RemoteReaderCache(disk: disk)
        XCTAssertEqual(afterRestart.load(localIdentity: "local-a", now: time.addingTimeInterval(200)), value)
        XCTAssertEqual(afterRestart.load(localIdentity: "local-a", now: time.addingTimeInterval(200))?.freshness(at: time.addingTimeInterval(200)), .historical)
        XCTAssertNil(afterRestart.load(localIdentity: nil, now: time), "unknown identity cannot expose a cold cache")
        XCTAssertEqual(afterRestart.load(localIdentity: nil, verifiedAccount: "account-a", now: time), value, "unknown did not delete the cache")
        XCTAssertNil(afterRestart.load(localIdentity: "local-b", now: time))
        XCTAssertNil(afterRestart.load(localIdentity: "local-a", now: time), "account mismatch purges the old value")
    }

    func testExpiredFutureCorruptAndOversizedCacheCannotLookFresh() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let disk = RemoteProbeDisk(directory: root)
        let cache = RemoteReaderCache(disk: disk)
        let now = Date()
        for age in [RemoteObservationPolicy.readerLifetime, -1] {
            try cache.save(.init(schemaVersion: 1, observedAt: now.addingTimeInterval(-age), workingCount: 1, waitingCount: 0), account: "a", localIdentity: "token")
            XCTAssertNil(cache.load(localIdentity: "token", now: now))
        }
        try Data("{broken".utf8).write(to: root.appendingPathComponent("reader.json"))
        XCTAssertNil(cache.load(localIdentity: "token"))
        try Data(repeating: 65, count: RemoteObservationPolicy.diskLimit + 1).write(to: root.appendingPathComponent("reader.json"))
        XCTAssertNil(cache.load(localIdentity: "token"))
    }

    func testDurableEpisodeKeepsIdentityAndOnlyStillWaitingEventsSurviveRestart() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let disk = RemoteProbeDisk(directory: root)
        let now = Date()
        var state = RemotePublisherState(account: "a"); state.enabled = true
        _ = state.observe([], at: now)
        let wait = RemoteSessionEvidence(localID: "local-private-session", alive: true, working: false, waitingForResponse: true)
        _ = state.observe([wait], at: now)
        let id = try XCTUnwrap(state.pending.first?.id)
        try disk.write(state, to: "publisher.json")
        var restored = try XCTUnwrap(disk.read("publisher.json", as: RemotePublisherState.self))
        restored.prepareAfterRestart()
        _ = restored.observe([wait, .init(localID: "new-during-gap", alive: true, working: false, waitingForResponse: true)], at: now.addingTimeInterval(1))
        XCTAssertEqual(restored.pending.map(\.id), [id], "a reconnect is a baseline, not an alert flood")
        XCTAssertEqual(restored.eligible(at: now.addingTimeInterval(1)).map(\.id), [id])
        XCTAssertTrue(restored.eligible(at: now.addingTimeInterval(301)).isEmpty)
        _ = restored.observe([], at: now.addingTimeInterval(2))
        XCTAssertTrue(restored.pending.isEmpty)
        restored.lastPublishedAt = now
        XCTAssertTrue(restored.shouldPublish(at: now.addingTimeInterval(2)), "resolution bypasses snapshot coalescing")
        let stable = restored
        _ = restored.observe([], at: now.addingTimeInterval(3))
        XCTAssertEqual(restored, stable, "cosmetic frames require no disk rewrite")
    }

    func testBackoffAndCoalescingDoNotReissueOnEveryFrame() {
        let now = Date()
        var state = RemotePublisherState(account: "a"); state.enabled = true
        XCTAssertTrue(state.shouldPublish(at: now))
        state.lastPublishedAt = now
        XCTAssertFalse(state.shouldPublish(at: now.addingTimeInterval(59)))
        XCTAssertTrue(state.shouldPublish(at: now.addingTimeInterval(60)))
        state.retryAt = now.addingTimeInterval(120)
        XCTAssertFalse(state.shouldPublish(at: now.addingTimeInterval(61)))
        XCTAssertEqual(RemoteObservationPolicy.retryDelay(attempt: 1), 5)
        XCTAssertEqual(RemoteObservationPolicy.retryDelay(attempt: 2), 10)
        XCTAssertEqual(RemoteObservationPolicy.retryDelay(attempt: 100, jitter: 1.2), 300)
        XCTAssertEqual(RemoteObservationPolicy.retryDelay(attempt: 3, retryAfter: 900), 900)
    }
}
#endif
