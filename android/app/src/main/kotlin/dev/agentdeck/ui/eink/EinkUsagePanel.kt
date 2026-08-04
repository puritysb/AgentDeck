package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.UsageUpdate
import dev.agentdeck.util.codexLimitRows

@Composable
fun EinkUsagePanel(
    usage: UsageUpdate,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Rate limit bars. The brand mark identifies the provider so Claude and
        // Codex rows read as distinct (labels stay 5h/7d).
        if (usage.fiveHourPercent != null) {
            val isApi = usage.costLimit != null && usage.costLimit > 0
            EinkTextGauge(
                label = if (isApi) "API" else "5h",
                percent = usage.fiveHourPercent,
                agentType = if (isApi) null else "claude-code",
            )
        }
        if (usage.sevenDayPercent != null) {
            EinkTextGauge(label = "7d", percent = usage.sevenDayPercent, agentType = "claude-code")
        }
        // Per-model scoped weekly caps (e.g. "Fable"). Monochrome e-ink → just
        // surface each one beneath 7d.
        usage.scopedLimits?.forEach { s ->
            EinkTextGauge(label = s.label.trim().take(8), percent = s.percent, agentType = "claude-code")
        }
        // Codex (ChatGPT) rolling-window usage — own per-window stale flag. Keep
        // stale windows (marked "*") so an idle Codex 7d row doesn't vanish; the
        // brand mark identifies the provider (labels stay 5h/7d).
        codexLimitRows(usage.codexRateLimits).forEach { row ->
            EinkTextGauge(label = row.label, percent = row.percent, agentType = row.agentType, stale = row.stale || row.footnote != null)
        }

        // Token counters
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = "In: ${formatCount(usage.inputTokens)}",
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = "Out: ${formatCount(usage.outputTokens)}",
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = "Tool: ${usage.toolCalls}",
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurface,
            )
        }

        // Duration + cost
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = formatDuration(usage.sessionDurationSec),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (usage.estimatedCostUsd != null) {
                Text(
                    text = "$${String.format("%.4f", usage.estimatedCostUsd)}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

/**
 * Compact single-line usage for portrait header.
 */
@Composable
fun EinkUsageCompact(
    usage: UsageUpdate,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (usage.fiveHourPercent != null) {
            val pct = usage.fiveHourPercent.coerceIn(0.0, 100.0).toInt()
            val filled = (pct / 10).coerceAtMost(10)
            val empty = 10 - filled
            val bar = "\u2588".repeat(filled) + "\u2591".repeat(empty)
            val isApi = usage.costLimit != null && usage.costLimit > 0
            Text(
                text = "${if (isApi) "API" else "5h"}: [$bar] $pct%",
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
        Text(
            text = "Tok: ${formatCount(usage.inputTokens + usage.outputTokens)}",
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
