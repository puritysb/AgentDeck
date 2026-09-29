// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/session-utils.ts (SESSION_WEIGHT_MIN/MAX, SESSION_ORDER_TTL_MS, MAX_SESSION_ORDER_PINS)
// Regenerate: pnpm generate-session-weight-rules (drift gated by shared/src/__tests__/session-weight-rules.test.ts)
package dev.agentdeck.net

/**
 * Documented cross-platform `--weight` range. A session weight on the wire
 * is always an integer inside [MIN, MAX]; [clamp] is the shared normalize
 * step every Kotlin consumer applies before comparing.
 *
 * [SESSION_ORDER_TTL_MS] / [MAX_SESSION_ORDER_PINS] extend the same contract
 * onto the daemon-persisted observed-session order pins (#273). Android does
 * not read the pin file; it carries the constants as the client mirror so the
 * cross-daemon file contract stays single-sourced.
 */
object SessionWeightRules {
    const val MIN = -9999
    const val MAX = 9999
    const val SESSION_ORDER_TTL_MS = 2592000000
    const val MAX_SESSION_ORDER_PINS = 256

    fun clamp(weight: Int): Int = weight.coerceIn(MIN, MAX)
}
