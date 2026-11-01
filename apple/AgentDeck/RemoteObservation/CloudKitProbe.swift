#if AGENTDECK_CLOUDKIT_POC
import CloudKit
import CryptoKit
import Foundation
import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#endif

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

@MainActor
final class CloudKitProbeModel: ObservableObject {
    static let shared = CloudKitProbeModel()
    @Published private(set) var status = "Not connected"
    @Published private(set) var event: CloudKitProbeEvent?
    @Published private(set) var busy = false
    @Published private(set) var roster: RemoteRosterSummary?
    private let store: CloudKitProbeStore
    private let cache: RemoteReaderCache
    private var generation = 0
    private var accountObserver: NSObjectProtocol?
    init(store: CloudKitProbeStore = CloudKitProbeStore(), cache: RemoteReaderCache = RemoteReaderCache()) {
        self.store = store
        self.cache = cache
        guard !AgentDeckApp.isHostedTest() else { return }
        roster = cache.load(localIdentity: RemoteLocalIdentity.current())
        if roster != nil { status = "Restored last observation from this account’s local cache." }
        accountObserver = NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.generation += 1
                self?.event = nil
                self?.roster = nil
                try? self?.cache.clear()
                self?.busy = false
                self?.status = "iCloud account changed. Enable receiving again."
                await self?.store.invalidateAccount()
            }
        }
    }
    func restoreCachedObservation() async {
        guard !AgentDeckApp.isHostedTest(), roster == nil,
              cache.disk.read("reader.json", as: RemoteReaderCache.Envelope.self) != nil else { return }
        status = "Verifying iCloud account before restoring the saved observation…"
        await run("restore")
    }
    func run(_ action: String) async {
        guard !busy else { return }
        busy = true
        let token = generation
        defer { if token == generation { busy = false } }
        if action == "disable" {
            #if os(iOS)
            UIApplication.shared.unregisterForRemoteNotifications()
            #endif
            roster = nil
            event = nil
            try? cache.clear()
        }
        if action == "storage" {
            defer { try? cache.disk.remove("storage-check.json") }
            do {
                try cache.disk.write(["version": 1], to: "storage-check.json")
                guard cache.disk.read("storage-check.json", as: [String: Int].self) == ["version": 1] else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                status = "Local cache storage round trip passed."
            } catch {
                let failure = error as NSError
                status = "Local cache storage failed: \(failure.domain) \(failure.code)."
            }
            return
        }
        do {
            let account = try await store.checkAccount()
            guard token == generation else { return }
            if action == "disable" {
                try await store.unsubscribe(account: account)
                guard token == generation else { return }
                status = "PoC receiving disabled; this reader is cleared."
            } else if action == "send" {
                let result = try await store.sendTest(account: account)
                guard token == generation else { return }
                event = result
                status = "Saved to CloudKit; notification delivery is not confirmed."
            } else if action == "receive" {
                #if os(iOS)
                let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
                guard allowed else { status = "Notifications are disabled in Settings."; return }
                UIApplication.shared.registerForRemoteNotifications()
                #endif
                try await store.subscribe(account: account)
                guard token == generation else { return }
                status = "Subscription saved. Send a test from the Mac."
            } else if action == "restore" {
                let owner = try await store.accountIdentity(account: account)
                guard token == generation else { return }
                roster = cache.load(localIdentity: RemoteLocalIdentity.current(), verifiedAccount: owner)
                status = roster == nil ? "No saved observation for this account." : "Restored original observation from this account’s local cache."
            } else if action == "roster" {
                let owner = try await store.accountIdentity(account: account)
                guard token == generation else { return }
                roster = cache.load(localIdentity: RemoteLocalIdentity.current(), verifiedAccount: owner)
                let result = try await store.fetchRoster(account: account)
                guard token == generation else { return }
                roster = result
                do {
                    try cache.save(result, account: owner, localIdentity: RemoteLocalIdentity.current())
                    status = "Fetched and cached original source observation."
                } catch {
                    let failure = error as NSError
                    status = "Fetched; durable cache write failed: \(failure.domain) \(failure.code). Retry refresh when storage is available."
                }
            } else {
                let result = try await store.fetchLatest(account: account)
                guard token == generation else { return }
                event = result
                status = "Fetched. Observation time below is unchanged."
            }
        } catch {
            guard token == generation else { return }
            if action == "disable" {
                status = "This device stopped push registration and cleared its reader. Cloud subscription deletion is not confirmed; retry when online."
            } else if (error as? CloudKitProbeStore.ProbeError) == .accountUnverified {
                status = "iCloud account state is unverified. The last saved observation is retained; retry when available."
            } else if (error as? CloudKitProbeStore.ProbeError) == .accountUnavailable
                || (error as? CloudKitProbeStore.ProbeError) == .accountChanged {
                roster = nil; event = nil
                try? cache.clear()
                status = "iCloud identity is unavailable or changed. Reader cleared; enable again when ready."
            } else if action == "roster", (error as? CKError)?.code == .unknownItem {
                roster = nil
                try? cache.clear()
                status = "Shared summary is unavailable or has been deleted."
            } else if (error as? URLError)?.code == .timedOut {
                status = action == "send"
                    ? "CloudKit response timed out. Save outcome is unknown; fetch to check before retrying."
                    : "CloudKit read timed out. Last observation is retained; retry when online."
            } else {
                status = "CloudKit unavailable (\((error as NSError).domain):\((error as NSError).code)). Retry when ready."
            }
        }
    }
}

struct CloudKitProbeView: View {
    @ObservedObject private var model = CloudKitProbeModel.shared
    #if os(iOS)
    @State private var showLocalDashboard = false
    #endif
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("CloudKit delivery experiment").font(.headline)
            Text("Test buttons share synthetic IDs and times. The optional local summary experiment separately shares only encrypted counts and their original observation time.")
            #if os(macOS)
            Button("Send test update") { Task { await model.run("send") } }.disabled(model.busy)
            #else
            Button("Local network dashboard") { showLocalDashboard = true }
            Button("Enable test notifications") { Task { await model.run("receive") } }.disabled(model.busy)
            Button("Disable PoC notifications and clear reader") { Task { await model.run("disable") } }.disabled(model.busy)
            Text("Disabling also removes this experiment’s shared iCloud subscription.").font(.caption)
            #endif
            #if os(macOS)
            LocalRosterProbeView()
            #else
            Button("Check local cache storage") { Task { await model.run("storage") } }.disabled(model.busy)
            Button("Fetch local work summary") { Task { await model.run("roster") } }.disabled(model.busy)
            if let roster = model.roster {
                TimelineView(.periodic(from: .now, by: 15)) { context in
                    if roster.freshness(at: context.date) == .recent || roster.freshness(at: context.date) == .historical {
                        Text("Last observed: \(roster.workingCount) working · \(roster.waitingCount) waiting")
                            .accessibilityIdentifier("remote-observation.counts")
                    }
                    Text("Freshness: \(String(describing: roster.freshness(at: context.date)))")
                    Text(roster.observedAt, style: .time)
                        .accessibilityIdentifier("remote-observation.source-time")
                }
            }
            #endif
            Button("Fetch latest test") { Task { await model.run("fetch") } }.disabled(model.busy)
            Text(model.status).foregroundStyle(.secondary)
            if let event = model.event {
                TimelineView(.periodic(from: .now, by: 15)) { context in
                    Text(event.isExpired(at: context.date) ? "Historical test · expired" : "Test observation")
                    Text(event.occurredAt, style: .date)
                    Text(event.occurredAt, style: .time)
                }
            }
            if model.busy { ProgressView() }
        }.padding()
        #if os(iOS)
        .fullScreenCover(isPresented: $showLocalDashboard) { LocalControlProbeView() }
        .task { await model.restoreCachedObservation() }
        #endif
        #if os(macOS)
        .task {
            guard !AgentDeckApp.isHostedTest() else { return }
            if ProcessInfo.processInfo.environment["AGENTDECK_CLOUDKIT_TEST_SEND"] == "1" {
                await model.run("send")
                NSLog("CloudKit stage A: %@", model.status)
            }
        }
        #endif
    }
}

#if os(iOS)
final class CloudKitProbeDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await CloudKitProbeModel.shared.run("roster")
        if await CloudKitProbeModel.shared.roster == nil {
            await CloudKitProbeModel.shared.run("fetch")
        }
    }
}
#endif
#endif
