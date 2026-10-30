// Test-only executable. Links production native relay, WS/auth and HTTP code;
// never packaged in the app. Parent supplies a temporary AGENTDECK_DATA_DIR.
import Foundation
@globalActor actor DaemonActor { static let shared = DaemonActor() }
private struct RelayBox: @unchecked Sendable { let value: [String:Any] }
private final class Memory: @unchecked Sendable {
    let lock = NSLock(); var data: Data?; var consent = false
    var storage: GitHubCIStorage { .init(load:{ self.lock.withLock { self.data } },save:{ data in self.lock.withLock { self.data = data } },remove:{ self.lock.withLock { self.data = nil } },consent:{ self.lock.withLock { self.consent } },setConsent:{ value in self.lock.withLock { self.consent = value } }) }
}
@main struct RelayNativeFixture {
    static func emit(_ object: [String:Any]) {
        if var data = DaemonRelayRules.data(object) { data.append(10); FileHandle.standardOutput.write(data) }
    }
    @DaemonActor private static func route(_ box: RelayBox, hub: DaemonRelayHub) { _ = hub.route(box.value,focused:nil,local:[]) }
    static func main() async throws { try await run() }
    @DaemonActor static func run() async throws {
        let mode = CommandLine.arguments[1], port = Int(CommandLine.arguments[2])!
        let rows: [[String:Any]] = [["id":"observed:claude:native","agentType":"claude-code","controlMode":"observed","state":"awaiting_permission","requestId":"native-held-gate","stopRequested":false,"waitingOn":NSNull()]]
        if mode == "worker" {
            let connection = DaemonRelayConnection(storage:Memory().storage)
            try await connection.connect(host:"127.0.0.1",port:port,token:nil,consent:true)
            let uplink = DaemonRelayUplink(instanceId:"swift-worker",connection:connection,snapshot:{ rows + [["id":"legacy-managed","port":9122],["id":"explicit-managed","controlMode":"managed"],["id":"observed:claude:received","controlMode":"observed"]] },current:{rows},exclude:{["observed:claude:received"]},execute:{ emit(["event":"executed","command":$0]) })
            await uplink.configure(); emit(["event":"started"])
            try await Task.sleep(for:.seconds(60)); uplink.stop()
        } else {
            let hub = DaemonRelayHub(instanceId:"swift-hub"), listener = WebSocketServer(), http = HTTPServer()
            hub.onChange = { emit(["event":"roster","sessions":hub.rows()]) }
            await http.get("/health") { _ in .json(["status":"ok","mode":"daemon","daemonRelay":true,"authRequired":true]) }
            await listener.setHTTPHandler(http)
            await listener.setCommandHandler { cmd,conn in
                let box = RelayBox(value:cmd)
                Task { @DaemonActor in hub.handle(box.value,socket:conn.id,send:{ if let data = DaemonRelayRules.data($0) { conn.send(data) } }) }
            }
            await listener.setDisconnectHandler { conn in Task { @DaemonActor in hub.drop(conn.id) } }
            try await listener.start(port:UInt16(port),loopbackOnly:true)
            emit(["event":"ready"])
            Task.detached {
                while let line = readLine(), let data = line.data(using:.utf8), let cmd = try? JSONSerialization.jsonObject(with:data) as? [String:Any] {
                    let box = RelayBox(value:cmd)
                    await route(box,hub:hub)
                }
            }
            try await Task.sleep(for:.seconds(60)); await listener.stop()
        }
    }
}
