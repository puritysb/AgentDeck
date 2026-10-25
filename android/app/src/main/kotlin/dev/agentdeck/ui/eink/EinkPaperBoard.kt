package dev.agentdeck.ui.eink

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import androidx.compose.runtime.key
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.CiWaitStatus
import dev.agentdeck.terrarium.ciCompanionLabel
import dev.agentdeck.net.AgentState
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.TimelineEntry
import dev.agentdeck.state.groupConsecutive
import dev.agentdeck.terrarium.renderer.einkColorEnabled
import dev.agentdeck.ui.component.BrandIcon
import dev.agentdeck.ui.screen.EinkLimitLine
import dev.agentdeck.ui.screen.EinkUsageGroup
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
    val ciWait: CiWaitStatus? = null,
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
            state.agentState, dev.agentdeck.terrarium.BackgroundWorkPolicy.label(sibling?.backgroundTaskCount)?.takeUnless { sibling?.state == "error" || state.agentState.isAwaiting() } ?: sibling?.activity, sibling?.question, sibling?.waitingOn?.takeUnless { state.agentState.isAwaiting() }), null, null)
    }
    val primaryId = if (!isAggregate) state.sessionId else null
    state.siblingSessions
        .filter { it.id != primaryId && it.agentType != "daemon" }
        .sortedWith(::compareSessionsForDisplay)
        .forEach {
            raw += Raw(BoardSession(it.id, it.projectName ?: "Agent", it.agentType, it.modelName,
                einkBoardState(state,it), dev.agentdeck.terrarium.BackgroundWorkPolicy.label(it.backgroundTaskCount)?.takeUnless { _ -> it.state == "error" || einkBoardState(state, it).isAwaiting() } ?: it.activity, it.question, it.waitingOn?.takeUnless { _ -> einkBoardState(state,it).isAwaiting() }), it.weight, it.startedAt)
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
 * and an abandoned task did not finish. Explicit history inspection also shows
 * terminal lifecycle rows and abandoned summaries with their outcome labels.
 */
internal fun paperRecent(entries: List<TimelineEntry>, limit: Int, historyMode: Boolean = false): List<PaperRecentItem> {
    val items = mutableListOf<Triple<String?, Boolean, PaperRecentItem>>()
    for (g in groupConsecutive(entries.filter { it.automated != true })) {
        val e = g.entry
        val item = when (e.type) {
            "task_end" -> {
                val mark = when (e.taskOutcome) {
                    "abandoned" -> if (historyMode) "ABANDONED" else continue
                    "failure", "failed" -> "FAILED"
                    "partial" -> "PARTIAL"
                    else -> null
                }
                val text = e.taskSummary?.let { paperHeadline(it, null) } ?: continue
                PaperRecentItem(e.endedAt ?: e.timestamp, e.projectName, e.agentType, text, mark)
            }
            "chat_start", "chat_response" -> {
                val reply = if (e.type == "chat_start") {
                    g.mergedResponse ?: (g.mergedCompletion ?: e).takeIf { historyMode } ?: continue
                } else e
                val text = paperHeadline(reply.summary, reply.detail) ?: continue
                val mark = when {
                    !historyMode -> null
                    reply.type == "chat_start" -> "IN PROGRESS"
                    g.mergedCompletion != null -> g.mergedCompletion.status?.uppercase(Locale.US) ?: "ENDED"
                    else -> null
                }
                PaperRecentItem(g.lastTs, e.projectName, e.agentType, text, mark)
            }
            "chat_end" -> {
                if (!historyMode) continue
                PaperRecentItem(e.endedAt ?: e.timestamp, e.projectName, e.agentType,
                    paperHeadline(e.summary, e.detail) ?: continue, e.status?.uppercase(Locale.US) ?: "ENDED")
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
        // One piece of work is listed once: a replayed history row or a turn
        // and its task ending on the same sentence must not read as two.
        .distinctBy { (it.projectName ?: "") + "\u0000" + it.text }
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
    val ci = board.quiet.count { it.ciWait?.agentWaiting == true }
    if (ci > 0) add("$ci CI wait")
    if (board.quiet.size > ci) add("${board.quiet.size-ci} idle")
    if (board.offline > 0) add("${board.offline} offline")
}.ifEmpty { listOf("No sessions") }.joinToString(" · ")

internal fun einkBoardState(state: DashboardState, session: dev.agentdeck.net.SessionInfo): AgentState =
    if (session.id == state.sessionId && state.agentType == session.agentType && state.agentState.isAwaiting()) state.agentState else mapSessionState(session)

internal fun paperCiLine(session: BoardSession): String? = session.ciWait?.takeUnless { session.state.isAwaiting() }?.let(::ciCompanionLabel)

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
            .fillMaxWidth().heightIn(min = 44.dp)
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
        val line = (if (waiting) session.question else paperCiLine(session) ?: session.activity)?.trim()?.takeIf { it.isNotEmpty() }
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
        Column(verticalArrangement = Arrangement.spacedBy(scale.rowSpacing + 2.dp)) {
            active.forEach { BoardRow(it, scale, onFocus) }
        }
    }
    if (board.quiet.isNotEmpty() || board.offline > 0) {
        if (active.isNotEmpty()) BoardDivider()
        val label = buildList {
            val ci = board.quiet.count { it.ciWait?.agentWaiting == true }
            if (ci > 0) add("CI WAIT · $ci")
            if (board.quiet.size > ci) add("IDLE · ${board.quiet.size-ci}")
            if (board.offline > 0) add("OFFLINE · ${board.offline}")
        }.joinToString("   ")
        ZoneLabel(label, scale)
        if (board.quiet.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(scale.rowSpacing)) {
                board.quiet.forEach { BoardRow(it, scale, onFocus) }
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
 * Usage, grouped by provider: a provider line (mark · name · plan, e.g.
 * `Codex  Plus · until Oct 10`) and that provider's windows beneath it as
 * aligned rows — window · bar · used · time left — so the eye runs straight
 * down the numbers. Captions are said once. A provider with only a plan
 * (Antigravity) is its line alone; absent providers are absent, and with no
 * provider at all the zone is not drawn. The bar has one width within the
 * zone: a comparison cue, never a ruler across the page.
 *
 * The used and time-left columns are as wide as the text they hold in its real
 * style (device font, system font scale), so the table fits the zone instead
 * of assuming a font: a fixed-dp table overflowed Crema's half-width zone and
 * ran `78%` into `3d 9h` (#415).
 */
@Composable
private fun UsageZone(groups: List<EinkUsageGroup>, scale: EinkLayoutScale, heading: Boolean = true) {
    if (groups.isEmpty()) return
    val caption = scale.sessionMetaFont
    val body = (scale.sessionMetaFont.value + 2).sp
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val (pctW, timeW, labelWidths) = remember(groups, body, caption, density) {
        fun width(text: String, size: TextUnit, bold: Boolean = false): Dp = with(density) {
            measurer.measure(
                text,
                TextStyle(fontSize = size, fontFamily = FontFamily.Monospace,
                    fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal),
                maxLines = 1, softWrap = false,
            ).size.width.toDp()
        }
        val visibleWindows = groups.flatMap { it.windows }
        val resets = visibleWindows.mapNotNull { it.reset } + UsageWidestReset
        val values = visibleWindows.map(::usageValue) + UsageWidestPct
        Triple(
            maxOf(values.maxOf { width(it, usagePctFont(body), bold = true) }, width("used", caption)) + UsageColumnGap,
            maxOf(resets.maxOf { width(it, body) }, width("resets in", caption)) + UsageColumnGap,
            visibleWindows.associate { it.label to width(it.label, body) },
        )
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val labelW = maxOf(UsageLabelW, (labelWidths.values.maxOrNull() ?: 0.dp) + 8.dp)
        val tableFitsLabels = UsageIndentW + labelW + pctW + timeW + UsageBarMinW <= maxWidth
        val cols = usageColumns(maxWidth, pctW, timeW, preferredLabel = if (tableFitsLabels) labelW else UsageLabelW)
        val stacked = cols.total > maxWidth || cols.bar < UsageBarMinW
        Column(if (stacked) Modifier.fillMaxWidth() else Modifier.width(cols.total), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (heading) Row(verticalAlignment = Alignment.Bottom) {
                Text("USAGE", fontSize = scale.sectionFont, fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold, color = Ink, modifier = Modifier.weight(1f))
                if (!stacked && groups.any { it.windows.isNotEmpty() }) {
                    Text("used", fontSize = caption, fontFamily = FontFamily.Monospace, color = Ink,
                        letterSpacing = 0.sp,
                        textAlign = TextAlign.End, maxLines = 1, modifier = Modifier.width(cols.pct))
                    Text("resets in", fontSize = caption, fontFamily = FontFamily.Monospace, color = Ink,
                        letterSpacing = 0.sp,
                        textAlign = TextAlign.End, maxLines = 1, modifier = Modifier.width(cols.time))
                }
            }
            groups.forEach { group ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 5.dp)) {
                    Box(Modifier.width(UsageIndentW)) {
                        BrandIcon(agentType = group.agentType, isEink = !einkColorEnabled, size = 16.dp, tint = markTint())
                    }
                    Column(Modifier.weight(1f)) {
                        Text(group.provider, fontSize = scale.sessionTitleFont, lineHeight = scale.sessionTitleFont * 1.2f, fontWeight = FontWeight.Bold, color = Ink)
                        group.plan?.let {
                            Text(it, fontSize = caption, lineHeight = caption * 1.2f, fontFamily = FontFamily.Monospace, color = Ink)
                        }
                    }
                }
                group.windows.forEach {
                    when {
                        stacked -> StackedUsageRow(it, body)
                        (labelWidths[it.label] ?: 0.dp) + 8.dp > cols.label -> {
                            Column(Modifier.fillMaxWidth()) {
                                Text(it.label, fontSize = body, fontFamily = FontFamily.Monospace,
                                    color = Ink, modifier = Modifier.padding(start = UsageIndentW, top = 3.dp))
                                UsageRow(it.copy(label = ""), cols.copy(label = 0.dp, bar = cols.bar + cols.label), body)
                            }
                        }
                        else -> UsageRow(it, cols, body)
                    }
                }

            }
        }
    }
}

private val UsageIndentW = 24.dp
private val UsageLabelW = 50.dp
private val UsageLabelMinW = 32.dp
/** Below this the bar stops reading as a comparison; the label column gives way first. */
private val UsageBarMinW = 32.dp
private val UsageBarMaxW = 150.dp
/** Space between the right-aligned used and time-left figures. */
internal val UsageColumnGap = 10.dp
/** The widest figure each column must hold, whatever the current data. */
private const val UsageWidestPct = "100%!"
private const val UsageWidestReset = "23h 59m"

private fun usagePctFont(body: TextUnit) = (body.value + 2).sp

private fun usageValue(row: EinkLimitLine): String {
    val pct = (row.percent ?: 0.0).coerceIn(0.0, 100.0)
    val used = if (row.remaining) 100.0 - pct else pct
    return (row.value ?: "${pct.toInt()}%") +
        if (row.stale) "?" else if (row.value == null && used >= 90) "!" else ""
}

/** Narrow screens and large system fonts trade a table for wrapping reading lines. */
@Composable
private fun StackedUsageRow(row: EinkLimitLine, body: TextUnit) {
    Column(Modifier.fillMaxWidth().padding(start = UsageIndentW, bottom = 4.dp)) {
        Text("${row.label} · ${usageValue(row)}", fontSize = usagePctFont(body),
            fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = Ink)
        if (row.value == null) {
            val pct = (row.percent ?: 0.0).coerceIn(0.0, 100.0)
            val used = if (row.remaining) 100.0 - pct else pct
            Box(Modifier.fillMaxWidth().height(12.dp).border(1.5.dp, Ink)) {
                val fill = if (einkColorEnabled && !row.stale) Color(UsageSeverity.color(used, onPaper = true)) else Ink
                Box(Modifier.fillMaxHeight().fillMaxWidth((pct / 100.0).toFloat()).background(fill))
            }
        }
        row.reset?.let {
            Text("resets in $it", fontSize = body, fontFamily = FontFamily.Monospace, color = Ink)
        }
    }
}

/** Column widths of the usage table. [total] never exceeds the zone unless even a zero-width bar cannot fit. */
internal data class UsageColumns(val label: Dp, val bar: Dp, val pct: Dp, val time: Dp) {
    val total: Dp get() = UsageIndentW + label + bar + pct + time
}

/**
 * Fit the table into [available]: the figure columns keep their measured
 * widths, the bar takes what remains up to its maximum, and when the zone is
 * too narrow the label column shrinks to keep a readable bar. Nothing forces
 * the bar wider than what is left, so it cannot push the figures off the zone
 * (#415).
 */
internal fun usageColumns(available: Dp, pct: Dp, time: Dp, preferredLabel: Dp = UsageLabelW): UsageColumns {
    val figures = UsageIndentW + pct + time
    val label = (available - figures - UsageBarMinW).coerceIn(UsageLabelMinW, preferredLabel)
    val bar = (available - figures - label).coerceIn(0.dp, UsageBarMaxW)
    return UsageColumns(label = label, bar = bar, pct = pct, time = time)
}

@Composable
private fun UsageRow(row: EinkLimitLine, cols: UsageColumns, body: TextUnit) {
    val pct = (row.percent ?: 0.0).coerceIn(0.0, 100.0)
    // Severity reads the consumed share: a Luna reserve with 95% LEFT is not critical.
    val used = if (row.remaining) 100.0 - pct else pct
    val critical = row.value == null && used >= 90
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(UsageIndentW))
        Text(row.label, fontSize = body, lineHeight = body * 1.15f, fontFamily = FontFamily.Monospace, color = Ink,
            letterSpacing = 0.sp,
            modifier = Modifier.width(cols.label))
        if (row.value != null) {
            // A credit balance has no cap to fill against: no bar, just the figure.
            Box(Modifier.width(cols.bar))
        } else {
            Box(Modifier.width(cols.bar).height(12.dp).border(1.5.dp, Ink)) {
                val fill = if (einkColorEnabled && !row.stale) Color(UsageSeverity.color(used, onPaper = true)) else Ink
                Box(Modifier.fillMaxHeight().fillMaxWidth((pct / 100.0).toFloat()).background(fill))
            }
        }
        Text(
            text = usageValue(row),
            fontSize = usagePctFont(body),
            lineHeight = usagePctFont(body) * 1.15f,
            fontFamily = FontFamily.Monospace,
            fontWeight = if (critical) FontWeight.Bold else FontWeight.Medium,
            letterSpacing = 0.sp,
            color = Ink,
            textAlign = TextAlign.End,
            maxLines = 1,
            modifier = Modifier.width(cols.pct),
        )
        Text(row.reset ?: "", fontSize = body, lineHeight = body * 1.15f, fontFamily = FontFamily.Monospace, color = Ink,
            letterSpacing = 0.sp,
            textAlign = TextAlign.End, maxLines = 1, modifier = Modifier.width(cols.time))
    }
}

private val timeFormat = SimpleDateFormat("HH:mm", Locale.US)

@Composable
private fun RecentZone(entries: List<TimelineEntry>, scale: EinkLayoutScale, limit: Int, historyMode: Boolean) {
    val recent = remember(entries, limit, historyMode) { paperRecent(entries, limit, historyMode) }
    if (recent.isEmpty()) return
    ZoneLabel(if (historyMode) "HISTORY" else "DONE", scale)
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

/** The visible scroll rail belongs to its pane, so overflow never becomes a hidden page. */
@Composable
private fun PaperScrollColumn(
    scroll: ScrollState,
    tag: String,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Box(modifier.drawWithContent {
        drawContent()
        if (scroll.maxValue > 0 && size.height > 0) {
            val viewport = scroll.viewportSize.toFloat().coerceAtLeast(1f)
            val thumb = (size.height * viewport / (viewport + scroll.maxValue)).coerceIn(18.dp.toPx().coerceAtMost(size.height), size.height)
            val top = (size.height - thumb) * scroll.value / scroll.maxValue
            drawRect(Ink.copy(alpha = 0.2f), Offset(size.width - 1.dp.toPx(), 0f), Size(1.dp.toPx(), size.height))
            drawRect(Ink, Offset(size.width - 3.dp.toPx(), top), Size(3.dp.toPx(), thumb))
        }
    }) {
        Column(Modifier.fillMaxWidth().verticalScroll(scroll).testTag(tag).padding(end = 8.dp), content = content)
    }
}

private fun usageProviderKey(group: EinkUsageGroup) = group.provider + ":" + group.agentType

private fun nearLimit(line: EinkLimitLine): Boolean {
    if (line.stale || line.value != null || line.percent == null) return false
    val used = if (line.remaining) 100.0 - line.percent else line.percent
    return used >= 90
}

/** Column eligibility uses real numeric widths; long labels can wrap above their figures. */
@Composable
private fun usageMinimumWidth(groups: List<EinkUsageGroup>, scale: EinkLayoutScale): Dp {
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val body = (scale.sessionMetaFont.value + 2).sp
    return remember(groups, density, body) {
        fun width(text: String, font: TextUnit, bold: Boolean = false) = with(density) {
            measurer.measure(text, TextStyle(fontSize = font, fontFamily = FontFamily.Monospace,
                fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal), maxLines = 1, softWrap = false).size.width.toDp()
        }
        val windows = groups.flatMap { it.windows }
        val pct = (windows.map(::usageValue) + UsageWidestPct).maxOf { width(it, usagePctFont(body), true) } + UsageColumnGap
        val reset = (windows.mapNotNull { it.reset } + UsageWidestReset).maxOf { width(it, body) } + UsageColumnGap
        UsageIndentW + UsageLabelW + pct + reset + UsageBarMinW
    }
}

@Composable
private fun DashboardUsage(
    groups: List<EinkUsageGroup>,
    scale: EinkLayoutScale,
    scroll: ScrollState,
    expanded: List<String>,
    toggle: (String) -> Unit,
    landscape: Boolean,
    modifier: Modifier = Modifier,
) {
    val visibleGroups = groups.map { if (usageProviderKey(it) in expanded) it else it.copy(windows = it.windows.take(2)) }
    val minimumColumn = usageMinimumWidth(visibleGroups, scale)
    Column(modifier.testTag("paper-usage").padding(horizontal = scale.contentPadding, vertical = 6.dp)) {
        Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("USAGE", color = Ink, fontSize = scale.sectionFont, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
            Text("used · resets in", color = Ink, fontSize = scale.sessionMetaFont, fontFamily = FontFamily.Monospace)
        }
        BoxWithConstraints(Modifier.weight(1f, fill = false).fillMaxWidth()) {
            val columns = if (!landscape && maxWidth - 8.dp >= minimumColumn * 2 + 18.dp) 2 else 1
            PaperScrollColumn(scroll, "paper-usage-scroll", Modifier.fillMaxWidth()) {
                if (groups.isEmpty()) Text("No usage reported", color = Ink, fontSize = scale.sessionTitleFont)
                groups.chunked(columns).forEach { row ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                        row.forEach { group ->
                            key(usageProviderKey(group)) {
                                Column(Modifier.weight(1f).padding(bottom = 8.dp)) {
                                    val open = usageProviderKey(group) in expanded
                                    val shown = if (open) group else group.copy(windows = group.windows.take(2))
                                    UsageZone(listOf(shown), scale, heading = false)
                                    if (group.windows.size > 2) {
                                        val hiddenCritical = group.windows.drop(2).count(::nearLimit)
                                        val label = if (open) "Fewer limits" else "+${group.windows.size - 2} more limits" +
                                            if (hiddenCritical > 0) " · $hiddenCritical near limit" else ""
                                        Box(Modifier.fillMaxWidth().heightIn(min = 44.dp)
                                            .testTag("paper-usage-expand-${group.provider}")
                                            .clickable(role = Role.Button) { toggle(usageProviderKey(group)) }
                                            .padding(vertical = 5.dp), contentAlignment = Alignment.CenterStart) {
                                            Text(label, color = Ink, fontSize = (scale.sessionMetaFont.value + 1).sp,
                                                fontWeight = if (!open && hiddenCritical > 0) FontWeight.Bold else FontWeight.Normal)
                                        }
                                    }
                                }
                            }
                        }
                        if (row.size < columns) Box(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun DashboardSessions(
    board: PaperBoard,
    timelineEntries: List<TimelineEntry>,
    scale: EinkLayoutScale,
    scroll: ScrollState,
    onFocus: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.testTag("paper-sessions").padding(horizontal = scale.contentPadding, vertical = 6.dp)) {
        Text(paperMastheadSummary(board), color = Ink, fontSize = scale.sectionFont,
            lineHeight = scale.sectionFont * 1.3f, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(bottom = 6.dp))
        PaperScrollColumn(scroll, "paper-session-scroll", Modifier.weight(1f).fillMaxWidth()) {
            NowZones(board, scale, onFocus)
            if (timelineEntries.isNotEmpty()) {
                BoardDivider()
                RecentZone(timelineEntries, scale, limit = 3, historyMode = false)
            }
        }
    }
}

/** Work and usage stay together. Only the header's explicit Frame mode mounts the tank. */
@Composable
internal fun EinkPaperBoard(
    state: DashboardState,
    timelineEntries: List<TimelineEntry>,
    landscape: Boolean,
    onFocusSession: (String) -> Unit,
    usage: List<EinkUsageGroup>,
    sleepSnapshotMode: Boolean,
    modifier: Modifier = Modifier,
    inspectionLabel: String? = null,
    inspectionSessionId: String? = null,
    onClearInspection: () -> Unit = {},
    showSessionList: Boolean = true,
    frameMode: Boolean = false,
    onExitFrame: () -> Unit = {},
    tank: (@Composable (Modifier) -> Unit)? = null,
) {
    val scale = rememberEinkLayoutScale()
    val board = remember(state) { buildPaperBoard(state) }
    val sessionsScroll = rememberScrollState()
    val usageScroll = rememberScrollState()
    val historyScroll = key(inspectionSessionId ?: inspectionLabel) { rememberScrollState() }
    var expanded by rememberSaveable { mutableStateOf(emptyList<String>()) }
    var viewportSize by remember { mutableStateOf(IntSize.Zero) }
    val fontScale = LocalDensity.current.fontScale
    val historyMode = inspectionLabel != null
    val showFrame = frameMode && tank != null
    BackHandler(enabled = historyMode || showFrame) {
        if (historyMode) onClearInspection() else onExitFrame()
    }
    if (showFrame && !historyMode) {
        Box(modifier.fillMaxSize().background(Paper).padding(scale.contentPadding).testTag("paper-terrarium")) {
            tank?.invoke(Modifier.fillMaxSize())
        }
        return
    }
    EinkRefreshZone(
        mode = Zone.CONTEXT_FAST.mode, debounceMs = Zone.CONTEXT_FAST.debounceMs,
        triggerKey = listOf(board, usage, timelineEntries, expanded, inspectionSessionId, historyMode),
        softTriggerKey = listOf(sessionsScroll.value, usageScroll.value, historyScroll.value),
        qualityTriggerKey = if (viewportSize == IntSize.Zero) null else listOf(historyMode, viewportSize, fontScale),
        sleepSnapshotMode = sleepSnapshotMode,
        modifier = modifier.fillMaxSize().onSizeChanged { viewportSize = it },
    ) {
        if (historyMode) {
            Column(Modifier.fillMaxSize().background(Paper).testTag("paper-history").padding(scale.contentPadding)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.heightIn(min = 44.dp).clickable(role = Role.Button, onClick = onClearInspection)
                        .padding(end = 16.dp), contentAlignment = Alignment.CenterStart) {
                        Text(if (showFrame) "Back to Frame" else "Back to Work", color = Ink, fontSize = scale.sessionTitleFont)
                    }
                    Text("History · $inspectionLabel", color = Ink, fontSize = scale.sessionTitleFont,
                        fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                }
                PaperScrollColumn(historyScroll, "paper-history-scroll", Modifier.weight(1f).fillMaxWidth()) {
                    if (paperRecent(timelineEntries, 1, true).isEmpty()) Text("No events for this session", color = Ink)
                    else RecentZone(timelineEntries, scale, limit = timelineEntries.size, historyMode = true)
                }
            }
        } else BoxWithConstraints(Modifier.fillMaxSize().background(Paper).testTag("paper-dashboard")) {
            val usageHeightCeiling = minOf(260.dp * fontScale, maxHeight * 0.45f)
            val toggle: (String) -> Unit = { id -> expanded = if (id in expanded) expanded - id else expanded + id }
            when {
                !showSessionList -> DashboardUsage(usage, scale, usageScroll, expanded, toggle, false, Modifier.fillMaxSize())
                landscape -> Row(Modifier.fillMaxSize()) {
                    DashboardSessions(board, timelineEntries, scale, sessionsScroll, onFocusSession, Modifier.weight(0.59f).fillMaxHeight())
                    VerticalDivider(Modifier.fillMaxHeight(), color = Ink, thickness = 1.dp)
                    DashboardUsage(usage, scale, usageScroll, expanded, toggle, true, Modifier.weight(0.41f).fillMaxHeight())
                }
                else -> Column(Modifier.fillMaxSize()) {
                    DashboardSessions(board, timelineEntries, scale, sessionsScroll, onFocusSession, Modifier.weight(1f).fillMaxWidth())
                    HorizontalDivider(color = Ink, thickness = 1.dp)
                    // Natural content height below the ceiling: one provider leaves more room for work.
                    DashboardUsage(usage, scale, usageScroll, expanded, toggle, false,
                        Modifier.fillMaxWidth().heightIn(max = usageHeightCeiling))
                }
            }
        }
    }
}
