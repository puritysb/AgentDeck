package dev.agentdeck.state

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class TimelineStoreTest {

    // Use reflection to create fresh instances (singleton pattern)
    private lateinit var store: TimelineStore

    @Before
    fun setUp() {
        // Access the singleton and clear it
        store = TimelineStore.instance
        store.clear()
    }

    // --- addEntry ---

    @Test
    fun `addEntry stores entry`() {
        store.addEntry(entry(1000, "chat_start", "Hello"))
        assertEquals(1, store.entries.value.size)
        assertEquals("Hello", store.entries.value[0].summary)
    }

    @Test
    fun `addEntry deduplicates within 5s window`() {
        store.addEntry(entry(1000, "tool_request", "Read file.ts"))
        store.addEntry(entry(3000, "tool_request", "Read file.ts"))  // within 5s, same type+summary
        assertEquals(1, store.entries.value.size)
    }

    @Test
    fun `addEntry allows same type+summary after 5s`() {
        store.addEntry(entry(1000, "tool_request", "Read file.ts"))
        store.addEntry(entry(7000, "tool_request", "Read file.ts"))  // after 5s
        assertEquals(2, store.entries.value.size)
    }

    @Test
    fun `addEntry allows different type within 5s`() {
        store.addEntry(entry(1000, "tool_request", "Read file.ts"))
        store.addEntry(entry(2000, "chat_end", "Read file.ts"))  // different type
        assertEquals(2, store.entries.value.size)
    }

    @Test
    fun `addEntry allows different summary within 5s`() {
        store.addEntry(entry(1000, "tool_request", "Read a.ts"))
        store.addEntry(entry(2000, "tool_request", "Read b.ts"))  // different summary
        assertEquals(2, store.entries.value.size)
    }

    @Test
    fun `addEntry caps at MAX_ENTRIES`() {
        // Add 600 entries (MAX = 500)
        for (i in 1..600) {
            store.addEntry(entry(i * 10_000L, "chat_start", "Entry $i"))
        }
        assertEquals(500, store.entries.value.size)
        // First entries should be trimmed, last should remain
        assertEquals("Entry 600", store.entries.value.last().summary)
    }

    // --- upsertEntry ---

    @Test
    fun `upsertEntry updates existing entry within 1s tolerance`() {
        store.addEntry(entry(1000, "chat_end", "Original"))
        store.upsertEntry(entry(1500, "chat_end", "Updated"))  // within 1s
        assertEquals(1, store.entries.value.size)
        assertEquals("Updated", store.entries.value[0].summary)
    }

    @Test
    fun `upsertEntry adds new entry if no match`() {
        store.addEntry(entry(1000, "chat_end", "First"))
        store.upsertEntry(entry(5000, "chat_end", "Second"))  // >1s gap
        assertEquals(2, store.entries.value.size)
    }

    @Test
    fun `upsertEntry preserves existing detail if new detail is null`() {
        store.addEntry(TimelineEntry(1000, "chat_end", "Summary", detail = "Existing detail"))
        store.upsertEntry(entry(1000, "chat_end", "Updated summary"))  // null detail
        assertEquals("Existing detail", store.entries.value[0].detail)
        assertEquals("Updated summary", store.entries.value[0].summary)
    }

    @Test
    fun `upsertEntry preserves timeline attribution`() {
        store.addEntry(entry(1000, "chat_end", "Summary"))
        store.upsertEntry(
            TimelineEntry(
                timestamp = 1000,
                type = "chat_end",
                summary = "Updated summary",
                projectName = "AgentDeck",
                sessionId = "session-1",
            )
        )
        assertEquals("AgentDeck", store.entries.value[0].projectName)
        assertEquals("session-1", store.entries.value[0].sessionId)
    }

    @Test
    fun `upsertEntry propagates summaryKind progression heuristic to llm`() {
        // The async LLM upsert flips summaryKind from 'heuristic' / 'none' to
        // 'llm'. Without propagation the dashboard keeps the old kind and the
        // detail pane (suppressed for 'none') stays hidden after rescue.
        store.addEntry(
            TimelineEntry(
                timestamp = 1000, type = "chat_end",
                summary = "Completed · 4s",
                detail = "response body",
                summaryKind = "none",
            )
        )
        assertEquals("none", store.entries.value[0].summaryKind)

        store.upsertEntry(
            TimelineEntry(
                timestamp = 1000, type = "chat_end",
                summary = "Refactored timeline store · 4s",
                summaryKind = "llm",
            )
        )
        assertEquals("llm", store.entries.value[0].summaryKind)
        assertEquals("Refactored timeline store · 4s", store.entries.value[0].summary)
    }

    @Test
    fun `upsertEntry preserves existing summaryKind when new entry omits it`() {
        store.addEntry(
            TimelineEntry(
                timestamp = 1000, type = "chat_end",
                summary = "Done", summaryKind = "heuristic",
            )
        )
        store.upsertEntry(entry(1000, "chat_end", "Done v2")) // no summaryKind set
        assertEquals("heuristic", store.entries.value[0].summaryKind)
    }

    // --- updateLastOfType ---

    @Test
    fun `updateLastOfType modifies the last matching entry`() {
        store.addEntry(entry(1000, "chat_start", "First"))
        store.addEntry(entry(10000, "chat_start", "Second"))
        store.addEntry(entry(20000, "tool_request", "Read"))

        store.updateLastOfType("chat_start") { it.copy(summary = "Modified") }
        val chatStarts = store.entries.value.filter { it.type == "chat_start" }
        assertEquals("First", chatStarts[0].summary)
        assertEquals("Modified", chatStarts[1].summary)
    }

    @Test
    fun `updateLastOfType no-op if type not found`() {
        store.addEntry(entry(1000, "chat_start", "Hello"))
        store.updateLastOfType("nonexistent") { it.copy(summary = "Modified") }
        assertEquals("Hello", store.entries.value[0].summary)
    }

    // --- addEntries ---

    @Test
    fun `addEntries merges and deduplicates`() {
        store.addEntry(entry(1000, "chat_start", "First"))
        store.addEntries(listOf(
            entry(1000, "chat_start", "First"),  // duplicate
            entry(2000, "chat_end", "Second"),
        ))
        assertEquals(2, store.entries.value.size)
    }

    @Test
    fun `addEntries sorts by timestamp`() {
        store.addEntries(listOf(
            entry(3000, "c", "Third"),
            entry(1000, "a", "First"),
            entry(2000, "b", "Second"),
        ))
        assertEquals(1000, store.entries.value[0].timestamp)
        assertEquals(2000, store.entries.value[1].timestamp)
        assertEquals(3000, store.entries.value[2].timestamp)
    }

    // --- groupConsecutive ---

    @Test
    fun `groupConsecutive empty list returns empty`() {
        assertEquals(emptyList<GroupedEntry>(), groupConsecutive(emptyList()))
    }

    @Test
    fun `groupConsecutive single entry`() {
        val result = groupConsecutive(listOf(entry(1000, "chat_start", "Hello")))
        assertEquals(1, result.size)
        assertEquals(1, result[0].count)
    }

    @Test
    fun `groupConsecutive groups tool_request within 10s`() {
        val entries = listOf(
            entry(1000, "tool_request", "Read a.ts").copy(sessionId = "s1"),
            entry(5000, "tool_request", "Write b.ts").copy(sessionId = "s1"),  // within 10s, same session
            entry(8000, "tool_request", "Edit c.ts").copy(sessionId = "s1"),   // within 10s of prev
        )
        val result = groupConsecutive(entries)
        assertEquals(1, result.size)
        assertEquals(3, result[0].count)
        assertEquals("Edit c.ts", result[0].entry.summary)  // latest kept
    }

    @Test
    fun `groupConsecutive splits tool_request after 10s gap`() {
        val entries = listOf(
            entry(1000, "tool_request", "Read a.ts").copy(sessionId = "s1"),
            entry(20000, "tool_request", "Read b.ts").copy(sessionId = "s1"),  // >10s gap
        )
        val result = groupConsecutive(entries)
        assertEquals(2, result.size)
    }

    @Test
    fun `groupConsecutive does not merge tool_request across sessions`() {
        val entries = listOf(
            entry(1000, "tool_request", "Read a.ts").copy(sessionId = "claude-a", projectName = "AgentDeck"),
            entry(5000, "tool_request", "Write b.ts").copy(sessionId = "codex-a", projectName = "Compiler"),
        )
        val result = groupConsecutive(entries)
        assertEquals(2, result.size)
    }

    @Test
    fun `groupConsecutive does not merge distinct run ids on same session`() {
        val entries = listOf(
            entry(1000, "tool_request", "Read a.ts").copy(sessionId = "s1", runId = "run-a"),
            entry(5000, "tool_request", "Write b.ts").copy(sessionId = "s1", runId = "run-b"),
        )
        val result = groupConsecutive(entries)
        assertEquals(2, result.size)
    }

    @Test
    fun `groupConsecutive groups chat_end by type only within 60s`() {
        val entries = listOf(
            entry(1000, "chat_end", "Summary A").copy(sessionId = "s1"),
            entry(30000, "chat_end", "Summary B").copy(sessionId = "s1"),  // different summary, still groups
        )
        val result = groupConsecutive(entries)
        assertEquals(1, result.size)
        assertEquals(2, result[0].count)
        assertEquals("Summary B", result[0].entry.summary)  // latest kept
    }

    @Test
    fun `groupConsecutive does not merge chat_end across projects`() {
        val entries = listOf(
            entry(1000, "chat_end", "AgentDeck summary").copy(projectName = "AgentDeck", agentType = "claude-code"),
            entry(30000, "chat_end", "Compiler summary").copy(projectName = "Compiler", agentType = "claude-code"),
        )
        val result = groupConsecutive(entries)
        assertEquals(2, result.size)
    }

    @Test
    fun `groupConsecutive requires same summary for other types`() {
        val entries = listOf(
            entry(1000, "chat_start", "Hello"),
            entry(5000, "chat_start", "World"),  // different summary
        )
        val result = groupConsecutive(entries)
        assertEquals(2, result.size)
    }

    @Test
    fun `groupConsecutive groups same summary within 60s`() {
        val entries = listOf(
            entry(1000, "error", "Connection lost"),
            entry(30000, "error", "Connection lost"),
        )
        val result = groupConsecutive(entries)
        assertEquals(1, result.size)
        assertEquals(2, result[0].count)
    }

    @Test
    fun `groupConsecutive splits different types but folds the turn completion`() {
        val entries = listOf(
            entry(1000, "chat_start", "Hello"),
            entry(2000, "tool_request", "Read"),
            entry(3000, "chat_end", "Done"),
        )
        val result = groupConsecutive(entries)
        // chat_start and tool_request stay distinct rows; chat_end looks past
        // the in-turn tool row and folds into the chat_start as its completion.
        assertEquals(2, result.size)
        assertEquals("chat_start", result[0].entry.type)
        assertEquals("Done", result[0].mergedCompletion?.summary)
        assertEquals("tool_request", result[1].entry.type)
    }

    @Test
    fun `turn merge looks past interleaved rows from other sessions`() {
        val entries = listOf(
            entry(1000, "chat_start", "Fix timeline").copy(sessionId = "a", startedAt = 1000),
            entry(2000, "chat_start", "Other session prompt").copy(sessionId = "b", startedAt = 2000),
            entry(3000, "chat_response", "Fixed it").copy(sessionId = "a", startedAt = 1000),
        )
        val result = groupConsecutive(entries)
        assertEquals(2, result.size)
        assertEquals("a", result[0].entry.sessionId)
        assertEquals("Fixed it", result[0].mergedResponse?.summary)
        assertTrue(result[0].hasResponse)
        assertEquals("b", result[1].entry.sessionId)
        assertFalse(result[1].hasResponse)
    }

    @Test
    fun `turn merge never crosses a newer same-session chat_start`() {
        val entries = listOf(
            entry(1000, "chat_start", "Turn 1").copy(sessionId = "a", startedAt = 1000),
            entry(2000, "chat_start", "Turn 2").copy(sessionId = "a", startedAt = 2000),
            entry(3000, "chat_response", "Reply to turn 1").copy(sessionId = "a", startedAt = 1000),
        )
        val result = groupConsecutive(entries)
        // The response's anchor (startedAt=1000) doesn't match the most recent
        // same-session chat_start (Turn 2) — merging further back would
        // cross-talk, so it stays standalone.
        assertEquals(3, result.size)
        assertFalse(result[0].hasResponse)
        assertFalse(result[1].hasResponse)
        assertEquals("chat_response", result[2].entry.type)
    }

    // --- timelineDisplayGroups ---

    @Test
    fun `timelineDisplayGroups keeps in-flight chat_start until completion`() {
        val groups = groupConsecutive(listOf(
            TimelineEntry(
                timestamp = 1000,
                type = "chat_start",
                summary = "Refactor timeline",
                sessionId = "s1",
                projectName = "AgentDeck",
            ),
        ))

        val result = timelineDisplayGroups(groups)

        assertEquals(1, result.size)
        assertEquals("chat_start", result[0].entry.type)
    }

    @Test
    fun `groupConsecutive merges a meaningful chat_start with its response into one turn`() {
        // Turn-merge parity with Apple (Model/Timeline.swift): a meaningful
        // chat_start absorbs its same-turn chat_response (matched by
        // sameTimelineContext + startedAt anchor) so the user prompt and the
        // reply render as ONE row instead of two. The prompt stays the anchor
        // entry; the response rides on `mergedResponse`.
        val groups = groupConsecutive(listOf(
            TimelineEntry(
                timestamp = 1000,
                type = "chat_start",
                summary = "Refactor timeline",
                sessionId = "s1",
                projectName = "AgentDeck",
                startedAt = 1000,
            ),
            TimelineEntry(
                timestamp = 7000,
                type = "chat_response",
                summary = "Timeline rows now show summarized unit sessions",
                sessionId = "s1",
                projectName = "AgentDeck",
                startedAt = 1000,
                endedAt = 7000,
            ),
        ))

        val result = timelineDisplayGroups(groups)

        assertEquals(1, result.size)
        assertEquals("chat_start", result[0].entry.type)
        assertEquals("Timeline rows now show summarized unit sessions", result[0].mergedResponse?.summary)
        assertTrue(result[0].hasResponse)
    }

    @Test
    fun `timelineDisplayGroups collapses synthetic chat_start once response arrives`() {
        // Synthetic starters (e.g. "Prompt sent") still hide behind the
        // response — they carry no user-meaningful content.
        val groups = groupConsecutive(listOf(
            TimelineEntry(
                timestamp = 1000, type = "chat_start", summary = "Prompt sent",
                sessionId = "s1", startedAt = 1000,
            ),
            TimelineEntry(
                timestamp = 7000, type = "chat_response", summary = "Done",
                sessionId = "s1", startedAt = 1000, endedAt = 7000,
            ),
        ))
        val result = timelineDisplayGroups(groups)
        assertEquals(1, result.size)
        assertEquals("chat_response", result[0].entry.type)
    }

    @Test
    fun `timelineDisplayGroups keeps independent sessions visible`() {
        val groups = groupConsecutive(listOf(
            entry(1000, "chat_start", "Claude task").copy(sessionId = "claude-a", agentType = "claude-code", projectName = "AgentDeck"),
            entry(2000, "chat_response", "Codex result").copy(sessionId = "codex-a", agentType = "codex-cli", projectName = "Compiler"),
        ))

        val result = timelineDisplayGroups(groups)

        assertEquals(2, result.size)
        assertEquals(listOf("chat_start", "chat_response"), result.map { it.entry.type })
    }

    @Test
    fun `timelineDisplayGroups keeps in-flight start when later completion has distinct run id`() {
        val groups = groupConsecutive(listOf(
            entry(1000, "chat_start", "First task").copy(sessionId = "s1", runId = "run-a"),
            entry(4000, "chat_response", "Second result").copy(sessionId = "s1", runId = "run-b"),
        ))

        val result = timelineDisplayGroups(groups)

        assertEquals(2, result.size)
        assertEquals(listOf("chat_start", "chat_response"), result.map { it.entry.type })
    }

    @Test
    fun `groupConsecutive folds a whole chat_start-response-end turn into one row`() {
        // The full turn lifecycle (chat_start + chat_response + chat_end) for
        // one turn collapses into a single group: the chat_start absorbs the
        // response as `mergedResponse` and the terminator as `mergedCompletion`.
        // This is the fix for OpenClaw/Claude turns previously rendering as 2-3
        // separate rows on Android.
        val groups = groupConsecutive(listOf(
            entry(1000, "chat_start", "Prompt").copy(sessionId = "s1", startedAt = 1000),
            entry(5000, "chat_response", "Useful summary").copy(sessionId = "s1", startedAt = 1000),
            entry(5200, "chat_end", "Completed").copy(sessionId = "s1", startedAt = 1000, endedAt = 5200),
        ))

        val result = timelineDisplayGroups(groups)

        assertEquals(1, result.size)
        assertEquals("chat_start", result[0].entry.type)
        assertEquals("Useful summary", result[0].mergedResponse?.summary)
        assertEquals("Completed", result[0].mergedCompletion?.summary)
    }

    @Test
    fun `timelineDisplayGroups hides model_call after model_response in same run`() {
        val groups = groupConsecutive(listOf(
            entry(1000, "model_call", "자동 작업 · daily review").copy(
                agentType = "openclaw",
                runId = "run-a",
                automated = true,
            ),
            entry(5000, "model_response", "일일 리뷰 완료").copy(
                agentType = "openclaw",
                runId = "run-a",
            ),
        ))

        val result = timelineDisplayGroups(groups)

        assertEquals(1, result.size)
        assertEquals("model_response", result[0].entry.type)
    }

    @Test
    fun `addEntry normalizes openclaw cron model_call prompt dump`() {
        store.addEntry(
            TimelineEntry(
                timestamp = 1_000,
                type = "model_call",
                summary = "[cron:abc self-improvement-daily-review-2350] 입력 수집:\n1. ls -lt 사용\n2. tail -50 사용",
                detail = "[cron:abc self-improvement-daily-review-2350] 입력 수집:\n1. ls -lt 사용\n2. tail -50 사용",
                agentType = "openclaw",
                automated = true,
            )
        )

        assertEquals(1, store.entries.value.size)
        assertEquals("자동 작업 · self improvement daily review 2350", store.entries.value[0].summary)
        assertEquals(null, store.entries.value[0].detail)
        assertEquals(true, store.entries.value[0].automated)
    }

    @Test
    fun `timelineLifecycleBounds pairs response with prior start`() {
        val entries = listOf(
            entry(1000, "chat_start", "Prompt").copy(sessionId = "s1"),
            entry(8500, "chat_response", "Summary").copy(sessionId = "s1"),
        )

        val (startedAt, endedAt) = timelineLifecycleBounds(entries[1], entries)

        assertEquals(1000L, startedAt)
        assertEquals(8500L, endedAt)
    }

    // --- clear ---

    @Test
    fun `clear empties the store`() {
        store.addEntry(entry(1000, "chat_start", "Hello"))
        store.clear()
        assertTrue(store.entries.value.isEmpty())
    }

    // --- low-signal storage filter (Apple parity, mirrors DaemonTimelineStore) ---

    @Test
    fun `addEntry drops codex otel low-signal tool noise`() {
        val noise = TimelineEntry(
            timestamp = 1_000,
            type = "tool_exec",
            summary = "tool",
            agentType = "codex-cli",
            sessionId = "codex:otel-active",
        )
        store.addEntry(noise)
        assertTrue("OTel noise must not enter store", store.entries.value.isEmpty())
    }

    @Test
    fun `addEntry drops codex tool_exec even when raw is meaningful`() {
        // Matches macOS: Codex emits one tool_exec per Bash/MCP action. These
        // remain useful for telemetry/eval ingestion, but the device timeline
        // should show chat/task lifecycle rows instead of a Bash firehose.
        val real = TimelineEntry(
            timestamp = 1_000,
            type = "tool_exec",
            summary = "Bash: pnpm vitest",
            agentType = "codex-cli",
            sessionId = "codex:otel-active",
        )
        store.addEntry(real)
        assertTrue(store.entries.value.isEmpty())
    }

    @Test
    fun `addEntry keeps coalesced codex subagent lifecycle`() {
        store.addEntry(
            TimelineEntry(
                timestamp = 1_000,
                type = "tool_exec",
                summary = "Subagent reviewer · Started",
                agentType = "codex-cli",
                sessionId = "codex:thread-1",
            ),
        )
        assertEquals(1, store.entries.value.size)
    }

    @Test
    fun `addEntry drops opencode tool_exec so a tool-heavy turn does not flood`() {
        // OpenCode emits one tool_exec per Bash/read/todowrite action via the
        // observer plugin. Mirror the Codex suppression so its turn reads clean
        // (prompt/response) instead of a tool firehose.
        for (raw in listOf("bash", "bash completed", "read completed", "todowrite")) {
            store.clear()
            store.addEntry(
                TimelineEntry(
                    timestamp = 1_000,
                    type = "tool_exec",
                    summary = raw,
                    agentType = "opencode",
                    sessionId = "opencode:ses_09e7",
                ),
            )
            assertTrue("opencode tool_exec '$raw' must not enter Android timeline", store.entries.value.isEmpty())
        }
        // chat rows for the same session are kept.
        store.clear()
        store.addEntry(
            TimelineEntry(
                timestamp = 2_000,
                type = "chat_start",
                summary = "openclaw 업데이트되었다 반영하고 점검하라",
                agentType = "opencode",
                sessionId = "opencode:ses_09e7",
            ),
        )
        assertEquals(1, store.entries.value.size)
    }

    @Test
    fun `addEntry drops antigravity tool_exec forward-compat`() {
        // The observed-hook classifier already accepts antigravity_* events;
        // suppress their tool rows too so a future AGY observer can't flood.
        store.addEntry(
            TimelineEntry(
                timestamp = 1_000,
                type = "tool_exec",
                summary = "bash",
                agentType = "antigravity",
                sessionId = "antigravity:sess-1",
            ),
        )
        assertTrue(store.entries.value.isEmpty())
    }

    @Test
    fun `addEntry drops codex tool_exec from normal codex session`() {
        val bash = TimelineEntry(
            timestamp = 1_000,
            type = "tool_exec",
            summary = "Bash: git status --short",
            agentType = "codex-cli",
            sessionId = "codex:019f0884-8e13-77f2-9c4b-2c82e00760e9",
        )
        store.addEntry(bash)
        assertTrue("Normal Codex session Bash rows must not enter Android timeline", store.entries.value.isEmpty())
    }

    @Test
    fun `addEntries filters otel noise from bulk replay`() {
        store.addEntries(
            listOf(
                TimelineEntry(1_000, "chat_start", "Real prompt", agentType = "codex-cli", sessionId = "codex-real"),
                TimelineEntry(1_100, "tool_exec", "tool", agentType = "codex-cli", sessionId = "codex:otel-active"),
                TimelineEntry(1_200, "tool_request", "exec", agentType = "codex-cli", sessionId = "codex:otel-active"),
                TimelineEntry(1_300, "tool_resolved", "tool completed", agentType = "codex-cli", sessionId = "codex:otel-active"),
            )
        )
        val summaries = store.entries.value.map { it.summary }
        assertTrue("Real prompt survives", summaries.contains("Real prompt"))
        assertFalse("Bulk replay drops 'tool' noise", summaries.contains("tool"))
        assertFalse("Bulk replay drops 'exec' noise", summaries.contains("exec"))
        assertFalse("Bulk replay drops 'tool completed' noise", summaries.contains("tool completed"))
    }

    @Test
    fun `upsertEntry refuses to insert otel noise via add fallback`() {
        store.upsertEntry(
            TimelineEntry(
                timestamp = 1_000,
                type = "tool_exec",
                summary = "exec completed",
                agentType = "codex-cli",
                sessionId = "codex:otel-active",
            )
        )
        assertTrue(store.entries.value.isEmpty())
    }

    // OpenClaw Gateway session.tool emits "tool · running" / "tool · complete"
    // when upstream omits the tool name AND has no input/output to show. The
    // producer guard in OpenClawAdapter.swift (2026-05-18) drops new ones at
    // source; this filter catches the historical entries that persisted to
    // timeline.json before that fix shipped, so replays don't repopulate the
    // dashboard with the same noise it just cleaned up.
    @Test
    fun `addEntry drops openclaw placeholder tool rows`() {
        val noise = TimelineEntry(
            timestamp = 1_000,
            type = "tool_exec",
            summary = "tool · running",
            agentType = "openclaw",
        )
        store.addEntry(noise)
        assertTrue("OpenClaw placeholder must not enter store", store.entries.value.isEmpty())
    }

    @Test
    fun `addEntry keeps real openclaw tool rows`() {
        // Real tool execution — `shell · complete` has the real tool name in
        // raw and carries detail data. Must survive the filter.
        val real = TimelineEntry(
            timestamp = 1_000,
            type = "tool_exec",
            summary = "shell · complete",
            agentType = "openclaw",
        )
        store.addEntry(real)
        assertEquals(1, store.entries.value.size)
        assertEquals("shell · complete", store.entries.value[0].summary)
    }

    // Codex stop-time review 2026-05-18: producer keeps unnamed tool rows
    // when input/output is present — the JSON ends up in `detail` while
    // `summary` (raw) falls back to the literal "tool" placeholder.
    // The filter must NOT drop those because the detail pane is exactly
    // what makes the row useful for the user.
    @Test
    fun `addEntry keeps openclaw placeholder summary when detail has content`() {
        val unnamedWithIO = TimelineEntry(
            timestamp = 1_000,
            type = "tool_exec",
            summary = "tool · running",
            detail = "status: running\ninput: {\"command\":\"ls -la\"}",
            agentType = "openclaw",
        )
        store.addEntry(unnamedWithIO)
        assertEquals(
            "Unnamed tool with input/output in detail must survive — it carries signal even with a placeholder summary",
            1,
            store.entries.value.size,
        )
    }

    // Codex stop-time review 2026-05-18 (second round): detail="status: running"
    // alone (no input/output) is still placeholder noise — looser
    // detail-gate had let these bypass. Producer no longer emits this
    // case (name+input+output all absent → early return), but legacy
    // on-disk entries can have it.
    @Test
    fun `addEntry drops openclaw placeholder with status-only detail`() {
        val statusOnly = TimelineEntry(
            timestamp = 1_000,
            type = "tool_exec",
            summary = "tool · running",
            detail = "status: running",  // no input/output line
            agentType = "openclaw",
        )
        store.addEntry(statusOnly)
        assertTrue(
            "Status-only detail is still placeholder noise — bypass must be closed",
            store.entries.value.isEmpty(),
        )
    }

    // Codex stop-time review 2026-05-18 (third round): enumerated status
    // set used to miss `failed` (and would miss any future Gateway-side
    // status string). Structural match — `raw == "tool"` or
    // `raw.startsWith("tool · ")` — must catch all of them.
    @Test
    fun `addEntry drops openclaw placeholder with failed status`() {
        val failed = TimelineEntry(
            timestamp = 1_000,
            type = "tool_exec",
            summary = "tool · failed",
            detail = "status: failed",
            agentType = "openclaw",
        )
        store.addEntry(failed)
        assertTrue(
            "tool · failed placeholder must drop — Codex #3 regression guard",
            store.entries.value.isEmpty(),
        )
    }

    @Test
    fun `addEntry drops openclaw placeholder with arbitrary future status`() {
        val futureStatus = TimelineEntry(
            timestamp = 1_000,
            type = "tool_exec",
            summary = "tool · whatever_new_status",
            detail = "status: whatever_new_status",
            agentType = "openclaw",
        )
        store.addEntry(futureStatus)
        assertTrue(
            "Structural match must cover any future status string without code change",
            store.entries.value.isEmpty(),
        )
    }

    // --- Task-judge upsert (Step 2: score → timeline pipeline) ---

    @Test
    fun `upsertEntry merges task_end by taskId beyond the 1s tolerance window`() {
        // Initial task_end emit — no score yet (judge still running)
        val initial = TimelineEntry(
            timestamp = 1000L,
            type = "task_end",
            summary = "TODO done · 12s",
            taskId = "task-abc",
        )
        store.addEntry(initial)

        // Judge resolves 20 s later (well past the 1 s ts tolerance). The
        // upsert MUST find the existing row by (type, taskId) and merge,
        // not append a duplicate. Without the taskId fallback this row
        // would stack and the dashboard would show two TASK END rows.
        val followup = TimelineEntry(
            timestamp = 21000L,
            type = "task_end",
            summary = "TODO done · 12s",
            taskId = "task-abc",
            taskScore = 0.85,
            taskOutcome = "success",
            taskCategory = "general",
            taskSummary = "Refactored auth and verified tests",
        )
        store.upsertEntry(followup)

        assertEquals("only one task_end row should remain after upsert",
            1, store.entries.value.size)
        val merged = store.entries.value[0]
        assertEquals(0.85, merged.taskScore!!, 0.0001)
        assertEquals("success", merged.taskOutcome)
        assertEquals("general", merged.taskCategory)
        assertEquals("Refactored auth and verified tests", merged.taskSummary)
    }

    @Test
    fun `upsertEntry without taskId falls back to ts-window match`() {
        // Pre-existing behavior must keep working for non-task entries.
        store.addEntry(TimelineEntry(timestamp = 1000L, type = "chat_end", summary = "Original"))
        store.upsertEntry(TimelineEntry(timestamp = 1500L, type = "chat_end", summary = "Updated"))
        assertEquals(1, store.entries.value.size)
        assertEquals("Updated", store.entries.value[0].summary)
    }

    @Test
    fun `deriveSubagentActivity pairs starts and completions per parent`() {
        val activity = deriveSubagentActivity(
            entries = listOf(
                TimelineEntry(
                    timestamp = 100,
                    type = "tool_exec",
                    summary = "Subagent reviewer · Started",
                    sessionId = "parent-1",
                    startedAt = 100,
                ),
                TimelineEntry(
                    timestamp = 110,
                    type = "tool_exec",
                    summary = "Subagent tester · Started",
                    sessionId = "parent-1",
                    startedAt = 110,
                ),
                TimelineEntry(
                    timestamp = 120,
                    type = "tool_resolved",
                    summary = "Subagent reviewer · Review complete",
                    sessionId = "parent-1",
                    startedAt = 100,
                ),
            ),
            now = 150,
        )

        assertEquals(SubagentVisualActivity(activeCount = 1, lastCompletedAt = 120), activity["parent-1"])
    }

    @Test
    fun `deriveSubagentActivity ignores ordinary tools and expires orphaned starts`() {
        val activity = deriveSubagentActivity(
            entries = listOf(
                TimelineEntry(
                    timestamp = 10,
                    type = "tool_exec",
                    summary = "Bash · pnpm test",
                    sessionId = "parent-1",
                ),
                TimelineEntry(
                    timestamp = 20,
                    type = "tool_exec",
                    summary = "Subagent stale · Started",
                    sessionId = "parent-1",
                ),
            ),
            now = 1_000,
            activeTtlMs = 100,
        )

        assertTrue(activity.isEmpty())
    }

    // --- helpers ---

    // --- matchesTimelineFilter (per-session timeline filter) ---

    @Test
    fun `matchesTimelineFilter matches by sessionId`() {
        val e = TimelineEntry(timestamp = 1, type = "chat_start", summary = "hi", sessionId = "sess-1")
        assertTrue(e.matchesTimelineFilter(TimelineSessionFilter("sess-1")))
        assertFalse(e.matchesTimelineFilter(TimelineSessionFilter("sess-2")))
    }

    @Test
    fun `matchesTimelineFilter canonicalizes observed session prefixes`() {
        val e = TimelineEntry(timestamp = 1, type = "chat_start", summary = "hi", sessionId = "session-uuid")
        assertTrue(e.matchesTimelineFilter(TimelineSessionFilter("observed:codex:session-uuid")))
        assertFalse(e.matchesTimelineFilter(TimelineSessionFilter("observed:codex:other-uuid")))

        listOf("claude", "codex", "codex-app", "opencode", "antigravity").forEach { provider ->
            assertEquals("session-uuid", canonicalTimelineSessionId("observed:$provider:session-uuid"))
        }
    }

    @Test
    fun `matchesTimelineFilter keeps sessionless OpenClaw rows under gateway`() {
        val e = TimelineEntry(timestamp = 1, type = "chat_response", summary = "cron", agentType = "openclaw")
        assertTrue(e.matchesTimelineFilter(TimelineSessionFilter("openclaw-gateway", "OpenClaw", "openclaw")))
        // A non-openclaw sessionless row must NOT leak into the gateway view.
        val other = TimelineEntry(timestamp = 1, type = "chat_response", summary = "x", agentType = "claude-code")
        assertFalse(other.matchesTimelineFilter(TimelineSessionFilter("openclaw-gateway", "OpenClaw", "openclaw")))
    }

    @Test
    fun `matchesTimelineFilter falls back to project plus agent for legacy sessionless rows`() {
        val e = TimelineEntry(timestamp = 1, type = "chat_start", summary = "hi",
            agentType = "claude-code", projectName = "AgentDeck")
        assertTrue(e.matchesTimelineFilter(TimelineSessionFilter("sess-x", "AgentDeck", "claude-code")))
        // Different project in the same agent must not collapse two sessions.
        assertFalse(e.matchesTimelineFilter(TimelineSessionFilter("sess-x", "ViewTrans", "claude-code")))
    }

    @Test
    fun `matchesTimelineFilter with sessionId ignores project fallback`() {
        // Entry HAS a sessionId that doesn't match — the project/agent fallback
        // is only for sessionless entries, so this must not match.
        val e = TimelineEntry(timestamp = 1, type = "chat_start", summary = "hi",
            agentType = "claude-code", projectName = "AgentDeck", sessionId = "sess-real")
        assertFalse(e.matchesTimelineFilter(TimelineSessionFilter("sess-x", "AgentDeck", "claude-code")))
    }

    @Test
    fun `TimelineSessionFilter label prefers project then friendly agent`() {
        assertEquals("AgentDeck", TimelineSessionFilter("s", "AgentDeck", "claude-code").label)
        assertEquals("Claude", TimelineSessionFilter("s", null, "claude-code").label)
        assertEquals("s", TimelineSessionFilter("s", null, null).label)
    }

    private fun entry(ts: Long, type: String, summary: String) =
        TimelineEntry(timestamp = ts, type = type, summary = summary)
}
