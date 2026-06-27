package dev.agentdeck.ui.eink

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
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
import dev.agentdeck.state.GroupedEntry
import dev.agentdeck.state.TimelineEntry
import dev.agentdeck.state.groupConsecutive
import dev.agentdeck.state.timelineDisplayGroups
import dev.agentdeck.ui.timeline.stripMarkdownInline
import dev.agentdeck.ui.timeline.timelineDetailIsRedundant
import dev.agentdeck.ui.timeline.timelineIconKey
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * E-ink timeline list.
 *
 * E-ink-specific rules (versus tablet):
 *   - No color: only black text on white. Tints rendered as opacity collapse
 *     to grey on most panels, which then ghosts after partial refresh.
 *   - No animations: 400 ms B&W frame budget; the only motion allowed is the
 *     "▼ NEW" affordance the user explicitly opts into.
 *   - Bold ASCII bracket markers (`[OK]`, `[T ]`) instead of Unicode glyphs:
 *     bracket characters have high black coverage, so they survive 1-bit
 *     dither without thinning to invisibility.
 *   - Task headers render as **inverse video** full-width strips — the only
 *     visual hierarchy break in the list, which makes the "evaluation unit"
 *     legible at a glance even on slow refresh.
 */
@Composable
fun EinkTimelinePanel(
    entries: List<TimelineEntry>,
    modifier: Modifier = Modifier,
) {
    val recentEntries = remember(entries) {
        entries.takeLast(80)
    }
    val displayGroups = remember(recentEntries) {
        timelineDisplayGroups(groupConsecutive(recentEntries))
    }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    var lastSeenCount by remember { mutableIntStateOf(displayGroups.size) }
    val hasNewItems by remember(displayGroups.size) {
        derivedStateOf { displayGroups.size > lastSeenCount }
    }

    val isNearBottom by remember {
        derivedStateOf {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            lastVisible >= listState.layoutInfo.totalItemsCount - 2
        }
    }

    LaunchedEffect(displayGroups.size) {
        if (isNearBottom && displayGroups.isNotEmpty()) {
            listState.scrollToItem(displayGroups.size - 1)
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        if (displayGroups.isEmpty()) {
            Text(
                text = "No timeline events",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.align(Alignment.Center),
            )
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                items(
                    displayGroups,
                    key = { "${it.entry.timestamp}-${it.entry.type}-${it.entry.summary}-${it.count}" },
                ) { group ->
                    when (group.entry.type) {
                        "task_start" -> EinkTaskStartHeader(group)
                        "task_end" -> EinkTaskEndBar(group)
                        else -> EinkTimelineItem(group)
                    }
                    HorizontalDivider(thickness = 0.5.dp, color = Color.Black)
                }
            }

            if (hasNewItems && !isNearBottom) {
                Text(
                    text = "▼ NEW",
                    style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Bold),
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 8.dp)
                        .clickable {
                            scope.launch {
                                listState.scrollToItem(displayGroups.size - 1)
                                lastSeenCount = displayGroups.size
                            }
                        },
                )
            }
        }
    }
}

@Composable
private fun EinkTimelineItem(group: GroupedEntry) {
    val entry = group.entry
    val source = sourceLabel(entry)
    val countSuffix = if (group.count > 1) " (×${group.count})" else ""
    val tight = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))
    val iconKey = timelineIconKey(entry.type, entry.status)

    // Indent turn rows that belong to a task — visual cue mirroring the
    // tablet/Apple layout. Two leading spaces, monospaced, so the indent is
    // a constant pixel width on bitmap fonts.
    val indent = if (entry.taskId != null) "  " else ""

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        // Timestamp — 12 sp regular monospace.
        Text(
            text = formatTime(entry.timestamp),
            color = Color.Black,
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            style = tight,
        )

        // Status marker — bracket ASCII, high black coverage.
        Text(
            text = indent + iconKey.einkGlyph,
            color = Color.Black,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            style = tight,
        )

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (source.isNotEmpty()) {
                Text(
                    text = source,
                    color = Color.Black,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    style = tight,
                )
            }
            Text(
                text = entry.summary + countSuffix,
                color = Color.Black,
                fontSize = 16.sp,
                fontWeight = FontWeight.Normal,
                style = tight,
            )
            entry.detail?.takeIf { shouldShowEinkDetail(entry, it) }?.let { detail ->
                // Bridge ships chat detail with markdown markers preserved
                // (so the colour-screen TimelineMarkdownView can render
                // headings / tables / inline styles). E-ink is plain-text
                // only — strip markers here so the literal `**` / `##` etc.
                // don't leak into the panel.
                val plain = stripMarkdownInline(detail).replace("\n", " ").trim()
                if (plain.isNotEmpty()) {
                    Text(
                        text = plain,
                        color = Color.Black,
                        fontSize = 12.sp,
                        fontStyle = FontStyle.Italic,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = tight,
                    )
                }
            }
        }
    }
}

private fun shouldShowEinkDetail(entry: TimelineEntry, detail: String): Boolean {
    if (detail.isBlank()) return false
    if (entry.summaryKind == "none" || entry.summaryKind == "progress") return false
    return !timelineDetailIsRedundant(detail, entry.summary)
}

/**
 * task_start row — full-width inverse video (black bg / white text). The
 * single visual hierarchy break that the user can reliably parse on a slow
 * partial-refresh panel.
 */
@Composable
private fun EinkTaskStartHeader(group: GroupedEntry) {
    val entry = group.entry
    val source = sourceLabel(entry).takeIf { it.isNotEmpty() }
    val tight = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.Black)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = formatTime(entry.timestamp),
            color = Color.White,
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            style = tight,
        )
        Text(
            text = "[==] TASK",
            color = Color.White,
            fontSize = 16.sp,
            fontWeight = FontWeight.ExtraBold,
            fontFamily = FontFamily.Monospace,
            style = tight,
        )
        if (source != null) {
            Text(
                text = source,
                color = Color.White,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = tight,
            )
        }
        Text(
            text = entry.summary,
            color = Color.White,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = tight,
        )
    }
}

/**
 * task_end row — short capped strip with bottom black bar. Closes the visual
 * envelope started by task_start without consuming as much vertical space.
 */
@Composable
private fun EinkTaskEndBar(group: GroupedEntry) {
    val entry = group.entry
    val tight = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = formatTime(entry.timestamp),
                color = Color.Black,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                style = tight,
            )
            Text(
                text = "[==] TASK END",
                color = Color.Black,
                fontSize = 14.sp,
                fontWeight = FontWeight.ExtraBold,
                fontFamily = FontFamily.Monospace,
                style = tight,
            )
            Text(
                text = entry.summary,
                color = Color.Black,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = tight,
            )
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(Color.Black),
        )
    }
}

private fun sourceLabel(entry: TimelineEntry): String {
    val project = entry.projectName?.takeIf { it.isNotBlank() }
    val agent = when (entry.agentType) {
        "claude-code" -> "Claude"
        "codex-cli" -> "Codex CLI"
        "codex-app" -> "Codex App"
        "openclaw" -> "OpenClaw"
        "opencode" -> "OpenCode"
        "daemon" -> "Daemon"
        null -> ""
        else -> "Agent"
    }
    return when {
        project != null && agent.isNotEmpty() -> "[$project] $agent"
        project != null -> "[$project]"
        agent.isNotEmpty() -> "[$agent]"
        else -> ""
    }
}

private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.US)

private fun formatTime(timestamp: Long): String = timeFormat.format(Date(timestamp))
