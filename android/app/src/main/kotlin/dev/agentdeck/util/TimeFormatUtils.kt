package dev.agentdeck.util

import dev.agentdeck.net.CodexCredits
import dev.agentdeck.net.CodexLunaReserve
import dev.agentdeck.net.CodexRateLimits
import dev.agentdeck.net.ZaiRateLimits
import dev.agentdeck.net.ZaiWindow
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
    /** `percent` is what REMAINS (the Codex Luna reserve), not what is used.
     *  Renderers fill by it and colour by [usedPercent]. */
    val remaining: Boolean = false,
    /** A reading that is not a percentage — the remaining Codex credit balance
     *  ("62.5K"). When set, renderers print it in place of the percent and draw
     *  no bar and no severity colour: a balance has no cap to fill against, so
     *  a bar would be a fake percentage. [percent] is 0 and meaningless. */
    val value: String? = null,
) {
    /** The consumed share, whichever way [percent] reads — the colour ramp input. */
    val usedPercent: Double get() = if (remaining) 100.0 - percent else percent
}

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
    // An exhausted account window hands the Codex rows to what the account can
    // still spend — the cross-surface rule (UsagePresentation): the purchased
    // credit balance, and the Luna reserve read as what is LEFT. Every Android
    // Codex block has room for both, so both show; credits lead because they
    // are what the account is actually drawing down.
    val credits = activeCodexCredits(limits, nowMs)
    val luna = activeLunaReserve(limits, nowMs)
    if (credits != null || luna != null) {
        return listOfNotNull(
            credits?.let {
                ProviderLimitRow(
                    "codex", "credits", 0.0, it.regularResetsAt, false,
                    value = UsagePresentation.formatCreditBalance(it.balance),
                )
            },
            luna?.let {
                ProviderLimitRow(
                    "codex", "luna", (100.0 - it.usedPercent).coerceIn(0.0, 100.0),
                    it.resetsAt, false, remaining = true,
                )
            },
        )
    }
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

/**
 * The Luna reserve while it replaces the account windows — mirror of
 * `selectedLunaReserve` (shared/src/usage-presentation.ts) with the generated
 * [UsagePresentation.lunaActive] predicate. A reported reserve alone is not
 * exhaustion: only a live account window at 100% selects it.
 */
fun activeLunaReserve(limits: CodexRateLimits?, nowMs: Long = System.currentTimeMillis()): CodexLunaReserve? {
    val reserve = limits?.lunaReserve ?: return null
    fun epoch(iso: String?): Long? = iso?.let { runCatching { OffsetDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() }
    if (epoch(reserve.resetsAt)?.let { it <= nowMs } == true) return null
    fun live(w: dev.agentdeck.net.CodexRateLimitWindow?): Double {
        val used = w?.usedPercent ?: return -1.0
        if (w.stale == true) return -1.0
        if (epoch(w.resetsAt)?.let { it <= nowMs } == true) return -1.0
        return used
    }
    return reserve.takeIf { UsagePresentation.lunaActive(live(limits.primary), live(limits.secondary), it.usedPercent) }
}

/** Remaining credits while they replace an exhausted plan window. */
data class ActiveCodexCredits(
    /** Remaining balance; +Infinity when unlimited. */
    val balance: Double,
    /** When the exhausted plan window resets and credits stop being spent. */
    val regularResetsAt: String?,
)

/**
 * The numeric balance [UsagePresentation.creditsActive] reads — mirror of
 * `codexCreditBalance` (shared/src/usage-presentation.ts). Codex reports the
 * balance as a string ("62500"); `hasCredits: false` is an explicit zero.
 */
fun codexCreditBalance(credits: CodexCredits?): Double {
    if (credits == null) return -1.0
    if (credits.unlimited == true) return Double.POSITIVE_INFINITY
    if (credits.hasCredits == false) return 0.0
    val n = credits.balance?.trim()?.takeIf { it.isNotEmpty() }?.toDoubleOrNull() ?: return -1.0
    return if (n.isFinite()) n else -1.0
}

/**
 * The credits reading once a plan window is exhausted — mirror of
 * `selectedCodexCredits` (shared/src/usage-presentation.ts) with the generated
 * [UsagePresentation.creditsActive] predicate. A zero or unreported balance
 * with an exhausted window means nothing is being spent, so it returns null.
 */
fun activeCodexCredits(limits: CodexRateLimits?, nowMs: Long = System.currentTimeMillis()): ActiveCodexCredits? {
    if (limits == null) return null
    fun epoch(iso: String?): Long? = iso?.let { runCatching { OffsetDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() }
    fun live(w: dev.agentdeck.net.CodexRateLimitWindow?): Double {
        val used = w?.usedPercent ?: return -1.0
        if (w.stale == true) return -1.0
        if (epoch(w.resetsAt)?.let { it <= nowMs } == true) return -1.0
        return used
    }
    val balance = codexCreditBalance(limits.credits)
    if (!UsagePresentation.creditsActive(live(limits.primary), live(limits.secondary), balance)) return null
    // The LATEST exhausted reset: credits are spent until every exhausted
    // window is back, so the earlier reset would promise relief too soon.
    val regularResetsAt = listOfNotNull(limits.primary, limits.secondary)
        .filter { live(it) >= 100 && epoch(it.resetsAt) != null }
        .maxByOrNull { epoch(it.resetsAt)!! }
        ?.resetsAt
    return ActiveCodexCredits(balance, regularResetsAt)
}

/**
 * Codex + z.ai usage rows in one display list — every LIMITS surface renders
 * THIS so the two providers' order cannot drift between surfaces (#348).
 * Codex keeps the established seat, z.ai follows.
 */
fun providerLimitRows(
    codex: CodexRateLimits?,
    zai: ZaiRateLimits?,
    nowMs: Long = System.currentTimeMillis(),
): List<ProviderLimitRow> = codexLimitRows(codex, nowMs) + zaiLimitRows(zai, nowMs)

/**
 * z.ai (GLM Coding Plan) usage rows — the same window grammar as the Codex
 * rows. The `agentType` "zai" resolves to the upstream z.ai mark in the
 * BrandIcon registry (design/brand/zai.svg), so these gauges carry the real
 * provider logo like [codexLimitRows] carries the Codex mark. The MCP
 * tool-call quota labels by its QUANTITY ("mcp"), never its length. NOT gated
 * by Claude's `usageStale`; each window carries its own stale flag (#348).
 */
fun zaiLimitRows(limits: ZaiRateLimits?, nowMs: Long = System.currentTimeMillis()): List<ProviderLimitRow> {
    if (limits == null) return emptyList()
    return buildList {
        // The MCP tool-call quota is labeled by its QUANTITY, not its length —
        // "MCP" must never read as token usage.
        fun label(w: ZaiWindow): String =
            if (w.quantity == "mcp") "mcp" else windowLabel(w.windowMinutes)
        limits.primary?.let { p ->
            val pct = p.usedPercent
            if (pct != null) {
                add(
                    ProviderLimitRow(
                        "zai", label(p), pct, p.resetsAt, p.stale == true,
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
                        "zai", label(s), pct, s.resetsAt, s.stale == true,
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
