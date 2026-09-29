// SessionOrderStoreTests.swift — Swift mirror coverage for the
// daemon-persisted observed-session order pins (#273).
//
// The Swift store is a deliberate near-transliteration of
// bridge/src/session-order-store.ts (both daemons read and write one
// session-order.json), so these tests pin the same contracts as
// bridge/src/__tests__/session-order-store.test.ts: bare-id keying across
// both id forms, 0-clears, clamping, persistence round-trip, corrupt-file
// tolerance, TTL GC, pin-cap eviction, noteSeen throttling, the overlay's
// precedence, and the route helpers' validation/resolution — plus the
// cross-daemon JSON shape itself.

#if os(macOS)
import XCTest
@testable import AgentDeck

/// Mutable test clock. `@unchecked Sendable` because every access is confined
/// to the single test method that owns it.
final class OrderTestClock: @unchecked Sendable {
    var ms: Int64
    init(_ ms: Int64) { self.ms = ms }
    var now: @Sendable () -> Int64 { { self.ms } }
}

final class SessionOrderStoreTests: XCTestCase {
    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdeck-order-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    private var storePath: URL { tmpDir.appendingPathComponent("session-order.json") }

    private func makeObserved(
        _ id: String, project: String = "P", weight: Int? = nil, controlMode: String? = "observed"
    ) -> DaemonSessionEntry {
        var entry = DaemonSessionEntry(
            id: id, port: 0, pid: 0, projectName: project,
            agentType: "claude-code", tmuxSession: nil, tty: nil, parentTty: nil,
            startedAt: "2026-09-19T00:00:00Z", weight: weight)
        entry.controlMode = controlMode
        return entry
    }

    // ── Identity ───────────────────────────────────────────────────────

    func testBothIdFormsAddressTheSamePin() {
        let store = SessionOrderStore(fileURL: storePath)
        store.set("observed:claude:abc-123", weight: 3)
        XCTAssertEqual(store.weightFor("observed:claude:abc-123"), 3)
        XCTAssertEqual(store.weightFor("abc-123"), 3)
        XCTAssertTrue(store.clear("abc-123"))
        XCTAssertNil(store.weightFor("observed:claude:abc-123"))
    }

    func testWeightZeroClearsInsteadOfPinning() {
        let store = SessionOrderStore(fileURL: storePath)
        _ = store.set("observed:codex:x", weight: 5)
        XCTAssertNil(store.set("observed:codex:x", weight: 0))
        XCTAssertEqual(store.count, 0)
    }

    func testOutOfRangeWeightsClampToDocumentedRange() {
        let store = SessionOrderStore(fileURL: storePath)
        XCTAssertEqual(store.set("a", weight: Int.max), SessionWeightRules.max)
        XCTAssertEqual(store.set("b", weight: Int.min), SessionWeightRules.min)
    }

    // ── Persistence and lifecycle ──────────────────────────────────────

    func testPersistAndReloadAcrossRestart() throws {
        let clock = OrderTestClock(1_700_000_000_000)
        let store = SessionOrderStore(fileURL: storePath, now: clock.now)
        _ = store.set("observed:claude:first", weight: 2)
        _ = store.set("observed:codex:second", weight: 1)

        // A restart (new instance, wall clock moved on) rehydrates the pins.
        clock.ms += 2 * 86_400_000
        let reloaded = SessionOrderStore(fileURL: storePath, now: clock.now).load()
        XCTAssertEqual(reloaded.weightFor("observed:claude:first"), 2)
        XCTAssertEqual(reloaded.weightFor("observed:codex:second"), 1)
    }

    func testFileShapeMatchesTheNodeStore() throws {
        let clock = OrderTestClock(1_700_000_000_000)
        let store = SessionOrderStore(fileURL: storePath, now: clock.now)
        _ = store.set("smoke-uuid-1", weight: 2)

        let data = try Data(contentsOf: storePath)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["version"] as? Int, 1)
        let pins = try XCTUnwrap(json["pins"] as? [String: [String: Any]])
        let pin = try XCTUnwrap(pins["smoke-uuid-1"])
        XCTAssertEqual(pin["weight"] as? Int, 2)
        XCTAssertNotNil(pin["updatedAt"])
        XCTAssertNotNil(pin["lastSeenAt"])
    }

    func testCorruptFileLoadsEmptyAndStaysUsable() throws {
        try Data("{not json".utf8).write(to: storePath)
        let store = SessionOrderStore(fileURL: storePath).load()
        XCTAssertEqual(store.count, 0)
        XCTAssertEqual(store.set("observed:opencode:z", weight: 7), 7)
    }

    func testTTLGarbageCollectsUnseenPins() {
        let clock = OrderTestClock(1_700_000_000_000)
        let store = SessionOrderStore(fileURL: storePath, now: clock.now)
        _ = store.set("stale", weight: 1)
        _ = store.set("fresh", weight: 2)
        // `fresh` reappears hourly for 31 days; `stale` never does.
        for _ in 0..<(31 * 24) {
            clock.ms += 3_600_000
            store.noteSeen(ids: ["observed:claude:fresh"])
        }
        let reloaded = SessionOrderStore(fileURL: storePath, now: clock.now).load()
        XCTAssertEqual(reloaded.weightFor("fresh"), 2)
        XCTAssertNil(reloaded.weightFor("stale"))
    }

    func testPinCapEvictsLeastRecentlySeenFirst() {
        let clock = OrderTestClock(1_700_000_000_000)
        let store = SessionOrderStore(fileURL: storePath, now: clock.now)
        let cap = SessionWeightRules.maxSessionOrderPins
        for i in 0..<(cap + 3) {
            clock.ms += 10_000
            _ = store.set("pin-\(i)", weight: (i % 500) + 1)
            // pin-1 reappears in every roster tick; every other pin goes
            // quiet at set time.
            store.noteSeen(ids: ["pin-1"])
        }
        XCTAssertEqual(store.count, cap)
        XCTAssertNil(store.weightFor("pin-0"))
        XCTAssertNotNil(store.weightFor("pin-1"))
        XCTAssertNotNil(store.weightFor("pin-\(cap + 2)"))
    }

    func testNoteSeenIsThrottledPerPin() throws {
        let clock = OrderTestClock(1_700_000_000_000)
        let store = SessionOrderStore(fileURL: storePath, now: clock.now)
        _ = store.set("observed:claude:a", weight: 1)
        let before = try Data(contentsOf: storePath)
        clock.ms += 5_000
        store.noteSeen(ids: ["observed:claude:a"])
        let after = try Data(contentsOf: storePath)
        XCTAssertEqual(before, after)
    }

    // ── Overlay precedence ─────────────────────────────────────────────

    func testApplyPinsWeightlessObservedRows() {
        let store = SessionOrderStore(fileURL: storePath)
        _ = store.set("observed:claude:abc", weight: -2)
        let pinned = store.apply(to: makeObserved("observed:claude:abc"))
        XCTAssertEqual(pinned.weight, -2)
    }

    func testApplyNeverOverridesAnExplicitWeight() {
        let store = SessionOrderStore(fileURL: storePath)
        _ = store.set("observed:claude:abc", weight: -2)
        let weighted = store.apply(to: makeObserved("observed:claude:abc", weight: 5))
        XCTAssertEqual(weighted.weight, 5)
    }

    func testApplyLeavesManagedRowsUntouched() {
        let store = SessionOrderStore(fileURL: storePath)
        _ = store.set("abc", weight: -2)
        XCTAssertEqual(store.apply(to: makeObserved("abc", controlMode: "managed")).weight, nil)
        XCTAssertEqual(store.apply(to: makeObserved("abc", controlMode: nil)).weight, nil)
    }

    func testApplyReturnsUnpinnedRowsUnchanged() {
        let store = SessionOrderStore(fileURL: storePath)
        let row = makeObserved("observed:codex:none")
        let out = store.apply(to: row)
        XCTAssertEqual(out.id, row.id)
        XCTAssertNil(out.weight)
        XCTAssertEqual(out.controlMode, "observed")
    }

    // ── Route helpers ──────────────────────────────────────────────────

    func testParseWeightAcceptsDocumentedValuesOnly() {
        XCTAssertEqual(SessionOrderRules.parseWeight(3), 3)
        XCTAssertEqual(SessionOrderRules.parseWeight(-9999), -9999)
        XCTAssertEqual(SessionOrderRules.parseWeight("12"), 12)
        XCTAssertNil(SessionOrderRules.parseWeight(nil))
        XCTAssertNil(SessionOrderRules.parseWeight(1.5))
        XCTAssertNil(SessionOrderRules.parseWeight(10000))
        XCTAssertNil(SessionOrderRules.parseWeight("weight"))
    }

    func testResolveTargetExactPrefixAmbiguousUnknown() {
        let roster = [
            "observed:claude:aaaa1111-0000-0000-0000-000000000000",
            "observed:claude:bbbb2222-0000-0000-0000-000000000000",
            "observed:codex:cccc3333-0000-0000-0000-000000000000",
        ]
        XCTAssertEqual(
            SessionOrderRules.resolveTarget(roster[2], knownIds: roster),
            .resolved(id: roster[2]))
        XCTAssertEqual(
            SessionOrderRules.resolveTarget("observed:codex:cccc3333-0000-0000-0", knownIds: roster),
            .resolved(id: roster[2]))
        if case .ambiguous(let candidates) = SessionOrderRules.resolveTarget("observed:claude:", knownIds: roster) {
            XCTAssertEqual(candidates, [roster[0], roster[1]])
        } else {
            XCTFail("expected ambiguity")
        }
        XCTAssertEqual(
            SessionOrderRules.resolveTarget("observed:claude:zzzz-not-live", knownIds: roster),
            .resolved(id: "zzzz-not-live"))
    }

    func testResolveTargetCrossFormAgainstBareIdRoster() {
        // Swift's observed rows carry the bare uuid. A prefix copied from the
        // Node world (`observed:claude:512d…`) must still resolve — before
        // this it fell through to the truncated uuid and the pin never
        // applied (found live 2026-09-19).
        let roster = [
            "aaaa1111-0000-0000-0000-000000000000",
            "bbbb2222-0000-0000-0000-000000000000",
        ]
        XCTAssertEqual(
            SessionOrderRules.resolveTarget("observed:claude:aaaa1111-0000-0000-0", knownIds: roster),
            .resolved(id: roster[0]))
        XCTAssertEqual(
            SessionOrderRules.resolveTarget("observed:claude:bbbb2222-0000-0000-0000-000000000000", knownIds: roster),
            .resolved(id: roster[1]))
        // Bare-prefix ambiguity across agents is still named.
        if case .ambiguous(let candidates) = SessionOrderRules.resolveTarget(
            "aaaa", knownIds: ["observed:claude:aaaa1", "observed:codex:aaaa2"]) {
            XCTAssertEqual(candidates.count, 2)
        } else {
            XCTFail("expected ambiguity")
        }
    }
}

#endif
