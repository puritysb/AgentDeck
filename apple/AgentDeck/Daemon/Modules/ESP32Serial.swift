#if os(macOS)
// ESP32Serial.swift — USB serial communication with ESP32 devices
// Ported from bridge/src/esp32-serial.ts

import Foundation
import Darwin

/// Thread-safe token to signal read threads to stop.
/// Shared between actor (invalidate) and read dispatch queue (check).
final class ReadToken: @unchecked Sendable {
    private let lock = NSLock()
    private var _active = true
    var isActive: Bool { lock.withLock { _active } }
    func invalidate() { lock.withLock { _active = false } }
}

/// Thread-safe cancellation marker for blocking serial open/config attempts.
final class OpenAttemptToken: @unchecked Sendable {
    private let lock = NSLock()
    private var _active = true
    var isActive: Bool { lock.withLock { _active } }
    func invalidate() { lock.withLock { _active = false } }
}

final class SerialStatusShadow: @unchecked Sendable {
    private let lock = NSLock()
    private var value: [String: Any] = ["available": true, "connections": [] as [Any]]

    func update(_ next: [String: Any]) {
        lock.withLock { value = next }
    }

    func snapshot() -> [String: Any] {
        lock.withLock { value }
    }
}

/// Manages USB serial connections to ESP32 devices (CH340/CP210x/native USB).
/// Newline-delimited JSON protocol, heartbeat, WiFi provisioning.
actor ESP32Serial {
    // Port detection patterns
    private static let portPatterns: [NSRegularExpression] = {
        ["/dev/cu\\.usbserial-\\d+", "/dev/cu\\.wchusbserial\\d+", "/dev/cu\\.usbmodem\\d+"].compactMap {
            try? NSRegularExpression(pattern: $0)
        }
    }()
    private static let excludePatterns = ["Bluetooth", "WLAN"]

    struct SerialConnection: Identifiable {
        let id = UUID()
        let port: String
        let fd: Int32
        var writeHandle: FileHandle?
        var readHandle: FileHandle?
        var connected = true
        var readBuffer = ""
        var deviceInfo: DeviceInfo?
        var provisionSent = false
        let readToken = ReadToken()
        let openedAt = Date()
        var lastReadAt: Date?
        var lastWriteAt: Date?
        var deviceInfoRequestsSent = 0
        var needsLineReset = false
        var writeBackpressureCount = 0
        /// While set and in the future, non-JSON serial lines from this port
        /// are logged verbatim — opened by a panic marker line so crash
        /// backtraces land in the daemon log instead of being discarded.
        var panicLogUntil: Date?
        var panicLogLines = 0
    }

    struct DeviceInfo {
        var board: String?
        var version: String?
        var protocolRevision: Int?
        var wifiConfigured: Bool?
        var wifiConnected: Bool?
    }

    private struct PortFailure {
        let error: String
        let isPermanent: Bool  // true for EACCES (Operation not permitted)
        var failCount: Int
        var lastAttempt: Date
    }

    private var connections: [SerialConnection] = []
    private var pollTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var lastDetectedPorts: [String] = []
    private var lastOpenError: String?
    private var lastReadError: String?
    private var lastWriteError: String?
    private var failedPorts: [String: PortFailure] = [:]
    private var openingPorts: [String: OpenAttemptToken] = [:]
    private var provisionFingerprintsByPort: [String: String] = [:]
    private let statusShadow = SerialStatusShadow()
    private static let permanentBlockDuration: TimeInterval = 300  // 5 minutes
    private static let serialOpenTimeoutSec: TimeInterval = 3
    private static let deviceInfoTimeoutSec: TimeInterval = 30  // retry device_info if absent
    // An identified connection that read before but has been RX-silent this
    // long is half-open: the board hung/rebooted badly or the CH340 RX path
    // wedged, while writes keep landing in the kernel buffer so no write error
    // ever closes it. Recycle so the poll loop reopens the port — the reopen's
    // DTR/RTS toggle resets the board (self-heal). Safe ONLY because the
    // heartbeat sends a keepalive every cycle and the firmware acks each one
    // (~3s cadence): 180s = ~60 missed acks. Mirrors UART_SILENT_READ_TIMEOUT_MS
    // in bridge/src/esp32-serial.ts.
    private static let silentReadTimeoutSec: TimeInterval = 180
    private static let writeBackpressureRetryLimit = 100
    private static let writeBackpressureRetryUsec: useconds_t = 20_000
    private static let writeBackpressureDisconnectThreshold = 15

    /// Thread-safe queue for incoming serial data (read thread → actor)
    private struct PendingRead: @unchecked Sendable {
        let port: String
        let data: String
    }
    private let pendingReadsLock = NSLock()
    nonisolated(unsafe) private var pendingReads: [PendingRead] = []

    private nonisolated func enqueuePendingRead(port: String, data: String) {
        pendingReadsLock.lock()
        pendingReads.append(PendingRead(port: port, data: data))
        pendingReadsLock.unlock()
    }

    private func drainPendingReads() {
        pendingReadsLock.lock()
        let reads = pendingReads
        pendingReads.removeAll()
        pendingReadsLock.unlock()
        for r in reads {
            if r.data.hasPrefix("<<READ_ERR:") {
                let details = String(r.data.dropFirst("<<READ_ERR:".count).dropLast(2))
                markReadFailure(port: r.port, message: "read failed on \(r.port): \(details)")
            } else {
                handleReadData(port: r.port, data: r.data)
            }
        }
    }
    private static let transientMaxBackoff: TimeInterval = 60
    // A USB-serial bridge that keeps FAILING TO OPEN (timeout or errno, not a
    // one-off) is almost certainly hardware-wedged (e.g. a CH340 termios wedge)
    // that no software open can recover — only a physical power-cycle can. Yet
    // every open() attempt toggles DTR/RTS and RESETS the attached board, so
    // retrying such a port on the 60s transient cap reboots an otherwise-healthy
    // board once a minute. After this many consecutive open failures, escalate
    // the backoff to the permanent-block cadence (5 min) so the reset-poking
    // becomes rare while the port still self-heals once the bridge is
    // power-cycled and finally opens. See memory ips10-wedged-ch340-daemon-reset-poke.
    private static let openFailureEscalationThreshold = 4

    /// Backoff before re-attempting to open a port that failed to open.
    ///
    /// Every `open()` toggles DTR/RTS and RESETS the attached board, so a port
    /// that keeps failing to open (a wedged CH340, a stuck bridge) must not be
    /// retried on a tight cadence or it reboots an otherwise-healthy board. The
    /// transient cadence ramps by consecutive `failCount`: 1→10s, 2→20s, 3→40s,
    /// 4→80s, 5→160s, 6+→300s — the exponential cap rises from
    /// `transientMaxBackoff` (60s) to `permanentBlockDuration` (5 min) once
    /// `failCount` reaches `openFailureEscalationThreshold`, so 300s is only
    /// reached at the 6th failure (not immediately at the 4th). Permanent
    /// failures (EACCES) use the flat 5-min block. Pure + `nonisolated` so the
    /// cadence is unit-tested independently of the poll loop.
    nonisolated static func openFailureBackoff(failCount: Int, isPermanent: Bool) -> TimeInterval {
        if isPermanent { return permanentBlockDuration }
        let cap = failCount >= openFailureEscalationThreshold ? permanentBlockDuration : transientMaxBackoff
        return min(10.0 * pow(2.0, Double(failCount - 1)), cap)
    }

    nonisolated(unsafe) private var stateProvider: (() -> [String: Any]?)?
    nonisolated(unsafe) private var usageProvider: (() -> [String: Any]?)?
    nonisolated(unsafe) private var sessionsListProvider: (() -> [String: Any]?)?
    nonisolated(unsafe) private var displayStateProvider: (() -> [String: Any])?
    nonisolated(unsafe) private var initialStateProvider: (() -> [[String: Any]])?
    var onMessage: (@Sendable (String, [String: Any]) -> Void)?

    var connectionCount: Int { connections.filter(\.connected).count }

    nonisolated func cachedStatusSnapshot() -> [String: Any] {
        statusShadow.snapshot()
    }

    func statusSnapshot() -> sending [String: Any] {
        let snapshot = makeStatusSnapshot()
        statusShadow.update(snapshot)
        return statusShadow.snapshot()
    }

    private func publishStatusShadow() {
        statusShadow.update(makeStatusSnapshot())
    }

    private func makeStatusSnapshot() -> [String: Any] {
        let connectedPorts = Set(connections.filter(\.connected).map(\.port))
        return [
            "available": true,
            "connectionCount": connections.filter(\.connected).count,
            "detectedPorts": lastDetectedPorts,
            "openingPorts": Array(openingPorts.keys).sorted(),
            "lastOpenError": lastOpenError as Any,
            "lastReadError": lastReadError as Any,
            "lastWriteError": lastWriteError as Any,
            "portFailures": failedPorts.filter { !connectedPorts.contains($0.key) }.mapValues { failure in
                [
                    "error": failure.error,
                    "isPermanent": failure.isPermanent,
                    "failCount": failure.failCount,
                    "lastAttempt": Int(failure.lastAttempt.timeIntervalSince1970 * 1000),
                ] as [String: Any]  
            },
            "connections": connections.map { conn in
                [
                    "port": conn.port,
                    "connected": conn.connected,
                    "provisionSent": conn.provisionSent,
                    "lastReadAt": conn.lastReadAt.map { Int($0.timeIntervalSince1970 * 1000) } as Any,
                    "lastWriteAt": conn.lastWriteAt.map { Int($0.timeIntervalSince1970 * 1000) } as Any,
                    "deviceInfoRequestsSent": conn.deviceInfoRequestsSent,
                    "writeBackpressureCount": conn.writeBackpressureCount,
                    "deviceInfo": [
                        "board": conn.deviceInfo?.board as Any,
                        "version": conn.deviceInfo?.version as Any,
                        "protocolRevision": conn.deviceInfo?.protocolRevision as Any,
                        "wifiConfigured": conn.deviceInfo?.wifiConfigured as Any,
                        "wifiConnected": conn.deviceInfo?.wifiConnected as Any,
                    ] as [String: Any],
                ] as [String: Any]
            },
        ]
    }

    nonisolated func setStateProviderFn(_ provider: @escaping () -> [String: Any]?) { stateProvider = provider }
    nonisolated func setUsageProviderFn(_ provider: @escaping () -> [String: Any]?) { usageProvider = provider }
    nonisolated func setSessionsListProviderFn(_ provider: @escaping () -> [String: Any]?) { sessionsListProvider = provider }
    nonisolated func setDisplayStateProviderFn(_ provider: @escaping () -> [String: Any]) { displayStateProvider = provider }
    nonisolated func setInitialStateProviderFn(_ provider: @escaping () -> [[String: Any]]) { initialStateProvider = provider }
    func setOnMessage(_ handler: @escaping @Sendable (String, [String: Any]) -> Void) { onMessage = handler }

    // MARK: - Lifecycle

    private var drainTask: Task<Void, Never>?

    func start() {
        pollTask = Task { [weak self] in
            await self?.pollForDevices()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                await self?.pollForDevices()
            }
        }

        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                await self?.sendHeartbeat()
            }
        }

        // Drain incoming serial data every 100ms
        drainTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                await self?.drainPendingReads()
            }
        }

        DaemonLogger.shared.debug("ESP32", "Serial bridge started")
        publishStatusShadow()
    }

    func stop() async {
        pollTask?.cancel()
        heartbeatTask?.cancel()
        drainTask?.cancel()
        // Wait for tasks to actually finish so no in-flight pollForDevices() opens new ports
        await pollTask?.value
        await heartbeatTask?.value
        await drainTask?.value
        pollTask = nil
        heartbeatTask = nil
        drainTask = nil
        closeAllConnections()
        DaemonLogger.shared.debug("ESP32", "Serial bridge stopped")
    }

    /// Wake recovery — full stop + restart to avoid FD leaks
    func handleWake() async {
        DaemonLogger.shared.info("ESP32 serial wake recovery — closing \(connections.count) stale connection(s)")
        await stop()
        // Delay 2s to let USB bus stabilize after wake
        try? await Task.sleep(for: .seconds(2))
        start()
    }

    /// Close all connections, invalidate read tokens, release FDs
    private func closeAllConnections() {
        for conn in connections {
            conn.readToken.invalidate()
            try? conn.writeHandle?.close()
            // readHandle is the same FileHandle — no separate close needed
        }
        connections.removeAll()
        failedPorts.removeAll()
        lastOpenError = nil
        lastReadError = nil
        lastWriteError = nil
        publishStatusShadow()
    }

    // MARK: - Broadcast

    /// Forward events matching SERIAL_FORWARDED_EVENTS to all connected ESP32
    func broadcast(_ event: [String: Any]) {
        guard !connections.isEmpty else { return }
        guard let type = event["type"] as? String,
              Self.serialForwardedEvents.contains(type) else { return }

        for i in connections.indices where connections[i].connected {
            sendEvent(event, to: &connections[i])
        }
        publishStatusShadow()
    }

    func sendWifiProvisionToAll(_ msg: [String: Any]) -> Int {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let json = String(data: data, encoding: .utf8) else { return 0 }
        var count = 0
        let fingerprint = Self.provisionFingerprint(for: msg)
        for i in connections.indices {
            guard connections[i].connected, !connections[i].provisionSent else { continue }
            if connections[i].deviceInfo?.wifiConnected == true { continue }
            if provisionFingerprintsByPort[connections[i].port] == fingerprint { continue }
            sendToConnection(&connections[i], json: json)
            guard connections[i].connected else { continue }
            connections[i].provisionSent = true
            provisionFingerprintsByPort[connections[i].port] = fingerprint
            count += 1
        }
        publishStatusShadow()
        return count
    }

    /// Send display state (on/off) to all connected ESP32 devices.
    /// Called by IOKit display sleep/wake handlers.
    // A `sendDisplayState(displayOn:)` helper used to live here. It built the
    // event without the `dim` object, which boards read as legacy full-off — so
    // reviving it would have silently downgraded every serial board's dim
    // setting. It had no callers: the live paths (broadcast fan-out and the
    // on-connect snapshot in DaemonServer) both send `dim`. Removed rather than
    // fixed so the trap cannot be re-armed by an innocent-looking call.

    // MARK: - Port Detection

    private func detectPorts() -> [String] {
        // Pure-Swift port enumeration. Previously shelled out to `ls` via
        // /bin/sh; App Store guideline 2.5.2 disallows spawning external
        // interpreters and `FileManager.contentsOfDirectory` gives us the
        // same result with no subprocess. Works identically in the CLI
        // build — there's no reason to keep the shell path.
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: "/dev") else {
            return []
        }
        return entries
            .filter { $0.hasPrefix("cu.") }
            .map { "/dev/\($0)" }
            .filter { port in
                guard !Self.excludePatterns.contains(where: { port.localizedCaseInsensitiveContains($0) }) else { return false }
                let range = NSRange(port.startIndex..., in: port)
                return Self.portPatterns.contains { $0.firstMatch(in: port, range: range) != nil }
            }
            .sorted { a, b in
                let ap = Self.portPriority(a)
                let bp = Self.portPriority(b)
                return ap == bp ? a < b : ap < bp
            }
    }

    private static func portPriority(_ port: String) -> Int {
        if port.contains("wchusbserial") || port.contains("usbserial") { return 0 }
        if port.contains("usbmodem") { return 1 }
        return 2
    }

    private func pollForDevices() {
        // Prune disconnected
        connections.removeAll { !$0.connected }

        let ports = detectPorts()
        lastDetectedPorts = ports
        // A wedged bridge stays enumerated, so a port VANISHING from the
        // detected set means it was physically unplugged / power-cycled / driver
        // re-enumerated — cases where the wedge may well be gone. Drop its
        // failure record so a re-plug retries immediately instead of inheriting
        // the escalated (5-min) delay above, even when macOS re-enumerates it
        // under the same device name. Trade-off: a device that flaps in and out
        // of enumeration (bad contact) resets its failCount each time and never
        // escalates; that's accepted because making a genuine re-plug wait up to
        // 5 min is the worse user-recovery outcome. Revisit with a grace period
        // only if enumeration false-negatives are observed in the field.
        if !failedPorts.isEmpty {
            let detected = Set(ports)
            failedPorts = failedPorts.filter { detected.contains($0.key) }
        }
        let now = Date()
        publishStatusShadow()

        for port in ports {
            // Skip if already connected
            if connections.contains(where: { $0.port == port }) { continue }
            if openingPorts[port] != nil { continue }

            // Check failure blocklist. openFailureBackoff() is the single,
            // unit-tested source of the retry cadence (see its doc): it escalates
            // a wedged port toward a 5-min block so we stop DTR-resetting the
            // board every minute.
            if let failure = failedPorts[port] {
                let backoff = Self.openFailureBackoff(failCount: failure.failCount, isPermanent: failure.isPermanent)
                if now.timeIntervalSince(failure.lastAttempt) < backoff { continue }
            }

            beginOpenPort(port)
        }
    }

    // MARK: - Port Open

    private enum SerialOpenResult: Sendable {
        case opened(Int32)
        case failed(Int32, String)
        case cancelled
    }

    private func beginOpenPort(_ port: String) {
        // Close any existing connection to the same port first (prevents FD leak on restart/wake race)
        if let existingIdx = connections.firstIndex(where: { $0.port == port }) {
            let old = connections.remove(at: existingIdx)
            old.readToken.invalidate()
            try? old.writeHandle?.close()
            DaemonLogger.shared.debug("ESP32", "Closed stale connection to \(port) before reopening")
        }

        let token = OpenAttemptToken()
        openingPorts[port] = token

        Task.detached(priority: .utility) { [weak self, token] in
            let result = Self.openSerialDescriptor(port, token: token)
            await self?.finishOpenPort(port: port, token: token, result: result)
        }

        Task { [weak self, token] in
            try? await Task.sleep(for: .seconds(Self.serialOpenTimeoutSec))
            await self?.markOpenTimedOut(port: port, token: token)
        }
    }

    private func finishOpenPort(port: String, token: OpenAttemptToken, result: SerialOpenResult) {
        guard openingPorts[port] === token else {
            if case .opened(let fd) = result {
                Darwin.close(fd)
            }
            publishStatusShadow()
            return
        }
        openingPorts.removeValue(forKey: port)

        switch result {
        case .opened(let descriptor):
            failedPorts.removeValue(forKey: port)
            registerOpenedDescriptor(port: port, descriptor: descriptor)
        case .failed(let errNo, let message):
            recordOpenFailure(port: port, errNo: errNo, message: message)
        case .cancelled:
            break
        }
        publishStatusShadow()
    }

    private func markOpenTimedOut(port: String, token: OpenAttemptToken) {
        guard openingPorts[port] === token else { return }
        token.invalidate()
        openingPorts.removeValue(forKey: port)

        let message = "serial open timed out after \(Self.serialOpenTimeoutSec)s"
        let existing = failedPorts[port]
        let count = (existing?.failCount ?? 0) + 1
        failedPorts[port] = PortFailure(error: message, isPermanent: false, failCount: count, lastAttempt: Date())
        lastOpenError = "failed to open serial handle for \(port): \(message)"
        DaemonLogger.shared.throttledDebug(
            "ESP32",
            key: "open-timeout:\(port)",
            "Timed out opening serial: \(port) [attempt \(count)]",
            minInterval: 30
        )
        publishStatusShadow()
    }

    private func registerOpenedDescriptor(port: String, descriptor: Int32) {
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        let writeHandle = handle
        let readHandle = handle

        let conn = SerialConnection(port: port, fd: descriptor, writeHandle: writeHandle, readHandle: readHandle)

        DaemonLogger.shared.info("ESP32 opened: \(port) [\(port.contains("usbmodem") ? "CDC" : "UART")]")

        lastOpenError = nil
        lastReadError = nil
        // IMPORTANT: append to connections array BEFORE starting read thread,
        // otherwise handleReadData won't find the connection by port name
        connections.append(conn)
        guard let readHandle = conn.readHandle else {
            DaemonLogger.shared.throttledDebug("ESP32", key: "missing-read:\(port)", "No read handle for \(port), skipping", minInterval: 60)
            return
        }
        startReading(port: port, handle: readHandle, fd: conn.fd, token: conn.readToken)

        // Send the initial burst only after the read loop is active so CDC
        // ports can drain the response path before larger payloads arrive.
        if let idx = connections.firstIndex(where: { $0.port == port }) {
            sendDeviceInfoRequest(to: &connections[idx])
            sendInitialState(to: &connections[idx])
        }
        publishStatusShadow()
    }

    private func recordOpenFailure(port: String, errNo: Int32, message: String) {
        let isPermanent = (errNo == EACCES)
        let existing = failedPorts[port]
        let count = (existing?.failCount ?? 0) + 1
        failedPorts[port] = PortFailure(error: message, isPermanent: isPermanent, failCount: count, lastAttempt: Date())

        if isPermanent {
            if count == 1 {
                DaemonLogger.shared.error("ESP32: Permission denied opening \(port) - serial entitlement missing or App Sandbox. Suppressing for 5 min.")
            }
        } else {
            DaemonLogger.shared.throttledDebug(
                "ESP32",
                key: "open-fail:\(port):\(message)",
                "Failed to open serial: \(port) (\(message)) [attempt \(count)]",
                minInterval: 30
            )
        }

        lastOpenError = "failed to open serial handle for \(port): \(message)"
        publishStatusShadow()
    }

    private nonisolated static func openSerialDescriptor(_ port: String, token: OpenAttemptToken) -> SerialOpenResult {
        // O_NONBLOCK needed to avoid blocking on DCD during open; cleared after termios config
        let descriptor = open(port, O_RDWR | O_NOCTTY | O_NONBLOCK)
        guard descriptor >= 0 else {
            let errNo = errno
            let message = String(cString: strerror(errNo))
            return .failed(errNo, message)
        }

        guard token.isActive else {
            Darwin.close(descriptor)
            return .cancelled
        }

        // Configure termios: raw mode, blocking read
        var options = termios()
        tcgetattr(descriptor, &options)
        guard token.isActive else {
            Darwin.close(descriptor)
            return .cancelled
        }
        cfmakeraw(&options)
        options.c_cflag |= UInt(CLOCAL | CREAD)
        options.c_cflag &= ~UInt(HUPCL)  // Match Node serial bridge: don't drop DTR on close/reopen.
        cfsetispeed(&options, speed_t(B115200))
        cfsetospeed(&options, speed_t(B115200))
        withUnsafeMutablePointer(to: &options.c_cc) { ptr in
            let cc = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: UInt8.self)
            cc[Int(VMIN)] = 1   // block until 1+ byte available
            cc[Int(VTIME)] = 0
        }
        tcsetattr(descriptor, TCSANOW, &options)
        guard token.isActive else {
            Darwin.close(descriptor)
            return .cancelled
        }
        tcflush(descriptor, TCIOFLUSH)
        // Keep O_NONBLOCK set — matches pyserial behavior (read returns EAGAIN when no data)

        guard token.isActive else {
            Darwin.close(descriptor)
            return .cancelled
        }
        return .opened(descriptor)
    }

    private func startReading(port: String, handle: FileHandle, fd: Int32, token: ReadToken) {
        // Use a dedicated thread for serial reading — FileHandle.readabilityHandler
        // uses dispatch sources which don't reliably trigger for serial port fds.
        // Read on a dispatch queue — poll fd with O_NONBLOCK
        let readQueue = DispatchQueue(label: "esp32.read.\(port)", qos: .default)
        readQueue.async { [weak self, handle] in
            _ = handle  // Retain the FileHandle for the entire reader lifetime.
            let bufSize = 1024
            let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
            defer { buf.deallocate() }

            while token.isActive {
                let n = Darwin.read(fd, buf, bufSize)
                if n > 0 {
                    if let str = String(bytes: UnsafeBufferPointer(start: buf, count: n), encoding: .utf8) {
                        self?.enqueuePendingRead(port: port, data: str)
                    }
                } else if n < 0 {
                    let errNo = errno
                    if errNo == EAGAIN || errNo == EWOULDBLOCK {
                        Thread.sleep(forTimeInterval: 0.05)
                        continue
                    }
                    DaemonLogger.shared.throttledDebug("ESP32", key: "read-exit:\(port):\(errNo)", "Read exit \(port): errno=\(errNo)", minInterval: 30)
                    let errText = String(cString: strerror(errNo))
                    self?.enqueuePendingRead(port: port, data: "<<READ_ERR:errno=\(errNo) \(errText)>>")
                    break
                } else {
                    Thread.sleep(forTimeInterval: 0.05)
                }
            }
        }
    }

    // ESP32 crash output is plain text on the same UART/CDC stream as the
    // JSON protocol. These markers open a capture window so the whole dump
    // (register dump lines don't individually match) is logged before the
    // board reboots.
    private static let panicMarkers = [
        "guru meditation", "backtrace:", "register dump", "abort() was called",
        "assert failed", "stack smashing", "stack canary",
        "debug exception reason", "elf file sha256", "rebooting...",
    ]
    private static let panicCaptureWindowSec: TimeInterval = 10
    private static let panicCaptureMaxLines = 200

    private func capturePanicLine(idx: Int, line: String) {
        let now = Date()
        let inWindow = connections[idx].panicLogUntil.map { now < $0 } ?? false
        let lowered = line.lowercased()
        let isMarker = Self.panicMarkers.contains { lowered.contains($0) }
        guard inWindow || isMarker else { return }
        if isMarker {
            // (Re)open the window on every marker — "Rebooting..." after the
            // dump keeps the bootloader reset-cause lines in scope too.
            connections[idx].panicLogUntil = now.addingTimeInterval(Self.panicCaptureWindowSec)
            if !inWindow { connections[idx].panicLogLines = 0 }
        }
        guard connections[idx].panicLogLines < Self.panicCaptureMaxLines else { return }
        connections[idx].panicLogLines += 1
        DaemonLogger.shared.info("ESP32 panic capture \(connections[idx].port): \(line)")
    }

    private func markReadFailure(port: String, message: String) {
        lastReadError = message
        if let idx = connections.firstIndex(where: { $0.port == port }) {
            connections[idx].readToken.invalidate()
            connections[idx].connected = false
        }
        publishStatusShadow()
    }

    private func handleReadData(port: String, data: String) {
        guard let idx = connections.firstIndex(where: { $0.port == port }) else { return }
        connections[idx].lastReadAt = Date()
        failedPorts.removeValue(forKey: port)
        lastReadError = nil
        connections[idx].readBuffer += data
        // Normalize CR/CRLF to LF — ESP32 Serial.println() sends \r\n,
        // cfmakeraw disables ICRNL so \r arrives as-is
        connections[idx].readBuffer = connections[idx].readBuffer
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        while let newlineIdx = connections[idx].readBuffer.firstIndex(of: "\n") {
            let line = String(connections[idx].readBuffer[..<newlineIdx]).trimmingCharacters(in: .whitespaces)
            connections[idx].readBuffer = String(connections[idx].readBuffer[connections[idx].readBuffer.index(after: newlineIdx)...])

            guard line.hasPrefix("{") else {
                // Not protocol JSON — usually boot/debug chatter, but ESP32
                // crash dumps arrive on this stream too. Capture those.
                capturePanicLine(idx: idx, line: line)
                continue
            }
            guard let jsonData = line.data(using: .utf8),
                  let msg = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let type = msg["type"] as? String else { continue }

            DaemonLogger.shared.sampledDebug("ESP32", key: "recv:\(port):\(type)", every: 20, "← \(port): \(type)")

            if type == "device_info" {
                let hadDeviceInfo = connections[idx].deviceInfo != nil
                connections[idx].deviceInfo = DeviceInfo(
                    board: msg["board"] as? String,
                    version: msg["version"] as? String,
                    protocolRevision: msg["protocolRevision"] as? Int,
                    wifiConfigured: msg["wifiConfigured"] as? Bool,
                    wifiConnected: msg["wifiConnected"] as? Bool
                )
                failedPorts.removeValue(forKey: port)
                if !hadDeviceInfo {
                    sendInitialState(to: &connections[idx])
                }
                publishStatusShadow()
            }

            onMessage?(port, msg)
        }

        // Prevent buffer bloat
        if connections[idx].readBuffer.count > 8192 {
            connections[idx].readBuffer = ""
        }
    }

    // MARK: - Heartbeat

    private func sendHeartbeat() {
        drainPendingReads()
        guard !connections.isEmpty else { return }

        // Check for connections that never received device_info. A delayed
        // response is not a device failure: keep the port open, retry the
        // request, and only reconnect a completely silent port after a longer
        // grace window.
        let now = Date()
        for i in connections.indices.reversed() where connections[i].connected {
            if connections[i].deviceInfo == nil,
               now.timeIntervalSince(connections[i].openedAt) > Self.deviceInfoTimeoutSec {
                let port = connections[i].port
                if connections[i].deviceInfoRequestsSent < 3 {
                    DaemonLogger.shared.throttledDebug(
                        "ESP32",
                        key: "device-info-retry:\(port)",
                        "\(port): device_info not received yet — retrying request",
                        minInterval: 30
                    )
                    sendDeviceInfoRequest(to: &connections[i])
                }
            }
        }

        // Half-open recycle: a connection that has read before but has been
        // RX-silent past silentReadTimeoutSec is a zombie — the board can no
        // longer be reached and no write error will ever close the FD. Drop it
        // here; pollForDevices() (10s cadence) reopens the port, and the
        // reopen's DTR/RTS toggle resets the board. Never-read connections
        // (lastReadAt == nil) are the device_info retry path's concern above.
        for i in connections.indices.reversed() where connections[i].connected {
            guard let lastReadAt = connections[i].lastReadAt else { continue }
            let readAge = now.timeIntervalSince(lastReadAt)
            if readAge > Self.silentReadTimeoutSec {
                let conn = connections[i]
                DaemonLogger.shared.info("ESP32 half-open serial (RX silent \(Int(readAge))s, writes healthy): \(conn.port) — recycling")
                conn.readToken.invalidate()
                try? conn.writeHandle?.close()
                connections.remove(at: i)
            }
        }

        if let event = stateProvider?() {
            for i in connections.indices where connections[i].connected {
                sendEvent(event, to: &connections[i])
            }
        }

        if let event = usageProvider?(),
           event["fiveHourPercent"] != nil {
            for i in connections.indices where connections[i].connected {
                sendEvent(event, to: &connections[i])
            }
        }

        // Re-sync sessions_list every cycle for the same reason as display_state
        // below: it is otherwise edge-triggered (on change + on connect), so a
        // board that (re)connects during a quiet window — daemon handoff,
        // half-open serial — sits on an empty roster ("no active sessions")
        // until the next unrelated session change happens to broadcast. The
        // firmware upserts idempotently.
        if let event = sessionsListProvider?() {
            for i in connections.indices where connections[i].connected {
                sendEvent(event, to: &connections[i])
            }
        }

        // Re-sync display_state every cycle. It is otherwise edge-triggered
        // (on change + on connect); a board that misses the wake edge — half-
        // open serial, daemon handoff — stays blacked out until power-cycled.
        // The payload is tiny and the firmware handler is idempotent.
        if let event = displayStateProvider?() {
            for i in connections.indices where connections[i].connected {
                sendEvent(event, to: &connections[i])
            }
        }

        // Keepalive EVERY cycle, not only when no other data went out. The
        // firmware acks ONLY keepalive lines (heartbeat_ack) — state/usage/
        // sessions payloads produce no reply — so this is the sole periodic
        // board→host liveness signal. Sending it only on idle meant an active
        // daemon generated zero reads from healthy boards, which would make
        // the half-open recycle above reset every board each timeout window.
        let keepalive = "{\"type\":\"keepalive\"}"
        for i in connections.indices where connections[i].connected {
            sendToConnection(&connections[i], json: keepalive)
        }
        publishStatusShadow()
    }

    // MARK: - Serial Helpers

    private enum SerialWriteResult {
        case success
        case backpressure(String, partial: Bool)
        case hardFailure(String)
    }

    private func sendDeviceInfoRequest(to conn: inout SerialConnection) {
        conn.deviceInfoRequestsSent += 1
        sendToConnection(&conn, json: #"{"type":"device_info_request"}"#)
    }

    private func sendInitialState(to conn: inout SerialConnection) {
        guard let events = initialStateProvider?() else { return }
        for event in events {
            if conn.deviceInfo == nil, (event["type"] as? String) == "usage_update" {
                continue
            }
            sendEvent(event, to: &conn)
        }
    }

    @discardableResult
    private func sendEvent(_ event: [String: Any], to conn: inout SerialConnection) -> Bool {
        guard let type = event["type"] as? String,
              Self.serialForwardedEvents.contains(type) else { return false }
        let prepared = Self.prepareForSerial(event, deviceInfo: conn.deviceInfo)
        guard let data = try? JSONSerialization.data(withJSONObject: prepared),
              let json = String(data: data, encoding: .utf8) else { return false }
        sendToConnection(&conn, json: json)
        return true
    }

    private func sendToConnection(_ conn: inout SerialConnection, json: String) {
        guard conn.connected, conn.writeHandle != nil else { return }
        let hadLineReset = conn.needsLineReset
        let prefix = conn.needsLineReset ? "\n" : ""
        let payload = Array((prefix + json + "\n").utf8)
        switch writePayload(payload, to: conn.fd) {
        case .success:
            conn.needsLineReset = false
            conn.writeBackpressureCount = 0
            conn.lastWriteAt = Date()
            lastWriteError = nil
            failedPorts.removeValue(forKey: conn.port)
        case .backpressure(let message, let partial):
            conn.needsLineReset = hadLineReset || partial
            conn.writeBackpressureCount += 1
            lastWriteError = "write backpressure for \(conn.port): \(message)"
            DaemonLogger.shared.throttledDebug(
                "ESP32",
                key: "write-backpressure:\(conn.port)",
                "\(conn.port): \(message); keeping connection open",
                minInterval: 30
            )
            if conn.writeBackpressureCount >= Self.writeBackpressureDisconnectThreshold {
                let failCount = (failedPorts[conn.port]?.failCount ?? 0) + 1
                let failure = "\(message) after \(conn.writeBackpressureCount) consecutive write stall(s)"
                conn.readToken.invalidate()
                conn.connected = false
                try? conn.writeHandle?.close()
                failedPorts[conn.port] = PortFailure(
                    error: failure,
                    isPermanent: false,
                    failCount: failCount,
                    lastAttempt: Date()
                )
                lastWriteError = "write failed for \(conn.port): \(failure)"
                DaemonLogger.shared.debug("ESP32", "\(conn.port): closing stalled serial connection for reconnect")
            }
        case .hardFailure(let message):
            conn.readToken.invalidate()
            conn.connected = false
            try? conn.writeHandle?.close()
            failedPorts[conn.port] = PortFailure(
                error: message,
                isPermanent: false,
                failCount: (failedPorts[conn.port]?.failCount ?? 0) + 1,
                lastAttempt: Date()
            )
            lastWriteError = "write failed for \(conn.port): \(message)"
        }
    }

    private func writePayload(_ payload: [UInt8], to fd: Int32) -> SerialWriteResult {
        var offset = 0
        var retryCount = 0
        let chunkSize = 128
        while offset < payload.count {
            let bytesToWrite = min(payload.count - offset, chunkSize)
            let written = payload.withUnsafeBufferPointer { buffer in
                Darwin.write(
                    fd,
                    buffer.baseAddress!.advanced(by: offset),
                    bytesToWrite
                )
            }
            if written > 0 {
                offset += written
                retryCount = 0
                if offset < payload.count {
                    usleep(10_000) // 10ms delay between chunks to let ESP32 RX buffer drain
                }
                continue
            }

            let errNo = errno
            if (written < 0 && (errNo == EAGAIN || errNo == EWOULDBLOCK)) || written == 0 {
                if retryCount < Self.writeBackpressureRetryLimit {
                    retryCount += 1
                    usleep(Self.writeBackpressureRetryUsec)
                    continue
                }
                return .backpressure(
                    "write stalled after \(offset) of \(payload.count) bytes, errno=\(errNo)",
                    partial: offset > 0
                )
            }

            return .hardFailure("write returned \(written), wrote \(offset) of \(payload.count), errno=\(errNo)")
        }
        return .success
    }

    private static func provisionFingerprint(for msg: [String: Any]) -> String {
        let ssid = msg["ssid"] as? String ?? ""
        let password = msg["password"] as? String ?? ""
        let bridgeIp = msg["bridgeIp"] as? String ?? ""
        let bridgePort = msg["bridgePort"] as? Int ?? 0
        return "\(ssid)|\(password.hashValue)|\(bridgeIp)|\(bridgePort)"
    }

    /// Strip fields ESP32 doesn't need (reduce payload for small RX buffers)
    /// Shrink + strip a broadcast event into the lean payload a small ESP32
    /// display can actually buffer. Static + keyed on `DeviceInfo?` so BOTH the
    /// USB-serial path (SerialConnection) and the WiFi-WS path (cachedWifiEsp32)
    /// run the exact same transform — no drift. Mirrors bridge/src/esp32-serial.ts
    /// `prepareForSerial`.
    static func prepareForSerial(_ event: [String: Any], deviceInfo: DeviceInfo?) -> [String: Any] {
        var e = event
        let type = event["type"] as? String

        // Global strips — large metadata daemon has but small devices don't use
        e.removeValue(forKey: "modelCatalog")
        e.removeValue(forKey: "ollamaStatus")
        e.removeValue(forKey: "tokenStatus")

        if type == "usage_update" {
            e.removeValue(forKey: "extraUsageEnabled")
            e.removeValue(forKey: "extraUsageMonthlyLimit")
            e.removeValue(forKey: "extraUsageUsedCredits")
            e.removeValue(forKey: "extraUsageUtilization")
            e.removeValue(forKey: "costSpent")
            e.removeValue(forKey: "costLimit")
            e.removeValue(forKey: "sessionPercent")
            e.removeValue(forKey: "resetTime")
            e.removeValue(forKey: "resetDate")
        } else if type == "state_update" {
            e.removeValue(forKey: "agentCapabilities")
            e.removeValue(forKey: "billingType")
            e.removeValue(forKey: "remoteUrl")
            e.removeValue(forKey: "moduleHealth")
            e.removeValue(forKey: "subscriptions")
            e.removeValue(forKey: "options")
            e.removeValue(forKey: "suggestedPrompt")
            e.removeValue(forKey: "question")
            e.removeValue(forKey: "pairingUrl")
            e.removeValue(forKey: "gatewayDeviceId")
            e.removeValue(forKey: "gatewayAuthRequestId")
            e.removeValue(forKey: "gatewayAuthMessage")
            e.removeValue(forKey: "voiceAssistantText")
            e.removeValue(forKey: "voiceAssistantResponseText")
            // Keep gatewayAvailable and gatewayHasError — ESP32 needs them for crayfish rendering
        } else if type == "timeline_event" || type == "timeline_history" {
            // Cap timeline text to the firmware's byte-sized TimelineEntry buffers
            // (raw[120]/detail[200]/projectName[40]). Uncapped, the board's strncpy
            // does the cut — mid-UTF-8 for 한글/CJK — and the card/ticker renders a
            // broken trailing glyph. Mirrors the Node bridge `stamp` shrink
            // (bridge/src/esp32-serial.ts). `localHm` is already stamped at source
            // (daemonTimelineEntryDict).
            func shrinkEntry(_ entry: [String: Any]) -> [String: Any] {
                var o = entry
                o["raw"] = limitUtf8Bytes(entry["raw"], 119)
                if entry["detail"] != nil { o["detail"] = limitUtf8Bytes(entry["detail"], 199) }
                if entry["projectName"] != nil { o["projectName"] = limitUtf8Bytes(entry["projectName"], 39) }
                return o
            }
            if type == "timeline_event" {
                if let entry = e["entry"] as? [String: Any] { e["entry"] = shrinkEntry(entry) }
            } else if let entries = e["entries"] as? [[String: Any]] {
                // The firmware ring keeps at most 64 rows (TIMELINE_MAX_ENTRIES),
                // but the row cap alone is not enough: a busy afternoon of CJK
                // entries made the 64-row frame ~37 KB — far past the boards'
                // 4 KB line buffer, so serial firmware discarded it silently and
                // the WiFi WS client on heap-tight boards dropped the socket,
                // reconnected, got the same frame, and flapped forever. Budget
                // the shipped history by BYTES, newest first, so the frame
                // always fits what a board can actually ingest.
                e["entries"] = Self.budgetTimelineEntries(entries.suffix(64).map(shrinkEntry))
            }
        }
        return shapeSessionsList(e, type: type, deviceInfo: deviceInfo)
    }

    /// Node parity: SERIAL_SESSIONS_CAP in bridge/src/esp32-serial.ts.
    static let serialSessionsCap = 10

    /// Total byte budget for a shipped timeline_history frame. The smallest
    /// board line buffer is 4096 (util/line_buffer defaults; InkDeck is 8192)
    /// — anything larger is discarded whole on-device, so shipping it is pure
    /// waste at best and a WS-client killer at worst.
    static let timelineHistoryByteBudget = 3500

    /// Keep the NEWEST entries whose summed JSON size fits the byte budget,
    /// preserving chronological order for the ones that survive.
    static func budgetTimelineEntries(_ entries: [[String: Any]]) -> [[String: Any]] {
        var kept: [[String: Any]] = []
        var total = 0
        for entry in entries.reversed() {
            guard let data = try? JSONSerialization.data(withJSONObject: entry) else { continue }
            // +1 for the array comma; the envelope overhead lives in the
            // budget's headroom (4096 - 3500).
            if total + data.count + 1 > timelineHistoryByteBudget { break }
            total += data.count + 1
            kept.append(entry)
        }
        return kept.reversed()
    }

    /// Fair per-agentType session pick under the cap — a direct port of
    /// `roundRobinByAgentType` (bridge/src/esp32-serial.ts): one session per
    /// agent type per round, alive-then-active first within each type, so a
    /// burst of observed Claude sessions can't evict the codex/opencode rows.
    static func roundRobinByAgentType(_ sessions: [[String: Any]], cap: Int) -> [[String: Any]] {
        guard sessions.count > cap else { return sessions }

        var groups: [String: [[String: Any]]] = [:]
        var order: [String] = []
        for s in sessions {
            let key = s["agentType"] as? String ?? ""
            if groups[key] == nil { groups[key] = []; order.append(key) }
            groups[key]!.append(s)
        }

        func rank(_ s: [String: Any]) -> Int {
            let alive = ((s["alive"] as? Bool) ?? false) ? 1 : 0
            let state = s["state"] as? String ?? ""
            let active = (!state.isEmpty && state != "idle") ? 1 : 0
            return alive * 2 + active
        }
        for key in order {
            // Stable for ties — enumerate to keep the original index as the
            // secondary sort key (Swift's sort is not guaranteed stable).
            groups[key] = groups[key]!.enumerated()
                .sorted { a, b in
                    let ra = rank(a.element), rb = rank(b.element)
                    return ra != rb ? ra > rb : a.offset < b.offset
                }
                .map { $0.element }
        }

        var result: [[String: Any]] = []
        var progressed = true
        while result.count < cap && progressed {
            progressed = false
            for key in order {
                guard !groups[key]!.isEmpty else { continue }
                result.append(groups[key]!.removeFirst())
                progressed = true
                if result.count >= cap { break }
            }
        }
        return result
    }

    private static func shapeSessionsList(_ event: [String: Any], type: String?, deviceInfo: DeviceInfo?) -> [String: Any] {
        var e = event
        if type == "sessions_list" {
            // Per-session fields the device needs, with serial-size caps. Mirrors the Node
            // bridge's prepareForSerial map (bridge/src/esp32-serial.ts) so the App-Store Swift
            // daemon drives the same IPS10 D1 cards + pixel-office (project pods, desks, real
            // option buttons) even when no CLI daemon is running. Dead sessions excluded.
            func lim(_ v: Any?, _ n: Int) -> String { limitUtf8Bytes(v, n) }
            if let sessions = e["sessions"] as? [[String: Any]] {
                // Cap the roster like Node (SERIAL_SESSIONS_CAP=10,
                // roundRobinByAgentType). Uncapped, an afternoon of many
                // observed Claude sessions pushed the frame past the boards'
                // 4 KB line buffer: serial firmware silently discards the
                // line (stale cards), but the WiFi WS client CLOSES on it —
                // the chronic connect→choke→reconnect flap of every
                // WiFi-only board whenever session count was high.
                e["sessions"] = Self.roundRobinByAgentType(
                    sessions.filter { s in (s["alive"] as? Bool) ?? true },
                    cap: Self.serialSessionsCap)
                    .map { s -> [String: Any] in
                        var o: [String: Any] = [
                            "id": lim(s["id"], 31),
                            "projectName": lim(s["projectName"], 39),
                            "modelName": lim(s["modelName"], 31),
                            "agentType": lim(s["agentType"], 15),
                            "state": lim(s["state"], 19),
                            "alive": s["alive"] ?? true,
                            "currentTool": lim(s["currentTool"], 39),
                            // Clean per-session one-liner ("Editing auth.ts") from the
                            // shared activity pipeline — glance surfaces (InkDeck cards,
                            // XTeink X3/X4 rows) render this instead of the raw tool name.
                            // Without it the device falls back to "Bash". Mirrors the Node
                            // bridge serial map (bridge/src/esp32-serial.ts activity cap 79).
                            "activity": lim(s["activity"], 79),
                            "promptType": lim(s["promptType"], 19),
                            "question": lim(s["question"], 159)
                        ]
                        if let p = s["port"] { o["port"] = p }
                        if let es = s["elapsedSec"] { o["elapsedSec"] = es }
                        if let op = s["options"] { o["options"] = op }
                        // Daemon-computed latest milestone (TIMELINE parity for the
                        // IPS10 cards). Omitted when absent — empty strings would
                        // cost ~50 bytes/session on the 4KB serial line budget.
                        let lastText = lim(s["lastEventText"], 99)
                        if !lastText.isEmpty {
                            o["lastEventText"] = lastText
                            let lastTask = lim(s["lastEventTask"], 39)
                            if !lastTask.isEmpty { o["lastEventTask"] = lastTask }
                            let lastHm = lim(s["lastEventHm"], 5)
                            if !lastHm.isEmpty { o["lastEventHm"] = lastHm }
                        }
                        return o
                    }
            }
        }

        // Before the ESP32 has identified itself, keep the first burst lean.
        // CDC devices are the ones that have been stalling on the initial
        // payload, so strip the high-volume fields until device_info lands.
        if deviceInfo == nil, type == "state_update" {
            e.removeValue(forKey: "moduleHealth")
            e.removeValue(forKey: "subscriptions")
            e.removeValue(forKey: "voiceAssistantState")
            e.removeValue(forKey: "voiceAssistantText")
            e.removeValue(forKey: "voiceAssistantResponseText")
            e.removeValue(forKey: "pairingUrl")
            e.removeValue(forKey: "gatewayDeviceId")
            e.removeValue(forKey: "gatewayAuthRequestId")
            e.removeValue(forKey: "gatewayAuthMessage")
            e.removeValue(forKey: "remoteUrl")
        }
        if Self.needsLegacyCodexAppAlias(deviceInfo) {
            e = Self.aliasCodexAppAgentTypes(e) as? [String: Any] ?? e
        }
        return e
    }

    private static func parseDeviceInfo(from data: String) -> DeviceInfo? {
        for line in data
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("{"),
                  let jsonData = trimmed.data(using: .utf8),
                  let msg = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  (msg["type"] as? String) == "device_info" else { continue }
            return DeviceInfo(
                board: msg["board"] as? String,
                version: msg["version"] as? String,
                protocolRevision: msg["protocolRevision"] as? Int,
                wifiConfigured: msg["wifiConfigured"] as? Bool,
                wifiConnected: msg["wifiConnected"] as? Bool
            )
        }
        return nil
    }

    private static func needsLegacyCodexAppAlias(_ deviceInfo: DeviceInfo?) -> Bool {
        guard deviceInfo?.board == "round_amoled" else { return false }
        // Round AMOLED v0.1.0 predates codex-app and falls back to the
        // Claude creature for unknown agent types. Newer firmware advertises
        // protocolRevision 2 / v0.1.1 and can render codex-app directly.
        if (deviceInfo?.protocolRevision ?? 0) >= 2 { return false }
        return !isVersion(deviceInfo?.version, atLeast: "0.1.1")
    }

    private static func isVersion(_ version: String?, atLeast minimum: String) -> Bool {
        guard let version else { return false }
        let lhs = version.split(separator: ".").map { Int($0) ?? 0 }
        let rhs = minimum.split(separator: ".").map { Int($0) ?? 0 }
        let count = max(lhs.count, rhs.count)
        for idx in 0..<count {
            let l = idx < lhs.count ? lhs[idx] : 0
            let r = idx < rhs.count ? rhs[idx] : 0
            if l != r { return l > r }
        }
        return true
    }

    private static func aliasCodexAppAgentTypes(_ value: Any) -> Any {
        if let dict = value as? [String: Any] {
            var mapped: [String: Any] = [:]
            for (key, child) in dict {
                if key == "agentType", (child as? String) == "codex-app" {
                    mapped[key] = "codex-cli"
                } else {
                    mapped[key] = aliasCodexAppAgentTypes(child)
                }
            }
            return mapped
        }
        if let array = value as? [Any] {
            return array.map { aliasCodexAppAgentTypes($0) }
        }
        return value
    }

    /// Truncate to a UTF-8 BYTE budget on a character boundary. Firmware buffers
    /// are byte-sized (`char raw[120]` …); the old `String.prefix(n)` counted
    /// Characters, so n=39 한글 graphemes could still be 117 bytes — the board's
    /// strncpy then cut mid-sequence and the panel drew a broken glyph. Mirrors
    /// the Node bridge `limitString` (bridge/src/esp32-serial.ts).
    static func limitUtf8Bytes(_ v: Any?, _ maxBytes: Int) -> String {
        guard let s = v as? String else { return "" }
        if s.utf8.count <= maxBytes { return s }
        var out = ""
        var used = 0
        for ch in s {
            let n = String(ch).utf8.count
            if used + n > maxBytes { break }
            out.append(ch)
            used += n
        }
        return out
    }

    // MARK: - Constants

    static let serialForwardedEvents: Set<String> = [
        "state_update", "usage_update", "sessions_list",
        "connection", "display_state",
        "timeline_event", "timeline_history"
    ]

    // MARK: - WiFi-WS ESP32 (Node parity)

    /// Reconstruct a `DeviceInfo` from a cached WiFi-ESP32 device dict
    /// (`cachedWifiEsp32[...].devices.first`) so the WiFi path feeds
    /// `prepareForSerial` the same board/version/protocolRevision context the
    /// USB-serial path gets — keeps per-board caps and legacy aliases identical.
    static func wifiDeviceInfo(_ dict: [String: Any]?) -> DeviceInfo? {
        guard let dict, let board = dict["board"] as? String else { return nil }
        return DeviceInfo(
            board: board,
            version: dict["version"] as? String,
            protocolRevision: dict["protocolRevision"] as? Int,
            wifiConfigured: nil,
            wifiConnected: nil)
    }

    /// The payload a WiFi-WS ESP32 *display* board should receive for a broadcast
    /// event, or `nil` to drop it (not display-forwardable). A WiFi board is a
    /// display client, not a dashboard: it gets the same whitelisted +
    /// `prepareForSerial`-shrunk stream as a USB-serial board, never the full
    /// dashboard fanout (which overran its buffer over 2.4 GHz and flapped the
    /// socket every few seconds). Mirrors the `esp32 eventTransformer` in
    /// bridge/src/daemon-server.ts.
    static func wifiEsp32Forward(_ event: [String: Any], deviceInfo: DeviceInfo?) -> [String: Any]? {
        guard let type = event["type"] as? String, serialForwardedEvents.contains(type) else { return nil }
        return prepareForSerial(event, deviceInfo: deviceInfo)
    }
}
#endif
