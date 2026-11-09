import CloudKit
import Foundation
import XCTest
@testable import AgentDeck

final class RemoteObservationCloudStoreTests: XCTestCase {
    private final class Capture: @unchecked Sendable {
        private let lock = NSLock()
        private var saved: [CKDatabaseOperation] = []
        func note(_ operation: CKDatabaseOperation) { lock.lock(); saved.append(operation); lock.unlock() }
        var operations: [CKDatabaseOperation] { lock.lock(); defer { lock.unlock() }; return saved }
    }

    private static func completeZone(_ operation: CKModifyRecordZonesOperation) {
        for zone in operation.recordZonesToSave ?? [] { operation.perRecordZoneSaveBlock?(zone.zoneID, .success(zone)) }
        operation.modifyRecordZonesResultBlock?(.success(()))
    }

    private func snapshot(installation: UUID = UUID()) -> RemoteObservationSnapshot {
        let now = Date()
        return .init(installationID: installation, revision: 1, sourceState: .observed,
            observedAt: now, publishedAt: now, expiresAt: now.addingTimeInterval(604800),
            workingCount: 1, waitingCount: 0, activeEventIDs: [])
    }

    func testPartialBatchFailureCannotBeAcknowledgedByTheFirstSavedRecord() async throws {
        let capture = Capture()
        let store = RemoteObservationCloudStore(account: { $0(.success("a")) }, submit: { operation in
            capture.note(operation)
            if let zone = operation as? CKModifyRecordZonesOperation { Self.completeZone(zone) }
            else if let fetch = operation as? CKFetchRecordsOperation, let id = fetch.recordIDs?.first {
                fetch.perRecordResultBlock?(id, .failure(CKError(.unknownItem)))
            } else if let save = operation as? CKModifyRecordsOperation, let first = save.recordsToSave?.first {
                save.perRecordSaveBlock?(first.recordID, .success(first))
                if let second = save.recordsToSave?.last {
                    let failure = CKError(.networkFailure)
                    save.perRecordSaveBlock?(second.recordID, .failure(failure))
                    save.modifyRecordsResultBlock?(.failure(CKError(.partialFailure,
                        userInfo: [CKPartialErrorsByItemIDKey: [second.recordID: failure]])))
                }
            }
        })
        let account = try await store.account()
        let summary = snapshot()
        let event = RemoteAttentionEvent(id: UUID(), installationID: summary.installationID,
            occurredAt: summary.publishedAt, expiresAt: summary.publishedAt.addingTimeInterval(300))
        do {
            try await store.publish(summary, events: [.init(event: event, mayCreate: true)], account: account)
            XCTFail("a partial batch must not advance acknowledged outbox state")
        } catch {
            let code = (error as? CKError)?.code
            XCTAssertTrue(code == .partialFailure || code == .networkFailure, "Unexpected error: \(error)")
        }
        let mutation = try XCTUnwrap(capture.operations.compactMap { $0 as? CKModifyRecordsOperation }.first)
        XCTAssertTrue(mutation.isAtomic)
        XCTAssertEqual(mutation.savePolicy, .ifServerRecordUnchanged)
        XCTAssertEqual(mutation.recordsToSave?.count, 2)
        XCTAssertNotNil(mutation.recordsToSave?.first?.encryptedValues["payload"])
    }

    func testSilentReadHasDeadlineCancellationAndIgnoresLateRecordResult() async throws {
        let capture = Capture()
        let store = RemoteObservationCloudStore(account: { $0(.success("a")) }, submit: { capture.note($0) }, deadline: .milliseconds(10))
        let account = try await store.account()
        do { _ = try await store.snapshot(account: account); XCTFail("silent reads must terminate") }
        catch { XCTAssertEqual((error as? URLError)?.code, .timedOut) }
        let fetch = try XCTUnwrap(capture.operations.first as? CKFetchRecordsOperation)
        XCTAssertTrue(fetch.isCancelled)
        let id = try XCTUnwrap(fetch.recordIDs?.first)
        fetch.perRecordResultBlock?(id, .failure(CKError(.unknownItem))) // late completion must be inert
    }

    func testAnotherInstallationCannotOverwriteTheExistingSnapshot() async throws {
        let capture = Capture()
        let previous = snapshot()
        let record = CKRecord(recordType: RemoteObservationContract.snapshotType,
            recordID: CKRecord.ID(recordName: RemoteObservationContract.snapshotRecord, zoneID: RemoteObservationCloudStore.zoneID))
        record["schemaVersion"] = 1
        record["installationID"] = previous.installationID.uuidString
        record.encryptedValues["payload"] = try RemoteObservationContract.encode(previous)
        let store = RemoteObservationCloudStore(account: { $0(.success("a")) }, submit: { operation in
            capture.note(operation)
            if let zone = operation as? CKModifyRecordZonesOperation { Self.completeZone(zone) }
            if let fetch = operation as? CKFetchRecordsOperation {
                fetch.perRecordResultBlock?(record.recordID, .success(record))
            }
        })
        let account = try await store.account()
        do { try await store.publish(snapshot(), events: [], account: account); XCTFail("foreign ownership must fail closed") }
        catch { XCTAssertEqual(error as? RemoteObservationError, .anotherPublisher) }
        XCTAssertTrue(capture.operations.compactMap { $0 as? CKModifyRecordsOperation }.isEmpty)
    }

    func testExpiredAmbiguousEventCanOnlyUpdateAnExistingRecord() async throws {
        let capture = Capture()
        let store = RemoteObservationCloudStore(account: { $0(.success("a")) }, submit: { operation in
            capture.note(operation)
            if let zone = operation as? CKModifyRecordZonesOperation { Self.completeZone(zone) }
            else if let fetch = operation as? CKFetchRecordsOperation, let id = fetch.recordIDs?.first {
                fetch.perRecordResultBlock?(id, .failure(CKError(.unknownItem)))
            } else if let save = operation as? CKModifyRecordsOperation {
                for record in save.recordsToSave ?? [] { save.perRecordSaveBlock?(record.recordID, .success(record)) }
                save.modifyRecordsResultBlock?(.success(()))
            }
        })
        let account = try await store.account()
        let summary = snapshot()
        let old = summary.publishedAt.addingTimeInterval(-301)
        let event = RemoteAttentionEvent(id: UUID(), installationID: summary.installationID,
            occurredAt: old, expiresAt: old.addingTimeInterval(300))
        try await store.publish(summary, events: [.init(event: event, mayCreate: false)], account: account)
        let mutation = try XCTUnwrap(capture.operations.compactMap { $0 as? CKModifyRecordsOperation }.first)
        XCTAssertEqual(mutation.recordsToSave?.count, 1, "only the summary may be created")
    }

    func testFailedZoneItemCannotLicenseSnapshotWritesEvenIfOverallCompletionSucceeds() async throws {
        let capture = Capture()
        let store = RemoteObservationCloudStore(account: { $0(.success("a")) }, submit: { operation in
            capture.note(operation)
            XCTAssertEqual(operation.configuration.qualityOfService, .userInitiated)
            if let zone = operation as? CKModifyRecordZonesOperation {
                zone.perRecordZoneSaveBlock?(RemoteObservationCloudStore.zoneID, .failure(CKError(.permissionFailure)))
                zone.modifyRecordZonesResultBlock?(.success(()))
            }
        })
        let account = try await store.account()
        do { try await store.publish(snapshot(), events: [], account: account); XCTFail("per-zone errors must propagate") }
        catch { XCTAssertEqual((error as? CKError)?.code, .permissionFailure) }
        XCTAssertEqual(capture.operations.count, 1)
    }

    func testFailedSubscriptionItemCannotReportNotificationsEnabled() async throws {
        let previous = snapshot()
        let record = CKRecord(recordType: RemoteObservationContract.snapshotType,
            recordID: CKRecord.ID(recordName: RemoteObservationContract.snapshotRecord, zoneID: RemoteObservationCloudStore.zoneID))
        record["schemaVersion"] = 1; record["installationID"] = previous.installationID.uuidString
        record.encryptedValues["payload"] = try RemoteObservationContract.encode(previous)
        let store = RemoteObservationCloudStore(account: { $0(.success("a")) }, submit: { operation in
            if let fetch = operation as? CKFetchRecordsOperation {
                fetch.perRecordResultBlock?(record.recordID, .success(record))
            } else if let subscription = operation as? CKModifySubscriptionsOperation,
                      let id = subscription.subscriptionsToSave?.first?.subscriptionID {
                subscription.perSubscriptionSaveBlock?(id, .failure(CKError(.networkFailure)))
                subscription.modifySubscriptionsResultBlock?(.success(()))
            }
        })
        let account = try await store.account()
        do {
            try await store.subscribe(installation: previous.installationID, receiver: UUID(), enabled: true, account: account)
            XCTFail("per-subscription failure cannot become enabled")
        } catch { XCTAssertEqual((error as? CKError)?.code, .networkFailure) }
    }

    func testDeletingAnAlreadyMissingSubscriptionIsIdempotent() async throws {
        let store = RemoteObservationCloudStore(account: { $0(.success("a")) }, submit: { operation in
            if let subscription = operation as? CKModifySubscriptionsOperation,
               let id = subscription.subscriptionIDsToDelete?.first {
                subscription.perSubscriptionDeleteBlock?(id, .failure(CKError(.unknownItem)))
                subscription.modifySubscriptionsResultBlock?(.failure(CKError(.unknownItem)))
            }
        })
        let account = try await store.account()
        try await store.subscribe(installation: UUID(), receiver: UUID(), enabled: false, account: account)
    }
}
