#if os(macOS)
import XCTest
import SQLite3
@testable import AgentDeck

@DaemonActor
final class ApmeRetentionTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Row: Decodable { let table: String; let label: String; let ts: Int64; let kind: String; let payload: String? }
        let cutoffMs: Int64; let prunedAt: Int64; let rows: [Row]
    }
    private final class Database {
        let directory: URL
        let store: ApmeStore
        var db: OpaquePointer!
        init() throws {
            directory = FileManager.default.temporaryDirectory.appendingPathComponent("retention-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            store = ApmeStore(databaseURL: directory.appendingPathComponent("apme.sqlite"))
            guard store.open(), sqlite3_open_v2(store.dbPath, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
                throw ApmeStorageError.unavailable
            }
            try exec("INSERT INTO runs(id,session_id,agent_type,started_at) VALUES ('r','s','claude-code',1)")
            try exec("INSERT INTO tasks(id,run_id,task_index,boundary_signal,started_at) VALUES ('t','r',0,'open',1)")
            try exec("INSERT INTO turns(id,run_id,task_id,turn_index,prompt,response,started_at) VALUES ('u','r','t',0,'keep prompt','keep reply',1)")
            try exec("INSERT INTO evals(run_id,layer,metric,score,created_at) VALUES ('r','task_judge','overall',0.8,1)")
            XCTAssertTrue(store.recordTaskFeedback(taskId: "t", verdict: "incorrect", note: "keep correction"))
            store.noteTaskAttempt("t", status: "failed", reason: "keep provenance")
        }
        deinit { sqlite3_close_v2(db); store.close(); try? FileManager.default.removeItem(at: directory) }
        func exec(_ sql: String) throws {
            guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw ApmeStorageError.sqlite(sqlite3_errcode(db)) }
        }
        func rows(_ table: String) throws -> Data {
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, "SELECT * FROM \(table) ORDER BY rowid", -1, &statement, nil) == SQLITE_OK else { throw ApmeStorageError.unavailable }
            defer { sqlite3_finalize(statement) }
            var rows: [[String: Any]] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                var row: [String: Any] = [:]
                for col in 0..<sqlite3_column_count(statement) {
                    let key = String(cString: sqlite3_column_name(statement, col))
                    switch sqlite3_column_type(statement, col) {
                    case SQLITE_INTEGER: row[key] = sqlite3_column_int64(statement, col)
                    case SQLITE_FLOAT: row[key] = sqlite3_column_double(statement, col)
                    case SQLITE_NULL: row[key] = NSNull()
                    default:
                        let count = Int(sqlite3_column_bytes(statement, col))
                        let data = sqlite3_column_blob(statement, col).map { Data(bytes: $0, count: count) } ?? Data()
                        row[key] = String(decoding: data, as: UTF8.self)
                    }
                }
                rows.append(row)
            }
            return try JSONSerialization.data(withJSONObject: rows, options: .sortedKeys)
        }
        func seed(_ fixture: Fixture) throws {
            for (seq, row) in fixture.rows.enumerated() {
                let sql = row.table == "steps"
                    ? "INSERT INTO steps(run_id,ts,kind,payload) VALUES ('r',?,?,?)"
                    : "INSERT INTO sample_events(task_id,run_id,turn_index,seq,ts,kind,payload,dedup_key) VALUES ('t','r',0,\(seq),?,?,?,'\(row.label)')"
                var stmt: OpaquePointer?
                XCTAssertEqual(sqlite3_prepare_v2(db, sql, -1, &stmt, nil), SQLITE_OK)
                defer { sqlite3_finalize(stmt) }
                sqlite3_bind_int64(stmt, 1, row.ts)
                _ = row.kind.withCString { sqlite3_bind_text(stmt, 2, $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
                if let payload = row.payload {
                    _ = payload.withCString { sqlite3_bind_text(stmt, 3, $0, Int32(payload.utf8.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
                } else { sqlite3_bind_null(stmt, 3) }
                XCTAssertEqual(sqlite3_step(stmt), SQLITE_DONE)
            }
        }
    }

    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/apme-retention-vectors.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testPreviewIsReadOnlyApplyPreservesHistoryAndReopenIsIdempotent() async throws {
        let db = try Database(); let vector = try fixture(); try db.seed(vector)
        let protected = ["runs", "tasks", "turns", "evals", "task_feedback", "task_judge_attempts"]
        let snapshots = try protected.map { try db.rows($0) }
        let beforeSteps = try db.rows("steps"); let beforeEvents = try db.rows("sample_events")
        let before = try db.store.storageStatus()
        XCTAssertNotNil(before.databaseBytes); XCTAssertNotNil(before.walBytes)
        let preview = try db.store.previewPrune(cutoffMs: vector.cutoffMs)
        XCTAssertNil(preview.steps.bytesAfter)
        XCTAssertEqual(try db.rows("steps"), beforeSteps)
        XCTAssertEqual(try db.rows("sample_events"), beforeEvents)
        let applied = try db.store.applyPrune(cutoffMs: vector.cutoffMs, expectedFingerprint: preview.fingerprint, prunedAt: vector.prunedAt)
        XCTAssertEqual(applied.steps.rows, 4); XCTAssertEqual(applied.sampleEvents.rows, 4)
        for (table, original) in zip(protected, snapshots) { XCTAssertEqual(try db.rows(table), original, table) }
        let events = try XCTUnwrap(JSONSerialization.jsonObject(with: db.rows("sample_events")) as? [[String: Any]])
        XCTAssertEqual(events.count, vector.rows.filter { $0.table == "sample_events" }.count)
        for event in events where event["kind"] as? String != "tool" {
            XCTAssertEqual(event["payload"] as? String, "Keep " + (event["kind"] as! String))
        }
        db.store.close(); XCTAssertTrue(db.store.open())
        let empty = try db.store.previewPrune(cutoffMs: vector.cutoffMs)
        XCTAssertEqual(empty.steps.rows + empty.sampleEvents.rows, 0)
        let again = try db.store.applyPrune(cutoffMs: vector.cutoffMs, expectedFingerprint: empty.fingerprint, prunedAt: vector.prunedAt)
        XCTAssertEqual(again.steps, ApmePruneEstimate(bytesAfter: 0))
        XCTAssertThrowsError(try db.store.applyPrune(cutoffMs: vector.cutoffMs, expectedFingerprint: preview.fingerprint, prunedAt: vector.prunedAt))
    }

    func testCandidateChangeRefusesApplyAndSecondTableFailureRollsBackBothTables() async throws {
        let db = try Database(); let vector = try fixture(); try db.seed(vector)
        let preview = try db.store.previewPrune(cutoffMs: vector.cutoffMs)
        try db.exec("UPDATE steps SET payload='changed' WHERE id=1")
        XCTAssertThrowsError(try db.store.applyPrune(cutoffMs: vector.cutoffMs, expectedFingerprint: preview.fingerprint, prunedAt: vector.prunedAt))
        let next = try db.store.previewPrune(cutoffMs: vector.cutoffMs)
        let before = try db.rows("steps")
        try db.exec("CREATE TRIGGER fail_cleanup BEFORE UPDATE OF payload ON sample_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
        XCTAssertThrowsError(try db.store.applyPrune(cutoffMs: vector.cutoffMs, expectedFingerprint: next.fingerprint, prunedAt: vector.prunedAt))
        XCTAssertEqual(try db.rows("steps"), before)
        XCTAssertEqual(try db.store.previewPrune(cutoffMs: vector.cutoffMs).fingerprint, next.fingerprint)
        try db.exec("DROP TRIGGER fail_cleanup")
        _ = try db.store.applyPrune(cutoffMs: vector.cutoffMs, expectedFingerprint: next.fingerprint, prunedAt: vector.prunedAt)
    }

    func testMultipleBatchesBusyWriterAndWALReadSnapshot() async throws {
        let db = try Database()
        try db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2005) INSERT INTO steps(run_id,ts,kind,payload) SELECT 'r',1,'tool','large payload' FROM n")
        let preview = try db.store.previewPrune(cutoffMs: 1000)
        XCTAssertEqual(preview.steps.rows, 2005)
        try db.exec("BEGIN IMMEDIATE")
        XCTAssertThrowsError(try db.store.applyPrune(cutoffMs: 1000, expectedFingerprint: preview.fingerprint, prunedAt: 2000))
        try db.exec("ROLLBACK")
        try db.exec("BEGIN DEFERRED")
        let snapshot = try db.rows("steps")
        let applied = try db.store.applyPrune(cutoffMs: 1000, expectedFingerprint: preview.fingerprint, prunedAt: 2000)
        XCTAssertEqual(applied.steps.rows, 2005)
        XCTAssertEqual(try db.rows("steps"), snapshot, "WAL reader keeps its old snapshot")
        try db.exec("COMMIT")
        XCTAssertNotEqual(try db.rows("steps"), snapshot)
    }

    func testLongWriteRollsBackBeforeCollectorBusyTimeoutAndIncomingRecordSurvives() async throws {
        let db = try Database(); try db.seed(fixture())
        let preview = try db.store.previewPrune(cutoffMs: 1000)
        let before = try db.rows("sample_events")
        try db.exec("CREATE TRIGGER slow_cleanup BEFORE UPDATE OF payload ON steps BEGIN SELECT (WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n); END")
        let store = db.store
        let cleanup = Task.detached { () -> Bool in
            do {
                _ = try store.applyPrune(cutoffMs: 1000, expectedFingerprint: preview.fingerprint, prunedAt: 2000)
                return true
            } catch { return false }
        }
        var observedLock = false
        for _ in 0..<100 {
            if sqlite3_exec(db.db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_BUSY { observedLock = true; break }
            try? db.exec("ROLLBACK")
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(observedLock)
        let path = db.store.dbPath
        let incoming = Task.detached { () -> Int32 in
            var connection: OpaquePointer?
            guard sqlite3_open_v2(path, &connection, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else { return SQLITE_ERROR }
            defer { sqlite3_close_v2(connection) }
            sqlite3_busy_timeout(connection, 5000)
            return sqlite3_exec(connection, "INSERT INTO steps(run_id,ts,kind,payload) VALUES ('r',2000,'tool','incoming record')", nil, nil, nil)
        }
        let completed = await cleanup.value; XCTAssertFalse(completed)
        let written = await incoming.value; XCTAssertEqual(written, SQLITE_OK)
        XCTAssertEqual(try db.rows("sample_events"), before)
        XCTAssertEqual(try db.store.previewPrune(cutoffMs: 1000).fingerprint, preview.fingerprint)
    }

    func testDeadlineRefusesWorkWithoutChangingRows() async throws {
        let db = try Database(); try db.seed(fixture())
        let before = try db.rows("steps")
        let worker = ApmeRetention(db: db.db, path: db.store.dbPath, budgetSeconds: 0)
        XCTAssertThrowsError(try worker.preview(cutoffMs: 1000))
        XCTAssertThrowsError(try worker.apply(cutoffMs: 1000, expectedFingerprint: "unused", prunedAt: 2000))
        XCTAssertEqual(try db.rows("steps"), before)
        XCTAssertNoThrow(try db.store.previewPrune(cutoffMs: 1000))
    }

    func testCompactionSpaceGateAndActualTemporaryFileSizes() async throws {
        XCTAssertFalse(ApmeStorageStatus.allowsVacuum(file: nil, free: 1000))
        XCTAssertFalse(ApmeStorageStatus.allowsVacuum(file: 1000, free: nil))
        XCTAssertFalse(ApmeStorageStatus.allowsVacuum(file: 1000, free: 1099))
        XCTAssertTrue(ApmeStorageStatus.allowsVacuum(file: 1000, free: 1100))
        let db = try Database()
        try db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO steps(run_id,ts,kind,payload) SELECT 'r',1,'tool',hex(zeroblob(8192)) FROM n")
        try db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        let before = try db.store.storageStatus()
        let preview = try db.store.previewPrune(cutoffMs: 1000)
        _ = try db.store.applyPrune(cutoffMs: 1000, expectedFingerprint: preview.fingerprint, prunedAt: 2000)
        let compacted = try db.store.compactStorage()
        XCTAssertLessThan(try XCTUnwrap(compacted.databaseBytes), try XCTUnwrap(before.databaseBytes))
        XCTAssertEqual(compacted.walBytes, 0)
        XCTAssertEqual(try db.store.previewPrune(cutoffMs: 1000).steps.rows, 0)
    }

    func testLocalAuthenticatedRoutesRequirePreviewAndExplicitConfirmation() async throws {
        let db = try Database(); try db.seed(fixture())
        let http = HTTPServer(); await ApmeHttpRoutes.register(on: http, store: db.store)
        func request(_ path: String, method: String = "GET", token: String? = nil, ip: String = "127.0.0.1", body: Data? = nil, days: String? = nil) -> HTTPServer.HTTPRequest {
            var query: [String: String] = ["token": token ?? AuthManager.shared.token]
            if let days { query["days"] = days }
            return HTTPServer.HTTPRequest(method: method, path: path, headers: [:], body: body, queryParams: query, remoteIP: ip)
        }
        let denied = await http.route(request("/apme/storage", token: "")); XCTAssertEqual(denied.status, 401)
        let remote = await http.route(request("/apme/storage", ip: "192.0.2.1")); XCTAssertEqual(remote.status, 403)
        let invalid = await http.route(request("/apme/storage/preview", days: "nan")); XCTAssertEqual(invalid.status, 400)
        let response = await http.route(request("/apme/storage/preview", days: "30")); XCTAssertEqual(response.status, 200)
        let preview = try JSONDecoder().decode(ApmePrunePreview.self, from: XCTUnwrap(response.body))
        func body(_ confirmed: Bool) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["cutoffMs": preview.cutoffMs, "fingerprint": preview.fingerprint, "confirm": confirmed])
        }
        let unconfirmed = await http.route(request("/apme/storage/prune", method: "POST", body: try body(false))); XCTAssertEqual(unconfirmed.status, 400)
        let applied = await http.route(request("/apme/storage/prune", method: "POST", body: try body(true))); XCTAssertEqual(applied.status, 200)
        let repeated = await http.route(request("/apme/storage/prune", method: "POST", body: try body(true))); XCTAssertEqual(repeated.status, 409)
        let compact = await http.route(request("/apme/storage/compact", method: "POST", body: Data(#"{"confirm":1}"#.utf8))); XCTAssertEqual(compact.status, 400)
        db.store.close()
        let unavailable = await http.route(request("/apme/storage")); XCTAssertEqual(unavailable.status, 503)
    }
}
#endif
