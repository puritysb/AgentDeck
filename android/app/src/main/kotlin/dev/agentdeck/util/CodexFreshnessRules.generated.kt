// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/format-utils.ts (CODEX_SNAPSHOT_STALE_MS, codexUsageFootnote)
// Regenerate: pnpm generate-codex-freshness-rules (drift gated by shared/src/__tests__/codex-freshness-rules.test.ts)
package dev.agentdeck.util

import java.time.OffsetDateTime

/**
 * Freshness of a passively-read Codex usage snapshot.
 *
 * Two axes, deliberately separate — never fold one into the other:
 *  - `stale` (on the window): the window has ENDED; slot-based consumers
 *    (Pixoo renderers, ESP32 firmware) drop the gauge entirely on it.
 *  - `capturedAt` (here): when the value was measured. An old reading of a
 *    still-live window keeps rendering, dimmed, with its age shown.
 *
 * Derived against the local clock at paint time, never from a producer-set
 * boolean — such a flag freezes between pushes exactly like the percentage it
 * is meant to qualify.
 */
object CodexFreshnessRules {
    /**
     * How old a snapshot may get before its numbers stop reading as live.
     * ABSOLUTE on purpose: a fraction of the window length would scale to 8h+
     * on the weekly window and never fire, which is the hole this closes.
     */
    const val SNAPSHOT_STALE_MS: Long = 1800000L

    /** Age of a snapshot in ms, or null when unknown/unparseable. */
    fun snapshotAgeMs(capturedAt: String?, nowMs: Long = System.currentTimeMillis()): Long? {
        if (capturedAt.isNullOrEmpty()) return null
        val t = try {
            // OffsetDateTime handles both "Z" and "+09:00", with or without fraction.
            OffsetDateTime.parse(capturedAt).toInstant().toEpochMilli()
        } catch (_: Exception) {
            return null
        }
        return (nowMs - t).coerceAtLeast(0L)
    }

    /**
     * Compact "when was this measured" label: "34m ago", "3h ago", "2d ago".
     * Rounds DOWN so it never overstates freshness.
     */
    fun formatSnapshotAge(capturedAt: String?, nowMs: Long = System.currentTimeMillis()): String? {
        val age = snapshotAgeMs(capturedAt, nowMs) ?: return null
        val minutes = age / 60_000L
        if (minutes < 1) return "now"
        if (minutes < 60) return "${minutes}m ago"
        val hours = minutes / 60
        if (hours < 24) return "${hours}h ago"
        return "${hours / 24}d ago"
    }

    /**
     * The one footnote a Codex gauge prints under its percentage:
     *  - window ended (`stale`) -> "stale"  (the number no longer applies)
     *  - snapshot aged          -> "3h ago" (last true reading, not live)
     *  - live                   -> null     (caller prints its countdown)
     *
     * A missing stamp is "unknown", NOT "old" — a producer that sends none must
     * not leave every Codex gauge permanently dimmed.
     */
    fun footnote(
        stale: Boolean,
        capturedAt: String?,
        nowMs: Long = System.currentTimeMillis(),
    ): String? {
        if (stale) return "stale"
        val age = snapshotAgeMs(capturedAt, nowMs) ?: return null
        if (age <= SNAPSHOT_STALE_MS) return null
        return formatSnapshotAge(capturedAt, nowMs) ?: "stale"
    }
}
