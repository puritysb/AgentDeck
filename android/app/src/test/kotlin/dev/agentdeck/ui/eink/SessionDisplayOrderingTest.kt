package dev.agentdeck.ui.eink

import dev.agentdeck.net.SessionInfo
import dev.agentdeck.net.SessionWeightRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Locks in the cross-platform sort contract used by Android, macOS/iOS, the
 * TUI, and the Stream Deck plugin. The same input must produce the same
 * ordering and the same #N suffix on every surface — otherwise the
 * dashboard left HUD shows different sessions in different positions for the
 * same daemon snapshot. Mirrors apple/AgentDeckTests/ProtocolTests.swift's
 * sortSessions tests and shared/src/__tests__/session-utils.test.ts.
 */
class SessionDisplayOrderingTest {

    private fun session(
        id: String,
        agentType: String? = "claude-code",
        projectName: String? = "AgentDeck",
        startedAt: String? = null,
        port: Int = 9120,
        weight: Int? = null,
    ) = SessionInfo(
        id = id,
        port = port,
        projectName = projectName,
        agentType = agentType,
        alive = true,
        state = "idle",
        modelName = null,
        startedAt = startedAt,
        weight = weight,
    )

    @Test
    fun `agentTypeRank places openclaw first`() {
        assertEquals(0, agentTypeRank("openclaw"))
        assertEquals(1, agentTypeRank("claude-code"))
        assertEquals(2, agentTypeRank("codex-cli"))
        assertEquals(3, agentTypeRank("codex-app"))
        assertEquals(4, agentTypeRank("opencode"))
        assertEquals(5, agentTypeRank("antigravity"))
        assertEquals(6, agentTypeRank("unknown"))
        assertEquals(6, agentTypeRank(null))
    }

    @Test
    fun `naturalLabelCompare orders Agent 2 before Agent 10`() {
        assertTrue(naturalLabelCompare("Agent 2", "Agent 10") < 0)
        assertTrue(naturalLabelCompare("Agent 10", "Agent 2") > 0)
        assertEquals(0, naturalLabelCompare("Agent 2", "Agent 2"))
    }

    @Test
    fun `compareSessionsForDisplay sorts openclaw before claude-code regardless of project`() {
        val sorted = listOf(
            session(id = "claude", agentType = "claude-code", projectName = "Z", startedAt = "2026-05-11T10:00:00Z"),
            session(id = "oc", agentType = "openclaw", projectName = "A", startedAt = "2026-05-11T11:00:00Z"),
        ).sortedWith(::compareSessionsForDisplay)

        assertEquals(listOf("oc", "claude"), sorted.map { it.id })
    }

    @Test
    fun `compareSessionsForDisplay breaks ties on startedAt ascending (oldest first)`() {
        val sorted = listOf(
            session(id = "newer", startedAt = "2026-05-11T11:00:00Z"),
            session(id = "older", startedAt = "2026-05-11T10:00:00Z"),
        ).sortedWith(::compareSessionsForDisplay)

        assertEquals(listOf("older", "newer"), sorted.map { it.id })
    }

    @Test
    fun `compareSessionsForDisplay tie-breaks on natural id when startedAt is identical`() {
        // The iPad/iOS reproduction: two AgentDeck claude-code sessions start
        // in the same second. The natural-id tie-breaker decides, and must be
        // deterministic so the #N suffix order does not flip on re-sorts.
        val sameTs = "2026-05-11T10:00:00Z"
        val sorted = listOf(
            session(id = "session-10", startedAt = sameTs),
            session(id = "session-2", startedAt = sameTs),
        ).sortedWith(::compareSessionsForDisplay)

        assertEquals(listOf("session-2", "session-10"), sorted.map { it.id })
    }

    @Test
    fun `sessionWeight collapses null to 0 and preserves finite values`() {
        assertEquals(0, sessionWeight(null))
        assertEquals(0, sessionWeight(0))
        assertEquals(3, sessionWeight(3))
        assertEquals(-5, sessionWeight(-5))
    }

    @Test
    fun `sessionWeight accepts the documented bounds and clamps beyond them`() {
        assertEquals(SessionWeightRules.MIN, sessionWeight(SessionWeightRules.MIN))
        assertEquals(SessionWeightRules.MAX, sessionWeight(SessionWeightRules.MAX))
        assertEquals(SessionWeightRules.MIN, sessionWeight(SessionWeightRules.MIN - 1))
        assertEquals(SessionWeightRules.MAX, sessionWeight(SessionWeightRules.MAX + 1))
        assertEquals(SessionWeightRules.MIN, sessionWeight(Int.MIN_VALUE))
        assertEquals(SessionWeightRules.MAX, sessionWeight(Int.MAX_VALUE))
    }

    @Test
    fun `compareSessionsForDisplay orders opposite-sign extreme weights without Int overflow`() {
        // Int.MIN_VALUE vs Int.MAX_VALUE under the old subtraction comparator
        // wrapped and reversed the ordering; the clamp + three-way compare must
        // order them min → 0 → max.
        val sorted = listOf(
            session(id = "huge", weight = Int.MAX_VALUE),
            session(id = "tiny", weight = Int.MIN_VALUE),
            session(id = "zero", weight = null),
        ).sortedWith(::compareSessionsForDisplay)

        assertEquals(listOf("tiny", "zero", "huge"), sorted.map { it.id })
    }

    @Test
    fun `compareSessionsForDisplay orders by weight ascending before everything else`() {
        // Negatives, then unweighted/0, then positives. A weighted claude-code
        // session sorts before an unweighted openclaw. Mirrors shared/Apple.
        val sorted = listOf(
            session(id = "pos", weight = 2),
            session(id = "oc", agentType = "openclaw", weight = null),
            session(id = "neg", weight = -5),
            session(id = "zero", weight = 0),
        ).sortedWith(::compareSessionsForDisplay)

        // neg(-5) → 0-band [oc(openclaw rank 0) before zero(claude rank 1)] → pos(2)
        assertEquals(listOf("neg", "oc", "zero", "pos"), sorted.map { it.id })
    }

    @Test
    fun `compareSessionsForDisplay maps terminal tab order onto the deck`() {
        // Five same-project tabs launched out of order, each pinned to its tab
        // number via --weight, land in slot order 1..5.
        val sorted = listOf(
            session(id = "tab3", weight = 3, startedAt = "2026-07-08T10:02:00Z"),
            session(id = "tab1", weight = 1, startedAt = "2026-07-08T10:00:00Z"),
            session(id = "tab5", weight = 5, startedAt = "2026-07-08T10:04:00Z"),
            session(id = "tab2", weight = 2, startedAt = "2026-07-08T10:01:00Z"),
            session(id = "tab4", weight = 4, startedAt = "2026-07-08T10:03:00Z"),
        ).sortedWith(::compareSessionsForDisplay)

        assertEquals(listOf("tab1", "tab2", "tab3", "tab4", "tab5"), sorted.map { it.id })
    }

    @Test
    fun `compareSessionsForDisplay is stable across re-sorts of any input order`() {
        val sessions = listOf(
            session(id = "session-10", startedAt = "2026-05-11T10:00:00Z"),
            session(id = "session-2", startedAt = "2026-05-11T10:00:00Z"),
            session(id = "oc", agentType = "openclaw", startedAt = "2026-05-11T09:00:00Z"),
        )
        val a = sessions.sortedWith(::compareSessionsForDisplay)
        val b = sessions.reversed().sortedWith(::compareSessionsForDisplay)

        assertEquals(a.map { it.id }, b.map { it.id })
        assertEquals(listOf("oc", "session-2", "session-10"), a.map { it.id })
    }
}
