#if os(macOS)
// SessionRegistry.swift — daemon.json / sessions.json management
// Ported from bridge/src/session-registry.ts

import Foundation

/// Dedicated URLSession for short-lived local-loopback probes (sibling
/// `/health`, ollama `/api/ps`, mlx `/models`). Isolating these from
/// `URLSession.shared` prevents Pixoo/APME/usage HTTP storms from starving
/// the connection pool and causing legitimate sibling sessions to be pruned
/// on a single transient timeout. See memory/bug_urlsession_pool_starvation.md
enum LocalProbeSession {
    static let shared: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 2
        config.httpMaximumConnectionsPerHost = 2
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()
}

/// Tracks consecutive health-probe failures per port so that a single
/// transient failure (e.g. URLSession pool contention) does not prune a
/// legitimate sibling session. Three consecutive failures required before
/// `listActiveAndReachable()` treats a sibling as dead.
actor SessionProbeFailureTracker {
    private var failures: [Int: Int] = [:]

    func recordSuccess(port: Int) {
        failures[port] = nil
    }

    /// Returns the new failure count after incrementing.
    func recordFailure(port: Int) -> Int {
        let count = (failures[port] ?? 0) + 1
        failures[port] = count
        return count
    }
}

private final class RegistryIOBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T?

    func set(_ value: T?) {
        lock.lock()
        self.value = value
        lock.unlock()
    }

    func get() -> T? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

struct DaemonInfo: Codable, Sendable {
    let port: Int
    let pid: Int
    let startedAt: String
    let httpPort: Int?    // HTTP server port (may differ from WS port)
}

struct DaemonSessionEntry: Codable, Sendable, Identifiable {
    let id: String
    let port: Int
    let pid: Int
    let projectName: String
    var agentType: String?
    var tmuxSession: String?
    var tty: String?
    var parentTty: String?
    var startedAt: String?
    // Enriched fields (from /health probe, not persisted to sessions.json)
    var state: String?
    var modelName: String?
    var effortLevel: String?
    var currentTool: String?
    var options: [[String: AnyCodable]]?
    var navigable: Bool?
    var question: String?  // awaiting prompt question (from Notification hook message)
}

final class SessionRegistry: Sendable {
    static let shared = SessionRegistry()
    static let defaultPort = 9120
    static let basePort = 9120
    static let maxPort = 9139
    // QoS .userInteractive, not .utility/.userInitiated: callers include
    // DaemonServer.startServices/startAllPolling running on the main actor
    // (User-interactive QoS) — they sync-wait via DispatchSemaphore, so any
    // queue strictly below User-interactive trips Thread Performance Checker
    // priority-inversion warnings on every read. The work is a single
    // bounded `Data(contentsOf:)` capped at 700 ms, so .userInteractive is
    // bounded and lives on the main-actor critical path; it is not a
    // sustained background workload.
    private static let ioQueue = DispatchQueue(label: "dev.agentdeck.registry.io", qos: .userInteractive)
    private static let readTimeout: DispatchTimeInterval = .milliseconds(700)

    /// Per-port consecutive health-probe failure counter. Shared across the
    /// SessionRegistry singleton so repeated calls to `listActiveAndReachable()`
    /// can enforce an N-strike grace period before pruning.
    private static let probeFailureTracker = SessionProbeFailureTracker()
    private static let probeFailureThreshold = 3

    private var dataDir: URL {
        if let env = ProcessInfo.processInfo.environment["AGENTDECK_DATA_DIR"] {
            return URL(fileURLWithPath: env)
        }
        return AuthManager.agentDeckDir
    }

    private var sessionsFile: URL { dataDir.appendingPathComponent("sessions.json") }
    private var daemonFile: URL { dataDir.appendingPathComponent("daemon.json") }

    // MARK: - Sessions

    func readSessions() -> [DaemonSessionEntry] {
        guard let data = readDataBounded(from: sessionsFile),
              let sessions = try? JSONDecoder().decode([DaemonSessionEntry].self, from: data) else {
            return []
        }
        return sessions
    }

    private func writeSessions(_ sessions: [DaemonSessionEntry]) {
        guard let data = try? JSONEncoder.pretty.encode(sessions) else { return }
        writeDataBestEffort(data, to: sessionsFile, tmpPrefix: ".sessions")
    }

    func register(_ entry: DaemonSessionEntry) {
        var sessions = pruneDeadSessions(readSessions())
        sessions.removeAll { $0.id == entry.id }
        sessions.append(entry)
        writeSessions(sessions)
        DaemonLogger.shared.debug("SessionRegistry", "Registered \(entry.id) on port \(entry.port)")
    }

    func deregister(_ id: String) {
        var sessions = readSessions()
        sessions.removeAll { $0.id == id }
        writeSessions(sessions)
    }

    func listActive() -> [DaemonSessionEntry] {
        let sessions = readSessions()
        let alive = pruneDeadSessions(sessions)
        if alive.count != sessions.count { writeSessions(alive) }
        return alive
    }

    /// Like `listActive()` but additionally verifies each non-daemon session
    /// responds on its HTTP port within a short timeout. Unreachable sessions
    /// are deregistered from sessions.json. Use from sibling-relay code paths
    /// (TimelineRelay, usage relay) so dead CLI processes with reused PIDs —
    /// which pass `isProcessAlive` but never respond — don't cause restart
    /// loops, stuck subscriptions, or health-probe timeouts.
    func listActiveAndReachable() async -> [DaemonSessionEntry] {
        let pidAlive = listActive()
        let candidates = pidAlive.filter { $0.agentType != "daemon" }
        guard !candidates.isEmpty else { return pidAlive }

        // Probe in parallel, return (id, port, ok) so the grace-period logic
        // below can track consecutive failures per port.
        struct ProbeResult: Sendable {
            let id: String
            let port: Int
            let ok: Bool
        }
        let results: [ProbeResult] = await withTaskGroup(of: ProbeResult.self) { group in
            for entry in candidates {
                group.addTask { [self] in
                    let ok = await self.isSessionReachable(port: entry.port)
                    return ProbeResult(id: entry.id, port: entry.port, ok: ok)
                }
            }
            var out: [ProbeResult] = []
            for await r in group { out.append(r) }
            return out
        }

        // Apply 3-strike grace: a sibling is only considered unreachable after
        // N consecutive failed probes. This absorbs transient URLSession
        // contention (Pixoo storms, APME LLM calls) that would otherwise prune
        // a perfectly healthy session on the first miss.
        var reachableIds = Set<String>()
        for r in results {
            if r.ok {
                await Self.probeFailureTracker.recordSuccess(port: r.port)
                reachableIds.insert(r.id)
            } else {
                let count = await Self.probeFailureTracker.recordFailure(port: r.port)
                if count < Self.probeFailureThreshold {
                    // Grace: keep in the survivor set so it isn't pruned yet.
                    reachableIds.insert(r.id)
                    DaemonLogger.shared.debug(
                        "SessionRegistry",
                        "Sibling health probe failed for port \(r.port) (\(count)/\(Self.probeFailureThreshold)) — holding"
                    )
                }
            }
        }

        let survivors = pidAlive.filter { entry in
            entry.agentType == "daemon" || reachableIds.contains(entry.id)
        }
        if survivors.count != pidAlive.count {
            let removed = pidAlive.count - survivors.count
            DaemonLogger.shared.info("SessionRegistry: pruned \(removed) unreachable sibling session(s) from sessions.json")
            writeSessions(survivors)
        }
        return survivors
    }

    private func isSessionReachable(port: Int) async -> Bool {
        guard port > 0 else { return false }
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (_, response) = try await LocalProbeSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return false }
            return http.statusCode == 200
        } catch {
            return false
        }
    }

    func findExistingDaemon() -> DaemonSessionEntry? {
        listActive().first { $0.agentType == "daemon" }
    }

    // MARK: - Daemon Info

    func writeDaemonInfo(_ info: DaemonInfo) {
        guard let data = try? JSONEncoder.pretty.encode(info) else { return }
        writeDataBestEffort(data, to: daemonFile, tmpPrefix: ".daemon")
        DaemonLogger.shared.debug("SessionRegistry", "Wrote daemon.json: port=\(info.port)")
    }

    func removeDaemonInfo() {
        let daemonFile = daemonFile
        Self.ioQueue.async {
            try? FileManager.default.removeItem(at: daemonFile)
        }
    }

    func readDaemonInfo() -> DaemonInfo? {
        guard let data = readDataBounded(from: daemonFile),
              let info = try? JSONDecoder().decode(DaemonInfo.self, from: data) else {
            return nil
        }
        guard isProcessAlive(info.pid) else {
            removeDaemonInfo()
            return nil
        }
        // PID reuse guard: if startedAt is more than 24h ago, the PID likely
        // belongs to a different process that reused the same number.
        if let startedDate = ISO8601DateFormatter().date(from: info.startedAt) {
            let age = Date().timeIntervalSince(startedDate)
            if age > 24 * 60 * 60 {
                DaemonLogger.shared.debug("SessionRegistry", "Stale daemon.json (startedAt \(info.startedAt), age \(Int(age))s) — removing")
                removeDaemonInfo()
                return nil
            }
        }
        return info
    }

    func findDaemonPort() -> Int? {
        if let info = readDaemonInfo() { return info.port }
        if let daemon = findExistingDaemon() { return daemon.port }
        return nil
    }

    // MARK: - Port Allocation

    func findAvailablePort(excluding: Set<Int> = []) async -> Int? {
        let sessions = listActive()
        let usedPorts = Set(sessions.map(\.port)).union(excluding)
        for port in Self.basePort...Self.maxPort {
            if !usedPorts.contains(port), await isPortFree(port) {
                return port
            }
        }
        return nil
    }

    func isPortBindable(_ port: Int) async -> Bool {
        await isPortFree(port)
    }

    // MARK: - Health Probe

    func probeDaemonHealth(port: Int) async -> [String: Any]? {
        guard port > 0 else { return nil }
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (data, response) = try await LocalProbeSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch {
            return nil
        }
    }

    /// Scan the daemon port window (9120-9139) for a live daemon's `/health`.
    /// Mirrors the Node bridge's `findDaemonPortAsync` port-scan fallback
    /// (bridge/src/session-registry.ts): covers the case where a sibling
    /// daemon is alive on a fallback port but its daemon.json lives in a data
    /// dir this sandboxed process can't read (`~/.agentdeck` vs the group
    /// container). Session bridges share the same port window but report
    /// `mode: <agentType>`, so only `mode == "daemon"` matches. Probes run in
    /// parallel; closed local ports fail fast with connection-refused, so the
    /// scan costs at most one probe timeout (~2 s) even when an unrelated
    /// process squats a port.
    func scanForDaemonPort(excluding: Set<Int> = []) async -> Int? {
        await withTaskGroup(of: Int?.self) { group in
            for port in Self.basePort...Self.maxPort where !excluding.contains(port) {
                group.addTask { [self] in
                    let health = await self.probeDaemonHealth(port: port)
                    return (health?["mode"] as? String) == "daemon" ? port : nil
                }
            }
            var found: Int?
            for await result in group {
                if let result {
                    // Lowest port wins for determinism across racing probes.
                    found = found.map { Swift.min($0, result) } ?? result
                }
            }
            return found
        }
    }

    // MARK: - Helpers

    private func pruneDeadSessions(_ sessions: [DaemonSessionEntry]) -> [DaemonSessionEntry] {
        sessions.filter { isProcessAlive($0.pid) }
    }

    private func isProcessAlive(_ pid: Int) -> Bool {
        // kill(pid, 0) returns 0 even for zombies still in the kernel table,
        // so use sysctl to check the process state directly. Treat zombies
        // (SZOMB) and exiting processes (P_WEXIT flag) as dead — they will
        // never respond to WebSocket/HTTP probes.
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, Int32(pid)]
        let result = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        guard result == 0, size > 0 else { return false }
        if info.kp_proc.p_stat == 5 { return false }              // SZOMB
        if (Int32(info.kp_proc.p_flag) & 0x2000) != 0 { return false }  // P_WEXIT
        return true
    }

    private func isPortFree(_ port: Int) async -> Bool {
        // Test IPv6 wildcard (::) in dual-stack mode — matches what NWListener actually binds.
        // NWListener binds to "::.<port>" by default, so an IPv4-only 127.0.0.1 test can
        // succeed while the actual NWListener bind fails with EADDRINUSE.
        let fd = socket(AF_INET6, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        // SO_REUSEADDR to match NWParameters.allowLocalEndpointReuse
        var reuseAddr: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuseAddr, socklen_t(MemoryLayout<Int32>.size))

        // Dual-stack — accept both IPv4 and IPv6 on same socket
        var v6only: Int32 = 0
        setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &v6only, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in6()
        addr.sin6_family = sa_family_t(AF_INET6)
        addr.sin6_port = in_port_t(port).bigEndian
        addr.sin6_addr = in6addr_any  // :: wildcard

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.size))
            }
        }
        guard bindResult == 0 else { return false }

        // SO_REUSEADDR allows TWO sockets to bind() the same port, but only one
        // can listen(). Without this check, the probe can report "free" while
        // another REUSEADDR socket already owns the listen slot, then NWListener
        // loses the race and fails with EADDRINUSE.
        return listen(fd, 1) == 0
    }

    private func readDataBounded(from url: URL) -> Data? {
        let box = RegistryIOBox<Data>()
        let semaphore = DispatchSemaphore(value: 0)
        Self.ioQueue.async {
            box.set(try? Data(contentsOf: url))
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + Self.readTimeout) == .success else {
            DaemonLogger.shared.debug("SessionRegistry", "Timed out reading \(url.lastPathComponent); treating as absent")
            return nil
        }
        return box.get()
    }

    private func writeDataBestEffort(_ data: Data, to destination: URL, tmpPrefix: String) {
        let dataDir = dataDir
        Self.ioQueue.async {
            try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
            let tmpFile = dataDir.appendingPathComponent("\(tmpPrefix).\(UUID().uuidString).tmp")
            try? data.write(to: tmpFile)
            self.replaceFile(at: destination, with: tmpFile)
        }
    }

    private func replaceFile(at destination: URL, with source: URL) {
        let fm = FileManager.default
        if fm.fileExists(atPath: destination.path) {
            _ = try? fm.replaceItemAt(destination, withItemAt: source)
        } else {
            try? fm.moveItem(at: source, to: destination)
        }
        if fm.fileExists(atPath: source.path) {
            try? fm.removeItem(at: source)
        }
    }
}

// MARK: - JSONEncoder convenience

extension JSONEncoder {
    static let pretty: JSONEncoder = {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        return enc
    }()
}
#endif
