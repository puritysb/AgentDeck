#if os(macOS)
import Darwin
import Foundation
import SQLite3

// File-scope callback: never inherit a daemon/main executor in a C callback.
private final class AntigravityReadDeadline {
    let start = DispatchTime.now().uptimeNanoseconds
}
private func antigravityReadExpired(_ context: UnsafeMutableRawPointer?) -> Int32 {
    guard let context else { return 1 }
    let deadline = Unmanaged<AntigravityReadDeadline>.fromOpaque(context).takeUnretainedValue()
    return (DispatchTime.now().uptimeNanoseconds - deadline.start) / 1_000_000 > AntigravityPolicy.activityQueryBudgetMs ? 1 : 0
}

enum AntigravityActivity {
    private enum Failure: Error { case invalid }
    private enum Value {
        case integer(Int64), bytes(Data), text(String), null
        var integer: Int64? { if case .integer(let n) = self { return n }; return nil }
        var bytes: Data? { if case .bytes(let n) = self { return n }; return nil }
        var text: String? { if case .text(let n) = self { return n }; return nil }
    }
    private static func fields(_ data: Data) throws -> [(Int, Value)] {
        let bytes = Array(data); var offset = 0
        func varint() throws -> UInt64 {
            var n: UInt64 = 0
            for i in 0..<10 {
                guard offset < bytes.count else { throw Failure.invalid }
                let b = bytes[offset]; offset += 1
                guard i != 9 || b <= 1 else { throw Failure.invalid }
                n |= UInt64(b & 127) << (i * 7)
                if b < 128 { return n }
            }
            throw Failure.invalid
        }
        var out: [(Int, Value)] = []
        while offset < bytes.count {
            guard out.count < AntigravityPolicy.activityProtoFields else { throw Failure.invalid }
            let tag = try varint(), field = tag >> 3, wire = tag & 7
            guard field > 0, field < 1 << 29 else { throw Failure.invalid }
            if wire == 0 {
                let n = try varint()
                // Unknown large varints are skipped, never converted unsafely.
                out.append((Int(field), n <= UInt64(Int64.max) ? .integer(Int64(n)) : .null))
            } else {
                let size: UInt64
                switch wire { case 2: size = try varint(); case 1: size = 8; case 5: size = 4; default: throw Failure.invalid }
                guard size <= UInt64(bytes.count - offset) else { throw Failure.invalid }
                out.append((Int(field), wire == 2 ? .bytes(Data(bytes[offset..<offset + Int(size)])) : .null))
                offset += Int(size)
            }
        }
        return out
    }
    static func createdAt(_ data: Data) throws -> Int64 {
        guard data.count <= AntigravityPolicy.activityMetadataBytes else { throw Failure.invalid }
        let values = try fields(data).filter { $0.0 == AntigravityPolicy.activityCreatedAtField }
        guard values.count == 1, let raw = values[0].1.bytes else { throw Failure.invalid }
        let timestamp = try fields(raw), sec = timestamp.filter { $0.0 == 1 }, nano = timestamp.filter { $0.0 == 2 }
        guard sec.count == 1, let seconds = sec[0].1.integer, seconds > 0, nano.count <= 1 else { throw Failure.invalid }
        let nanos: Int64
        if nano.isEmpty { nanos = 0 }
        else { guard let value = nano[0].1.integer else { throw Failure.invalid }; nanos = value }
        guard nanos >= 0, nanos < 1_000_000_000, seconds <= 9_007_199_254_740 else { throw Failure.invalid }
        let ms = seconds * 1000 + nanos / 1_000_000
        guard ms <= 9_007_199_254_740_991 else { throw Failure.invalid }
        return ms
    }
    private static func query(_ db: OpaquePointer, _ sql: String, _ parameters: [Int64] = []) throws -> [[String: Value]] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw Failure.invalid }
        defer { sqlite3_finalize(statement) }
        for (index, value) in parameters.enumerated() {
            guard sqlite3_bind_int64(statement, Int32(index + 1), value) == SQLITE_OK else { throw Failure.invalid }
        }
        var rows: [[String: Value]] = []
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { return rows }
            guard status == SQLITE_ROW, rows.count < AntigravityPolicy.activitySchemaColumns + 1 else { throw Failure.invalid }
            var row: [String: Value] = [:]
            for column in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, column))
                switch sqlite3_column_type(statement, column) {
                case SQLITE_INTEGER: row[name] = .integer(sqlite3_column_int64(statement, column))
                case SQLITE_TEXT:
                    guard sqlite3_column_bytes(statement, column) <= AntigravityPolicy.activityMetadataBytes,
                          let text = sqlite3_column_text(statement, column) else { throw Failure.invalid }
                    let data = Data(bytes: text, count: Int(sqlite3_column_bytes(statement, column)))
                    guard let value = String(data: data, encoding: .utf8) else { throw Failure.invalid }
                    row[name] = .text(value)
                case SQLITE_BLOB:
                    let size = Int(sqlite3_column_bytes(statement, column))
                    guard size <= AntigravityPolicy.activityMetadataBytes else { throw Failure.invalid }
                    if let bytes = sqlite3_column_blob(statement, column) { row[name] = .bytes(Data(bytes: bytes, count: size)) }
                    else { row[name] = .bytes(Data()) }
                case SQLITE_NULL: row[name] = .null
                default: throw Failure.invalid
                }
            }
            rows.append(row)
        }
    }
    private static func number(_ value: Value?) throws -> Int64 {
        guard let n = value?.integer, n >= 0, n <= 9_007_199_254_740_991 else { throw Failure.invalid }; return n
    }
    private static func present(_ url: URL) throws -> Bool {
        var info = stat()
        if lstat(url.path, &info) == 0 { return true }
        if errno == ENOENT { return false }
        throw Failure.invalid
    }
    private static func stamp(_ url: URL, wal: Bool = false) throws -> Int64 {
        var info = stat()
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { throw Failure.invalid }
        if wal && info.st_size <= AntigravityPolicy.activityWalHeaderBytes { return 0 }
        return Int64(info.st_mtimespec.tv_sec) * 1000 + Int64(info.st_mtimespec.tv_nsec / 1_000_000)
    }
    private static func fingerprint(_ path: String) throws -> String {
        try ["", "-wal", "-shm", "-journal"].map { suffix in
            var info = stat()
            guard lstat(path + suffix, &info) == 0 else {
                if !suffix.isEmpty && errno == ENOENT { return "-" }
                throw Failure.invalid
            }
            guard (info.st_mode & S_IFMT) == S_IFREG else { throw Failure.invalid }
            return "\(info.st_dev):\(info.st_ino):\(info.st_size):\(info.st_mtimespec.tv_sec):\(info.st_mtimespec.tv_nsec):\(info.st_ctimespec.tv_sec):\(info.st_ctimespec.tv_nsec)"
        }.joined(separator: "|")
    }
    private static func coldWAL(_ path: String, walFrames: Bool, journal: Bool) throws -> Bool {
        if walFrames || journal { return false }
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw Failure.invalid }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size >= 100 else { throw Failure.invalid }
        var header = [UInt8](repeating: 0, count: 100)
        let count = header.withUnsafeMutableBytes { pread(fd, $0.baseAddress, $0.count, 0) }
        guard count == header.count else { throw Failure.invalid }
        let cold = !walFrames && !journal && header[18] == 2 && header[19] == 2
        guard !cold || info.st_size <= AntigravityPolicy.activityColdMaxBytes else { throw Failure.invalid }
        return cold
    }
    static func freshness(root: URL, id: String, nowMs: Int64) -> String {
        var modified: Int64 = 0
        for suffix in ["", "-wal"] {
            let path = root.appendingPathComponent("conversations").appendingPathComponent(id + ".db" + suffix)
            do { if try present(path) { modified = max(modified, try stamp(path, wal: suffix == "-wal")) } }
            catch { return "unknown" }
        }
        return modified > 0 && nowMs - modified <= AntigravityPolicy.rosterWindowMs ? "recent" : "historical"
    }
    static func observe(root: URL, base: AntigravityObservation, nowMs: Int64,
                        safePath: ([String], Bool) throws -> URL) -> AntigravityObservation {
        guard base.status != "unknown", base.currentTurnId != nil else { return base }
        func unknown(_ reason: String = "unreadable_activity") -> AntigravityObservation {
            var out = base; out.status = "unknown"; out.reason = reason; out.state = nil; return out
        }
        var db: OpaquePointer?
        let deadline = AntigravityReadDeadline()
        defer {
            withExtendedLifetime(deadline) {
                if let db { sqlite3_progress_handler(db, 0, nil, nil); sqlite3_close(db) }
            }
        }
        do {
            guard try present(root.appendingPathComponent("conversations")) else { return base }
            _ = try safePath(["conversations"], true)
            let name = base.conversationId + ".db"
            guard try present(root.appendingPathComponent("conversations").appendingPathComponent(name)) else { return base }
            let file = try safePath(["conversations", name], false)
            var modified = try stamp(file)
            var walFrames = false, journal = false, shm = false
            for suffix in ["-wal", "-shm", "-journal"] where try present(URL(fileURLWithPath: file.path + suffix)) {
                let companion = try safePath(["conversations", name + suffix], false)
                let time = try stamp(companion, wal: suffix == "-wal")
                if suffix == "-wal" {
                    var info = stat()
                    guard lstat(companion.path, &info) == 0 else { throw Failure.invalid }
                    walFrames = info.st_size > AntigravityPolicy.activityWalHeaderBytes
                }
                if suffix == "-journal" { journal = true }
                if suffix == "-shm" { shm = true }
                if suffix == "-wal" { modified = max(modified, time) }
            }
            guard !walFrames || shm else { return unknown() }
            // Resolve aliases above the selected root (e.g. macOS /var), while
            // NOFOLLOW still refuses symlinks in the source's own components.
            guard let canonicalRoot = realpath(root.path, nil) else { throw Failure.invalid }
            defer { free(canonicalRoot) }
            let sqlitePath = String(cString: canonicalRoot) + "/conversations/" + name
            let before = try fingerprint(sqlitePath)
            let cold = try coldWAL(sqlitePath, walFrames: walFrames, journal: journal)
            var openPath = sqlitePath
            if cold {
                // Immutable is safe only for a bounded, unchanged main file with
                // no committed WAL frames or rollback journal. It never creates
                // sidecars under the read-only security-scoped folder grant.
                var uri = URLComponents()
                uri.scheme = "file"; uri.path = sqlitePath
                uri.queryItems = [URLQueryItem(name: "mode", value: "ro"), URLQueryItem(name: "immutable", value: "1")]
                guard let value = uri.string else { throw Failure.invalid }
                openPath = value
            }
            guard sqlite3_open_v2(openPath, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX | SQLITE_OPEN_NOFOLLOW | SQLITE_OPEN_URI, nil) == SQLITE_OK,
                  let db else { throw Failure.invalid }
            sqlite3_busy_timeout(db, Int32(AntigravityPolicy.activityBusyMs))
            sqlite3_progress_handler(db, Int32(AntigravityPolicy.activityProgressOps), antigravityReadExpired, Unmanaged.passUnretained(deadline).toOpaque())
            guard sqlite3_exec(db, "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN", nil, nil, nil) == SQLITE_OK else { throw Failure.invalid }
            let tables = try query(db, AntigravityPolicy.activityTablesSQL)
            guard tables.count == 2, tables.allSatisfy({ $0["type"]?.text == "table" }) else { return unknown("unsupported_activity_schema") }
            let columns = try query(db, AntigravityPolicy.activityColumnsSQL, [Int64(AntigravityPolicy.activitySchemaColumns + 1)])
            guard columns.count <= AntigravityPolicy.activitySchemaColumns, ["idx", "step_type", "status", "metadata"].allSatisfy({ name in columns.contains { $0["name"]?.text == name } }),
                  ["idx", "step_type", "status"].allSatisfy({ name in columns.contains { $0["name"]?.text == name && $0["type"]?.text?.lowercased() == "integer" } }),
                  columns.contains(where: { $0["name"]?.text == "metadata" && $0["type"]?.text?.lowercased() == "blob" }),
                  columns.contains(where: { $0["name"]?.text == "idx" && $0["pk"]?.integer == 1 }) else { return unknown("unsupported_activity_schema") }
            let identity = try query(db, AntigravityPolicy.activityTrajectorySQL)
            guard identity.count == 1, identity[0]["cascade_id"]?.text == base.conversationId else { return unknown("activity_identity_mismatch") }
            guard let latest = try query(db, AntigravityPolicy.activityLatestSQL, [Int64(AntigravityPolicy.activityMetadataBytes)]).first else { return unknown("missing_activity_step") }
            let step = try number(latest["idx"]), status = try number(latest["status"])
            _ = try number(latest["step_type"])
            let user = try query(db, AntigravityPolicy.activityUserSQL, [Int64(AntigravityPolicy.activityMetadataBytes), max(0, step - Int64(AntigravityPolicy.activityStepWindow)), step, Int64(AntigravityPolicy.activityUserStepType)]).first
            guard let user, let turn = base.turns.last, let jsonStep = base.latestStepIndex,
                  step >= jsonStep, try number(user["idx"]) == turn.stepIndex else { return unknown("activity_identity_mismatch") }
            guard let userMetadata = user["metadata"]?.bytes, let latestMetadata = latest["metadata"]?.bytes else { throw Failure.invalid }
            let userTime = try createdAt(userMetadata)
            let precision = turn.startedAtMs % Int64(AntigravityPolicy.activityTimestampPrecisionMs) == 0 ? Int64(AntigravityPolicy.activityTimestampPrecisionMs) : 1
            guard userTime / precision == turn.startedAtMs / precision else { return unknown("activity_identity_mismatch") }
            let updated = try createdAt(latestMetadata)
            guard updated >= userTime, updated <= nowMs + Int64(AntigravityPolicy.futureSkewMs), modified <= nowMs + Int64(AntigravityPolicy.futureSkewMs) else { return unknown("invalid_activity_time") }
            let working = AntigravityPolicy.activityWorkingStatuses.contains(Int(status))
            guard working || AntigravityPolicy.activityIdleStatuses.contains(Int(status)) else { return unknown("unknown_activity_status") }
            if cold {
                guard try fingerprint(sqlitePath) == before else { return unknown("activity_changed_during_read") }
            }
            var out = base; out.status = "known"; out.reason = "database_step_evidence"; out.state = working ? "processing" : "idle"
            out.updatedAtMs = updated; out.modifiedAtMs = modified; out.latestStepIndex = Int(step)
            let ttl = working ? AntigravityPolicy.activeWindowMs : AntigravityPolicy.rosterWindowMs
            if nowMs - min(updated, modified) > ttl { out.status = "stale"; out.reason = working ? "unconfirmed_work" : "history"; out.state = nil }
            return out
        } catch { return unknown() }
    }
}
#endif
