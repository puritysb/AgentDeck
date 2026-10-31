#if os(macOS)
import XCTest
import SQLite3
@testable import AgentDeck

private final class AntigravityScopeProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var starts = 0
    private var stops = 0
    private var makes = 0
    private var allowed = true
    private var stale = false
    private var block = false
    let release = DispatchSemaphore(value: 0)
    var counts: (Int, Int, Int) { lock.withLock { (starts, stops, makes) } }
    func configure(allowed: Bool = true, stale: Bool = false, block: Bool = false) { lock.withLock { self.allowed = allowed; self.stale = stale; self.block = block } }
    var access: AntigravityFolderAccess {
        .init(makeBookmark: { url in
            let n = self.lock.withLock { self.makes += 1; return self.makes }
            return Data([UInt8(n)]) + Data(url.path.utf8)
        }, resolve: { data in
            (URL(fileURLWithPath: String(decoding: data.dropFirst(), as: UTF8.self)), self.lock.withLock { self.stale })
        }, start: { _ in
            let value = self.lock.withLock { self.starts += 1; return (self.allowed, self.block) }
            if value.1 { _ = self.release.wait(timeout: .now() + 3) }
            return value.0
        }, stop: { _ in self.lock.withLock { self.stops += 1 } })
    }
}

@MainActor
final class AntigravityObservationTests: XCTestCase {
    private struct Source {
        let root: URL
        let transcript: URL
        let now: Int64
        let defaults: UserDefaults
        let suite: String
        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("antigravity-\(UUID().uuidString)")
            transcript = root.appendingPathComponent("brain/conversation-A/.system_generated/logs/transcript.jsonl")
            try FileManager.default.createDirectory(at: transcript.deletingLastPathComponent(), withIntermediateDirectories: true)
            now = Int64(Date().timeIntervalSince1970 * 1000)
            suite = "AntigravityScope.\(UUID().uuidString)"; defaults = UserDefaults(suiteName: suite)!
            defaults.set(Data([8, 9]), forKey: "prefs.antigravityBookmark") // independent plan DB grant
            defaults.set("keep-plan-db", forKey: "prefs.antigravitySelectedPath")
        }
        func cleanup() { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: root) }
        func write(status: String = "RUNNING", step: Int = 1, promptTime: Int64? = nil, stepTime: Int64? = nil) throws {
            let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            func stamp(_ ms: Int64) -> String { iso.string(from: Date(timeIntervalSince1970: Double(ms) / 1000)) }
            let records: [[String: Any]] = [
                ["step_index": 0, "type": "USER_INPUT", "source": "USER_EXPLICIT", "status": "DONE", "created_at": stamp(promptTime ?? now - 1000), "content": "<USER_REQUEST>Fixture only</USER_REQUEST>"],
                ["step_index": step, "type": "RUN_COMMAND", "source": "MODEL", "status": status, "created_at": stamp(stepTime ?? now)],
            ]
            var data = Data()
            for record in records { data.append(try JSONSerialization.data(withJSONObject: record)); data.append(10) }
            try data.write(to: transcript)
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(stepTime ?? now) / 1000)], ofItemAtPath: transcript.path)
        }
    }

    func testConsentRestoresOnRelaunchKeepsUsageGrantAndRevocationInvalidatesCachedEvidence() async throws {
        XCTAssertEqual(AntigravityObservation(conversationId: "fractional", startedAtMs: 1_793_390_395_782).startedAtISO, "2026-10-30T19:59:55.782Z")
        let source = try Source(); defer { source.cleanup() }; try source.write()
        let probe = AntigravityScopeProbe(), gate = AntigravityAccessGate()
        let settings = AntigravitySessionSettings(defaults: source.defaults, access: probe.access, gate: gate)
        XCTAssertFalse(settings.isEnabled)
        let before = await settings.read(nowMs: source.now); XCTAssertEqual(before.reason, "not_configured"); XCTAssertEqual(probe.counts.0, 0)
        XCTAssertTrue(settings.selectFolder(source.root))
        let first = await settings.read(nowMs: source.now)
        XCTAssertEqual(first.known.count, 1); XCTAssertEqual(first.known.first?.state, "processing")
        XCTAssertTrue(gate.accepts(first.grantRevision))
        let reopened = AntigravitySessionSettings(defaults: source.defaults, access: probe.access, gate: gate)
        XCTAssertTrue(reopened.isEnabled); XCTAssertFalse(gate.accepts(first.grantRevision))
        let restored = await reopened.read(nowMs: source.now)
        XCTAssertEqual(restored.known.first?.currentTurnId, first.known.first?.currentTurnId)
        XCTAssertEqual(restored.known.first?.startedAtMs, first.known.first?.startedAtMs)
        reopened.stopObserving()
        XCTAssertFalse(gate.accepts(restored.grantRevision)); XCTAssertFalse(reopened.isEnabled)
        XCTAssertEqual(source.defaults.data(forKey: "prefs.antigravityBookmark"), Data([8, 9]))
        XCTAssertEqual(source.defaults.string(forKey: "prefs.antigravitySelectedPath"), "keep-plan-db")
        XCTAssertEqual(probe.counts.0, probe.counts.1)
    }
    func testDeniedAndStaleBookmarksAreNotHealthyAndStaleRenewalPersists() async throws {
        let source = try Source(); defer { source.cleanup() }; try source.write()
        let probe = AntigravityScopeProbe()
        let settings = AntigravitySessionSettings(defaults: source.defaults, access: probe.access, gate: .init())
        XCTAssertTrue(settings.selectFolder(source.root))
        let first = source.defaults.data(forKey: AntigravitySessionSettings.bookmarkKey)
        probe.configure(stale: true)
        let fresh = await settings.read(nowMs: source.now)
        XCTAssertEqual(fresh.status, "known")
        XCTAssertNotEqual(source.defaults.data(forKey: AntigravitySessionSettings.bookmarkKey), first)
        probe.configure(allowed: false)
        let denied = await settings.read(nowMs: source.now)
        XCTAssertEqual(denied.status, "unknown"); XCTAssertEqual(denied.reason, "access_denied"); XCTAssertTrue(denied.known.isEmpty)
        XCTAssertNotNil(settings.errorMessage)
    }
    func testRevocationDuringResolutionCannotPublishLateRows() async throws {
        let source = try Source(); defer { source.cleanup() }; try source.write()
        let probe = AntigravityScopeProbe(), gate = AntigravityAccessGate()
        let settings = AntigravitySessionSettings(defaults: source.defaults, access: probe.access, gate: gate)
        XCTAssertTrue(settings.selectFolder(source.root)); probe.configure(block: true)
        let read = Task { await settings.read(nowMs: source.now) }
        for _ in 0..<100 where probe.counts.0 < 2 { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(probe.counts.0, 2)
        settings.stopObserving(); probe.release.signal()
        let late = await read.value
        XCTAssertTrue(late.known.isEmpty); XCTAssertEqual(settings.snapshot.reason, "not_configured")
        XCTAssertFalse(gate.accepts(late.grantRevision)); XCTAssertEqual(probe.counts.0, probe.counts.1)
    }
    func testRotationPartialTailAndExpiryNeverFabricateIdleOrPermissions() throws {
        let source = try Source(); defer { source.cleanup() }; try source.write()
        let first = AntigravitySourceReader.scan(root: source.root, nowMs: source.now)
        let id = try XCTUnwrap(first.known.first?.currentTurnId)
        XCTAssertFalse(first.known[0].isAdmissible(nowMs: source.now + Int64(AntigravityPolicy.activeWindowMs) + 1))
        let expired = AntigravitySourceReader.scan(root: source.root, nowMs: source.now + Int64(AntigravityPolicy.activeWindowMs) + 1)
        XCTAssertEqual(expired.observations.first?.status, "stale"); XCTAssertTrue(expired.known.isEmpty)
        let handle = try FileHandle(forWritingTo: source.transcript); try handle.seekToEnd(); try handle.write(contentsOf: Data("{\"step_index\":".utf8)); try handle.close()
        XCTAssertTrue(AntigravitySourceReader.scan(root: source.root, nowMs: source.now).known.isEmpty)
        try source.write(status: "DONE", promptTime: source.now)
        let rotated = AntigravitySourceReader.scan(root: source.root, nowMs: source.now)
        XCTAssertEqual(rotated.known.first?.state, "idle"); XCTAssertNotEqual(rotated.known.first?.currentTurnId, id)
        XCTAssertEqual(rotated.known.first?.conversationId, first.known.first?.conversationId)
    }
    func testUnsafeFolderAndSymlinkDoNotReplaceTheExistingGrant() async throws {
        let source = try Source(); defer { source.cleanup() }; try source.write()
        let probe = AntigravityScopeProbe(), gate = AntigravityAccessGate()
        let settings = AntigravitySessionSettings(defaults: source.defaults, access: probe.access, gate: gate)
        XCTAssertTrue(settings.selectFolder(source.root)); let bookmark = source.defaults.data(forKey: AntigravitySessionSettings.bookmarkKey)
        XCTAssertFalse(settings.selectFolder(source.transcript.deletingLastPathComponent()))
        XCTAssertEqual(source.defaults.data(forKey: AntigravitySessionSettings.bookmarkKey), bookmark)
        let outside = source.root.appendingPathComponent("private.jsonl"); try Data("not a transcript".utf8).write(to: outside)
        try FileManager.default.removeItem(at: source.transcript)
        try FileManager.default.createSymbolicLink(at: source.transcript, withDestinationURL: outside)
        let scan = await settings.read(nowMs: source.now)
        XCTAssertEqual(scan.observations.first?.status, "unknown"); XCTAssertTrue(scan.known.isEmpty)
    }
    private func metadata(_ ms: Int64) -> Data {
        func varint(_ value: UInt64) -> [UInt8] {
            var n = value, out: [UInt8] = []
            repeat { let byte = UInt8(n & 127); n >>= 7; out.append(byte | (n > 0 ? 128 : 0)) } while n > 0
            return out
        }
        let timestamp = [UInt8(8)] + varint(UInt64(ms / 1000)) + [16] + varint(UInt64(ms % 1000) * 1_000_000 + 123_000)
        return Data([10, UInt8(timestamp.count)] + timestamp)
    }
    private func sql(_ db: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw NSError(domain: "AntigravityFixture", code: Int(sqlite3_errcode(db)))
        }
    }
    private func database(_ source: Source) throws -> OpaquePointer {
        let folder = source.root.appendingPathComponent("conversations")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(folder.appendingPathComponent("conversation-A.db").path, &db), SQLITE_OK)
        let handle = try XCTUnwrap(db)
        try sql(handle, "CREATE TABLE trajectory_meta (cascade_id TEXT); INSERT INTO trajectory_meta VALUES ('conversation-A'); CREATE TABLE steps (idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB)")
        func blob(_ ms: Int64) -> String { metadata(ms).map { String(format: "%02x", $0) }.joined() }
        try sql(handle, "INSERT INTO steps VALUES (0,14,3,X'\(blob(source.now - 1000))'); INSERT INTO steps VALUES (2,15,8,X'\(blob(source.now))')")
        return handle
    }
    func testClosedWalStoreDoesNotCreateSidecarsUnderReadOnlyFolderAccess() throws {
        let source = try Source(); defer { source.cleanup() }; try source.write(status: "DONE")
        let db = try database(source)
        try sql(db, "PRAGMA journal_mode=WAL; UPDATE steps SET status=8 WHERE idx=2; PRAGMA wal_checkpoint(TRUNCATE)")
        XCTAssertEqual(sqlite3_close(db), SQLITE_OK)
        let folder = source.root.appendingPathComponent("conversations")
        let file = folder.appendingPathComponent("conversation-A.db")
        for suffix in ["-wal", "-shm"] where FileManager.default.fileExists(atPath: file.path + suffix) {
            try FileManager.default.removeItem(atPath: file.path + suffix)
        }
        let before = try Data(contentsOf: file)
        XCTAssertEqual(before[18], 2)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: folder.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path) }
        let scan = AntigravitySourceReader.scan(root: source.root, nowMs: source.now)
        XCTAssertEqual(scan.known.first?.state, "processing")
        XCTAssertEqual(try Data(contentsOf: file), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path + "-wal"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path + "-shm"))
    }
    func testDirectDatabaseActivityKeepsTurnIdentityAndSurvivesWalWithoutWritingTheStore() throws {
        let source = try Source(); defer { source.cleanup() }; try source.write(status: "DONE")
        let db = try database(source); defer { sqlite3_close(db) }
        let file = source.root.appendingPathComponent("conversations/conversation-A.db")
        let before = try Data(contentsOf: file)
        let active = AntigravitySourceReader.scan(root: source.root, nowMs: source.now)
        let observed = try XCTUnwrap(active.known.first)
        XCTAssertEqual(observed.state, "processing"); XCTAssertEqual(observed.reason, "database_step_evidence")
        XCTAssertEqual(try Data(contentsOf: file), before)
        let rows = DaemonServer.antigravityRows(active, excluding: [], nowMs: source.now)
        XCTAssertEqual(rows.first?.state, "processing"); XCTAssertEqual(rows.first?.controlMode, "observed")
        XCTAssertTrue(DaemonServer.antigravityRows(active, excluding: ["conversation-A"], nowMs: source.now).isEmpty)
        XCTAssertTrue(DaemonServer.antigravityRows(active, excluding: [], nowMs: source.now + Int64(AntigravityPolicy.activeWindowMs) + 1).isEmpty)
        let blob = metadata(source.now).map { String(format: "%02x", $0) }.joined()
        let window = AntigravityPolicy.activityStepWindow
        try sql(db, "WITH RECURSIVE seq(x) AS (SELECT 3 UNION ALL SELECT x+1 FROM seq WHERE x<\(window)) INSERT INTO steps SELECT x,15,3,X'\(blob)' FROM seq; UPDATE steps SET status=8 WHERE idx=\(window)")
        XCTAssertEqual(AntigravitySourceReader.scan(root: source.root, nowMs: source.now).known.first?.state, "processing")
        try sql(db, "INSERT INTO steps VALUES (\(window + 1),15,8,X'\(blob)')")
        XCTAssertTrue(AntigravitySourceReader.scan(root: source.root, nowMs: source.now).known.isEmpty)
        try sql(db, "DELETE FROM steps WHERE idx>2")
        try sql(db, "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE steps SET status=2 WHERE idx=2")
        XCTAssertEqual(AntigravitySourceReader.scan(root: source.root, nowMs: source.now).known.first?.state, "processing")
        try sql(db, "UPDATE steps SET status=3 WHERE idx=2")
        let done = AntigravitySourceReader.scan(root: source.root, nowMs: source.now)
        XCTAssertEqual(done.known.first?.state, "idle"); XCTAssertEqual(done.known.first?.currentTurnId, observed.currentTurnId)
        XCTAssertEqual(DaemonServer.antigravityRows(done, excluding: [], nowMs: source.now).first?.state, "idle")
    }
    func testActivityUnknownStaleIdentityMismatchAndBusyNeverFallBackToJsonIdle() throws {
        let source = try Source(); defer { source.cleanup() }; try source.write(status: "DONE")
        let db = try database(source); defer { sqlite3_close(db) }
        let stale = AntigravitySourceReader.scan(root: source.root, nowMs: source.now + Int64(AntigravityPolicy.activeWindowMs) + 1)
        XCTAssertEqual(stale.observations.first?.status, "stale"); XCTAssertTrue(stale.known.isEmpty)
        try sql(db, "UPDATE steps SET status=9 WHERE idx=2")
        var unknown = AntigravitySourceReader.scan(root: source.root, nowMs: source.now)
        XCTAssertEqual(unknown.observations.first?.reason, "unknown_activity_status"); XCTAssertTrue(unknown.known.isEmpty)
        try sql(db, "UPDATE steps SET status=8 WHERE idx=2; UPDATE trajectory_meta SET cascade_id='wrong-id'")
        unknown = AntigravitySourceReader.scan(root: source.root, nowMs: source.now)
        XCTAssertEqual(unknown.observations.first?.reason, "activity_identity_mismatch"); XCTAssertTrue(unknown.known.isEmpty)
        try sql(db, "UPDATE trajectory_meta SET cascade_id='conversation-A'; BEGIN EXCLUSIVE")
        let start = Date()
        unknown = AntigravitySourceReader.scan(root: source.root, nowMs: source.now)
        XCTAssertTrue(unknown.known.isEmpty); XCTAssertEqual(unknown.observations.first?.status, "unknown")
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
        try sql(db, "ROLLBACK")
        XCTAssertEqual(AntigravitySourceReader.scan(root: source.root, nowMs: source.now).known.first?.state, "processing")
        XCTAssertThrowsError(try AntigravityActivity.createdAt(Data([10, 100])))
        XCTAssertThrowsError(try AntigravityActivity.createdAt(Data(repeating: 0, count: AntigravityPolicy.activityMetadataBytes + 1)))
    }

    func testFreshExplicitDatabaseStepCanReviveColdJsonButTouchingOldActivityCannot() throws {
        let source = try Source(); defer { source.cleanup() }
        let old = source.now - Int64(AntigravityPolicy.rosterWindowMs) - 60_000
        try source.write(status: "DONE", promptTime: old, stepTime: old + 1000)
        let db = try database(source); defer { sqlite3_close(db) }
        func blob(_ ms: Int64) -> String { metadata(ms).map { String(format: "%02x", $0) }.joined() }
        try sql(db, "UPDATE steps SET metadata=X'\(blob(old))' WHERE idx=0")
        let active = AntigravitySourceReader.scan(root: source.root, nowMs: source.now)
        XCTAssertEqual(active.known.first?.state, "processing"); XCTAssertEqual(active.known.first?.reason, "database_step_evidence")
        try sql(db, "UPDATE steps SET metadata=X'\(blob(old + 1000))' WHERE idx=2")
        let stale = AntigravitySourceReader.scan(root: source.root, nowMs: source.now)
        XCTAssertEqual(stale.observations.first?.status, "stale"); XCTAssertTrue(stale.known.isEmpty)
    }

}
#endif
