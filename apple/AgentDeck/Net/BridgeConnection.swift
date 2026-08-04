// BridgeConnection.swift — WebSocket connection to AgentDeck bridge
// Ported from android BridgeConnection.kt

import Foundation
import Combine

final class BridgeConnection: ObservableObject, @unchecked Sendable {
    private final class HealthCheckBox: @unchecked Sendable {
        private let lock = NSLock()
        private var completed = false

        func tryComplete() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard !completed else { return false }
            completed = true
            return true
        }
    }

    // MARK: - Constants

    private static let initialBackoffMs = 1000
    private static let maxBackoffMs = 8000
    private static let maxReconnectAttempts = 5
    // Keepalive cadence. The daemon (ws-server.ts) pings every 15s and evicts any
    // client that hasn't ponged within one 15s window, so we keep the path warm
    // well inside that budget: an 8s interval gives ~2x margin, and the first ping
    // fires shortly after connect (firstPingDelaySec) instead of a full interval
    // later so a stalled path is detected fast rather than ~15s late.
    private static let pingIntervalSec: TimeInterval = 8
    private static let firstPingDelaySec: TimeInterval = 2
    // A periodic keepalive ping that gets no pong within this window means the TCP
    // path silently stalled (cross-interface Wi-Fi/Ethernet glitch, sleep/wake) —
    // treat it as a dead socket and reconnect rather than waiting for the 60s
    // receive timeout (and long past the daemon's own 15s eviction).
    private static let pingTimeoutSec: TimeInterval = 5
    private static let healthCheckTimeoutSec: TimeInterval = 3
    private static let connectionTimeoutSec: TimeInterval = 5

    // MARK: - Observable State

    @Published private(set) var status: ConnectionStatus = .disconnected
    @Published private(set) var url: String?
    @Published private(set) var lastError: String?
    @Published private(set) var isReconnecting = false
    @Published private(set) var reconnectAttempt = 0

    // MARK: - Event callback

    var onEvent: ((BridgeEvent) -> Void)?

    /// Called when WebSocket disconnects (before reconnect attempts)
    var onDisconnect: (() -> Void)?

    /// Called when reconnect gives up — state holder can restart discovery.
    /// Carries the URL that failed, because this callback fires from the same
    /// main-queue block that clears `url`; reading `connection.url` from inside
    /// the handler always saw nil, so the caller's ghost-bridge blacklist never
    /// matched and a dead mDNS entry could be retried forever.
    var onReconnectExhausted: ((String?) -> Void)?

    /// Called before each reconnect attempt — return true to abort reconnect
    /// and let the caller take over (e.g. switch to a local session).
    var onReconnectAttempt: (() -> Bool)?

    // MARK: - Private

    private var webSocket: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var backoffMs = initialBackoffMs
    private var shouldReconnect = false
    private var pingSource: DispatchSourceTimer?
    private var reconnectWork: DispatchWorkItem?
    private var connectTimeoutWork: DispatchWorkItem?
    private let queue = DispatchQueue(label: "dev.agentdeck.bridge", qos: .userInitiated)
    private var hasReceivedMessage = false
    /// Incremented on disconnect(reconnect: false) to invalidate pending reconnect work
    private var connectionGeneration = 0
    /// Guard against concurrent handleDisconnect calls (ping callback + receive loop race)
    private var isHandlingDisconnect = false
    /// Permanent stop flag used during app termination. Once set, no reconnect
    /// work or late URLSession callback is allowed to revive the bridge.
    private var isTerminating = false

    enum ConnectionStatus: Sendable {
        case disconnected
        case connecting
        case connected
    }

    // MARK: - Connect

    func connect(to urlString: String) {
        queue.async { [weak self] in
            self?.connectInternal(urlString)
        }
    }

    private func connectInternal(_ urlString: String) {
        guard !isTerminating else { return }

        // Allow handleDisconnect to run again for this new connection
        isHandlingDisconnect = false

        // Clean up previous socket without resetting reconnect state
        let wasReconnecting = isReconnecting
        let savedAttempt = reconnectAttempt
        pingSource?.cancel()  // Already on queue — direct access safe
        pingSource = nil
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        connectTimeoutWork?.cancel()
        connectTimeoutWork = nil

        guard let wsUrl = URL(string: urlString) else {
            DispatchQueue.main.async { self.lastError = "Invalid URL: \(urlString)" }
            return
        }

        DispatchQueue.main.async {
            self.url = urlString
            self.status = .connecting
            self.lastError = nil
            self.hasReceivedMessage = false
            // Only enable shouldReconnect for fresh connections.
            // Reconnect-originated calls already have it set; re-setting it
            // would undo a concurrent disconnect(reconnect: false) call.
            if !wasReconnecting {
                self.shouldReconnect = true
            }
            // Preserve reconnecting state across reconnect attempts
            if wasReconnecting {
                self.isReconnecting = true
                self.reconnectAttempt = savedAttempt
            }
        }

        print("[BridgeConnection] connecting to \(urlString)")

        let config = URLSessionConfiguration.default
        // timeoutIntervalForRequest applies per outstanding URLSession receive
        // call for WebSocketTask. When no server push arrives within the window
        // the pending `ws.receive` fails with "Operation timed out" and we tear
        // the socket down. Must comfortably exceed `pingIntervalSec` (8s) so
        // ping/pong round-trips keep the connection alive between quiet periods.
        config.timeoutIntervalForRequest = 60
        #if os(iOS)
        // iOS: WiFi may not be ready on cold start — wait instead of failing immediately
        config.waitsForConnectivity = true
        #else
        // macOS: network is always up — fast failure enables quicker reconnect
        config.waitsForConnectivity = false
        // Half-open detection: abort reads that idle longer than this. Live sockets
        // produce traffic via pingIntervalSec so healthy connections never trip it;
        // after sleep/wake the dead socket fails within the window and reconnect fires.
        config.timeoutIntervalForResource = 120
        #endif
        let session = URLSession(configuration: config)
        self.urlSession = session
        let task = session.webSocketTask(with: wsUrl)

        // Half-open detection: idle timeout
        task.maximumMessageSize = 1_048_576  // 1MB

        self.webSocket = task
        task.resume()

        // Don't set .connected here — wait for first message in receiveLoop
        startPingTimerOnQueue()  // Already on queue
        receiveLoop()

        // Start connection timeout timer
        let connectionGen = self.connectionGeneration
        let timeoutWork = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.queue.async {
                guard self.connectionGeneration == connectionGen,
                      self.status == .connecting else { return }
                print("[BridgeConnection] connection attempt timed out (\(Self.connectionTimeoutSec)s)")
                self.handleDisconnect(error: URLError(.timedOut))
            }
        }
        self.connectTimeoutWork = timeoutWork
        self.queue.asyncAfter(deadline: .now() + Self.connectionTimeoutSec, execute: timeoutWork)
    }

    // MARK: - Disconnect

    func disconnect(reconnect: Bool = false) {
        guard !isTerminating else { return }
        shouldReconnect = reconnect
        reconnectWork?.cancel()
        reconnectWork = nil
        connectTimeoutWork?.cancel()
        connectTimeoutWork = nil
        isHandlingDisconnect = false  // Reset so future handleDisconnect can fire
        stopPingTimer()

        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil

        if !reconnect {
            // Bump generation so any in-flight reconnect work on queue sees stale gen
            connectionGeneration += 1
            DispatchQueue.main.async {
                self.status = .disconnected
                self.isReconnecting = false
                self.reconnectAttempt = 0
            }
        }
    }

    /// Stop all socket activity for process termination. This is intentionally
    /// stronger than disconnect(reconnect: false): it also blocks future
    /// connect() calls and stale URLSession callbacks from scheduling work.
    func prepareForTermination() {
        queue.async { [weak self] in
            guard let self else { return }
            self.isTerminating = true
            self.shouldReconnect = false
            self.connectionGeneration += 1
            self.reconnectWork?.cancel()
            self.reconnectWork = nil
            self.connectTimeoutWork?.cancel()
            self.connectTimeoutWork = nil
            self.isHandlingDisconnect = false
            self.hasReceivedMessage = false

            self.pingSource?.cancel()
            self.pingSource = nil
            self.webSocket?.cancel(with: .goingAway, reason: nil)
            self.webSocket = nil
            self.urlSession?.invalidateAndCancel()
            self.urlSession = nil

            DispatchQueue.main.async {
                self.status = .disconnected
                self.isReconnecting = false
                self.reconnectAttempt = 0
                self.shouldReconnect = false
            }
        }
    }

    // MARK: - Send Command

    func send(_ command: PluginCommand) {
        guard let ws = webSocket else { return }

        do {
            let data = try JSONEncoder().encode(command)
            guard let text = String(data: data, encoding: .utf8) else { return }
            ws.send(.string(text)) { error in
                if let error {
                    print("[BridgeConnection] Send error: \(error)")
                }
            }
        } catch {
            print("[BridgeConnection] Encode error: \(error)")
        }
    }

    // MARK: - Receive Loop

    private func receiveLoop() {
        guard let ws = webSocket else { return }

        ws.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard !self.isTerminating,
                      let currentSocket = self.webSocket,
                      currentSocket === ws else { return }
                self.handleReceiveResult(result)
            }
        }
    }

    private func handleReceiveResult(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        switch result {
        case .success(let message):
            // First successful message = connection confirmed
            if !hasReceivedMessage {
                hasReceivedMessage = true
                print("[BridgeConnection] first message received — connected!")
                self.connectTimeoutWork?.cancel()
                self.connectTimeoutWork = nil
                DispatchQueue.main.async {
                    self.status = .connected
                    self.backoffMs = Self.initialBackoffMs
                    self.reconnectAttempt = 0
                    self.isReconnecting = false
                }
            }

            switch message {
            case .string(let text):
                dispatchInbound(text)
            case .data(let data):
                if let text = String(data: data, encoding: .utf8) {
                    dispatchInbound(text)
                }
            @unknown default:
                break
            }
            // Continue receiving
            receiveLoop()

        case .failure(let error):
            print("[BridgeConnection] Receive error: \(error.localizedDescription)")
            handleDisconnect(error: error)
        }
    }

    /// Decode one inbound text frame to a typed `BridgeEvent` and deliver it to
    /// `onEvent` on the main queue.
    private func dispatchInbound(_ text: String) {
        if let event = BridgeEventParser.parse(text) {
            DispatchQueue.main.async { self.onEvent?(event) }
        }
    }

    // MARK: - Ping

    func startPingTimer() {
        queue.async { [weak self] in
            self?.startPingTimerOnQueue()
        }
    }

    /// Cancel ping timer immediately. DispatchSource.cancel() is thread-safe,
    /// so this is safe to call from any thread (including disconnect()).
    func stopPingTimer() {
        pingSource?.cancel()
    }

    /// Start ping timer — must be called on `queue`
    private func startPingTimerOnQueue() {
        guard !isTerminating else { return }
        pingSource?.cancel()
        pingSource = nil
        let source = DispatchSource.makeTimerSource(queue: queue)
        // First ping fires firstPingDelaySec after connect (not a full interval
        // later); ±jitter via leeway avoids many clients pinging in lockstep.
        source.schedule(deadline: .now() + Self.firstPingDelaySec,
                        repeating: Self.pingIntervalSec,
                        leeway: .milliseconds(750))
        source.setEventHandler { [weak self] in
            guard let owner = self else { return }
            guard !owner.isTerminating else { return }
            owner.sendKeepalivePing()
        }
        source.resume()
        pingSource = source
    }

    /// One keepalive ping with an explicit timeout. `URLSessionWebSocketTask`'s
    /// `sendPing` completion only fires on success or a hard error — on a silently
    /// stalled path the pong may never arrive and the completion can hang well past
    /// the daemon's 15s eviction window. We bound it ourselves: no pong within
    /// `pingTimeoutSec` is treated as a dead socket and triggers reconnect.
    /// Must be called on `queue`.
    private func sendKeepalivePing() {
        guard !isTerminating, let ws = webSocket else { return }
        let box = HealthCheckBox()
        ws.sendPing { [weak self] error in
            // tryComplete() first so a received pong cancels the pending timeout
            // even when there's no error to act on.
            guard let self, box.tryComplete(), let error else { return }
            self.queue.async {
                guard !self.isTerminating, self.webSocket === ws else { return }
                print("[BridgeConnection] Ping failed: \(error)")
                self.handleDisconnect(error: error)
            }
        }
        queue.asyncAfter(deadline: .now() + Self.pingTimeoutSec) { [weak self] in
            guard let self, box.tryComplete() else { return }
            guard !self.isTerminating, self.webSocket === ws else { return }
            print("[BridgeConnection] keepalive ping timed out (\(Self.pingTimeoutSec)s) — reconnecting")
            self.handleDisconnect(error: URLError(.timedOut))
        }
    }

    // MARK: - Health Check & Force Reconnect

    /// Send an immediate ping with a short timeout to check if the socket is alive.
    func forceHealthCheck(completion: @escaping @Sendable (Bool) -> Void) {
        guard let ws = webSocket else {
            completion(false)
            return
        }

        let box = HealthCheckBox()

        ws.sendPing { error in
            guard box.tryComplete() else { return }
            DispatchQueue.main.async { completion(error == nil) }
        }

        // Timeout
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.healthCheckTimeoutSec) {
            guard box.tryComplete() else { return }
            print("[BridgeConnection] health check timed out")
            DispatchQueue.main.async { completion(false) }
        }
    }

    /// Tear down the socket without triggering reconnect. Caller is responsible for restarting.
    func forceDisconnectAndRestart() {
        disconnect(reconnect: false)
    }

    /// Reset reconnect counter (e.g. after foreground return).
    func resetReconnectCount() {
        reconnectAttempt = 0
        backoffMs = Self.initialBackoffMs
    }

    // MARK: - Reconnect

    private func handleDisconnect(error: Error? = nil) {
        // Serialize on queue to prevent concurrent calls (ping callback + receive loop race).
        // isHandlingDisconnect stays true until connectInternal resets it —
        // this prevents the second error callback (ping + receive loop both fire when
        // bridge dies) from scheduling a duplicate reconnect.
        queue.async { [weak self] in
            guard let self, !self.isTerminating, !self.isHandlingDisconnect else { return }
            self.isHandlingDisconnect = true

            self.pingSource?.cancel()
            self.pingSource = nil
            self.webSocket?.cancel(with: .goingAway, reason: nil)
            self.webSocket = nil
            self.connectTimeoutWork?.cancel()
            self.connectTimeoutWork = nil

            let wasConnected = self.hasReceivedMessage
            self.hasReceivedMessage = false

            // Notify state holder immediately so UI shows disconnect
            if wasConnected {
                DispatchQueue.main.async { self.onDisconnect?() }
            }

            // Check for auth rejection (4001)
            if let urlError = error as? URLError,
               urlError.code == .userAuthenticationRequired {
                self.isHandlingDisconnect = false  // No reconnect will follow
                DispatchQueue.main.async {
                    self.status = .disconnected
                    self.lastError = "Unauthorized — check pairing token"
                    self.shouldReconnect = false
                    self.isReconnecting = false
                }
                return
            }

            guard self.shouldReconnect, self.url != nil else {
                self.isHandlingDisconnect = false  // No reconnect will follow
                DispatchQueue.main.async {
                    self.status = .disconnected
                }
                return
            }

            // Give up after max attempts. Each reconnect attempt first consults
            // onReconnectAttempt, which re-resolves mDNS and switches to a freshly
            // discovered bridge URL if one surfaced — so this cap bounds retries
            // against a single stale/unreachable cached IP before the waterfall
            // restarts discovery from scratch.
            let maxAttempts = Self.maxReconnectAttempts
            if self.reconnectAttempt >= maxAttempts {
                self.isHandlingDisconnect = false  // No reconnect will follow
                let failedUrl = self.url
                DispatchQueue.main.async {
                    self.status = .disconnected
                    self.url = nil
                    self.isReconnecting = false
                    self.shouldReconnect = false
                    self.lastError = wasConnected
                        ? "Bridge disconnected"
                        : "Connection failed"
                    self.onReconnectExhausted?(failedUrl)
                }
                return
            }

            DispatchQueue.main.async {
                self.status = .disconnected
                self.isReconnecting = true
                self.reconnectAttempt += 1
            }

            // Let caller short-circuit reconnect (e.g. macOS local session found)
            if let check = self.onReconnectAttempt, check() {
                self.isHandlingDisconnect = false  // Caller takes over connection
                DispatchQueue.main.async {
                    self.isReconnecting = false
                    self.shouldReconnect = false
                }
                return
            }

            let delay = Double(self.backoffMs) / 1000.0
            self.backoffMs = min(self.backoffMs * 2, Self.maxBackoffMs)

            let gen = self.connectionGeneration
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.connectionGeneration == gen,
                      !self.isTerminating,
                      self.shouldReconnect, let url = self.url else { return }
                self.connectInternal(url)
            }
            self.reconnectWork = work
            self.queue.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }
}
