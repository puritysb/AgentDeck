#if os(macOS)
// AuthManager.swift — Token generation, validation, local connection detection
// Ported from bridge/src/auth.ts

import Foundation
import Security
import Darwin
import SQLite3

final class AuthManager: @unchecked Sendable {
    static let shared = AuthManager()

    /// Base AgentDeck data directory. Delegates to `AgentDeckPaths` which
    /// resolves to the App Store sandbox container when sandboxed and falls
    /// back to the legacy `~/.agentdeck/` layout otherwise.
    static var agentDeckDir: URL { AgentDeckPaths.baseDirectory }
    static var tokenFile: URL { AgentDeckPaths.authToken }
    static var acceptedTokenFile: URL { AgentDeckPaths.authTokenAccepted }
    private static let tokenLength = 32 // 32 hex chars = 16 bytes
    /// Bounded so a long-lived machine cannot accumulate an unbounded key ring.
    private static let maxAcceptedTokens = PairingCredentialRules.maxAccepted
    private static let credentialIO = DispatchQueue(label: "AgentDeck.PairingCredentials", qos: .utility)

    private static func string(from nullTerminatedBytes: [CChar]) -> String {
        let bytes = nullTerminatedBytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// Guards `currentToken`/`acceptedTokens`. The token is no longer immutable:
    /// `adoptPeerToken` rewrites it when this app finds a CLI daemon already
    /// serving the machine, and `/health` and the WS gate read it from other
    /// executors.
    private let lock = NSLock()
    private var currentToken: String
    private var acceptedTokens: [String]

    private let credentialDirectory: URL
    private var retirement = PairingCredentialRules.Retirement(revision: 0, eventId: "")
    private var credentialUnavailable = false

    init(directory: URL = AuthManager.agentDeckDir) {
        credentialDirectory = directory
        let result = Self.readFileWithTimeout(AgentDeckPaths.authCredentials(in: directory), label: "credential-state")
        if case .missing = result {
            currentToken = Self.loadOrCreateToken(at: AgentDeckPaths.authToken(in: directory))
            acceptedTokens = Self.loadAcceptedTokens(at: AgentDeckPaths.authTokenAccepted(in: directory))
        } else if let text = result.text, let state = try? PairingCredentialRules.decode(Data(text.utf8)) {
            currentToken = state.token; acceptedTokens = state.accepted; retirement = state.retirement
        } else {
            // A fenced state that cannot be read must not revive legacy files.
            currentToken = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            acceptedTokens = []; credentialUnavailable = true
            DaemonLogger.shared.error("Pairing credential state unavailable; legacy fallback and rotation refused")
        }
    }

    var credentials: PairingCredentialRules.State {
        lock.lock(); defer { lock.unlock() }
        return .init(revision: retirement.revision, eventId: retirement.eventId, token: currentToken, accepted: acceptedTokens)
    }
    var credentialGeneration: String? {
        lock.lock(); defer { lock.unlock() }
        return credentialUnavailable ? "unknown" : retirement.generation
    }
    var rotationAvailable: Bool {
        lock.lock(); defer { lock.unlock() }; return !credentialUnavailable
    }

    var token: String {
        lock.lock()
        defer { lock.unlock() }
        return currentToken
    }

    // MARK: - Token Management

    private static func loadOrCreateToken(at url: URL) -> String {
        // macOS 26 sandbox container I/O can silently block the very
        // first `Data(contentsOf:)` on auth-token at `__open` syscall —
        // sample shows main thread stuck in `_fcntl_overlay_open` →
        // `__open`, no sandboxd deny in system log. That stalls the entire
        // daemon startup (`DaemonServer.init` → `AuthManager.shared` is
        // called sync from main actor) and makes the GUI look frozen.
        //
        // Run the read on a background queue with a short timeout. If the
        // syscall never returns we treat it as "no existing token" and
        // generate a fresh one — the dashboard's auth token is dashboard-
        // only state, regenerating it doesn't break any external integration.
        // The write also runs on a background queue, so a hung write
        // doesn't block startup either.
        if let existing = readFileWithTimeout(url, label: "token-file").text?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           existing.count >= tokenLength {
            return existing
        }

        // Generate new token
        var bytes = [UInt8](repeating: 0, count: tokenLength / 2)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let token = bytes.map { String(format: "%02x", $0) }.joined()

        // Write fire-and-forget on a background queue; if it hangs the
        // next launch will hit the timeout path again and stay
        // functional rather than freezing the daemon.
        credentialIO.async {
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try (token + "\n").write(to: url, atomically: true, encoding: .utf8)
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o600],
                    ofItemAtPath: url.path
                )
                DaemonLogger.shared.debug("auth", "Generated new auth token")
            } catch {
                DaemonLogger.shared.error("Failed to write token file: \(error)")
            }
        }

        return token
    }

    /// Read a small file off the calling thread with a hard deadline. Container
    /// I/O can wedge in `__open` (see `loadOrCreateToken`) and every caller here
    /// runs synchronously on the daemon's startup path.
    private static func readFileWithTimeout(_ url: URL, label: String) -> AuthTokenReadResult {
        let semaphore = DispatchSemaphore(value: 0)
        let box = AuthTokenReadBox()
        DispatchQueue.global(qos: .userInitiated).async {
            defer { semaphore.signal() }
            do {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                let data = try handle.read(upToCount: PairingCredentialRules.maxBytes + 1) ?? Data()
                guard data.count <= PairingCredentialRules.maxBytes, let text = String(data: data, encoding: .utf8) else { return }
                box.set(.text(text))
            } catch {
                let e = error as NSError
                if (e.domain == NSCocoaErrorDomain && [NSFileReadNoSuchFileError, NSFileNoSuchFileError].contains(e.code)) || (e.domain == NSPOSIXErrorDomain && e.code == Int(ENOENT)) { box.set(.missing) }
            }
        }
        if semaphore.wait(timeout: .now() + 2) == .timedOut {
            DaemonLogger.shared.error("AuthManager: \(label) read timed out (sandbox first-launch?)")
            return .unavailable
        }
        return box.get()
    }

    private static func loadAcceptedTokens(at url: URL) -> [String] {
        guard let text = readFileWithTimeout(url, label: "accepted-token-file").text else { return [] }
        return text
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.count >= tokenLength }
            .prefix(maxAcceptedTokens)
            .map { String($0) }
    }

    private static func writeAtomic(_ data: Data, to target: URL) throws {
        let dir = target.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let temp = dir.appendingPathComponent(".credential-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temp) }
        guard FileManager.default.createFile(atPath: temp.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw PairingCredentialRules.Failure.unavailable }
        let handle = try FileHandle(forWritingTo: temp)
        defer { try? handle.close() }
        try handle.synchronize()
        guard rename(temp.path, target.path) == 0 else { throw PairingCredentialRules.Failure.unavailable }
    }
    private static func persist(_ state: PairingCredentialRules.State, directory: URL) throws {
        try writeAtomic(JSONEncoder().encode(state), to: AgentDeckPaths.authCredentials(in: directory))
        do {
            try writeAtomic(Data(state.accepted.map { $0 + "\n" }.joined().utf8), to: AgentDeckPaths.authTokenAccepted(in: directory))
            try writeAtomic(Data((state.token + "\n").utf8), to: AgentDeckPaths.authToken(in: directory))
        } catch { DaemonLogger.shared.error("Legacy credential mirror unavailable; atomic state remains authoritative") }
    }
    /// Matches Node's BEGIN IMMEDIATE guard; process death releases the OS lock.
    /// The lock database contains no tokens. The JSON file remains authority.
    private static func withCredentialLock<T>(_ directory: URL, body: () throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var handle: OpaquePointer?
        guard sqlite3_open_v2(AgentDeckPaths.authCredentialLock(in: directory).path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let db = handle else { if let handle { sqlite3_close(handle) }; throw PairingCredentialRules.Failure.unavailable }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, Int32(PairingCredentialRules.timeoutMs))
        guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { throw PairingCredentialRules.Failure.unavailable }
        defer { sqlite3_exec(db, "ROLLBACK", nil, nil, nil) }
        return try body()
    }
    private func mutateCredentials(_ transform: @escaping @Sendable (PairingCredentialRules.State) throws -> PairingCredentialRules.State?) async throws -> PairingCredentialRules.State {
        try await withCheckedThrowingContinuation { continuation in
            Self.credentialIO.async { [self] in
                do {
                    lock.lock()
                    let unavailable = credentialUnavailable
                    let cached = PairingCredentialRules.State(revision: retirement.revision, eventId: retirement.eventId, token: currentToken, accepted: acceptedTokens)
                    lock.unlock()
                    guard !unavailable else { throw PairingCredentialRules.Failure.unavailable }
                    let next = try Self.withCredentialLock(credentialDirectory) {
                        let result = Self.readFileWithTimeout(AgentDeckPaths.authCredentials(in: credentialDirectory), label: "credential-mutation")
                        let current: PairingCredentialRules.State
                        if case .missing = result, cached.revision == 0 { current = cached }
                        else if let text = result.text { current = try PairingCredentialRules.decode(Data(text.utf8)) }
                        else { throw PairingCredentialRules.Failure.unavailable }
                        guard current.revision >= cached.revision,
                              current.revision != cached.revision || current.revision == 0 || (current.eventId == cached.eventId && current.token == cached.token) else { throw PairingCredentialRules.Failure.conflictingRetirement }
                        let next = try transform(current) ?? current
                        if next != current { try Self.persist(next, directory: credentialDirectory) }
                        return next
                    }
                    lock.lock()
                    currentToken = next.token; acceptedTokens = next.accepted; retirement = next.retirement
                    lock.unlock()
                    continuation.resume(returning: next)
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    func rotate(minimumRevision: Int) async throws -> PairingCredentialRules.State {
        try await mutateCredentials { current in
            var bytes = [UInt8](repeating: 0, count: 16)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw PairingCredentialRules.Failure.unavailable }
            let token = bytes.map { String(format: "%02x", $0) }.joined()
            let eventId = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            return try PairingCredentialRules.rotate(current, token: token, eventId: eventId, minimumRevision: minimumRevision)
        }
    }

    /// Adopt the pairing token of a daemon already serving this machine.
    ///
    /// A machine has ONE fleet of paired devices but two possible daemons — this
    /// in-process Swift one and the Node CLI one — and they keep their token in
    /// different files. This app is sandboxed and cannot read
    /// `~/.agentdeck/auth-token`, so the credential travels over the one channel
    /// both can always use: the incumbent's loopback `/health`, which carries
    /// `pairingToken` to same-machine callers only. Whoever starts second adopts
    /// what the incumbent serves, so a later handover in either direction costs
    /// no device its pairing and start order stops mattering.
    ///
    /// Before retirement, the superseded token stays in the accepted list. A
    /// newer retirement clears that ring and blocks older peer state.
    ///
    /// Returns true when the served token actually changed.
    @discardableResult
    func adoptPeerToken(_ candidate: String?, retirement raw: Any? = nil) async throws -> Bool {
        let metadata = try PairingCredentialRules.metadata(raw)
        guard let candidate = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), candidate.count >= Self.tokenLength else {
            if raw != nil { throw PairingCredentialRules.Failure.unavailable }
            return false
        }
        let before = credentials
        let after = try await mutateCredentials { local in
            try PairingCredentialRules.adopt(local, token: candidate, metadata: metadata.json)
        }
        return after != before
    }

    /// Pure decision core of `adoptPeerToken` — nil means "nothing to adopt".
    /// Split out so the ring semantics can be tested without touching the real
    /// credential on disk: `AuthManager.shared` is a singleton over the live
    /// token file, and a test that exercised it could un-pair the machine.
    /// Mirrors revision-zero legacy convergence only; production retirement
    /// transitions use PairingCredentialRules and temporary-profile probes.
    nonisolated static func adoption(
        of candidate: String?, current: String, ring: [String], maxTokens: Int = maxAcceptedTokens
    ) -> (token: String, ring: [String])? {
        guard let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
              trimmed.count >= tokenLength,
              trimmed != current else { return nil }
        var updated = ring.filter { $0 != current && $0 != trimmed }
        updated.insert(current, at: 0)
        return (trimmed, Array(updated.prefix(maxTokens)))
    }

    // MARK: - Validation

    private func constantTimeMatch(_ candidate: String, _ stored: String) -> Bool {
        guard candidate.count == stored.count else { return false }
        var result: UInt8 = 0
        for (a, b) in zip(candidate.utf8, stored.utf8) {
            result |= a ^ b
        }
        return result == 0
    }

    /// Validate against the token we serve, then the ones we still accept (a
    /// token superseded by `adoptPeerToken`). Every candidate is compared — no
    /// early exit — so the answer costs the same whichever key matched.
    func validateToken(_ candidate: String) -> Bool {
        lock.lock()
        let stored = currentToken
        let accepted = acceptedTokens
        lock.unlock()

        var ok = constantTimeMatch(candidate, stored)
        for token in accepted {
            ok = constantTimeMatch(candidate, token) || ok
        }
        return ok
    }

    // MARK: - Local Connection Detection

    func isLocalConnection(_ ip: String) -> Bool {
        if ip == "127.0.0.1" || ip == "::1" || ip == "::ffff:127.0.0.1" { return true }

        // Check against this machine's network interfaces
        let localIPs = Self.getLocalIPAddresses()
        return localIPs.contains(ip) || localIPs.contains(where: { "::ffff:\($0)" == ip })
    }

    // MARK: - Network Helpers

    static func getLanIP() -> String? {
        // Prefer the default-route interface's IPv4 so a dual-homed host (e.g.
        // en0 + en1 on the same subnet) advertises the address a remote device
        // can actually reach, not an arbitrary secondary one. App-Store-safe: a
        // UDP "connect" sends no packet — it just makes the kernel resolve the
        // source address via the route table (no subprocess, unlike `route`).
        if let routed = primaryRouteIP() { return routed }

        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0 else { continue }
            let addr = ptr.pointee.ifa_addr.pointee
            guard addr.sa_family == UInt8(AF_INET) else { continue }

            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(ptr.pointee.ifa_addr, socklen_t(addr.sa_len),
                           &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = Self.string(from: hostname)
                if !ip.hasPrefix("169.254.") { return ip } // Skip link-local
            }
        }
        return nil
    }

    /// IPv4 of the default-route interface via the UDP-connect source-address
    /// trick (no packet leaves the host). Returns nil when there's no route.
    private static func primaryRouteIP() -> String? {
        let fd = socket(AF_INET, SOCK_DGRAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }

        var dest = sockaddr_in()
        dest.sin_family = sa_family_t(AF_INET)
        dest.sin_port = in_port_t(53).bigEndian
        inet_pton(AF_INET, "8.8.8.8", &dest.sin_addr)
        let connected = withUnsafePointer(to: &dest) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard connected == 0 else { return nil }

        var local = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &local) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        guard named == 0 else { return nil }

        var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        inet_ntop(AF_INET, &local.sin_addr, &buf, socklen_t(INET_ADDRSTRLEN))
        let ip = Self.string(from: buf)
        if ip.isEmpty || ip == "0.0.0.0" || ip.hasPrefix("169.254.") { return nil }
        return ip
    }

    private static func getLocalIPAddresses() -> Set<String> {
        var result = Set<String>()
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return result }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let addr = ptr.pointee.ifa_addr.pointee
            guard addr.sa_family == UInt8(AF_INET) || addr.sa_family == UInt8(AF_INET6) else { continue }
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(ptr.pointee.ifa_addr, socklen_t(addr.sa_len),
                           &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
                result.insert(Self.string(from: hostname))
            }
        }
        return result
    }

    func getWsUrl(port: Int) -> String {
        let ip = Self.getLanIP() ?? "127.0.0.1"
        return "ws://\(ip):\(port)?token=\(token)"
    }
}

private enum AuthTokenReadResult: Sendable {
    case missing, unavailable, text(String)
    var text: String? { if case .text(let value) = self { return value }; return nil }
}

private final class AuthTokenReadBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: AuthTokenReadResult = .unavailable

    func set(_ value: AuthTokenReadResult) {
        lock.lock()
        self.value = value
        lock.unlock()
    }

    func get() -> AuthTokenReadResult {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
#endif
