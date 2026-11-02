#if os(macOS)
import XCTest
@testable import AgentDeck

private final class RelayMemory: @unchecked Sendable {
    let lock = NSLock(); var data: Data?; var consent = false; var failRemove = false
    var storage: GitHubCIStorage { .init(load:{ self.lock.withLock { self.data } },save:{ value in self.lock.withLock { self.data = value } },remove:{ try self.lock.withLock { if self.failRemove { throw URLError(.noPermissionsToReadFile) }; self.data = nil } },consent:{ self.lock.withLock { self.consent } },setConsent:{ value in self.lock.withLock { self.consent = value } }) }
}
@DaemonActor
private final class RelayFixture {
    var hellos = 0, snapshots = 0, refusals = 0
    var peer: WebSocketConnection?
    var received: [[String:Any]] = []
    func handle(_ cmd: [String:Any], _ conn: WebSocketConnection) {
        peer = conn
        switch cmd["type"] as? String {
        case "relay_hello": hellos += 1; send(["type":"relay_ack","v":1])
        case "relay_sessions": snapshots += 1; received = cmd["sessions"] as? [[String:Any]] ?? []
        case "relay_command_refused": refusals += 1
        default: break
        }
    }
    func send(_ cmd: [String:Any]) { if let data = DaemonRelayRules.data(cmd) { peer?.send(data) } }
}
final class DaemonRelayTests: XCTestCase {
    func testBuiltAppTransportPolicyLimitsRelayExceptionToSharedIPv4Space() throws {
        // Inspect the built host Info.plist, not a source-file copy: this also
        // catches project generation or packaging dropping the exception.
        let policy = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any])
        XCTAssertEqual(Set(policy.keys), ["NSAllowsLocalNetworking", "NSExceptionDomains"])
        XCTAssertEqual(policy["NSAllowsLocalNetworking"] as? Bool, true)
        let exceptions = try XCTUnwrap(policy["NSExceptionDomains"] as? [String: [String: Any]])
        XCTAssertEqual(Set(exceptions.keys), ["100.64.0.0/10"])
        let sharedSpace = try XCTUnwrap(exceptions["100.64.0.0/10"])
        XCTAssertEqual(Set(sharedSpace.keys), ["NSExceptionAllowsInsecureHTTPLoads"])
        XCTAssertEqual(sharedSpace["NSExceptionAllowsInsecureHTTPLoads"] as? Bool, true)
    }
    private let row: [String:Any] = ["id":"observed:claude:one","agentType":"claude-code","controlMode":"observed","requestId":"gate-one","state":"awaiting_permission","port":9123]
    func testTypedRowsRetainExplicitFalseNullAndRejectManagedUnknownFields() {
        let rows = DaemonRelayRules.sanitize([["id":"a","alive":false,"state":3,"stopRequested":false,"waitingOn":NSNull(),"weight":1e30,"secret":"hidden"], ["id":"a"],["id":"m","controlMode":"managed"],["id":"openclaw-gateway"]])
        XCTAssertEqual(rows.count,1); XCTAssertEqual(rows[0]["port"] as? Int,0)
        XCTAssertEqual(rows[0]["alive"] as? Bool,false); XCTAssertEqual(rows[0]["stopRequested"] as? Bool,false)
        XCTAssertTrue(rows[0]["waitingOn"] is NSNull); XCTAssertNil(rows[0]["state"]); XCTAssertNil(rows[0]["secret"])
        XCTAssertEqual(rows[0]["weight"] as? Int,SessionWeightRules.max)
        let many = (0..<100).map { ["id":String($0)] }
        XCTAssertEqual(DaemonRelayRules.sanitize(many).count,DaemonRelayPolicy.RELAY_MAX_ROWS)
    }
    func testPublicationExcludesReceivedManagedGatewayAndVolatileElapsed() {
        var local = row; local["elapsedSec"] = 10
        let rows = DaemonRelayRules.publish([local,["id":"r"],["id":"m","controlMode":"managed"],["id":"openclaw-gateway"]],excluding:["r"])
        XCTAssertEqual(rows.count,1); XCTAssertNil(rows[0]["elapsedSec"])
    }
    func testHeldQuestionKeepsOriginalOptionsAndPrivateGateCorrelation() {
        let visible: [String:Any] = ["id":"observed:claude:ask","agentType":"claude-code","controlMode":"observed",
            "question":"Which path?","liveAnswerable":true,"options":[["index":0,"label":"Alpha"],["index":1,"label":"Bravo"],["index":2,"label":"Charlie"]]]
        var held = visible; held["requestId"] = "ask-one"; held["_relayHeldAsk"] = true
        let published = DaemonRelayRules.nativeSnapshot([visible],current:[held])
        XCTAssertEqual(published[0]["requestId"] as? String,"ask-one")
        let wire = DaemonRelayRules.nativeWireRows(published)[0]
        XCTAssertNil(wire["requestId"]); XCTAssertNil(wire["_relayHeldAsk"])
        XCTAssertEqual(wire["question"] as? String,"Which path?")
        XCTAssertEqual((wire["options"] as? [[String:Any]])?.compactMap { $0["label"] as? String },["Alpha","Bravo","Charlie"])
        let choose: [String:Any] = ["type":"select_option","sessionId":"observed:claude:ask","index":2,"question":"Which path?"]
        XCTAssertNotNil(DaemonRelayRules.nativeCommand(choose,published:published,current:[held]))
        var replacement = held; replacement["requestId"] = "ask-two"
        XCTAssertNil(DaemonRelayRules.nativeCommand(choose,published:published,current:[replacement]))
        let refreshed = DaemonRelayRules.nativeSnapshot([visible],current:[replacement])
        XCTAssertNotEqual(DaemonRelayRules.data(published),DaemonRelayRules.data(refreshed))
        XCTAssertEqual(DaemonRelayRules.data(DaemonRelayRules.nativeWireRows(published)),DaemonRelayRules.data(DaemonRelayRules.nativeWireRows(refreshed)))
        XCTAssertNotNil(DaemonRelayRules.nativeCommand(choose,published:refreshed,current:[replacement]))
        XCTAssertEqual(DaemonRelayRules.nativeWireRows([row])[0]["requestId"] as? String,"gate-one")
    }
    @DaemonActor
    func testHubHandshakeSupersessionDedupAndCloseCannotRemoveReplacement() async {
        let hub = DaemonRelayHub(instanceId:"hub"), a = UUID(), b = UUID()
        var replies: [[String:Any]] = [], changes = 0
        hub.onChange = { changes += 1 }
        func hello(_ id: UUID,_ instance: String,_ v: Int = 1) { hub.handle(["type":"relay_hello","instanceId":instance,"v":v],socket:id,send:{ replies.append($0) }) }
        hello(a,"hub"); XCTAssertEqual(replies.last?["type"] as? String,"relay_refused")
        hello(a,"w",9); XCTAssertFalse(hub.contains(a))
        hub.handle(["type":"relay_sessions","sessions":[row]],socket:a,send:{_ in}); XCTAssertTrue(hub.rows().isEmpty)
        hello(a,"w"); hub.handle(["type":"relay_sessions","sessions":[row,row]],socket:a,send:{_ in})
        XCTAssertEqual(hub.rows().count,1)
        let before = changes
        hub.handle(["type":"relay_sessions","sessions":[row,row]],socket:a,send:{_ in}); XCTAssertEqual(changes,before)
        hello(b,"w"); hub.handle(["type":"relay_sessions","sessions":[row]],socket:b,send:{_ in})
        hub.drop(a); XCTAssertEqual(hub.rows().count,1)
        hub.drop(b); XCTAssertTrue(hub.rows().isEmpty)
    }
    @DaemonActor
    func testStaleRowsExpireOnReadSweepOnceAndHeartbeatRestores() async {
        let hub = DaemonRelayHub(instanceId:"hub"), socket = UUID(); var changes = 0
        hub.onChange = { changes += 1 }
        hub.handle(["type":"relay_hello","instanceId":"w","v":1],socket:socket,now:100,send:{_ in})
        hub.handle(["type":"relay_sessions","sessions":[row]],socket:socket,now:100,send:{_ in})
        XCTAssertEqual(hub.rows(now:145).count,1); XCTAssertTrue(hub.rows(now:145.001).isEmpty)
        let before = changes; hub.sweep(now:146); hub.sweep(now:147); XCTAssertEqual(changes,before+1)
        hub.handle(["type":"relay_sessions","sessions":[row]],socket:socket,now:148,send:{_ in})
        XCTAssertEqual(hub.rows(now:148).count,1)
    }
    @DaemonActor
    func testHubDerivesElapsedWithoutSnapshotChurn() async {
        let hub = DaemonRelayHub(instanceId:"hub"), socket = UUID()
        hub.handle(["type":"relay_hello","instanceId":"w","v":1],socket:socket,now:100,send:{_ in})
        hub.handle(["type":"relay_sessions","sessions":[["id":"r","startedAt":"1970-01-01T00:01:00.000Z"]]],socket:socket,now:100,send:{_ in})
        XCTAssertEqual(hub.rows(now:100.9).first?["elapsedSec"] as? Int,40)
        XCTAssertEqual(hub.rows(now:101.9).first?["elapsedSec"] as? Int,41)
    }
    @DaemonActor
    func testLocalIdentityAndRequestsWinAndStaleRemoteFocusNeverFallsThrough() async {
        let hub = DaemonRelayHub(instanceId:"hub"), socket = UUID(); var sent: [[String:Any]] = []
        hub.handle(["type":"relay_hello","instanceId":"w","v":1],socket:socket,send:{ sent.append($0) })
        hub.handle(["type":"relay_sessions","sessions":[row]],socket:socket,send:{_ in})
        let cmd: [String:Any] = ["type":"session_command","sessionId":"observed:claude:one","command":["type":"interrupt"]]
        XCTAssertFalse(hub.route(cmd,focused:nil,local:[row]))
        XCTAssertFalse(hub.route(["type":"permission_decision","requestId":"gate-one","decision":"allow"],focused:nil,local:[row]))
        XCTAssertTrue(hub.route(cmd,focused:nil,local:[])); XCTAssertEqual(sent.last?["type"] as? String,"relay_command_down")
        XCTAssertTrue(DaemonRelayRules.rejectsLocalFallback(["type":"interrupt"],focused:"retired-id-evicted-from-cache",local:[]))
        XCTAssertTrue(DaemonRelayRules.rejectsLocalFallback(["type":"select_option","sessionId":"unknown-remote","index":0],focused:"local",local:["local"]))
        XCTAssertFalse(DaemonRelayRules.rejectsLocalFallback(["type":"voice"],focused:"remote",local:[]))
        XCTAssertFalse(DaemonRelayRules.rejectsLocalFallback(["type":"interrupt"],focused:"local",local:["local"]))
        hub.drop(socket); let count = sent.count
        XCTAssertTrue(hub.route(["type":"interrupt"],focused:"observed:claude:one",local:[])); XCTAssertEqual(sent.count,count)
    }
    func testWorkerRejectsGlobalTerminalUnsupportedAgentAndStaleControl() {
        let bad: [[String:Any]] = [["type":"voice"],["type":"launch_session"],["type":"set_session_setting"],["type":"session_command","sessionId":"other","command":["type":"interrupt"]],["type":"session_command","sessionId":"observed:claude:one","command":["type":"type_text","text":"danger"]]]
        for cmd in bad { XCTAssertNil(DaemonRelayRules.nativeCommand(cmd,published:[row],current:[row])) }
        let prompt: [String:Any] = ["type":"session_command","sessionId":"observed:claude:one","command":["type":"send_prompt","text":"hello"]]
        XCTAssertNotNil(DaemonRelayRules.nativeCommand(prompt,published:[row],current:[row]))
        XCTAssertNil(DaemonRelayRules.nativeCommand(prompt,published:[row],current:[]))
        var codex = row; codex["agentType"] = "codex"; XCTAssertNil(DaemonRelayRules.nativeCommand(prompt,published:[codex],current:[codex]))
        var heldCodex = codex; heldCodex["_relayHeldCodex"] = true
        let codexAnswer: [String:Any] = ["type":"permission_decision","requestId":"gate-one","decision":"allow"]
        XCTAssertNotNil(DaemonRelayRules.nativeCommand(codexAnswer,published:[codex],current:[heldCodex]))
        XCTAssertNil(DaemonRelayRules.nativeCommand(prompt,published:[codex],current:[heldCodex]))
        var noGate = row; noGate.removeValue(forKey:"requestId")
        let answer: [String:Any] = ["type":"select_option","sessionId":"observed:claude:one","index":0,"question":"Pick"]
        XCTAssertNil(DaemonRelayRules.nativeCommand(answer,published:[row],current:[noGate]))
        XCTAssertNotNil(DaemonRelayRules.nativeCommand(answer,published:[row],current:[row]))
        var ask = row; ask["_relayHeldAsk"] = true
        let askPermission: [String:Any] = ["type":"permission_decision","requestId":"gate-one","decision":"allow"]
        XCTAssertNil(DaemonRelayRules.nativeCommand(askPermission,published:[row],current:[ask]))
        var missingEcho = answer; missingEcho.removeValue(forKey:"question")
        XCTAssertNil(DaemonRelayRules.nativeCommand(missingEcho,published:[row],current:[ask]))
        let permission: [String:Any] = ["type":"permission_decision","requestId":"stale","decision":"allow"]
        XCTAssertNil(DaemonRelayRules.nativeCommand(permission,published:[row],current:[row]))
    }
    func testEndpointConsentTokenPersistenceAndFailedRemovalStayOff() async throws {
        XCTAssertThrowsError(try DaemonRelayTarget(host:"192.0.2.1",port:9120,token:nil))
        for host in ["example.com/path","user@example.com","host?token=x","evil\nlocalhost"] { XCTAssertThrowsError(try DaemonRelayTarget(host:host,port:9120,token:"x")) }
        XCTAssertNoThrow(try DaemonRelayTarget(host:"::1",port:9120,token:nil))
        let memory = RelayMemory(), config = DaemonRelayConnection(storage:memory.storage)
        do { try await config.connect(host:"127.0.0.1",port:9120,token:nil,consent:false); XCTFail("no consent") } catch {}
        try await config.connect(host:"hub.example",port:9120,token:"synthetic",consent:true)
        let restored = DaemonRelayConnection(storage:memory.storage)
        let target = try await restored.snapshot().1; XCTAssertEqual(target?.host,"hub.example"); XCTAssertEqual(target?.token,"synthetic")
        memory.failRemove = true
        do { try await config.disconnect(); XCTFail("expected removal failure") } catch {}
        let disabled = try await DaemonRelayConnection(storage:memory.storage).snapshot().1; XCTAssertNil(disabled)
    }
    @DaemonActor
    func testActualNativeWorkerSocketReconnectUnsupportedRefusalAndStop() async throws {
        let fixture = RelayFixture(), http = HTTPServer(), listener = WebSocketServer()
        await http.get("/health") { _ in .json(["mode":"daemon","daemonRelay":true]) }
        await listener.setHTTPHandler(http)
        await listener.setCommandHandler { cmd,conn in let box = SendableDict(cmd); Task { @DaemonActor in fixture.handle(box.value,conn) } }
        try await listener.start(port:19781,loopbackOnly:true)
        let config = DaemonRelayConnection(storage:RelayMemory().storage)
        try await config.connect(host:"127.0.0.1",port:19781,token:nil,consent:true)
        var executed: [[String:Any]] = []
        let local = row
        let worker = DaemonRelayUplink(instanceId:"native-worker",connection:config,snapshot:{[local,["id":"legacy-managed","port":9122]]},current:{[local]},exclude:{[]},execute:{executed.append($0)})
        await worker.configure()
        for _ in 0..<300 { if fixture.snapshots > 0 { break }; try await Task.sleep(for:.milliseconds(10)) }
        XCTAssertEqual(fixture.received.count,1)
        XCTAssertEqual(fixture.received.first?["id"] as? String,local["id"] as? String)
        fixture.send(["type":"relay_command_down","command":["type":"voice"]])
        fixture.send(["type":"relay_command_down","command":["type":"session_command","sessionId":"observed:claude:one","command":["type":"interrupt"]]])
        for _ in 0..<100 { if fixture.refusals > 0 && !executed.isEmpty { break }; try await Task.sleep(for:.milliseconds(10)) }
        XCTAssertEqual(fixture.refusals,1); XCTAssertEqual(executed.count,1)
        fixture.peer?.close(force:true)
        for _ in 0..<500 { if fixture.hellos >= 2 && fixture.snapshots >= 2 { break }; try await Task.sleep(for:.milliseconds(10)) }
        XCTAssertEqual(fixture.hellos,2)
        worker.stop(); let count = fixture.hellos
        try await Task.sleep(for:.milliseconds(100)); await worker.configure(); XCTAssertEqual(fixture.hellos,count)
        await listener.stop()
    }
}
#endif
