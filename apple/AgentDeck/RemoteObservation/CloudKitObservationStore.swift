#if AGENTDECK_CLOUDKIT_POC
import CloudKit
import CryptoKit
import Foundation

/// Stage A deliberately carries no session content or credentials.
struct CloudKitProbeEvent: Identifiable, Sendable {
    let id: String
    let occurredAt: Date
    let expiresAt: Date
    func isExpired(at now: Date) -> Bool { now >= expiresAt }
}

/// Resolves once, including when a cancelled CloudKit request completes late.
final class ProbeCompletion<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    init(_ continuation: CheckedContinuation<T, Error>) { self.continuation = continuation }
    func finish(_ result: Result<T, Error>) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(with: result)
    }
}

actor CloudKitProbeStore {
    static let containerID = "iCloud.bound.serendipity.agent.deck"
    private var container: CKContainer { CKContainer(identifier: Self.containerID) }
    private var database: CKDatabase { container.privateCloudDatabase }
    private let recordID = CKRecord.ID(recordName: "stage-a-latest-test")
    private(set) var phase = "idle"
    private var accountGeneration = 0
    private var writes: [UUID: CKDatabaseOperation] = [:]
    private let accountStatusOverride: (@Sendable (ProbeCompletion<CKAccountStatus>) -> Void)?
    private let deadline: Duration
    private let submitOverride: (@Sendable (CKDatabaseOperation) -> Void)?

    init(accountStatus: (@Sendable (ProbeCompletion<CKAccountStatus>) -> Void)? = nil,
         submit: (@Sendable (CKDatabaseOperation) -> Void)? = nil,
         deadline: Duration = .seconds(RemoteObservationPolicy.networkTimeout)) {
        self.deadline = deadline
        accountStatusOverride = accountStatus
        submitOverride = submit
    }

    func invalidateAccount() {
        accountGeneration += 1
        for operation in writes.values { operation.cancel() }
        writes.removeAll()
    }

    func bounded<T: Sendable>(timeout: Duration? = nil, _ start: @escaping @Sendable (ProbeCompletion<T>) -> Void) async throws -> T {
        let timeout = timeout ?? deadline
        return try await withCheckedThrowingContinuation { continuation in
            let completion = ProbeCompletion(continuation)
            start(completion)
            Task {
                try? await Task.sleep(for: timeout)
                completion.finish(.failure(URLError(.timedOut)))
            }
        }
    }

    @discardableResult
    func checkAccount(expected: Int? = nil) async throws -> Int {
        let generation = accountGeneration
        phase = "account check"
        let read: @Sendable (ProbeCompletion<CKAccountStatus>) -> Void
        if let accountStatusOverride { read = accountStatusOverride }
        else {
            let container = container
            read = { done in
                container.accountStatus { status, error in
                    if let error { done.finish(.failure(error)) }
                    else { done.finish(.success(status)) }
                }
            }
        }
        let status = try await bounded(read)
        guard generation == accountGeneration, expected == nil || expected == generation else { throw ProbeError.accountChanged }
        switch status {
        case .available: return generation
        case .noAccount: throw ProbeError.accountUnavailable
        case .couldNotDetermine, .temporarilyUnavailable, .restricted:
            throw ProbeError.accountUnverified
        @unknown default: throw ProbeError.accountUnverified
        }
    }

    func accountIdentity(account: Int? = nil) async throws -> String {
        let generation = try await checkAccount(expected: account)
        let container = container
        let id: CKRecord.ID = try await bounded { done in
            container.fetchUserRecordID { id, error in
                if let error { done.finish(.failure(error)) }
                else if let id { done.finish(.success(id)) }
                else { done.finish(.failure(ProbeError.invalidRecord)) }
            }
        }
        guard generation == accountGeneration else { throw ProbeError.accountChanged }
        return SHA256.hash(data: Data((Self.containerID + ":" + id.recordName).utf8))
            .map { String(format: "%02x", $0) }.joined()
    }

    private func fetchRecord(_ id: CKRecord.ID, account: Int) async throws -> CKRecord? {
        guard account == accountGeneration else { throw ProbeError.accountChanged }
        let operation = CKFetchRecordsOperation(recordIDs: [id])
        let requestID = UUID()
        writes[requestID] = operation
        defer { operation.cancel(); writes.removeValue(forKey: requestID) }
        operation.configuration.timeoutIntervalForRequest = RemoteObservationPolicy.networkTimeout
        operation.configuration.timeoutIntervalForResource = RemoteObservationPolicy.networkTimeout
        let submit: @Sendable (CKDatabaseOperation) -> Void
        if let submitOverride { submit = submitOverride }
        else { let database = database; submit = { database.add($0) } }
        let result: CKRecord? = try await bounded { done in
            operation.perRecordResultBlock = { _, result in
                switch result {
                case .success(let record): done.finish(.success(record))
                case .failure(let error) where (error as? CKError)?.code == .unknownItem: done.finish(.success(nil))
                case .failure(let error): done.finish(.failure(error))
                }
            }
            operation.fetchRecordsResultBlock = { result in
                if case .failure(let error) = result { done.finish(.failure(error)) }
                else { done.finish(.failure(ProbeError.invalidRecord)) }
            }
            submit(operation)
        }
        guard account == accountGeneration else { throw ProbeError.accountChanged }
        return result
    }

    func waitEpisodeExists(id: UUID, account: Int) async throws -> Bool {
        try await fetchRecord(CKRecord.ID(recordName: id.uuidString), account: account) != nil
    }

    func sendTest(account: Int? = nil) async throws -> CloudKitProbeEvent {
        let generation = try await checkAccount(expected: account)
        let now = Date()
        let event = CloudKitProbeEvent(id: UUID().uuidString, occurredAt: now,
                                      expiresAt: now.addingTimeInterval(300))
        // A separate immutable event triggers the creation subscription. The latest
        // pointer is written first so a delayed notification always opens current data.
        let latest = CKRecord(recordType: "ObservationProbe", recordID: recordID)
        latest["occurredAt"] = event.occurredAt
        latest["expiresAt"] = event.expiresAt
        latest["eventID"] = event.id
        let alert = CKRecord(recordType: "AttentionProbe", recordID: CKRecord.ID(recordName: event.id))
        alert["occurredAt"] = event.occurredAt
        alert["expiresAt"] = event.expiresAt
        try await save(latest, account: generation)
        try await save(alert, account: generation)
        return event
    }

    private func mutate(_ operation: CKDatabaseOperation, account generation: Int,
                        configure: @escaping @Sendable (ProbeCompletion<Bool>) -> Void) async throws {
        guard generation == accountGeneration else { throw ProbeError.accountChanged }
        let writeID = UUID()
        writes[writeID] = operation
        defer {
            operation.cancel()
            writes.removeValue(forKey: writeID)
        }
        operation.configuration.timeoutIntervalForRequest = RemoteObservationPolicy.networkTimeout
        operation.configuration.timeoutIntervalForResource = RemoteObservationPolicy.networkTimeout
        let submit: @Sendable (CKDatabaseOperation) -> Void
        if let submitOverride { submit = submitOverride }
        else {
            let database = database
            submit = { database.add($0) }
        }
        let _: Bool = try await bounded { done in
            configure(done)
            submit(operation)
        }
        guard generation == accountGeneration else { throw ProbeError.accountChanged }
    }

    private func save(_ record: CKRecord, account generation: Int, policy: CKModifyRecordsOperation.RecordSavePolicy = .allKeys) async throws {
        phase = "save " + record.recordType
        let operation = CKModifyRecordsOperation(recordsToSave: [record])
        operation.savePolicy = policy
        try await mutate(operation, account: generation) { done in
            operation.perRecordSaveBlock = { _, result in done.finish(result.map { _ in true }) }
            operation.modifyRecordsResultBlock = { result in done.finish(result.map { true }) }
        }
    }

    func subscribe(account: Int? = nil) async throws {
        let generation = try await checkAccount(expected: account)
        let subscription = CKQuerySubscription(recordType: "AttentionProbe", predicate: NSPredicate(value: true),
            subscriptionID: "stage-a-attention-v1", options: .firesOnRecordCreation)
        let info = CKSubscription.NotificationInfo()
        info.alertBody = "AgentDeck test update. Open to check its time."
        info.soundName = "default"
        subscription.notificationInfo = info
        let operation = CKModifySubscriptionsOperation(subscriptionsToSave: [subscription])
        try await mutate(operation, account: generation) { done in
            operation.perSubscriptionSaveBlock = { _, result in done.finish(result.map { _ in true }) }
            operation.modifySubscriptionsResultBlock = { done.finish($0.map { true }) }
        }
    }

    func unsubscribe(account: Int? = nil) async throws {
        let generation = try await checkAccount(expected: account)
        let operation = CKModifySubscriptionsOperation(subscriptionIDsToDelete: ["stage-a-attention-v1"])
        try await mutate(operation, account: generation) { done in
            operation.perSubscriptionDeleteBlock = { _, result in
                if case .failure(let error) = result, (error as? CKError)?.code == .unknownItem {
                    done.finish(.success(true))
                } else { done.finish(result.map { true }) }
            }
            operation.modifySubscriptionsResultBlock = { done.finish($0.map { true }) }
        }
    }

    func fetchLatest(account: Int? = nil) async throws -> CloudKitProbeEvent {
        let generation = try await checkAccount(expected: account)
        guard let record = try await fetchRecord(recordID, account: generation) else { throw CKError(.unknownItem) }
        guard let id = record["eventID"] as? String,
              let occurred = record["occurredAt"] as? Date,
              let expiry = record["expiresAt"] as? Date else { throw ProbeError.invalidRecord }
        return CloudKitProbeEvent(id: id, occurredAt: occurred, expiresAt: expiry)
    }

    func saveRoster(_ summary: RemoteRosterSummary, account: Int? = nil,
                    installation: UUID? = nil, revision: Int? = nil) async throws {
        let generation = try await checkAccount(expected: account)
        guard summary.freshness(at: Date()) == .recent else { throw ProbeError.invalidRecord }
        let id = CKRecord.ID(recordName: "stage-b-latest")
        var record = CKRecord(recordType: "RosterProbe", recordID: id)
        if let installation, let revision {
            if let current = try await fetchRecord(id, account: generation) {
                if let owner = current["installationID"] as? String, owner != installation.uuidString { throw ProbeError.publisherConflict }
                if let previous = current["revision"] as? Int, previous > revision { throw ProbeError.invalidRecord }
                record = current
            }
            record["installationID"] = installation.uuidString
            record["revision"] = revision
        }
        record.encryptedValues["summary"] = try JSONEncoder().encode(summary)
        try await save(record, account: generation, policy: installation == nil ? .allKeys : .ifServerRecordUnchanged)
    }

    func saveWaitEpisode(id: UUID, occurredAt: Date, account: Int? = nil) async throws {
        let generation = try await checkAccount(expected: account)
        let age = Date().timeIntervalSince(occurredAt)
        guard age >= 0, age < 300 else { throw ProbeError.invalidRecord }
        let record = CKRecord(recordType: "AttentionProbe", recordID: CKRecord.ID(recordName: id.uuidString))
        record["occurredAt"] = occurredAt
        record["expiresAt"] = occurredAt.addingTimeInterval(300)
        record.encryptedValues["kind"] = "needsResponse"
        try await save(record, account: generation)
    }

    func deleteRoster(account: Int? = nil) async throws {
        let generation = try await checkAccount(expected: account)
        let operation = CKModifyRecordsOperation(recordIDsToDelete: [CKRecord.ID(recordName: "stage-b-latest")])
        try await mutate(operation, account: generation) { done in
            operation.perRecordDeleteBlock = { _, result in
                if case .failure(let error) = result, (error as? CKError)?.code == .unknownItem {
                    done.finish(.success(true))
                } else { done.finish(result.map { true }) }
            }
            operation.modifyRecordsResultBlock = { done.finish($0.map { true }) }
        }
    }

    func fetchRoster(account: Int? = nil) async throws -> RemoteRosterSummary {
        let generation = try await checkAccount(expected: account)
        guard let record = try await fetchRecord(CKRecord.ID(recordName: "stage-b-latest"), account: generation) else { throw CKError(.unknownItem) }
        guard let data = record.encryptedValues["summary"] as? Data else { throw ProbeError.invalidRecord }
        guard data.count <= 16384 else { throw ProbeError.invalidRecord }
        let summary = try JSONDecoder().decode(RemoteRosterSummary.self, from: data)
        guard summary.schemaVersion == 1, summary.workingCount >= 0, summary.waitingCount >= 0 else {
            throw ProbeError.invalidRecord
        }
        return summary
    }

    enum ProbeError: Error, Equatable { case accountUnavailable, accountUnverified, accountChanged, invalidRecord, publisherConflict }
}
#endif
