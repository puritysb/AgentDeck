#if os(macOS)
import Foundation

private final class RelayNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@DaemonActor
final class DaemonRelayUplink {
    private let instanceId: String
    private let host: String
    private let snapshot: @DaemonActor () -> [[String:Any]]
    private let current: @DaemonActor () -> [[String:Any]]
    private let exclude: @DaemonActor () -> Set<String>
    private let execute: @DaemonActor ([String:Any]) -> Void
    private let connection: DaemonRelayConnection
    private var revision: Int?
    private var task: Task<Void,Never>?
    private var pushTask: Task<Void,Never>?
    private var pingTask: Task<Void,Never>?
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var epoch = 0
    private var stopped = false
    private var published: [[String:Any]] = []
    private var lastJSON = Data(), lastSent = Date.distantPast
    private var sending = false
    init(instanceId: String, host: String = ProcessInfo.processInfo.hostName, connection: DaemonRelayConnection = .shared,
         snapshot: @escaping @DaemonActor () -> [[String:Any]], current: @escaping @DaemonActor () -> [[String:Any]],
         exclude: @escaping @DaemonActor () -> Set<String>, execute: @escaping @DaemonActor ([String:Any]) -> Void) {
        self.instanceId = instanceId; self.host = host; self.connection = connection
        self.snapshot = snapshot; self.current = current; self.exclude = exclude; self.execute = execute
    }
    func configure() async {
        do {
            let (revision,target) = try await connection.snapshot()
            guard !stopped, self.revision != revision else { return }
            retire(); self.revision = revision
            if let target { let ticket = epoch; task = Task { [weak self] in await self?.run(target,epoch:ticket,revision:revision) } }
        } catch { retire(); revision = nil }
    }
    func stop() { stopped = true; retire() }
    private func retire() {
        epoch += 1; task?.cancel(); task = nil; dispose()
    }
    private func dispose() {
        pushTask?.cancel(); pingTask?.cancel(); pushTask = nil; pingTask = nil
        socket?.cancel(with:.goingAway,reason:nil); socket = nil
        session?.invalidateAndCancel(); session = nil; published = []; lastJSON = Data(); lastSent = .distantPast; sending = false
    }
    private func valid(_ ticket: Int,_ revision: Int) -> Bool { !stopped && !Task.isCancelled && epoch == ticket && connection.generation.value == revision }
    private func report(_ text: String,_ revision: Int) { connection.generation.report(text,revision:revision) }
    private func health(_ target: DaemonRelayTarget) async throws -> Bool {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = Double(DaemonRelayPolicy.RELAY_HEALTH_TIMEOUT_MS)/1000
        config.timeoutIntervalForResource = config.timeoutIntervalForRequest
        config.httpCookieStorage = nil; config.urlCache = nil; config.urlCredentialStorage = nil
        let client = URLSession(configuration:config,delegate:RelayNoRedirect(),delegateQueue:nil)
        defer { client.invalidateAndCancel() }
        guard let url = target.url(scheme:"http",health:true) else { return false }
        let (bytes,response) = try await client.bytes(from:url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        var data = Data()
        for try await byte in bytes { guard data.count < DaemonRelayPolicy.RELAY_MAX_MESSAGE_BYTES else { throw URLError(.dataLengthExceedsMaximum) }; data.append(byte) }
        guard let json = try JSONSerialization.jsonObject(with:data) as? [String:Any], json["mode"] as? String == "daemon" else { throw URLError(.badServerResponse) }
        return DaemonRelayRules.bool(json["daemonRelay"]) == true
    }
    /// Cancelling the actual socket bounds a silent send/receive/ping, including
    /// continuations whose peer never returns. No task-group join on peer I/O.
    private func deadline(_ ws: URLSessionWebSocketTask, ms: Int) -> Task<Void,Never> {
        Task { try? await Task.sleep(for:.milliseconds(ms)); if !Task.isCancelled { ws.cancel(with:.goingAway,reason:nil) } }
    }
    private func send(_ object: [String:Any], ws: URLSessionWebSocketTask) async throws {
        guard let data = DaemonRelayRules.data(object), data.count <= DaemonRelayPolicy.RELAY_MAX_MESSAGE_BYTES,
              let text = String(data:data,encoding:.utf8) else { throw URLError(.dataLengthExceedsMaximum) }
        let timer = deadline(ws,ms:DaemonRelayPolicy.RELAY_SEND_TIMEOUT_MS); defer { timer.cancel() }
        try await ws.send(.string(text))
    }
    private func receive(_ ws: URLSessionWebSocketTask, ms: Int) async throws -> [String:Any] {
        let timer = deadline(ws,ms:ms); defer { timer.cancel() }
        let message = try await ws.receive()
        let data: Data
        switch message { case .data(let d): data = d; case .string(let s): data = Data(s.utf8); @unknown default: throw URLError(.cannotParseResponse) }
        guard data.count <= DaemonRelayPolicy.RELAY_MAX_MESSAGE_BYTES,
              let json = try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw URLError(.cannotParseResponse) }; return json
    }
    private func push(_ ws: URLSessionWebSocketTask, ticket: Int, revision: Int, force: Bool = false) async throws {
        guard valid(ticket,revision), socket === ws, !sending else { return }
        sending = true; defer { if socket === ws { sending = false } }
        // Native registry/managed rows can omit controlMode; unlike the Node
        // enriched roster, absence here is not evidence of observation.
        // Capture exclusions first; this synchronous actor turn cannot receive
        // a new worker frame, and a TTL boundary cannot re-publish an old row.
        let excluded = exclude()
        let observed = snapshot().filter { $0["controlMode"] as? String == "observed" }
        let rows = DaemonRelayRules.publish(observed,excluding:excluded), json = DaemonRelayRules.data(rows) ?? Data()
        guard force || json != lastJSON || Date().timeIntervalSince(lastSent)*1000 >= Double(DaemonRelayPolicy.RELAY_SNAPSHOT_HEARTBEAT_MS) else { return }
        // Fingerprint/retain the private hold identity, so replacing an identical
        // question still refreshes its publication before commands are accepted.
        // Only the public projection leaves this worker.
        try await send(["type":"relay_sessions","sessions":DaemonRelayRules.nativeWireRows(rows)],ws:ws)
        guard valid(ticket,revision), socket === ws else { return }
        published = rows; lastJSON = json; lastSent = Date()
    }
    private func run(_ target: DaemonRelayTarget, epoch ticket: Int, revision: Int) async {
        var delay = DaemonRelayPolicy.RELAY_RECONNECT_INITIAL_MS
        while valid(ticket,revision) {
            var refused = false
            do {
                report("Connecting",revision)
                guard try await health(target) else { refused = true; throw URLError(.unsupportedURL) }
                guard valid(ticket,revision), let url = target.url(scheme:"ws") else { return }
                let config = URLSessionConfiguration.ephemeral
                config.httpCookieStorage = nil; config.urlCache = nil; config.urlCredentialStorage = nil
                // Keep the platform's persistent resource lifetime. Per-operation deadlines below.
                let session = URLSession(configuration:config,delegate:RelayNoRedirect(),delegateQueue:nil)
                self.session = session
                let ws = session.webSocketTask(with:url); ws.maximumMessageSize = DaemonRelayPolicy.RELAY_MAX_MESSAGE_BYTES
                socket = ws; ws.resume()
                try await send(["type":"relay_hello","v":DaemonRelayPolicy.RELAY_PROTOCOL_VERSION,"instanceId":instanceId,"host":host],ws:ws)
                let until = Date().addingTimeInterval(Double(DaemonRelayPolicy.RELAY_ACK_TIMEOUT_MS)/1000)
                while true {
                    let remaining = Int(until.timeIntervalSinceNow*1000)
                    guard remaining > 0 else { throw URLError(.timedOut) }
                    let frame = try await receive(ws,ms:remaining)
                    if frame["type"] as? String == "relay_refused" { refused = true; throw URLError(.userAuthenticationRequired) }
                    if frame["type"] as? String == "relay_ack" {
                        guard DaemonRelayRules.number(frame["v"]) == Double(DaemonRelayPolicy.RELAY_PROTOCOL_VERSION) else { refused = true; throw URLError(.unsupportedURL) }; break
                    }
                }
                guard valid(ticket,revision) else { return }
                report("Connected",revision); delay = DaemonRelayPolicy.RELAY_RECONNECT_INITIAL_MS
                try await push(ws,ticket:ticket,revision:revision,force:true)
                pushTask = Task { [weak self] in
                    while !Task.isCancelled {
                        try? await Task.sleep(for:.milliseconds(DaemonRelayPolicy.RELAY_POLL_MS))
                        guard let self, self.valid(ticket,revision), self.socket === ws else { return }
                        do { try await self.push(ws,ticket:ticket,revision:revision) } catch { ws.cancel(with:.goingAway,reason:nil); return }
                    }
                }
                pingTask = Task { [weak self] in
                    while !Task.isCancelled {
                        try? await Task.sleep(for:.milliseconds(DaemonRelayPolicy.RELAY_SNAPSHOT_HEARTBEAT_MS))
                        guard let self, self.valid(ticket,revision), self.socket === ws else { return }
                        let timer = self.deadline(ws,ms:DaemonRelayPolicy.RELAY_PONG_TIMEOUT_MS)
                        ws.sendPing { error in timer.cancel(); if error != nil { ws.cancel(with:.goingAway,reason:nil) } }
                    }
                }
                while valid(ticket,revision) {
                    // Pings have their own deadline. The roster stream may be quiet indefinitely.
                    let frame = try await ws.receive()
                    guard valid(ticket,revision), socket === ws else { return }
                    let data: Data
                    switch frame { case .data(let d): data = d; case .string(let s): data = Data(s.utf8); @unknown default: continue }
                    guard let json = try JSONSerialization.jsonObject(with:data) as? [String:Any], json["type"] as? String == "relay_command_down" else { continue }
                    if let accepted = DaemonRelayRules.nativeCommand(json["command"],published:published,current:current()) { execute(accepted) }
                    else { try await send(["type":"relay_command_refused","reason":"unsupported_or_stale_command"],ws:ws) }
                }
            } catch { if socket?.closeCode.rawValue == 4001 || [401,403].contains((socket?.response as? HTTPURLResponse)?.statusCode ?? 0) { refused = true } }
            guard valid(ticket,revision) else { return }
            dispose(); report(refused ? "Refused; check target, token and capability" : "Disconnected; retrying",revision)
            try? await Task.sleep(for:.milliseconds(refused ? DaemonRelayPolicy.RELAY_REFUSED_RETRY_MS : delay))
            delay = min(delay*2,DaemonRelayPolicy.RELAY_RECONNECT_MAX_MS)
        }
    }
}
#endif
