package dev.agentdeck.ui.eink

import dev.agentdeck.net.AgentState
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.TimelineEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EinkPaperBoardTest {

    private fun session(id: String, state: String, project: String = "AgentDeck", agent: String = "claude-code") =
        SessionInfo(
            id = id, port = 9120, projectName = project, agentType = agent,
            alive = true, state = state, modelName = null,
        )

    @Test
    fun `sessions rank by what they ask of the reader`() {
        val board = buildPaperBoard(
            DashboardState(
                agentType = "daemon",
                siblingSessions = listOf(
                    session("a", "idle", "Quiet"),
                    session("b", "processing", "Busy"),
                    session("c", "awaiting_permission", "Blocked"),
                    session("d", "idle", "Gone").copy(alive = false),
                ),
            ),
        )
        assertEquals(listOf("Blocked"), board.needsYou.map { it.name })
        assertEquals(listOf("Busy"), board.working.map { it.name })
        assertEquals(listOf("Quiet"), board.quiet.map { it.name })
        assertEquals(1, board.offline)
        assertEquals("1 need you · 1 working · 1 idle · 1 offline", paperMastheadSummary(board))
    }

    @Test
    fun `same project and agent twice are numbered`() {
        val board = buildPaperBoard(
            DashboardState(
                agentType = "daemon",
                siblingSessions = listOf(session("a", "idle"), session("b", "idle")),
            ),
        )
        assertEquals(setOf("AgentDeck #1", "AgentDeck #2"), board.quiet.map { it.name }.toSet())
    }

    private fun entry(ts: Long, type: String, summary: String = "", detail: String? = null, taskId: String? = null) =
        TimelineEntry(timestamp = ts, type = type, summary = summary, detail = detail,
            projectName = "AgentDeck", agentType = "claude-code", taskId = taskId)

    @Test
    fun `recent holds finished agent work, never a prompt still waiting`() {
        val recent = paperRecent(
            listOf(
                entry(100, "chat_start", "Please fix the gauge"),
                entry(200, "chat_start", "Explain the flap", taskId = "t2"),
                entry(210, "chat_response", "## Overview\n", "The flap comes from the half-open reaper.", taskId = "t2"),
            ),
            limit = 5,
        )
        assertEquals(listOf("The flap comes from the half-open reaper."), recent.map { it.text })
    }

    @Test
    fun `a judged task speaks for its turns and abandoned work is not done`() {
        val recent = paperRecent(
            listOf(
                entry(100, "chat_start", "Deploy it", taskId = "t1"),
                entry(110, "chat_response", "Deployed to the tablet.", taskId = "t1"),
                entry(120, "task_end", taskId = "t1").copy(taskSummary = "Deployed the build to every device", taskOutcome = "success"),
                entry(300, "task_end", taskId = "t3").copy(taskSummary = "Tried a refactor", taskOutcome = "abandoned"),
                entry(400, "task_end", taskId = "t4").copy(taskSummary = "Flash the NM board over USB", taskOutcome = "failure"),
            ),
            limit = 5,
        )
        assertEquals(listOf("Flash the NM board over USB", "Deployed the build to every device"), recent.map { it.text })
        assertEquals(listOf("FAILED", null), recent.map { it.mark })
    }

    @Test
    fun `headline skips bare headings and machine output`() {
        assertEquals("Two findings need a decision today", paperHeadline("# Summary", "Two findings need a decision today"))
        assertEquals("Short", paperHeadline("Short", null))
        assertTrue(paperHeadline("{\"suggestions\":[]}", null) == null)
    }
}
