#if os(macOS)
import XCTest
@testable import AgentDeck

private final class PixooTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 1_793_424_000)
    func get() -> Date { lock.withLock { date } }
    func advance(_ seconds: Double) { lock.withLock { date.addTimeInterval(seconds) } }
}
private actor PixooCommands {
    private var rows: [[String: Any]] = []
    var unknownID = false, unknownFrame = false
    var invalidCounter: Double?
    var failureOffset: Int?
    var holdOffset: Int?
    var held: CheckedContinuation<Void, Never>?
    private var picId = 30
    private var badReset = false
    func seedCounter(_ value: Int) { picId = value }
    func rejectReset(_ value: Bool) { badReset = value }
    func configure(fail: Int? = nil, hold: Int? = nil) { failureOffset = fail; holdOffset = hold }
    func invalid(id: Bool = false, frame: Bool = false, counter: Double? = nil) { unknownID = id; unknownFrame = frame; invalidCounter = counter }
    func release() { held?.resume(); held = nil }
    func frames() -> [Data] { rows.filter { $0["Command"] as? String == "Draw/SendHttpGif" }.compactMap { try? JSONSerialization.data(withJSONObject: $0) } }
    func all() -> [Data] { rows.compactMap { try? JSONSerialization.data(withJSONObject: $0) } }
    func receive(_ body: Data) async -> Data? {
        let row = try! JSONSerialization.jsonObject(with: body) as! [String: Any]; rows.append(row)
        if row["Command"] as? String == "Draw/GetHttpGifId" { if unknownID { return Data("{}".utf8) }; if let invalidCounter { return try! JSONSerialization.data(withJSONObject:["error_code":0,"PicId":invalidCounter]) }; return try! JSONSerialization.data(withJSONObject: ["error_code":0,"PicId":picId]) }
        if row["Command"] as? String == "Draw/ResetHttpGifId" { if badReset { return Data("{}".utf8) }; picId = 0 }
        if row["Command"] as? String == "Draw/SendHttpGif" {
            if unknownFrame { return Data("{}".utf8) }
            let offset = row["PicOffset"] as? Int ?? 0
            if offset == holdOffset { await withCheckedContinuation { held = $0 } }
            if offset == failureOffset { return Data("{\"error_code\":1}".utf8) }
            picId = row["PicID"] as? Int ?? picId
        }
        return Data("{\"error_code\":0}".utf8)
    }
}
final class PixooBakedTests: XCTestCase {
    private func prepare(_ commands: PixooCommands, _ clock: PixooTestClock) async -> PixooModule {
        let module = PixooModule(settingsLoader: { [.init(ip: "fixture", brightness: 37, animation: "loop")] }, now: { clock.get() },
                                 commandTransport: { _, data, _ in await commands.receive(data) })
        await module.handleEvent(["type":"state_update","state":"processing","agentType":"claude-code"])
        await module.handleEvent(["type":"sessions_list","sessions":[["id":"a","agentType":"claude-code","state":"processing","alive":true]]])
        await module.reloadFromSettingsExternal()
        return module
    }
    private func decoded(_ rows: [Data]) -> [[String: Any]] { rows.map { try! JSONSerialization.jsonObject(with: $0) as! [String: Any] } }
    func testBundledCoreCachePalindromeBoundsAndActivity() throws {
        let renderer = try PixooBakedRenderer()
        XCTAssertEqual(PixooLoopPolicy.gammaLUT.count, 256)
        for i in 0..<256 { XCTAssertEqual(PixooLoopPolicy.gammaLUT[i], Int(round(pow(Double(i)/255,0.7)*255))) }
        let state: [String:Any] = ["state":"processing","agentType":"claude-code"]
        let at = 1_793_424_000_000.0
        let frames = try renderer.render(state: state, usage: nil, sessions: nil, nowMs: at)
        XCTAssertEqual(frames.count, 14); XCTAssertTrue(frames.allSatisfy { $0.count == 12_288 })
        for index in 1..<7 { XCTAssertEqual(frames[index], frames[14-index]) }
        XCTAssertNotEqual(frames[0], frames[1])
        XCTAssertEqual(try renderer.render(state: state, usage: nil, sessions: nil, nowMs: at+1), frames)
        renderer.clear()
        XCTAssertEqual(try renderer.render(state: state, usage: nil, sessions: nil, nowMs: at), frames)
        XCTAssertThrowsError(try renderer.render(state: state, usage: nil, sessions: Array(repeating: [:], count: 33), nowMs: at))
        XCTAssertThrowsError(try renderer.render(state: state, usage: ["extra":String(repeating:"x", count:131_073)], sessions:nil, nowMs:at))
        XCTAssertTrue(renderer.isActive(state: state, sessions: [], timeline: [], nowMs: at))
    }
    func testActualModuleUsesOneFramePerRequestAndCoalescesCadence() async {
        let recorder = PixooCommands(), clock = PixooTestClock(), module = await prepare(recorder, clock)
        await module.checkAndPush()
        let first = decoded(await recorder.frames()); XCTAssertEqual(first.count, 14)
        XCTAssertEqual(Set(first.compactMap { $0["PicID"] as? Int }).count, 1)
        XCTAssertEqual(first.compactMap { $0["PicOffset"] as? Int }, Array(0..<14))
        XCTAssertTrue(first.allSatisfy { ($0["PicNum"] as? Int) == 14 && ($0["PicSpeed"] as? Int) == 200 && Data(base64Encoded:$0["PicData"] as? String ?? "")?.count == 12_288 })
        clock.advance(9); await module.checkAndPush()
        let cached = await recorder.frames(); XCTAssertEqual(cached.count, 14)
        clock.advance(1); await module.checkAndPush()
        let refreshed = await recorder.frames(); XCTAssertEqual(refreshed.count, 28)
        await module.handleEvent(["type":"state_update","state":"awaiting_permission","agentType":"claude-code"])
        clock.advance(1); await module.checkAndPush()
        let burst = await recorder.frames(); XCTAssertEqual(burst.count, 28)
        clock.advance(2); await module.checkAndPush()
        let changed = await recorder.frames(); XCTAssertEqual(changed.count, 42)
        await module.stop()
        let farewell = decoded(await recorder.frames()); XCTAssertEqual(farewell.count, 43)
        XCTAssertEqual(farewell.last?["PicNum"] as? Int, 1)
        clock.advance(20); await module.checkAndPush()
        let afterStop = await recorder.frames(); XCTAssertEqual(afterStop.count, 43)
    }
    func testFailureAbortsThenUsesSingleFramesUntilCooldownExpires() async {
        let recorder = PixooCommands(), clock = PixooTestClock(), module = await prepare(recorder, clock)
        await recorder.configure(fail: 2); await module.checkAndPush()
        let failed = await recorder.frames(); XCTAssertEqual(failed.count, 3)
        await recorder.configure(); clock.advance(3); await module.checkAndPush()
        let fallback = decoded(await recorder.frames()); XCTAssertEqual(fallback.count, 4); XCTAssertEqual(fallback.last?["PicNum"] as? Int, 1)
        clock.advance(900); await module.checkAndPush()
        let recovered = await recorder.frames(); XCTAssertEqual(recovered.count, 18)
        await module.stop()
    }
    func testDimDuringUploadStopsRemainingFramesAndWakeRestoresBrightness() async throws {
        let recorder = PixooCommands(), clock = PixooTestClock(), module = await prepare(recorder, clock)
        await recorder.configure(hold: 1)
        let upload = Task { await module.checkAndPush() }
        for _ in 0..<200 { if await recorder.held != nil { break }; try await Task.sleep(for: .milliseconds(5)) }
        let pending = await recorder.held != nil; XCTAssertTrue(pending)
        await module.handleEvent(["type":"display_state","displayOn":false,"dim":["enabled":true,"mode":"min","level":7]])
        await recorder.release(); await upload.value
        let stopped = await recorder.frames(); XCTAssertEqual(stopped.count, 2)
        clock.advance(20); await module.checkAndPush()
        let asleep = await recorder.frames(); XCTAssertEqual(asleep.count, 2)
        await module.handleEvent(["type":"display_state","displayOn":true])
        for _ in 0..<100 {
            let rows = decoded(await recorder.all())
            if rows.filter({ $0["Command"] as? String == "Channel/SetBrightness" }).count >= 3 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let brightness = decoded(await recorder.all()).filter { $0["Command"] as? String == "Channel/SetBrightness" }.compactMap { $0["Brightness"] as? Int }
        XCTAssertEqual(brightness, [37,7,37])
        await recorder.configure(); await module.checkAndPush()
        let awake = await recorder.frames(); XCTAssertEqual(awake.count, 16)
        await module.stop()
    }
    func testUnknownUploadReplyAndUnknownCounterCannotBecomeSuccessOrZero() async {
        let recorder = PixooCommands(), clock = PixooTestClock(), module = await prepare(recorder, clock)
        await recorder.invalid(frame: true); await module.checkAndPush()
        let rejected = await recorder.frames(); XCTAssertEqual(rejected.count, 1)
        await recorder.invalid(id: true); clock.advance(3); await module.checkAndPush()
        let noFabricatedID = await recorder.frames(); XCTAssertEqual(noFabricatedID.count, 1)
        XCTAssertFalse((module.statusSnapshot()["lastPushError"] as? String ?? "").isEmpty)
        await recorder.invalid(counter: 1e20); clock.advance(3); await module.checkAndPush()
        let noOverflow = await recorder.frames(); XCTAssertEqual(noOverflow.count, 1)
        await module.stop()
    }
    func testCounterWrapRequiresAnAcknowledgedResetBeforeFrameOne() async {
        let recorder = PixooCommands(), clock = PixooTestClock()
        await recorder.seedCounter(249)
        let module = await prepare(recorder, clock)
        await recorder.rejectReset(true); await module.checkAndPush()
        let refused = await recorder.frames(); XCTAssertTrue(refused.isEmpty)
        await recorder.rejectReset(false); clock.advance(3); await module.checkAndPush()
        let recovered = decoded(await recorder.frames()); XCTAssertEqual(recovered.count,1)
        XCTAssertEqual(recovered.first?["PicID"] as? Int,1)
        await module.stop()
    }
    func testChildActivityChangesUseTheCommonThreeSecondStateFloor() async {
        let recorder = PixooCommands(), clock = PixooTestClock(), module = await prepare(recorder, clock)
        await module.handleEvent(["type":"state_update","state":"idle","agentType":"claude-code"])
        await module.handleEvent(["type":"sessions_list","sessions":[["id":"a","agentType":"claude-code","state":"idle","alive":true]]])
        await module.checkAndPush()
        let idle = await recorder.frames(); XCTAssertEqual(idle.count, 1)
        clock.advance(1)
        await module.handleEvent(["type":"timeline_event","entry":["sessionId":"a","type":"tool_exec","ts":clock.get().timeIntervalSince1970*1000,"raw":"Subagent ×3 helpers"]])
        await module.checkAndPush()
        let coalesced = await recorder.frames(); XCTAssertEqual(coalesced.count, 1)
        clock.advance(2); await module.checkAndPush()
        let active = await recorder.frames(); XCTAssertEqual(active.count, 15)
        await module.stop()
    }
    func testLongCombiningTimelinePrefixStaysInsideTheInputBudget() async {
        let recorder = PixooCommands(), clock = PixooTestClock(), module = await prepare(recorder, clock)
        await module.handleEvent(["type":"timeline_history","entries":[["sessionId":"a","type":"tool_exec","ts":clock.get().timeIntervalSince1970*1000,"raw":"Subagent ×2 a"+String(repeating:"\u{301}",count:200_000)]]])
        await module.checkAndPush()
        let frames = await recorder.frames(); XCTAssertEqual(frames.count, 14)
        await module.stop()
    }
    func testUnchangedDisplayOnHeartbeatDoesNotCancelLoop() async throws {
        let recorder = PixooCommands(), clock = PixooTestClock(), module = await prepare(recorder, clock)
        await recorder.configure(hold: 1)
        let upload = Task { await module.checkAndPush() }
        for _ in 0..<200 { if await recorder.held != nil { break }; try await Task.sleep(for: .milliseconds(5)) }
        await module.handleEvent(["type":"display_state","displayOn":true])
        await recorder.release(); await upload.value
        let frames = await recorder.frames(); XCTAssertEqual(frames.count, 14)
        await module.stop()
    }
    @MainActor func testEditingAnimationPreservesBrightnessAndUnknownDeviceFields() async {
        let rows = PixooSheet.updatedDeviceRows(currentRows: [["ip":"a","brightness":27,"animation":"tide","future":"keep"],["ip":"b","brightness":82]],
                                               devices:[.init(ip:"a",name:"Desk",animation:"loop"),.init(ip:"b",name:nil)])
        XCTAssertEqual(rows[0]["brightness"] as? Int,27); XCTAssertEqual(rows[0]["future"] as? String,"keep")
        XCTAssertEqual(rows[0]["animation"] as? String,"loop"); XCTAssertEqual(rows[1]["brightness"] as? Int,82)
    }
}
#endif
