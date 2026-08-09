package dev.agentdeck.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The pairing-code path for a device with no camera and no cable.
 *
 * Two things are tested here, both of them the parts a wrong answer strands a
 * reader on: the shape rules (mirrored from shared/src/pairing-code.ts, so a
 * typo is refused locally rather than spending one of the operator's five
 * attempts), and the status→screen mapping, which is the difference between
 * "type it again" and "go open a window on your Mac".
 *
 * Robolectric because `interpret` reads the daemon's body with `org.json`, which
 * is a throwing stub in a plain unit test — the same reason `ProtocolTest` runs
 * under it.
 */
@RunWith(RobolectricTestRunner::class)
class PairingCodeClientTest {

    private val host = "192.168.1.10"
    private val port = 9120

    private fun interpret(status: Int, body: String?) =
        PairingCodeClient.interpret(status, body, host, port)

    // ── shape rules ───────────────────────────────────────────────────────

    @Test
    fun `normalize accepts a bare code`() {
        assertEquals("482913", PairingCodeRules.normalize("482913"))
    }

    @Test
    fun `normalize accepts the separators the code was displayed with`() {
        // The CLI prints `482 913`; refusing that is refusing what the operator
        // is looking at.
        for (typed in listOf("482 913", "482-913", " 482913 ")) {
            assertEquals("482913", PairingCodeRules.normalize(typed))
        }
    }

    @Test
    fun `normalize rejects anything that is not the code length`() {
        for (bad in listOf("48291", "4829134", "", "abcdef", null)) {
            assertNull(PairingCodeRules.normalize(bad))
        }
    }

    @Test
    fun `format groups the code the way the CLI prints it`() {
        assertEquals("482 913", PairingCodeRules.format("482913"))
    }

    @Test
    fun `constants match the daemon's`() {
        assertEquals(6, PairingCodeRules.DIGITS)
        assertEquals(5, PairingCodeRules.MAX_FAILED_ATTEMPTS)
    }

    // ── status mapping ────────────────────────────────────────────────────

    @Test
    fun `200 with a token pairs, using the endpoint we actually reached`() {
        val result = interpret(200, """{"token":"abc123","port":9120}""")
        assertTrue(result is PairingCodeClient.Result.Paired)
        result as PairingCodeClient.Result.Paired
        assertEquals("ws://192.168.1.10:9120?token=abc123", result.wsUrl)
        assertEquals("abc123", result.token)
    }

    @Test
    fun `200 without a token is a daemon fault, not a pairing`() {
        // Never report success without a credential: the ladder would persist a
        // tokenless URL as this device's pairing.
        val result = interpret(200, """{"port":9120}""")
        assertTrue(result is PairingCodeClient.Result.Unreachable)
    }

    @Test
    fun `401 mismatch is a retryable wrong code, and carries the budget`() {
        val result = interpret(401, """{"error":"mismatch","attemptsRemaining":3}""")
        assertEquals(PairingCodeClient.Result.WrongCode(3), result)
    }

    @Test
    fun `401 no-window sends the user to the Mac instead of retyping`() {
        // Same status as a wrong code on purpose — a closed daemon must not
        // reveal that somebody is pairing — so the body is what separates them.
        assertEquals(
            PairingCodeClient.Result.NoWindow,
            interpret(401, """{"error":"no-window","attemptsRemaining":0}"""),
        )
    }

    @Test
    fun `401 with no body at all is treated as no window`() {
        // The safe reading: telling the user to retype into a daemon that is not
        // listening is the one answer that cannot work.
        assertEquals(PairingCodeClient.Result.NoWindow, interpret(401, null))
        assertEquals(PairingCodeClient.Result.NoWindow, interpret(401, "not json"))
    }

    @Test
    fun `410 and 429 mean the window is gone, not that the code was wrong`() {
        assertEquals(PairingCodeClient.Result.WindowClosed, interpret(410, """{"error":"expired"}"""))
        assertEquals(PairingCodeClient.Result.WindowClosed, interpret(429, """{"error":"exhausted"}"""))
    }

    @Test
    fun `400 malformed is retryable and spends none of the budget`() {
        val result = interpret(400, """{"error":"malformed","attemptsRemaining":5}""")
        assertEquals(PairingCodeClient.Result.WrongCode(5), result)
    }

    @Test
    fun `an unexpected status is reported rather than guessed at`() {
        val result = interpret(500, """{"error":"boom"}""")
        assertTrue(result is PairingCodeClient.Result.Unreachable)
        assertTrue((result as PairingCodeClient.Result.Unreachable).detail.contains("500"))
    }

    @Test
    fun `a missing attempt count degrades to unknown, never to zero`() {
        // Zero would read as "window closed" on screen and stop a user who in
        // fact has tries left.
        val result = interpret(401, """{"error":"mismatch"}""")
        assertEquals(PairingCodeClient.Result.WrongCode(-1), result)
    }
}
