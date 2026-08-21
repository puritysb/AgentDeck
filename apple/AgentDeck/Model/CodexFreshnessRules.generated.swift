// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/format-utils.ts (CODEX_SNAPSHOT_STALE_MS, codexUsageFootnote,
// codexSnapshotMatchesAccountPlan, codexSnapshotOutranks, CHATGPT_PLAN_DISPLAY_NAMES)
// Regenerate: pnpm generate-codex-freshness-rules (drift gated by shared/src/__tests__/codex-freshness-rules.test.ts)

import Foundation

/// Freshness of a passively-read Codex usage snapshot.
///
/// Two axes, deliberately separate — never fold one into the other:
///   • `stale` (on the window)  the window has ENDED; slot-based consumers
///     (Pixoo renderers, ESP32 firmware) drop the gauge entirely on it.
///   • `capturedAt` (here)      when the value was measured. An old reading of
///     a still-live window keeps rendering, dimmed, with its age shown.
///
/// Derived against the local clock at paint time, never from a producer-set
/// boolean — such a flag freezes between pushes exactly like the percentage it
/// is meant to qualify.
enum CodexUsageFreshness {
    /// How old a snapshot may get before its numbers stop reading as live.
    /// ABSOLUTE on purpose: a fraction of the window length would scale to 8h+
    /// on the weekly window and never fire, which is the hole this closes.
    static let snapshotStaleInterval: TimeInterval = 1800

    /// Age of a snapshot in seconds, or nil when unknown/unparseable.
    static func snapshotAge(_ capturedAt: String?, now: Date = Date()) -> TimeInterval? {
        guard let capturedAt, !capturedAt.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        guard let date = fractional.date(from: capturedAt) ?? plain.date(from: capturedAt) else { return nil }
        return max(0, now.timeIntervalSince(date))
    }

    /// True when the snapshot is too old to present as live. A missing stamp is
    /// "unknown", NOT "old" — a producer that sends none must not leave every
    /// Codex gauge permanently dimmed.
    static func isSnapshotAged(
        _ capturedAt: String?,
        now: Date = Date(),
        maxAge: TimeInterval = snapshotStaleInterval
    ) -> Bool {
        guard let age = snapshotAge(capturedAt, now: now) else { return false }
        return age > maxAge
    }

    /// Compact "when was this measured" label: "34m ago", "3h ago", "2d ago".
    /// Rounds DOWN so it never overstates freshness.
    static func formatSnapshotAge(_ capturedAt: String?, now: Date = Date()) -> String? {
        guard let age = snapshotAge(capturedAt, now: now) else { return nil }
        let minutes = Int(age / 60)
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        return "\(hours / 24)d ago"
    }

    /// The one footnote a Codex gauge prints under its percentage. Three states,
    /// resolved identically on every surface:
    ///
    ///   • window ended (`stale`) → "stale",  dim — the number no longer applies
    ///   • snapshot aged          → "3h ago", dim — last true reading, not live
    ///   • live                   → nil            — caller prints its countdown
    ///
    /// `stale` wins over age: an ended window is a stronger statement than an old read.
    static func footnote(stale: Bool, capturedAt: String?, now: Date = Date()) -> String? {
        if stale { return "stale" }
        guard isSnapshotAged(capturedAt, now: now) else { return nil }
        return formatSnapshotAge(capturedAt, now: now) ?? "stale"
    }
}

/// Which plan a passively-read Codex usage snapshot belongs to.
///
/// A THIRD axis, independent of the two above: freshness asks "how current is
/// this number", this asks "is it still this account's number at all". Codex
/// stamps `plan_type` into every `rate_limits` snapshot it writes, and the live
/// tier is read separately from `auth.json`. When they disagree the snapshot was
/// minted under a plan the account no longer holds, and neither freshness axis
/// can retire it — `stale` waits for `resetsAt` (a retired weekly window stays
/// future-dated for up to 7 days) and `capturedAt` only dims, because an aged
/// reading of a LIVE window is still that window's last true value.
///
/// Mirrored on the Swift daemon only: both daemons PRODUCE the wire snapshot, so
/// both must void it identically. Pure consumers (Android, firmware) already
/// hide-if-absent and need no copy.
enum CodexPlanRules {
    /// True when the ChatGPT tier carries no paid Codex subscription.
    static func isFreePlan(_ plan: String?) -> Bool {
        return normalized(plan) == "free"
    }

    /// True when the snapshot still belongs to the plan the account holds.
    /// Unknown on either side matches: absence is "no information", never a
    /// licence to void real data (an API-key install reports no account tier, a
    /// pre-`plan_type` rollout reports no snapshot tier).
    static func snapshotMatchesAccountPlan(snapshot: String?, account: String?) -> Bool {
        let snap = normalized(snapshot)
        let acct = normalized(account)
        if snap.isEmpty || acct.isEmpty { return true }
        return snap == acct
    }

    /// Rank one snapshot against another for the live account tier.
    ///
    /// Recency alone is the wrong ordering: a snapshot that will be VOIDED a step
    /// later must not first win the selection. Codex stamps `plan_type` from the
    /// auth token the WRITING PROCESS started with, so a session opened before a
    /// plan change keeps appending old-plan snapshots for as long as it stays
    /// open — and, being the busiest session, keeps minting the newest timestamps
    /// too. A newest-wins picker hands the void rule a mismatched snapshot on
    /// every build and every gauge goes blank, while a valid same-plan snapshot
    /// sits unread in another rollout.
    ///
    /// Plan agreement is the PRIMARY key, age only the tie-break; exact ties keep
    /// the incumbent. This orders snapshots, it never rescues one — a mismatched
    /// snapshot that wins for lack of a peer is still voided downstream.
    ///
    /// Capture stamps are seconds-since-epoch so "unknown" can be `-.infinity`
    /// and order without a second date parse.
    static func snapshotOutranks(
        candidatePlan: String?,
        candidateCapturedAt: TimeInterval,
        incumbentPlan: String?,
        incumbentCapturedAt: TimeInterval,
        account: String?
    ) -> Bool {
        let candidateMatches = snapshotMatchesAccountPlan(snapshot: candidatePlan, account: account)
        let incumbentMatches = snapshotMatchesAccountPlan(snapshot: incumbentPlan, account: account)
        if candidateMatches != incumbentMatches { return candidateMatches }
        return candidateCapturedAt > incumbentCapturedAt
    }

    private static func normalized(_ value: String?) -> String {
        return (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

/// Display name for a raw `chatgpt_plan_type`.
///
/// Generated so the daemons cannot disagree about what an account is called. The
/// mapping had already drifted into three hand-written Swift call sites once,
/// each passing an unrecognised plan through verbatim; keeping it hand-mirrored
/// against the TS copy repeated that at the platform level — OpenAI mints tiers
/// on its own schedule (`prolite` arrived unannounced) and whichever copy was
/// not updated renders the fallback capitalisation for the same account.
///
/// Keys carry no separators: `prolite`, `pro_lite` and `pro lite` are one plan.
/// An unrecognised tier is capitalised, never dropped and never shown raw.
enum ChatGPTPlan {
    static func displayName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = trimmed.lowercased().filter { !$0.isWhitespace && $0 != "_" && $0 != "-" }
        switch key {
        case "free": return "ChatGPT Free"
        case "plus": return "ChatGPT Plus"
        case "pro": return "ChatGPT Pro"
        case "prolite": return "ChatGPT Pro Lite"
        case "team": return "ChatGPT Team"
        case "enterprise": return "ChatGPT Enterprise"
        default: return "ChatGPT " + trimmed.prefix(1).uppercased() + trimmed.dropFirst()
        }
    }
}
