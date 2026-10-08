package dev.agentdeck.terrarium

import dev.agentdeck.net.AgentState
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.state.DashboardState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TerrariumStateTest {
    @Test fun `primary permission frame overrides a still idle CI roster for every creature kind`() {
        for (kind in listOf("claude-code","codex-cli","opencode","hermes","kiro-cli","antigravity")) {
            for (permission in listOf(AgentState.AWAITING_PERMISSION,AgentState.AWAITING_OPTION,AgentState.AWAITING_DIFF)) {
                val state = DashboardState(agentState = permission,agentType = kind,sessionId = "self",
                    siblingSessions = listOf(SessionInfo(id = "self",port = 0,projectName = "Work",agentType = kind,state = "idle",
                        waitingOn = dev.agentdeck.net.CiWaitStatus(phase = "running",agentWaiting = true)))).toTerrariumState()
                assertEquals(kind,OctopusVisualState.ASKING,aquariumResidents(state).single().state)
                assertTrue(kind,state.ciWaits.isEmpty())
                assertTrue(kind,state.ciWaitLabels.isEmpty())
                assertTrue(kind,state.ciWaitingIds.isEmpty())
            }
        }
    }


    @Test
    fun `primary Kiro session routes to the canonical vector-mark creature`() {
        val terrarium = DashboardState(
            agentState = AgentState.PROCESSING,
            agentType = "kiro-cli",
            sessionId = "kiro:primary",
        ).toTerrariumState()

        assertEquals(0, terrarium.agents.size)
        assertEquals(1, terrarium.openCodeCreatures.size)
        assertEquals("kiro-cli", terrarium.openCodeCreatures.single().agentType)
        assertEquals(OctopusVisualState.WORKING, terrarium.openCodeCreatures.single().visualState)
    }

    // The daemon sends every session in `sessions_list`, and the focused one is
    // among them — `siblingSessions` therefore always contains the primary
    // itself, which is why every sibling loop below skips it by id. A fixture
    // that leaves the list empty describes a state production never produces,
    // and the tests above did exactly that, which is how the primary creature
    // could stop rendering without a single assertion noticing.

    @Test
    fun `a focused session keeps its creature when the list contains itself`() {
        val self = SessionInfo(
            id = "claude:primary", port = 9120, agentType = "claude-code",
            alive = true, state = "processing",
        )
        val terrarium = DashboardState(
            agentState = AgentState.PROCESSING,
            agentType = "claude-code",
            sessionId = self.id,
            siblingSessions = listOf(self),
        ).toTerrariumState()

        assertEquals(1, terrarium.agents.size)
        assertEquals("claude-code", terrarium.agents.single().agentType)
        assertTrue(terrarium.agents.single().isPrimary)
    }

    @Test
    fun `a second session of the same agent does not suppress the focused one`() {
        // Two Claude sessions is the ordinary case, not an aggregate view. The
        // sibling loop skips the focused session by id, so if the primary
        // branch also declines it the focused session has no creature at all.
        val self = SessionInfo(
            id = "claude:a", port = 9120, agentType = "claude-code",
            alive = true, state = "processing",
        )
        val other = SessionInfo(
            id = "claude:b", port = 9120, agentType = "claude-code",
            alive = true, state = "idle",
        )
        val terrarium = DashboardState(
            agentState = AgentState.PROCESSING,
            agentType = "claude-code",
            sessionId = self.id,
            siblingSessions = listOf(self, other),
        ).toTerrariumState()

        assertEquals(2, terrarium.agents.size)
        assertEquals(setOf("claude:a", "claude:b"), terrarium.agents.map { it.sessionId }.toSet())
    }

    @Test
    fun `a focused Codex session keeps its cloud when the list contains itself`() {
        val self = SessionInfo(
            id = "codex:primary", port = 9120, agentType = "codex-cli",
            alive = true, state = "processing",
        )
        val terrarium = DashboardState(
            agentState = AgentState.PROCESSING,
            agentType = "codex-cli",
            sessionId = self.id,
            siblingSessions = listOf(self),
        ).toTerrariumState()

        assertEquals(1, terrarium.cloudCreatures.size)
        assertEquals("codex:primary", terrarium.cloudCreatures.single().sessionId)
    }

    @Test
    fun `Kiro IDE sibling does not fall back to an octopus`() {
        val terrarium = DashboardState(
            agentState = AgentState.DISCONNECTED,
            agentType = "daemon",
            siblingSessions = listOf(
                SessionInfo(id = "kiro:ide", port = 9120, agentType = "kiro-ide", alive = true, state = "idle"),
            ),
        ).toTerrariumState()

        assertEquals(0, terrarium.agents.size)
        assertEquals(1, terrarium.openCodeCreatures.size)
        assertEquals("kiro-ide", terrarium.openCodeCreatures.single().agentType)
    }

    // Presence-driven SSOT: the crayfish tracks the emitted OpenClaw SESSION,
    // never raw gateway flags. No session row ⇒ DORMANT, regardless of
    // reachability/auth/error — this is the regression lock for the
    // "OpenClaw won't go away" trace.

    @Test
    fun `reachable gateway without an emitted session hides OpenClaw and workers`() {
        val terrarium = DashboardState(
            agentState = AgentState.IDLE,
            agentType = "daemon",
            gatewayAvailable = true,
            gatewayConnected = false,
            gatewayHasError = false,
            workerSessionCount = 3,
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.DORMANT, terrarium.crayfish)
        assertEquals(0, terrarium.workerCrayfishCount)
    }

    @Test
    fun `stuck gatewayConnected without an emitted session still hides OpenClaw`() {
        // The phantom "trace" scenario: a stale gatewayConnected=true but the
        // daemon emitted NO openclaw session — the crayfish must stay hidden.
        val terrarium = DashboardState(
            agentState = AgentState.IDLE,
            agentType = "daemon",
            gatewayAvailable = true,
            gatewayConnected = true,
            workerSessionCount = 2,
            siblingSessions = emptyList(),
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.DORMANT, terrarium.crayfish)
        assertEquals(0, terrarium.workerCrayfishCount)
    }

    @Test
    fun `emitted OpenClaw session shows OpenClaw at rest`() {
        val terrarium = DashboardState(
            agentState = AgentState.IDLE,
            agentType = "daemon",
            gatewayAvailable = true,
            gatewayConnected = true,
            gatewayHasError = false,
            workerSessionCount = 2,
            siblingSessions = listOf(
                SessionInfo(id = "oc-1", port = 18789, agentType = "openclaw", alive = true, state = "idle"),
            ),
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.SITTING, terrarium.crayfish)
        assertEquals(2, terrarium.workerCrayfishCount)
    }

    @Test
    fun `gateway error with a live session surfaces sick OpenClaw`() {
        val terrarium = DashboardState(
            agentState = AgentState.IDLE,
            agentType = "daemon",
            gatewayAvailable = true,
            gatewayConnected = true,
            gatewayHasError = true,
            siblingSessions = listOf(
                SessionInfo(id = "oc-1", port = 18789, agentType = "openclaw", alive = true, state = "idle"),
            ),
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.SICK, terrarium.crayfish)
    }

    @Test
    fun `gateway error without an emitted session does not spawn a creature`() {
        val terrarium = DashboardState(
            agentState = AgentState.IDLE,
            agentType = "daemon",
            gatewayAvailable = true,
            gatewayConnected = false,
            gatewayHasError = true,
            workerSessionCount = 2,
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.DORMANT, terrarium.crayfish)
        assertEquals(0, terrarium.workerCrayfishCount)
    }

    /**
     * Regression: when only Claude is processing on an OpenClaw aggregate
     * primary, the OpenClaw crayfish must NOT animate as ROUTING — it
     * should track its own sibling state. Previously the dashboard's
     * `agentState` was overwritten with Claude's PROCESSING (via the
     * keep-aggregate-identity path) and the crayfish branch read it as
     * the OpenClaw state.
     */
    @Test
    fun `claude processing does not bleed into OpenClaw crayfish on aggregate view`() {
        val terrarium = DashboardState(
            agentState = AgentState.IDLE,
            agentType = "openclaw",
            gatewayAvailable = true,
            gatewayConnected = true,
            siblingSessions = listOf(
                SessionInfo(id = "oc-1", port = 9120, agentType = "openclaw", alive = true, state = "idle"),
                SessionInfo(id = "cc-1", port = 9121, agentType = "claude-code", alive = true, state = "processing"),
            ),
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.SITTING, terrarium.crayfish)
        // Aggregate scene mood still reflects sibling activity.
        assertEquals(OctopusVisualState.WORKING, terrarium.octopus)
        assertEquals(EnvironmentVisualState.ACTIVE, terrarium.environment)
    }

    @Test
    fun `OpenClaw processing routes its own crayfish`() {
        val terrarium = DashboardState(
            agentState = AgentState.PROCESSING,
            agentType = "openclaw",
            gatewayAvailable = true,
            gatewayConnected = true,
            siblingSessions = listOf(
                SessionInfo(id = "oc-1", port = 9120, agentType = "openclaw", alive = true, state = "processing"),
            ),
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.ROUTING, terrarium.crayfish)
    }

    /**
     * Regression: on the daemon aggregate view (daemon's own state is
     * permanently DISCONNECTED), an idle OpenClaw sibling must keep the
     * crayfish at SITTING even when a Claude sibling is processing.
     */
    @Test
    fun `daemon aggregate keeps OpenClaw crayfish calm while claude works`() {
        val terrarium = DashboardState(
            agentState = AgentState.DISCONNECTED,
            agentType = "daemon",
            gatewayAvailable = true,
            gatewayConnected = true,
            siblingSessions = listOf(
                SessionInfo(id = "oc-1", port = 9120, agentType = "openclaw", alive = true, state = "idle"),
                SessionInfo(id = "cc-1", port = 9121, agentType = "claude-code", alive = true, state = "processing"),
            ),
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.SITTING, terrarium.crayfish)
        assertEquals(EnvironmentVisualState.ACTIVE, terrarium.environment)
    }
}
