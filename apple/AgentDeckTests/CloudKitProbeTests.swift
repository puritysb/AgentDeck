#if AGENTDECK_CLOUDKIT_POC
import XCTest
import CloudKit
@testable import AgentDeck

final class CloudKitProbeTests: XCTestCase {
    private final class WriteCapture: @unchecked Sendable {
        private let lock = NSLock()
        private var operations: [CKDatabaseOperation] = []
        func add(_ operation: CKDatabaseOperation) {
            lock.lock(); defer { lock.unlock() }
            operations.append(operation)
        }
        var first: CKDatabaseOperation? {
            lock.lock(); defer { lock.unlock() }; return operations.first
        }
        var count: Int { lock.lock(); defer { lock.unlock() }; return operations.count }
    }

    func testAccountChangeCancelsWriteAndLateAcknowledgementCannotSendNextRecord() async throws {
        let capture = WriteCapture()
        let queued = XCTestExpectation(description: "first record queued")
        let store = CloudKitProbeStore(accountStatus: { $0.finish(.success(.available)) }, submit: {
            capture.add($0); queued.fulfill()
        })
        let send = Task { try await store.sendTest() }
        await fulfillment(of: [queued], timeout: 2)
        let operation = try XCTUnwrap(capture.first as? CKModifyRecordsOperation)
        await store.invalidateAccount()
        XCTAssertTrue(operation.isCancelled)
        let record = try XCTUnwrap(operation.recordsToSave?.first)
        operation.perRecordSaveBlock?(record.recordID, .success(record))
        do {
            _ = try await send.value
            XCTFail("An old-account acknowledgement cannot continue the publication")
        } catch {
            XCTAssertEqual(error as? CloudKitProbeStore.ProbeError, .accountChanged)
        }
        XCTAssertEqual(capture.count, 1, "no alert record may be submitted after the switch")
    }

    func testSummaryDeletionTreatsAnAlreadyMissingRecordAsSuccess() async throws {
        let capture = WriteCapture()
        let queued = XCTestExpectation(description: "delete queued")
        let store = CloudKitProbeStore(accountStatus: { $0.finish(.success(.available)) }, submit: {
            capture.add($0); queued.fulfill()
        })
        let deletion = Task { try await store.deleteRoster() }
        await fulfillment(of: [queued], timeout: 2)
        let operation = try XCTUnwrap(capture.first as? CKModifyRecordsOperation)
        let id = try XCTUnwrap(operation.recordIDsToDelete?.first)
        operation.perRecordDeleteBlock?(id, .failure(CKError(.unknownItem)))
        try await deletion.value
        XCTAssertTrue(operation.isCancelled, "completed operations leave no unbounded background mutation")
    }

    func testDisableDeletesOnlyTheExperimentSubscription() async throws {
        let capture = WriteCapture()
        let queued = XCTestExpectation(description: "unsubscribe queued")
        let store = CloudKitProbeStore(accountStatus: { $0.finish(.success(.available)) }, submit: {
            capture.add($0); queued.fulfill()
        })
        let deletion = Task { try await store.unsubscribe() }
        await fulfillment(of: [queued], timeout: 2)
        let operation = try XCTUnwrap(capture.first as? CKModifySubscriptionsOperation)
        XCTAssertEqual(operation.subscriptionIDsToDelete, ["stage-a-attention-v1"])
        operation.perSubscriptionDeleteBlock?("stage-a-attention-v1", .success(()))
        try await deletion.value
        XCTAssertEqual(capture.count, 1)
    }

    func testQueuedOldAccountSummaryCannotBeSavedInNewAccount() async throws {
        let capture = WriteCapture()
        let store = CloudKitProbeStore(accountStatus: { $0.finish(.success(.available)) }, submit: { capture.add($0) })
        let oldAccount = try await store.checkAccount()
        await store.invalidateAccount()
        let summary = RemoteRosterSummary(schemaVersion: 1, observedAt: Date(), workingCount: 2, waitingCount: 1)
        do {
            try await store.saveRoster(summary, account: oldAccount)
            XCTFail("A queued summary cannot adopt the new account's authorization")
        } catch { XCTAssertEqual(error as? CloudKitProbeStore.ProbeError, .accountChanged) }
        XCTAssertEqual(capture.count, 0)
    }

    func testSilentPeerTerminatesWithTimeout() async {
        let store = CloudKitProbeStore()
        do {
            let _: Bool = try await store.bounded(timeout: .milliseconds(10)) { _ in }
            XCTFail("A silent peer must not leave the operation busy forever")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .timedOut)
        }
    }

    func testDuplicateAndLateCompletionCannotResumeTwice() async throws {
        let store = CloudKitProbeStore()
        let value: Bool = try await store.bounded(timeout: .milliseconds(10)) { done in
            done.finish(.success(true))
            done.finish(.failure(URLError(.cancelled)))
        }
        XCTAssertTrue(value)
        try await Task.sleep(for: .milliseconds(30))
    }
}
#endif
