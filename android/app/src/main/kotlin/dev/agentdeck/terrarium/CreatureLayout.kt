package dev.agentdeck.terrarium

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

/**
 * Layout slot for positioning a creature in the terrarium.
 */
data class CreatureSlot(
    val centerXFraction: Float,
    val centerYFraction: Float,
    val scaleFactor: Float,
)

/**
 * Compute layout positions for multiple octopuses (coding agents).
 * Distributes them across the left-center area of the terrarium.
 */
fun layoutOctopuses(count: Int): List<CreatureSlot> {
    return layoutBand(
        count = count,
        xMin = 0.20f,
        xMax = 0.50f,
        frontY = 0.42f,
        backY = 0.52f,
        singleRowLimit = 4,
        baseScale = 1.0f,
        minScale = 0.58f,
        creatureWidth = 0.11f,
    )
}

/**
 * Agent info for project-based clustering layout.
 */
data class AgentLayoutInfo(
    val sessionId: String,
    val projectName: String?,
)

/**
 * Compute layout positions grouped by project name.
 * Same-project agents cluster together; groups are spaced apart.
 */
fun layoutOctopusesByProject(agents: List<AgentLayoutInfo>): List<CreatureSlot> {
    return layoutOctopuses(agents.size)
}

/**
 * Compute layout positions for cloud creatures (Codex CLI agents).
 * Clouds float in the upper-center area, above octopuses.
 */
fun layoutCloudCreatures(count: Int): List<CreatureSlot> {
    return layoutBand(
        count = count,
        xMin = 0.30f,
        xMax = 0.55f,
        frontY = 0.16f,
        backY = 0.28f,
        singleRowLimit = 3,
        baseScale = 0.98f,
        minScale = 0.56f,
        creatureWidth = 0.080f,
    )
}

/**
 * Compute layout positions for OpenCode creatures.
 * Similar to cloud creatures but positioned in the mid-center area.
 */
fun layoutOpenCodeCreatures(count: Int): List<CreatureSlot> {
    return layoutBand(
        count = count,
        xMin = 0.45f,
        xMax = 0.68f,
        frontY = 0.34f,
        backY = 0.46f,
        singleRowLimit = 3,
        baseScale = 0.96f,
        minScale = 0.56f,
        creatureWidth = 0.078f,
    )
}

/**
 * Compute layout positions for Antigravity peak/arc creatures.
 * Positioned in the upper-right band, distinct from octopus/cloud/opencode zones.
 */
fun layoutAntigravityCreatures(count: Int): List<CreatureSlot> {
    return layoutBand(
        count = count,
        xMin = 0.58f,
        xMax = 0.82f,
        frontY = 0.22f,
        backY = 0.34f,
        singleRowLimit = 3,
        baseScale = 0.96f,
        minScale = 0.56f,
        creatureWidth = 0.096f,
    )
}

/** Kiro ghosts — top-left band, INSIDE the visible tank. Above the octopuses
 * and left of the Codex clouds (0.30+). The x floor is 0.21, not the tank edge:
 * the session-list HUD covers roughly the left 0.19, and a band starting at
 * 0.08 put the ghosts behind it. The right side is the upstream HUD plus the
 * Antigravity strip and crayfish floor. */
fun layoutKiroCreatures(count: Int): List<CreatureSlot> {
    return layoutBand(
        count = count,
        xMin = 0.21f,
        xMax = 0.32f,
        frontY = 0.10f,
        backY = 0.20f,
        singleRowLimit = 3,
        baseScale = 0.96f,
        minScale = 0.56f,
        creatureWidth = 0.086f,
    )
}

/**
 * Hard floor for the crowd-driven shrink. Below the per-band [minScale] so
 * tightly packed bands can still shrink enough to honor the overlap cap before
 * we give up and accept brief overlap.
 */
private const val CROWDED_MIN_SCALE = 0.40f

/**
 * Max fraction of a creature's width that two neighbors may overlap. 0.5 →
 * centers stay at least half a body-width apart (≤50% overlap).
 */
private const val MAX_OVERLAP_FRACTION = 0.5f

private fun layoutBand(
    count: Int,
    xMin: Float,
    xMax: Float,
    frontY: Float,
    backY: Float,
    singleRowLimit: Int,
    baseScale: Float,
    minScale: Float,
    creatureWidth: Float,
): List<CreatureSlot> {
    if (count <= 0) return emptyList()

    val rows = when {
        count <= singleRowLimit -> 1
        count <= singleRowLimit * 2 -> 2
        else -> 3
    }

    val scale = max(minScale, baseScale - (count - 1) * 0.055f)
    val rowCounts = distribute(count, rows)
    val slots = mutableListOf<CreatureSlot>()
    var absoluteIndex = 0

    for (row in 0 until rows) {
        val rowCount = rowCounts[row]
        if (rowCount <= 0) continue

        val rowT = if (rows == 1) 0f else row.toFloat() / (rows - 1).toFloat()
        val rowY = frontY + (backY - frontY) * rowT
        val rowInset = 0.015f + row * 0.02f
        val rowMinX = xMin + rowInset
        val rowMaxX = xMax - rowInset
        // Alternating jitter magnitude — constant within a row.
        val spread = max(0.003f, minOf(0.012f, (rowMaxX - rowMinX) / (rowCount * 5).coerceAtLeast(1)))

        // Overlap cap: keep neighbor center-spacing ≥ MAX_OVERLAP_FRACTION of
        // the on-screen body width so creatures never overlap by more than
        // ~half. When the band is too tight to honor that at the count-based
        // scale, shrink every creature in the row by the same ratio (down to
        // CROWDED_MIN_SCALE) instead of letting them pile up.
        var rowScale = max(minScale, scale - row * 0.04f)
        if (rowCount >= 2) {
            // Worst-case gap after the alternating jitter squeezes a pair.
            val spacing = (rowMaxX - rowMinX) / (rowCount - 1).toFloat() - 2 * spread
            val overlapCapScale = max(0f, spacing) / (MAX_OVERLAP_FRACTION * creatureWidth)
            rowScale = max(CROWDED_MIN_SCALE, minOf(rowScale, overlapCapScale))
        }

        for (col in 0 until rowCount) {
            val t = if (rowCount == 1) 0.5f else col.toFloat() / (rowCount - 1).toFloat()
            val baseX = rowMinX + (rowMaxX - rowMinX) * t
            val phase = if ((absoluteIndex + row) % 2 == 0) -1f else 1f
            val x = (baseX + spread * phase).coerceIn(xMin, xMax)
            val yJitter = ((absoluteIndex % 3) - 1) * 0.008f
            slots += CreatureSlot(x, rowY + yJitter, rowScale)
            absoluteIndex += 1
        }
    }

    return slots
}

private fun distribute(count: Int, rows: Int): IntArray {
    val result = IntArray(rows) { count / rows }
    repeat(count % rows) { index -> result[index] += 1 }
    return result
}

/**
 * Compute layout positions for OpenClaw worker crayfish.
 * Workers are smaller and arranged in an arc around the main crayfish position.
 */
fun layoutWorkerCrayfish(
    count: Int,
    mainX: Float = TerrariumLayout.CRAYFISH_CENTER_X_FRACTION,
    mainY: Float = TerrariumLayout.CRAYFISH_CENTER_Y_FRACTION,
): List<CreatureSlot> {
    if (count == 0) return emptyList()

    val arcRadius = 0.08f

    return (0 until count).map { i ->
        val angle = PI.toFloat() * 0.8f + (i.toFloat() / max(1, count - 1).toFloat()) * PI.toFloat() * 0.4f
        CreatureSlot(
            mainX + cos(angle) * arcRadius,
            mainY + sin(angle) * arcRadius,
            0.5f,
        )
    }
}

/**
 * Per-entry slots for the vector-mark creature list, which holds OpenCode rings
 * and Kiro ghosts together (they share a class, not a band). Each entry is
 * placed from ITS OWN band so the two platforms agree on where a session is
 * drawn — the layout mirrors are only a single source of truth if both sides
 * ask the same function for the same agent.
 */
/** Single spelling of "is this a Kiro session", shared by the layout split
 * and the state builder. Two copies of this predicate is how one surface
 * ends up placing a ghost in a band the other does not. */
internal fun isKiroAgentType(type: String?): Boolean =
    type == "kiro-cli" || type == "kiro-ide"

internal fun vectorMarkSlots(creatures: List<AgentCreatureState>): List<CreatureSlot> {
    val kiroCount = creatures.count { isKiroAgentType(it.agentType) }
    val openCodeSlots = layoutOpenCodeCreatures(creatures.size - kiroCount)
    val kiroSlots = layoutKiroCreatures(kiroCount)
    val fallback = CreatureSlot(0.55f, 0.40f, 1.0f)
    var openCodeIndex = 0
    var kiroIndex = 0
    return creatures.map { creature ->
        if (isKiroAgentType(creature.agentType)) {
            val slot = kiroSlots.getOrElse(kiroIndex) { kiroSlots.lastOrNull() ?: fallback }
            kiroIndex++
            slot
        } else {
            val slot = openCodeSlots.getOrElse(openCodeIndex) { openCodeSlots.lastOrNull() ?: fallback }
            openCodeIndex++
            slot
        }
    }
}
