#if os(macOS)
// GatewayProbe.swift — TCP health check for OpenClaw Gateway
// Ported from bridge/src/gateway-probe.ts

import Foundation
import Network

actor GatewayProbe {
    static let gatewayPort: UInt16 = 18789
    private var pollTask: Task<Void, Never>?
    private let enabled: Bool
    private let pollInterval: Duration
    private let probeOverride: (@Sendable () async -> Bool)?

    init(enabled: Bool = ProcessInfo.processInfo.environment["AGENTDECK_DAEMON_NO_GATEWAY"] != "1",
         pollInterval: Duration = .seconds(5), probe: (@Sendable () async -> Bool)? = nil) {
        self.enabled = enabled; self.pollInterval = pollInterval; self.probeOverride = probe
    }
    private(set) var isAvailable = false
    private(set) var hasError = false
    var onStateChanged: ((Bool, Bool) -> Void)? // (available, hasError)

    func hasErrorSnapshot() -> Bool { hasError }

    func start() {
        guard enabled, pollTask == nil else { return }
        let interval = pollInterval
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: interval) } catch { break }
                guard !Task.isCancelled, let self else { break }
                await self.probe()
            }
        }
    }

    func stop() {
        pollTask?.cancel(); pollTask = nil
    }

    private func probe() async {
        let available: Bool
        if let probeOverride { available = await probeOverride() }
        else { available = await tcpProbe(port: Self.gatewayPort) }
        let changed = available != isAvailable
        isAvailable = available

        if available {
            // Authenticated health is sourced through OpenClawAdapter's
            // Gateway RPC after auth; this probe only tracks reachability.
            let errorChanged = false != hasError
            hasError = false
            if changed || errorChanged {
                onStateChanged?(available, hasError)
            }
        } else if changed {
            hasError = false
            onStateChanged?(false, false)
        }
    }

    private func tcpProbe(port: UInt16) async -> Bool {
        // Simple socket connect test — no NWConnection to avoid continuation races
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        // Non-blocking connect with 2s timeout
        var flags = fcntl(fd, F_GETFL, 0)
        flags |= O_NONBLOCK
        _ = fcntl(fd, F_SETFL, flags)

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        if result == 0 { return true }
        guard errno == EINPROGRESS else { return false }

        // Wait for connect with poll()
        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        let pollResult = poll(&pfd, 1, 2000) // 2s timeout
        if pollResult <= 0 { return false }

        // Check if connect succeeded
        var error: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &len)
        return error == 0
    }

}
#endif
