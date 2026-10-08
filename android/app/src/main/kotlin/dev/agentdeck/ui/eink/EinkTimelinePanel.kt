package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.state.TimelineEntry
import dev.agentdeck.state.recentTimelineDisplayGroups
import dev.agentdeck.state.timelineLatestActivityEntry
import dev.agentdeck.ui.component.BrandIcon
import dev.agentdeck.ui.component.agentDisplayLabel
import dev.agentdeck.ui.timeline.stripMarkdownInline
import dev.agentdeck.ui.timeline.timelineIconKey
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * E-ink timeline — **recent-activity view, no scroll**.
 *
 * Product decision (2026-07-05): the e-ink device is a glance surface. It does
 * not need a scrollable history — it needs to answer "what is happening right
 * now, and who is doing it" at a look. No LazyColumn, no "▼ NEW" affordance, no
 * partial-refresh ghosting from a moving list.
 *
 * Refinement (2026-07-06): one line was too sparse — the panel now renders the
 * newest meaningful entry LARGE (full attribution + activity text) plus up to
 * two older entries in a compact form below it. The count adapts to the newest
 * message's length so the layout never overflows: a long primary message keeps
 * the panel to just itself, a short one lets two more recent rows through. This
 * gives "두세개 정도까지" depending on the message, not a fixed list.
 *
 * E-ink rules still apply: black on white only, no animation, bracket ASCII
 * status glyph (high 1-bit coverage).
 */
@Composable
fun EinkTimelinePanel(
    entries: List<TimelineEntry>,
    modifier: Modifier = Modifier,
) {
    val layoutScale = rememberEinkLayoutScale()
    // Newest meaningful groups, newest first. groupConsecutive+displayGroups
    // drops low-signal rows and merges a turn's chat_start/response, so each
    // element is a real work unit rather than a stray tool row. Cap at 3 — the
    // most this glance surface renders even for the shortest messages.
    val recent = remember(entries) {
        recentTimelineDisplayGroups(entries, 3)
            .map(::timelineLatestActivityEntry)
            .asReversed()
    }

    Box(modifier = modifier.fillMaxSize().padding(layoutScale.contentPadding)) {
        val primary = recent.firstOrNull()
        if (primary == null) {
            Text(
                text = "IDLE — no active work",
                color = Color.Black,
                fontSize = layoutScale.sessionTitleFont,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.align(Alignment.Center),
            )
        } else {
            // Adaptive budget: the longer the primary message, the fewer older
            // rows we show, so a verbose response never pushes secondaries off
            // the panel. Thresholds are line-count proxies (chars), tuned for
            // the ~22sp primary / ~14sp secondary sizes below.
            val primaryLen = primary.summary.trim().length
            val secondaryBudget = when {
                primaryLen <= 90 -> 2
                primaryLen <= 240 -> 1
                else -> 0
            }
            val secondaries = recent.drop(1).take(secondaryBudget)

            Column(verticalArrangement = Arrangement.spacedBy(layoutScale.rowSpacing + 3.dp)) {
                EinkLatestActivity(
                    entry = primary,
                    taskLabel = resolveTaskLabel(primary, entries),
                    summaryMaxLines = if (secondaries.isEmpty()) 5 else 3,
                    showDetail = secondaries.isEmpty(),
                    layoutScale = layoutScale,
                )
                if (secondaries.isNotEmpty()) {
                    HorizontalDivider(thickness = 1.dp, color = Color.Black)
                    secondaries.forEach { entry ->
                        EinkSecondaryActivity(entry, layoutScale)
                    }
                }
            }
        }
    }
}

/** Resolve the enclosing task label (task_start.summary) for a turn row so
 *  "which task" shows even though the turn row itself only carries taskId. */
private fun resolveTaskLabel(entry: TimelineEntry, entries: List<TimelineEntry>): String? = when {
    entry.type == "task_start" || entry.type == "task_end" -> entry.summary.takeIf { it.isNotBlank() }
    entry.taskId != null -> entries.lastOrNull { it.type == "task_start" && it.taskId == entry.taskId }
        ?.summary?.takeIf { it.isNotBlank() }
    else -> null
}

@Composable
private fun EinkLatestActivity(
    entry: TimelineEntry,
    taskLabel: String?,
    summaryMaxLines: Int = 5,
    showDetail: Boolean = true,
    layoutScale: EinkLayoutScale,
) {
    val tight = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))
    val iconKey = timelineIconKey(entry.type, entry.status)
    val agent = agentDisplayLabel(entry.agentType)
    val project = entry.projectName?.takeIf { it.isNotBlank() }

    Column(verticalArrangement = Arrangement.spacedBy(layoutScale.rowSpacing + 3.dp)) {
        // ── Attribution header: brand glyph + agent + status marker ──
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!entry.agentType.isNullOrBlank()) {
                BrandIcon(agentType = entry.agentType, isEink = true, modifier = Modifier.size(28.dp))
            }
            Text(
                text = agent.ifEmpty { "Agent" },
                color = Color.Black,
                fontSize = (layoutScale.timelinePrimaryFont.value - 2f).sp,
                fontWeight = FontWeight.ExtraBold,
                fontFamily = FontFamily.Monospace,
                style = tight,
            )
            Text(
                text = iconKey.einkGlyph,
                color = Color.Black,
                fontSize = (layoutScale.timelinePrimaryFont.value - 4f).sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                style = tight,
            )
            Text(
                text = formatTime(entry.timestamp),
                color = Color.Black,
                fontSize = (layoutScale.sessionMetaFont.value + 2f).sp,
                fontFamily = FontFamily.Monospace,
                style = tight,
                modifier = Modifier.weight(1f),
            )
        }

        // ── project · task context line ──
        val context = listOfNotNull(project, taskLabel).joinToString("  ·  ")
        if (context.isNotEmpty()) {
            Text(
                text = context,
                color = Color.Black,
                fontSize = (layoutScale.timelineSecondaryFont.value - 1f).sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                style = tight,
            )
        }

        // ── the current activity text, large ──
        Text(
            text = entry.summary,
            color = Color.Black,
            fontSize = layoutScale.timelinePrimaryFont,
            fontWeight = FontWeight.Normal,
            maxLines = summaryMaxLines,
            overflow = TextOverflow.Ellipsis,
            style = tight,
        )

        // ── optional one-line detail (suppressed when older rows follow, to
        //    keep the primary block within its adaptive line budget) ──
        if (showDetail) {
            entry.detail
                ?.takeIf { it.isNotBlank() && entry.summaryKind != "none" && entry.summaryKind != "progress" }
                ?.let { detail ->
                    val plain = stripMarkdownInline(detail).replace("\n", " ").trim()
                    if (plain.isNotEmpty()) {
                        Text(
                            text = plain,
                            color = Color.Black,
                            fontSize = (layoutScale.timelineSecondaryFont.value - 1f).sp,
                            fontStyle = FontStyle.Italic,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            style = tight,
                        )
                    }
                }
        }
    }
}

/**
 * Compact prior-activity row shown beneath the primary block. One entry per
 * row: brand glyph + short agent + time on the header line, then the activity
 * text (up to two lines). Smaller than the primary so the newest work still
 * dominates the glance, but enough to answer "and what happened just before".
 */
@Composable
private fun EinkSecondaryActivity(entry: TimelineEntry, layoutScale: EinkLayoutScale) {
    val tight = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))
    val iconKey = timelineIconKey(entry.type, entry.status)
    val agent = agentDisplayLabel(entry.agentType)
    val summary = entry.summary.trim().takeIf { it.isNotEmpty() } ?: entry.type

    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!entry.agentType.isNullOrBlank()) {
                BrandIcon(agentType = entry.agentType, isEink = true, modifier = Modifier.size(18.dp))
            }
            Text(
                text = agent.ifEmpty { "Agent" },
                color = Color.Black,
                fontSize = (layoutScale.timelineSecondaryFont.value - 2f).sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                style = tight,
            )
            Text(
                text = iconKey.einkGlyph,
                color = Color.Black,
                fontSize = (layoutScale.timelineSecondaryFont.value - 3f).sp,
                fontFamily = FontFamily.Monospace,
                style = tight,
            )
            Text(
                text = formatShortTime(entry.timestamp),
                color = Color.Black,
                fontSize = layoutScale.sessionMetaFont,
                fontFamily = FontFamily.Monospace,
                style = tight,
                modifier = Modifier.weight(1f),
            )
        }
        Text(
            text = summary,
            color = Color.Black,
            fontSize = layoutScale.timelineSecondaryFont,
            fontWeight = FontWeight.Normal,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            style = tight,
        )
    }
}

private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.US)
private val shortTimeFormat = SimpleDateFormat("HH:mm", Locale.US)

private fun formatTime(timestamp: Long): String = timeFormat.format(Date(timestamp))
private fun formatShortTime(timestamp: Long): String = shortTimeFormat.format(Date(timestamp))
