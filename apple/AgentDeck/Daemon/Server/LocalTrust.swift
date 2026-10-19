#if os(macOS)
// LocalTrust.swift — this daemon's inputs to the same-machine trust rule, and
// its refusal log (Node: `localTrustOf` / `logLocalTrustRefusal` in
// bridge/src/auth.ts).
//
// The rule itself is `LocalTrustRules`, generated from shared/src/local-trust.ts:
// a web page in a browser here connects from 127.0.0.1 like a local program,
// and only its `Host` and `Origin` tell them apart. A request that fails it is
// answered as a LAN peer: it needs the pairing token.

import Foundation

enum LocalTrust {
    typealias Verdict = LocalTrustRules.Verdict

    /// The verdict for a request this daemon parsed (its header keys are lower case).
    static func verdict(for request: HTTPServer.HTTPRequest, upgrade: Bool = false, port: Int) -> Verdict {
        LocalTrustRules.verdict(
            method: request.method, upgrade: upgrade,
            origin: request.headers["origin"], host: request.headers["host"],
            environment: environment(port: port))
    }

    /// This daemon's environment. The host name comes from `gethostname`, the
    /// same source as Node's `os.hostname()`, so both daemons accept the same
    /// names.
    static func environment(port: Int) -> LocalTrustRules.Environment {
        LocalTrustRules.Environment(
            port: port,
            isLocalAddress: { AuthManager.shared.isLocalConnection($0) },
            hostNames: currentHostName().map { [$0] } ?? [])
    }

    private static func currentHostName() -> String? {
        var buffer = [CChar](repeating: 0, count: Int(MAXHOSTNAMELEN) + 1)
        guard gethostname(&buffer, buffer.count) == 0 else { return nil }
        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return bytes.isEmpty ? nil : String(decoding: bytes, as: UTF8.self)
    }

    private static let refusalLock = NSLock()
    nonisolated(unsafe) private static var refusalLoggedAt: [String: Date] = [:]

    /// Say why a same-machine request had to authenticate like a LAN peer:
    /// once a minute per surface and reason, so a page retrying in a loop
    /// cannot flood the log. The header came from a web page, so it is clipped
    /// and reduced to URL characters before it is logged.
    static func logRefusal(surface: String, verdict: Verdict, headers: [String: String], now: Date = Date()) {
        guard verdict != .trusted else { return }
        let key = "\(surface):\(verdict.rawValue)"
        refusalLock.lock()
        let last = refusalLoggedAt[key]
        let due = last.map { now.timeIntervalSince($0) >= 60 } ?? true
        if due { refusalLoggedAt[key] = now }
        refusalLock.unlock()
        guard due else { return }
        let name = verdict == .foreignHost ? "Host" : "Origin"
        let value = headers[name.lowercased()] ?? ""
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/._-[]%")
        let shown = String(value.filter { allowed.contains($0) }.prefix(80))
        DaemonLogger.shared.info("A same-machine \(surface) request with \(name) \(shown.isEmpty ? "(empty)" : shown) "
            + "is a web page, not a local program; it was answered as a LAN peer (pairing token required)")
    }
}
#endif
