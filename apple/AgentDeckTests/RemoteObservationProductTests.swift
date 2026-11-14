import Foundation
import XCTest
@testable import AgentDeck

private actor MemoryObservationStore: RemoteObservationTransport {
    var identity = "account-a"
    var generation = 0
    var offline = false
    var unverified = false
    var signedOut = false
    var failAfterPublish = false
    var unsettled = false
    var latest: RemoteObservationSnapshot?
    var events: [UUID: RemoteAttentionEvent] = [:]
    var creations = 0
    var publications: [RemoteObservationSnapshot] = []
    var subscriptions: Set<UUID> = []
    var calls: [String] = []
    var holdPublish = false
    private var held: CheckedContinuation<Void, Never>?
    private var heldEventID: UUID?
    private var heldEventRead: CheckedContinuation<Void, Never>?

    func configure(offline: Bool = false, identity: String = "account-a", unverified: Bool = false,
                   signedOut: Bool = false, failAfterPublish: Bool = false, unsettled: Bool = false, holdPublish: Bool = false) {
        self.offline = offline; self.identity = identity; self.unverified = unverified
        self.signedOut = signedOut; self.failAfterPublish = failAfterPublish; self.unsettled = unsettled; self.holdPublish = holdPublish
    }
    private func check(_ account: RemoteObservationAccount? = nil) throws {
        if offline { throw URLError(.notConnectedToInternet) }
        if let account, account.identity != identity || account.generation != generation { throw RemoteObservationError.accountChanged }
    }
    func account() throws -> RemoteObservationAccount {
        calls.append("account"); try check()
        if unverified { throw RemoteObservationError.unverifiedAccount }
        if signedOut { throw RemoteObservationError.noAccount }
        return .init(identity: identity, generation: generation)
    }
    func invalidate() { generation += 1; calls.append("invalidate") }
    func quiesce() throws {
        calls.append("quiesce")
        if unsettled { throw RemoteObservationError.operationUnsettled }
    }
    func snapshot(account: RemoteObservationAccount) throws -> RemoteObservationSnapshot? {
        try check(account); return latest
    }
    func event(id: UUID, account: RemoteObservationAccount) async throws -> RemoteAttentionEvent? {
        try check(account)
        if heldEventID == id { await withCheckedContinuation { heldEventRead = $0 } }
        return events[id]
    }
    func holdEventRead(_ id: UUID) { heldEventID = id }
    func isHoldingEvent() -> Bool { heldEventRead != nil }
    func releaseEventRead() { heldEventID = nil; heldEventRead?.resume(); heldEventRead = nil }
    func publish(_ snapshot: RemoteObservationSnapshot, events changes: [RemoteEventMutation], account: RemoteObservationAccount) async throws {
        try check(account)
        if let latest, latest.installationID != snapshot.installationID { throw RemoteObservationError.anotherPublisher }
        latest = snapshot; publications.append(snapshot); calls.append("publish")
        for change in changes {
            if events[change.event.id] != nil || change.mayCreate {
                if events[change.event.id] == nil { creations += 1 }
                events[change.event.id] = change.event
            }
        }
        if holdPublish { await withCheckedContinuation { held = $0 } }
        if failAfterPublish { failAfterPublish = false; throw URLError(.timedOut) }
    }
    func releasePublication() { held?.resume(); held = nil; holdPublish = false }
    func isHolding() -> Bool { held != nil }
    func subscribe(installation: UUID, receiver: UUID, enabled: Bool, account: RemoteObservationAccount) throws {
        try check(account)
        calls.append(enabled ? "subscribe" : "unsubscribe")
        if enabled { subscriptions.insert(receiver) } else { subscriptions.remove(receiver) }
    }
    func delete(installation: UUID, account: RemoteObservationAccount) throws {
        try check(account)
        if let latest, latest.installationID != installation { throw RemoteObservationError.anotherPublisher }
        latest = nil; events.removeAll(); subscriptions.removeAll(); calls.append("delete")
    }
    func cleanup(at now: Date, account: RemoteObservationAccount) throws {
        try check(account); calls.append("cleanup")
    }
    func replaceSnapshot(_ value: RemoteObservationSnapshot?) { latest = value }
    func replaceEvent(_ event: RemoteAttentionEvent) { events[event.id] = event }
    func counts() -> (publications: Int, creations: Int, events: Int) { (publications.count, creations, events.count) }
    func callLog() -> [String] { calls }
}

@MainActor
final class RemoteObservationProductTests: XCTestCase {
    @MainActor private final class Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = MemoryObservationStore()
        var time = Date(timeIntervalSince1970: 1_800_000_000)
        var roster: RemoteLocalRoster?
        var disk: RemoteProbeDisk { RemoteProbeDisk(directory: root) }
        func model() -> RemoteObservationController {
            let model = RemoteObservationController(transport: store, disk: disk, now: { [self] in time },
                localIdentity: { "local-account-a" }, automaticLifecycle: false)
            model.bindLocalSource { [weak self] in self?.roster }
            return model
        }
        func rows(_ rows: [RemoteSessionEvidence]) { roster = .init(sessions: rows, observedAt: time) }
        deinit { try? FileManager.default.removeItem(at: root) }
    }
    private func require<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
        try XCTUnwrap(value, file: file, line: line)
    }
    private func assertTrue(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) { XCTAssertTrue(value, file: file, line: line) }
    private func assertFalse(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) { XCTAssertFalse(value, file: file, line: line) }
    private func assertNil<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) { XCTAssertNil(value, file: file, line: line) }
    private func assertNotNil<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) { XCTAssertNotNil(value, file: file, line: line) }
    private func row(_ id: String = "private-session-path", waiting: Bool) -> RemoteSessionEvidence {
        .init(localID: id, alive: true, working: !waiting, waitingForResponse: waiting)
    }
    private func summary(_ installation: UUID, at time: Date, revision: Int = 1, active: [UUID] = []) -> RemoteObservationSnapshot {
        .init(installationID: installation, revision: revision, sourceState: .observed, observedAt: time,
              publishedAt: time, expiresAt: time.addingTimeInterval(RemoteObservationPolicy.readerLifetime),
              workingCount: 2, waitingCount: active.count, activeEventIDs: active)
    }

    func testOptInBaselineAndSerializedPayloadNeverExportLocalIdentifiers() async throws {
        let fixture = Fixture(); fixture.rows([row(waiting: true)])
        let model = fixture.model()
        await model.enableSharing()
        let firstCounts = await fixture.store.counts()
        XCTAssertEqual(firstCounts.creations, 0, "existing waits establish a baseline")
        fixture.time.addTimeInterval(1); fixture.rows([row(waiting: true), row("new-secret-project", waiting: true)])
        await model.publishIfNeeded(force: true)
        let snapshot = try require(await fixture.store.latest)
        let bytes = try RemoteObservationContract.encode(snapshot)
        let text = String(decoding: bytes, as: UTF8.self)
        XCTAssertFalse(text.contains("private-session")); XCTAssertFalse(text.contains("secret-project"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(json["observedAt"] as? Int64, 1_800_000_001_000)
        XCTAssertEqual(snapshot.waitingCount, 2)
        let finalCounts = await fixture.store.counts()
        XCTAssertEqual(finalCounts.creations, 1)
    }

    func testDetailsConsentIsSeparateAndClearsWithStop() async throws {
        let fixture = Fixture()
        fixture.rows([row(waiting: true)])
        let publisher = fixture.model()
        await publisher.enableSharing()
        assertNil(await fixture.store.latest?.details)

        await publisher.setDetailsSharing(true)
        let detailed = await fixture.store.latest
        XCTAssertEqual(detailed?.details?.sessions.first?.phase, .response)
        XCTAssertEqual(fixture.disk.read("publisher.json", as: RemotePublicationJournal.self)?.includeDetails, true)

        let reader = fixture.model()
        await reader.enableReceiving()
        assertNotNil(reader.snapshot?.details)
        await publisher.setDetailsSharing(false)
        await reader.refresh(force: true)
        assertNil(reader.snapshot?.details)
        XCTAssertEqual(reader.snapshot?.waitingCount, 1)

        await publisher.setDetailsSharing(true)
        await publisher.stopSharing()
        await reader.refresh(force: true)
        XCTAssertEqual(reader.snapshot?.sourceState, .disabled)
        assertNil(reader.snapshot?.details)
        await publisher.enableSharing()
        assertNil(await fixture.store.latest?.details)
    }

    func testDetailsPayloadBoundsRowsAndKeepsPrivateSessionFieldsLocal() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var privateRow = SessionInfo(id: "private-session-id", port: 0, projectName: "private-project-name",
                                     agentType: "codex-app", state: "awaiting_option")
        privateRow.question = "private-question"
        privateRow.activity = "private-activity"
        privateRow.subagents = SubagentSummary(active: 2, peak: 3, completed: 1)
        let extra = (0..<30).map { row("private-id-\($0)", waiting: false) }
        let roster = RemoteLocalRoster(sessions: extra + [.init(row: privateRow, observedAt: now)], observedAt: now)
        var journal = RemotePublicationJournal(account: "account-a")
        journal.revision = 1
        let old = try RemoteObservationContract.encode(journal.snapshot(roster: roster, at: now))
        XCTAssertNil(try RemoteObservationContract.decode(RemoteObservationSnapshot.self, from: old).details)

        journal.includeDetails = true
        let snapshot = journal.snapshot(roster: roster, at: now)
        try snapshot.validate()
        let bytes = try RemoteObservationContract.encode(snapshot)
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("private-"))
        let decoded = try RemoteObservationContract.decode(RemoteObservationSnapshot.self, from: bytes)
        XCTAssertEqual(decoded.details?.sessionCount, 31)
        XCTAssertEqual(decoded.details?.sessions.count, RemoteObservationDetails.sessionLimit)
        XCTAssertEqual(decoded.details?.sessions.first?.agent, .codexApp)
        XCTAssertEqual(decoded.details?.sessions.first?.phase, .response)
        XCTAssertEqual(decoded.details?.sessions.first?.activeSubagents, 2)
        XCTAssertNil(journal.snapshot(roster: nil, at: now).details)
    }

    func testUsageProjectionPreservesSourceTimeAndRetiresUnknownOrEndedWindows() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let reset = now.addingTimeInterval(120)
        let rawReset = reset.formatted(.iso8601)
        let stamp = now.addingTimeInterval(-120)
        let deadline = now.addingTimeInterval(60)
        let reading = try XCTUnwrap(RemoteUsageWindow.make(provider: .zai, quantity: .mcp, minutes: 60,
            used: 72.5, observedAt: stamp, resetsAt: rawReset, validUntil: deadline, at: now))
        XCTAssertEqual(reading.remainingPercent, 27.5)
        XCTAssertEqual(reading.observedAt, stamp)
        XCTAssertEqual(reading.resetsAt, reset)
        XCTAssertFalse(reading.isVisible(at: deadline))
        XCTAssertNil(RemoteUsageWindow.make(provider: .codex, minutes: 60,
            used: 0, observedAt: nil, resetsAt: rawReset, at: now))
        XCTAssertNil(RemoteUsageWindow.make(provider: .codex, minutes: 60,
            used: 0, observedAt: stamp, resetsAt: rawReset, at: reset))
        XCTAssertNil(RemoteUsageWindow.make(provider: .codex, minutes: 60,
            used: .nan, observedAt: stamp, resetsAt: rawReset, at: now))
    }

    func testRelayedZaiProjectsProviderTimeAndRejectsRetiredWindows() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let observedAt = now.addingTimeInterval(-60)
        let reset = now.addingTimeInterval(3600)
        let window = ZaiWindow(usedPercent: 72.5, windowMinutes: 300, resetsAt: reset.formatted(.iso8601))
        var quota = ZaiRateLimits(primary: window, capturedAt: observedAt.formatted(.iso8601))

        let reading = try XCTUnwrap(RemoteUsageWindow.zaiAccount(quota,
            observedAt: remoteObservationDate(quota.capturedAt), at: now).first)
        XCTAssertEqual(reading.remainingPercent, 27.5)
        XCTAssertEqual(reading.observedAt, observedAt)
        XCTAssertEqual(reading.resetsAt, reset)
        XCTAssertFalse(reading.isVisible(at: observedAt.addingTimeInterval(600)))
        XCTAssertTrue(RemoteUsageWindow.zaiAccount(quota, observedAt: nil, at: now).isEmpty)
        XCTAssertTrue(RemoteUsageWindow.zaiAccount(quota, observedAt: observedAt,
            at: observedAt.addingTimeInterval(600)).isEmpty)
        quota.primary?.stale = true
        XCTAssertTrue(RemoteUsageWindow.zaiAccount(quota, observedAt: observedAt, at: now).isEmpty)
        quota.primary = window
        quota.authFailed = true
        XCTAssertTrue(RemoteUsageWindow.zaiAccount(quota, observedAt: observedAt, at: now).isEmpty)
    }

    func testAmbiguousCommittedAlertResolvesBySameIdentityWithoutDuplicateCreation() async throws {
        let fixture = Fixture(); fixture.rows([])
        let model = fixture.model(); await model.enableSharing()
        fixture.time.addTimeInterval(1); fixture.rows([row(waiting: true)])
        await fixture.store.configure(failAfterPublish: true)
        await model.publishIfNeeded(force: true)
        let id = try XCTUnwrap(model.writer?.episodes.first?.event.id)
        XCTAssertEqual(model.writer?.episodes.first?.attempted, true)
        XCTAssertEqual(model.writer?.episodes.first?.acknowledged, false)
        fixture.time.addTimeInterval(1); fixture.rows([row(waiting: false)])
        await model.publishIfNeeded(force: true)
        let saved = await fixture.store.events[id]
        XCTAssertNotNil(saved?.resolvedAt)
        XCTAssertEqual(saved?.id, id)
        let counts = await fixture.store.counts()
        XCTAssertEqual(counts.creations, 1)
        XCTAssertEqual(model.writer?.episodes.first?.acknowledged, true)
    }

    func testSourceLossAndMissingRowAfterReconnectNeverClaimResolution() async throws {
        let fixture = Fixture(); fixture.rows([])
        let model = fixture.model(); await model.enableSharing()
        fixture.time.addTimeInterval(1); fixture.rows([row(waiting: true)])
        await model.publishIfNeeded(force: true)
        let id = try XCTUnwrap(model.writer?.episodes.first?.event.id)
        fixture.roster = nil
        await model.sourceWasInvalidated()
        var snapshot = await fixture.store.latest
        XCTAssertEqual(snapshot?.sourceState, .unavailable)
        XCTAssertNil(snapshot?.workingCount)
        fixture.time.addTimeInterval(1); fixture.rows([])
        await model.publishIfNeeded(force: true)
        let event = try require(await fixture.store.events[id])
        snapshot = await fixture.store.latest
        XCTAssertNil(event.resolvedAt)
        XCTAssertEqual(event.presentation(snapshot: snapshot, at: fixture.time), .unconfirmed)
    }

    func testOfflineStopSurvivesRestartAndPublishesDisabledWithoutReenabling() async throws {
        let fixture = Fixture(); fixture.rows([row(waiting: false)])
        let model = fixture.model(); await model.enableSharing()
        await fixture.store.configure(offline: true)
        await model.stopSharing()
        XCTAssertFalse(try XCTUnwrap(model.writer).enabled)
        XCTAssertEqual(model.writer?.intent, .stop)
        let restored = fixture.model(); restored.restoreDisk()
        XCTAssertEqual(restored.writer?.intent, .stop)
        XCTAssertFalse(try XCTUnwrap(restored.writer).enabled)
        await fixture.store.configure()
        await restored.publishIfNeeded(force: true)
        XCTAssertEqual(restored.writer?.intent, RemotePublicationJournal.Intent.none)
        let snapshot = try require(await fixture.store.latest)
        XCTAssertEqual(snapshot.sourceState, .disabled)
        XCTAssertNil(snapshot.workingCount); XCTAssertTrue(snapshot.activeEventIDs.isEmpty)
    }

    func testDeletionWaitsForOldWritesAndRetainsOriginalAccountIntentAcrossRestart() async throws {
        let fixture = Fixture(); fixture.rows([])
        let model = fixture.model(); await model.enableSharing()
        await fixture.store.configure(unsettled: true)
        await model.stopSharing(delete: true)
        XCTAssertEqual(model.writer?.intent, .delete)
        assertFalse((await fixture.store.callLog()).contains("delete"))
        let restored = fixture.model(); restored.restoreDisk()
        await fixture.store.configure(identity: "account-b")
        await restored.publishIfNeeded(force: true)
        XCTAssertEqual(restored.writer?.intent, .delete)
        assertNotNil(await fixture.store.latest)
        await fixture.store.configure()
        await restored.publishIfNeeded(force: true)
        XCTAssertEqual(restored.writer?.intent, RemotePublicationJournal.Intent.none)
        assertNil(await fixture.store.latest)
        XCTAssertFalse(try XCTUnwrap(restored.writer).enabled)
    }

    func testAccountChangeWhileSaveIsSuspendedRevokesConsentAndRejectsLateCompletion() async throws {
        let fixture = Fixture(); fixture.rows([])
        let model = fixture.model(); await model.enableSharing()
        await fixture.store.configure(holdPublish: true)
        fixture.time.addTimeInterval(1); fixture.rows([row(waiting: true)])
        let publication = Task { await model.publishIfNeeded(force: true) }
        for _ in 0..<100 where !(await fixture.store.isHolding()) { await Task.yield() }
        assertTrue(await fixture.store.isHolding())
        await model.accountChanged()
        await fixture.store.releasePublication(); await publication.value
        XCTAssertFalse(try XCTUnwrap(model.writer).enabled)
        XCTAssertTrue(try XCTUnwrap(model.writer).episodes.isEmpty)
        XCTAssertEqual(model.writer?.intent, .stop)
        let disk = try XCTUnwrap(fixture.disk.read("publisher.json", as: RemotePublicationJournal.self))
        XCTAssertFalse(disk.enabled); XCTAssertTrue(disk.episodes.isEmpty)
    }

    func testUnsentResolvedAndExpiredWaitsNeverCreateCatchUpAlerts() throws {
        let fixture = Fixture()
        var journal = RemotePublicationJournal(account: "a"); journal.enabled = true
        journal.observe(.init(sessions: [], observedAt: fixture.time), at: fixture.time)
        journal.observe(.init(sessions: [row(waiting: true)], observedAt: fixture.time), at: fixture.time)
        journal.observe(.init(sessions: [row(waiting: false)], observedAt: fixture.time), at: fixture.time)
        XCTAssertTrue(journal.episodes.isEmpty)
        journal.observe(.init(sessions: [row(waiting: true)], observedAt: fixture.time), at: fixture.time)
        fixture.time.addTimeInterval(RemoteObservationPolicy.attentionLifetime)
        let roster = RemoteLocalRoster(sessions: [row(waiting: true)], observedAt: fixture.time)
        journal.observe(roster, at: fixture.time)
        XCTAssertTrue(journal.mutations(roster: roster, at: fixture.time).isEmpty)
    }

    func testReaderRefreshesOpenedEventResolutionAndRetainsOriginalTimeOffline() async throws {
        let fixture = Fixture(); let installation = UUID(); let id = UUID()
        let snapshot = summary(installation, at: fixture.time, active: [id])
        var event = RemoteAttentionEvent(id: id, installationID: installation, occurredAt: fixture.time,
            expiresAt: fixture.time.addingTimeInterval(300))
        await fixture.store.replaceSnapshot(snapshot); await fixture.store.replaceEvent(event)
        let reader = fixture.model(); await reader.enableReceiving(); await reader.notificationOpened(id: id)
        XCTAssertEqual(reader.attentionEvent?.presentation(snapshot: reader.snapshot, at: fixture.time), .waiting)
        fixture.time.addTimeInterval(2); event.resolvedAt = fixture.time
        await fixture.store.replaceEvent(event)
        await reader.refresh(force: true)
        XCTAssertEqual(reader.attentionEvent?.presentation(snapshot: reader.snapshot, at: fixture.time), .resolved)
        await fixture.store.configure(offline: true)
        fixture.time.addTimeInterval(180)
        await reader.refresh(force: true)
        XCTAssertTrue(reader.usingCache)
        XCTAssertEqual(reader.snapshot?.observedAt, snapshot.observedAt)
        XCTAssertEqual(reader.snapshot?.freshness(at: fixture.time), .historical)
        XCTAssertNotNil(fixture.disk.read("reader.json", as: RemoteObservationCache.self))
    }

    func testPublisherChangeDoesNotTransferNotificationConsentOrResetReceiverIdentity() async throws {
        let fixture = Fixture()
        let first = UUID(), second = UUID()
        await fixture.store.replaceSnapshot(summary(first, at: fixture.time))
        let model = fixture.model()
        await model.enableReceiving()
        await model.enableNotifications()
        let receiverID = model.reader.receiverID
        XCTAssertTrue(model.reader.notifications)
        await fixture.store.replaceSnapshot(summary(second, at: fixture.time))
        await model.refresh(force: true)
        XCTAssertEqual(model.reader.installationID, second)
        XCTAssertEqual(model.reader.receiverID, receiverID)
        XCTAssertFalse(model.reader.notifications)
        let subscriptions = await fixture.store.subscriptions
        XCTAssertTrue(subscriptions.isEmpty)
        let restored = fixture.model(); restored.restoreDisk()
        XCTAssertEqual(restored.reader.receiverID, receiverID)
        XCTAssertFalse(restored.reader.notifications)
        await model.enableNotifications()
        XCTAssertTrue(model.reader.notifications)
        let enabled = await fixture.store.subscriptions
        XCTAssertEqual(enabled, [receiverID])
    }

    func testStopReceivingClearsDiskImmediatelyAndRetriesSubscriptionDeletionAfterRestart() async throws {
        let fixture = Fixture()
        await fixture.store.replaceSnapshot(summary(UUID(), at: fixture.time))
        let reader = fixture.model(); await reader.enableReceiving(); await reader.enableNotifications()
        await fixture.store.configure(offline: true)
        await reader.stopReceiving()
        XCTAssertFalse(reader.reader.receiving)
        XCTAssertTrue(reader.reader.unsubscribePending)
        XCTAssertNil(reader.snapshot)
        XCTAssertNil(fixture.disk.read("reader.json", as: RemoteObservationCache.self))
        let restored = fixture.model(); restored.restoreDisk()
        await fixture.store.configure()
        await restored.refresh(force: true)
        XCTAssertFalse(restored.reader.unsubscribePending)
        XCTAssertFalse(restored.reader.receiving)
        assertTrue((await fixture.store.subscriptions).isEmpty)
    }

    func testUnknownIdentityRetainsPrivateDiskButConfirmedDifferentAccountClearsReader() async throws {
        let fixture = Fixture()
        await fixture.store.replaceSnapshot(summary(UUID(), at: fixture.time))
        let reader = fixture.model(); await reader.enableReceiving()
        await fixture.store.configure(unverified: true)
        let restored = RemoteObservationController(transport: fixture.store, disk: fixture.disk, now: { fixture.time },
            localIdentity: { nil }, automaticLifecycle: false)
        restored.restoreDisk()
        XCTAssertNil(restored.snapshot)
        await restored.refresh(force: true)
        XCTAssertNil(restored.snapshot)
        XCTAssertNotNil(fixture.disk.read("reader.json", as: RemoteObservationCache.self))
        await fixture.store.configure(identity: "account-b")
        await restored.refresh(force: true)
        XCTAssertFalse(restored.reader.receiving)
        XCTAssertNil(fixture.disk.read("reader.json", as: RemoteObservationCache.self))
    }

    func testEventStatesDistinguishExpiryResolutionStoppedSharingAndUnknownSource() {
        let fixture = Fixture(); let installation = UUID(); let id = UUID()
        var event = RemoteAttentionEvent(id: id, installationID: installation, occurredAt: fixture.time,
            expiresAt: fixture.time.addingTimeInterval(300))
        XCTAssertEqual(event.presentation(snapshot: nil, at: fixture.time), .unconfirmed)
        XCTAssertEqual(event.presentation(snapshot: summary(installation, at: fixture.time, active: [id]), at: fixture.time), .waiting)
        let stopped = RemoteObservationSnapshot(installationID: installation, revision: 2, sourceState: .disabled,
            observedAt: nil, publishedAt: fixture.time, expiresAt: fixture.time.addingTimeInterval(604800),
            workingCount: nil, waitingCount: nil, activeEventIDs: [])
        XCTAssertEqual(event.presentation(snapshot: stopped, at: fixture.time), .sharingStopped)
        XCTAssertEqual(event.presentation(snapshot: nil, at: fixture.time.addingTimeInterval(300)), .expired)
        event.resolvedAt = fixture.time.addingTimeInterval(2)
        XCTAssertEqual(event.presentation(snapshot: nil, at: fixture.time.addingTimeInterval(301)), .resolved)
    }

    func testHostedControllerDoesNotLoadSavedConsentOrContactCloudWithoutExplicitWork() async throws {
        let fixture = Fixture()
        var journal = RemotePublicationJournal(account: "a"); journal.enabled = true
        try fixture.disk.write(journal, to: "publisher.json")
        let model = fixture.model(); model.start()
        XCTAssertNil(model.writer)
        assertTrue((await fixture.store.callLog()).isEmpty)
    }

    func testRevocationMarkerOverridesAnOlderEnabledJournalAfterInterruptedDiskSave() throws {
        let fixture = Fixture()
        var journal = RemotePublicationJournal(account: "account-a"); journal.enabled = true
        try fixture.disk.write(journal, to: "publisher.json")
        try fixture.disk.write(RemoteSharingRevocation(account: journal.account, installationID: journal.installationID,
            revision: journal.revision, intent: .delete), to: "publisher-revocation.json")
        let model = fixture.model(); model.restoreDisk()
        XCTAssertFalse(try XCTUnwrap(model.writer).enabled)
        XCTAssertEqual(model.writer?.intent, .delete)
        XCTAssertEqual(model.writer?.installationID, journal.installationID)
    }

    func testNewerSchemaDoesNotReplaceTheLastReadableSnapshotOrAdvanceItsTime() async throws {
        let fixture = Fixture()
        let readable = summary(UUID(), at: fixture.time)
        await fixture.store.replaceSnapshot(readable)
        let model = fixture.model(); await model.enableReceiving()
        var future = readable; future.schemaVersion = 99
        await fixture.store.replaceSnapshot(future)
        await model.refresh(force: true)
        XCTAssertEqual(model.snapshot, readable)
        XCTAssertTrue(model.usingCache)
        XCTAssertTrue(model.status.contains("newer AgentDeck"))
    }

    func testForegroundNotificationRefreshDoesNotNavigateUntilUserOpensIt() async {
        let fixture = Fixture()
        await fixture.store.replaceSnapshot(summary(UUID(), at: fixture.time))
        let model = fixture.model(); await model.enableReceiving()
        await model.notificationArrived(id: nil)
        XCTAssertEqual(model.selectedTab, .local)
        await model.notificationOpened(id: nil)
        XCTAssertEqual(model.selectedTab, .remote)
    }

    func testBoundedOutboxDoesNotRenameOrReplayEpisodesOnReconnect() {
        let fixture = Fixture()
        var journal = RemotePublicationJournal(account: "a")
        journal.observe(.init(sessions: [], observedAt: fixture.time), at: fixture.time)
        let rows = (0..<40).map { row("local-\($0)", waiting: true) }
        let roster = RemoteLocalRoster(sessions: rows, observedAt: fixture.time)
        journal.observe(roster, at: fixture.time)
        let ids = journal.episodes.map { $0.event.id }
        XCTAssertEqual(ids.count, RemoteObservationPolicy.pendingLimit)
        XCTAssertEqual(journal.droppedEvents, 8)
        journal.invalidateSource(); journal.observe(roster, at: fixture.time)
        XCTAssertEqual(journal.episodes.map { $0.event.id }, ids)
    }

    func testStopAndAccountChangeHideMemoryEvenWhenRevocationFileCannotBeWritten() async throws {
        for accountChange in [false, true] {
            let fixture = Fixture()
            await fixture.store.replaceSnapshot(summary(UUID(), at: fixture.time))
            let model = fixture.model(); await model.enableReceiving()
            XCTAssertNotNil(model.snapshot)
            // A directory cannot be replaced by the atomic revocation-file write.
            try FileManager.default.createDirectory(at: fixture.root.appendingPathComponent("receiver-disabled.json"), withIntermediateDirectories: true)
            if accountChange { await model.accountChanged() } else { await model.stopReceiving() }
            XCTAssertNil(model.snapshot)
            XCTAssertNil(model.attentionEvent)
            XCTAssertFalse(model.reader.receiving)
            XCTAssertTrue(model.status.contains("retry"))
            let relaunched = fixture.model(); relaunched.restoreDisk()
            XCTAssertFalse(relaunched.reader.receiving, "a failed revocation write must not revive old receiver consent")
        }
    }

    func testLateEventReadCannotOverwriteANewerNotificationTap() async throws {
        let fixture = Fixture(); let installation = UUID(); let first = UUID(); let second = UUID()
        await fixture.store.replaceSnapshot(summary(installation, at: fixture.time, active: [first, second]))
        for id in [first, second] {
            await fixture.store.replaceEvent(.init(id: id, installationID: installation, occurredAt: fixture.time,
                expiresAt: fixture.time.addingTimeInterval(300)))
        }
        let model = fixture.model(); await model.enableReceiving()
        await fixture.store.holdEventRead(first)
        let oldRead = Task { await model.notificationOpened(id: first) }
        for _ in 0..<200 {
            if await fixture.store.isHoldingEvent() { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        assertTrue(await fixture.store.isHoldingEvent())
        await model.notificationOpened(id: second)
        await fixture.store.releaseEventRead(); await oldRead.value
        XCTAssertNil(model.attentionEvent, "the old episode cannot replace the user's new selection")
        await model.refresh(force: true)
        XCTAssertEqual(model.attentionEvent?.id, second)
        await model.notificationArrived(id: first)
        XCTAssertEqual(model.attentionEvent?.id, second, "a foreground banner must not select a different episode")
    }

    func testDevelopmentConsentAndPendingDeletionCannotMoveIntoProduction() throws {
        let fixture = Fixture()
        let development = RemoteObservationContract.storage(in: fixture.root, environment: .development)
        let production = RemoteObservationContract.storage(in: fixture.root, environment: .production)
        var writer = RemotePublicationJournal(account: "same-apple-account")
        writer.intent = .delete
        try development.write(writer, to: "publisher.json")
        var reader = RemoteReaderJournal(); reader.account = writer.account; reader.receiving = true
        try development.write(reader, to: "receiver.json")
        let release = RemoteObservationController(transport: fixture.store, disk: production, automaticLifecycle: false)
        release.restoreDisk()
        XCTAssertNil(release.writer)
        XCTAssertFalse(release.reader.receiving, "a Production install needs its own explicit enrollment")
        let debug = RemoteObservationController(transport: fixture.store, disk: development, automaticLifecycle: false)
        debug.restoreDisk()
        XCTAssertEqual(debug.writer?.intent, .delete, "Development cleanup remains recoverable in its own environment")
        XCTAssertTrue(debug.reader.receiving)
        XCTAssertNotNil(RemoteObservationContract.environment, "the actual built host must declare its selected CloudKit environment")
    }

    func testQueuedNotificationDoesNotBypassAutomaticOfflineBackoff() async throws {
        let fixture = Fixture()
        await fixture.store.replaceSnapshot(summary(UUID(), at: fixture.time))
        let model = fixture.model(); await model.enableReceiving()
        await fixture.store.configure(offline: true)
        await model.notificationOpened(id: UUID())
        let afterFailure = await fixture.store.callLog()
        await model.refresh() // A queued tap may bypass coalescing, never the failure backoff.
        let beforeDeadline = await fixture.store.callLog()
        XCTAssertEqual(beforeDeadline, afterFailure)
        fixture.time.addTimeInterval(6)
        await model.refresh()
        let afterDeadline = await fixture.store.callLog()
        XCTAssertGreaterThan(afterDeadline.count, beforeDeadline.count)
    }
}
