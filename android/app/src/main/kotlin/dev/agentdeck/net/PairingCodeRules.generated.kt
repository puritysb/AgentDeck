// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/pairing-code.ts
// Regenerate: pnpm generate-pairing-code-rules (drift gated by shared/src/__tests__/pairing-code-rules-sync.test.ts)
package dev.agentdeck.net

/**
 * Operator-authorized pairing codes — the credential path for a reader with no
 * camera to scan `agentdeck qr` with and no USB channel to be provisioned over.
 * See shared/src/pairing-code.ts for the security reasoning.
 *
 * Android is a client here: it collects the code the operator reads off the Mac
 * and redeems it for a token. Judging a redemption is the daemon's job, so the
 * evaluator is deliberately not mirrored — only the shape both sides must agree
 * on, so the app can validate the field before spending one of the operator's
 * five attempts on a typo.
 */
object PairingCodeRules {

    /** Digits in a pairing code. */
    const val DIGITS = 6

    /** How long an operator-opened window stays open, in milliseconds. */
    const val WINDOW_MS = 120000L

    /** Port a typed address means when it carries none. */
    const val DEFAULT_DAEMON_PORT = 9120

    /** Quiet period before retrying the same selected host, never another host. */
    const val CLIENT_RECONNECT_COOLDOWN_MS = 30000L

    /** Wrong codes the whole window tolerates before it closes. */
    const val MAX_FAILED_ATTEMPTS = 5

    /** Credentials one window hands out unless the operator asks for more. */
    const val DEFAULT_REDEMPTIONS = 1

    /**
     * Reduce a human-entered code to its canonical form, or null if it is not one.
     *
     * Filters to ASCII digits, which is also why the Kotlin/TS string-unit trap
     * does not apply: after filtering, UTF-16 code units and characters agree.
     */
    fun normalize(input: String?): String? {
        if (input == null) return null
        val digitsOnly = input.filter { it in '0'..'9' }
        return if (digitsOnly.length == DIGITS) digitsOnly else null
    }

    /** True when [code] is exactly what [normalize] emits. */
    fun isPairingCode(code: String?): Boolean = code != null && normalize(code) == code

    /** Group a code for display: `482913` → `482 913`. */
    fun format(code: String): String {
        val normalized = normalize(code) ?: return code
        val half = DIGITS / 2
        return "${normalized.substring(0, half)} ${normalized.substring(half)}"
    }

    data class DaemonAddress(val host: String, val port: Int)

    /**
     * Parse an operator-typed daemon address into host + port.
     *
     * The code path is otherwise gated on discovery — a client spends a code
     * against a daemon it found over mDNS — so on a network where multicast is
     * filtered the six-digit path is unreachable by exactly the camera-less
     * devices it was built for. Shared with the other client because the two
     * must agree what a bare `192.168.1.5` means.
     */
    fun parseDaemonAddress(input: String?): DaemonAddress? {
        var text = input?.trim().orEmpty()
        if (text.isEmpty()) return null
        val scheme = text.indexOf("://")
        if (scheme >= 0) text = text.substring(scheme + 3)
        for (cut in listOf("/", "?", "#")) {
            val at = text.indexOf(cut)
            if (at >= 0) text = text.substring(0, at)
        }
        if (text.isEmpty()) return null

        var host = text
        var port = DEFAULT_DAEMON_PORT

        if (text.startsWith("[")) {
            val close = text.indexOf(']')
            if (close < 0) return null
            host = text.substring(1, close)
            val rest = text.substring(close + 1)
            if (rest.startsWith(":")) {
                port = parsePort(rest.substring(1)) ?: return null
            } else if (rest.isNotEmpty()) {
                return null
            }
        } else {
            val colons = text.count { it == ':' }
            if (colons == 1) {
                val at = text.lastIndexOf(':')
                port = parsePort(text.substring(at + 1)) ?: return null
                host = text.substring(0, at)
            } else if (colons > 1) {
                // A bare IPv6 literal carries its own colons and no port.
                host = text
            }
        }

        if (host.isEmpty()) return null
        return DaemonAddress(host, port)
    }

    private fun parsePort(text: String): Int? {
        if (text.isEmpty() || text.length > 5 || !text.all { it in '0'..'9' }) return null
        val value = text.toIntOrNull() ?: return null
        return if (value in 1..65535) value else null
    }

    /**
     * Handshake header a client uses to say WHICH device it is. Approval needs
     * an identity, and the source address stops being one behind NAT, where
     * every device shares it. Not proof: the link is plaintext, so anything in
     * the handshake is replayable by a passive observer — as true of the
     * existing token. The win is granularity and revocation, not secrecy.
     */
    const val DEVICE_ID_HEADER = "x-agentdeck-device"

    /** Characters in a device id — 128 bits, same shape as the auth token. */
    const val DEVICE_ID_LENGTH = 32

    /**
     * Strict on purpose: this string is a map key and an approved row, so a
     * client must not be able to vary its own identity between connects and
     * appear as several devices — or outlive a revocation that way.
     */
    fun normalizeDeviceId(input: String?): String? {
        val trimmed = input?.trim()?.lowercase() ?: return null
        if (trimmed.length != DEVICE_ID_LENGTH) return null
        return if (trimmed.all { it in '0'..'9' || it in 'a'..'f' }) trimmed else null
    }

    /** Short form for a row the operator reads — never used as a key. */
    fun shortDeviceId(id: String): String = normalizeDeviceId(id)?.take(8) ?: id
}
