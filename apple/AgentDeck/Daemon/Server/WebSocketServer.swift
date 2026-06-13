#if os(macOS)
// WebSocketServer.swift — Unified HTTP + WebSocket server on a single port
// Raw TCP listener with protocol detection: WS upgrade or plain HTTP

import Foundation
import Network
import CryptoKit

/// A unified server handling both HTTP requests and WebSocket connections on one port.
/// Also advertises Bonjour service for mDNS discovery.
actor WebSocketServer {
    private var listener: NWListener?
    private var connections = Set<WebSocketConnection>()
    private var broadcastHooks: [@Sendable (Data) -> Void] = []

    var onCommand: (@Sendable ([String: Any], WebSocketConnection) -> Void)?
    var onClientConnect: (@Sendable (WebSocketConnection) -> Void)?
    var onClientDisconnect: (@Sendable (WebSocketConnection) -> Void)?
    var onListenerFailed: (@Sendable (Error) -> Void)?

    var clientCount: Int { connections.count }
    private var externalClientCountProvider: (@Sendable () async -> Int)?

    func setExternalClientCountProvider(_ provider: @escaping @Sendable () async -> Int) {
        externalClientCountProvider = provider
    }

    /// Total client count including external connections (ESP32 serial)
    func hasClients() async -> Bool {
        if !connections.isEmpty { return true }
        if let provider = externalClientCountProvider {
            return await provider() > 0
        }
        return false
    }

    // HTTP handler delegation
    private var httpHandler: HTTPServer?

    // Bonjour service
    private var bonjourService: NWListener.Service?

    func setCommandHandler(_ handler: @escaping @Sendable ([String: Any], WebSocketConnection) -> Void) {
        onCommand = handler
    }
    func setConnectHandler(_ handler: @escaping @Sendable (WebSocketConnection) -> Void) {
        onClientConnect = handler
    }
    func setDisconnectHandler(_ handler: @escaping @Sendable (WebSocketConnection) -> Void) {
        onClientDisconnect = handler
    }
    func setListenerFailedHandler(_ handler: @escaping @Sendable (Error) -> Void) {
        onListenerFailed = handler
    }

    /// Set the HTTP server to delegate plain HTTP requests to
    func setHTTPHandler(_ handler: HTTPServer) {
        self.httpHandler = handler
    }

    /// Set Bonjour service for mDNS advertisement (call before start)
    func setBonjourService(_ service: NWListener.Service) {
        self.bonjourService = service
    }

    /// Re-advertise Bonjour service after system wake (mDNSResponder may have stale state)
    func republishBonjour() {
        guard let listener, let service = bonjourService else { return }
        DaemonLogger.shared.info("Re-publishing Bonjour service after wake")
        listener.service = nil
        // Brief delay then re-set with retry logic
        Task {
            try? await Task.sleep(for: .milliseconds(500))
            self.listener?.service = service

            // Verify and retry with exponential backoff (1s, 2s, 4s)
            let retryDelays: [UInt64] = [1, 2, 4]
            for (attempt, delaySec) in retryDelays.enumerated() {
                try? await Task.sleep(for: .seconds(1))
                if self.listener?.service != nil {
                    DaemonLogger.shared.debug("mDNS", "Bonjour service re-registered")
                    return
                }
                DaemonLogger.shared.debug("mDNS", "Bonjour re-publish retry \(attempt + 1)/\(retryDelays.count)")
                try? await Task.sleep(for: .seconds(delaySec))
                self.listener?.service = service
            }

            // Final check
            try? await Task.sleep(for: .seconds(1))
            if self.listener?.service != nil {
                DaemonLogger.shared.debug("mDNS", "Bonjour service re-registered after retry")
            } else {
                DaemonLogger.shared.error("Bonjour service re-publish failed after \(retryDelays.count) retries")
            }
        }
    }

    // MARK: - Lifecycle

    /// Start the listener and wait until it reaches `.ready` (success) or `.failed`/`.cancelled` (throws).
    /// The `stateUpdateHandler` stays installed so post-bind failures still route to `onListenerFailed`.
    func start(port: UInt16) async throws {
        let params = NWParameters.tcp  // Raw TCP — no WebSocket protocol layer
        params.allowLocalEndpointReuse = true  // SO_REUSEADDR — allows rebind after TIME_WAIT/crash
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(domain: "WebSocketServer", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid port \(port)"])
        }
        let listener = try NWListener(using: params, on: nwPort)
        self.listener = listener

        // Attach Bonjour service for mDNS discovery
        if let service = bonjourService {
            listener.service = service
        }

        let failedHandler = onListenerFailed
        // stateUpdateHandler fires on .main queue; ResumeGate is only touched there.
        let gate = ResumeGate()
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if gate.tryResume() {
                        DaemonLogger.shared.info("Server listening on port \(port) (HTTP + WebSocket + mDNS)")
                        cont.resume()
                    }
                case .failed(let error):
                    DaemonLogger.shared.error("Server listener failed: \(error)")
                    if gate.tryResume() {
                        cont.resume(throwing: error)
                    } else {
                        // Post-bind failure — route to external handler for teardown/retry.
                        failedHandler?(error)
                    }
                case .cancelled:
                    if gate.tryResume() {
                        cont.resume(throwing: WebSocketServerError.listenerCancelled)
                    }
                default:
                    break
                }
            }

            listener.newConnectionHandler = { [weak self] nwConn in
                Task { await self?.handleNewConnection(nwConn) }
            }

            listener.start(queue: .main)
        }
    }

    func stop() {
        listener?.cancel()
        for conn in connections {
            conn.close()
        }
        connections.removeAll()
    }

    // MARK: - Connection Detection

    private func handleNewConnection(_ nwConn: NWConnection) {
        nwConn.start(queue: .main)

        // Read the first bytes, then finish the HTTP request framing before
        // protocol detection. Codex OTel POSTs can be hundreds of KB; handing
        // only the first 65 KB to HTTPServer truncates JSON bodies. WebSocket
        // upgrades are still HTTP requests with no body, so this also handles
        // split upgrade headers correctly.
        nwConn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, error in
            guard let data, error == nil else {
                nwConn.cancel()
                return
            }
            HTTPServer.receiveFullRequest(on: nwConn, accumulated: data) { [weak self] requestData in
                guard let requestData else {
                    nwConn.cancel()
                    return
                }
                Task {
                    guard let self else { return }
                    if Self.isWebSocketUpgrade(requestData) {
                        await self.handleWebSocketUpgrade(nwConn, requestData: requestData)
                    } else {
                        await self.handleHTTPRequest(nwConn, data: requestData)
                    }
                }
            }
        }
    }

    private static func isWebSocketUpgrade(_ data: Data) -> Bool {
        guard let text = String(data: data, encoding: .utf8) else { return false }
        return text.range(of: "upgrade: websocket", options: .caseInsensitive) != nil
    }

    /// Format an NWEndpoint as "host:port" for logging. Distinguishes local (127.0.0.1/::1)
    /// from LAN clients so we can tell at a glance whether iPad/iPhone is actually connecting.
    private static func describeRemote(_ endpoint: NWEndpoint) -> String {
        switch endpoint {
        case .hostPort(let host, let port):
            switch host {
            case .ipv4(let addr): return "\(addr):\(port.rawValue)"
            case .ipv6(let addr): return "[\(addr)]:\(port.rawValue)"
            case .name(let name, _): return "\(name):\(port.rawValue)"
            @unknown default: return "\(host):\(port.rawValue)"
            }
        default:
            return "\(endpoint)"
        }
    }

    // MARK: - WebSocket Upgrade

    private func handleWebSocketUpgrade(_ nwConn: NWConnection, requestData: Data) {
        guard let text = String(data: requestData, encoding: .utf8) else {
            nwConn.cancel()
            return
        }

        // Extract Sec-WebSocket-Key
        var wsKey: String?
        for line in text.components(separatedBy: "\r\n") {
            if line.lowercased().hasPrefix("sec-websocket-key:") {
                wsKey = String(line.dropFirst("sec-websocket-key:".count)).trimmingCharacters(in: .whitespaces)
                break
            }
        }

        guard let key = wsKey else {
            nwConn.cancel()
            return
        }

        // Compute accept key (RFC 6455)
        let magic = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        let hash = Insecure.SHA1.hash(data: Data(magic.utf8))
        let acceptKey = Data(hash).base64EncodedString()

        // Send 101 Switching Protocols
        let response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(acceptKey)\r\n\r\n"

        nwConn.send(content: Data(response.utf8), isComplete: false, completion: .contentProcessed({ [weak self] error in
            guard error == nil else {
                nwConn.cancel()
                return
            }
            Task { await self?.setupWebSocketConnection(nwConn) }
        }))
    }

    private func setupWebSocketConnection(_ nwConn: NWConnection) {
        let conn = WebSocketConnection(connection: nwConn)
        connections.insert(conn)
        let remote = Self.describeRemote(nwConn.endpoint)
        DaemonLogger.shared.info("WS: Client connected from \(remote) (\(connections.count) total)")

        conn.onMessage = { [weak self] data in
            let c = conn
            Task { await self?.handleMessage(data, from: c) }
        }

        conn.onClose = { [weak self] in
            let c = conn
            Task { await self?.handleDisconnect(c) }
        }

        conn.startReceiveLoop()
        onClientConnect?(conn)
    }

    // MARK: - HTTP Request Handling

    private func handleHTTPRequest(_ nwConn: NWConnection, data: Data) async {
        guard let httpHandler else {
            // No HTTP handler — send 503
            let body = Data("{\"error\":\"no http handler\"}".utf8)
            let response = "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
            nwConn.send(content: Data(response.utf8) + body, completion: .contentProcessed({ _ in nwConn.cancel() }))
            return
        }

        let request = HTTPServer.parseHTTPRequest(data, remoteIP: nwConn.endpoint.debugDescription)
        _ = await httpHandler.handle(request, on: nwConn)
    }

    // MARK: - WebSocket Message Handling

    private func handleMessage(_ data: Data, from conn: WebSocketConnection) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        DaemonLogger.shared.debug("WS", "recv cmd: \(json["type"] as? String ?? "unknown")")
        onCommand?(json, conn)
    }

    private func handleDisconnect(_ conn: WebSocketConnection) {
        connections.remove(conn)
        DaemonLogger.shared.debug("WS", "Client disconnected (\(connections.count) remaining)")
        onClientDisconnect?(conn)
    }

    // MARK: - Broadcast

    func broadcast(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
        for conn in connections {
            conn.send(data)
        }
        for hook in broadcastHooks {
            hook(data)
        }
    }

    func broadcastRaw(_ data: Data) {
        for conn in connections {
            conn.send(data)
        }
        for hook in broadcastHooks {
            hook(data)
        }
    }

    func sendTo(_ conn: WebSocketConnection, event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
        conn.send(data)
    }

    func onBroadcast(_ hook: @escaping @Sendable (Data) -> Void) {
        broadcastHooks.append(hook)
    }
}

// MARK: - WebSocketConnection (manual frame handling)

final class WebSocketConnection: Hashable, Sendable {
    let id = UUID()
    private let connection: NWConnection
    private let frameParser = WebSocketFrameParser()

    nonisolated(unsafe) var onMessage: (@Sendable (Data) -> Void)?
    nonisolated(unsafe) var onClose: (@Sendable () -> Void)?

    /// Lock-protected "this connection is gone" flag. Set synchronously
    /// inside the receive callback (before scheduling any onMessage /
    /// onClose Tasks) the moment we detect close. Read by the daemon's
    /// `handleClientRegister` to refuse a registration whose
    /// originating WS has already FINned — without this, Swift
    /// concurrency does not guarantee that `onMessage` Tasks (queued
    /// before the close) run before `onClose` Tasks on MainActor, so a
    /// `client_register` bundled with FIN can land on `cachedStreamDeck`
    /// after `handleClientDisconnect` already swept past, leaving the
    /// row stuck until the 120 s TTL.
    private let disconnectedLock = NSLock()
    nonisolated(unsafe) private var _disconnected = false

    /// Backpressure: frames handed to NWConnection whose `contentProcessed`
    /// completion hasn't fired yet. A slow-but-alive peer (suspended iOS
    /// app, flaky WiFi) never surfaces a send error, so without a cap every
    /// broadcast would pile into NWConnection's internal buffer unbounded.
    /// Dropping data frames at the cap is safe for this protocol: every
    /// broadcast (sessions_list / state_update / usage / timeline upsert
    /// follow-ups) is a full snapshot, so the next delivered frame restores
    /// consistency. Close/pong frames bypass `send` and are never dropped.
    private let sendLock = NSLock()
    nonisolated(unsafe) private var _inFlightSends = 0
    private static let maxInFlightSends = 64

    var isDisconnected: Bool {
        disconnectedLock.lock()
        defer { disconnectedLock.unlock() }
        return _disconnected
    }

    func markDisconnected() {
        disconnectedLock.lock()
        defer { disconnectedLock.unlock() }
        _disconnected = true
    }

    init(connection: NWConnection) {
        self.connection = connection
    }

    func startReceiveLoop() {
        receiveLoop()
    }

    private func receiveLoop() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] content, _, isComplete, error in
            guard let self else { return }
            if let error {
                DaemonLogger.shared.debug("WS", "Receive error: \(error)")
                // Mark before scheduling onClose Task so any already-
                // queued onMessage Task (e.g. a client_register frame
                // that arrived with the same packet) sees the closed
                // state when it eventually runs on MainActor — even if
                // Swift schedules the disconnect Task after it.
                self.markDisconnected()
                self.onClose?()
                return
            }

            if let content {
                let frames = self.frameParser.feed(content)
                for (opcode, payload) in frames {
                    switch opcode {
                    case 0x1, 0x2: // text, binary
                        self.onMessage?(payload)
                    case 0x8: // close
                        let closeFrame = Self.buildFrame(opcode: 0x8, payload: payload.prefix(2))
                        self.connection.send(content: closeFrame, completion: .contentProcessed({ _ in
                            self.connection.cancel()
                        }))
                        self.markDisconnected()
                        self.onClose?()
                        return
                    case 0x9: // ping → pong
                        let pongFrame = Self.buildFrame(opcode: 0xA, payload: payload)
                        self.connection.send(content: pongFrame, isComplete: false, completion: .contentProcessed({ _ in }))
                    default:
                        break // pong, continuation, etc.
                    }
                }
            }

            // Peer FINned the TCP stream (kill -9, ws.terminate(),
            // process crash, machine sleep) without sending a 0x8 WS
            // close frame. Without this branch the loop would recurse
            // forever on (nil, _, true, nil) and onClose would never
            // fire — leaving cachedStreamDeck stuck until the 120 s
            // TTL. Checked AFTER frame processing so a final FIN
            // bundled with data (Network.framework can present both in
            // one callback) doesn't drop the trailing payload, and
            // markDisconnected runs BEFORE firing onClose so a
            // `client_register` Task queued earlier in this same
            // callback observes the closed state when it lands on
            // MainActor.
            if isComplete {
                DaemonLogger.shared.debug("WS", "Receive: peer FIN (no close frame)")
                self.markDisconnected()
                self.onClose?()
                return
            }

            self.receiveLoop()
        }
    }

    func send(_ data: Data) {
        sendLock.lock()
        if _inFlightSends >= Self.maxInFlightSends {
            sendLock.unlock()
            DaemonLogger.shared.debug("WS", "Send queue saturated (\(Self.maxInFlightSends) in flight) — dropping frame for slow client \(id)")
            return
        }
        _inFlightSends += 1
        sendLock.unlock()

        let frame = Self.buildFrame(opcode: 0x1, payload: data)
        // isComplete: false — on NWConnection/TCP, isComplete: true signals
        // end-of-stream (FIN). Setting it per-frame half-closes the send side
        // after the first outbound WS message, which races with the client's
        // ping/receive timers and manifests as a ~15s reconnect loop.
        connection.send(content: frame, isComplete: false, completion: .contentProcessed({ [weak self] error in
            guard let self else { return }
            self.sendLock.lock()
            self._inFlightSends -= 1
            self.sendLock.unlock()
            if let error = error {
                DaemonLogger.shared.debug("WS", "Send error: \(error)")
                self.markDisconnected()
                self.onClose?()
            }
        }))
    }

    func close() {
        let closeFrame = Self.buildFrame(opcode: 0x8, payload: Data())
        connection.send(content: closeFrame, completion: .contentProcessed({ [weak self] _ in
            self?.connection.cancel()
        }))
    }

    // MARK: - Frame Building (server → client: no mask)

    static func buildFrame(opcode: UInt8, payload: Data) -> Data {
        var frame = Data()
        frame.append(0x80 | opcode) // FIN + opcode

        if payload.count < 126 {
            frame.append(UInt8(payload.count))
        } else if payload.count < 65536 {
            frame.append(126)
            frame.append(UInt8((payload.count >> 8) & 0xFF))
            frame.append(UInt8(payload.count & 0xFF))
        } else {
            frame.append(127)
            for i in (0..<8).reversed() {
                frame.append(UInt8((payload.count >> (i * 8)) & 0xFF))
            }
        }

        frame.append(payload)
        return frame
    }

    // Hashable
    static func == (lhs: WebSocketConnection, rhs: WebSocketConnection) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

// MARK: - WebSocket Frame Parser (client → server: masked)

final class WebSocketFrameParser: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()

    /// Feed raw TCP data, returns parsed frames as (opcode, payload)
    func feed(_ data: Data) -> [(UInt8, Data)] {
        lock.lock()
        defer { lock.unlock() }

        buffer.append(data)
        var frames: [(UInt8, Data)] = []

        while true {
            guard buffer.count >= 2 else { break }

            let byte0 = buffer[buffer.startIndex]
            let byte1 = buffer[buffer.startIndex + 1]
            let opcode = byte0 & 0x0F
            let masked = (byte1 & 0x80) != 0
            var payloadLen = UInt64(byte1 & 0x7F)
            var headerLen = 2

            if payloadLen == 126 {
                guard buffer.count >= 4 else { break }
                payloadLen = UInt64(buffer[buffer.startIndex + 2]) << 8
                    | UInt64(buffer[buffer.startIndex + 3])
                headerLen = 4
            } else if payloadLen == 127 {
                guard buffer.count >= 10 else { break }
                payloadLen = 0
                for i in 0..<8 {
                    payloadLen = (payloadLen << 8) | UInt64(buffer[buffer.startIndex + 2 + i])
                }
                headerLen = 10
            }

            let maskLen = masked ? 4 : 0
            let totalLen = headerLen + maskLen + Int(payloadLen)
            guard buffer.count >= totalLen else { break }

            let maskStart = buffer.startIndex + headerLen
            let payloadStart = maskStart + maskLen
            var payload = Data(buffer[payloadStart..<(payloadStart + Int(payloadLen))])

            if masked {
                let maskKey = buffer[maskStart..<(maskStart + 4)]
                for i in 0..<payload.count {
                    payload[payload.startIndex + i] ^= maskKey[maskKey.startIndex + (i % 4)]
                }
            }

            frames.append((opcode, payload))
            buffer.removeFirst(totalLen)
        }

        return frames
    }
}

enum WebSocketServerError: Error {
    case listenerCancelled
}

/// Single-use gate used from the listener's stateUpdateHandler to ensure the
/// bind continuation is resumed at most once. Class-typed so it can be captured
/// by the @Sendable state closure without triggering capture-of-mutable-var errors.
final class ResumeGate: @unchecked Sendable {
    private var done = false
    func tryResume() -> Bool {
        if done { return false }
        done = true
        return true
    }
}
#endif
