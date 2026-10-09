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

    private val now = 1_000_000_000L

    private fun mayDial(
        current: String? = null,
        loopbackTried: Boolean = true,
        unauthorized: Map<String, Long> = emptyMap(),
        saved: String? = null,
        nowMs: Long = now,
    ) = PairingCredential.mayDialDiscovered(
        discovered, current, loopbackTried, unauthorized, saved, nowMs,
    )

    /** A refusal stamped fresh enough that the holdoff still applies. */
    private fun refusedNow(vararg endpoints: String): Map<String, Long> =
        endpoints.associateWith { now }

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
    fun `an endpoint that closed us 4001 is not redialled inside the holdoff`() {
        // The socket layer clears the URL on 4001, so "rejected" and "never
        // tried" look identical from here unless the refusal is its own fact.
        assertFalse(mayDial(unauthorized = refusedNow("192.168.1.10:9120")))
        assertFalse(
            mayDial(
                unauthorized = mapOf("192.168.1.10:9120" to now),
                nowMs = now + PairingCredential.UNAUTHORIZED_REDIAL_HOLDOFF_MS - 1,
            )
        )
    }

    @Test
    fun `a refusal expires on read, because approval mints no token`() {
        // Operator approval makes the endpoint dialable without giving the
        // device any new credential to offer — so a refusal remembered without
        // an age could only ever be retired by an app restart. An aged-out
        // refusal buys one redial; a daemon that still refuses re-stamps it.
        assertTrue(
            mayDial(
                unauthorized = mapOf("192.168.1.10:9120" to now),
                nowMs = now + PairingCredential.UNAUTHORIZED_REDIAL_HOLDOFF_MS,
            )
        )
    }

    @Test
    fun `a refused endpoint is dialled again once we hold a credential for it`() {
        assertTrue(mayDial(unauthorized = refusedNow("192.168.1.10:9120"), saved = paired))
    }

    @Test
    fun `a refusal is remembered per endpoint, not globally`() {
        assertTrue(mayDial(unauthorized = refusedNow("192.168.1.99:9120")))
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
            PairingCredential.approvalMessage("ws://192.168.1.10:9120"),
            detail,
        )
    }

    @Test
    fun `pairing is still offered to a device riding the USB tunnel`() {
        // The case this exists for: a reader on `adb reverse` shows a live
        // dashboard and has no credential at all. Gating the offer on
        // "disconnected" hid it from every device it was written for.
        assertTrue(PairingCredential.shouldOfferPairing(connected = true, currentUrl = "ws://127.0.0.1:9120"))
        assertTrue(PairingCredential.shouldOfferPairing(connected = true, currentUrl = "ws://localhost:9120"))
        assertTrue(PairingCredential.shouldOfferPairing(connected = false, currentUrl = null))
        assertTrue(PairingCredential.shouldOfferPairing(connected = false, currentUrl = paired))
    }

    @Test
    fun `pairing is not offered to a device already on the LAN`() {
        // It got there with a credential; offering to replace it is noise.
        assertFalse(PairingCredential.shouldOfferPairing(connected = true, currentUrl = paired))
        assertFalse(PairingCredential.shouldOfferPairing(connected = true, currentUrl = discovered))
    }

    @Test
    fun `the advice a camera-less reader is given is one it can actually take`() {
        // This copy is the whole recovery path on a device with no camera and no
        // cable. It has been wrong twice, each time by asking the DEVICE for
        // something it cannot give: first a 32-character token typed on an e-ink
        // keyboard, then a six-digit code that is only reachable once mDNS has
        // found the daemon — which, on a device reading this, it may never have.
        //
        // So the assertions pin the invariant rather than the sentence: whatever
        // the wording, it must not route the user through a token, and must not
        // send them to a CLI the App Store build does not ship. Rewording the
        // copy should not need a test edit; regressing it should.
        val detail = PairingCredential.disconnectedDetail(null, setOf("192.168.1.10:9120"))!!
        assertFalse(detail.contains("token="))
        assertFalse(detail.contains("agentdeck pair"))
        assertTrue(detail.contains("approve") || detail.contains("approval"))
        assertTrue(detail.contains("192.168.1.10:9120"))
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
        val refused = refusedNow("192.168.1.10:9120", "macbook.local:9120")
        assertFalse(mayDial(unauthorized = refused))
        assertFalse(
            PairingCredential.mayDialDiscovered(
                "ws://macbook.local:9120", null, true, refused, null, now,
            )
        )
    }
    @Test
    fun `switching hosts retains independent credentials`() {
        val first = "ws://192.168.1.10:9120?token=first"
        val second = "ws://192.168.1.11:9120?token=second"
        var saved = PairingCredential.remember(first, emptyMap())
        saved = PairingCredential.remember(second, saved)
        saved = PairingCredential.remember("ws://192.168.1.10:9120", saved)
        assertEquals(first, PairingCredential.resolveFromStore("ws://192.168.1.10:9120", saved))
        assertEquals(second, PairingCredential.resolveFromStore("ws://192.168.1.11:9120", saved))
        assertEquals("ws://192.168.1.12:9120", PairingCredential.resolveFromStore("ws://192.168.1.12:9120", saved))
    }

    @Test
    fun `a refusal from another host does not explain this hosts network failure`() {
        assertEquals("Network unreachable", PairingCredential.disconnectedDetail(
            "Network unreachable", setOf("192.168.1.10:9120"), "ws://192.168.1.11:9120"))
    }

    @Test fun `exhausted selected host keeps its own network error`() {
        val error = "Bridge not found"
        assertEquals(error, PairingCredential.disconnectedDetail(error, setOf("first.local:9120"),
            currentUrl = null, selectedUrl = "ws://second.local:9120"))
    }

}
