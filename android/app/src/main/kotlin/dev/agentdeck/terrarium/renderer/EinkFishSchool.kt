package dev.agentdeck.terrarium.renderer

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

internal const val EINK_FISH_COUNT = 12
internal const val EINK_FISH_PER_SCHOOL = 6

/** A side-on fish: yaw foreshortens its silhouette, never rotates it upside down. */
class EinkFish {
    var x = 0f
        internal set
    var y = 0f
        internal set
    var facing = 1f
        internal set
    var pitch = 0f
        internal set
    var tailBeat = 0f
        internal set
    var depth = 1f
        internal set
}

/**
 * Choreographed, continuous swimming for low-refresh displays.
 *
 * Two loose shoals follow a broad horizontal circuit, offset by half a lap.
 * Fish retain their longitudinal spacing and depth lanes. There are no competing
 * attraction/separation forces, zero-speed heading flips, or screen-plane spins.
 * States ease the pace of the same path; they never replace fish coordinates.
 */
class EinkFishSchool {
    val fish = List(EINK_FISH_COUNT) { EinkFish() }
    private var phase = 0.72
    private var tailPhase = 0.0
    private var pace = 1.0
    private var remainder = 0.0
    private val trailingOffsets = doubleArrayOf(0.0, 0.09, 0.26, 0.39, 0.54, 0.67)
    private val depthLanes = doubleArrayOf(-0.025, 0.029, -0.013, 0.038, -0.035, 0.007)

    init { project() }

    /** stepScale is elapsed time in 400ms units, independent of display cadence. */
    fun update(streaming: Boolean, stepScale: Float = 1f, hovering: Boolean = false) {
        if (!stepScale.isFinite()) return
        remainder += stepScale.coerceIn(0f, 1.5f).toDouble()
        val targetPace = when {
            hovering -> 0.55
            streaming -> 1.15
            else -> 1.0
        }
        // 3.125ms integration is invisible at both 100ms and 400ms display cadence.
        // Double phase and bounded angles also avoid long-running float drift.
        while (remainder >= 0.0078125) {
            // Keep the ~1.4s speed response independent of integration frequency.
            pace += (targetPace - pace) * 0.002267919
            phase = (phase + 0.040 * pace * 0.0078125) % (2 * PI)
            tailPhase = (tailPhase + 1.30 * pace * 0.0078125) % (2 * PI)
            remainder -= 0.0078125
        }
        project()
    }

    private fun project() {
        fish.forEachIndexed { i, f ->
            val local = i % EINK_FISH_PER_SCHOOL
            val lane = if (local % 2 == 0) -1.0 else 1.0
            val angle = phase + (i / EINK_FISH_PER_SCHOOL) * PI - trailingOffsets[local]
            val depth = sin(angle)
            // A broad oval leaves the substrate and agent name tags undisturbed.
            f.x = (0.50 + 0.34 * cos(angle)).toFloat()
            f.y = (0.36 + 0.105 * depth + depthLanes[local] +
                0.006 * sin(angle * 2 + local * 0.7)).toFloat()
            f.facing = (-sin(angle)).toFloat()
            // Turning is yaw into the water, with only a subtle vertical incline.
            f.pitch = (-cos(angle) * sin(angle) * 9).toFloat()
            f.tailBeat = sin(tailPhase - local * 0.65).toFloat()
            f.depth = (0.86 + 0.10 * depth + lane * 0.035).toFloat()
        }
    }
}
