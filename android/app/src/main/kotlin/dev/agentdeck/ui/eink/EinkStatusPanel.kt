package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.SessionMetrics
import dev.agentdeck.ui.component.BrandIcon
import dev.agentdeck.ui.monitor.rememberCurrentInstant
import dev.agentdeck.ui.monitor.subscriptionTrailing
import dev.agentdeck.util.codexLimitRows
import dev.agentdeck.util.formatCount
import dev.agentdeck.util.formatResetTime
import dev.agentdeck.util.formatUptime
import dev.agentdeck.util.gaugeBar

/**
 * RIGHT zone (32%) — Status panel for e-ink 3-zone layout.
 * Rate limits + engine/runtime sections.
 */
@Composable
fun EinkStatusPanel(
    state: DashboardState,
    modifier: Modifier = Modifier,
) {
    val monoStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    val usage = state.usage
    val metricsSnapshot by SessionMetrics.instance.metrics.collectAsState()

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // Connection
        val connIcon = if (state.bridgeConnected) "\u25CF" else "\u25CB"
        val connLabel = if (state.bridgeConnected) "CONNECTED" else "DISCONNECTED"
        Text(text = "Conn: $connIcon $connLabel", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)

        HorizontalDivider(thickness = 1.dp, color = Color.Black)

        // 5h rate limit + reset time
        usage.fiveHourPercent?.let { pct ->
            val bar = gaugeBar(pct)
            val reset = usage.fiveHourResetsAt?.let { formatResetTime(it) } ?: ""
            Text(text = "5h $bar ${pct.toInt()}%  $reset", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)
        }

        // 7d rate limit + reset time
        usage.sevenDayPercent?.let { pct ->
            val bar = gaugeBar(pct)
            val reset = usage.sevenDayResetsAt?.let { formatResetTime(it) } ?: ""
            Text(text = "7d $bar ${pct.toInt()}%  $reset", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)
        }

        // Codex (ChatGPT) rolling-window usage — own per-window stale flag, not
        // gated by Claude's usageStale. Brand mark identifies the provider so
        // the 5h/7d labels stay shared with the Claude rows above.
        codexLimitRows(state.codexRateLimits).forEach { row ->
            val bar = gaugeBar(row.percent)
            val reset = row.footnote ?: if (row.stale) "stale" else row.resetIso?.let { formatResetTime(it) } ?: ""
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BrandIcon(agentType = row.agentType, isEink = true, size = 11.dp)
                Text(
                    text = "${row.label} $bar ${row.percent.toInt()}%  $reset",
                    style = monoStyle,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }

        HorizontalDivider(thickness = 1.dp, color = Color.Black)

        // OpenClaw — strict primary-only filter (matches HUD rail). If no
        // model is tagged default the row collapses; promoting a non-default
        // entry would silently override the explicit rule.
        val openClawPrimary = if (state.gatewayConnected == true && state.agentType == "openclaw") {
            state.modelCatalog.orEmpty()
                .firstOrNull { it.available && it.role == "default" }
                ?.let { abbreviateModelName(it.name) }
        } else null
        if (openClawPrimary != null) {
            Text(text = "OpenClaw: $openClawPrimary", style = monoStyle, color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
            HorizontalDivider(thickness = 1.dp, color = Color.Black)
        }

        val ollama = state.ollamaStatus?.takeIf { it.available }?.models.orEmpty()
        val runningOllama = ollama.filter { it.sizeVram > 0 }
        val ollamaSource = if (runningOllama.isNotEmpty()) runningOllama else ollama
        if (ollamaSource.isNotEmpty()) {
            Text(
                text = "Ollama: ${ollamaSource.joinToString(", ") { abbreviateModelName(it.name) }}",
                style = monoStyle,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
            )
            HorizontalDivider(thickness = 1.dp, color = Color.Black)
        }

        if (state.mlxModels.isNotEmpty()) {
            Text(
                text = "MLX: ${state.mlxModels.joinToString(", ") { abbreviateModelName(it) }}",
                style = monoStyle,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
            )
            HorizontalDivider(thickness = 1.dp, color = Color.Black)
        }

        antigravityDisplayLine(state)?.let { line ->
            Text(text = "Antigravity: $line", style = monoStyle, color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
            HorizontalDivider(thickness = 1.dp, color = Color.Black)
        }

        if (state.subscriptions.isNotEmpty()) {
            // `rememberCurrentInstant` ticks every 60s so an expiring window
            // flips the suffix to "renewal needed" without depending on the
            // daemon to push another state update first.
            val now by rememberCurrentInstant()
            Text(
                text = "Subscription: ${state.subscriptions.joinToString(", ") { sub ->
                    val name = abbreviateModelName(sub.name)
                    val trailing = subscriptionTrailing(sub.until, now)
                    if (trailing != null) "$name ~${trailing.text}" else name
                }}",
                style = monoStyle,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
            )
            HorizontalDivider(thickness = 1.dp, color = Color.Black)
        }

        // Tokens
        val totalTok = usage.inputTokens.toLong() + usage.outputTokens.toLong()
        Text(text = "Tok: ${formatCount(totalTok)}", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)

        // Cost
        usage.estimatedCostUsd?.let {
            Text(text = "Cost: $${"%.2f".format(it)}", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)
        }

        // Messages + Uptime
        val msgCount = metricsSnapshot.messageCount
        val uptime = formatUptime(metricsSnapshot.connectedSince ?: 0L)
        Text(text = "Msg: $msgCount  UP: $uptime", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)
    }
}
