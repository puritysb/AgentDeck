import XCTest
@testable import AgentDeck

private actor WatchSourceFixture: WatchObservationSource {
    let owner: String
    let result: RemoteObservationSnapshot?
    let failFetch: Bool
    private(set) var reads = 0
    init(owner: String, result: RemoteObservationSnapshot? = nil, failFetch: Bool = false) {
        self.owner = owner; self.result = result; self.failFetch = failFetch
    }
    func account() -> RemoteObservationAccount { .init(identity: owner, generation: 0) }
    func snapshot(account: RemoteObservationAccount) throws -> RemoteObservationSnapshot? {
        reads += 1
        if failFetch { throw URLError(.notConnectedToInternet) }
        return result
    }
    func invalidate() {}
}

private actor WatchOfflineAccountFixture: WatchObservationSource {
    enum Failure: CaseIterable, Sendable { case offline, unverified, timedOut }
    let failure: Failure
    init(_ failure: Failure) { self.failure = failure }
    func account() throws -> RemoteObservationAccount {
        switch failure {
        case .offline: throw URLError(.notConnectedToInternet)
        case .unverified: throw RemoteObservationError.unverifiedAccount
        case .timedOut: throw URLError(.timedOut)
        }
    }
    func snapshot(account: RemoteObservationAccount) throws -> RemoteObservationSnapshot? { throw URLError(.notConnectedToInternet) }
    func invalidate() {}
}

@MainActor
final class WatchObservationModelTests: XCTestCase {
    private func withCache(_ test: (WatchSnapshotCache) async throws -> Void) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try await test(WatchSnapshotCache(disk: RemoteProbeDisk(directory: directory)))
    }

    private var observation: RemoteObservationSnapshot {
        let observedAt = Date().addingTimeInterval(-30)
        return RemoteObservationSnapshot(installationID: UUID(), revision: 3, sourceState: .observed, observedAt: observedAt,
            publishedAt: observedAt, expiresAt: observedAt.addingTimeInterval(3_600), workingCount: 3, waitingCount: 2,
            activeEventIDs: [], details: nil)
    }

    private func saved(_ cache: WatchSnapshotCache) -> RemoteObservationSnapshot? {
        cache.disk.read(WatchSnapshotCache.file, as: WatchSnapshotCache.Envelope.self)?.snapshot
    }

    func testColdStartWithoutLocalIdentityKeepsCacheHiddenUntilAccountVerification() async throws {
        try await withCache { cache in
            let snapshot = observation
            try cache.save(snapshot, account: "owner", localIdentity: nil)
            for failure in WatchOfflineAccountFixture.Failure.allCases {
                let model = WatchObservationModel(source: WatchOfflineAccountFixture(failure), cache: cache, localIdentity: { nil })
                XCTAssertNil(model.snapshot)
                XCTAssertTrue(model.status?.contains("verify its account") == true)
                await model.refresh()
                XCTAssertNil(model.snapshot)
                XCTAssertTrue(model.status?.contains("verify its account") == true)
                XCTAssertEqual(saved(cache), snapshot)
                XCTAssertFalse(model.busy)
            }
        }
    }

    func testVerifiedDifferentAccountClearsRestoredCountsEvenWhenFetchFails() async throws {
        try await withCache { cache in
            try cache.save(observation, account: "old-account", localIdentity: "unchanged-local-token")
            let model = WatchObservationModel(source: WatchSourceFixture(owner: "new-account", failFetch: true), cache: cache,
                                              localIdentity: { "unchanged-local-token" })
            XCTAssertNotNil(model.snapshot)
            await model.refresh()
            XCTAssertNil(model.snapshot)
            XCTAssertNil(saved(cache))
            XCTAssertFalse(model.busy)
        }
    }

    func testSameAccountOfflineRetainsOriginalObservationTime() async throws {
        try await withCache { cache in
            let snapshot = observation
            try cache.save(snapshot, account: "owner", localIdentity: "local")
            let model = WatchObservationModel(source: WatchSourceFixture(owner: "owner", failFetch: true), cache: cache,
                                              localIdentity: { "local" })
            await model.refresh()
            XCTAssertEqual(model.snapshot, snapshot)
            XCTAssertEqual(model.snapshot?.observedAt, snapshot.observedAt)
            XCTAssertNotNil(model.status)
            XCTAssertFalse(model.busy)
        }
    }

    func testDeletedSharingClearsTheWatch() async throws {
        try await withCache { cache in
            try cache.save(observation, account: "owner", localIdentity: "local")
            let model = WatchObservationModel(source: WatchSourceFixture(owner: "owner", result: nil), cache: cache,
                                              localIdentity: { "local" })
            await model.refresh()
            XCTAssertNil(model.snapshot)
            XCTAssertNil(saved(cache))
            XCTAssertNotNil(model.status)
        }
    }

    func testAccountChangeDoesNotThrottleNextActivation() async throws {
        try await withCache { cache in
            let source = WatchSourceFixture(owner: "owner", result: observation)
            let model = WatchObservationModel(source: source, cache: cache, localIdentity: { "local" })
            await model.refresh()
            XCTAssertNotNil(model.lastFetch)
            await model.accountDidChange()
            XCTAssertNil(model.snapshot)
            XCTAssertNil(model.lastFetch)
            await model.refreshIfStale()
            let reads = await source.reads
            XCTAssertEqual(reads, 2)
            XCTAssertNotNil(model.snapshot)
        }
    }

    func testCacheFailureIsReportedWithoutDiscardingFetchedObservation() async throws {
        try await withCache { cache in
            // A regular file where the cache directory must be makes writes fail.
            try Data().write(to: cache.disk.directory)
            let snapshot = observation
            let model = WatchObservationModel(source: WatchSourceFixture(owner: "owner", result: snapshot), cache: cache,
                                              localIdentity: { "local" })
            await model.refresh()
            XCTAssertEqual(model.snapshot, snapshot)
            XCTAssertNotNil(model.status)
            XCTAssertFalse(model.busy)
        }
    }
}
