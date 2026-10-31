#if os(macOS)
import Foundation
import SQLite3
import CryptoKit
import CoreFoundation

struct RecoveryProfileSummary: Codable, Sendable {
    var pins: Int
    var displays: Int
    var feedback: Double
    @DaemonActor init(_ text: String) throws {
        guard let value = DaemonCheckpointStore.parse(text), let configuration = value.configuration else { throw DaemonRecoveryStore.Failure.invalid }
        pins = configuration.pins.count; displays = configuration.pixoo.devices.count; feedback = value.pocket.feedbackCount
    }
}
struct RecoveryConflict: Identifiable, Sendable {
    var profile: String
    var runtime: String
    var localDigest: String
    var store: String
    var revision: Int64
    var headDigest: String
    var local: RecoveryProfileSummary
    var recovered: RecoveryProfileSummary
    var pending: Bool
    var id: String { profile }
}

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
        guard version == 0 || version == 1 || version == DaemonParityRules.recoverySchemaVersion else { throw Failure.invalid }
        sqlite3_finalize(statement); statement = nil
        try execute(db, "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")
        if version < DaemonParityRules.recoverySchemaVersion {
            try execute(db, "BEGIN IMMEDIATE")
            do { try execute(db, "\(DaemonParityRules.recoverySchema) PRAGMA user_version=\(DaemonParityRules.recoverySchemaVersion); COMMIT;") }
            catch { try? execute(db, "ROLLBACK"); throw error }
        }
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
    static func digest(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func query(_ db: OpaquePointer, _ sql: String, _ values: [String] = []) throws -> [[String: String]] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw Failure.invalid }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in values.enumerated() { sqlite3_bind_text(statement, Int32(index + 1), value, -1, transient) }
        var rows: [[String: String]] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { return rows }
            guard result == SQLITE_ROW else { throw Failure.unavailable }
            var row: [String: String] = [:]
            for i in 0..<sqlite3_column_count(statement) {
                guard let name = sqlite3_column_name(statement, i), let value = sqlite3_column_text(statement, i) else { throw Failure.invalid }
                row[String(cString: name)] = String(cString: value)
            }
            rows.append(row)
        }
    }
    func report(profile: String, snapshot: String) throws {
        let normalized = try Self.payload(snapshot), fingerprint = try DaemonRecoverySession.fingerprint(normalized)
        try database { db in
            try execute(db, "BEGIN IMMEDIATE"); defer { try? execute(db, "ROLLBACK") }
            let known = try query(db, "SELECT profile FROM recovery_conflicts WHERE profile=?", [profile])
            let count = try query(db, "SELECT COUNT(*) AS count FROM recovery_conflicts").first?["count"].flatMap(Int.init) ?? Int.max
            guard !known.isEmpty || count < DaemonParityRules.recoveryMaxConflicts else { throw Failure.unavailable }
            _ = try query(db, "INSERT OR REPLACE INTO recovery_conflicts(profile,runtime,local_digest,snapshot) VALUES(?,?,?,?)", [profile,"Swift",fingerprint,normalized])
            try execute(db, "COMMIT")
        }
    }
    func conflicts() throws -> [RecoveryConflict] {
        try database { db in
            guard let head = try head(db) else { return [] }
            let rows = try query(db, "SELECT c.profile,c.runtime,c.local_digest,c.snapshot,EXISTS(SELECT 1 FROM recovery_resolutions r WHERE r.profile=c.profile AND r.local_digest=c.local_digest AND r.store_id=? AND r.applied=0) AS pending FROM recovery_conflicts c", [head.store])
            guard rows.count <= DaemonParityRules.recoveryMaxConflicts else { throw Failure.invalid }
            return try rows.map { row in
                guard let profile = row["profile"], let runtime = row["runtime"], let localDigest = row["local_digest"], let snapshot = row["snapshot"],
                      profile.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil, ["Node","Swift"].contains(runtime),
                      localDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw Failure.invalid }
                return RecoveryConflict(profile: profile, runtime: runtime, localDigest: localDigest, store: head.store, revision: head.revision,
                    headDigest: Self.digest(head.payload), local: try .init(snapshot), recovered: try .init(head.payload), pending: row["pending"] == "1")
            }
        }
    }
    func resolve(_ expected: RecoveryConflict, choice: String) throws {
        guard ["local","recovery"].contains(choice) else { throw Failure.invalid }
        try database { db in
            try execute(db, "BEGIN IMMEDIATE"); defer { try? execute(db, "ROLLBACK") }
            guard let current = try head(db), current.store == expected.store, current.revision == expected.revision,
                  Self.digest(current.payload) == expected.headDigest,
                  let row = try query(db, "SELECT local_digest,snapshot FROM recovery_conflicts WHERE profile=?", [expected.profile]).first,
                  row["local_digest"] == expected.localDigest, let snapshot = row["snapshot"], current.revision < DaemonParityRules.recoveryMaxRevision else { throw Failure.conflict }
            let local = try Self.payload(snapshot), prior = try Self.payload(current.payload), next = current.revision + 1
            _ = try query(db, "UPDATE recovery_resolutions SET applied=1 WHERE profile=? AND applied=0", [expected.profile])
            _ = try query(db, "INSERT INTO recovery_resolutions(id,store_id,profile,local_digest,revision,choice,local_payload,prior_payload) VALUES(?,?,?,?,?,?,?,?)",
                [UUID().uuidString.lowercased(), current.store, expected.profile, expected.localDigest, String(next), choice, local, prior])
            _ = try query(db, "UPDATE recovery_head SET revision=?,payload=? WHERE singleton=1", [String(next), choice == "local" ? local : prior])
            try execute(db, "COMMIT")
        }
    }
    func approved(profile: String, fingerprint: String) throws -> (id: String, revision: Int64)? {
        try database { db in
            guard let row = try query(db, "SELECT r.id,r.revision FROM recovery_resolutions r JOIN recovery_head h ON h.singleton=1 AND r.store_id=h.store_id WHERE r.profile=? AND r.local_digest=? AND r.applied=0 AND r.revision<=h.revision ORDER BY r.revision DESC LIMIT 1", [profile,fingerprint]).first,
                  let id = row["id"], let revision = row["revision"].flatMap(Int64.init) else { return nil }
            guard UUID(uuidString: id) != nil else { throw Failure.invalid }
            return (id, revision)
        }
    }
    func acknowledge(id: String, profile: String, fingerprint: String) throws {
        try database { db in
            try execute(db, "BEGIN IMMEDIATE"); defer { try? execute(db, "ROLLBACK") }
            _ = try query(db, "UPDATE recovery_resolutions SET applied=1 WHERE id=?", [id])
            _ = try query(db, "DELETE FROM recovery_conflicts WHERE profile=? AND local_digest=?", [profile,fingerprint])
            try execute(db, "COMMIT")
        }
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
    private var approval: (id: String, fingerprint: String)?
    private var profile: String { DaemonRecoveryStore.digest("swift\n" + directory.path) }
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
    private static func selection(_ configuration: DaemonConfiguration?) -> DaemonConfiguration? {
        guard var value = configuration else { return nil }
        for index in value.pins.indices { value.pins[index].lastSeenAt = 0 }
        return value
    }
    private struct UserState: Encodable {
        var pocket: PocketAutonomy.State
        var receipts: [DaemonReceipt]
        var configuration: DaemonConfiguration?
    }
    private static func userState(_ text: String) throws -> Data {
        guard let value = DaemonCheckpointStore.parse(text) else { throw DaemonRecoveryStore.Failure.invalid }
        return try DaemonConfigurationRules.data(UserState(pocket: value.pocket, receipts: value.receipts, configuration: selection(value.configuration)))
    }
    static func fingerprint(_ text: String) throws -> String { DaemonRecoveryStore.digest(String(decoding: try userState(text), as: UTF8.self)) }
    func prepare(configuration: DaemonConfiguration? = nil, inspectOnly: Bool = false) throws -> Bool {
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
        }
        let local = try read("daemon-checkpoint.json")
        var candidate = local.flatMap { String(data: $0, encoding: .utf8) }.flatMap(DaemonCheckpointStore.parse)
        if let configuration { candidate?.configuration = configuration }
        let snapshot = try candidate.map { String(decoding: try DaemonCheckpointStore.encoded($0), as: UTF8.self) }
        let fingerprint = try snapshot.map(Self.fingerprint)
        if let head, let fingerprint, let approved = try store.approved(profile: profile, fingerprint: fingerprint), approved.revision <= head.revision {
            if inspectOnly { return false }
            let backup = directory.appendingPathComponent("daemon-recovery-resolution-" + approved.id, isDirectory: true)
            if !FileManager.default.fileExists(atPath: backup.path) {
                try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                for name in DaemonParityRules.recoveryPreservedFiles {
                    let source = directory.appendingPathComponent(name)
                    if FileManager.default.fileExists(atPath: source.path) { try FileManager.default.copyItem(at: source, to: backup.appendingPathComponent(name)) }
                }
            }
            approval = (approved.id, fingerprint)
            try Data(head.payload.utf8).write(to: directory.appendingPathComponent("daemon-checkpoint-peer.json"), options: .atomic)
            return true
        }
        func conflict(_ failure: DaemonRecoveryStore.Failure) throws -> Never {
            if let snapshot, head != nil { try store.report(profile: profile, snapshot: snapshot) }
            throw failure
        }
        if let cursor {
            guard UUID(uuidString: cursor.store) != nil, cursor.revision > 0, cursor.digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw DaemonRecoveryStore.Failure.invalid }
            guard let head, cursor.store == head.store, cursor.revision <= head.revision else { try conflict(.changedStore) }
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
        if cursor?.revision == head.revision { if !inspectOnly { try retirePeer() }; return false }
        if cursor != nil, let local = try read("daemon-checkpoint.json"), let configuration,
           let text = String(data: local, encoding: .utf8), Self.selection(configuration) != Self.selection(DaemonCheckpointStore.parse(text)?.configuration) {
            try conflict(.offlineConflict)
        }
        if let cursor, let local = try read("daemon-checkpoint.json"), digest(local) != cursor.digest {
            guard let text = String(data: local, encoding: .utf8), try Self.userState(text) == Self.userState(head.payload) else { try conflict(.offlineConflict) }
        }
        if inspectOnly { return false }
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
        if let approval {
            try store.acknowledge(id: approval.id, profile: profile, fingerprint: approval.fingerprint)
            self.approval = nil
        }
    }
}
#endif

#if os(macOS)
@DaemonActor
enum RecoveryConflictAccess {
    static func inspect(shared: URL, directory: URL) throws -> [RecoveryConflict] {
        let session = try DaemonRecoverySession(shared: shared, directory: directory)
        let config = DaemonConfigurationStore(directory: directory, order: SessionOrderStore(fileURL: directory.appendingPathComponent("session-order.json")))
        do { _ = try session.prepare(configuration: config.snapshot(useDiskPins: true), inspectOnly: true) }
        catch DaemonRecoveryStore.Failure.offlineConflict { }
        catch DaemonRecoveryStore.Failure.changedStore { }
        return try withExtendedLifetime(session) { try DaemonRecoveryStore(directory: shared).conflicts() }
    }
    static func resolve(shared: URL, directory: URL, conflict: RecoveryConflict, choice: String) throws {
        let session = try DaemonRecoverySession(shared: shared, directory: directory)
        try withExtendedLifetime(session) { try DaemonRecoveryStore(directory: shared).resolve(conflict, choice: choice) }
    }
}
#endif
