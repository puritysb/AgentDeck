package dev.agentdeck.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PanelPolicyTransitionManagerTest {

    @Test
    fun `eink to lcd restores old effects before applying and re-evaluating`() {
        val events = mutableListOf<String>()
        val policy = policy(events)

        assertTrue(policy.install(isEink = true))
        events.clear()

        assertTrue(policy.install(isEink = false))
        assertEquals(listOf("restore", "apply:lcd", "reapply"), events)
    }

    @Test
    fun `lcd to eink uses the same coherent transition`() {
        val events = mutableListOf<String>()
        val policy = policy(events)

        assertTrue(policy.install(isEink = false))
        events.clear()

        assertTrue(policy.install(isEink = true))
        assertEquals(listOf("restore", "apply:eink", "reapply"), events)
    }

    @Test
    fun `installing the active panel policy is a no-op`() {
        val events = mutableListOf<String>()
        val policy = policy(events)

        assertTrue(policy.install(isEink = true))
        events.clear()

        assertFalse(policy.install(isEink = true))
        assertTrue(events.isEmpty())
    }

    private fun policy(events: MutableList<String>) = PanelPolicyTransitionManager(
        restoreCurrent = { events += "restore" },
        applyNext = { events += if (it) "apply:eink" else "apply:lcd" },
        reapplyLatestState = { events += "reapply" },
    )
}
