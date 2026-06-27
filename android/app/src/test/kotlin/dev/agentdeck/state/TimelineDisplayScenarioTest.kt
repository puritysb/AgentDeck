package dev.agentdeck.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineDisplayScenarioTest {

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
        assertTrue(renderedKeys.contains("claude-a:chat_response:AgentDeck"))
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
    fun `codex otel low-signal tool entries are suppressed`() {
        val entries = listOf(
            event(1_000, "chat_start", "Real prompt", "codex-real", "codex-cli", "Compiler"),
            // codex:otel-active sentinel: bridge wires synthetic OTel rows here.
            // raws: "tool", "exec", "unknown" — strictly noise, drop.
            event(1_100, "tool_exec", "tool", "codex:otel-active", "codex-cli", "Compiler"),
            event(1_200, "tool_request", "exec", "codex:otel-active", "codex-cli", "Compiler"),
            event(1_300, "tool_resolved", "tool completed", "codex:otel-active", "codex-cli", "Compiler"),
            // Same session_id but raw is meaningful — must NOT be filtered.
            event(1_400, "tool_exec", "Bash: pnpm vitest", "codex:otel-active", "codex-cli", "Compiler"),
        )
        val display = timelineDisplayGroups(groupConsecutive(entries))
        val rendered = display.map { it.entry.summary }

        assertFalse("OTel synthetic 'tool' raw should be hidden", rendered.contains("tool"))
        assertFalse("OTel synthetic 'exec' raw should be hidden", rendered.contains("exec"))
        assertFalse("OTel 'tool completed' raw should be hidden", rendered.contains("tool completed"))
        assertTrue("Real Bash command must remain visible", rendered.contains("Bash: pnpm vitest"))
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
