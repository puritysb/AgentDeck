// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/pairing-code.ts
// Regenerate: pnpm generate-pairing-code-rules (drift gated by shared/src/__tests__/pairing-code-rules-sync.test.ts)

import Foundation

/// Operator-authorized pairing codes — see shared/src/pairing-code.ts for why
/// this path exists and what it deliberately does not weaken.
///
/// Pure, injected-clock, no daemon state: `PairingWindowStore` owns the mutable
/// window and asks this type for every verdict, so the Swift daemon and the Node
/// daemon answer a redemption identically.
enum PairingCodeRules {

    /// Digits in a pairing code.
    static let digits = 6

    /// How long an operator-opened window stays open, in milliseconds.
    static let windowMs = 120000

    /// Wrong codes the whole window tolerates before it closes. Global rather
    /// than per-peer: an attacker picks their source address.
    static let maxFailedAttempts = 5

    /// Credentials one window hands out unless the operator asks for more.
    static let defaultRedemptions = 1

    /// Port a typed address means when it carries none.
    static let DEFAULT_DAEMON_PORT = 9120

    /// Quiet period before retrying the same selected host, never another host.
    static let clientReconnectCooldownMs = 30000

    /// State a daemon keeps for an open window, and all these rules read.
    struct WindowSnapshot: Sendable {
        var code: String
        /// Epoch milliseconds after which the window is closed regardless.
        var expiresAt: Int
        var failedAttempts: Int
        var redemptionsRemaining: Int

        init(code: String, expiresAt: Int, failedAttempts: Int = 0, redemptionsRemaining: Int = PairingCodeRules.defaultRedemptions) {
            self.code = code
            self.expiresAt = expiresAt
            self.failedAttempts = failedAttempts
            self.redemptionsRemaining = redemptionsRemaining
        }
    }

    enum Outcome: String, Sendable {
        case accepted
        case noWindow = "no-window"
        case expired
        case exhausted
        case mismatch
        case malformed
    }

    struct Result: Sendable {
        var outcome: Outcome
        /// The HTTP status to answer with — part of the shared contract.
        var status: Int
        var attemptsRemaining: Int
        /// True when the daemon must drop the window as a result of this call.
        var closes: Bool
    }

    /// Reduce a human-entered code to its canonical form, or nil if it is not one.
    ///
    /// Filters to ASCII digits, which is also why the TS/Swift string-unit trap
    /// does not apply here: after filtering, UTF-16 code units, Characters and
    /// bytes all agree, so `count` cannot disagree with TS `.length`.
    static func normalize(_ input: String?) -> String? {
        guard let input else { return nil }
        let digitsOnly = input.unicodeScalars.filter { $0.value >= 48 && $0.value <= 57 }
        guard digitsOnly.count == digits else { return nil }
        return String(String.UnicodeScalarView(digitsOnly))
    }

    /// True when `code` is exactly what `normalize` emits.
    static func isPairingCode(_ code: String?) -> Bool {
        guard let code else { return false }
        return normalize(code) == code
    }

    /// Group a code for display: `482913` → `482 913`.
    static func format(_ code: String) -> String {
        guard let normalized = normalize(code) else { return code }
        let half = digits / 2
        let split = normalized.index(normalized.startIndex, offsetBy: half)
        return "\(normalized[normalized.startIndex..<split]) \(normalized[split...])"
    }

    /// Length-independent compare, so a wrong code cannot be measured digit by digit.
    private static func codesMatch(_ a: String, _ b: String) -> Bool {
        let lhs = Array(a.utf8), rhs = Array(b.utf8)
        guard lhs.count == rhs.count else { return false }
        var diff: UInt8 = 0
        for i in lhs.indices { diff |= lhs[i] ^ rhs[i] }
        return diff == 0
    }

    /// The whole redemption decision, as a function of the window and the code.
    ///
    /// Order is contract: expiry is decided before the code is looked at, so a
    /// stale window is not probeable for free, and `malformed` is decided before
    /// `mismatch`, so a typo does not spend one of the operator's attempts.
    static func evaluate(window: WindowSnapshot?, submitted: String?, now: Int) -> Result {
        guard let window else {
            return Result(outcome: .noWindow, status: 401, attemptsRemaining: 0, closes: false)
        }
        if now >= window.expiresAt {
            return Result(outcome: .expired, status: 410, attemptsRemaining: 0, closes: true)
        }
        if window.redemptionsRemaining <= 0 || window.failedAttempts >= maxFailedAttempts {
            return Result(outcome: .exhausted, status: 429, attemptsRemaining: 0, closes: true)
        }

        let attemptsBefore = maxFailedAttempts - window.failedAttempts
        guard let code = normalize(submitted) else {
            return Result(outcome: .malformed, status: 400, attemptsRemaining: attemptsBefore, closes: false)
        }
        if !codesMatch(code, window.code) {
            let attemptsRemaining = attemptsBefore - 1
            return Result(outcome: .mismatch, status: 401, attemptsRemaining: attemptsRemaining, closes: attemptsRemaining <= 0)
        }

        let redemptionsLeft = window.redemptionsRemaining - 1
        return Result(outcome: .accepted, status: 200, attemptsRemaining: attemptsBefore, closes: redemptionsLeft <= 0)
    }

    /// Seconds left on a window, floored at 0 — for countdown copy.
    static func secondsRemaining(window: WindowSnapshot?, now: Int) -> Int {
        guard let window else { return 0 }
        let remaining = window.expiresAt - now
        if remaining <= 0 { return 0 }
        return (remaining + 999) / 1000
    }

    struct DaemonAddress: Equatable, Sendable {
        let host: String
        let port: Int
    }

    /// Parse an operator-typed daemon address into host + port.
    ///
    /// The code path is otherwise gated on discovery — a client spends a code
    /// against a daemon it found over mDNS — so on a network where multicast is
    /// filtered the six-digit path is unreachable by exactly the camera-less
    /// devices it was built for. Shared with the other client because the two
    /// must agree what a bare `192.168.1.5` means; if they defaulted to
    /// different ports, the same string typed on two devices in one room would
    /// reach different daemons and it would look like a bad code.
    static func parseDaemonAddress(_ input: String?) -> DaemonAddress? {
        guard var text = input?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        if let scheme = text.range(of: "://") { text = String(text[scheme.upperBound...]) }
        for cut in ["/", "?", "#"] {
            if let at = text.range(of: cut) { text = String(text[..<at.lowerBound]) }
        }
        if text.isEmpty { return nil }

        var host = text
        var port = DEFAULT_DAEMON_PORT

        if text.hasPrefix("[") {
            guard let close = text.firstIndex(of: "]") else { return nil }
            host = String(text[text.index(after: text.startIndex)..<close])
            let rest = String(text[text.index(after: close)...])
            if rest.hasPrefix(":") {
                guard let parsed = parsePort(String(rest.dropFirst())) else { return nil }
                port = parsed
            } else if !rest.isEmpty {
                return nil
            }
        } else {
            let colons = text.filter { $0 == ":" }.count
            if colons == 1 {
                guard let at = text.lastIndex(of: ":") else { return nil }
                guard let parsed = parsePort(String(text[text.index(after: at)...])) else { return nil }
                host = String(text[..<at])
                port = parsed
            } else if colons > 1 {
                // A bare IPv6 literal carries its own colons and no port, so a
                // trailing `:9120` cannot be told from part of the address.
                host = text
            }
        }

        if host.isEmpty { return nil }
        return DaemonAddress(host: host, port: port)
    }

    private static func parsePort(_ text: String) -> Int? {
        guard !text.isEmpty, text.count <= 5, text.allSatisfy({ $0.isASCII && $0.isNumber }),
              let value = Int(text), value >= 1, value <= 65535 else { return nil }
        return value
    }

    /// Handshake header a client uses to say WHICH device it is. Approval needs
    /// an identity, and the source address stops being one behind NAT, where
    /// every device shares it. Not proof: the link is plaintext, so anything in
    /// the handshake is replayable by a passive observer — as true of the
    /// existing token. The win is granularity and revocation, not secrecy.
    static let DEVICE_ID_HEADER = "x-agentdeck-device"

    /// Characters in a device id — 128 bits, same shape as the auth token.
    static let DEVICE_ID_LENGTH = 32

    /// Strict on purpose: this string is a map key and an approved row, so a
    /// client must not be able to vary its own identity between connects and
    /// appear as several devices — or outlive a revocation that way.
    static func normalizeDeviceId(_ input: String?) -> String? {
        guard let trimmed = input?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              trimmed.count == DEVICE_ID_LENGTH,
              trimmed.allSatisfy({ $0.isHexDigit && ($0.isNumber || $0.isLowercase) })
        else { return nil }
        return trimmed
    }

    /// Short form for a row the operator reads — never used as a key.
    static func shortDeviceId(_ id: String) -> String {
        guard let normalized = normalizeDeviceId(id) else { return id }
        return String(normalized.prefix(8))
    }
}
