package dev.agentdeck.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The ladder's pacing and daemon choice.
 *
 * Both rules exist because of what an unpaired, USB-less reader shows its user:
 * a USB attempt that appears and drops, over and over, because nothing paced
 * the probe. The composable around them is not testable; these are.
 */
class AutoConnectRulesTest {

    private fun daemon(port: Int, name: String = "daemon") = DiscoveredBridge(
        name = name,
        host = "192.168.1.10",
        port = port,
        agentType = "daemon",
    )

    @Test
    fun `only the daemon hub is dialable`() {
        val bridges = listOf(
            DiscoveredBridge("session", "192.168.1.10", 9121, agentType = "claude"),
            daemon(9120),
        )
        assertEquals(9120, AutoConnectRules.pickDaemon(bridges)?.port)
    }

    @Test
    fun `no daemon means no dial`() {
        assertNull(AutoConnectRules.pickDaemon(emptyList()))
        assertNull(
            AutoConnectRules.pickDaemon(
                listOf(DiscoveredBridge("session", "192.168.1.10", 9121, agentType = "codex"))
            )
        )
    }

    @Test
    fun `the canonical port is preferred but not required`() {
        // The hub falls back to 9121+ when something else won 9120. A filter
        // that required the canonical port made that daemon invisible.
        assertEquals(9121, AutoConnectRules.pickDaemon(listOf(daemon(9121)))?.port)
        assertEquals(
            9120,
            AutoConnectRules.pickDaemon(listOf(daemon(9121, "a"), daemon(9120, "b")))?.port,
        )
    }

    @Test
    fun `the first loopback re-probe waits, and later ones back off`() {
        assertEquals(
            AutoConnectRules.LOOPBACK_PROBE_BASE_MS,
            AutoConnectRules.loopbackProbeDelayMs(0),
        )
        assertEquals(
            AutoConnectRules.LOOPBACK_PROBE_BASE_MS * 2,
            AutoConnectRules.loopbackProbeDelayMs(1),
        )
        assertEquals(
            AutoConnectRules.LOOPBACK_PROBE_BASE_MS * 4,
            AutoConnectRules.loopbackProbeDelayMs(2),
        )
    }

    @Test
    fun `the backoff is capped, and never inverts or overflows`() {
        // A device that will never have a reverse tunnel keeps probing — it
        // just must not spend its life doing it, and must not wrap negative
        // (a negative delay returns instantly and becomes a tight loop).
        for (misses in 0..1000) {
            val delay = AutoConnectRules.loopbackProbeDelayMs(misses)
            assert(delay >= AutoConnectRules.LOOPBACK_PROBE_BASE_MS) { "misses=$misses -> $delay" }
            assert(delay <= AutoConnectRules.LOOPBACK_PROBE_MAX_MS) { "misses=$misses -> $delay" }
        }
        assertEquals(
            AutoConnectRules.LOOPBACK_PROBE_MAX_MS,
            AutoConnectRules.loopbackProbeDelayMs(Int.MAX_VALUE),
        )
    }

    @Test
    fun `a negative miss count is treated as the first probe`() {
        assertEquals(
            AutoConnectRules.LOOPBACK_PROBE_BASE_MS,
            AutoConnectRules.loopbackProbeDelayMs(-1),
        )
    }
}
