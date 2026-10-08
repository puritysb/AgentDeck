package dev.agentdeck.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineDisplayScenarioTest {


    @Test
    fun `eink projection retains latest tool after three unrelated prompts`() {
        val prompt = TimelineEntry(1000, "chat_start", "Inspect disk usage", sessionId = "own", runId = "r")
        val noise = (0 until 3).map { TimelineEntry(2000L + it, "chat_start", "Other prompt $it", sessionId = "other-$it") }
        val tool = TimelineEntry(5000, "tool_exec", "Latest disk result", detail = "Disk evidence", sessionId = "own", runId = "r")
        val entries = listOf(prompt) + noise + tool
        val recent = recentTimelineDisplayGroups(entries, 3)
        assertEquals(3, recent.size)
        assertEquals(prompt, recent.last().entry)
        assertEquals(listOf(tool), recent.last().toolActivity)
        assertEquals("Latest disk result", timelineLatestActivityEntry(recent.last()).summary)
        assertEquals(5000L, timelineLatestActivityEntry(recent.last()).timestamp)
        // Attribution still runs in source order, before the projection sort.
        assertEquals(prompt, groupConsecutive(entries).first().entry)
    }

    @Test
    fun `lcd projection retains latest reply after eighty unrelated turns`() {
        val prompt = TimelineEntry(1000, "chat_start", "Inspect disk usage", sessionId = "own", runId = "r")
        val noise = (0 until 80).map { TimelineEntry(2000L + it, "chat_start", "Other prompt $it", sessionId = "other-$it") }
        val tool = TimelineEntry(5000, "tool_exec", "Disk evidence", sessionId = "own", runId = "r")
        val reply = TimelineEntry(6000, "chat_response", "Latest disk reply", sessionId = "own", runId = "r", startedAt = 1000)
        val recent = recentTimelineDisplayGroups(listOf(prompt) + noise + listOf(tool, reply), 50)
        assertEquals(50, recent.size)
        assertEquals(prompt, recent.last().entry)
        assertEquals(reply, recent.last().mergedResponse)
        assertEquals(listOf(tool), recent.last().toolActivity)
        assertEquals("Latest disk reply", timelineLatestActivityEntry(recent.last()).summary)
    }

    @Test
    fun `folded tool result endedAt outranks a reply without changing the turn identity`() {
        val prompt = TimelineEntry(1000, "chat_start", "Inspect disk", sessionId = "own", runId = "r")
        val tool = TimelineEntry(1500, "tool_exec", "exec ×42", detail = "Failure evidence", sessionId = "own", runId = "r", endedAt = 9000)
        val reply = TimelineEntry(7000, "chat_response", "Earlier reply", sessionId = "own", runId = "r", startedAt = 1000)
        val other = TimelineEntry(8000, "chat_start", "Other request", sessionId = "other")
        val group = recentTimelineDisplayGroups(listOf(prompt, tool, reply, other), 3).last()
        assertEquals(prompt, group.entry)
        assertEquals(reply, group.mergedResponse)
        assertEquals("exec ×42", timelineLatestActivityEntry(group).summary)
        assertEquals("Failure evidence", timelineLatestActivityEntry(group).detail)
        assertEquals(9000L, timelineLatestActivityEntry(group).timestamp)
    }

    @Test
    fun `merged completion and progressive responses advance recency`() {
        val prompt = TimelineEntry(1000, "chat_start", "Inspect disk", sessionId = "own", runId = "r")
        val tool = TimelineEntry(1500, "tool_exec", "Disk evidence", sessionId = "own", runId = "r", endedAt = 7000)
        val other = TimelineEntry(8000, "chat_start", "Other request", sessionId = "other")
        val completion = TimelineEntry(2000, "chat_end", "Completed disk check", sessionId = "own", runId = "r", startedAt = 1000, endedAt = 9000)
        val completeGroup = recentTimelineDisplayGroups(listOf(prompt, tool, completion, other), 3).last()
        assertEquals(completion, completeGroup.mergedCompletion)
        assertEquals(9000L, timelineGroupActivityAt(completeGroup))
        assertEquals("Completed disk check", timelineLatestActivityEntry(completeGroup).summary)
        val progress = TimelineEntry(9000, "chat_response", "Still checking", sessionId = "own", runId = "r", startedAt = 1000, summaryKind = "progress")
        val progressGroup = recentTimelineDisplayGroups(listOf(prompt, tool, other, progress), 3).last()
        assertEquals(9000L, timelineGroupActivityAt(progressGroup))
        assertEquals("Disk evidence", timelineLatestActivityEntry(progressGroup).summary)
        assertEquals(9000L, timelineLatestActivityEntry(progressGroup).timestamp)
    }

    @Test
    fun `equal activity timestamps preserve chronological group order before the cap`() {
        val a = TimelineEntry(1000, "chat_start", "Request A", sessionId = "a")
        val b = TimelineEntry(2000, "chat_start", "Request B", sessionId = "b")
        val entries = listOf(a, b,
            TimelineEntry(3000, "tool_exec", "A result", sessionId = "a"),
            TimelineEntry(3000, "tool_exec", "B result", sessionId = "b"))
        assertEquals(listOf("a", "b"), recentTimelineDisplayGroups(entries, 3).map { it.entry.sessionId })
        assertEquals("b", recentTimelineDisplayGroups(entries, 1).single().entry.sessionId)
    }

    @Test
    fun `selected and expanded turns keep their identity when activity reorders rows`() {
        val a = TimelineEntry(1000, "chat_start", "Request A", sessionId = "a")
        val b = TimelineEntry(2000, "chat_start", "Request B", sessionId = "b")
        val before = recentTimelineDisplayGroups(listOf(a, b), 50)
        val selected = timelineGroupKey(before[1])
        val expanded = timelineGroupKey(before[0])
        val after = recentTimelineDisplayGroups(listOf(a.copy(summary = "Enriched A"), b,
            TimelineEntry(5000, "tool_exec", "A result", sessionId = "a")), 50)
        assertEquals(0, timelineSelectedGroupIndex(after, selected))
        assertEquals("b", after[timelineSelectedGroupIndex(after, selected)].entry.sessionId)
        assertEquals(1, timelineSelectedGroupIndex(after, expanded))
        assertEquals("a", after[timelineSelectedGroupIndex(after, expanded)].entry.sessionId)
        assertEquals(timelineGroupItemKeys(before).toSet(), timelineGroupItemKeys(after).toSet())
        val legacy = listOf(GroupedEntry(TimelineEntry(1000, "error", "One")), GroupedEntry(TimelineEntry(1000, "error", "Two")))
        assertEquals(2, timelineGroupItemKeys(legacy).toSet().size)
        assertEquals(-1, timelineSelectedGroupIndex(legacy, timelineGroupKey(legacy[0])))
    }

    @Test
    fun `legacy collision keys are assigned before recency sorting and remain selectable`() {
        val a = TimelineEntry(1000, "tool_exec", "Legacy A", endedAt = 2000)
        val b = TimelineEntry(1000, "tool_exec", "Legacy B", endedAt = 3000)
        val initial = recentTimelineDisplayGroups(listOf(a), 50)
        val initialSelection = timelineGroupKey(initial.single())
        val before = recentTimelineDisplayGroups(listOf(a, b), 50)
        assertEquals(0, timelineSelectedGroupIndex(before, initialSelection))
        val selected = timelineGroupKey(before[1])
        val after = recentTimelineDisplayGroups(listOf(a.copy(endedAt = 4000), b), 50)
        assertEquals(2, timelineGroupItemKeys(after).toSet().size)
        assertEquals(after.map(::timelineGroupKey), timelineGroupItemKeys(after))
        assertEquals(0, timelineSelectedGroupIndex(after, selected))
        assertEquals("Legacy B", after[timelineSelectedGroupIndex(after, selected)].entry.summary)
        val contexts = recentTimelineDisplayGroups(listOf(a.copy(agentType = "openclaw", projectName = "A"),
            b.copy(agentType = "claude-code", projectName = "B")), 50)
        assertEquals(2, timelineGroupItemKeys(contexts).toSet().size)
    }

    @Test
    fun `same millisecond child content wins over the prompt on eink`() {
        val prompt = TimelineEntry(1000, "chat_start", "Inspect disk", sessionId = "own", runId = "r")
        val reply = TimelineEntry(1000, "chat_response", "Disk reply", sessionId = "own", runId = "r", startedAt = 1000)
        val group = recentTimelineDisplayGroups(listOf(prompt, reply), 3).single()
        assertEquals("Disk reply", timelineLatestActivityEntry(group).summary)
        assertEquals(prompt, group.entry)
    }

    @Test
    fun `multi-agent dashboard timeline projects meaningful session rows`() {
        val entries = listOf(
            event(1_000, "chat_start", "Fix Android timeline", "claude-a", "claude-code", "AgentDeck", startedAt = 1_000),
            event(2_000, "tool_request", "Edit TimelineStrip.kt", "claude-a", "claude-code", "AgentDeck"),
            event(6_000, "chat_response", "Android Timeline now shows unit-session summaries", "claude-a", "claude-code", "AgentDeck", startedAt = 1_000, endedAt = 6_000),
            event(6_200, "chat_end", "Completed", "claude-a", "claude-code", "AgentDeck", startedAt = 1_000, endedAt = 6_200),
            event(6_500, "eval_result", "★ turn 91% [code] Android timeline projection verified", "claude-a", "claude-code", "AgentDeck", startedAt = 1_000, endedAt = 6_200),

            event(1_500, "chat_start", "Audit parser", "codex-a", "codex-cli", "Compiler", startedAt = 1_500),
            event(2_500, "tool_exec", "Bash: pnpm vitest", "codex-a", "codex-cli", "Compiler"),

            event(2_200, "chat_response", "OpenClaw routed dashboard health check", "openclaw-a", "openclaw", "Gateway", startedAt = 2_000, endedAt = 2_200),
            event(2_800, "chat_response", "OpenCode generated Rust port summary", "opencode-a", "opencode", "RustPort", startedAt = 2_000, endedAt = 2_800),
        ).sortedBy { it.timestamp }

        val display = timelineDisplayGroups(groupConsecutive(entries))
        val renderedKeys = display.map { "${it.entry.sessionId}:${it.entry.type}:${it.entry.projectName}" }

        // Updated 2026-05-10: meaningful chat_start ("Fix Android timeline")
        // is now kept post-completion so the user's prompt stays visible.
        // Synthetic starters ("Prompt sent" etc.) still hide.
        assertTrue(
            "Meaningful Claude prompt row should remain visible alongside response",
            renderedKeys.contains("claude-a:chat_start:AgentDeck"),
        )
        assertFalse(
            "chat_end should not duplicate a chat_response for the same turn",
            renderedKeys.contains("claude-a:chat_end:AgentDeck"),
        )
        // Updated 2026-07-06: the interleave-tolerant turn merge folds the
        // response into its chat_start group even across other sessions' rows
        // — it renders as the turn's sub-line, not a standalone row.
        val claudeTurn = display.first { it.entry.sessionId == "claude-a" && it.entry.type == "chat_start" }
        assertTrue(
            "Claude response should fold into its turn group",
            claudeTurn.mergedResponse?.summary?.contains("unit-session summaries") == true,
        )
        assertFalse(renderedKeys.contains("claude-a:chat_response:AgentDeck"))
        assertTrue(renderedKeys.contains("claude-a:eval_result:AgentDeck"))
        assertTrue(
            "In-flight Codex turn should remain visible until completion",
            renderedKeys.contains("codex-a:chat_start:Compiler"),
        )
        assertTrue(renderedKeys.contains("openclaw-a:chat_response:Gateway"))
        assertTrue(renderedKeys.contains("opencode-a:chat_response:RustPort"))

        val agentTypes = display.mapNotNull { it.entry.agentType }.distinct()
        assertEquals(4, agentTypes.size)
        assertTrue(agentTypes.containsAll(listOf("claude-code", "codex-cli", "openclaw", "opencode")))
    }

    @Test
    fun `codex tool entries are suppressed from device timeline`() {
        val entries = listOf(
            event(1_000, "chat_start", "Real prompt", "codex-real", "codex-cli", "Compiler"),
            // codex:otel-active sentinel: bridge wires synthetic OTel rows here.
            // raws: "tool", "exec", "unknown" — strictly noise, drop.
            event(1_100, "tool_exec", "tool", "codex:otel-active", "codex-cli", "Compiler"),
            event(1_200, "tool_request", "exec", "codex:otel-active", "codex-cli", "Compiler"),
            event(1_300, "tool_resolved", "tool completed", "codex:otel-active", "codex-cli", "Compiler"),
            // Same session_id but raw is meaningful-looking. Device timeline still
            // drops Codex tool_exec firehose; APME keeps the internal trajectory.
            event(1_400, "tool_exec", "Bash: pnpm vitest", "codex:otel-active", "codex-cli", "Compiler"),
        )
        val display = timelineDisplayGroups(groupConsecutive(entries))
        val rendered = display.map { it.entry.summary }

        assertFalse("OTel synthetic 'tool' raw should be hidden", rendered.contains("tool"))
        assertFalse("OTel synthetic 'exec' raw should be hidden", rendered.contains("exec"))
        assertFalse("OTel 'tool completed' raw should be hidden", rendered.contains("tool completed"))
        assertFalse("Codex Bash command firehose must be hidden", rendered.contains("Bash: pnpm vitest"))
        assertTrue("Real prompt remains visible", rendered.contains("Real prompt"))
    }

    @Test
    fun `synthetic chat_start is suppressed once completion arrives`() {
        // "Codex turn started" / "Prompt sent" / "Connected" / "Resumed" /
        // "Starting chat" are bridge-inserted lifecycle markers — once a
        // completion arrives they should be elided. A meaningful prompt with
        // identical lifecycle stays visible.
        val entries = listOf(
            event(1_000, "chat_start", "Codex turn started", "codex-1", "codex-cli", "App", startedAt = 1_000),
            event(2_000, "chat_response", "Built ok", "codex-1", "codex-cli", "App", startedAt = 1_000, endedAt = 2_000),

            event(3_000, "chat_start", "Refactor TimelineStrip", "codex-2", "codex-cli", "App", startedAt = 3_000),
            event(5_000, "chat_response", "Done", "codex-2", "codex-cli", "App", startedAt = 3_000, endedAt = 5_000),
        )
        val display = timelineDisplayGroups(groupConsecutive(entries))
        val keys = display.map { "${it.entry.sessionId}:${it.entry.type}:${it.entry.summary}" }

        assertFalse(
            "Synthetic 'Codex turn started' should not survive completion",
            keys.contains("codex-1:chat_start:Codex turn started"),
        )
        assertTrue(
            "Meaningful user prompt should remain alongside the response",
            keys.contains("codex-2:chat_start:Refactor TimelineStrip"),
        )
    }

    @Test
    fun `task notification chat_start is suppressed`() {
        val entries = listOf(
            TimelineEntry(
                timestamp = 1_000,
                type = "chat_start",
                summary = "<task-notification>\n<summary>Background command completed</summary>",
                detail = "<task-notification>\n<summary>Background command completed</summary>",
                sessionId = "claude-a",
                agentType = "claude-code",
                projectName = "AgentDeck",
                startedAt = 1_000,
            ),
            event(
                2_000,
                "chat_response",
                "Flash completed successfully",
                "claude-a",
                "claude-code",
                "AgentDeck",
                startedAt = 1_000,
                endedAt = 2_000,
            ),
        )

        val display = timelineDisplayGroups(groupConsecutive(entries))
        assertEquals(listOf("chat_response"), display.map { it.entry.type })
        assertEquals("Flash completed successfully", display[0].entry.summary)
    }

    @Test
    fun `chat_end is hidden when chat_response already represents the same turn`() {
        // chat_end is completion metadata for the response row. It should not
        // appear as a second standalone item for the same assistant answer,
        // even when summaryKind names the summarizer backend.
        val withSummary = TimelineEntry(
            timestamp = 6_000,
            type = "chat_end",
            summary = "Completed · 4s",
            sessionId = "claude-a",
            agentType = "claude-code",
            projectName = "AgentDeck",
            startedAt = 1_000,
            endedAt = 6_000,
            summaryKind = "llm",
        )
        val withoutSummary = withSummary.copy(timestamp = 6_500, sessionId = "claude-b", summaryKind = "none")
        val response = TimelineEntry(
            timestamp = 5_900,
            type = "chat_response",
            summary = "Body",
            sessionId = "claude-a",
            agentType = "claude-code",
            projectName = "AgentDeck",
            startedAt = 1_000,
            endedAt = 5_900,
        )
        val responseB = response.copy(timestamp = 6_400, sessionId = "claude-b")
        val display = timelineDisplayGroups(groupConsecutive(listOf(response, responseB, withSummary, withoutSummary).sortedBy { it.timestamp }))
        val pairs = display.map { it.entry.sessionId to it.entry.type }

        assertFalse("chat_end with summaryKind=llm must drop next to chat_response", pairs.contains("claude-a" to "chat_end"))
        assertFalse("chat_end with summaryKind=none must drop next to chat_response", pairs.contains("claude-b" to "chat_end"))
    }

    @Test
    fun `chat_end is hidden when chat_start already represents a response-less turn`() {
        val entries = listOf(
            event(
                1_000,
                "chat_start",
                "Review timeline exposure",
                "claude-a",
                "claude-code",
                "AgentDeck",
                startedAt = 1_000,
            ),
            event(
                4_000,
                "chat_end",
                "Completed · Review timeline exposure",
                "claude-a",
                "claude-code",
                "AgentDeck",
                startedAt = 1_000,
                endedAt = 4_000,
            ).copy(summaryKind = "heuristic"),
        )

        val display = timelineDisplayGroups(groupConsecutive(entries))

        assertEquals(listOf("chat_start"), display.map { it.entry.type })
        assertEquals("Review timeline exposure", display[0].entry.summary)
    }

    @Test
    fun `synthetic response-less turn is hidden completely`() {
        val entries = listOf(
            event(
                1_000,
                "chat_start",
                "Prompt sent",
                "claude-a",
                "claude-code",
                "AgentDeck",
                startedAt = 1_000,
            ),
            event(
                4_000,
                "chat_end",
                "Completed · 3s",
                "claude-a",
                "claude-code",
                "AgentDeck",
                startedAt = 1_000,
                endedAt = 4_000,
            ).copy(summaryKind = "none"),
        )

        val display = timelineDisplayGroups(groupConsecutive(entries))

        assertTrue(display.isEmpty())
    }

    @Test
    fun `progress chat_response and progress chat_end are hidden`() {
        val entries = listOf(
            event(
                1_000,
                "chat_response",
                "The build is still running",
                "codex-a",
                "codex-cli",
                "AgentDeck",
                startedAt = 500,
                endedAt = 1_000,
            ).copy(summaryKind = "progress"),
            event(
                1_100,
                "chat_end",
                "Completed · 1s · In progress",
                "codex-a",
                "codex-cli",
                "AgentDeck",
                startedAt = 500,
                endedAt = 1_100,
            ).copy(summaryKind = "progress"),
        )

        val display = timelineDisplayGroups(groupConsecutive(entries))

        assertTrue(display.isEmpty())
    }

    @Test
    fun `same timestamp summaries stay separate by agent and project`() {
        val entries = listOf(
            event(10_000, "chat_end", "Summary", "claude-a", "claude-code", "AgentDeck"),
            event(10_050, "chat_end", "Summary", "claude-b", "claude-code", "ViewTrans"),
            event(10_100, "chat_end", "Summary", "codex-a", "codex-cli", "AgentDeck"),
        )

        val groups = groupConsecutive(entries)

        assertEquals(3, groups.size)
        assertEquals(listOf("AgentDeck", "ViewTrans", "AgentDeck"), groups.map { it.entry.projectName })
        assertEquals(listOf("claude-code", "claude-code", "codex-cli"), groups.map { it.entry.agentType })
    }

    // --- Queued / superseded (folded) prompt detection (Apple parity) ---

    /** Real scenario: two prompts ~26 s apart to one observed Codex session.
     *  Codex coalesces them into one turn, emits a single Stop stamped to the
     *  second prompt's anchor. The reply merges into the later turn; the first
     *  must be detected as folded (→ fold glyph + borrowed reply), the second
     *  as the turn that absorbed it (→ "shared" tag) — not a spinning orphan. */
    @Test
    fun `queued prompt folds into next turn`() {
        val entries = listOf(
            event(1000, "chat_start", "commit the rest", "codex:x", "codex-cli", "AgentDeck", startedAt = 1000),
            event(2000, "chat_start", "push too", "codex:x", "codex-cli", "AgentDeck", startedAt = 2000),
            event(3000, "chat_response", "committed + pushed", "codex:x", "codex-cli", "AgentDeck", startedAt = 2000, endedAt = 3000),
            event(3001, "chat_end", "Completed · 57s", "codex:x", "codex-cli", "AgentDeck", startedAt = 2000, endedAt = 3001),
        )
        val groups = groupConsecutive(entries)
        val first = groups.first { it.entry.summary == "commit the rest" }
        val second = groups.first { it.entry.summary == "push too" }
        assertFalse("first prompt keeps no reply of its own", first.hasResponse)
        assertTrue("second prompt absorbed the shared reply", second.hasResponse)

        val shared = timelineSupersededSharedResponse(first.entry, first.hasResponse, entries)
        assertEquals("committed + pushed", shared?.summary)
        assertTrue(timelineAbsorbsQueuedPrompt(second.entry, second.hasResponse, entries))
        assertNull(timelineSupersededSharedResponse(second.entry, second.hasResponse, entries))
        // The folded prompt still renders (meaningful chat_start survives filter).
        val display = timelineDisplayGroups(groups)
        assertTrue(display.any { it.entry.summary == "commit the rest" })
    }

    @Test
    fun `answered turn is not folded`() {
        val entries = listOf(
            event(1000, "chat_start", "hi", "s1", "claude-code", "AgentDeck", startedAt = 1000),
            event(2000, "chat_response", "hello", "s1", "claude-code", "AgentDeck", startedAt = 1000, endedAt = 2000),
        )
        val groups = groupConsecutive(entries)
        assertNull(timelineSupersededSharedResponse(groups[0].entry, groups[0].hasResponse, entries))
        assertFalse(timelineAbsorbsQueuedPrompt(groups[0].entry, groups[0].hasResponse, entries))
    }

    @Test
    fun `still-open queued prompts are not folded`() {
        val entries = listOf(
            event(1000, "chat_start", "first", "s1", "claude-code", "AgentDeck", startedAt = 1000),
            event(2000, "chat_start", "second", "s1", "claude-code", "AgentDeck", startedAt = 2000),
        )
        val groups = groupConsecutive(entries)
        assertNull(timelineSupersededSharedResponse(groups[0].entry, groups[0].hasResponse, entries))
        assertNull(timelineSupersededSharedResponse(groups[1].entry, groups[1].hasResponse, entries))
    }

    @Test
    fun `task_end boundary blocks fold`() {
        val entries = listOf(
            event(1000, "chat_start", "orphaned", "s1", "claude-code", "AgentDeck", startedAt = 1000),
            TimelineEntry(1500, "task_end", "Session end", sessionId = "s1", agentType = "claude-code", projectName = "AgentDeck", taskId = "t1"),
            event(2000, "chat_start", "next session prompt", "s1", "claude-code", "AgentDeck", startedAt = 2000),
            event(3000, "chat_response", "reply", "s1", "claude-code", "AgentDeck", startedAt = 2000, endedAt = 3000),
        )
        val orphan = entries.first { it.summary == "orphaned" }
        assertNull(timelineSupersededSharedResponse(orphan, false, entries))
    }

    private fun event(
        timestamp: Long,
        type: String,
        summary: String,
        sessionId: String,
        agentType: String,
        projectName: String,
        startedAt: Long? = null,
        endedAt: Long? = null,
    ) = TimelineEntry(
        timestamp = timestamp,
        type = type,
        summary = summary,
        sessionId = sessionId,
        agentType = agentType,
        projectName = projectName,
        startedAt = startedAt,
        endedAt = endedAt,
    )
}
