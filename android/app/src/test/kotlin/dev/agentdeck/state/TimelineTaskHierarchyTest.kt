package dev.agentdeck.state

import dev.agentdeck.ui.timeline.IN_FLIGHT_TASK_MAX_AGE_MS
import dev.agentdeck.ui.timeline.ROTATING_ENTRY_MAX_AGE_MS
import dev.agentdeck.ui.timeline.TimelineIconKey
import dev.agentdeck.ui.timeline.isInFlightTask
import dev.agentdeck.ui.timeline.ROTATING_ICON_KEY
import dev.agentdeck.ui.timeline.isRotatingEntry
import dev.agentdeck.ui.timeline.parseTimelineMarkdown
import dev.agentdeck.ui.timeline.stripMarkdownInline
import dev.agentdeck.ui.timeline.timelineDetailIsRedundant
import dev.agentdeck.ui.timeline.timelinePromoteInformativeLead
import dev.agentdeck.ui.timeline.timelineSummaryIsRedundantWithDetail
import dev.agentdeck.ui.timeline.timelineDisplayIconKey
import dev.agentdeck.ui.timeline.timelineIconKey
import dev.agentdeck.ui.timeline.TimelineMarkdownLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineTaskHierarchyTest {

    @Test
    fun `same project two sessions are not the same context anymore`() {
        // Two distinct Claude sessions in the same project. Earlier code fell
        // through to (projectName, agentType) when only one side carried a
        // sessionId — collapsing them into a single timeline row. The
        // tightened rule requires both sides to share a sessionId.
        val a = entry("chat_end", sessionId = "sess-1", projectName = "AgentDeck", agentType = "claude-code")
        val b = entry("chat_end", sessionId = "sess-2", projectName = "AgentDeck", agentType = "claude-code")
        assertFalse("two sessions in same project must not group", sameTimelineContext(a, b))
    }

    @Test
    fun `taskId is the strongest grouping key`() {
        val a = entry("tool_request", sessionId = "sess-1", taskId = "task-A")
        val b = entry("tool_resolved", sessionId = "sess-2", taskId = "task-A")
        assertTrue("entries with same taskId share context", sameTimelineContext(a, b))
    }

    @Test
    fun `task entries never group with each other`() {
        val entries = listOf(
            entry("task_start", timestamp = 1_000, summary = "Task 1", taskId = "a"),
            entry("task_start", timestamp = 2_000, summary = "Task 1", taskId = "b"),
            entry("task_end",   timestamp = 3_000, summary = "Task 1", taskId = "a"),
            entry("task_end",   timestamp = 4_000, summary = "Task 1", taskId = "b"),
        )
        val groups = groupConsecutive(entries)
        assertEquals(4, groups.size)
        assertTrue(groups.all { it.count == 1 })
    }

    @Test
    fun `closed task renders as a single header row, never a standalone task_end`() {
        // One-row-per-task contract (shared/src/timeline-task-display.ts):
        // the meaningful header stays; the closure folds into it.
        val entries = listOf(
            entry("task_start", timestamp = 1_000, summary = "Timeline cleanup", taskId = "a"),
            entry("chat_start", timestamp = 2_000, sessionId = "s", taskId = "a", startedAt = 2_000),
            entry("chat_end",   timestamp = 6_000, sessionId = "s", taskId = "a", startedAt = 2_000, endedAt = 6_000),
            entry("task_end",   timestamp = 6_500, taskId = "a", boundarySignal = "manual", summary = "Manual · 5s"),
        )
        val display = timelineDisplayGroups(groupConsecutive(entries))
        val types = display.map { it.entry.type }
        assertTrue(types.contains("task_start"))
        assertFalse(types.contains("task_end"))

        val header = taskHeaderDisplay(entries[0], entries)
        assertTrue(header.closed)
        assertEquals("Timeline cleanup", header.title)
        assertEquals("Manual · 5s", header.closureText)
    }

    @Test
    fun `judged closure makes a bare header visible with the summary as title`() {
        val entries = listOf(
            entry("task_start", timestamp = 1_000, summary = "Task 1", taskId = "a"),
            entry(
                "task_end", timestamp = 6_500, taskId = "a", boundarySignal = "session_end",
                summary = "Session end · 2 turns · 6m 5s",
                taskScore = 0.2, taskOutcome = "abandoned", taskSummary = "10min session with no commit",
            ),
        )
        val display = timelineDisplayGroups(groupConsecutive(entries))
        assertEquals(listOf("task_start"), display.map { it.entry.type })

        val header = taskHeaderDisplay(entries[0], entries)
        assertEquals("10min session with no commit", header.title)
        assertEquals("Session end · 2 turns · 6m 5s", header.closureText)
        assertEquals(0.2, header.taskScore!!, 1e-9)
        assertEquals("abandoned", header.taskOutcome)
    }

    @Test
    fun `judge summary outranks a meaningful own title`() {
        // Contract flip 2026-08-28 (shared/src/timeline-task-display.ts):
        // intent-derived titles hold the slot until the judge answers; once a
        // summary exists it wins, so the outcome sentence is never invisible.
        val entries = listOf(
            entry("task_start", timestamp = 1_000, summary = "Fix eink ticker", taskId = "a"),
            entry(
                "task_end", timestamp = 6_500, taskId = "a", boundarySignal = "session_end",
                summary = "Session end · 2 turns · 6m 5s",
                taskSummary = "Fixed the ticker overflow",
            ),
        )
        val header = taskHeaderDisplay(entries[0], entries)
        assertEquals("Fixed the ticker overflow", header.title)
    }

    @Test
    fun `interrupted reaper closure pair leaves no visible row`() {
        val entries = listOf(
            entry("task_start", timestamp = 1_000, summary = "Task 1", taskId = "a"),
            entry("task_end", timestamp = 6_500, taskId = "a", boundarySignal = "interrupted", summary = "Interrupted · ~6h"),
        )
        val display = timelineDisplayGroups(groupConsecutive(entries))
        assertTrue(display.none { it.entry.type == "task_start" || it.entry.type == "task_end" })
    }

    @Test
    fun `session_end task boundary is hidden from display projection`() {
        val entries = listOf(
            entry("task_start", timestamp = 1_000, summary = "Task 1", taskId = "a"),
            entry("chat_response", timestamp = 6_000, sessionId = "s", taskId = "a", startedAt = 2_000, endedAt = 6_000),
            entry("task_end", timestamp = 6_500, taskId = "a", boundarySignal = "session_end", summary = "Session end · 5s"),
        )

        val display = timelineDisplayGroups(groupConsecutive(entries))
        val types = display.map { it.entry.type }

        assertFalse(types.contains("task_start"))
        assertFalse(types.contains("task_end"))
        assertEquals(listOf("chat_response"), types)
    }

    @Test
    fun `idle_gap task boundary is hidden from display projection`() {
        val entries = listOf(
            entry("task_start", timestamp = 1_000, summary = "Task 1", taskId = "a"),
            entry("chat_response", timestamp = 6_000, sessionId = "s", taskId = "a", startedAt = 2_000, endedAt = 6_000),
            entry("task_end", timestamp = 6_500, taskId = "a", boundarySignal = "idle_gap", summary = "Idle gap · 928s"),
        )

        val display = timelineDisplayGroups(groupConsecutive(entries))
        val types = display.map { it.entry.type }

        assertFalse(types.contains("task_start"))
        assertFalse(types.contains("task_end"))
        assertEquals(listOf("chat_response"), types)
    }

    @Test
    fun `OpenClaw NO_REPLY polling responses are hidden from display projection`() {
        val entries = listOf(
            entry(
                "chat_response",
                timestamp = 1_000,
                summary = "Still translating - 2 entries in progress. No action needed.\n\nNO_REPLY",
                detail = "Two entries still translating -> pipeline not done yet.\n\nNO_REPLY",
                sessionId = "openclaw-a",
                projectName = "OpenClaw",
                agentType = "openclaw",
            ),
        )

        val display = timelineDisplayGroups(groupConsecutive(entries))
        assertTrue(display.isEmpty())
    }

    @Test
    fun `OpenClaw automated polling chat starts are hidden from display projection`() {
        val entries = listOf(
            entry(
                "chat_start",
                timestamp = 1_000,
                summary = "Still translating - 2 entries in progress, 1 failed. Not all terminal yet.",
                sessionId = "openclaw-a",
                projectName = "OpenClaw",
                agentType = "openclaw",
                automated = true,
            ),
        )

        val display = timelineDisplayGroups(groupConsecutive(entries))
        assertTrue(display.isEmpty())
    }

    @Test
    fun `OpenClaw LINE notification failures stay visible`() {
        val entries = listOf(
            entry(
                "chat_response",
                timestamp = 1_000,
                summary = "Pride and Prejudice published - LINE notification failed (userId 미등록, 4/21부터 지속)\n\nNO_REPLY",
                detail = "LINE target ID is still unconfigured. Notification remains pending.",
                sessionId = "openclaw-a",
                projectName = "OpenClaw",
                agentType = "openclaw",
            ),
        )

        val display = timelineDisplayGroups(groupConsecutive(entries))
        assertEquals(listOf("chat_response"), display.map { it.entry.type })
    }

    @Test
    fun `iconKey resolves to Task for task entries`() {
        assertEquals(TimelineIconKey.Task, timelineIconKey("task_start"))
        assertEquals(TimelineIconKey.Task, timelineIconKey("task_end"))
    }

    @Test
    fun `iconKey resolves tool_request status to success error awaiting`() {
        assertEquals(TimelineIconKey.Success, timelineIconKey("tool_request", "approved"))
        assertEquals(TimelineIconKey.Error, timelineIconKey("tool_request", "denied"))
        assertEquals(TimelineIconKey.Awaiting, timelineIconKey("tool_request", "pending"))
        assertEquals(TimelineIconKey.Awaiting, timelineIconKey("tool_request"))
    }

    @Test
    fun `eink glyphs are constant 4-char width`() {
        for (key in TimelineIconKey.values()) {
            assertEquals("eink glyph for $key", 4, key.einkGlyph.length)
        }
    }

    @Test
    fun `markdown parser parity with shared - basics`() {
        assertEquals(
            listOf(TimelineMarkdownLine.Plain("hello")),
            parseTimelineMarkdown("hello"),
        )
        val out = parseTimelineMarkdown("# Title\n- bullet\n1. one")
        assertEquals(3, out.size)
        assertTrue(out[0] is TimelineMarkdownLine.Heading)
        assertTrue(out[1] is TimelineMarkdownLine.Bullet)
        assertTrue(out[2] is TimelineMarkdownLine.Numbered)
    }

    @Test
    fun `markdown parser code fence is verbatim`() {
        val out = parseTimelineMarkdown("text\n```\n# not heading\n- not bullet\n```\nback")
        assertEquals(4, out.size)
        assertEquals(TimelineMarkdownLine.Plain("text"), out[0])
        assertTrue(out[1] is TimelineMarkdownLine.Code)
        assertEquals("# not heading", (out[1] as TimelineMarkdownLine.Code).content)
        assertTrue(out[2] is TimelineMarkdownLine.Code)
        assertEquals(TimelineMarkdownLine.Plain("back"), out[3])
    }

    @Test
    fun `detail redundancy fires when prefix matches summary`() {
        // The LLM summarizer often starts the response with a paraphrase of
        // the summary line. Both rendered side-by-side looks like duplicate
        // content with a slight color difference.
        assertTrue(
            timelineDetailIsRedundant(
                detail = "Did the thing. The change touches three files.",
                raw = "Did the thing · 4s",
            ),
        )
    }

    @Test
    fun `detail redundancy does not fire when content is genuinely new`() {
        assertFalse(
            timelineDetailIsRedundant(
                detail = "Notes:\n- updated parser\n- added tests",
                raw = "Refactor · 12s · 4 tools",
            ),
        )
    }

    @Test
    fun `summary is redundant with detail for standalone response prefix truncation`() {
        // Producers stamp summary = prefix(120/200) and detail = prefix(1000+)
        // of the same response text — the summary is always the body's opening
        // and must be suppressed, including a mid-word cut at the boundary.
        val full = "타임라인 중복 렌더 원인을 확인했습니다. Summary 라인이 detail 본문의 접두어라서 같은 텍스트가 " +
            "두 번 보였고, 게이트가 chat_response 분기에서 redundancy 검사를 건너뛰었습니다."
        assertTrue(timelineSummaryIsRedundantWithDetail(summary = full.take(60), detail = full))
        // Exact duplicate (short response: summary == detail).
        assertTrue(
            timelineSummaryIsRedundantWithDetail(
                summary = "빌드 완료. 테스트 42개 통과.",
                detail = "빌드 완료. 테스트 42개 통과.",
            ),
        )
        // Markdown-formatted detail vs plain summary opening.
        assertTrue(
            timelineSummaryIsRedundantWithDetail(
                summary = "정리 focusSession 의 시각 효과 추가됨",
                detail = "## 정리\n\n**focusSession 의 시각 효과 추가됨**\n\n추가 검증 내용",
            ),
        )
    }

    @Test
    fun `summary is not redundant for merged prompt-response turn`() {
        // Merged chat_start turn: summary = the user PROMPT, detail = the
        // assistant response. Different text — the summary must stay.
        assertFalse(
            timelineSummaryIsRedundantWithDetail(
                summary = "Timeline 메세지 출력이 정확한지 검증하라",
                detail = "반영했고 실제 Desktop 데몬에서 검증했습니다.\n\n검증:\n- vitest\n- xcodebuild",
            ),
        )
        // Very short summaries never suppress unless exactly equal.
        assertFalse(
            timelineSummaryIsRedundantWithDetail(
                summary = "완료",
                detail = "완료 처리했습니다. 추가로 문서도 갱신했습니다.",
            ),
        )
    }

    @Test
    fun `promote informative lead skips generic outcome paragraph`() {
        val raw = "반영했고 실제 Desktop 데몬에서 검증했습니다.\n\n원인은 Codex hook의 tool_exec 방송 구조였습니다."
        assertEquals(
            "원인은 Codex hook의 tool_exec 방송 구조였습니다.",
            timelinePromoteInformativeLead(raw, "chat_response"),
        )
        // Non-response types (e.g. the prompt on a merged turn) pass through.
        assertEquals(raw, timelinePromoteInformativeLead(raw, "chat_start"))
    }

    @Test
    fun `a rotating row draws the running glyph, not its own`() {
        // An open task_start spins. Before this rule Android rotated the
        // static Checklist glyph, which reads as a glitch rather than a
        // spinner; Apple already swapped in the circular arrow.
        val open = entry("task_start", timestamp = 1_000L, taskId = "task-A")
        assertTrue(isRotatingEntry(open, emptyList(), nowMs = 1_000L))
        assertEquals(TimelineIconKey.Task, timelineIconKey(open.type, open.status))
        assertEquals(ROTATING_ICON_KEY, timelineDisplayIconKey(open, emptyList(), nowMs = 1_000L))
        assertEquals(TimelineIconKey.Running, ROTATING_ICON_KEY)
    }

    @Test
    fun `a closed task returns to its own task glyph`() {
        val open = entry("task_start", timestamp = 1_000L, taskId = "task-A")
        val siblings = listOf(entry("task_end", timestamp = 1_010L, taskId = "task-A"))
        assertFalse(isRotatingEntry(open, siblings, nowMs = 1_000L))
        assertEquals(TimelineIconKey.Task, timelineDisplayIconKey(open, siblings, nowMs = 1_000L))
    }

    @Test
    fun `an error closes a turn so the spinner stops beside its explanation`() {
        // The TS and Swift mirrors both counted `error` as a completion; the
        // Kotlin mirror had dropped it, so a failed request kept spinning
        // right next to the error row that explained it.
        val chat = entry("chat_start", timestamp = 1_000L, sessionId = "sess-1")
        val err = entry("error", timestamp = 1_005L, sessionId = "sess-1")
        assertFalse(
            "a later same-session error must stop the spinner",
            isRotatingEntry(chat, listOf(err), nowMs = 1_000L),
        )
    }

    @Test
    fun `an error in a different session leaves the turn spinning`() {
        val chat = entry("chat_start", timestamp = 1_000L, sessionId = "sess-1")
        val other = entry("error", timestamp = 1_005L, sessionId = "sess-2")
        assertTrue(isRotatingEntry(chat, listOf(other), nowMs = 1_000L))
    }

    private fun entry(
        type: String,
        timestamp: Long = 0L,
        summary: String = "x",
        sessionId: String? = null,
        projectName: String? = null,
        agentType: String? = null,
        runId: String? = null,
        taskId: String? = null,
        boundarySignal: String? = null,
        startedAt: Long? = null,
        endedAt: Long? = null,
        detail: String? = null,
        automated: Boolean? = null,
        taskScore: Double? = null,
        taskOutcome: String? = null,
        taskSummary: String? = null,
    ) = TimelineEntry(
        timestamp = timestamp,
        type = type,
        summary = summary,
        detail = detail,
        sessionId = sessionId,
        projectName = projectName,
        agentType = agentType,
        runId = runId,
        taskId = taskId,
        boundarySignal = boundarySignal,
        startedAt = startedAt,
        endedAt = endedAt,
        automated = automated,
        taskScore = taskScore,
        taskOutcome = taskOutcome,
        taskSummary = taskSummary,
    )

    @Suppress("unused")
    private fun assertNotSameContext(a: TimelineEntry, b: TimelineEntry) {
        assertNotEquals(true, sameTimelineContext(a, b))
    }

    // ============================================================
    // stripMarkdownInline — e-ink plain-text fallback
    // ============================================================

    @Test
    fun `stripMarkdownInline drops markers including table syntax`() {
        val md = "## 정리\n\n**bold** and *italic* and `code`\n\n| col1 | col2 |\n|------|------|\n| a    | b    |\n| c    | d    |"
        val out = stripMarkdownInline(md)
        // No markdown markers leak.
        assertFalse("heading marker leaked", out.contains("##"))
        assertFalse("bold marker leaked", out.contains("**"))
        assertFalse("inline code marker leaked", out.contains("`"))
        // No pipe characters from table rows.
        assertFalse("table pipe leaked", out.contains('|'))
        // Header separator row is dropped entirely.
        assertFalse("table separator leaked", out.contains("---"))
        // Cells survive as content (space-delimited).
        assertTrue(out.contains("col1"))
        assertTrue(out.contains("col2"))
        assertTrue(out.contains("a"))
        assertTrue(out.contains("d"))
    }

    @Test
    fun `stripMarkdownInline preserves non-table pipes`() {
        // A line with a literal `|` mid-text shouldn't be touched (not a row).
        val out = stripMarkdownInline("Run cmd1 | cmd2 to see output")
        assertTrue(out.contains("cmd1 | cmd2"))
    }

    @Test
    fun `stripMarkdownInline handles single-cell table row`() {
        assertEquals("just one", stripMarkdownInline("| just one |"))
    }

    // ============================================================
    // isInFlightTask + isRotatingEntry — sibling-aware in-flight signal
    // ============================================================

    @Test
    fun `task_start without matching task_end is in flight`() {
        val taskStart = entry("task_start", taskId = "a", timestamp = 1_000L)
        assertTrue(isInFlightTask(taskStart, emptyList(), nowMs = 2_000L))
        assertTrue(isInFlightTask(taskStart, listOf(entry("task_start", taskId = "a")), nowMs = 2_000L))
    }

    @Test
    fun `task_start whose task_end (same taskId) appeared is finished`() {
        val taskStart = entry("task_start", taskId = "a")
        assertFalse(isInFlightTask(taskStart, listOf(entry("task_end", taskId = "a"))))
    }

    @Test
    fun `mismatched taskId on task_end does not close it`() {
        val taskStart = entry("task_start", taskId = "a", timestamp = 1_000L)
        assertTrue(isInFlightTask(taskStart, listOf(entry("task_end", taskId = "b")), nowMs = 2_000L))
    }

    @Test
    fun `task_start older than the staleness cap is no longer in flight`() {
        val taskStart = entry("task_start", taskId = "a", timestamp = 1_000L)
        assertFalse(isInFlightTask(taskStart, emptyList(), nowMs = 1_000L + IN_FLIGHT_TASK_MAX_AGE_MS + 1))
        assertTrue(isInFlightTask(taskStart, emptyList(), nowMs = 1_000L + 60_000L))
    }

    @Test
    fun `task_start without taskId is never considered in flight`() {
        val taskStart = entry("task_start", taskId = null)
        assertFalse(isInFlightTask(taskStart, emptyList()))
    }

    @Test
    fun `non task_start entries are never in flight`() {
        assertFalse(isInFlightTask(entry("chat_start"), emptyList()))
        assertFalse(isInFlightTask(entry("task_end", taskId = "a"), emptyList()))
    }

    @Test
    fun `fresh chat_start rotates via icon-key running`() {
        assertTrue(isRotatingEntry(entry("chat_start", timestamp = 1_000L), emptyList(), nowMs = 2_000L))
    }

    @Test
    fun `chat_start older than the age cap stops rotating`() {
        assertFalse(
            isRotatingEntry(
                entry("chat_start", timestamp = 1_000L),
                emptyList(),
                nowMs = 1_000L + ROTATING_ENTRY_MAX_AGE_MS + 1,
            ),
        )
    }

    @Test
    fun `chat_start with a later same-session completion stops rotating`() {
        val start = entry("chat_start", timestamp = 1_000L, sessionId = "a")
        val done = entry("chat_response", timestamp = 5_000L, sessionId = "a")
        assertFalse(isRotatingEntry(start, listOf(start, done), nowMs = 6_000L))
    }

    @Test
    fun `chat_start superseded by a newer same-session prompt stops rotating`() {
        val start = entry("chat_start", timestamp = 1_000L, sessionId = "a")
        val next = entry("chat_start", timestamp = 5_000L, sessionId = "a")
        assertFalse(isRotatingEntry(start, listOf(start, next), nowMs = 6_000L))
    }

    @Test
    fun `other sessions completions do not stop a running chat_start`() {
        val start = entry("chat_start", timestamp = 1_000L, sessionId = "a")
        val other = entry("chat_response", timestamp = 5_000L, sessionId = "b")
        assertTrue(isRotatingEntry(start, listOf(start, other), nowMs = 6_000L))
    }

    @Test
    fun `orphan task_start rotates via in-flight predicate`() {
        val taskStart = entry("task_start", taskId = "a", timestamp = 1_000L)
        assertTrue(isRotatingEntry(taskStart, listOf(taskStart), nowMs = 2_000L))
    }

    @Test
    fun `closed task_start does not rotate`() {
        val taskStart = entry("task_start", taskId = "a")
        assertFalse(isRotatingEntry(taskStart, listOf(entry("task_end", taskId = "a"))))
    }

    @Test
    fun `static rows do not rotate`() {
        assertFalse(isRotatingEntry(entry("tool_exec"), emptyList()))
        assertFalse(isRotatingEntry(entry("model_call"), emptyList()))
        assertFalse(isRotatingEntry(entry("chat_end"), emptyList()))
    }

    @Test
    fun `eval_result and task_end never rotate`() {
        assertFalse(isRotatingEntry(entry("eval_result"), emptyList()))
        assertFalse(isRotatingEntry(entry("task_end", taskId = "a"), emptyList()))
    }
}
