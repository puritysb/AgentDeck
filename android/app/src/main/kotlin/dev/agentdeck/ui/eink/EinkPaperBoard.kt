package dev.agentdeck.ui.eink

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.AgentState
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.TimelineEntry
import dev.agentdeck.state.groupConsecutive
import dev.agentdeck.terrarium.renderer.einkColorEnabled
import dev.agentdeck.ui.component.BrandIcon
import dev.agentdeck.ui.screen.EinkLimitLine
import dev.agentdeck.util.SessionTone
import dev.agentdeck.util.UsageSeverity
import dev.agentdeck.util.sessionWords
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Paper Board (DESIGN.md §5.14) — the e-ink Dashboard as a board of ranked
 * zones instead of a shrunken tablet. Sessions are ranked by what they ask of
 * the reader (needs you → working → quiet), never laid out as equal cards;
 * there is no filler copy; everything is black ink on white.
 */
internal data class BoardSession(
    val id: String?,
    val name: String,
    val agentType: String?,
    val modelName: String?,
    val state: AgentState,
    val activity: String?,
    val question: String?,
)

internal data class PaperBoard(
    val needsYou: List<BoardSession>,
    val working: List<BoardSession>,
    val quiet: List<BoardSession>,
    val offline: Int,
) {
    val total get() = needsYou.size + working.size + quiet.size + offline
}

/** Ranks every session of [state] into the board's zones. Pure, for tests. */
internal fun buildPaperBoard(state: DashboardState): PaperBoard {
    data class Raw(val s: BoardSession, val weight: Int?, val startedAt: String?)
    val raw = mutableListOf<Raw>()
    val isAggregate = state.agentType == "daemon" || state.agentType == "openclaw" ||
        state.siblingSessions.any { it.agentType == state.agentType }
    if (!isAggregate && state.agentType != null) {
        val sibling = state.siblingSessions.firstOrNull { it.id == state.sessionId }
        raw += Raw(BoardSession(state.sessionId, state.projectName ?: "Agent", state.agentType, state.modelName,
            state.agentState, sibling?.activity, sibling?.question), null, null)
    }
    val primaryId = if (!isAggregate) state.sessionId else null
    state.siblingSessions
        .filter { it.id != primaryId && it.agentType != "daemon" }
        .sortedWith(::compareSessionsForDisplay)
        .forEach {
            raw += Raw(BoardSession(it.id, it.projectName ?: "Agent", it.agentType, it.modelName,
                mapSessionState(it), it.activity, it.question), it.weight, it.startedAt)
        }
    // Same project and agent twice: number them so a row names one session.
    val counts = raw.groupingBy { it.s.name to it.s.agentType }.eachCount()
    val seen = mutableMapOf<Pair<String, String?>, Int>()
    val sessions = raw.map { r ->
        val key = r.s.name to r.s.agentType
        if ((counts[key] ?: 1) > 1) {
            val n = (seen[key] ?: 0) + 1
            seen[key] = n
            r.s.copy(name = "${r.s.name} #$n")
        } else r.s
    }
    return PaperBoard(
        needsYou = sessions.filter { it.state.isAwaiting() },
        working = sessions.filter { it.state == AgentState.PROCESSING },
        quiet = sessions.filter { it.state == AgentState.IDLE },
        offline = sessions.count { it.state == AgentState.DISCONNECTED },
    )
}

/** One finished piece of agent work: when, where, and what came back. */
internal data class PaperRecentItem(
    val timestamp: Long,
    val projectName: String?,
    val agentType: String?,
    val text: String,
    /** Null when the work succeeded; otherwise the reader's word for how it ended. */
    val mark: String?,
)

/**
 * Newest finished agent work, newest first. A judged task (`task_end` with a
 * `taskSummary`) is the best account of what finished; a turn counts only
 * when the agent answered it. A prompt still waiting for its answer is the
 * reader's own words, not news; automated turns and tool noise never count,
 * and an abandoned task did not finish.
 */
internal fun paperRecent(entries: List<TimelineEntry>, limit: Int): List<PaperRecentItem> {
    val items = mutableListOf<Triple<String?, Boolean, PaperRecentItem>>()
    for (g in groupConsecutive(entries.filter { it.automated != true })) {
        val e = g.entry
        val item = when (e.type) {
            "task_end" -> {
                val mark = when (e.taskOutcome) {
                    "abandoned" -> continue
                    "failure", "failed" -> "FAILED"
                    "partial" -> "PARTIAL"
                    else -> null
                }
                val text = e.taskSummary?.let { paperHeadline(it, null) } ?: continue
                PaperRecentItem(e.endedAt ?: e.timestamp, e.projectName, e.agentType, text, mark)
            }
            "chat_start", "chat_response" -> {
                val reply = if (e.type == "chat_start") g.mergedResponse ?: continue else e
                val text = paperHeadline(reply.summary, reply.detail) ?: continue
                PaperRecentItem(g.lastTs, e.projectName, e.agentType, text, null)
            }
            "error" -> PaperRecentItem(e.timestamp, e.projectName, e.agentType,
                paperHeadline(e.summary, e.detail) ?: continue, "FAILED")
            else -> continue
        }
        items += Triple(e.taskId, e.type == "task_end", item)
    }
    // A judged task already speaks for the turns inside it.
    val judged = items.filter { it.second }.mapNotNull { it.first }.toSet()
    return items
        .filter { (taskId, isTask, _) -> isTask || taskId == null || taskId !in judged }
        .map { it.third }
        .sortedByDescending { it.timestamp }
        .take(limit)
}

/**
 * The line a reader would quote from an agent reply: markdown markers
 * stripped, and a bare heading ("Overview", "## Summary") skipped in
 * favour of the first sentence-like line.
 */
internal fun paperHeadline(summary: String, detail: String?): String? {
    val lines = (summary + "\n" + (detail ?: ""))
        .lineSequence()
        .map { it.trim().trimStart('#', '*', '-', '>', ' ').trim('*', '_', '`', ' ') }
        .filter { it.isNotEmpty() && it != "…" && it != "..." && !it.startsWith("{") && !it.startsWith("[") }
        .toList()
    return lines.firstOrNull { it.length >= 20 || it.split(' ').size >= 4 } ?: lines.firstOrNull()
}

/** Masthead summary: counts by state, in the reader's words. */
internal fun paperMastheadSummary(board: PaperBoard): String = buildList {
    if (board.needsYou.isNotEmpty()) add("${board.needsYou.size} need you")
    if (board.working.isNotEmpty()) add("${board.working.size} working")
    if (board.quiet.isNotEmpty()) add("${board.quiet.size} idle")
    if (board.offline > 0) add("${board.offline} offline")
}.ifEmpty { listOf("No sessions") }.joinToString(" · ")

private fun AgentState.isAwaiting() = this == AgentState.AWAITING_PERMISSION ||
    this == AgentState.AWAITING_OPTION || this == AgentState.AWAITING_DIFF

private val Ink = Color.Black

/** Brand marks keep their own colour on colour e-ink, and are ink elsewhere. */
private fun markTint(onInk: Boolean = false): Color? = when {
    onInk -> Paper
    einkColorEnabled -> null
    else -> Ink
}
private val Paper = Color.White

@Composable
private fun ZoneLabel(text: String, scale: EinkLayoutScale, color: Color = Ink) {
    Text(
        text = text,
        fontSize = scale.sectionFont,
        lineHeight = scale.sectionFont * 1.2f,
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Bold,
        color = color,
        modifier = Modifier.padding(bottom = 4.dp),
    )
}

/** One working (or waiting) session: glyph · name · state, then its live activity. */
@Composable
private fun BoardRow(session: BoardSession, scale: EinkLayoutScale, onFocus: (String) -> Unit) {
    val waiting = session.state.isAwaiting()
    val fg = if (waiting) Paper else Ink
    // Colour e-ink: the band is the needs-you hue; on grey panels it is ink (DESIGN.md §5.14).
    val band = if (einkColorEnabled) Color(SessionTone.AWAITING.paper) else Ink
    val nameSize: TextUnit = scale.sessionTitleFont * 1.25f
    val bodySize: TextUnit = scale.sessionTitleFont
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (waiting) Modifier.background(band) else Modifier)
            .then(if (session.id != null) Modifier.clickable { onFocus(session.id) } else Modifier)
            .padding(horizontal = if (waiting) 8.dp else 0.dp, vertical = 5.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            BrandIcon(agentType = session.agentType, isEink = !einkColorEnabled, size = 20.dp, tint = markTint(onInk = waiting))
            Text(
                text = session.name,
                fontSize = nameSize,
                lineHeight = nameSize * 1.15f,
                fontWeight = FontWeight.Bold,
                color = fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(start = 8.dp),
            )
            // The zone heading already says WORKING; only a waiting row names its state.
            if (waiting) {
                Text(
                    text = session.state.sessionWords.short,
                    fontSize = scale.sectionFont,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = fg,
                )
            }
        }
        val line = (if (waiting) session.question else session.activity)?.trim()?.takeIf { it.isNotEmpty() }
            ?: session.modelName?.takeIf { it.isNotBlank() }
        if (line != null) {
            Text(
                text = line,
                fontSize = bodySize,
                lineHeight = bodySize * 1.3f,
                color = fg,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 28.dp, top = 2.dp),
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NowZones(board: PaperBoard, scale: EinkLayoutScale, onFocus: (String) -> Unit) {
    val active = board.needsYou + board.working
    if (active.isNotEmpty()) {
        // The heading carries the state (and, on colour e-ink, its hue) once for the zone.
        val lead = if (board.needsYou.isEmpty()) AgentState.PROCESSING else AgentState.AWAITING_PERMISSION
        ZoneLabel(if (board.needsYou.isEmpty()) "WORKING · ${board.working.size}"
            else "NOW · ${board.needsYou.size} need you · ${board.working.size} working", scale,
            color = stateColor(lead) ?: Ink)
        Column(verticalArrangement = Arrangement.spacedBy(scale.rowSpacing + 2.dp)) {
            active.forEach { BoardRow(it, scale, onFocus) }
        }
    }
    if (board.quiet.isNotEmpty() || board.offline > 0) {
        if (active.isNotEmpty()) BoardDivider()
        val label = buildList {
            if (board.quiet.isNotEmpty()) add("IDLE · ${board.quiet.size}")
            if (board.offline > 0) add("OFFLINE · ${board.offline}")
        }.joinToString("   ")
        ZoneLabel(label, scale)
        if (board.quiet.isNotEmpty()) {
            // Name alone is ambiguous (a Claude session in the OpenClaw repo
            // and the OpenClaw agent are both "OpenClaw"); the mark settles it.
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(18.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                board.quiet.forEach { q ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = if (q.id != null) Modifier.clickable { onFocus(q.id) } else Modifier,
                    ) {
                        BrandIcon(agentType = q.agentType, isEink = !einkColorEnabled, size = 14.dp, tint = markTint())
                        Text(
                            text = q.name,
                            fontSize = scale.sessionTitleFont,
                            color = Ink,
                            maxLines = 1,
                            modifier = Modifier.padding(start = 5.dp),
                        )
                    }
                }
            }
        }
    }
    if (board.total == 0) {
        Text("No sessions", fontSize = scale.sessionTitleFont * 1.25f, color = Ink)
    }
}

@Composable
private fun BoardDivider() {
    HorizontalDivider(thickness = 1.dp, color = Ink, modifier = Modifier.padding(vertical = 8.dp))
}

/**
 * Usage, one line per provider: mark, then `window NN%` chips. The number is
 * the information, so it is the largest thing here; the short bar under it is
 * a glance cue, not a ruler across the page. `!` at critical, `?` when stale.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun UsageZone(rows: List<EinkLimitLine>, scale: EinkLayoutScale) {
    if (rows.isEmpty()) return
    ZoneLabel("USAGE", scale)
    val byProvider = rows.filter { it.percent != null }.groupBy { it.agentType }
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(36.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        byProvider.forEach { (agentType, gauges) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                BrandIcon(agentType = agentType, isEink = !einkColorEnabled, size = 18.dp, tint = markTint())
                Row(
                    horizontalArrangement = Arrangement.spacedBy(18.dp),
                    modifier = Modifier.padding(start = 10.dp),
                ) {
                    gauges.forEach { UsageChip(it, scale) }
                }
            }
        }
    }
    val notes = rows.filter { it.percent == null }.mapNotNull { it.value }
    if (notes.isNotEmpty()) {
        Text(
            text = notes.joinToString("  ·  "),
            fontSize = scale.sessionMetaFont,
            fontFamily = FontFamily.Monospace,
            color = Ink,
            modifier = Modifier.padding(top = 6.dp),
        )
    }
}

/** One width for every usage bar, so two windows compare by eye without reading numbers. */
private val UsageBarWidth = 104.dp

@Composable
private fun UsageChip(row: EinkLimitLine, scale: EinkLayoutScale) {
    val pct = (row.percent ?: 0.0).coerceIn(0.0, 100.0)
    val critical = pct >= 90
    val numberSize = scale.sessionTitleFont * 1.2f
    Column(Modifier.width(UsageBarWidth)) {
        Row {
            Text(
                text = row.label,
                fontSize = scale.sessionMetaFont,
                fontFamily = FontFamily.Monospace,
                color = Ink,
                maxLines = 1,
                modifier = Modifier.alignByBaseline().padding(end = 5.dp),
            )
            Text(
                text = "${pct.toInt()}%" + if (row.stale) "?" else if (critical) "!" else "",
                fontSize = numberSize,
                lineHeight = numberSize,
                fontFamily = FontFamily.Monospace,
                fontWeight = if (critical) FontWeight.Bold else FontWeight.Medium,
                color = Ink,
                maxLines = 1,
                modifier = Modifier.alignByBaseline(),
            )
        }
        Box(Modifier.padding(top = 3.dp).fillMaxWidth().height(12.dp).border(1.5.dp, Ink)) {
            val fill = if (einkColorEnabled && !row.stale) Color(UsageSeverity.color(pct, onPaper = true)) else Ink
            Box(Modifier.fillMaxHeight().fillMaxWidth((pct / 100.0).toFloat()).background(fill))
        }
        // Time left is what the reader plans around; it sits directly under its bar.
        row.reset?.let {
            Text(
                text = if (row.stale) it else "resets $it",
                fontSize = (scale.sessionMetaFont.value + 1).sp,
                fontFamily = FontFamily.Monospace,
                color = Ink,
                maxLines = 1,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

private val timeFormat = SimpleDateFormat("HH:mm", Locale.US)

@Composable
private fun RecentZone(entries: List<TimelineEntry>, scale: EinkLayoutScale, limit: Int) {
    val recent = remember(entries, limit) { paperRecent(entries, limit) }
    if (recent.isEmpty()) return
    ZoneLabel("DONE", scale)
    Column(verticalArrangement = Arrangement.spacedBy(scale.rowSpacing + 2.dp)) {
        recent.forEach { item ->
            Row {
                Text(
                    text = timeFormat.format(Date(item.timestamp)),
                    fontSize = (scale.sessionMetaFont.value + 1).sp,
                    fontFamily = FontFamily.Monospace,
                    color = Ink,
                    modifier = Modifier.width(46.dp).padding(top = 2.dp),
                )
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        BrandIcon(agentType = item.agentType, isEink = !einkColorEnabled, size = 12.dp, tint = markTint())
                        Text(
                            text = (item.projectName?.takeIf { it.isNotBlank() } ?: "Agent") +
                                (item.mark?.let { "  ·  $it" } ?: ""),
                            fontSize = (scale.sessionMetaFont.value + 1).sp,
                            fontWeight = FontWeight.Bold,
                            color = Ink,
                            maxLines = 1,
                            modifier = Modifier.padding(start = 4.dp),
                        )
                    }
                    Text(
                        text = item.text,
                        fontSize = scale.sessionTitleFont,
                        lineHeight = scale.sessionTitleFont * 1.3f,
                        color = Ink,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/** A text zone: its own partial-refresh region, sized to its content. */
@Composable
private fun TextZone(
    zone: Zone,
    triggerKey: Any,
    sleepSnapshotMode: Boolean,
    modifier: Modifier = Modifier,
    fill: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    EinkRefreshZone(
        mode = zone.mode,
        debounceMs = zone.debounceMs,
        triggerKey = triggerKey,
        sleepSnapshotMode = sleepSnapshotMode,
        wrapContentHeight = !fill,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(
            Modifier.fillMaxWidth().then(if (fill) Modifier.fillMaxHeight() else Modifier).background(Paper),
            content = content,
        )
    }
}

/** Below this the terrarium is a keyhole, not a view: the zone gives the space back. */
private val MinTankHeight = 150.dp

@Composable
private fun TankZone(modifier: Modifier, tank: @Composable (Modifier) -> Unit) {
    BoxWithConstraints(modifier.fillMaxWidth()) {
        if (maxHeight >= MinTankHeight) tank(Modifier.fillMaxSize())
    }
}

/**
 * The board body under the masthead and the needs-you band. Every text zone
 * is its own partial-refresh region (sessions fast, usage and finished work
 * slow), and [tank] — the terrarium, with its own animated region — takes
 * whatever height the zones leave, never less than [MinTankHeight] and never
 * over a zone.
 */
@Composable
internal fun EinkPaperBoard(
    state: DashboardState,
    timelineEntries: List<TimelineEntry>,
    landscape: Boolean,
    onFocusSession: (String) -> Unit,
    usageRows: List<EinkLimitLine>,
    sleepSnapshotMode: Boolean,
    modifier: Modifier = Modifier,
    tank: (@Composable (Modifier) -> Unit)? = null,
) {
    val scale = rememberEinkLayoutScale()
    val board = remember(state) { buildPaperBoard(state) }
    val pad = scale.contentPadding + 4.dp
    val nowKey = remember(board) {
        (board.needsYou + board.working + board.quiet).joinToString("|") {
            "${it.id}:${it.state}:${it.name}:${it.activity}:${it.question}"
        } + ":${board.offline}"
    }
    val statusKey = usageRows to timelineEntries.size
    val hasRecent = remember(timelineEntries) { paperRecent(timelineEntries, 1).isNotEmpty() }
    val sessions: @Composable ColumnScope.() -> Unit = {
        Column(Modifier.padding(pad)) { NowZones(board, scale, onFocusSession) }
    }
    val status: @Composable ColumnScope.(Int) -> Unit = { recentLimit ->
        Column(Modifier.padding(pad)) {
            UsageZone(usageRows, scale)
            if (usageRows.isNotEmpty() && hasRecent) BoardDivider()
            RecentZone(timelineEntries, scale, limit = recentLimit)
        }
    }
    if (landscape) {
        // Text reads down one column; the terrarium is a full-height window
        // beside it, so neither depends on how much the other has to say.
        Row(modifier = modifier.fillMaxSize().background(Paper)) {
            Column(Modifier.weight(if (tank != null) 0.46f else 1f).fillMaxHeight()) {
                TextZone(Zone.CONTEXT_FAST, nowKey, sleepSnapshotMode, content = sessions)
                HorizontalDivider(thickness = 1.dp, color = Ink, modifier = Modifier.padding(horizontal = pad))
                TextZone(Zone.STATUS_SLOW, statusKey, sleepSnapshotMode, Modifier.weight(1f), fill = true) {
                    status(4)
                }
            }
            if (tank != null) {
                VerticalDivider(thickness = 2.dp, color = Ink)
                TankZone(Modifier.weight(0.54f).fillMaxHeight().padding(pad), tank)
            }
        }
    } else {
        Column(modifier = modifier.fillMaxSize().background(Paper)) {
            TextZone(Zone.CONTEXT_FAST, nowKey, sleepSnapshotMode, content = sessions)
            if (tank != null) {
                TankZone(Modifier.weight(1f).padding(horizontal = pad), tank)
            } else {
                Box(Modifier.weight(1f))
            }
            HorizontalDivider(thickness = 2.dp, color = Ink)
            TextZone(Zone.STATUS_SLOW, statusKey, sleepSnapshotMode) { status(3) }
        }
    }
}
