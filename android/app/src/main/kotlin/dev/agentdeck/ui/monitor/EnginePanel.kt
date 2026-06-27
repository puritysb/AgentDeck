package dev.agentdeck.ui.monitor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign

import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.ModelCatalogEntry
import dev.agentdeck.net.OllamaStatus
import dev.agentdeck.net.SubscriptionInfo
import dev.agentdeck.net.AntigravityStatusInfo
import dev.agentdeck.net.UsageUpdate
import dev.agentdeck.state.DashboardState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.util.formatBytes
import dev.agentdeck.util.formatResetTime
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeParseException

/**
 * Right HUD panel — "TANK STATUS" aquarium-themed engine dashboard.
 * Water-level gauges for rate limits, model info, ollama models, connection LED dots.
 */
@Composable
fun TankStatusPanel(
    state: DashboardState,
    modifier: Modifier = Modifier,
) {
    val usage = state.usage
    val staleSuffix = if (usage.usageStale == true) " !" else ""
    val ollamaStatus = state.ollamaStatus
    val modelCatalog = state.modelCatalog ?: emptyList()
    // Catalog-ownership gate (mirrors Apple TopologyRail `catalogOwner == .openclaw`):
    // state.modelCatalog belongs to the focused/primary agent, so only render it
    // under the OpenClaw header when OpenClaw IS that agent — otherwise Claude's
    // catalog would show under "OpenClaw" whenever an OpenClaw sibling exists.
    // The raw `gatewayConnected` flag is intentionally dropped; ownership implies it.
    val openClawLines = if (state.agentType == "openclaw") {
        openClawDisplayLines(modelCatalog)
    } else {
        emptyList()
    }
    Column(
        modifier = modifier
            .background(TerrariumColors.HUDBg, RoundedCornerShape(8.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // Header
        Text(
            text = "\u223F TANK STATUS",
            color = TerrariumColors.HUDSubtext,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )

        // Water gauges: 5h + 7d side by side (subscription billing)
        if (usage.fiveHourPercent != null || usage.sevenDayPercent != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                if (usage.fiveHourPercent != null) {
                    WaterGauge(
                        label = "5h$staleSuffix",
                        percent = usage.fiveHourPercent,
                        resetTime = usage.fiveHourResetsAt?.let { formatResetTime(it) },
                    )
                }
                if (usage.sevenDayPercent != null) {
                    WaterGauge(
                        label = "7d$staleSuffix",
                        percent = usage.sevenDayPercent,
                        resetTime = usage.sevenDayResetsAt?.let { formatResetTime(it) },
                    )
                }
            }
        }

        // API billing: session cost gauge
        if (state.billingType == "api" && usage.costSpent != null) {
            ApiCostSection(
                costSpent = usage.costSpent,
                costLimit = usage.costLimit,
                resetTime = usage.resetTime?.let { formatResetTime(it) },
                stale = staleSuffix,
            )
        }

        EngineSection(
            title = "OpenClaw",
            lines = openClawLines,
            highlightedLine = openClawLines.firstOrNull(),
        )

        EngineSection(
            title = "MLX",
            lines = state.mlxModels,
        )

        EngineSection(
            title = "OLLAMA",
            lines = ollamaDisplayLines(ollamaStatus),
        )

        EngineSection(
            title = "Antigravity",
            lines = antigravityDisplayLines(state.antigravityStatus),
        )

        // Subscriptions row reads "wall clock now" so an expiring window
        // flips to "renewal needed" without depending on incidental state
        // changes — the ticker is shared with the HUD rail's footer.
        val now by rememberCurrentInstant()
        EngineSection(
            title = "Subscriptions",
            lines = subscriptionDisplayLines(state.subscriptions, now),
        )
    }
}

/**
 * Vertical water-level gauge — fills from bottom up.
 * Color transitions: green (<70%) → amber (70-90%) → red (≥90%).
 */
@Composable
private fun WaterGauge(
    label: String,
    percent: Double,
    resetTime: String?,
) {
    val pct = percent.coerceIn(0.0, 100.0)
    val fillFraction = (pct / 100.0).toFloat()
    val fillColor = when {
        pct >= 90 -> TerrariumColors.LEDRed
        pct >= 70 -> TerrariumColors.LEDAmber
        else -> TerrariumColors.LEDGreen
    }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        // Gauge label
        Text(
            text = label,
            color = TerrariumColors.HUDSubtext,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )

        // Gauge body — glass container with water fill
        Box(
            modifier = Modifier
                .size(width = 76.dp, height = 76.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(Color(0x20FFFFFF)),
            contentAlignment = Alignment.Center,
        ) {
            // Water fill from bottom
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight(fillFraction)
                    .align(Alignment.BottomCenter)
                    .background(fillColor.copy(alpha = 0.5f)),
            )

            // Percent overlay
            Text(
                text = "${pct.toInt()}%",
                color = TerrariumColors.HUDText,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                textAlign = TextAlign.Center,
            )
        }

        // Reset time
        if (resetTime != null) {
            Text(
                text = "\u27F2 $resetTime",
                color = TerrariumColors.HUDSubtext.copy(alpha = 0.7f),
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

/**
 * API billing cost display — horizontal bar gauge for cost/limit.
 */
@Composable
private fun ApiCostSection(
    costSpent: Double,
    costLimit: Double?,
    resetTime: String?,
    stale: String,
) {
    val tightStyle = PlatformTextStyle(includeFontPadding = false)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text = "API COST$stale",
            color = TerrariumColors.HUDSubtext,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            style = TextStyle(platformStyle = tightStyle),
        )

        if (costLimit != null && costLimit > 0) {
            val pct = (costSpent / costLimit * 100.0).coerceIn(0.0, 100.0)
            val fillFraction = (pct / 100.0).toFloat()
            val fillColor = when {
                pct >= 90 -> TerrariumColors.LEDRed
                pct >= 70 -> TerrariumColors.LEDAmber
                else -> TerrariumColors.LEDGreen
            }

            // Horizontal bar gauge
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(18.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(Color(0x20FFFFFF)),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth(fillFraction)
                        .fillMaxHeight()
                        .background(fillColor.copy(alpha = 0.5f)),
                )
                Text(
                    text = "${"%.2f".format(costSpent)} / ${"%.0f".format(costLimit)}",
                    color = TerrariumColors.HUDText,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.align(Alignment.Center),
                    style = TextStyle(platformStyle = tightStyle),
                )
            }
        } else {
            Text(
                text = "$${"%.2f".format(costSpent)}",
                color = TerrariumColors.HUDText,
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
                style = TextStyle(platformStyle = tightStyle),
            )
        }

        if (resetTime != null) {
            Text(
                text = "\u27F2 $resetTime",
                color = TerrariumColors.HUDSubtext.copy(alpha = 0.7f),
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                style = TextStyle(platformStyle = tightStyle),
            )
        }
    }
}

@Composable
private fun EngineSection(
    title: String,
    lines: List<String>,
    highlightedLine: String? = null,
) {
    if (lines.isEmpty()) return

    val tightStyle = PlatformTextStyle(includeFontPadding = false)
    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(
            text = title,
            color = TerrariumColors.HUDSubtext,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            style = TextStyle(platformStyle = tightStyle),
        )

        lines.forEach { line ->
            Text(
                text = line,
                color = if (line == highlightedLine) TerrariumColors.LEDAmber else TerrariumColors.HUDText,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                style = TextStyle(platformStyle = tightStyle),
                maxLines = 2,
            )
        }
    }
}

private fun ollamaDisplayLines(ollamaStatus: OllamaStatus?): List<String> {
    if (ollamaStatus == null || !ollamaStatus.available || ollamaStatus.models.isEmpty()) return emptyList()
    val running = ollamaStatus.models.filter { it.sizeVram > 0 }
    val source = if (running.isNotEmpty()) running else ollamaStatus.models
    val items = source.map { model ->
        val vramText = when {
            model.sizeVram > 0 -> " ${formatBytes(model.sizeVram)}"
            model.size > 0 -> " ${formatBytes(model.size)}"
            else -> ""
        }
        "${model.name}$vramText"
    }
    return if (items.isEmpty()) emptyList() else listOf(items.distinct().joinToString(", "))
}

// `openClawDisplayLines` and `normalizeOpenClawName` live in TopologyRail.kt
// (same package) so the HUD rail and the e-ink TANK STATUS panel stay in
// sync on the primary-only filter rule.

private fun subscriptionDisplayLines(
    subscriptions: List<SubscriptionInfo>,
    now: Instant,
): List<String> = subscriptions.map { formatSubscriptionLine(it, now) }

/**
 * Trailing label rendered to the right of the subscription name. `null`
 * means the subscription has no `until` field at all (e.g. Claude billing
 * type). When `until` is present but in the past or unparseable we surface
 * `"renewal needed"` (`expired = true`) so the user sees an actionable hint
 * — Codex writes `chatgpt_subscription_active_until` once at login and
 * never refreshes it on auto-renewal, so a stale past date is the common
 * case. Caller passes `now` so unit tests can pin time.
 */
internal data class SubscriptionTrailing(val text: String, val expired: Boolean)

internal fun subscriptionTrailing(until: String?, now: Instant): SubscriptionTrailing? {
    val raw = until?.trim().takeUnless { it.isNullOrEmpty() } ?: return null
    val parsed = parseUntilInstant(raw)
    if (parsed != null && parsed.isAfter(now)) {
        return SubscriptionTrailing(text = raw.take(10), expired = false)
    }
    return SubscriptionTrailing(text = "renewal needed", expired = true)
}

/**
 * Render one subscription row. Past or unparseable `until` becomes a
 * `"renewal needed"` hint instead of the stale date itself.
 */
internal fun formatSubscriptionLine(sub: SubscriptionInfo, now: Instant): String {
    val trailing = subscriptionTrailing(sub.until, now) ?: return sub.name
    return "${sub.name} · ${trailing.text}"
}

/**
 * Parse `SubscriptionInfo.until` to an `Instant`. Accepts ISO 8601 with
 * offset (`2026-05-15T00:00:00Z`), with fractional seconds, and bare date
 * (`2026-05-15`, treated as UTC midnight). Returns `null` for blank or
 * unparseable input.
 */
internal fun parseUntilInstant(input: String): Instant? {
    val trimmed = input.trim()
    if (trimmed.isEmpty()) return null
    return try {
        OffsetDateTime.parse(trimmed).toInstant()
    } catch (_: DateTimeParseException) {
        try {
            Instant.parse(trimmed)
        } catch (_: DateTimeParseException) {
            try {
                LocalDate.parse(trimmed).atStartOfDay().toInstant(ZoneOffset.UTC)
            } catch (_: DateTimeParseException) {
                null
            }
        }
    }
}

private fun antigravityDisplayLines(status: AntigravityStatusInfo?): List<String> {
    val planName = status?.planName?.takeIf { it.isNotBlank() } ?: return emptyList()
    return listOf(planName)
}
