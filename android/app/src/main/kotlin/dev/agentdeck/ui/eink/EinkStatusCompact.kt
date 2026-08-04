package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.ModuleHealthState
import dev.agentdeck.state.DashboardState
import dev.agentdeck.terrarium.renderer.einkColorEnabled
import dev.agentdeck.ui.component.BrandIcon
import dev.agentdeck.ui.monitor.rememberCurrentInstant
import dev.agentdeck.ui.monitor.subscriptionTrailing
import dev.agentdeck.util.ProviderLimitRow
import dev.agentdeck.util.codexLimitRows
import dev.agentdeck.util.formatBytes
import dev.agentdeck.util.formatResetTime
import kotlin.math.roundToInt

/**
 * E-ink status — 2-column layout: LIMITS (left) | MODELS (right).
 * Unicode block gauge (█░) for compact inline rate limit display.
 */
@Composable
fun EinkStatusCompact(
    state: DashboardState,
    modifier: Modifier = Modifier,
    showTankStatus: Boolean = true,
    showDeviceDiagnostic: Boolean = true,
) {
    if (!showTankStatus && !showDeviceDiagnostic) return

    if (!showTankStatus) {
        Column(
            modifier = modifier
                .fillMaxSize()
                .padding(horizontal = 6.dp, vertical = 0.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            SectionLabel("DEVICES")
            downstreamDeviceLine(state.moduleHealth)?.let { line ->
                DataLine(line, maxLines = 2)
            } ?: DataLine("No downstream devices", color = Color.DarkGray)
        }
        return
    }

    Row(
        modifier = modifier
            .fillMaxSize()
            .height(IntrinsicSize.Min)
            .padding(horizontal = 6.dp, vertical = 0.dp),
    ) {
        // Left: LIMITS (30%)
        Column(
            modifier = Modifier.weight(0.30f).fillMaxHeight().padding(end = 4.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            LimitsColumn(state)
        }

        VerticalDivider(thickness = 1.dp, color = Color.LightGray)

        // Right: MODELS (70%)
        Column(
            modifier = Modifier.weight(0.70f).fillMaxHeight().padding(start = 6.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            ModelsColumn(state, showDeviceDiagnostic)
        }
    }
}

// -- LIMITS column: Unicode block gauges --

private const val GAUGE_LEN = 8

/** Build a text gauge: █████░░░░░ */
private fun blockGauge(percent: Double): String {
    val filled = ((percent / 100.0).coerceIn(0.0, 1.0) * GAUGE_LEN).roundToInt()
    return "█".repeat(filled) + "░".repeat(GAUGE_LEN - filled)
}

@Composable
private fun LimitsColumn(state: DashboardState) {
    val usage = state.usage
    val has5h = usage.fiveHourPercent != null
    val has7d = usage.sevenDayPercent != null
    val hasLimits = state.billingType != "api" && (has5h || has7d)
    val stale = if (usage.usageStale == true) "!" else ""
    // Codex (ChatGPT) rolling-window usage — independent of Claude billing/limits
    // (a user may run only Codex). Each window carries its own stale flag.
    val codexRows = codexLimitRows(state.codexRateLimits)

    SectionLabel("LIMITS")

    if (hasLimits) {
        if (has5h) {
            val pct = usage.fiveHourPercent!!
            val reset = usage.fiveHourResetsAt?.let { formatResetTime(it) } ?: ""
            GaugeText("5h", pct, reset, stale)
        }
        if (has7d) {
            val pct = usage.sevenDayPercent!!
            val reset = usage.sevenDayResetsAt?.let { formatResetTime(it) } ?: ""
            GaugeText("7d", pct, reset, stale)
        }
    } else if (state.billingType == "api") {
        val cost = usage.costSpent
        val limit = usage.costLimit
        if (cost != null && limit != null && limit > 0) {
            val pct = (cost / limit * 100.0).coerceIn(0.0, 100.0)
            GaugeText("$${"%.2f".format(cost)}/$${"%.0f".format(limit)}", pct, "", stale)
        } else if (cost != null) {
            DataLine("$${"%.2f".format(cost)}$stale")
        } else {
            DataLine("API Key$stale")
        }
        val resetTimeStr = usage.resetTime?.let { formatResetTime(it) }
        if (resetTimeStr != null) {
            DataLine("\u27F2 $resetTimeStr")
        }
    }

    // Codex rows render after the Claude/API block; the brand mark distinguishes
    // them (labels stay 5h/7d).
    codexRows.forEach { CodexGaugeRow(it) }

    // Only collapse to the em-dash placeholder when no provider has anything.
    if (!hasLimits && state.billingType != "api" && codexRows.isEmpty()) {
        DataLine("—")
    }
}

@Composable
private fun CodexGaugeRow(row: ProviderLimitRow) {
    val staleMark = if (row.stale || row.footnote != null) "!" else ""
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BrandIcon(agentType = row.agentType, isEink = true, size = 12.dp)
        Text(
            text = "${row.label} ${blockGauge(row.percent)} ${row.percent.toInt()}%$staleMark",
            fontSize = 13.sp,
            lineHeight = 17.sp,
            fontFamily = FontFamily.Monospace,
            color = gaugeColor(row.percent),
            maxLines = 1,
        )
    }
    val reset = row.footnote ?: if (row.stale) "stale" else row.resetIso?.let { formatResetTime(it) } ?: ""
    if (reset.isNotEmpty()) {
        Text(
            text = "   ⟲ $reset",
            fontSize = 12.sp,
            lineHeight = 15.sp,
            fontFamily = FontFamily.Monospace,
            color = Color.DarkGray,
            maxLines = 1,
        )
    }
}

/** Color-code gauge by usage level on color e-ink: green < 60%, amber 60-85%, red > 85%. */
private fun gaugeColor(percent: Double): Color {
    if (!einkColorEnabled) return Color.Black
    return when {
        percent >= 85.0 -> Color(0xFFCC2222) // red — critical
        percent >= 60.0 -> Color(0xFFBB7700) // amber — warning
        else -> Color(0xFF227733)             // green — ok
    }
}

@Composable
private fun GaugeText(label: String, percent: Double, resetTime: String, stale: String) {
    val gauge = blockGauge(percent)
    Text(
        text = "$label $gauge ${percent.toInt()}%$stale",
        fontSize = 13.sp,
        lineHeight = 17.sp,
        fontFamily = FontFamily.Monospace,
        color = gaugeColor(percent),
        maxLines = 1,
    )
    if (resetTime.isNotEmpty()) {
        Text(
            text = "   \u27F2 $resetTime",
            fontSize = 12.sp,
            lineHeight = 15.sp,
            fontFamily = FontFamily.Monospace,
            color = Color.DarkGray,
            maxLines = 1,
        )
    }
}

// -- MODELS column (inline label: "Label: data" on one line) --

@Composable
private fun ModelsColumn(state: DashboardState, showDeviceDiagnostic: Boolean) {
    val labelColor = if (einkColorEnabled) Color(0xFF335588) else Color.DarkGray

    // OpenClaw — strict primary-only filter (matches HUD rail). If the user
    // hasn't tagged any model as default, the row collapses; promoting a
    // non-default entry would silently override the explicit rule.
    val openClawPrimary = if (state.gatewayConnected == true && state.agentType == "openclaw") {
        state.modelCatalog.orEmpty()
            .firstOrNull { it.available && it.role == "default" }
            ?.let { abbreviateModelName(it.name) }
    } else null
    if (openClawPrimary != null) {
        InlineModelLine("OpenClaw", openClawPrimary, labelColor = labelColor)
    }

    // Ollama
    val ollama = state.ollamaStatus?.takeIf { it.available }?.models.orEmpty()
    val runningOllama = ollama.filter { it.sizeVram > 0 }
    val ollamaSource = if (runningOllama.isNotEmpty()) runningOllama else ollama
    if (ollamaSource.isNotEmpty()) {
        val models = ollamaSource.joinToString(", ") { m ->
            val sizeStr = if (m.sizeVram > 0) " ${formatBytes(m.sizeVram)}"
                else if (m.size > 0) " ${formatBytes(m.size)}"
                else ""
            "${abbreviateModelName(m.name)}$sizeStr"
        }
        InlineModelLine("Ollama", models, labelColor = labelColor, maxLines = 2)
    }

    // MLX
    if (state.mlxModels.isNotEmpty()) {
        InlineModelLine(
            "MLX",
            state.mlxModels.joinToString(", ") { abbreviateModelName(it) },
            labelColor = labelColor,
        )
    }

    // Subscriptions — `rememberCurrentInstant` ticks every 60s so an
    // expired window flips from its date suffix to "renewal needed"
    // without depending on incidental state changes.
    if (state.subscriptions.isNotEmpty()) {
        val now by rememberCurrentInstant()
        InlineModelLine(
            "Subscription",
            state.subscriptions.joinToString(", ") { sub ->
                val name = abbreviateModelName(sub.name)
                val trailing = subscriptionTrailing(sub.until, now)
                if (trailing != null) "$name ~${trailing.text}" else name
            },
            labelColor = labelColor,
            dataColor = if (einkColorEnabled) Color(0xFF227733) else Color.Black,
        )
    }

    // Antigravity
    antigravityDisplayLine(state)?.let { line ->
        InlineModelLine(
            "Antigravity",
            line,
            labelColor = labelColor,
            dataColor = if (einkColorEnabled) Color(0xFF335588) else Color.Black,
        )
    }

    if (showDeviceDiagnostic) {
        InlineModelLine(
            "Devices",
            downstreamDeviceLine(state.moduleHealth) ?: "No downstream devices",
            labelColor = labelColor,
            dataColor = if (state.moduleHealth == null) Color.DarkGray else Color.Black,
            maxLines = 2,
        )
    }
}

private fun downstreamDeviceLine(health: ModuleHealthState?): String? {
    if (health == null) return null

    val labels = mutableListOf<String>()
    val streamDeckCount = health.streamDeck?.devices.orEmpty().size
    if (streamDeckCount > 0) labels += countLabel("StreamDeck", streamDeckCount)

    health.d200h?.let { d200h ->
        labels += if (d200h.connected) "D200H" else "D200H off"
    }

    val pixoo = health.pixoo
    if ((pixoo?.configuredDeviceCount ?: 0) > 0) {
        labels += countLabel("Pixoo", pixoo!!.configuredDeviceCount)
    }

    val serialBoards = health.serial?.connectedBoards.orEmpty()
    if (serialBoards.isNotEmpty()) labels += countLabel("ESP32", serialBoards.size)

    val adb = health.adb
    if (adb != null) {
        val eInkCount = adb.classifiedDevices.count { it.deviceClass.startsWith("e-ink.") }
        val tabletCount = adb.classifiedDevices.count { it.deviceClass == "android.tablet" }
        val tc001Count = adb.classifiedDevices.count { it.deviceClass == "ulanzi.tc001" }
        if (eInkCount > 0) labels += countLabel("E-ink", eInkCount)
        if (tabletCount > 0) labels += countLabel("Tablet", tabletCount)
        if (tc001Count > 0) labels += countLabel("TC001", tc001Count)
        if (labels.isEmpty() && adb.lastError != null) labels += "ADB error"
    }

    return labels.takeIf { it.isNotEmpty() }?.joinToString(", ")
}

private fun countLabel(label: String, count: Int): String {
    return if (count > 1) "$label:$count" else label
}

// -- Shared --

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        fontSize = 12.sp,
        lineHeight = 15.sp,
        fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace,
        color = if (einkColorEnabled) Color(0xFF335588) else Color.DarkGray,
        modifier = Modifier.padding(bottom = 1.dp),
    )
}

@Composable
private fun DataLine(text: String, maxLines: Int = 1, color: Color = Color.Black) {
    Text(
        text = text,
        fontSize = 13.sp,
        lineHeight = 17.sp,
        fontFamily = FontFamily.Monospace,
        color = color,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth(),
    )
}

/** Inline label + data on a single line: "Label: data" with bold colored label. */
@Composable
private fun InlineModelLine(
    label: String,
    data: String,
    labelColor: Color = Color.DarkGray,
    dataColor: Color = Color.Black,
    maxLines: Int = 1,
) {
    Text(
        text = buildAnnotatedString {
            withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = labelColor)) {
                append("$label: ")
            }
            withStyle(SpanStyle(color = dataColor)) {
                append(data)
            }
        },
        fontSize = 13.sp,
        lineHeight = 17.sp,
        fontFamily = FontFamily.Monospace,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth(),
    )
}
