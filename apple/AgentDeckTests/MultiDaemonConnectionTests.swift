#if os(macOS)
import XCTest
import Network
import CryptoKit
import Combine
@testable import AgentDeck

/// Real loopback handshakes exercise URLSession's two refusal shapes, including
/// the close code that disappeared when teardown ran before classification.
final class MultiDaemonConnectionTests: XCTestCase {
    @MainActor
    func testInitialRefusalRetriesBeforeMainQueueCanPublishConnectionState() throws {
        let ready = expectation(description: "listener ready")
        let request = DispatchSemaphore(value: 0)
        let server = try RefusalServer(code: 503, requestSeen: { request.signal() }) { ready.fulfill() }
        defer { server.stop() }
        wait(for: [ready], timeout: 5)
        let connection = BridgeConnection()
        defer { connection.prepareForTermination() }
        connection.connect(to: "ws://127.0.0.1:\(try XCTUnwrap(server.port))")

        // Deliberately hold the main queue: the peer can refuse the handshake
        // before the queued @Published URL/status have reached the UI.
        XCTAssertEqual(request.wait(timeout: .now() + 8), .success)
        XCTAssertNil(connection.url, "Exercise the unpublished initial endpoint")
        XCTAssertEqual(request.wait(timeout: .now() + 8), .success,
                       "The transport must retry without waiting for main-queue publication")
    }

    func testFreshConnectDuringOldRetryRearmsAutomaticRetries() throws {
        let ready = expectation(description: "busy listener ready")
        let server = try RefusalServer(code: 503) { ready.fulfill() }
        defer { server.stop() }
        wait(for: [ready], timeout: 5)
        let connection = BridgeConnection()
        defer { connection.prepareForTermination() }
        let retrying = expectation(description: "initial attempt entered retry")
        let subscription = connection.$isReconnecting.first(where: { $0 }).sink { _ in retrying.fulfill() }
        defer { subscription.cancel() }
        let url = "ws://127.0.0.1:\(try XCTUnwrap(server.port))"
        connection.connect(to: url)
        wait(for: [retrying], timeout: 8)
        let initialRequests = server.requests
        connection.disconnect()
        connection.connect(to: url)
        let settled = expectation(description: "fresh attempt also retries its first failure")
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { settled.fulfill() }
        wait(for: [settled], timeout: 7)
        XCTAssertGreaterThanOrEqual(server.requests, initialRequests + 2)
    }

    func testHTTP401StopsAndExplicitRetryWorks() throws { try refusal(401) }
    func testWebSocket4001StopsAndExplicitRetryWorks() throws { try refusal(4001) }

    private func refusal(_ code: Int) throws {
        let ready = expectation(description: "listener ready")
        let server = try RefusalServer(code: code) { ready.fulfill() }
        defer { server.stop() }
        wait(for: [ready], timeout: 5)
        let url = "ws://127.0.0.1:\(try XCTUnwrap(server.port))"
        let connection = BridgeConnection()
        defer { connection.prepareForTermination() }
        let refused = expectation(description: "authentication required")
        connection.onAuthenticationRequired = { refused.fulfill() }
        connection.connect(to: url)
        wait(for: [refused], timeout: 8)
        XCTAssertEqual(connection.authenticationRequiredURL, url)
        XCTAssertEqual(connection.status, .disconnected)
        XCTAssertFalse(connection.isReconnecting)
        XCTAssertTrue(connection.lastError?.contains("127.0.0.1:") == true)
        XCTAssertTrue(connection.lastError?.contains("Devices › Pair Device") == true)
        let settled = expectation(description: "no automatic retry")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) { settled.fulfill() }
        wait(for: [settled], timeout: 3)
        XCTAssertEqual(server.requests, 1)
        server.approve()
        let connected = expectation(description: "explicit retry succeeds after approval")
        connection.onEvent = { event in
            if case .connection(let state) = event, state.status == "connected" { connected.fulfill() }
        }
        connection.connect(to: url)
        wait(for: [connected], timeout: 8)
        XCTAssertEqual(server.requests, 2)
        XCTAssertEqual(connection.status, .connected)
        XCTAssertNil(connection.authenticationRequiredURL)
        XCTAssertNil(connection.lastError)
    }
    #if DEBUG
    func testSavedHostIsDialedWhenOnlyOtherHostIsDiscovered() throws {
        let ready = expectation(description: "listener ready")
        let server = try RefusalServer(code: 401) { ready.fulfill() }
        defer { server.stop() }
        wait(for: [ready], timeout: 5)
        server.approve()
        let url = "ws://127.0.0.1:\(try XCTUnwrap(server.port))"
        let old = UserDefaults.standard.string(forKey: "lastBridgeUrl")
        UserDefaults.standard.set(url, forKey: "lastBridgeUrl")
        defer { UserDefaults.standard.set(old, forKey: "lastBridgeUrl") }
        let holder = AgentStateHolder()
        holder.discovery.isBrowserEnabled = false
        defer { holder.prepareForTermination() }
        holder.discovery.publishForTesting([DiscoveredBridge(name: "other-host", host: "192.0.2.10", port: 9120, token: nil, agentType: "daemon")])
        holder.startConnectionWaterfall()
        let settled = expectation(description: "saved URL fallback window")
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { settled.fulfill() }
        wait(for: [settled], timeout: 9)
        XCTAssertGreaterThan(server.requests, 0, "A different mDNS host must not suppress dialing the saved endpoint")
    }

    func testSelectedHostRecoversAfterRetryExhaustion() throws {
        let ready = expectation(description: "listener ready")
        let server = try RefusalServer(code: 401) { ready.fulfill() }
        defer { server.stop() }
        wait(for: [ready], timeout: 5)
        server.approve()
        let url = "ws://127.0.0.1:\(try XCTUnwrap(server.port))"
        let old = UserDefaults.standard.string(forKey: "lastBridgeUrl")
        UserDefaults.standard.set(url, forKey: "lastBridgeUrl")
        defer { UserDefaults.standard.set(old, forKey: "lastBridgeUrl") }
        let holder = AgentStateHolder()
        holder.discovery.isBrowserEnabled = false
        defer { holder.prepareForTermination() }
        holder.connection.onReconnectExhausted?(url)
        holder.discovery.publishForTesting([
            DiscoveredBridge(name: "unrelated", host: "192.0.2.10", port: 9120, token: nil, agentType: "daemon"),
            DiscoveredBridge(name: "selected-host-returned", host: "127.0.0.1", port: Int(try XCTUnwrap(server.port)), token: nil, agentType: "daemon")])
        let settled = expectation(description: "passive discovery delivery")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { settled.fulfill() }
        wait(for: [settled], timeout: 4)
        XCTAssertGreaterThan(server.requests, 0, "Retry exhaustion must not be treated as a user stop when the selected host returns")
    }

    func testPreferredLocalHostRecoversAfterRetryExhaustion() throws {
        let ready = expectation(description: "local listener ready")
        let server = try RefusalServer(code: 401) { ready.fulfill() }
        defer { server.stop() }
        wait(for: [ready], timeout: 5)
        server.approve()
        let port = Int(try XCTUnwrap(server.port))
        let old = UserDefaults.standard.string(forKey: "lastBridgeUrl")
        defer { UserDefaults.standard.set(old, forKey: "lastBridgeUrl") }
        let holder = AgentStateHolder()
        holder.discovery.isBrowserEnabled = false
        defer { holder.prepareForTermination() }
        let initial = expectation(description: "preferred local endpoint connected")
        let handle = holder.connection.onEvent
        holder.connection.onEvent = { event in
            handle?(event)
            if case .connection(let state) = event, state.status == "connected" { initial.fulfill() }
        }
        let url = "ws://127.0.0.1:\(port)"
        holder.setPreferredLocalBridge(url: url)
        wait(for: [initial], timeout: 8)
        holder.connection.onEvent = handle
        let requests = server.requests
        holder.connection.disconnect()
        holder.handleEvent(.connection(ConnectionEvent(type: "connection", status: "disconnected")))
        let disconnected = expectation(description: "socket teardown delivered")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { disconnected.fulfill() }
        wait(for: [disconnected], timeout: 3)
        holder.connection.onReconnectExhausted?(url)
        holder.schedulePreferredLocalRecovery(after: 0.01)
        let settled = expectation(description: "local recovery retry delivered")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { settled.fulfill() }
        wait(for: [settled], timeout: 4)
        XCTAssertGreaterThan(server.requests, requests, "A preferred loopback endpoint must recover even without a matching Bonjour LAN address")
        let recoveredRequests = server.requests
        holder.stopConnectionAttempts()
        holder.schedulePreferredLocalRecovery(after: 0.01)
        let stopped = expectation(description: "explicit stop remains in force")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { stopped.fulfill() }
        wait(for: [stopped], timeout: 3)
        XCTAssertEqual(server.requests, recoveredRequests)
    }

    func testDiscoveryDoesNotUndoExplicitStop() throws { try assertDiscoveryRemainsStopped(auth: false) }
    func testDiscoveryDoesNotRetryAnAuthenticationRefusal() throws { try assertDiscoveryRemainsStopped(auth: true) }

    private func assertDiscoveryRemainsStopped(auth: Bool) throws {
        let ready = expectation(description: "listener ready")
        let server = try RefusalServer(code: 401) { ready.fulfill() }
        defer { server.stop() }
        wait(for: [ready], timeout: 5)
        let old = UserDefaults.standard.string(forKey: "lastBridgeUrl")
        let url = "ws://127.0.0.1:\(try XCTUnwrap(server.port))"
        UserDefaults.standard.set(url, forKey: "lastBridgeUrl")
        defer { UserDefaults.standard.set(old, forKey: "lastBridgeUrl") }
        let holder = AgentStateHolder()
        holder.discovery.isBrowserEnabled = false
        defer { holder.prepareForTermination() }
        if auth { holder.connection.onAuthenticationRequired?() }
        else { holder.stopConnectionAttempts() }
        holder.discovery.publishForTesting([DiscoveredBridge(name: "selected", host: "127.0.0.1", port: Int(try XCTUnwrap(server.port)), token: nil, agentType: "daemon")])
        let settled = expectation(description: "discovery delivered")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { settled.fulfill() }
        wait(for: [settled], timeout: 3)
        XCTAssertEqual(server.requests, 0)
    }
    #endif

}

private final class RefusalServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "pairing-test-server")
    private let lock = NSLock()
    private var count = 0
    private var approved = false
    private let requestSeen: @Sendable () -> Void
    func approve() { lock.withLock { approved = true } }
    private var peers: [NWConnection] = []
    var requests: Int { lock.withLock { count } }
    var port: UInt16? { listener.port?.rawValue }

    init(code: Int, requestSeen: @escaping @Sendable () -> Void = {}, ready: @escaping @Sendable () -> Void) throws {
        self.requestSeen = requestSeen
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.stateUpdateHandler = { state in if case .ready = state { ready() } }
        listener.newConnectionHandler = { [weak self] peer in
            guard let self else { return }
            self.lock.withLock { self.peers.append(peer) }
            peer.start(queue: self.queue)
            self.read(peer, code: code, accumulated: Data())
        }
        listener.start(queue: queue)
    }

    private func read(_ peer: NWConnection, code: Int, accumulated: Data) {
        peer.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] bytes, _, complete, error in
            guard let self, error == nil else { return }
            var request = accumulated
            request.append(bytes ?? Data())
            guard request.count < 16384 else { peer.cancel(); return }
            guard let text = String(data: request, encoding: .utf8), text.contains("\r\n\r\n") else {
                if !complete { self.read(peer, code: code, accumulated: request) }
                return
            }
            self.lock.withLock { self.count += 1 }
            self.requestSeen()
            let approved = self.lock.withLock { self.approved }
            if code < 4000 && !approved {
                peer.send(content: Data("HTTP/1.1 \(code) \(code == 401 ? "Unauthorized" : "Service Unavailable")\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8), completion: .contentProcessed { _ in peer.cancel() })
                return
            }
            let key = text.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("sec-websocket-key:") }?
                .split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces) ?? ""
            let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
            let header = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
            peer.send(content: Data(header.utf8), completion: .contentProcessed { _ in
                let payload = Data(#"{"type":"connection","status":"connected"}"#.utf8)
                let frame = approved ? Data([0x81, UInt8(payload.count)]) + payload : Data([0x88, 0x02, 0x0f, 0xa1])
                peer.send(content: frame, completion: .contentProcessed { _ in })
            })
        }
    }

    func stop() {
        listener.cancel()
        lock.withLock { peers.forEach { $0.cancel() } }
    }
}
#endif
