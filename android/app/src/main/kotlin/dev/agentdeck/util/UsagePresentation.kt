// GENERATED from shared/src/usage-presentation.ts. DO NOT EDIT.
package dev.agentdeck.util
object UsagePresentation {
    const val heading = "USAGE"
    fun lunaActive(primary: Double, secondary: Double, reserve: Double): Boolean = reserve >= 0 && (primary >= 100 || secondary >= 100)
}
