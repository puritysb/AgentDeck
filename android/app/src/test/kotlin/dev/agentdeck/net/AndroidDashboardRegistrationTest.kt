package dev.agentdeck.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidDashboardRegistrationTest {

    @Test
    fun `connected profile change publishes new wire kind without reconnect`() {
        val payloads = mutableListOf<String>()
        val coordinator = AndroidDashboardRegistrationCoordinator { payload ->
            payloads += payload
            true
        }
        val tablet = AndroidDashboardIdentity("model", "AgentDeck Tablet", "tablet")
        val eink = AndroidDashboardIdentity("model", "AgentDeck Tablet", "eink")

        assertTrue(coordinator.socketOpened(tablet))
        assertTrue(coordinator.profileChanged(eink))

        assertEquals(2, payloads.size)
        assertTrue(payloads[0].contains("\"kind\":\"tablet\""))
        assertTrue(payloads[1].contains("\"kind\":\"eink\""))
    }

    @Test
    fun `repeated identity does not duplicate registration churn`() {
        val payloads = mutableListOf<String>()
        val coordinator = AndroidDashboardRegistrationCoordinator { payload ->
            payloads += payload
            true
        }
        val identity = AndroidDashboardIdentity("model", "AgentDeck", "eink")

        assertTrue(coordinator.socketOpened(identity))
        assertFalse(coordinator.profileChanged(identity))
        assertFalse(coordinator.profileChanged(identity))
        assertEquals(1, payloads.size)
    }

    @Test
    fun `disconnected change is retried when the socket opens`() {
        val payloads = mutableListOf<String>()
        var connected = false
        val coordinator = AndroidDashboardRegistrationCoordinator { payload ->
            if (connected) {
                payloads += payload
                true
            } else {
                false
            }
        }
        val eink = AndroidDashboardIdentity("model", "Reader", "eink")

        coordinator.socketClosed()
        assertFalse(coordinator.profileChanged(eink))
        assertEquals(0, payloads.size)

        connected = true
        assertTrue(coordinator.socketOpened(eink))
        assertEquals(1, payloads.size)
    }
}
