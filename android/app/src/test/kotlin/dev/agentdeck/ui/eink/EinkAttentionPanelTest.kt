package dev.agentdeck.ui.eink

import dev.agentdeck.net.AgentState
import dev.agentdeck.net.PromptOption
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.state.DashboardState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class EinkAttentionPanelTest {
    @Test
    fun `native held approvals retain identity and disable an unpolled OpenCode request`() {
        val row = session("held", "AgentDeck", "awaiting_permission").copy(
            controlMode = "observed", agentType = "opencode", requestId = "ocperm:request-1", liveAnswerable = true,
            question = "Run the harmless command?",
        )
        fun paper(session: SessionInfo) = buildEinkAttentionFeatured(DashboardState(siblingSessions = listOf(session)))!!
        val eink = paper(row)
        assertEquals(listOf("Allow once", "Deny"), eink.options.map { it.label })
        assertEquals(row.requestId, eink.permissionRequestId)
        assertEquals(true, eink.actionable)
        assertFalse(paper(row.copy(liveAnswerable = false)).actionable)
        val lcd = dev.agentdeck.ui.monitor.buildAttentionFeatured(row, row.question)
        assertEquals(eink.options, lcd.options)
        assertEquals(eink.permissionRequestId, lcd.permissionRequestId)
        assertEquals(true, lcd.actionable)
        assertFalse(dev.agentdeck.ui.monitor.buildAttentionFeatured(row.copy(liveAnswerable = false), row.question).actionable)
    }

    @Test
    fun `featured attention prefers focused awaiting session`() {
        val state = DashboardState(
            agentState = AgentState.IDLE,
            sessionId = "session-2",
            question = "Approve write?",
            options = listOf(PromptOption(label = "Approve", index = 4)),
            cursorIndex = 4,
            navigable = true,
            siblingSessions = listOf(
                session("session-1", "ViewTrans", "awaiting_permission"),
                session("session-2", "AgentDeck", "awaiting_option"),
            ),
        )

        val featured = buildEinkAttentionFeatured(state)!!

        assertEquals("session-2", featured.sessionId)
        assertEquals("AgentDeck", featured.projectName)
        assertEquals("Approve write?", featured.question)
        assertEquals("Approve", featured.options.single().label)
        assertEquals(4, featured.cursorIndex)
        assertEquals(1, featured.queuedCount)
    }

    @Test
    fun `non-focused awaiting session hides unavailable live prompt fields`() {
        val state = DashboardState(
            agentState = AgentState.IDLE,
            sessionId = "focused-idle",
            question = "Focused-only question",
            options = listOf(PromptOption(label = "Focused-only option", index = 0)),
            siblingSessions = listOf(
                session("session-1", "AgentDeck", "awaiting_permission"),
            ),
        )

        val featured = buildEinkAttentionFeatured(state)!!

        assertEquals("session-1", featured.sessionId)
        assertNull(featured.question)
        assertEquals(emptyList<PromptOption>(), featured.options)
        assertEquals(emptyList<PromptOption>(), effectiveEinkAttentionOptions(featured.options))
    }

    @Test
    fun `primary awaiting session is surfaced when not represented by siblings`() {
        val state = DashboardState(
            agentState = AgentState.AWAITING_PERMISSION,
            agentType = "claude-code",
            sessionId = "primary-session",
            projectName = "AgentDeck",
            modelName = "claude-opus-4",
            question = "Allow shell command?",
            options = listOf(PromptOption(label = "Allow", index = 0)),
            siblingSessions = emptyList(),
        )

        val featured = buildEinkAttentionFeatured(state)!!

        assertEquals("primary-session", featured.sessionId)
        assertEquals("AgentDeck", featured.projectName)
        assertEquals("claude-code", featured.agentType)
        assertEquals("Allow shell command?", featured.question)
        assertEquals("Allow", featured.options.single().label)
    }

    @Test
    fun `observed AskUserQuestion choices are visible but not actionable`() {
        val state = DashboardState(
            agentState = AgentState.IDLE,
            sessionId = "observed-ask",
            siblingSessions = listOf(
                SessionInfo(
                    id = "observed-ask",
                    port = 0,
                    projectName = "AgentDeck",
                    agentType = "claude-code",
                    alive = true,
                    state = "awaiting_option",
                    question = "Which deadline?",
                    options = listOf(
                        PromptOption(label = "14 days", index = 0),
                        PromptOption(label = "7 days", index = 1),
                    ),
                    controlMode = "observed",
                ),
            ),
        )

        val featured = buildEinkAttentionFeatured(state)!!

        assertEquals("Which deadline?", featured.question)
        assertEquals(listOf("14 days", "7 days"), featured.options.map { it.label })
        assertFalse(featured.actionable)
        assertFalse(featured.navigable)
    }

    private fun session(id: String, project: String, state: String): SessionInfo {
        return SessionInfo(
            id = id,
            port = 9121,
            projectName = project,
            agentType = "claude-code",
            alive = true,
            state = state,
            modelName = "claude-opus-4",
        )
    }
}
