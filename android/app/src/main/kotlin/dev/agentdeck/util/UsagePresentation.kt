// GENERATED from shared/src/usage-presentation.ts. DO NOT EDIT.
package dev.agentdeck.util
object UsagePresentation {
    const val heading = "USAGE"
    fun lunaActive(primary: Double, secondary: Double, reserve: Double): Boolean = reserve >= 0 && (primary >= 100 || secondary >= 100)
    /** usageCreditsActive: balance is -1 when unknown, +Infinity when unlimited. */
    fun creditsActive(primary: Double, secondary: Double, balance: Double): Boolean = balance > 0 && (primary >= 100 || secondary >= 100)
    /** formatCreditBalance: truncated, integer-only, "∞" when unlimited. */
    fun formatCreditBalance(balance: Double): String {
        if (balance == Double.POSITIVE_INFINITY) return "\u221E"
        if (!balance.isFinite() || balance <= 0) return "0"
        for ((divisor, suffix) in listOf(1000000.0 to "M", 1000.0 to "K")) {
            if (balance < divisor) continue
            val tenths = kotlin.math.floor(balance * 10 / divisor).toLong()
            return if (tenths >= 1000 || tenths % 10 == 0L) "${tenths / 10}$suffix" else "${tenths / 10}.${tenths % 10}$suffix"
        }
        if (balance >= 10) return kotlin.math.floor(balance).toLong().toString()
        val tenths = kotlin.math.floor(balance * 10).toLong()
        return if (tenths % 10 == 0L) "${tenths / 10}" else "${tenths / 10}.${tenths % 10}"
    }
}
