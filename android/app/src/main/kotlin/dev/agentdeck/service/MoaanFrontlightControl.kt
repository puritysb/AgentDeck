package dev.agentdeck.service

/** Android 14 MOAAN LightUtils contract; procfs writes only update its cache. */
internal class MoaanFrontlightControl(
    private val read: (String) -> String?,
    private val write: (String, String?) -> Boolean,
    private val save: (Snapshot?) -> Boolean,
    restored: Snapshot? = null,
) {
    data class Snapshot(
        val mode: Int, val light: Int, val warm: Int,
        val lightEnabled: Boolean, val warmEnabled: Boolean,
        val presets: Map<String, String?>,
    )

    companion object {
        const val MODE = "light_current_mode"
        private val prefixes = listOf("custom", "close", "daytime", "nighttime", "bed", "auto")
        private val suffixes = listOf("light_key", "warm_key", "light_status", "warm_status")
        val savedKeys = listOf("close", "custom").flatMap { p -> suffixes.map { "${p}_mode_$it" } }
        private val lightDefaults = listOf(16, 0, 5, 15, 5, 0)
        private val warmDefaults = listOf(0, 0, 0, 0, 8, 0)

        fun valid(s: Snapshot): Boolean = s.mode in 0..5 && s.light in 0..32 && s.warm in 0..32 &&
            s.presets.keys == savedKeys.toSet() && s.presets.all { (key, value) ->
                value == null || value.toIntOrNull()?.let { it in 0..if (key.endsWith("status")) 1 else 32 } == true
            }
    }

    private var original = restored?.also { require(valid(it)) }
    val pending: Boolean get() = original != null
    val available: Boolean get() = pending || runCatching { read(MODE)?.toIntOrNull() in 0..5 }.getOrDefault(false)

    private fun capture(): Snapshot {
        val mode = read(MODE)?.toIntOrNull()?.takeIf { it in 0..5 } ?: error("unknown light mode")
        val prefix = "${prefixes[mode]}_mode_"
        fun value(key: String, default: Int): Int = read(key)?.let { it.toIntOrNull() ?: error("invalid light value") } ?: default
        val statusDefault = if (mode == 0) 0 else 1
        return Snapshot(mode,
            value(prefix + "light_key", lightDefaults[mode]), value(prefix + "warm_key", warmDefaults[mode]),
            mode == 5 || value(prefix + "light_status", statusDefault) == 1,
            mode == 5 || value(prefix + "warm_status", statusDefault) == 1,
            savedKeys.associateWith(read)).also { require(valid(it)) }
    }

    fun dim(mode: String, level: Int): Boolean = try {
        val state = original ?: capture().also {
            check(save(it)) // Durable recovery precedes every global setting mutation.
            original = it
        }
        val off = mode != "min"
        val prefix = if (off) "close_mode_" else "custom_mode_"
        val target = if (off || state.light == 0) 0 else (state.light * level.coerceIn(1, 100) / 100).coerceAtLeast(1)
        val changes = linkedMapOf(
            prefix + "light_key" to target.toString(),
            prefix + "warm_key" to (if (off) 0 else state.warm).toString(),
            prefix + "light_status" to (if (off || state.lightEnabled) "1" else "0"),
            prefix + "warm_status" to (if (off || state.warmEnabled) "1" else "0"),
            MODE to (if (off) "1" else "0"),
        )
        for ((key, value) in changes) {
            check(write(key, value) && read(key) == value)
        }
        true
    } catch (_: Exception) { false }

    fun restore(): Boolean {
        val state = original ?: return true
        return try {
            check(write(MODE, state.mode.toString()) && read(MODE) == state.mode.toString())
            for ((key, value) in state.presets) check(write(key, value) && read(key) == value)
            check(save(null))
            original = null
            true
        } catch (_: Exception) { false } // Keep the journal for the next wake/restart.
    }
}
