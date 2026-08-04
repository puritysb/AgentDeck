// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/format-utils.ts (CODEX_SNAPSHOT_STALE_MS, codexUsageFootnote)
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
