#if AGENTDECK_CLOUDKIT_POC
import XCTest
@testable import AgentDeck

private actor WatchStoreFixture: WatchObservationStore {
    let owner: String
    let result: RemoteRosterSummary?
    private(set) var reads = 0
    init(owner: String, result: RemoteRosterSummary? = nil) {
        self.owner = owner
        self.result = result
    }
    func checkAccount(expected: Int?) -> Int { 0 }
    func accountIdentity(account: Int?) -> String { owner }
    func fetchRoster(account: Int?) throws -> RemoteRosterSummary {
        reads += 1
        guard let result else { throw URLError(.notConnectedToInternet) }
        return result
    }
    func invalidateAccount() {}
}

private actor WatchOfflineAccountFixture: WatchObservationStore {
    enum Failure: CaseIterable, Sendable { case offline, unverified, timedOut }
    let failure: Failure
    init(_ failure: Failure = .offline) { self.failure = failure }
    func checkAccount(expected: Int?) throws -> Int {
        switch failure {
        case .offline: throw URLError(.notConnectedToInternet)
        case .unverified: throw CloudKitProbeStore.ProbeError.accountUnverified
        case .timedOut: throw URLError(.timedOut)
        }
    }
    func accountIdentity(account: Int?) throws -> String { throw URLError(.notConnectedToInternet) }
    func fetchRoster(account: Int?) throws -> RemoteRosterSummary { throw URLError(.notConnectedToInternet) }
    func invalidateAccount() {}
}

@MainActor
final class WatchObservationModelTests: XCTestCase {
    private func withCache(_ test: (RemoteReaderCache) async throws -> Void) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try await test(RemoteReaderCache(disk: RemoteProbeDisk(directory: directory)))
    }
    private var observation: RemoteRosterSummary {
        RemoteRosterSummary(schemaVersion: 1, observedAt: Date().addingTimeInterval(-30), workingCount: 3, waitingCount: 2)
    }

    func testColdStartWithoutLocalIdentityKeepsCacheHiddenUntilAccountVerification() async throws {
        try await withCache { cache in
            let saved = observation
            try cache.save(saved, account: "owner", localIdentity: nil)
            for failure in WatchOfflineAccountFixture.Failure.allCases {
                let model = WatchObservationModel(store: WatchOfflineAccountFixture(failure), cache: cache,
                                                  localIdentity: { nil })
                XCTAssertNil(model.summary)
                XCTAssertTrue(model.status?.contains("verify its account") == true)
                await model.refresh()
                XCTAssertNil(model.summary)
                XCTAssertTrue(model.status?.contains("verify its account") == true)
                XCTAssertEqual(cache.disk.read("reader.json", as: RemoteReaderCache.Envelope.self)?.summary, saved)
                XCTAssertFalse(model.busy)
            }
        }
    }

    func testVerifiedDifferentAccountClearsRestoredCountsEvenWhenFetchFails() async throws {
        try await withCache { cache in
            try cache.save(observation, account: "old-account", localIdentity: "unchanged-local-token")
            let model = WatchObservationModel(store: WatchStoreFixture(owner: "new-account"), cache: cache,
                                              localIdentity: { "unchanged-local-token" })
            XCTAssertNotNil(model.summary)
            await model.refresh()
            XCTAssertNil(model.summary)
            XCTAssertNil(cache.disk.read("reader.json", as: RemoteReaderCache.Envelope.self))
            XCTAssertFalse(model.busy)
        }
    }

    func testSameAccountOfflineRetainsOriginalObservationTime() async throws {
        try await withCache { cache in
            let saved = observation
            try cache.save(saved, account: "owner", localIdentity: "local")
            let model = WatchObservationModel(store: WatchStoreFixture(owner: "owner"), cache: cache,
                                              localIdentity: { "local" })
            await model.refresh()
            XCTAssertEqual(model.summary, saved)
            XCTAssertNotNil(model.status)
            XCTAssertFalse(model.busy)
        }
    }

    func testAccountChangeDoesNotThrottleNextActivation() async throws {
        try await withCache { cache in
            let store = WatchStoreFixture(owner: "owner", result: observation)
            let model = WatchObservationModel(store: store, cache: cache, localIdentity: { "local" })
            await model.refresh()
            XCTAssertNotNil(model.lastFetch)
            await model.accountDidChange()
            XCTAssertNil(model.summary)
            XCTAssertNil(model.lastFetch)
            await model.refreshIfStale()
            let reads = await store.reads
            XCTAssertEqual(reads, 2)
            XCTAssertNotNil(model.summary)
        }
    }

    func testCacheFailureIsReportedWithoutDiscardingFetchedObservation() async throws {
        try await withCache { cache in
            // A regular file where the cache directory must be makes writes fail.
            try Data().write(to: cache.disk.directory)
            let saved = observation
            let model = WatchObservationModel(store: WatchStoreFixture(owner: "owner", result: saved), cache: cache,
                                              localIdentity: { "local" })
            await model.refresh()
            XCTAssertEqual(model.summary, saved)
            XCTAssertNotNil(model.status)
            XCTAssertFalse(model.busy)
        }
    }
}
#endif
