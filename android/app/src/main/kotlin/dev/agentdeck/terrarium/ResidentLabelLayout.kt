package dev.agentdeck.terrarium

/**
 * Name-tag placement for the native aquarium (DESIGN.md §6.4).
 *
 * A tag must never hide another resident. Tags are resolved in priority order —
 * focused, awaiting, working, idle; nearer residents first within a rank — so
 * the tag that matters most claims its space first and is drawn last (on top):
 *
 *  - In a dense tank (≥ [TerrariumRules.NATIVE_LABEL_DENSE_RESIDENT_COUNT]
 *    residents) an idle, unfocused tag collapses to a title-only chip; the
 *    creature's dim pose and the roster already say "idle".
 *  - An idle tag that would collide with a tag already placed is dropped —
 *    the roster still lists it. Any other colliding tag stays but yields.
 *  - A tag lying over another resident's body yields: its backing drops to
 *    [TerrariumRules.NATIVE_LABEL_YIELD_BACKING_OPACITY] so the body shows
 *    through, and an idle tag's text dims too.
 *
 * Pure geometry in screen pixels, so the rule is unit-testable off-device.
 */
internal data class LabelBox(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    fun intersects(other: LabelBox): Boolean =
        left < other.right && other.left < right && top < other.bottom && other.top < bottom
}

internal enum class ResidentLabelMode { FULL, COMPACT, HIDDEN }

internal data class ResidentLabelInput(
    val id: String,
    /** 0 focused, 1 awaiting, 2 working, 3 idle. */
    val rank: Int,
    /** Screen-space body silhouette bounds. */
    val body: LabelBox,
    val fullTag: LabelBox,
    val compactTag: LabelBox,
)

internal data class ResidentLabelDecision(
    val id: String,
    val mode: ResidentLabelMode,
    val backingAlpha: Float,
    val textAlpha: Float,
)

internal const val LABEL_RANK_FOCUSED = 0
internal const val LABEL_RANK_AWAITING = 1
internal const val LABEL_RANK_WORKING = 2
internal const val LABEL_RANK_IDLE = 3

/** Returns decisions in DRAW order: lowest priority first, so priority paints on top. */
internal fun resolveResidentLabels(inputs: List<ResidentLabelInput>): List<ResidentLabelDecision> {
    val dense = inputs.size >= TerrariumRules.NATIVE_LABEL_DENSE_RESIDENT_COUNT
    // Nearer residents (lower on screen) claim space first within a rank.
    val ordered = inputs.sortedWith(compareBy<ResidentLabelInput> { it.rank }.thenByDescending { it.body.bottom }.thenBy { it.id })
    val placed = mutableListOf<LabelBox>()
    val decisions = ordered.map { input ->
        val idle = input.rank == LABEL_RANK_IDLE
        val compact = dense && idle
        val box = if (compact) input.compactTag else input.fullTag
        val collides = placed.any { it.intersects(box) }
        if (collides && idle) {
            return@map ResidentLabelDecision(input.id, ResidentLabelMode.HIDDEN, 0f, 0f)
        }
        placed += box
        val overBody = inputs.any { it.id != input.id && it.body.intersects(box) }
        val yielding = collides || overBody
        val backing = when {
            yielding -> TerrariumRules.NATIVE_LABEL_YIELD_BACKING_OPACITY
            compact -> TerrariumRules.NATIVE_LABEL_COMPACT_BACKING_OPACITY
            else -> TerrariumRules.NATIVE_LABEL_BACKING_OPACITY
        }
        val text = when {
            !idle -> 1f
            yielding -> TerrariumRules.NATIVE_LABEL_YIELD_TEXT_OPACITY
            else -> TerrariumRules.NATIVE_LABEL_IDLE_TEXT_OPACITY
        }
        ResidentLabelDecision(input.id, if (compact) ResidentLabelMode.COMPACT else ResidentLabelMode.FULL, backing, text)
    }
    return decisions.asReversed()
}
