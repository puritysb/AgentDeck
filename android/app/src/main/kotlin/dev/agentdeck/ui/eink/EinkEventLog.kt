package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.Color
import dev.agentdeck.state.GroupedEntry
import dev.agentdeck.state.TimelineEntry
import dev.agentdeck.state.groupConsecutive
import dev.agentdeck.state.timelineDisplayGroups
import dev.agentdeck.terrarium.renderer.einkColorEnabled
import dev.agentdeck.ui.timeline.stripMarkdownInline
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Compact event log for e-ink center column.
 * Shows the most recent grouped events with large monospace text.
 */
@Composable
fun EinkEventLog(
    entries: List<TimelineEntry>,
    modifier: Modifier = Modifier,
) {
    val scrollState = rememberScrollState()
    val recent = remember(entries) {
        entries
            .takeLast(40)
    }
    val grouped = remember(recent) {
        timelineDisplayGroups(groupConsecutive(recent)).takeLast(10)
    }

    // Auto-scroll to bottom when new entries arrive
    LaunchedEffect(recent.size) {
        scrollState.animateScrollTo(scrollState.maxValue)
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(8.dp)
            .verticalScroll(scrollState),
    ) {
        Text(
            text = "TIMELINE",
            style = MaterialTheme.typography.bodySmall.copy(
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                lineHeight = 16.sp,
                fontWeight = FontWeight.Bold,
            ),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 4.dp),
        )
        if (grouped.isEmpty()) {
            Text(
                text = "No events yet",
                style = MaterialTheme.typography.bodySmall.copy(
                    fontFamily = FontFamily.Monospace,
                ),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            grouped.forEach { group ->
                val entry = group.entry
                val time = formatTimeHHMM(entry.timestamp)
                val sourceTag = sourceTag(entry)
                val icon = typeIcon(entry.type, entry.status)
                val eventColor = typeColor(entry.type, entry.status)
                val countSuffix = if (group.count > 1) " (×${group.count})" else ""
                val line = "$time $sourceTag$icon ${entry.summary}$countSuffix"
                // Bridge ships chat detail with markdown markers preserved
                // for the colour-screen renderer; e-ink is plain-text only,
                // so strip markers before displaying the inline detail line.
                val plainDetail = entry.detail?.let { stripMarkdownInline(it) }?.replace("\n", " ")?.trim()
                val hasDetail = !plainDetail.isNullOrEmpty() && plainDetail != entry.summary
                Text(
                    text = line,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 15.sp,
                        lineHeight = 21.sp,
                        fontWeight = if (entry.type == "chat_start") FontWeight.Bold else FontWeight.Normal,
                    ),
                    color = eventColor ?: MaterialTheme.colorScheme.onSurface,
                    maxLines = if (hasDetail) 2 else 1,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (hasDetail) {
                    Text(
                        text = "  $plainDetail",
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 13.sp,
                            lineHeight = 17.sp,
                        ),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = 4.dp),
                    )
                }
            }
        }
    }
}

private val timeFormat = SimpleDateFormat("HH:mm", Locale.US)

private fun formatTimeHHMM(timestamp: Long): String {
    return timeFormat.format(Date(timestamp))
}

private fun typeIcon(type: String, status: String? = null): String = when (type) {
    "tool_request" -> when (status) {
        "approved" -> "✓"
        "denied" -> "✗"
        else -> "⚠"
    }
    "tool_resolved" -> "✓"
    "tool_exec" -> "▸"
    "model_call" -> "◆"
    "model_response" -> "◇"
    "chat_start" -> "▶"
    "chat_end" -> "■"
    "chat_response" -> "◇"
    "memory_recall" -> "⦻"
    "error" -> "✗"
    "scheduled" -> "⏰"
    "user_action" -> "☞"
    "state_change" -> "△"
    "eval_result" -> "★"
    // Task hierarchy — semantic mapping mirrors timelineIconKey()
    // (shared/src/timeline-icons.ts): task_start/task_end → task, milestone → success.
    "task_start", "task_end" -> "▣"
    "task_milestone" -> "✓"
    else -> "·"
}

/** Color-code timeline events by type on color e-ink (matches tablet typeColor). */
private fun typeColor(type: String, status: String?): Color? {
    if (!einkColorEnabled) return null
    return when (type) {
        "chat_start", "chat_end" -> Color(0xFF227733)   // green — chat lifecycle
        "chat_response" -> Color(0xFF335588)             // blue — model response
        "tool_request" -> when (status) {
            "denied" -> Color(0xFFCC2222)                // red — denied
            else -> Color(0xFFBB7700)                    // amber — pending/approved
        }
        "tool_resolved", "tool_exec" -> Color(0xFF557722)// olive — tool done
        "model_call", "model_response" -> Color(0xFF335588) // blue — model
        "error" -> Color(0xFFCC2222)                     // red — error
        "memory_recall" -> Color(0xFF775599)             // purple — memory
        "eval_result" -> Color(0xFFBB7700)                // amber — evaluation
        else -> null
    }
}

private fun sourceTag(entry: TimelineEntry): String {
    val project = entry.projectName?.takeIf { it.isNotBlank() }
    if (project != null) return "[$project] "
    return when (entry.agentType) {
        "claude-code" -> "Claude "
        "openclaw" -> "OpenClaw "
        "codex-cli" -> "Codex CLI "
        "codex-app" -> "Codex App "
        "opencode" -> "OpenCode "
        "antigravity" -> "Antigravity "
        "kiro-cli" -> "Kiro CLI "
        "kiro-ide" -> "Kiro IDE "
        null -> ""
        else -> "Agent "
    }
}
