package dev.agentdeck.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A discovered endpoint must not un-pair a device.
 *
 * Case-for-case mirror of Apple's `PairingCredentialTests`. Keep the two in
 * step: they encode one cross-platform contract, not two implementations.
 */
class PairingCredentialTest {

    private val paired = "ws://192.168.1.10:9120?token=abcdef0123456789abcdef0123456789"
    private val discovered = "ws://192.168.1.10:9120"

    @Test
    fun `credential is not part of a daemon's identity`() {
        assertTrue(PairingCredential.sameEndpoint(discovered, paired))
    }

    @Test
    fun `default port matches an explicit default port`() {
        assertTrue(PairingCredential.sameEndpoint("ws://192.168.1.10", "ws://192.168.1.10:9120"))
    }

    @Test
    fun `different host or port are different daemons`() {
        assertFalse(PairingCredential.sameEndpoint(discovered, "ws://192.168.1.11:9120"))
        assertFalse(PairingCredential.sameEndpoint(discovered, "ws://192.168.1.10:9125"))
    }

    @Test
    fun `unparseable inputs never compare equal`() {
        assertFalse(PairingCredential.sameEndpoint(null, null))
        assertFalse(PairingCredential.sameEndpoint(discovered, null))
        assertFalse(PairingCredential.sameEndpoint("not a url", "not a url"))
    }

    @Test
    fun `token extraction treats empty as absent`() {
        assertEquals("abcdef0123456789abcdef0123456789", PairingCredential.tokenIn(paired))
        assertNull(PairingCredential.tokenIn(discovered))
        assertNull(PairingCredential.tokenIn("ws://192.168.1.10:9120?token="))
        assertNull(PairingCredential.tokenIn(null))
    }

    @Test
    fun `paired endpoint inherits its stored credential`() {
        assertEquals(paired, PairingCredential.resolve(discovered, paired))
    }

    @Test
    fun `a different daemon never inherits another endpoint's credential`() {
        val other = "ws://192.168.1.11:9120"
        assertEquals(other, PairingCredential.resolve(other, paired))
    }

    @Test
    fun `no stored credential leaves the discovered url untouched`() {
        assertEquals(discovered, PairingCredential.resolve(discovered, null))
        assertEquals(discovered, PairingCredential.resolve(discovered, discovered))
    }

    @Test
    fun `an explicitly credentialed discovery wins`() {
        val legacy = "ws://192.168.1.10:9120?token=1111111111111111"
        assertEquals(legacy, PairingCredential.resolve(legacy, paired))
    }

    // --- persistence guard: the racy-overwrite half of the regression ---

    @Test
    fun `a tokenless url may not displace a stored credential for the same daemon`() {
        assertFalse(PairingCredential.mayPersist(discovered, paired))
    }

    @Test
    fun `a credentialed url always persists`() {
        assertTrue(PairingCredential.mayPersist(paired, discovered))
        assertTrue(PairingCredential.mayPersist(paired, null))
    }

    @Test
    fun `a tokenless url persists when nothing better is stored`() {
        assertTrue(PairingCredential.mayPersist(discovered, null))
        assertTrue(PairingCredential.mayPersist(discovered, discovered))
    }

    @Test
    fun `a tokenless url for a different daemon still persists`() {
        assertTrue(PairingCredential.mayPersist("ws://192.168.1.11:9120", paired))
    }

    @Test
    fun `localhost and blank are never persisted`() {
        assertFalse(PairingCredential.mayPersist(null, null))
        assertFalse(PairingCredential.mayPersist("", null))
        assertFalse(PairingCredential.mayPersist("ws://127.0.0.1:9120", null))
        assertFalse(PairingCredential.mayPersist("ws://localhost:9120", null))
    }

    // ── mayDialDiscovered ────────────────────────────────────────────────
    // The USB path answers first, and a 4001 endpoint stays refused. Both
    // matter most on a camera-less e-ink reader: over `adb reverse` it is
    // same-machine and needs no token, and it cannot scan a pairing QR.

    private fun mayDial(
        current: String? = null,
        loopbackTried: Boolean = true,
        unauthorized: Set<String> = emptySet(),
        saved: String? = null,
    ) = PairingCredential.mayDialDiscovered(discovered, current, loopbackTried, unauthorized, saved)

    @Test
    fun `the LAN endpoint is dialled once nothing else is in flight`() {
        assertTrue(mayDial())
    }

    @Test
    fun `the USB attempt is not preempted while it is still in flight`() {
        // The turn is held by the URL, not by a flag: the loopback probe owns
        // the connection until the socket layer gives up and clears it.
        assertFalse(mayDial(current = "ws://127.0.0.1:9120"))
        assertFalse(mayDial(current = "ws://localhost:9120"))
        assertFalse(mayDial(current = null, loopbackTried = false))
    }

    @Test
    fun `a live connection to another endpoint is left alone`() {
        assertFalse(mayDial(current = "ws://192.168.1.11:9120"))
    }

    @Test
    fun `an endpoint that closed us 4001 is not redialled`() {
        // The socket layer clears the URL on 4001, so "rejected" and "never
        // tried" look identical from here unless the refusal is its own fact.
        assertFalse(mayDial(unauthorized = setOf("192.168.1.10:9120")))
    }

    @Test
    fun `a refused endpoint is dialled again once we hold a credential for it`() {
        assertTrue(mayDial(unauthorized = setOf("192.168.1.10:9120"), saved = paired))
    }

    @Test
    fun `a refusal is remembered per endpoint, not globally`() {
        assertTrue(mayDial(unauthorized = setOf("192.168.1.99:9120")))
    }

    // ── what the disconnected screen says ────────────────────────────────

    @Test
    fun `a refusal outranks whatever the last attempt reported`() {
        // The recovery ladder keeps probing the USB path in the background, so
        // its failure text kept overwriting the only message the user can act
        // on. Being refused did not stop being true.
        val detail = PairingCredential.disconnectedDetail(
            "USB bridge not found — try WiFi",
            setOf("192.168.1.10:9120"),
        )
        assertEquals(
            "Not paired with 192.168.1.10:9120 — run \"agentdeck pair\" on your Mac, " +
                "then enter the code in Settings",
            detail,
        )
    }

    @Test
    fun `the advice a camera-less reader is given is one it can actually take`() {
        // This copy is the whole recovery path on a device with no camera and no
        // cable, so it must not send the user back to typing a token URL on an
        // e-ink keyboard — that was the old text, and it is why these readers
        // stayed unpaired.
        val detail = PairingCredential.disconnectedDetail(null, setOf("192.168.1.10:9120"))!!
        assertTrue(detail.contains("agentdeck pair"))
        assertFalse(detail.contains("token="))
    }

    @Test
    fun `with nothing refused the last error stands`() {
        assertEquals(
            "USB bridge not found — try WiFi",
            PairingCredential.disconnectedDetail("USB bridge not found — try WiFi", emptySet()),
        )
        assertNull(PairingCredential.disconnectedDetail(null, emptySet()))
    }

    @Test
    fun `every refused spelling of one daemon stays refused`() {
        // A dual-homed daemon is offered as both its TXT ip and its
        // NSD-resolved host, and the reconnect ladder fails over between them.
        // With a single remembered refusal the two took turns looking new.
        val refused = setOf("192.168.1.10:9120", "macbook.local:9120")
        assertFalse(mayDial(unauthorized = refused))
        assertFalse(
            PairingCredential.mayDialDiscovered(
                "ws://macbook.local:9120", null, true, refused, null,
            )
        )
    }
}
