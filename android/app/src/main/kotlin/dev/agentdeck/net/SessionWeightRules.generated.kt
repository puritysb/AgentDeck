// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/session-utils.ts (SESSION_WEIGHT_MIN/MAX)
// Regenerate: pnpm generate-session-weight-rules (drift gated by shared/src/__tests__/session-weight-rules.test.ts)
package dev.agentdeck.net

/**
 * Documented cross-platform `--weight` range. A session weight on the wire
 * is always an integer inside [MIN, MAX]; [clamp] is the shared normalize
 * step every Kotlin consumer applies before comparing.
 */
object SessionWeightRules {
    const val MIN = -9999
    const val MAX = 9999

    fun clamp(weight: Int): Int = weight.coerceIn(MIN, MAX)
}
