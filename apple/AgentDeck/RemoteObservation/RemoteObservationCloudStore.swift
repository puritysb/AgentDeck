import CloudKit
import CryptoKit
import Foundation

/// Handles cancellation before continuation installation, duplicate callbacks and late replies.
private final class RemoteCloudPromise<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    private var result: Result<T, Error>?
    func install(_ continuation: CheckedContinuation<T, Error>) {
        lock.lock()
        if let result { lock.unlock(); continuation.resume(with: result) }
        else { self.continuation = continuation; lock.unlock() }
    }
    func finish(_ result: Result<T, Error>) {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return }
        self.result = result
        let continuation = self.continuation; self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }
}

private final class RemoteCloudCollection<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [T] = []
    private var error: Error?
    func add(_ result: Result<T, Error>) {
        lock.lock(); defer { lock.unlock() }
        switch result { case .success(let value): values.append(value); case .failure(let error): self.error = error }
    }
    func result() -> Result<[T], Error> {
        lock.lock(); defer { lock.unlock() }
        if let error { return .failure(error) }
        return .success(values)
    }
}

actor RemoteObservationCloudStore: RemoteObservationTransport {
    typealias AccountResolver = @Sendable (@escaping @Sendable (Result<String, Error>) -> Void) -> Void
    private let accountResolver: AccountResolver?
    private let submitOverride: (@Sendable (CKDatabaseOperation) -> Void)?
    private let deadline: Duration
    private var container: CKContainer { CKContainer(identifier: RemoteObservationContract.container) }
    private var database: CKDatabase { container.privateCloudDatabase }
    static let zoneID = CKRecordZone.ID(zoneName: RemoteObservationContract.zone, ownerName: CKCurrentUserDefaultName)
    private var generation = 0
    private var operations: [UUID: CKDatabaseOperation] = [:]
    private var retiredOperations: [CKDatabaseOperation] = []

    init(account: AccountResolver? = nil, submit: (@Sendable (CKDatabaseOperation) -> Void)? = nil,
         deadline: Duration = .seconds(RemoteObservationPolicy.networkTimeout)) {
        accountResolver = account; submitOverride = submit; self.deadline = deadline
    }

    private func bounded<T: Sendable>(_ start: @escaping @Sendable (RemoteCloudPromise<T>) -> Void,
                                     cancel: @escaping @Sendable () -> Void = {}) async throws -> T {
        let promise = RemoteCloudPromise<T>()
        let deadline = deadline
        let timer = Task {
            do { try await Task.sleep(for: deadline) }
            catch { return }
            cancel(); promise.finish(.failure(URLError(.timedOut)))
        }
        defer { timer.cancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                promise.install(continuation)
                if Task.isCancelled { promise.finish(.failure(CancellationError())) }
                else { start(promise) }
            }
        } onCancel: {
            cancel(); promise.finish(.failure(CancellationError()))
        }
    }

    private func verify(_ account: RemoteObservationAccount) throws {
        try Task.checkCancellation()
        guard account.generation == generation else { throw RemoteObservationError.accountChanged }
    }

    private func perform<T: Sendable>(_ operation: CKDatabaseOperation, account: RemoteObservationAccount,
                                     configure: @escaping @Sendable (RemoteCloudPromise<T>) -> Void) async throws -> T {
        try verify(account)
        let id = UUID()
        operations[id] = operation
        // Remote updates have a bounded freshness window even with the dashboard closed.
        operation.configuration.qualityOfService = .userInitiated
        operation.configuration.timeoutIntervalForRequest = RemoteObservationPolicy.networkTimeout
        operation.configuration.timeoutIntervalForResource = RemoteObservationPolicy.networkTimeout
        defer {
            operation.cancel(); operations.removeValue(forKey: id)
            if !operation.isFinished { retiredOperations.append(operation) }
            retiredOperations.removeAll { $0.isFinished }
        }
        let submit: @Sendable (CKDatabaseOperation) -> Void
        if let submitOverride { submit = submitOverride }
        else { let database = database; submit = { database.add($0) } }
        let value = try await bounded({ done in configure(done); submit(operation) }, cancel: { operation.cancel() })
        try verify(account)
        return value
    }

    func account() async throws -> RemoteObservationAccount {
        let token = generation
        if let accountResolver {
            let identity: String = try await bounded { done in accountResolver { done.finish($0) } }
            guard token == generation else { throw RemoteObservationError.accountChanged }
            return .init(identity: identity, generation: token)
        }
        guard let environment = RemoteObservationContract.environment else { throw RemoteObservationError.invalidData }
        let container = container
        let status: CKAccountStatus = try await bounded { done in
            container.accountStatus { status, error in
                if let error { done.finish(.failure(error)) } else { done.finish(.success(status)) }
            }
        }
        guard token == generation else { throw RemoteObservationError.accountChanged }
        switch status {
        case .available: break
        case .noAccount: throw RemoteObservationError.noAccount
        default: throw RemoteObservationError.unverifiedAccount
        }
        let user: CKRecord.ID = try await bounded { done in
            container.fetchUserRecordID { id, error in
                if let error { done.finish(.failure(error)) }
                else if let id { done.finish(.success(id)) }
                else { done.finish(.failure(RemoteObservationError.unverifiedAccount)) }
            }
        }
        guard token == generation else { throw RemoteObservationError.accountChanged }
        let hash = SHA256.hash(data: Data((RemoteObservationContract.container + ":" + environment.rawValue + ":" + user.recordName).utf8))
            .map { String(format: "%02x", $0) }.joined()
        return RemoteObservationAccount(identity: hash, generation: token)
    }

    func invalidate() {
        generation += 1
        for operation in operations.values { operation.cancel() }
    }

    /// Delete/stop may only follow settled old writes. A timed-out fence leaves the durable intent pending.
    func quiesce() async throws {
        let pending = Array(operations.values) + retiredOperations
        for operation in pending { operation.cancel() }
        let deadline = ContinuousClock.now.advanced(by: deadline)
        while pending.contains(where: { !$0.isFinished }) {
            guard ContinuousClock.now < deadline else { throw RemoteObservationError.operationUnsettled }
            try await Task.sleep(for: .milliseconds(50))
        }
        retiredOperations.removeAll { $0.isFinished }
    }

    private static func isAbsent(_ error: Error) -> Bool {
        let code = (error as? CKError)?.code
        return code == .unknownItem || code == .zoneNotFound
    }

    private func fetch(_ id: CKRecord.ID, account: RemoteObservationAccount) async throws -> CKRecord? {
        let operation = CKFetchRecordsOperation(recordIDs: [id])
        return try await perform(operation, account: account) { done in
            operation.perRecordResultBlock = { _, result in
                switch result {
                case .success(let record): done.finish(.success(record))
                case .failure(let error) where Self.isAbsent(error): done.finish(.success(nil))
                case .failure(let error): done.finish(.failure(error))
                }
            }
            operation.fetchRecordsResultBlock = { result in
                if case .failure(let error) = result {
                    done.finish(Self.isAbsent(error) ? .success(nil) : .failure(error))
                } else { done.finish(.failure(RemoteObservationError.invalidData)) }
            }
        }
    }

    private func ensureZone(account: RemoteObservationAccount) async throws {
        let operation = CKModifyRecordZonesOperation(recordZonesToSave: [CKRecordZone(zoneID: Self.zoneID)])
        let results = RemoteCloudCollection<Bool>()
        let _: Bool = try await perform(operation, account: account) { done in
            operation.perRecordZoneSaveBlock = { _, result in results.add(result.map { _ in true }) }
            operation.modifyRecordZonesResultBlock = { Self.finishMutation($0, results: results, expected: 1, done: done) }
        }
    }

    /// CloudKit may report partial failures only through per-item callbacks.
    /// Overall completion alone cannot acknowledge a subscription, zone or record batch.
    private static func finishMutation(_ result: Result<Void, Error>, results: RemoteCloudCollection<Bool>,
                                       expected: Int, done: RemoteCloudPromise<Bool>) {
        switch result {
        case .failure(let error): done.finish(.failure(error))
        case .success:
            done.finish(results.result().flatMap { $0.count == expected
                ? .success(true) : .failure(RemoteObservationError.invalidData) })
        }
    }

    private static func payload<T: Decodable>(_ type: T.Type, record: CKRecord, recordType: String) throws -> T {
        guard record.recordID.zoneID == zoneID, record.recordType == recordType,
              let version = record["schemaVersion"] as? Int else { throw RemoteObservationError.invalidData }
        guard version == RemoteObservationContract.version else { throw RemoteObservationError.unsupportedSchema }
        guard let bytes = record.encryptedValues["payload"] as? Data else { throw RemoteObservationError.invalidData }
        return try RemoteObservationContract.decode(type, from: bytes)
    }

    func snapshot(account: RemoteObservationAccount) async throws -> RemoteObservationSnapshot? {
        guard let record = try await fetch(CKRecord.ID(recordName: RemoteObservationContract.snapshotRecord, zoneID: Self.zoneID), account: account) else { return nil }
        let snapshot = try Self.payload(RemoteObservationSnapshot.self, record: record, recordType: RemoteObservationContract.snapshotType)
        try snapshot.validate()
        guard record["installationID"] as? String == snapshot.installationID.uuidString else { throw RemoteObservationError.invalidData }
        return snapshot
    }

    func event(id: UUID, account: RemoteObservationAccount) async throws -> RemoteAttentionEvent? {
        guard let record = try await fetch(CKRecord.ID(recordName: id.uuidString, zoneID: Self.zoneID), account: account) else { return nil }
        let event = try Self.payload(RemoteAttentionEvent.self, record: record, recordType: RemoteObservationContract.eventType)
        try event.validate()
        guard event.id == id, record["installationID"] as? String == event.installationID.uuidString else { throw RemoteObservationError.invalidData }
        return event
    }

    private func modify(saving: [CKRecord] = [], deleting: [CKRecord.ID] = [], account: RemoteObservationAccount) async throws {
        guard !saving.isEmpty || !deleting.isEmpty else { return }
        let operation = CKModifyRecordsOperation(recordsToSave: saving, recordIDsToDelete: deleting)
        operation.isAtomic = true
        operation.savePolicy = .ifServerRecordUnchanged
        let results = RemoteCloudCollection<Bool>()
        let _: Bool = try await perform(operation, account: account) { done in
            operation.perRecordSaveBlock = { _, result in results.add(result.map { _ in true }) }
            operation.perRecordDeleteBlock = { _, result in
                if case .failure(let error) = result, Self.isAbsent(error) { results.add(.success(true)) }
                else { results.add(result.map { true }) }
            }
            operation.modifyRecordsResultBlock = { result in
                Self.finishMutation(result, results: results, expected: saving.count + deleting.count, done: done)
            }
        }
    }

    func publish(_ snapshot: RemoteObservationSnapshot, events: [RemoteEventMutation], account: RemoteObservationAccount) async throws {
        try snapshot.validate()
        guard events.count <= RemoteObservationPolicy.pendingLimit else { throw RemoteObservationError.invalidData }
        try await ensureZone(account: account)
        let id = CKRecord.ID(recordName: RemoteObservationContract.snapshotRecord, zoneID: Self.zoneID)
        let current = try await fetch(id, account: account)
        if let current {
            let previous = try Self.payload(RemoteObservationSnapshot.self, record: current, recordType: RemoteObservationContract.snapshotType)
            guard previous.installationID == snapshot.installationID else { throw RemoteObservationError.anotherPublisher }
            guard previous.revision <= snapshot.revision else { throw RemoteObservationError.invalidData }
        }
        let record = current ?? CKRecord(recordType: RemoteObservationContract.snapshotType, recordID: id)
        record["schemaVersion"] = snapshot.schemaVersion
        record["installationID"] = snapshot.installationID.uuidString
        record["revision"] = snapshot.revision
        record["publishedAt"] = snapshot.publishedAt
        record["expiresAt"] = snapshot.expiresAt
        record.encryptedValues["payload"] = try RemoteObservationContract.encode(snapshot)
        var records = [record]
        // Resolve bounded batches concurrently so one slow read cannot age every later event in the queue.
        let existingEvents = try await withThrowingTaskGroup(of: (RemoteEventMutation, CKRecord?).self) { group in
            for mutation in events {
                group.addTask {
                    let id = CKRecord.ID(recordName: mutation.event.id.uuidString, zoneID: Self.zoneID)
                    return (mutation, try await self.fetch(id, account: account))
                }
            }
            var values: [(RemoteEventMutation, CKRecord?)] = []
            for try await value in group { values.append(value) }
            return values
        }
        for (mutation, existing) in existingEvents {
            let event = mutation.event
            try event.validate()
            guard event.installationID == snapshot.installationID else { throw RemoteObservationError.invalidData }
            let eventID = CKRecord.ID(recordName: event.id.uuidString, zoneID: Self.zoneID)
            // An ambiguous write is reconciled by identity. Old/resolved waits never create catch-up alerts.
            guard existing != nil || (mutation.mayCreate && event.resolvedAt == nil && Date() < event.expiresAt) else { continue }
            let row = existing ?? CKRecord(recordType: RemoteObservationContract.eventType, recordID: eventID)
            if let existing {
                let prior = try Self.payload(RemoteAttentionEvent.self, record: existing, recordType: RemoteObservationContract.eventType)
                guard prior.id == event.id, prior.installationID == event.installationID else { throw RemoteObservationError.invalidData }
                if prior.resolvedAt != nil { continue } // Resolution cannot be retracted by a retry.
            }
            row["schemaVersion"] = event.schemaVersion
            row["installationID"] = event.installationID.uuidString
            row["occurredAt"] = event.occurredAt
            row["expiresAt"] = event.expiresAt
            row["deleteAfter"] = event.occurredAt.addingTimeInterval(RemoteObservationContract.eventRetention)
            row.encryptedValues["payload"] = try RemoteObservationContract.encode(event)
            records.append(row)
        }
        if snapshot.sourceState == .observed {
            guard let observedAt = snapshot.observedAt, Date().timeIntervalSince(observedAt) >= 0,
                  Date().timeIntervalSince(observedAt) < RemoteObservationPolicy.sourceLifetime else {
                throw RemoteObservationError.invalidData
            }
        }
        try await modify(saving: records, account: account)
    }

    static func subscriptionPrefix(_ installation: UUID) -> String { "remote-observation-v1-\(installation.uuidString)-" }

    func subscribe(installation: UUID, receiver: UUID, enabled: Bool, account: RemoteObservationAccount) async throws {
        let id = Self.subscriptionPrefix(installation) + receiver.uuidString
        if enabled {
            guard let current = try await snapshot(account: account), current.installationID == installation else {
                throw RemoteObservationError.invalidData
            }
        }
        var subscriptions: [CKSubscription] = []
        if enabled {
            let subscription = CKQuerySubscription(recordType: RemoteObservationContract.eventType,
                predicate: NSPredicate(format: "installationID == %@", installation.uuidString),
                subscriptionID: id, options: .firesOnRecordCreation)
            subscription.zoneID = Self.zoneID
            let info = CKSubscription.NotificationInfo()
            info.alertBody = "AgentDeck has an update to review."
            info.soundName = "default"
            subscription.notificationInfo = info
            subscriptions = [subscription]
        }
        let operation = CKModifySubscriptionsOperation(subscriptionsToSave: subscriptions, subscriptionIDsToDelete: enabled ? [] : [id])
        let results = RemoteCloudCollection<Bool>()
        let _: Bool = try await perform(operation, account: account) { done in
            operation.perSubscriptionSaveBlock = { _, result in results.add(result.map { _ in true }) }
            operation.perSubscriptionDeleteBlock = { _, result in
                if case .failure(let error) = result, Self.isAbsent(error) { results.add(.success(true)) }
                else { results.add(result.map { true }) }
            }
            operation.modifySubscriptionsResultBlock = { result in
                if !enabled, case .failure(let error) = result, Self.isAbsent(error) { done.finish(.success(true)) }
                else { Self.finishMutation(result, results: results, expected: 1, done: done) }
            }
        }
        if enabled {
            guard let current = try await snapshot(account: account), current.installationID == installation else {
                // A phone paused across the Mac's deletion must not resurrect its subscription.
                try await subscribe(installation: installation, receiver: receiver, enabled: false, account: account)
                throw RemoteObservationError.invalidData
            }
        }
    }

    func delete(installation: UUID, account: RemoteObservationAccount) async throws {
        try await quiesce()
        if let current = try await snapshot(account: account), current.installationID != installation {
            throw RemoteObservationError.anotherPublisher
        }
        let fetch = CKFetchSubscriptionsOperation.fetchAllSubscriptionsOperation()
        let collected = RemoteCloudCollection<CKSubscription>()
        let subscriptions: [CKSubscription] = try await perform(fetch, account: account) { done in
            fetch.perSubscriptionResultBlock = { _, result in collected.add(result) }
            fetch.fetchSubscriptionsResultBlock = { result in
                switch result { case .failure(let error): done.finish(.failure(error)); case .success: done.finish(collected.result()) }
            }
        }
        let ids = subscriptions.map(\.subscriptionID).filter { $0.hasPrefix(Self.subscriptionPrefix(installation)) }
        if !ids.isEmpty {
            let operation = CKModifySubscriptionsOperation(subscriptionIDsToDelete: ids)
            let results = RemoteCloudCollection<Bool>()
            let _: Bool = try await perform(operation, account: account) { done in
                operation.perSubscriptionDeleteBlock = { _, result in
                    if case .failure(let error) = result, Self.isAbsent(error) { results.add(.success(true)) }
                    else { results.add(result.map { true }) }
                }
                operation.modifySubscriptionsResultBlock = { Self.finishMutation($0, results: results, expected: ids.count, done: done) }
            }
        }
        let operation = CKModifyRecordZonesOperation(recordZoneIDsToDelete: [Self.zoneID])
        let results = RemoteCloudCollection<Bool>()
        let _: Bool = try await perform(operation, account: account) { done in
            operation.perRecordZoneDeleteBlock = { _, result in
                if case .failure(let error) = result, Self.isAbsent(error) { results.add(.success(true)) }
                else { results.add(result.map { true }) }
            }
            operation.modifyRecordZonesResultBlock = { result in
                if case .failure(let error) = result, Self.isAbsent(error) { done.finish(.success(true)) }
                else { Self.finishMutation(result, results: results, expected: 1, done: done) }
            }
        }
        guard try await snapshot(account: account) == nil else { throw RemoteObservationError.operationUnsettled }
    }

    func cleanup(at now: Date, account: RemoteObservationAccount) async throws {
        let query = CKQuery(recordType: RemoteObservationContract.eventType, predicate: NSPredicate(format: "deleteAfter <= %@", now as NSDate))
        let operation = CKQueryOperation(query: query)
        operation.zoneID = Self.zoneID
        operation.resultsLimit = RemoteObservationContract.cleanupBatch
        operation.desiredKeys = []
        let collected = RemoteCloudCollection<CKRecord.ID>()
        let ids: [CKRecord.ID] = try await perform(operation, account: account) { done in
            operation.recordMatchedBlock = { id, result in collected.add(result.map { _ in id }) }
            operation.queryResultBlock = { result in
                switch result {
                case .success: done.finish(collected.result())
                case .failure(let error) where Self.isAbsent(error): done.finish(.success([]))
                case .failure(let error): done.finish(.failure(error))
                }
            }
        }
        try await modify(deleting: ids, account: account)
    }
}
