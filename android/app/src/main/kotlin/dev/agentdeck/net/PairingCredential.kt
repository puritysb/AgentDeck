package dev.agentdeck.net

import java.net.URI

// java.net.URI, not android.net.Uri: this logic is pure and must stay testable
// in plain JUnit without pulling Robolectric in for a string parse.

/**
 * How a discovered endpoint and a stored credential combine.
 *
 * Discovery answers WHERE the daemon is. It has never been allowed to answer
 * WHAT the pairing token is — the daemon stopped advertising the token over
 * mDNS TXT, the UDP beacon, and unauthenticated `/health` (GitHub #145, #149),
 * because a credential handed out over the same channel that needs
 * authenticating is not a credential. Tokens now arrive only from a manually
 * typed URL (Android has no QR scanner).
 *
 * That left a stale assumption behind: "a discovered bridge URL is a complete,
 * dialable URL". It is not — it is an endpoint with no credential attached.
 * Dialing it verbatim gets the socket closed 4001, and persisting it on the
 * (handshake-early) CONNECTED edge overwrote the user's typed, token-bearing
 * URL with a tokenless one.
 *
 * The two rules, which any new call site must follow:
 *  1. Compare bridges by ENDPOINT (host + port), never by full URL string — a
 *     credential is not part of a daemon's identity.
 *  2. An endpoint we already hold a credential for INHERITS it. Absent means
 *     "no information", never "the credential is now empty".
 *
 * Mirrored in Swift as `apple/AgentDeck/Net/PairingCredential.swift`; the two
 * test suites share their cases.
 */
object PairingCredential {

    private const val DEFAULT_PORT = 9120

    /** Host+port identity of a `ws://host:port?...` URL, ignoring credentials. */
    fun endpointOf(url: String?): String? {
        if (url.isNullOrBlank()) return null
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        val host = uri.host?.lowercase() ?: return null
        val port = if (uri.port > 0) uri.port else DEFAULT_PORT
        return "$host:$port"
    }

    /** True when both URLs name the same daemon, regardless of credentials. */
    fun sameEndpoint(a: String?, b: String?): Boolean {
        val lhs = endpointOf(a) ?: return false
        val rhs = endpointOf(b) ?: return false
        return lhs == rhs
    }

    /** The `token` query parameter of a URL, if it carries a non-empty one. */
    fun tokenIn(url: String?): String? {
        if (url.isNullOrBlank()) return null
        val query = runCatching { URI(url).query }.getOrNull() ?: return null
        val token = query.split('&')
            .firstOrNull { it == "token" || it.startsWith("token=") }
            ?.substringAfter('=', "")
        return token?.takeIf { it.isNotEmpty() }
    }

    /**
     * The URL to actually dial for [discoveredUrl].
     *
     * When [savedUrl] holds a credential for the same endpoint, that credential
     * is carried over — discovery relocated the daemon, it did not un-pair the
     * device. A different endpoint, or no stored credential, yields
     * [discoveredUrl] untouched (the user then needs to enter a paired URL).
     */
    fun resolve(discoveredUrl: String, savedUrl: String?): String {
        if (tokenIn(discoveredUrl) != null) return discoveredUrl
        if (!sameEndpoint(discoveredUrl, savedUrl)) return discoveredUrl
        if (tokenIn(savedUrl) == null) return discoveredUrl
        return savedUrl!!
    }

    /**
     * Whether [candidate] may replace [stored] as the persisted bridge URL.
     *
     * Refuses a downgrade: a tokenless URL must never overwrite a stored
     * credential for the same daemon. Android marks CONNECTED at the WebSocket
     * handshake, which the daemon completes before rejecting an unauthorized
     * peer with 4001 — so without this guard a doomed tokenless attempt could
     * still race in and erase a working pairing.
     */
    fun mayPersist(candidate: String?, stored: String?): Boolean {
        if (candidate.isNullOrBlank()) return false
        if (candidate.contains("127.0.0.1") || candidate.contains("localhost")) return false
        if (tokenIn(candidate) != null) return true
        return !(sameEndpoint(candidate, stored) && tokenIn(stored) != null)
    }

    /**
     * What a disconnected screen should say, given the last attempt's error and
     * the endpoints that have refused us.
     *
     * A refusal outranks the error text because they are different kinds of
     * fact. `lastError` is whatever the most recent attempt happened to report,
     * and the recovery ladder keeps probing the loopback path in the
     * background — so on a device that has no reverse tunnel and no pairing
     * token, "USB bridge not found — try WiFi" kept overwriting the one message
     * that says what is actually wrong and what to do about it. Being refused
     * does not stop being true because a later probe failed differently.
     *
     * Android-only: an e-ink reader has no camera, so the answer here is never
     * "scan the pairing QR". It used to be "enter ws://…?token=… in Settings",
     * which is a 32-hex-character string typed on an e-ink keyboard — advice
     * technically possible and practically not taken. A pairing code is six
     * digits, so that is what this points at now; see [PairingCodeClient].
     */
    fun disconnectedDetail(lastError: String?, unauthorizedEndpoints: Set<String>): String? {
        val endpoint = unauthorizedEndpoints.firstOrNull() ?: return lastError
        return "Not paired with $endpoint — run \"agentdeck pair\" on your Mac, " +
            "then enter the code in Settings"
    }

    /** True for the `adb reverse` loopback endpoint, which needs no credential. */
    fun isLoopback(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        return url.contains("127.0.0.1") || url.contains("localhost")
    }

    /**
     * Whether a discovered LAN endpoint may be dialled right now.
     *
     * Two rules, one per way the old unconditional preempt failed.
     *
     * **The USB path answers first.** `adb reverse` puts the daemon on
     * 127.0.0.1, where it is same-machine and needs no token at all — so a
     * USB-attached device should never be asked to pair. Preempting that
     * attempt the moment mDNS resolves (mDNS visibility says nothing about
     * whether the reverse tunnel works) is what pushed camera-less e-ink
     * readers into a QR flow they cannot complete. A loopback probe fails in
     * milliseconds when the tunnel is absent, so letting it answer costs
     * almost nothing and the LAN endpoint is still reached.
     *
     * That turn is held by [currentUrl], not by a flag: an attempt in flight —
     * loopback or otherwise — owns the connection, and `BridgeConnection`
     * clears the URL when it gives up. A boolean latch would have to be
     * re-armed for every later probe, and any path that forgot (a cancelled
     * effect, an early return) would either strand the LAN endpoint forever or
     * silently restore the preempt. [loopbackTried] covers only the startup
     * window before the first loopback dial has been issued, when there is no
     * URL yet to hold the turn.
     *
     * **A 4001 endpoint is not dialable again without a credential.** The
     * socket layer stops its own reconnect on 4001 — and also clears the URL,
     * which made "rejected" indistinguishable from "never tried" to the layer
     * above, so every discovery emission redialled it (measured at ~25/s
     * against a live daemon). Rejection has to be remembered as its own fact,
     * keyed by ENDPOINT like every other credential decision here — and as a
     * SET, because one daemon can be offered under two spellings (the TXT ip
     * and the NSD-resolved host), and remembering only the last refusal lets
     * the two take turns being "new".
     *
     * Android-only, unlike the rest of this object: `adb reverse` has no Apple
     * analogue and Apple's reconnect ladder lives in `AgentStateHolder`. The
     * cases shared with `PairingCredentialTests` cover the functions above.
     */
    fun mayDialDiscovered(
        discoveredUrl: String,
        currentUrl: String?,
        loopbackTried: Boolean,
        unauthorizedEndpoints: Set<String>,
        savedUrl: String?,
    ): Boolean {
        // Something is already being tried — the loopback probe included.
        if (currentUrl != null) return false
        // The first loopback dial has not been issued yet; it answers first.
        if (!loopbackTried) return false
        // Rejected here before, and we still have nothing new to offer it.
        val endpoint = endpointOf(discoveredUrl) ?: return true
        if (endpoint in unauthorizedEndpoints &&
            tokenIn(resolve(discoveredUrl, savedUrl)) == null
        ) {
            return false
        }
        return true
    }
}
