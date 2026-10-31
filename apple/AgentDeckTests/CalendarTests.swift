#if os(macOS)
import XCTest
import Security
@testable import AgentDeck

private final class CalendarTestMemory: @unchecked Sendable {
    let lock = NSLock(); var data: Data?; var enabled = false; var loads = 0; var denyRemoval = false
    var storage: CalendarSecretStorage { .init(load: { self.lock.withLock { self.loads += 1; return self.data } }, save: { d in self.lock.withLock { self.data = d } }, remove: {
        try self.lock.withLock { if self.denyRemoval { throw CalendarICS.Failure.invalid }; self.data = nil }
    }, consent: { self.lock.withLock { self.enabled } }, setConsent: { v in self.lock.withLock { self.enabled = v } }) }
}
private actor CalendarReplies {
    var failed = false, count = 0
    var held = false
    var pending: CheckedContinuation<CalendarReply, Never>?
    let body: Data
    init(_ text: String) { body = Data(text.utf8) }
    func fail(_ value: Bool) { failed = value }
    func hold() { held = true }
    func release() { pending?.resume(returning: .init(status: 200, body: body)); pending = nil }
    func request() async throws -> CalendarReply {
        count += 1
        if failed { throw CalendarICS.Failure.invalid }
        if held { return await withCheckedContinuation { pending = $0 } }
        return .init(status: 200, body: body)
    }
}
final class CalendarTests: XCTestCase {
    private let body = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:private-uid\r\nDTSTART:20260804T001000Z\r\nSUMMARY:Private calendar title\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    private let now = 1_785_801_600_000.0
    private let urls = ["https://calendar.invalid/private-token.ics"]
    func testConsentRequiredRestoresWithoutPlaintextAndRemovalFailureStillRevokes() async throws {
        let memory = CalendarTestMemory(), connection = CalendarConnection(storage: memory.storage)
        let empty = try await connection.snapshot(); XCTAssertNil(empty.1); XCTAssertEqual(memory.loads, 0)
        do { try await connection.connect(urls: urls, consent: false); XCTFail("missing consent") } catch {}
        XCTAssertNil(memory.data)
        try await connection.connect(urls: urls, consent: true)
        let saved = try await connection.snapshot(); XCTAssertEqual(saved.1?.urls, urls)
        let summary = try await connection.summary(); XCTAssertFalse(summary.contains("private-token"))
        let restored = CalendarConnection(storage: memory.storage)
        let reopened = try await restored.snapshot(); XCTAssertEqual(reopened.1?.urls, urls)
        XCTAssertTrue(restored.grant.accepts(reopened.0))
        memory.denyRemoval = true
        do { try await connection.disconnect(); XCTFail("expected removal failure") } catch {}
        XCTAssertFalse(connection.grant.accepts(saved.0)); XCTAssertFalse(memory.enabled)
        let disabled = CalendarConnection(storage: memory.storage)
        let result = try await disabled.snapshot(); XCTAssertNil(result.1)
    }
    func testRevocationRejectsAnAlreadyQueuedSaveIntent() async throws {
        let memory = CalendarTestMemory(), connection = CalendarConnection(storage: memory.storage)
        let intent = connection.grant.value
        connection.revoke()
        do { try await connection.connect(urls: urls, consent: true, expectedRevision: intent); XCTFail("stale save intent") } catch {}
        XCTAssertNil(memory.data); XCTAssertFalse(memory.enabled)
        XCTAssertFalse(connection.grant.activate(intent))
        let snapshot = try await connection.snapshot(); XCTAssertNil(snapshot.1)
    }
    func testDeviceOnlyKeychainRecordRestoresAndDeletesWithoutPersistingURLInDefaults() async throws {
        let service = "bound.serendipity.agent.deck.calendar-test." + UUID().uuidString
        let probe: [String: Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service + ".probe",kSecAttrAccount as String:"probe",kSecUseDataProtectionKeychain as String:true,kSecValueData as String:Data([1]),kSecUseAuthenticationUI as String:kSecUseAuthenticationUIFail]
        let availability = SecItemAdd(probe as CFDictionary, nil)
        if availability == errSecMissingEntitlement { throw XCTSkip("Unsigned host cannot use Data Protection Keychain; signed audit verifies it.") }
        XCTAssertEqual(availability, errSecSuccess)
        _ = SecItemDelete(probe.filter { $0.key != kSecValueData as String && $0.key != kSecUseAuthenticationUI as String } as CFDictionary)
        let storage = CalendarSecretStorage.keychain(service: service)
        defer { storage.setConsent(false); try? storage.remove(); UserDefaults.standard.removeObject(forKey: service + ".consent") }
        let first = CalendarConnection(storage: storage)
        try await first.connect(urls: urls, consent: true)
        let second = CalendarConnection(storage: storage)
        let restored = try await second.snapshot(); XCTAssertEqual(restored.1?.urls, urls)
        XCTAssertEqual(UserDefaults.standard.object(forKey: service + ".consent") as? Bool, true)
        XCTAssertFalse(UserDefaults.standard.string(forKey: service + ".consent")?.contains("private-token") ?? false)
        try await second.disconnect(); XCTAssertNil(try storage.load()); XCTAssertFalse(storage.consent())
    }
    @DaemonActor func testSharedParserVectorsAndWireProjection() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("shared/calendar-vectors.json"))) as! [[String: Any]]
        for v in vectors {
            let events = try CalendarICS.build(CalendarICS.parse(v["ics"] as! String), nowMs: (v["nowMs"] as! NSNumber).doubleValue, zone: v["zone"] as! String)
            XCTAssertEqual(events.map(\.wire) as NSArray, v["expected"] as? NSArray, v["name"] as? String ?? "")
            let glance = GlanceSnapshot.build(sessions: [], usage: nil, weather: nil, events: events.map(\.wire))
            if events.isEmpty { XCTAssertNil(glance["events"]) } else { XCTAssertEqual(glance["events"] as? NSArray, events.map(\.wire) as NSArray) }
        }
    }
    @DaemonActor func testCacheRefiltersStaleNeverRestampsAndExpires() async throws {
        let memory = CalendarTestMemory(), connection = CalendarConnection(storage: memory.storage), replies = CalendarReplies(body)
        let provider = CalendarProvider(connection: connection, transport: .init(request: { _ in try await replies.request() }))
        let off = await provider.snapshot(nowMs: now, zone: "UTC"); XCTAssertEqual(off.status, "disabled")
        let zero = await replies.count; XCTAssertEqual(zero, 0)
        try await connection.connect(urls: urls, consent: true)
        let first = await provider.snapshot(nowMs: now, zone: "UTC"); XCTAssertEqual(first.status, "fresh"); XCTAssertEqual(first.events?.first?.startHm, "00:10")
        XCTAssertEqual(provider.freshness(nowMs: now + Double(CalendarPolicy.cacheMs)), "stale")
        let later = await provider.snapshot(nowMs: now + 1_200_000, zone: "UTC"); XCTAssertEqual(later.events, [])
        let count = await replies.count; XCTAssertEqual(count, 1)
        await replies.fail(true)
        let stale = await provider.snapshot(nowMs: now + Double(CalendarPolicy.cacheMs), zone: "UTC")
        XCTAssertEqual(stale.status, "stale"); XCTAssertEqual(stale.fetchedAt, first.fetchedAt)
        let expired = await provider.snapshot(nowMs: now + Double(CalendarPolicy.staleMs), zone: "UTC")
        XCTAssertEqual(expired.status, "unknown"); XCTAssertNil(expired.events)
        provider.stop()
    }
    @DaemonActor func testDisconnectCancelsInFlightAndRejectsLateResponseAndSavedProjection() async throws {
        let memory = CalendarTestMemory(), connection = CalendarConnection(storage: memory.storage), replies = CalendarReplies(body)
        let provider = CalendarProvider(connection: connection, transport: .init(request: { _ in try await replies.request() }))
        try await connection.connect(urls: urls, consent: true)
        let initial = await provider.snapshot(nowMs: now, zone: "UTC"); XCTAssertNotNil(provider.events(initial))
        await replies.hold()
        let task = Task { await provider.snapshot(nowMs: now + Double(CalendarPolicy.cacheMs), zone: "UTC") }
        for _ in 0..<100 { if await replies.pending != nil { break }; try await Task.sleep(for: .milliseconds(5)) }
        try await connection.disconnect()
        XCTAssertNil(provider.events(initial)); XCTAssertFalse(provider.accepts(initial))
        await replies.release()
        let late = await task.value; XCTAssertEqual(late.status, "disabled"); XCTAssertNil(late.events)
        provider.stop()
    }
    @DaemonActor func testRetiredServerCannotClearReplacementCacheOrPublishItsOldProjection() async throws {
        let memory = CalendarTestMemory(), connection = CalendarConnection(storage: memory.storage), replies = CalendarReplies(body)
        let provider = CalendarProvider(connection: connection, transport: .init(request: { _ in try await replies.request() }))
        try await connection.connect(urls: urls, consent: true)
        let oldOwner = UUID(), newOwner = UUID()
        let old = await provider.snapshot(nowMs: now, zone: "UTC", owner: oldOwner)
        let current = await provider.snapshot(nowMs: now, zone: "UTC", owner: newOwner)
        provider.stop(owner: oldOwner)
        XCTAssertNotNil(provider.events(current)); XCTAssertNil(provider.events(old))
        let cached = await provider.snapshot(nowMs: now, zone: "UTC", owner: newOwner)
        XCTAssertEqual(cached.events, current.events)
        let requests = await replies.count; XCTAssertEqual(requests, 2)
        provider.stop(owner: newOwner)
    }
    @DaemonActor func testCalendarDerivedPocketCardsPersistOnlyAggregateFeedback() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let events = try CalendarICS.build(CalendarICS.parse(body), nowMs: now, zone: "UTC")
        let store = PocketAutonomy(stateURL: root.appendingPathComponent("pocket-autonomy.json"), timeZone: TimeZone(identifier: "UTC")!)
        let cards = store.cards(sessions: [], glance: ["events":events.map(\.wire)], now: now)
        XCTAssertTrue(cards.contains { ($0["cardId"] as? String)?.contains(":agenda:") == true })
        store.observeDelivery(cards, now: now)
        store.flush()
        let text = try String(contentsOf: root.appendingPathComponent("pocket-autonomy.json"), encoding: .utf8)
        for secret in ["Private calendar title","private-uid","private-token","calendar.invalid","BEGIN:VEVENT"] { XCTAssertFalse(text.contains(secret)) }
    }
}
#endif
