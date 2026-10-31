#if os(macOS)
import Foundation
import SQLite3
import CryptoKit
import CoreFoundation

@DaemonActor
final class DaemonRecoveryStore {
    struct Head { var store: String; var revision: Int64; var payload: String }
    enum Failure: Error { case invalid, unavailable, conflict, changedStore, offlineConflict }
    let directory: URL
    init(directory: URL) { self.directory = directory }
    private func database<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
        let file = directory.appendingPathComponent(DaemonParityRules.recoveryFile)
        if let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
           attributes[.type] as? FileAttributeType != .typeRegular { throw Failure.invalid }
        var handle: OpaquePointer?
        guard sqlite3_open_v2(file.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let db = handle else { if let handle { sqlite3_close(handle) }; throw Failure.unavailable }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, Int32(DaemonParityRules.recoveryBusyTimeoutMs))
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "PRAGMA user_version", -1, &statement, nil) == SQLITE_OK else { throw Failure.invalid }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw Failure.invalid }
        let version = sqlite3_column_int(statement, 0)
        guard version == 0 || version == DaemonParityRules.recoveryVersion else { throw Failure.invalid }
        sqlite3_finalize(statement); statement = nil
        try execute(db, "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")
        if version == 0 { try execute(db, "\(DaemonParityRules.recoverySchema) PRAGMA user_version=\(DaemonParityRules.recoveryVersion);") }
        return try body(db)
    }
    private func execute(_ db: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw Failure.unavailable }
    }
    private func head(_ db: OpaquePointer) throws -> Head? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT store_id,revision,payload FROM recovery_head WHERE singleton=1", -1, &statement, nil) == SQLITE_OK else { throw Failure.invalid }
        defer { sqlite3_finalize(statement) }
        let status = sqlite3_step(statement)
        if status == SQLITE_DONE { return nil }
        guard status == SQLITE_ROW, let store = sqlite3_column_text(statement, 0), let text = sqlite3_column_text(statement, 2) else { throw Failure.invalid }
        let value = Head(store: String(cString: store), revision: sqlite3_column_int64(statement, 1), payload: String(cString: text))
        guard UUID(uuidString: value.store) != nil, value.revision > 0, value.revision <= DaemonParityRules.recoveryMaxRevision else { throw Failure.invalid }
        _ = try Self.payload(value.payload)
        return value
    }
    static func payload(_ text: String) throws -> String {
        guard let parsed = DaemonCheckpointStore.parse(text), parsed.configuration != nil,
              let result = String(data: try DaemonCheckpointStore.encoded(parsed), encoding: .utf8) else { throw Failure.invalid }
        return result
    }
    func load() throws -> Head? { try database { try head($0) } }
    func commit(expected: Head?, payload: String) throws -> Head {
        let normalized = try Self.payload(payload)
        return try database { db in
            try execute(db, "BEGIN IMMEDIATE")
            defer { try? execute(db, "ROLLBACK") }
            let current = try head(db)
            guard current?.store == expected?.store, current?.revision == expected?.revision, current?.payload == expected?.payload else { throw Failure.conflict }
            guard (current?.revision ?? 0) < DaemonParityRules.recoveryMaxRevision else { throw Failure.invalid }
            let next = Head(store: current?.store ?? UUID().uuidString.lowercased(), revision: (current?.revision ?? 0) + 1, payload: normalized)
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO recovery_head(singleton,store_id,revision,payload) VALUES(1,?,?,?)", -1, &statement, nil) == SQLITE_OK else { throw Failure.invalid }
            defer { sqlite3_finalize(statement) }
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            sqlite3_bind_text(statement, 1, next.store, -1, transient)
            sqlite3_bind_int64(statement, 2, next.revision)
            sqlite3_bind_text(statement, 3, next.payload, -1, transient)
            guard sqlite3_step(statement) == SQLITE_DONE else { throw Failure.unavailable }
            try execute(db, "COMMIT")
            return next
        }
    }
}

@DaemonActor
final class DaemonRecoverySession {
    struct Cursor: Codable { var store: String; var revision: Int64; var digest: String }
    private let store: DaemonRecoveryStore
    private let directory: URL
    private let shared: URL
    private let scoped: Bool
    private var head: DaemonRecoveryStore.Head?
    init(shared: URL, directory: URL) throws {
        self.shared = shared; scoped = shared.startAccessingSecurityScopedResource()
        guard scoped || !AgentDeckRuntime.isSandboxed else { throw CocoaError(.fileReadNoPermission) }
        store = .init(directory: shared); self.directory = directory
    }
    deinit { if scoped { shared.stopAccessingSecurityScopedResource() } }
    private func read(_ name: String) throws -> Data? {
        do { return try Data(contentsOf: directory.appendingPathComponent(name)) }
        catch let e as CocoaError where e.code == .fileReadNoSuchFile { return nil }
    }
    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func selection(_ configuration: DaemonConfiguration?) -> DaemonConfiguration? {
        guard var value = configuration else { return nil }
        for index in value.pins.indices { value.pins[index].lastSeenAt = 0 }
        return value
    }
    private struct UserState: Encodable {
        var pocket: PocketAutonomy.State
        var receipts: [DaemonReceipt]
        var configuration: DaemonConfiguration?
    }
    private func userState(_ text: String) throws -> Data {
        guard let value = DaemonCheckpointStore.parse(text) else { throw DaemonRecoveryStore.Failure.invalid }
        return try DaemonConfigurationRules.data(UserState(pocket: value.pocket, receipts: value.receipts, configuration: selection(value.configuration)))
    }
    func prepare(configuration: DaemonConfiguration? = nil) throws -> Bool {
        head = try store.load()
        let consent = shared.appendingPathComponent(DaemonParityRules.recoveryConsentFile)
        if FileManager.default.fileExists(atPath: consent.path) {
            guard let marker = try JSONSerialization.jsonObject(with: Data(contentsOf: consent)) as? [String: Any],
                  DaemonConfigurationRules.integer(marker["version"]) == Int64(DaemonParityRules.recoveryVersion),
                  let enabled = marker["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(),
                  marker["store"] as? String == head?.store else { throw DaemonRecoveryStore.Failure.invalid }
        }
        let cursor = try read(DaemonParityRules.recoveryCursorFile).map { try JSONDecoder().decode(Cursor.self, from: $0) }
        if let cursor {
            guard UUID(uuidString: cursor.store) != nil, cursor.revision > 0, cursor.digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw DaemonRecoveryStore.Failure.invalid }
            guard let head, cursor.store == head.store, cursor.revision <= head.revision else { throw DaemonRecoveryStore.Failure.changedStore }
        }
        guard let head else { return false }
        let peer = try read("daemon-checkpoint-peer.json")
        func retirePeer() throws {
            guard let peer else { return }
            guard let text = String(data: peer, encoding: .utf8) else { throw DaemonRecoveryStore.Failure.invalid }
            let normalized = try DaemonRecoveryStore.payload(text)
            if normalized != (try DaemonRecoveryStore.payload(head.payload)) {
                try Data(normalized.utf8).write(to: directory.appendingPathComponent("daemon-recovery-peer-profile-\(UUID().uuidString.lowercased()).json"), options: .atomic)
            }
            try FileManager.default.removeItem(at: directory.appendingPathComponent("daemon-checkpoint-peer.json"))
        }
        if cursor?.revision == head.revision { try retirePeer(); return false }
        if cursor != nil, let local = try read("daemon-checkpoint.json"), let configuration,
           let text = String(data: local, encoding: .utf8), selection(configuration) != selection(DaemonCheckpointStore.parse(text)?.configuration) {
            throw DaemonRecoveryStore.Failure.offlineConflict
        }
        if let cursor, let local = try read("daemon-checkpoint.json"), digest(local) != cursor.digest {
            guard let text = String(data: local, encoding: .utf8), try userState(text) == userState(head.payload) else { throw DaemonRecoveryStore.Failure.offlineConflict }
        }
        try retirePeer()
        try Data(head.payload.utf8).write(to: directory.appendingPathComponent("daemon-checkpoint-peer.json"), options: .atomic)
        return true
    }
    func publish(_ text: String) throws {
        let value = try DaemonRecoveryStore.payload(text)
        if head == nil || head?.payload != value { head = try store.commit(expected: head, payload: value) }
        guard let head else { throw DaemonRecoveryStore.Failure.invalid }
        try JSONEncoder().encode(Cursor(store: head.store, revision: head.revision, digest: digest(Data(text.utf8))))
            .write(to: directory.appendingPathComponent(DaemonParityRules.recoveryCursorFile), options: .atomic)
    }
}
#endif
