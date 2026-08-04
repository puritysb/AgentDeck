package dev.agentdeck.util

import dev.agentdeck.net.CodexRateLimits
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import kotlin.math.roundToInt

/**
 * Format ISO 8601 timestamp to relative time string.
 * Mirrors bridge/src/usage-api.ts formatResetTime().
 * Handles both "Z" and "+00:00" timezone offset formats.
 */
fun formatResetTime(isoString: String): String {
    return try {
        // OffsetDateTime handles both "Z" and "+00:00" / "+09:00" etc.
        val resetAt = OffsetDateTime.parse(isoString).toInstant()
        val now = Instant.now()
        val diffMs = Duration.between(now, resetAt).toMillis()
        if (diffMs <= 0) return "now"
        val diffMin = (diffMs / 60_000).toInt()
        if (diffMin < 60) return "${diffMin}m"
        val h = diffMin / 60
        val m = diffMin % 60
        if (h < 24) return if (m > 0) "${h}h ${m}m" else "${h}h"
        val d = h / 24
        "${d}d ${h % 24}h"
    } catch (_: Exception) {
        isoString
    }
}

/** Format large numbers compactly: 1000→"1.0K", 1500000→"1.5M" */
fun formatCount(n: Long): String {
    return when {
        n < 1_000 -> n.toString()
        n < 1_000_000 -> "%.1fK".format(n / 1_000.0)
        else -> "%.1fM".format(n / 1_000_000.0)
    }
}

/** Overload for Int */
fun formatCount(n: Int): String = formatCount(n.toLong())

/** Generate ASCII gauge bar: "████░░" */
fun gaugeBar(percent: Double, width: Int = 6): String {
    val filled = ((percent / 100.0) * width).roundToInt().coerceIn(0, width)
    val empty = width - filled
    return "█".repeat(filled) + "░".repeat(empty)
}

/** Format byte sizes compactly: 1073741824 → "1.0G", 536870912 → "512M" */
fun formatBytes(bytes: Long): String = when {
    bytes >= 1_073_741_824 -> "%.1fG".format(bytes / 1_073_741_824.0)
    bytes >= 1_048_576 -> "%dM".format(bytes / 1_048_576)
    bytes >= 1_024 -> "%dK".format(bytes / 1_024)
    else -> "${bytes}B"
}

/** Format millisecond duration compactly: 45000 → "45s", 125000 → "2m 5s" */
fun formatDurationCompact(ms: Long): String {
    if (ms < 1000) return "<1s"
    val totalSec = (ms / 1000).toInt()
    val m = totalSec / 60
    val s = totalSec % 60
    return when {
        m == 0 -> "${s}s"
        s == 0 -> "${m}m"
        else -> "${m}m ${s}s"
    }
}

/**
 * One provider's usage-limit window, in a render-agnostic shape shared by every
 * LIMITS surface (HUD rail, e-ink panels, tablet card). The `agentType` lets the
 * renderer tag the row with a brand mark (the mark conveys the provider — labels
 * stay plain "5h"/"7d", matching the D200H convention). `resetIso` is the raw
 * ISO-8601 instant; format it at render time with [formatResetTime] so the
 * countdown stays current.
 */
data class ProviderLimitRow(
    val agentType: String,
    val label: String,
    val percent: Double,
    val resetIso: String?,
    val stale: Boolean,
    /** Codex freshness note ("stale" / "3h ago") from [CodexFreshnessRules.footnote]. When
     *  present it takes the reset slot and the row renders dimmed: a passively-read
     *  snapshot of a still-live window keeps its last true percent, but a weekly
     *  window's countdown says nothing about when that percent was measured. */
    val footnote: String? = null,
)

/**
 * Compact window label from a duration in minutes: whole days → "Nd", whole
 * hours → "Nh", else "Nm". Days checked first so 10080 → "7d". Single source for
 * both the HUD rail (TopologyRail) and the e-ink surfaces so the mapping can't
 * drift between them.
 */
fun windowLabel(minutes: Int?): String {
    val m = minutes ?: return "·"
    if (m <= 0) return "·"
    if (m % 1440 == 0) return "${m / 1440}d"
    if (m % 60 == 0) return "${m / 60}h"
    return "${m}m"
}

/**
 * Codex (ChatGPT) usage rows, mirroring the Claude 5h/7d layout. One row per
 * present window that carries a `usedPercent` (primary ≈ 5h, secondary ≈ 7d);
 * labels derive from each window's length. Each window carries its own `stale`
 * flag — Codex usage is NOT gated by Claude's `usageStale`. Returns an empty
 * list when no Codex limit data is present, so callers can simply append it.
 */
fun codexLimitRows(limits: CodexRateLimits?, nowMs: Long = System.currentTimeMillis()): List<ProviderLimitRow> {
    if (limits == null) return emptyList()
    return buildList {
        limits.primary?.let { p ->
            val pct = p.usedPercent
            if (pct != null) {
                add(
                    ProviderLimitRow(
                        "codex", windowLabel(p.windowMinutes), pct, p.resetsAt, p.stale == true,
                        CodexFreshnessRules.footnote(p.stale == true, limits.capturedAt, nowMs),
                    ),
                )
            }
        }
        limits.secondary?.let { s ->
            val pct = s.usedPercent
            if (pct != null) {
                add(
                    ProviderLimitRow(
                        "codex", windowLabel(s.windowMinutes), pct, s.resetsAt, s.stale == true,
                        CodexFreshnessRules.footnote(s.stale == true, limits.capturedAt, nowMs),
                    ),
                )
            }
        }
    }
}


/** Format duration from epoch millis to "H:MM" or "D:HH:MM" */
fun formatUptime(connectedSinceMs: Long): String {
    if (connectedSinceMs <= 0) return "0:00"
    val elapsed = System.currentTimeMillis() - connectedSinceMs
    if (elapsed < 0) return "0:00"
    val totalMin = (elapsed / 60_000).toInt()
    val h = totalMin / 60
    val m = totalMin % 60
    return if (h < 24) "%d:%02d".format(h, m) else {
        val d = h / 24
        "%d:%02d:%02d".format(d, h % 24, m)
    }
}
