// GENERATED from shared/src/usage-severity.ts and design token bindings. DO NOT EDIT.
package dev.agentdeck.util
object UsageSeverity {
    enum class Level { UNKNOWN, NORMAL, WARNING, CRITICAL }
    fun level(used: Double): Level = when {
        !used.isFinite() || used < 0 -> Level.UNKNOWN
        used >= 90 -> Level.CRITICAL
        used >= 70 -> Level.WARNING
        else -> Level.NORMAL
    }
    private val bright = longArrayOf(0xFF7a8a9c, 0xFF52D988, 0xFFFFA93D, 0xFFFF6B6B)
    private val paper = longArrayOf(0xFF3d454e, 0xFF296c44, 0xFF7f541e, 0xFF7f3535)
    fun inactiveColor(onPaper: Boolean = false): Long = if (onPaper) 0xFF1f6b74 else 0xFF3ED6E8
    fun color(used: Double, onPaper: Boolean = false): Long = (if (onPaper) paper else bright)[level(used).ordinal]
}
