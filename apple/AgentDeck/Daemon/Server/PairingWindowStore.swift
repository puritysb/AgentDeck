import Foundation

/// The daemon's operator-opened pairing window — Swift parity with the Node
/// daemon's `bridge/src/pairing-window.ts`.
///
/// A device that can neither scan a QR nor be handed a token over USB serial had
/// no way to pair with this daemon at all: the LAN surface is default-deny, a
/// tokenless peer is closed 4001, and since #149 it is not allowed to redial. An
/// e-ink reader is exactly that device. The operator opens a short window, reads
/// a six-digit code off their own screen, and types it on the reader.
///
/// The verdict rules are generated from the TS SSOT (`PairingCodeRules`), so both
/// daemons answer a redemption with the same status for the same inputs. What
/// lives here is only the mutable window, the CSPRNG, and the audit trail.
///
/// `@DaemonActor` because it is daemon state reached from the HTTP server, which
/// runs there — not `@MainActor`; see docs/architecture.md § Swift daemon
/// isolation.
@DaemonActor
final class PairingWindowStore {

    static let shared = PairingWindowStore()

    /// One device that successfully redeemed, for the operator's confirmation.
    struct Redemption: Sendable {
        let at: Date
        let ip: String
        /// Device-supplied label — untrusted display text, sanitized on the way in.
        let name: String
        /// Device-supplied kind hint (`android-eink`, …), or "unknown".
        let kind: String
    }

    struct Failure: Sendable {
        let at: Date
        let ip: String
    }

    private struct Active {
        var snapshot: PairingCodeRules.WindowSnapshot
        var redemptions: [Redemption] = []
        var failures: [Failure] = []
    }

    /// What the window that just closed achieved, kept after it is gone.
    ///
    /// The success case closes the window, and the operator learns the outcome by
    /// polling — so without this the two race and a pairing that worked is
    /// reported as "nothing paired". Carries no code and no token.
    private struct Receipt {
        var closedAt: Date
        var redemptions: [Redemption]
        var failures: [Failure]
    }

    private var active: Active?
    private var receipt: Receipt?

    /// How long a closed window's receipt stays readable. Callers poll at 1s.
    private static let receiptTTL: TimeInterval = 60

    private init() {}

    // MARK: - Operator side

    struct OpenedWindow: Sendable {
        let code: String
        let expiresAt: Date
        let redemptions: Int
    }

    /// Open a window, replacing any window already open.
    ///
    /// Replacing rather than refusing: an operator who asks twice wants the code
    /// on their screen to be the live one, and a stale window running beside it
    /// would be a second valid secret nobody is watching.
    func open(ttl: TimeInterval? = nil, redemptions: Int? = nil) -> OpenedWindow {
        // Clamped, not trusted — the window length IS the exposure. The floor
        // keeps a `--ttl 0` typo from opening a window that is already over.
        let seconds = min(max(ttl ?? Double(PairingCodeRules.windowMs) / 1000, 15), 600)
        let count = min(max(redemptions ?? PairingCodeRules.defaultRedemptions, 1), 16)
        let expiresAt = Date().addingTimeInterval(seconds)

        active = Active(snapshot: PairingCodeRules.WindowSnapshot(
            code: Self.mintCode(),
            expiresAt: Self.epochMs(expiresAt),
            failedAttempts: 0,
            redemptionsRemaining: count
        ))
        // A fresh window starts with a fresh receipt: the previous run's
        // redemptions must not be reported as if this window had paired them.
        receipt = nil

        let code = active!.snapshot.code
        DaemonLogger.shared.info(
            "Pairing window open for \(Int(seconds))s — code \(PairingCodeRules.format(code)), "
            + "\(count) device(s). Enter it on the device to pair without USB or a QR scan.")
        return OpenedWindow(code: code, expiresAt: expiresAt, redemptions: count)
    }

    /// Close the window early (operator cancelled, daemon standing down).
    func close() {
        guard active != nil else { return }
        DaemonLogger.shared.info("Pairing window closed.")
        closeActive()
    }

    /// True when `POST /pair` is a route at all. Consulted by the access policy.
    func isOpen(now: Date = Date()) -> Bool {
        current(now: now) != nil
    }

    /// Operator-facing status. Never includes the code — the opener has it.
    ///
    /// Boxed in `SendableDict` because the HTTP handler that reads it is
    /// nonisolated; a bare `[String: Any]` cannot cross the actor boundary.
    func status(now: Date = Date()) -> SendableDict {
        func rows(_ redemptions: [Redemption], _ failures: [Failure]) -> [String: Any] {
            [
                "redemptions": redemptions.map {
                    ["at": Self.epochMs($0.at), "ip": $0.ip, "name": $0.name, "kind": $0.kind]
                },
                "failures": failures.map { ["at": Self.epochMs($0.at), "ip": $0.ip] },
            ]
        }

        guard let window = current(now: now) else {
            let closed = validReceipt(now: now)
            var payload: [String: Any] = [
                "open": false, "expiresAt": NSNull(), "secondsRemaining": 0,
                "attemptsRemaining": 0, "redemptionsRemaining": 0,
            ]
            payload.merge(rows(closed?.redemptions ?? [], closed?.failures ?? [])) { _, new in new }
            return SendableDict(payload)
        }

        var payload: [String: Any] = [
            "open": true,
            "expiresAt": window.snapshot.expiresAt,
            "secondsRemaining": PairingCodeRules.secondsRemaining(
                window: window.snapshot, now: Self.epochMs(now)),
            "attemptsRemaining": PairingCodeRules.maxFailedAttempts - window.snapshot.failedAttempts,
            "redemptionsRemaining": window.snapshot.redemptionsRemaining,
        ]
        payload.merge(rows(window.redemptions, window.failures)) { _, new in new }
        return SendableDict(payload)
    }

    // MARK: - Device side

    struct RedeemResult: Sendable {
        let outcome: PairingCodeRules.Outcome
        let status: Int
        let attemptsRemaining: Int
        /// Present only on `.accepted`.
        let token: String?
    }

    /// Redeem a submitted code for the pairing token.
    ///
    /// `mintToken` is injected rather than read from `AuthManager` directly so a
    /// refused redemption provably never touches the credential, and so a token
    /// handover (`adoptPeerToken`) reaches a device pairing right now.
    func redeem(
        submitted: String?,
        ip: String,
        name: String?,
        kind: String?,
        now: Date = Date(),
        mintToken: () -> String
    ) -> RedeemResult {
        let window = current(now: now)
        let verdict = PairingCodeRules.evaluate(
            window: window?.snapshot, submitted: submitted, now: Self.epochMs(now))

        switch verdict.outcome {
        case .accepted:
            guard active != nil else { break }
            let label = Self.sanitize(name, fallback: "unnamed device")
            let kindLabel = Self.sanitize(kind, fallback: "unknown", maxLength: 24)
            active!.redemptions.append(Redemption(at: now, ip: ip, name: label, kind: kindLabel))
            active!.snapshot.redemptionsRemaining -= 1
            let token = mintToken()
            DaemonLogger.shared.info("Paired \(label) (\(kindLabel)) at \(ip) with a pairing code.")
            if verdict.closes { closeActive(now: now) }
            return RedeemResult(outcome: .accepted, status: verdict.status,
                                attemptsRemaining: verdict.attemptsRemaining, token: token)

        case .mismatch:
            guard active != nil else { break }
            active!.snapshot.failedAttempts += 1
            active!.failures.append(Failure(at: now, ip: ip))
            DaemonLogger.shared.info(
                "Pairing code refused for \(ip) — \(verdict.attemptsRemaining) attempt(s) left.")
            if verdict.closes {
                DaemonLogger.shared.info(
                    "Pairing window closed after too many wrong codes. Open a new one if that was you.")
                closeActive(now: now)
            }

        default:
            if verdict.closes { closeActive(now: now) }
        }

        return RedeemResult(outcome: verdict.outcome, status: verdict.status,
                            attemptsRemaining: verdict.attemptsRemaining, token: nil)
    }

    // MARK: - Internals

    /// The live window, or nil. Enforces expiry ON READ.
    ///
    /// Not by a timer: a timer that fires late — a sleeping laptop, a saturated
    /// executor — would extend the window past its promise, and the promise is
    /// the security property.
    private func current(now: Date = Date()) -> Active? {
        guard let window = active else { return nil }
        if Self.epochMs(now) >= window.snapshot.expiresAt {
            closeActive(now: now)
            return nil
        }
        return window
    }

    private func closeActive(now: Date = Date()) {
        guard let window = active else { return }
        receipt = Receipt(closedAt: now, redemptions: window.redemptions, failures: window.failures)
        active = nil
    }

    private func validReceipt(now: Date) -> Receipt? {
        guard let held = receipt else { return nil }
        if now.timeIntervalSince(held.closedAt) > Self.receiptTTL {
            receipt = nil
            return nil
        }
        return held
    }

    /// A uniformly random code.
    ///
    /// `random(in:)` uses `SystemRandomNumberGenerator` and is unbiased over the
    /// range, unlike `% 10^6` over a raw draw — the attempt cap's arithmetic
    /// assumes a flat distribution.
    private static func mintCode() -> String {
        let upperBound = Int(pow(10.0, Double(PairingCodeRules.digits)))
        let value = Int.random(in: 0..<upperBound)
        return String(format: "%0\(PairingCodeRules.digits)d", value)
    }

    /// Device-supplied strings are display text from an unauthenticated peer, and
    /// this one lands in a log line, which is a terminal.
    private static func sanitize(_ value: String?, fallback: String, maxLength: Int = 40) -> String {
        guard let value else { return fallback }
        let stripped = String(String.UnicodeScalarView(
            value.unicodeScalars.map { scalar in
                (scalar.value < 0x20 || scalar.value == 0x7f) ? " " : scalar
            }))
        let collapsed = stripped.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        if collapsed.isEmpty { return fallback }
        if collapsed.count > maxLength {
            return String(collapsed.prefix(maxLength - 1)) + "…"
        }
        return collapsed
    }

    private static func epochMs(_ date: Date) -> Int {
        Int(date.timeIntervalSince1970 * 1000)
    }

    /// Test seam — drops any window without logging an operator action.
    func resetForTests() {
        active = nil
        receipt = nil
    }
}
