package dev.agentdeck.ui.monitor

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.state.GroupedEntry
import dev.agentdeck.state.TimelineEntry
import dev.agentdeck.state.groupConsecutive
import dev.agentdeck.state.isProgressChatResponse
import dev.agentdeck.state.timelineDisplayGroups
import dev.agentdeck.state.timelineLifecycleBounds
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.ui.theme.DesignTokens
import dev.agentdeck.ui.component.BrandIcon
import dev.agentdeck.ui.component.agentDisplayLabel
import dev.agentdeck.ui.timeline.TimelineIconKey
import dev.agentdeck.ui.timeline.TimelineMarkdownView
import dev.agentdeck.ui.timeline.isRotatingEntry
import dev.agentdeck.ui.timeline.rowSummary
import dev.agentdeck.ui.timeline.stripMarkdownForSummary
import dev.agentdeck.ui.timeline.turnHasLaterCompletion
import dev.agentdeck.ui.timeline.timelineDetailIsRedundant
import dev.agentdeck.ui.timeline.timelineIconKey
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Bottom HUD strip — adapts between two layouts:
 *   - **Regular** (tablet, phone landscape): 65/35 row with right-side detail pane.
 *   - **Compact** (phone portrait): single-column with tap-to-expand inline detail.
 * Picked via `rememberTimelineLayoutMode()` (orientation + smallestScreenWidthDp).
 */
@Composable
fun TimelineStrip(
    entries: List<TimelineEntry>,
    modifier: Modifier = Modifier,
    scale: MonitorLayoutScale = rememberMonitorLayoutScale(),
) {
    val layoutMode = rememberTimelineLayoutMode()
    val listState = rememberLazyListState()
    val displayEntries = remember(entries) { entries.takeLast(80) }
    val grouped = remember(displayEntries) {
        timelineDisplayGroups(groupConsecutive(displayEntries)).takeLast(50)
    }

    var focusedIndex by remember { mutableIntStateOf(-1) }
    var expandedIndex by remember { mutableIntStateOf(-1) }

    val focusedGroup: GroupedEntry? = when {
        grouped.isEmpty() -> null
        focusedIndex < 0 || focusedIndex >= grouped.size -> grouped.lastOrNull()
        else -> grouped[focusedIndex]
    }

    LaunchedEffect(grouped.size) {
        if (grouped.isNotEmpty() && focusedIndex < 0) {
            listState.animateScrollToItem(grouped.lastIndex)
        }
    }
    // When the device rotates between Compact and Regular, reset expand state
    // so we don't carry an inline expansion into a layout that doesn't render it.
    LaunchedEffect(layoutMode) { expandedIndex = -1 }

    Column(modifier = modifier.fillMaxWidth()) {
        when (layoutMode) {
            TimelineLayoutMode.Regular -> Row(
                modifier = Modifier.fillMaxWidth().weight(1f),
            ) {
                Column(
                    modifier = Modifier
                        .weight(0.65f)
                        .fillMaxHeight()
                        .padding(start = 8.dp, top = 4.dp, bottom = 4.dp),
                ) {
                    TimelineHeader(scale = scale)
                    // weight(1f, fill = false) bounds the LazyColumn's height
                    // to the column's remaining space — required because a
                    // scrollable composable measured with infinite max height
                    // either eagerly renders every item or throws at runtime.
                    TimelineList(
                        listState = listState,
                        grouped = grouped,
                        focusedIndex = focusedIndex,
                        expandedIndex = -1,
                        allowExpand = false,
                        displayEntries = displayEntries,
                        scale = scale,
                        onClick = { idx -> focusedIndex = idx },
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }
                Box(
                    modifier = Modifier
                        .fillMaxHeight()
                        .width(1.dp)
                        .padding(vertical = 8.dp)
                        .background(TerrariumColors.HUDSubtext.copy(alpha = 0.3f)),
                )
                DetailPane(
                    focusedGroup = focusedGroup,
                    entries = displayEntries,
                    scale = scale,
                    modifier = Modifier
                        .weight(0.35f)
                        .fillMaxHeight()
                        .padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
                )
            }
            TimelineLayoutMode.Compact -> Column(
                modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = 4.dp, vertical = 4.dp),
            ) {
                TimelineHeader(scale = scale)
                // weight(1f, fill = false): bound LazyColumn height to the
                // remaining vertical space in the compact column.
                TimelineList(
                    listState = listState,
                    grouped = grouped,
                    focusedIndex = focusedIndex,
                    expandedIndex = expandedIndex,
                    allowExpand = true,
                    displayEntries = displayEntries,
                    scale = scale,
                    onClick = { idx ->
                        expandedIndex = if (expandedIndex == idx) -1 else idx
                        focusedIndex = idx
                    },
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
        }
    }
}

/**
 * Continuous rotation angle for the in-flight ("running") status icon.
 * Returns 0 when inactive so non-running rows pay zero animation cost.
 * 1.8 s linear cycle — slow enough to read, fast enough to feel alive.
 * Mirrors Apple's `symbolEffect(.rotate, options: .repeating)`.
 */
@Composable
private fun rememberRunningRotation(active: Boolean): Float {
    if (!active) return 0f
    val transition = rememberInfiniteTransition(label = "timelineRunning")
    val angle by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1800, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "angle",
    )
    return angle
}

@Composable
private fun TimelineHeader(scale: MonitorLayoutScale) {
    Text(
        text = "TIMELINE",
        color = TerrariumColors.HUDSubtext,
        fontSize = scale.fontSub,
        fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace,
        modifier = Modifier.padding(bottom = 2.dp),
    )
}

@Composable
private fun TimelineList(
    listState: androidx.compose.foundation.lazy.LazyListState,
    grouped: List<GroupedEntry>,
    focusedIndex: Int,
    expandedIndex: Int,
    allowExpand: Boolean,
    displayEntries: List<TimelineEntry>,
    scale: MonitorLayoutScale,
    onClick: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (grouped.isEmpty()) {
        Text(
            text = "No events yet",
            color = TerrariumColors.HUDSubtext,
            fontSize = scale.fontSub,
            fontFamily = FontFamily.Monospace,
            modifier = modifier,
        )
    } else {
        LazyColumn(
            state = listState,
            verticalArrangement = Arrangement.spacedBy(0.dp),
            modifier = modifier,
        ) {
            itemsIndexed(grouped) { index, group ->
                val isSelected = index == focusedIndex ||
                    (focusedIndex < 0 && index == grouped.lastIndex)
                Column {
                    CompactLogRow(
                        group = group,
                        isSelected = isSelected,
                        allowMultiline = allowExpand,
                        scale = scale,
                        siblings = displayEntries,
                        onClick = { onClick(index) },
                    )
                    if (allowExpand && expandedIndex == index) {
                        InlineDetailPane(group = group, entries = displayEntries, scale = scale)
                    }
                }
            }
        }
    }
}

/**
 * Compact single-line log row dispatcher: a task hierarchy entry renders as
 * a full-width header strip; everything else is a normal turn row.
 */
@Composable
private fun CompactLogRow(
    group: GroupedEntry,
    isSelected: Boolean,
    allowMultiline: Boolean,
    scale: MonitorLayoutScale,
    siblings: List<TimelineEntry>,
    onClick: () -> Unit,
) {
    val entry = group.entry
    if (entry.type == "task_start" || entry.type == "task_end") {
        TaskHeaderRow(
            group = group,
            isSelected = isSelected,
            scale = scale,
            siblings = siblings,
            onClick = onClick,
        )
    } else {
        TurnRow(
            group = group,
            isSelected = isSelected,
            allowMultiline = allowMultiline,
            scale = scale,
            siblings = siblings,
            onClick = onClick,
        )
    }
}

@Composable
private fun TurnRow(
    group: GroupedEntry,
    isSelected: Boolean,
    allowMultiline: Boolean,
    scale: MonitorLayoutScale,
    siblings: List<TimelineEntry>,
    onClick: () -> Unit,
) {
    val entry = group.entry
    val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
    val timeStr = timeFormat.format(Date(entry.timestamp))
    // A merged chat_start turn is completed once its response/chat_end folded in
    // — swap the perpetually-Running chat_start icon to the completed glyph and
    // stop the spinner, matching Apple's hasResponse-aware row. An unmerged turn
    // whose completion exists elsewhere in the buffer counts too.
    val isCompletedTurn = entry.type == "chat_start" &&
        (group.hasResponse || turnHasLaterCompletion(entry, siblings))
    val iconKey = if (isCompletedTurn) dev.agentdeck.ui.timeline.TimelineIconKey.Success
        else timelineIconKey(entry.type, entry.status)
    val iconColor = if (isCompletedTurn) typeColor("chat_response") else typeColor(entry.type)
    val countSuffix = if (group.count > 1) " ×${group.count}" else ""
    val isChatEnd = entry.type == "chat_end"
    val sessionLabel = rowPrefixLabel(entry)
    val tight = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))

    Column(modifier = Modifier.fillMaxWidth()) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .background(
                if (isSelected) Color(0x20FFFFFF) else Color.Transparent,
            )
            // Selection indicator drawn via drawBehind so toggling it doesn't
            // shift row content right (was an inline first-child Box). The
            // bar lands at x = -6.dp, sitting in the parent LazyColumn's
            // horizontal padding without competing for row width.
            .drawBehind {
                if (isSelected) {
                    val w = 2.dp.toPx()
                    val h = 14.dp.toPx()
                    val xLeft = -6.dp.toPx()
                    val yMid = (size.height - h) / 2f
                    drawRect(
                        color = iconColor,
                        topLeft = Offset(xLeft, yMid),
                        size = Size(w, h),
                    )
                }
            }
            .clickable(onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Indent under task headers so turns visually belong to the task above.
        if (entry.taskId != null) Spacer(modifier = Modifier.width(8.dp))

        Text(
            text = timeStr,
            color = TerrariumColors.HUDSubtext.copy(alpha = if (isChatEnd) 0.4f else 0.5f),
            fontSize = scale.fontSub,
            fontFamily = FontFamily.Monospace,
            style = tight,
        )
        // Animate the leading icon when the row is in flight (running icon
        // key, or an open task_start whose task_end hasn't arrived). Non-
        // rotating rows get angle=0 from the helper and skip the infinite
        // transition entirely. Mirrors `isRotatingEntry` in shared.
        val rowAngle = rememberRunningRotation(
            active = !isCompletedTurn && isRotatingEntry(entry, siblings),
        )
        Icon(
            imageVector = iconKey.materialIcon,
            contentDescription = iconKey.name,
            tint = iconColor.copy(alpha = if (isChatEnd) 0.6f else 1f),
            modifier = Modifier
                .width(12.dp)
                .height(12.dp)
                .rotate(rowAngle),
        )
        Box(
            modifier = Modifier
                .width(12.dp)
                .height(12.dp),
            contentAlignment = Alignment.Center,
        ) {
            BrandIcon(
                agentType = entry.agentType,
                isEink = false,
                size = 10.dp,
            )
        }
        if (sessionLabel.isNotEmpty()) {
            Text(
                text = sessionLabel,
                color = TerrariumColors.HUDSubtext.copy(alpha = if (isChatEnd) 0.55f else 0.75f),
                fontSize = scale.fontSub,
                fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                // Wide enough for "[project] · Agent" — 96dp cut real labels
                // to "[OpenClaw] · Cl…", losing the attribution it exists for.
                modifier = Modifier.widthIn(max = if (scale.isTablet) 150.dp else 110.dp),
                style = tight,
            )
        }
        Text(
            // Strip lightweight markdown so `**bold**` / `## heading` don't
            // leak into the row as literal characters, and collapse newlines so
            // a multi-line prompt fills the row instead of ellipsizing at its
            // first line break. The detail pane (or compact inline-expand)
            // still renders the full markdown.
            text = rowSummary(entry.summary) + countSuffix,
            color = if (isChatEnd) TerrariumColors.HUDText.copy(alpha = 0.6f) else TerrariumColors.HUDText,
            fontSize = scale.fontSub,
            fontFamily = FontFamily.Monospace,
            maxLines = if (allowMultiline) 2 else 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
            style = tight,
        )
    }

        // Sub-line: assistant response body merged into this turn. Indented +
        // dimmed so the prompt above stays the primary reading anchor. Mirrors
        // apple/AgentDeck/UI/Monitor/TimelineStripView.swift turnRow sub-lines.
        val subIndent = if (entry.taskId != null) 64.dp else 56.dp
        group.mergedResponse?.let { resp ->
            if (!isProgressChatResponse(resp)) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Spacer(modifier = Modifier.width(subIndent))
                    Text(
                        text = "→",
                        color = TerrariumColors.HUDSubtext.copy(alpha = 0.55f),
                        fontSize = scale.fontSub,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.Monospace,
                        style = tight,
                    )
                    Text(
                        text = rowSummary(resp.summary),
                        color = TerrariumColors.HUDText.copy(alpha = 0.78f),
                        fontSize = scale.fontSub,
                        fontFamily = FontFamily.Monospace,
                        maxLines = if (allowMultiline) 3 else 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                        style = tight,
                    )
                }
            }
        }

        // Sub-line: terminator metadata ("Completed · Ns · topic").
        group.mergedCompletion?.let { end ->
            if (end.summaryKind != "progress") {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Spacer(modifier = Modifier.width(subIndent))
                    Text(
                        text = rowSummary(end.summary),
                        color = TerrariumColors.HUDSubtext.copy(alpha = 0.7f),
                        fontSize = scale.fontSub,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                        style = tight,
                    )
                }
            }
        }
    }
}

@Composable
private fun TaskHeaderRow(
    group: GroupedEntry,
    isSelected: Boolean,
    scale: MonitorLayoutScale,
    siblings: List<TimelineEntry>,
    onClick: () -> Unit,
) {
    val entry = group.entry
    val isEnd = entry.type == "task_end"
    val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
    val timeStr = timeFormat.format(Date(entry.timestamp))
    val accent = TerrariumColors.TetraNeon
    val sessionLabel = rowPrefixLabel(entry)
    val tight = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(3.dp))
            .background(accent.copy(alpha = if (isSelected) 0.18f else 0.08f))
            // Selection indicator drawn outside the row's content area so
            // toggling it doesn't shift text right (was an inline first-child
            // Box). Sits at x = -6.dp inside the parent LazyColumn padding.
            .drawBehind {
                if (isSelected) {
                    val w = 2.dp.toPx()
                    val h = 18.dp.toPx()
                    val xLeft = -6.dp.toPx()
                    val yMid = (size.height - h) / 2f
                    drawRect(
                        color = accent,
                        topLeft = Offset(xLeft, yMid),
                        size = Size(w, h),
                    )
                }
            }
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Spin the TASK marker while task_start has no matching task_end yet
        // — at-a-glance "this task is still running" signal.
        val taskAngle = rememberRunningRotation(
            active = isRotatingEntry(entry, siblings),
        )
        Icon(
            imageVector = TimelineIconKey.Task.materialIcon,
            contentDescription = "Task",
            tint = accent,
            modifier = Modifier.width(14.dp).height(14.dp).rotate(taskAngle),
        )
        Text(
            text = if (isEnd) "TASK END" else "TASK",
            color = accent,
            fontSize = scale.fontSub,
            fontWeight = FontWeight.ExtraBold,
            fontFamily = FontFamily.Monospace,
            style = tight,
        )
        if (sessionLabel.isNotEmpty()) {
            Text(
                text = sessionLabel,
                color = TerrariumColors.HUDSubtext.copy(alpha = 0.85f),
                fontSize = scale.fontSub,
                fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = if (scale.isTablet) 150.dp else 110.dp),
                style = tight,
            )
        }
        Text(
            text = rowSummary(entry.summary),
            color = TerrariumColors.HUDText,
            fontSize = scale.fontSub,
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
            style = tight,
        )
        // Task-judge verdict badge — only on task_end. Renders score + outcome
        // glyph once the async judge resolves. While pending shows a dim "…".
        if (isEnd) {
            TaskEvalBadge(
                score = entry.taskScore,
                outcome = entry.taskOutcome,
                fontSize = (scale.fontSub.value - 1f).sp,
                tight = tight,
            )
        }
        Text(
            text = timeStr,
            color = TerrariumColors.HUDSubtext.copy(alpha = 0.6f),
            fontSize = (scale.fontSub.value - 1f).sp,
            fontFamily = FontFamily.Monospace,
            style = tight,
        )
    }
}

/**
 * Eval chip rendered at the right edge of a `task_end` header. Stays neutral
 * (dim "…") until the judge resolves and the timeline row upserts with score
 * + outcome metadata. Mirrors `TaskEvalBadge` in Apple TimelineStripView.swift.
 */
@Composable
private fun TaskEvalBadge(
    score: Double?,
    outcome: String?,
    fontSize: androidx.compose.ui.unit.TextUnit,
    tight: TextStyle,
) {
    val (glyph, color) = when (outcome) {
        "success"   -> "✓" to DesignTokens.UI.ok
        "partial"   -> "△" to DesignTokens.UI.attn
        "fail"      -> "✗" to DesignTokens.UI.error
        // User explicitly cancelled (`agentdeck task cancel`). The judge
        // preserves this outcome instead of overwriting with its
        // score-derived class — render as a neutral "explicitly stopped"
        // so the row doesn't masquerade as pending nor as agent failure.
        "abandoned" -> "⊘" to DesignTokens.UI.error.copy(alpha = 0.55f)
        else        -> "…" to TerrariumColors.HUDSubtext.copy(alpha = 0.6f)
    }
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(3.dp))
            .background(color.copy(alpha = if (score == null) 0.08f else 0.16f))
            .padding(horizontal = 5.dp, vertical = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (score != null) {
            Text(
                text = String.format(Locale.US, "%.2f", score),
                color = color,
                fontSize = fontSize,
                fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Monospace,
                style = tight,
            )
        }
        Text(
            text = glyph,
            color = color,
            fontSize = fontSize,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            style = tight,
        )
    }
}

/**
 * Detail pane — shows full info for the focused entry.
 */
@Composable
private fun DetailPane(
    focusedGroup: GroupedEntry?,
    entries: List<TimelineEntry>,
    scale: MonitorLayoutScale,
    modifier: Modifier = Modifier,
) {
    val labelSp = (scale.fontSub.value - 1f).sp  // 9 sp on tablet, 8 sp on phone
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(4.dp))
            .background(Color(0x30000000)),
    ) {
        if (focusedGroup == null) {
            Box(
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "No events",
                    color = TerrariumColors.HUDSubtext.copy(alpha = 0.5f),
                    fontSize = scale.fontSub,
                    fontFamily = FontFamily.Monospace,
                )
            }
        } else {
            val entry = focusedGroup.entry
            // When a turn is merged (chat_start absorbing its chat_response),
            // the response body lives on `mergedResponse` — surface it here so
            // selecting a merged turn still shows the assistant's reply instead
            // of just the prompt (the merged rows are no longer selectable).
            val bodyEntry = focusedGroup.mergedResponse ?: entry
            val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
            val timeStr = timeFormat.format(Date(entry.timestamp))
            val iconKey = timelineIconKey(entry.type, entry.status)
            val iconColor = typeColor(entry.type)
            val sourceLabel = sourceLabel(entry)
            val countSuffix = if (focusedGroup.count > 1) " (×${focusedGroup.count})" else ""
            val lifecycleRows = lifecycleDetailRows(entry, entries)

            // Header: type badge + timestamp
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(3.dp))
                        .background(iconColor.copy(alpha = 0.7f))
                        .padding(horizontal = 4.dp, vertical = 1.dp),
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val badgeAngle = rememberRunningRotation(
                        active = isRotatingEntry(entry, entries),
                    )
                    Icon(
                        imageVector = iconKey.materialIcon,
                        contentDescription = iconKey.name,
                        tint = Color.White,
                        modifier = Modifier.width(10.dp).height(10.dp).rotate(badgeAngle),
                    )
                    Text(
                        text = formatType(entry.type),
                        color = Color.White,
                        fontSize = labelSp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    text = timeStr,
                    color = TerrariumColors.HUDSubtext,
                    fontSize = labelSp,
                    fontFamily = FontFamily.Monospace,
                )
            }

            // Source tag if present
            if (sourceLabel.isNotEmpty()) {
                Text(
                    text = sourceLabel + countSuffix,
                    color = TerrariumColors.HUDSubtext.copy(alpha = 0.7f),
                    fontSize = labelSp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
            }

            if (lifecycleRows.isNotEmpty()) {
                Spacer(modifier = Modifier.height(4.dp))
                Column(
                    modifier = Modifier.padding(horizontal = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(1.dp),
                ) {
                    lifecycleRows.forEach { row ->
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = row.first,
                                color = TerrariumColors.HUDSubtext.copy(alpha = 0.7f),
                                fontSize = (labelSp.value - 1f).sp,
                                fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.Monospace,
                                modifier = Modifier.width(34.dp),
                            )
                            Text(
                                text = row.second,
                                color = TerrariumColors.HUDSubtext.copy(alpha = 0.82f),
                                fontSize = (labelSp.value - 1f).sp,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(4.dp))

            // Task eval verdict — score badge + category + summary. Only
            // meaningful on task_end. Mirrors Apple `TimelineStripView`
            // detail-pane TaskEvalBadge rendering for cross-platform parity.
            if (entry.type == "task_end") {
                val tightStyle = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TaskEvalBadge(
                        score = entry.taskScore,
                        outcome = entry.taskOutcome,
                        fontSize = labelSp,
                        tight = tightStyle,
                    )
                    if (!entry.taskCategory.isNullOrEmpty()) {
                        Text(
                            text = entry.taskCategory,
                            color = TerrariumColors.HUDSubtext.copy(alpha = 0.85f),
                            fontSize = labelSp,
                            fontWeight = FontWeight.Medium,
                            fontFamily = FontFamily.Monospace,
                            style = tightStyle,
                        )
                    }
                }
                if (!entry.taskSummary.isNullOrEmpty()) {
                    Text(
                        text = entry.taskSummary,
                        color = TerrariumColors.HUDSubtext.copy(alpha = 0.85f),
                        fontSize = labelSp,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(horizontal = 8.dp).padding(top = 2.dp),
                    )
                }
                Spacer(modifier = Modifier.height(4.dp))
            }

            // Summary — strip markdown so `**bold**` / `## heading` don't
            // appear as literal characters next to the markdown-rendered detail.
            Text(
                text = stripMarkdownForSummary(bodyEntry.summary),
                color = TerrariumColors.HUDText,
                fontSize = scale.fontHeader,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(horizontal = 8.dp),
            )

            // Detail text — markdown-aware. Suppressed when:
            //   (a) summaryKind == "none" (heuristic last-resort: detail
            //       is just the raw response, showing it duplicates noisily)
            //   (b) timelineDetailIsRedundant matches detail against summary
            val detailText = bodyEntry.detail
            if (!detailText.isNullOrEmpty()
                && bodyEntry.summaryKind != "none"
                && !timelineDetailIsRedundant(detailText, bodyEntry.summary)) {
                Spacer(modifier = Modifier.height(4.dp))
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f, fill = false)
                        .padding(horizontal = 8.dp),
                ) {
                    item {
                        TimelineMarkdownView(text = detailText)
                    }
                }
            }

            Spacer(modifier = Modifier.weight(1f))
        }
    }
}

/**
 * Compact-mode inline detail block. Renders below the tapped row in
 * single-column layout. Mirrors the right-side `DetailPane` content shape
 * but laid out vertically without the type badge / timestamp header.
 */
@Composable
private fun InlineDetailPane(
    group: GroupedEntry,
    entries: List<TimelineEntry>,
    scale: MonitorLayoutScale,
) {
    val entry = group.entry
    val bodyEntry = group.mergedResponse ?: entry
    val tight = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))
    val lifecycleRows = lifecycleDetailRows(entry, entries)
    val labelSp = (scale.fontSub.value - 1f).sp

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 18.dp, end = 6.dp, top = 2.dp, bottom = 4.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(Color(0x1AFFFFFF))
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (lifecycleRows.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                lifecycleRows.forEach { row ->
                    Text(
                        text = "${row.first} ${row.second}",
                        color = TerrariumColors.HUDSubtext.copy(alpha = 0.7f),
                        fontSize = labelSp,
                        fontFamily = FontFamily.Monospace,
                        style = tight,
                    )
                }
            }
        }
        val detailText = bodyEntry.detail
        if (!detailText.isNullOrEmpty()
            && bodyEntry.summaryKind != "none"
            && !timelineDetailIsRedundant(detailText, bodyEntry.summary)) {
            TimelineMarkdownView(text = detailText)
        } else {
            Text(
                text = "Tap to collapse · summary only",
                color = TerrariumColors.HUDSubtext.copy(alpha = 0.5f),
                fontSize = labelSp,
                fontFamily = FontFamily.Monospace,
                style = tight,
            )
        }
    }
}

// typeIcon was a legacy Unicode-glyph helper. Replaced by TimelineIconKey
// (dev.agentdeck.ui.timeline.TimelineIcons) which maps to Material Icons
// for tablet and ASCII brackets for e-ink.

private fun typeColor(type: String) = when (type) {
    "task_start", "task_end" -> TerrariumColors.TetraNeon
    "tool_request", "tool_resolved", "tool_exec" -> TerrariumColors.LEDGreen
    "model_call", "model_response" -> TerrariumColors.TetraNeon
    "chat_response" -> TerrariumColors.TetraNeon
    "memory_recall" -> TerrariumColors.ClaudeBody
    "chat_start", "chat_end" -> TerrariumColors.HUDText
    "error" -> TerrariumColors.LEDRed
    "state_change", "eval_result" -> TerrariumColors.LEDAmber
    else -> TerrariumColors.HUDSubtext
}

// Delegates to the single shared Kotlin map (ui.component.agentDisplayLabel).
private fun agentTag(agentType: String?): String = agentDisplayLabel(agentType)

private fun rowPrefixLabel(entry: TimelineEntry): String {
    // Apple TimelineStripView.rowPrefixLabel parity: prefer the projectName
    // alone — the row's brand glyph (BrandIcon) already conveys the agent, and
    // appending the agent tag made the same row read "[AgentDeck] · Codex CLI"
    // on tablets vs "[AgentDeck]" on iOS/macOS. The agent tag remains only as
    // the fallback for rows with no recorded project.
    val project = entry.projectName?.takeIf { it.isNotBlank() }
    if (project != null) return "[$project]"
    val tag = agentTag(entry.agentType)
    return if (tag.isNotEmpty()) "[$tag]" else ""
}

private fun sourceLabel(entry: TimelineEntry): String {
    val project = entry.projectName?.takeIf { it.isNotBlank() }
    val tag = agentTag(entry.agentType)
    return when {
        project != null && tag.isNotEmpty() -> "$project · $tag"
        project != null -> project
        else -> tag
    }
}

private fun lifecycleDetailRows(entry: TimelineEntry, entries: List<TimelineEntry>): List<Pair<String, String>> {
    val (startedAt, endedAt) = timelineLifecycleBounds(entry, entries)
    val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
    val rows = mutableListOf<Pair<String, String>>()
    if (startedAt != null) rows += "START" to timeFormat.format(Date(startedAt))
    if (endedAt != null) rows += "END" to timeFormat.format(Date(endedAt))
    if (startedAt != null && endedAt != null && endedAt >= startedAt) {
        rows += "DUR" to formatDuration(endedAt - startedAt)
    }
    return rows
}

private fun formatDuration(ms: Long): String {
    val seconds = maxOf(0, ((ms + 500) / 1000).toInt())
    if (seconds < 60) return "${seconds}s"
    val minutes = seconds / 60
    val remainingSeconds = seconds % 60
    if (minutes < 60) return "${minutes}m ${remainingSeconds}s"
    val hours = minutes / 60
    return "${hours}h ${minutes % 60}m"
}

private fun formatType(type: String): String = when (type) {
    "tool_request" -> "TOOL"
    "tool_resolved" -> "DONE"
    "tool_exec" -> "EXEC"
    "model_call" -> "MODEL"
    "model_response" -> "RESP"
    "chat_start" -> "CHAT"
    "chat_end" -> "END"
    "chat_response" -> "REPLY"
    "memory_recall" -> "MEM"
    "error" -> "ERR"
    "scheduled" -> "SCHED"
    "user_action" -> "USER"
    "state_change" -> "STATE"
    "eval_result" -> "EVAL"
    "task_start" -> "TASK"
    "task_end" -> "TASK ✓"
    else -> type.uppercase().take(5)
}
