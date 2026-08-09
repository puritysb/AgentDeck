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
}
