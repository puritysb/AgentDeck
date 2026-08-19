#if os(macOS)
// How old is a relayed usage reading, and may we use it at all?
//
// Tier 1 usage comes from a sibling bridge over `GET /usage`, which answers
// `{ usage, fetchedAt }`. The age gate that decides whether to accept it lived
// inline as:
//
//     if let fetchedAt = json["fetchedAt"] as? Int, fetchedAt > 0 { …gate… }
//
// which conflates three different situations into one `if`. When the condition
// failed — no stamp, a zero stamp, or a non-Int — the whole block was skipped,
// so the reading lost the five-minute gate AND arrived with no `fetchedAt`,
// and the caller then stamped `Date()` on it. Numbers of unknown age were
// recorded as just-fetched, which is the one reading that can never go stale:
// `usageStaleTTL` measures against that stamp.
//
// That branch was unreachable while every Node result advanced the producer's
// clock. It stopped being unreachable the moment the Node daemon correctly
// refused to advance `lastApiFetchTime` on a non-live apply (2026-08-19), which
// made `fetchedAt: 0` a real pair for a bridge whose only cached numbers came
// from a failed fetch's fallback. The producer now refuses to serve those, but
// a consumer that treats a missing stamp as "now" is wrong on its own terms and
// on any producer, so the rule is enforced here too.
//
// The repository rule this restates: **absence of a timestamp is "unknown",
// never "fresh" and never "old"** — the same rule `capturedAt` follows on the
// Codex gauges. Unknown age is not usable as a relay source; it is not an
// error either, just a sibling we skip.

import Foundation

/// What a relayed usage payload's `fetchedAt` tells us.
enum UsageRelayFreshness: Equatable {
    /// Stamped, and inside the acceptance window. Carries epoch **seconds**,
    /// which is the unit `ApiUsageData.fetchedAt` uses.
    case usable(fetchedAtSeconds: Double)
    /// Stamped, but older than the window — a sibling worth skipping.
    case tooOld
    /// No usable stamp. Cannot be aged, so it cannot be relayed; treating it
    /// as fresh is what put unstaleable numbers on the dashboard.
    case unknownAge
}

enum UsageRelay {
    /// Readings older than this are not relayed.
    static let maxAgeMs = 5 * 60 * 1000

    /// Classify a `/usage` payload's stamp.
    ///
    /// `fetchedAtMs` is whatever came off the wire: `nil` when the key is
    /// absent or not a number, `0` when the producer has numbers but has never
    /// completed a live fetch. Both mean the same thing to us — we cannot say
    /// how old this is.
    static func classify(fetchedAtMs: Int?, nowMs: Int) -> UsageRelayFreshness {
        guard let fetchedAtMs, fetchedAtMs > 0 else { return .unknownAge }
        let ageMs = nowMs - fetchedAtMs
        // A stamp from the future is a clock disagreement between two local
        // processes, not a fresh reading. Accept it rather than skip — the
        // sibling is on this machine — but never let it read as negative age.
        if ageMs > maxAgeMs { return .tooOld }
        return .usable(fetchedAtSeconds: Double(fetchedAtMs) / 1000.0)
    }
}
#endif
