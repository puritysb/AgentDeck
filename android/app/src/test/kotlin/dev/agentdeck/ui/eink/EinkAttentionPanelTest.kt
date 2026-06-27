package dev.agentdeck.ui.eink

import dev.agentdeck.net.AgentState
import dev.agentdeck.net.PromptOption
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.state.DashboardState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EinkAttentionPanelTest {

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
