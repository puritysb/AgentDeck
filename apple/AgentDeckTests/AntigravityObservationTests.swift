#if os(macOS)
import XCTest
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
        func write(status: String = "RUNNING", step: Int = 1, promptTime: Int64? = nil) throws {
            let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            func stamp(_ ms: Int64) -> String { iso.string(from: Date(timeIntervalSince1970: Double(ms) / 1000)) }
            let records: [[String: Any]] = [
                ["step_index": 0, "type": "USER_INPUT", "source": "USER_EXPLICIT", "status": "DONE", "created_at": stamp(promptTime ?? now - 1000), "content": "<USER_REQUEST>Fixture only</USER_REQUEST>"],
                ["step_index": step, "type": "RUN_COMMAND", "source": "MODEL", "status": status, "created_at": stamp(now)],
            ]
            var data = Data()
            for record in records { data.append(try JSONSerialization.data(withJSONObject: record)); data.append(10) }
            try data.write(to: transcript)
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(now) / 1000)], ofItemAtPath: transcript.path)
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
}
#endif
