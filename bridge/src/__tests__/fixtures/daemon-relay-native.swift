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
        var row: [String:Any] = ["id":"observed:claude:native","projectName":"relay-fixture","alive":true,"agentType":"claude-code","controlMode":"observed","state":"awaiting_permission","requestId":"native-held-gate","stopRequested":false,"waitingOn":NSNull()]
        if mode == "worker-ask" {
            row["state"] = "awaiting_option"; row["question"] = "Which path?"; row["liveAnswerable"] = true
            row["requestId"] = "native-ask-gate"; row["_relayHeldAsk"] = true
            row["options"] = ["Alpha", "Bravo", "Charlie"].enumerated().map { ["index":$0.offset,"label":$0.element] as [String:Any] }
        }
        let rows = [row]
        if mode == "worker" || mode == "worker-ask" {
            let connection = DaemonRelayConnection(storage:Memory().storage)
            try await connection.connect(host:"127.0.0.1",port:port,token:nil,consent:true)
            let uplink = DaemonRelayUplink(instanceId:"swift-worker",connection:connection,snapshot:{ DaemonRelayRules.nativeSnapshot(rows.map { original in
                var row = original
                if row["_relayHeldAsk"] as? Bool == true { row.removeValue(forKey:"requestId"); row.removeValue(forKey:"_relayHeldAsk") }
                return row
            },current:rows) + [["id":"legacy-managed","port":9122],["id":"explicit-managed","controlMode":"managed"],["id":"observed:claude:received","controlMode":"observed"]] },current:{rows},exclude:{["observed:claude:received"]},execute:{ emit(["event":"executed","command":$0]) })
            await uplink.configure(); emit(["event":"started"])
            try await Task.sleep(for:.seconds(60)); uplink.stop()
        } else {
            let hub = DaemonRelayHub(instanceId:"swift-hub"), listener = WebSocketServer(), http = HTTPServer()
            hub.onChange = { emit(["event":"roster","sessions":hub.rows()]) }
            await http.setCredentialGeneration { AuthManager.shared.credentialGeneration }
            await http.get("/health") { _ in .json(["status":"ok","mode":"daemon","daemonRelay":true,"authRequired":true]) }
            if mode == "generation" {
                await http.get("/slow-secret") { _ in
                    emit(["event": "slow-started"])
                    try? await Task.sleep(for: .milliseconds(500))
                    return .json(["token": AuthManager.shared.token])
                }
                await http.post("/advance") { _ in
                    do {
                        let state = try await AuthManager.shared.rotate(minimumRevision: 0)
                        emit(["event": "advanced", "revision": state.revision])
                        var response = HTTPServer.HTTPResponse.json(["advanced": true])
                        response.permitsCredentialChange = true
                        return response
                    } catch { return .json(["error": true], status: 409) }
                }
                await http.post("/publish") { _ in
                    await listener.broadcastRaw(Data(AuthManager.shared.token.utf8))
                    return .json(["published": true])
                }
                await http.post("/approve") { _ in
                    PairingKnockStore.shared.approve(key: "device:" + String(repeating: "a", count: 32), credentialGeneration: HTTPRequestContext.credentialGeneration)
                    return .json(["approved": true])
                }
                await http.get("/approval") { _ in
                    .json(["approved": PairingKnockStore.shared.isApproved(ip: "192.0.2.1", deviceId: String(repeating: "a", count: 32), credentialGeneration: AuthManager.shared.credentialGeneration)])
                }
                await http.post("/knock") { _ in
                    PairingKnockStore.shared.record(ip: "192.0.2.1", deviceId: String(repeating: "a", count: 32), staleToken: true, credentialGeneration: AuthManager.shared.credentialGeneration)
                    return .json(["knocks": PairingKnockStore.shared.knocks().count])
                }
            }
            if mode == "retirement" {
                await http.stream("/held-stream") { _, connection in
                    connection.send(Data("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: ready\n\n".utf8)) { _ in }
                }
                await http.post("/retire-sockets") { _ in
                    var response = HTTPServer.HTTPResponse.json(["retired": true])
                    response.afterSend = { Task { await listener.reauthenticateClients(includeHTTP: true) } }
                    return response
                }
            }
            await listener.setHTTPHandler(http)
            await listener.setCommandHandler { cmd,conn in
                if mode == "generation" { emit(["event": "generation-command-received"]) }
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
