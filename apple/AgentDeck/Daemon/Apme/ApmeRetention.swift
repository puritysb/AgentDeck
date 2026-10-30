#if os(macOS)
import Foundation
import SQLite3
import CryptoKit

struct ApmePruneEstimate: Codable, Sendable, Equatable {
    var rows: Int64 = 0
    var bytesBefore: Int64 = 0
    var bytesAfter: Int64?
    enum CodingKeys: String, CodingKey { case rows, bytesBefore, bytesAfter }
    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(rows, forKey: .rows)
        try container.encode(bytesBefore, forKey: .bytesBefore)
        try container.encode(bytesAfter, forKey: .bytesAfter) // explicit null, like Node
    }
}

struct ApmePrunePreview: Codable, Sendable {
    let cutoffMs: Int64
    let fingerprint: String
    let steps: ApmePruneEstimate
    let sampleEvents: ApmePruneEstimate
}

struct ApmeStorageStatus: Codable, Sendable {
    let databaseBytes: Int64?
    let walBytes: Int64?
    let sharedMemoryBytes: Int64?
    let pageBytes: Int64
    let reusableBytes: Int64
    let freeDiskBytes: Int64?
    let vacuumRequiredBytes: Int64?
    var vacuumAllowed: Bool { Self.allowsVacuum(file: databaseBytes, free: freeDiskBytes) }

    static func allowsVacuum(file: Int64?, free: Int64?) -> Bool {
        guard let file, let free, file >= 0, free >= 0 else { return false }
        return Double(free) >= ceil(Double(file) * ApmeRetentionPolicy.vacuumSpaceMultiplier)
    }
}

enum ApmeStorageError: Error, LocalizedError {
    case unavailable, sqlite(Int32), stalePreview, timedOut, insufficientSpace
    var errorDescription: String? {
        switch self {
        case .unavailable: "Storage is unavailable."
        case .sqlite: "Storage is busy or could not be read. Try again."
        case .stalePreview: "The cleanup candidates changed. Preview again before applying."
        case .timedOut: "Storage maintenance reached its time limit. Refresh status before retrying."
        case .insufficientSpace: "Compaction needs more free disk space, or space could not be checked."
        }
    }
}

private final class ApmeMaintenanceDeadline {
    private(set) var expires: DispatchTime
    init(seconds: Double) { expires = .now() + seconds }
    func beginWrites() {
        // Stay below the collector connection's 5-second busy timeout. Long
        // cleanup rolls back rather than silently dropping an incoming write.
        expires = min(expires, .now() + 2)
    }
    func check() throws {
        if DispatchTime.now() >= expires { throw ApmeStorageError.timedOut }
    }
}

// File-scope C callback: must not inherit an actor executor.
private func apmeMaintenanceProgress(_ context: UnsafeMutableRawPointer?) -> Int32 {
    guard let context else { return 1 }
    return DispatchTime.now() >= Unmanaged<ApmeMaintenanceDeadline>.fromOpaque(context).takeUnretainedValue().expires ? 1 : 0
}

/// Stateless worker on a dedicated existing-store connection. Transactions never
/// include collector writes; WAL readers stay independent. Runs off actor.
struct ApmeRetention {
    let db: OpaquePointer
    let path: String
    let budgetSeconds: Double
    init(db: OpaquePointer, path: String, budgetSeconds: Double = 30) {
        self.db = db; self.path = path; self.budgetSeconds = budgetSeconds
    }

    private func execute(_ sql: String) throws {
        let result = sqlite3_exec(db, sql, nil, nil, nil)
        guard result == SQLITE_OK else { throw failure(result) }
    }

    private func failure(_ code: Int32) -> ApmeStorageError {
        code == SQLITE_INTERRUPT ? .timedOut : .sqlite(code)
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        let result = sqlite3_prepare_v2(db, sql, -1, &statement, nil)
        guard result == SQLITE_OK, let statement else { throw failure(result) }
        return statement
    }

    private func scalar(_ sql: String) throws -> Int64 {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        let result = sqlite3_step(statement)
        guard result == SQLITE_ROW else { throw failure(result) }
        return sqlite3_column_int64(statement, 0)
    }

    private func bounded<T>(_ body: (ApmeMaintenanceDeadline) throws -> T) throws -> T {
        let deadline = ApmeMaintenanceDeadline(seconds: budgetSeconds)
        sqlite3_progress_handler(db, 1000, apmeMaintenanceProgress, Unmanaged.passUnretained(deadline).toOpaque())
        defer { sqlite3_progress_handler(db, 0, nil, nil); withExtendedLifetime(deadline) {} }
        try deadline.check()
        return try body(deadline)
    }

    private func fileSize(_ suffix: String) -> Int64? {
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: path + suffix)
            return (attributes[.size] as? NSNumber)?.int64Value
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile && !suffix.isEmpty {
            return 0
        } catch { return nil }
    }

    func status() throws -> ApmeStorageStatus {
        let size = try scalar("PRAGMA page_size")
        let count = try scalar("PRAGMA page_count")
        let free = try scalar("PRAGMA freelist_count")
        let disk = (try? FileManager.default.attributesOfFileSystem(forPath: path)[.systemFreeSize] as? NSNumber)?.int64Value
        let file = fileSize("")
        return ApmeStorageStatus(databaseBytes: file, walBytes: fileSize("-wal"), sharedMemoryBytes: fileSize("-shm"),
                                 pageBytes: size * count, reusableBytes: size * free, freeDiskBytes: disk,
                                 vacuumRequiredBytes: file.map { Int64(ceil(Double($0) * ApmeRetentionPolicy.vacuumSpaceMultiplier)) })
    }

    private func candidates(_ table: String) -> String {
        (table == "sample_events" ? ApmeRetentionPolicy.samplePredicate : "") + ApmeRetentionPolicy.predicate
    }

    private func bindCandidates(_ statement: OpaquePointer, cutoffMs: Int64) {
        sqlite3_bind_int64(statement, 1, cutoffMs)
        _ = ApmeRetentionPolicy.prunedPayloadLike.withCString {
            sqlite3_bind_text(statement, 2, $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        }
    }

    func preview(cutoffMs: Int64) throws -> ApmePrunePreview {
        try bounded { deadline in
            try execute("BEGIN DEFERRED")
            do {
                let value = try scan(cutoffMs: cutoffMs, deadline: deadline)
                try deadline.check()
                try execute("COMMIT")
                return value
            } catch {
                // Clear the interrupted statement before rollback, which must always run.
                sqlite3_progress_handler(db, 0, nil, nil)
                try? execute("ROLLBACK")
                throw error
            }
        }
    }

    private func scan(cutoffMs: Int64, deadline: ApmeMaintenanceDeadline) throws -> ApmePrunePreview {
        var hash = SHA256()
        hash.update(data: Data("\(path)|\(cutoffMs)|".utf8))
        var estimates: [ApmePruneEstimate] = []
        for table in ["steps", "sample_events"] {
            hash.update(data: Data(table.utf8))
            let statement = try prepare("SELECT id, payload, LENGTH(payload) FROM \(table) WHERE \(candidates(table)) ORDER BY id")
            defer { sqlite3_finalize(statement) }
            bindCandidates(statement, cutoffMs: cutoffMs)
            var estimate = ApmePruneEstimate()
            var result = sqlite3_step(statement)
            while result == SQLITE_ROW {
                try deadline.check()
                let size = Int(sqlite3_column_bytes(statement, 1))
                let payload = sqlite3_column_blob(statement, 1)
                hash.update(data: Data("|\(sqlite3_column_int64(statement, 0)):\(size):".utf8))
                if let payload { hash.update(data: Data(bytes: payload, count: size)) }
                estimate.rows += 1
                // Node preview uses SQLite LENGTH (code points, stopping at NUL).
                estimate.bytesBefore += sqlite3_column_int64(statement, 2)
                result = sqlite3_step(statement)
            }
            guard result == SQLITE_DONE else { throw failure(result) }
            estimates.append(estimate)
        }
        return ApmePrunePreview(cutoffMs: cutoffMs, fingerprint: hash.finalize().map { String(format: "%02x", $0) }.joined(),
                                steps: estimates[0], sampleEvents: estimates[1])
    }

    func apply(cutoffMs: Int64, expectedFingerprint: String, prunedAt: Int64) throws -> ApmePrunePreview {
        try bounded { deadline in
            try execute("BEGIN DEFERRED")
            do {
                let preview = try scan(cutoffMs: cutoffMs, deadline: deadline)
                guard preview.fingerprint == expectedFingerprint else { throw ApmeStorageError.stalePreview }
                // Hash without a write lock. SQLite refuses a WAL snapshot
                // upgrade if another writer committed during the scan.
                deadline.beginWrites()
                let steps = try prune("steps", cutoffMs: cutoffMs, prunedAt: prunedAt, deadline: deadline)
                let events = try prune("sample_events", cutoffMs: cutoffMs, prunedAt: prunedAt, deadline: deadline)
                try deadline.check()
                try execute("COMMIT")
                return ApmePrunePreview(cutoffMs: cutoffMs, fingerprint: preview.fingerprint, steps: steps, sampleEvents: events)
            } catch {
                sqlite3_progress_handler(db, 0, nil, nil)
                try? execute("ROLLBACK")
                throw error
            }
        }
    }

    private func prune(_ table: String, cutoffMs: Int64, prunedAt: Int64, deadline: ApmeMaintenanceDeadline) throws -> ApmePruneEstimate {
        var estimate = ApmePruneEstimate(bytesAfter: 0)
        let update = try prepare("UPDATE \(table) SET payload = ? WHERE id = ?")
        defer { sqlite3_finalize(update) }
        while true {
            try deadline.check()
            let select = try prepare("SELECT id, payload FROM \(table) WHERE \(candidates(table)) LIMIT \(ApmeRetentionPolicy.batchSize)")
            bindCandidates(select, cutoffMs: cutoffMs)
            var batch: [(Int64, Int)] = []
            var result = sqlite3_step(select)
            while result == SQLITE_ROW {
                // Finalize before throwing; SQLite must release the read cursor.
                if (try? deadline.check()) == nil { sqlite3_finalize(select); throw ApmeStorageError.timedOut }
                let count = Int(sqlite3_column_bytes(select, 1))
                let raw = sqlite3_column_blob(select, 1)
                let data = raw.map { Data(bytes: $0, count: count) } ?? Data()
                // Node apply/marker uses JS string.length, i.e. UTF-16 units.
                batch.append((sqlite3_column_int64(select, 0), String(decoding: data, as: UTF8.self).utf16.count))
                result = sqlite3_step(select)
            }
            sqlite3_finalize(select)
            guard result == SQLITE_DONE else { throw failure(result) }
            if batch.isEmpty { return estimate }
            for (id, length) in batch {
                try deadline.check()
                let marker = "{\"pruned\":true,\"prunedAt\":\(prunedAt),\"bytes\":\(length)}"
                sqlite3_reset(update)
                sqlite3_clear_bindings(update)
                _ = marker.withCString { sqlite3_bind_text(update, 1, $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
                sqlite3_bind_int64(update, 2, id)
                let result = sqlite3_step(update)
                guard result == SQLITE_DONE else { throw failure(result) }
                estimate.rows += 1
                estimate.bytesBefore += Int64(length)
                estimate.bytesAfter! += Int64(marker.utf16.count)
            }
        }
    }

    func vacuum() throws -> ApmeStorageStatus {
        guard try status().vacuumAllowed else { throw ApmeStorageError.insufficientSpace }
        return try bounded { deadline in
            deadline.beginWrites()
            try deadline.check()
            try execute("VACUUM")
            // Report the actual file sizes. A busy reader can retain WAL bytes;
            // never claim that the checkpoint or file shrink necessarily happened.
            try execute("PRAGMA wal_checkpoint(TRUNCATE)")
            return try status()
        }
    }
}
#endif
