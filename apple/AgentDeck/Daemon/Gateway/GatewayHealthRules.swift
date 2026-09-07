#if os(macOS)
// GatewayHealthRules.swift — how an OpenClaw Gateway `health` frame becomes
// the `gatewayHasError` flag.
//
// A deliberate near-transliteration of shared/src/gateway-health.ts (a rule
// restated in different words is a rule that can drift), replayed by both
// suites through shared/gateway-health-vectors.json.
//
// The flag has one loud consumer shape: the OpenClaw creature turns SICK and
// the topology LED turns red on every surface. So the rule answers THREE
// questions, not two — healthy, unhealthy, and "this frame did not say".
// Both daemons used to collapse the third into the second (`!(ok ?? false)`),
// so a frame carrying no usable `ok` read as a failure and the creature stayed
// sick until the next frame happened to carry one — up to OpenClaw's 300 s
// health-monitor interval.

import Foundation

struct GatewayHealthVerdict: Sendable, Equatable {
    /// False when the frame said nothing usable — the caller RETAINS its
    /// previous value rather than inventing one.
    let known: Bool
    /// Only meaningful when `known`.
    let hasError: Bool
    /// Which part of the payload decided it, for the transition log.
    let reason: String
    /// The failing check/status name, when there was one.
    let detail: String?
}

enum GatewayHealthRules {
    /// A status word that means "not healthy" wherever a payload uses one.
    static let unhealthyStatus: Set<String> = [
        "error", "warn", "degraded", "unhealthy", "fail", "failed", "down",
    ]

    private static func statusOf(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed.lowercased()
    }

    private static let unreadable = GatewayHealthVerdict(
        known: false, hasError: false, reason: "unreadable", detail: nil)

    /// Read a Gateway health payload. Order mirrors the Swift adapter's
    /// existing ladder: an explicit `ok` boolean wins, then a `checks` array,
    /// then a top-level `status` string. Anything else is `known: false`.
    static func resolve(_ payload: [String: Any]?) -> GatewayHealthVerdict {
        guard let payload else { return unreadable }

        // `as? Bool` also matches NSNumber 0/1, which is what a JSON boolean
        // decodes to through JSONSerialization — that is the intended match.
        // A string "yes" or NSNull is not a verdict.
        if let ok = payload["ok"] as? Bool, !(payload["ok"] is String) {
            return GatewayHealthVerdict(known: true, hasError: !ok, reason: "ok_field", detail: nil)
        }

        if let checks = payload["checks"] as? [[String: Any]] {
            for check in checks {
                guard let status = statusOf(check["status"]), unhealthyStatus.contains(status) else { continue }
                let name = (check["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                return GatewayHealthVerdict(
                    known: true, hasError: true, reason: "checks",
                    detail: (name?.isEmpty == false) ? name : status)
            }
            // An empty `checks` array is a frame that ran no checks, not a pass.
            if checks.isEmpty { return unreadable }
            return GatewayHealthVerdict(known: true, hasError: false, reason: "checks", detail: nil)
        }

        if let status = statusOf(payload["status"]) {
            return GatewayHealthVerdict(
                known: true, hasError: unhealthyStatus.contains(status),
                reason: "status_field", detail: status)
        }

        return unreadable
    }
}
#endif
