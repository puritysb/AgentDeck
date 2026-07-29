package dev.agentdeck.terrarium.renderer

import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumState
import dev.agentdeck.terrarium.EnvironmentVisualState
import dev.agentdeck.terrarium.creature.BubbleSystem
import dev.agentdeck.terrarium.creature.CrayfishCreature
import dev.agentdeck.terrarium.creature.CloudCreature
import dev.agentdeck.terrarium.creature.OpenCodeCreature
import dev.agentdeck.terrarium.creature.AntigravityCreature
import dev.agentdeck.terrarium.creature.OctopusCreature
import dev.agentdeck.terrarium.creature.DataParticleSystem
import dev.agentdeck.terrarium.environment.KelpField
import dev.agentdeck.terrarium.environment.LightRaySystem
import dev.agentdeck.terrarium.environment.PlanktonSystem
import dev.agentdeck.terrarium.environment.RockFormation
import dev.agentdeck.terrarium.environment.SandDisturbance
import dev.agentdeck.terrarium.environment.WaterEffect
import dev.agentdeck.terrarium.environment.WaterSurface
import dev.agentdeck.state.SubagentVisualActivity
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * Main color terrarium renderer — composites all layers onto a Compose Canvas.
 * Creatures and environment elements manage their own animation state;
 * this renderer calls update(dt) then draw(scope) on each in layer order.
 */
@Composable
fun ColorTerrariumCanvas(
    state: TerrariumState,
    waterEffect: WaterEffect,
    rockFormation: RockFormation,
    kelpField: KelpField,
    mainCrayfish: CrayfishCreature,
    workerCrayfish: List<CrayfishCreature> = emptyList(),
    dataParticles: DataParticleSystem,
    octopuses: List<OctopusCreature>,
    cloudCreatures: List<CloudCreature> = emptyList(),
    openCodeCreatures: List<OpenCodeCreature> = emptyList(),
    antigravityCreatures: List<AntigravityCreature> = emptyList(),
    bubbleSystem: BubbleSystem,
    lightRaySystem: LightRaySystem,
    planktonSystem: PlanktonSystem,
    waterSurface: WaterSurface,
    sandDisturbance: SandDisturbance,
    drawMainCrayfish: Boolean = true,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height

        // Layer 1: Deep-sea gradient background
        drawDeepSeaBackground(w, h, state.environment)

        // Layer 2: Caustics overlay
        waterEffect.draw(this)

        // Layer 2.5: God rays (light shafts from surface)
        lightRaySystem.draw(this)

        // Layer 2.7: Back-layer plankton (behind everything)
        planktonSystem.drawBackLayer(this)

        // Layer 4: Rocks + sand (bottom)
        rockFormation.draw(this)

        // Layer 4.5: Sand disturbance particles
        sandDisturbance.draw(this)

        // Layer 5: Kelp + ground cover grass
        kelpField.draw(this)

        // Layer 6: LED cables on rocks
        rockFormation.drawLEDs(this, state.environment)

        // Layer 6.5: Back-layer fish (behind creatures for 3D depth)
        dataParticles.drawBackLayer(this)

        // Layer 7a: Worker crayfish (smaller, behind main)
        for (wc in workerCrayfish) wc.draw(this)

        // Layer 7b: Main crayfish (on rocks, bottom-right)
        if (drawMainCrayfish) {
            mainCrayfish.draw(this)
        }

        // Layer 8.8: decorative parent/child topology. These Saturn-like
        // rings and wired satellites are deliberately outside hit testing
        // and never create selectable sessions or control surfaces.
        drawSubagentOrbits(
            state = state,
            octopuses = octopuses,
            cloudCreatures = cloudCreatures,
            openCodeCreatures = openCodeCreatures,
            antigravityCreatures = antigravityCreatures,
        )

        // Layer 9: Octopuses (all coding agent avatars)
        for (oct in octopuses) oct.draw(this)

        // Layer 9.2: Cloud creatures (Codex CLI agents — float above octopuses)
        for (cloud in cloudCreatures) cloud.draw(this)

        // Layer 9.3: OpenCode creatures (geometric nested-square logo)
        for (oc in openCodeCreatures) oc.draw(this)

        // Layer 9.4: Antigravity creatures (peak/arc logo)
        for (ag in antigravityCreatures) ag.draw(this)

        // Layer 9.5: Front-layer fish (in front of creatures for 3D depth)
        dataParticles.drawFrontLayer(this)

        // Layer 9.7: Front-layer plankton (in front of creatures)
        planktonSystem.drawFrontLayer(this)

        // Layer 10: Bubbles (on top of creatures, includes creature exhales)
        bubbleSystem.draw(this)

        // Layer 10.5: Water surface line
        waterSurface.draw(this)

        // Layer 11: Error tint overlay
        if (state.hasError) {
            drawRect(
                color = TerrariumColors.ErrorTint,
                size = Size(w, h),
            )
        }
    }
}

// Pre-computed background colors — avoids per-frame Color.copy() allocations
private val BG_DARK_TOP = TerrariumColors.DeepSea.copy(alpha = 0.5f)
private val BG_ACTIVE_TOP = TerrariumColors.ShallowWater.copy(alpha = 0.9f)
private val BG_ALERT_TOP = Color(0xFF1A3D5C)
private val SUBAGENT_ORBIT_COLOR = TerrariumColors.TetraNeon
private val SUBAGENT_ORBIT_DASH = PathEffect.dashPathEffect(floatArrayOf(7f, 8f))
private val SUBAGENT_COUNT_PAINT = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = android.graphics.Color.WHITE
    typeface = android.graphics.Typeface.DEFAULT_BOLD
}

private fun DrawScope.drawSubagentOrbits(
    state: TerrariumState,
    octopuses: List<OctopusCreature>,
    cloudCreatures: List<CloudCreature>,
    openCodeCreatures: List<OpenCodeCreature>,
    antigravityCreatures: List<AntigravityCreature>,
) {
    for (index in octopuses.indices) {
        val visual = state.agents.getOrNull(index) ?: continue
        val pos = octopuses[index].currentPosition()
        drawSubagentOrbit(pos.first, pos.second, visual.subagentActivity)
    }
    for (index in cloudCreatures.indices) {
        val visual = state.cloudCreatures.getOrNull(index) ?: continue
        val pos = cloudCreatures[index].currentPosition()
        drawSubagentOrbit(pos.first, pos.second, visual.subagentActivity)
    }
    for (index in openCodeCreatures.indices) {
        val visual = state.openCodeCreatures.getOrNull(index) ?: continue
        val pos = openCodeCreatures[index].currentPosition()
        drawSubagentOrbit(pos.first, pos.second, visual.subagentActivity)
    }
    for (index in antigravityCreatures.indices) {
        val visual = state.antigravityCreatures.getOrNull(index) ?: continue
        val pos = antigravityCreatures[index].currentPosition()
        drawSubagentOrbit(pos.first, pos.second, visual.subagentActivity)
    }
}

private fun DrawScope.drawSubagentOrbit(
    xFraction: Float,
    yFraction: Float,
    activity: SubagentVisualActivity,
) {
    val now = System.currentTimeMillis()
    val completionAge = activity.lastCompletedAt?.let { now - it }
    val completionProgress = completionAge
        ?.takeIf { it in 0 until 4_000 }
        ?.div(4_000f)
    if (activity.activeCount <= 0 && completionProgress == null) return

    val center = Offset(xFraction * size.width, yFraction * size.height)
    val minDim = min(size.width, size.height)
    val radiusX = minDim * 0.115f
    val radiusY = radiusX * 0.38f
    val tilt = -0.28f

    fun orbitPoint(angle: Float, radiusMultiplier: Float = 1f): Offset {
        val localX = cos(angle) * radiusX * radiusMultiplier
        val localY = sin(angle) * radiusY * radiusMultiplier
        return Offset(
            x = center.x + localX * cos(tilt) - localY * sin(tilt),
            y = center.y + localX * sin(tilt) + localY * cos(tilt),
        )
    }

    if (activity.activeCount > 0) {
        val ring = Path()
        for (step in 0..48) {
            val p = orbitPoint(step / 48f * (PI.toFloat() * 2f))
            if (step == 0) ring.moveTo(p.x, p.y) else ring.lineTo(p.x, p.y)
        }
        drawPath(
            path = ring,
            color = SUBAGENT_ORBIT_COLOR.copy(alpha = 0.48f),
            style = Stroke(
                width = maxOf(1f, minDim * 0.0014f),
                pathEffect = SUBAGENT_ORBIT_DASH,
            ),
        )

        val visibleCount = min(activity.activeCount, 3)
        val phase = (now / 1_000f) * 0.72f
        for (index in 0 until visibleCount) {
            val angle = phase + index * (PI.toFloat() * 2f / visibleCount)
            val satellite = orbitPoint(angle)
            drawLine(
                color = SUBAGENT_ORBIT_COLOR.copy(alpha = 0.18f),
                start = center,
                end = satellite,
                strokeWidth = maxOf(1f, minDim * 0.001f),
            )
            val nodeRadius = if (index == 2 && activity.activeCount > 3) {
                minDim * 0.008f
            } else {
                minDim * 0.006f
            }
            drawCircle(
                color = SUBAGENT_ORBIT_COLOR.copy(alpha = 0.94f),
                radius = maxOf(3f, nodeRadius),
                center = satellite,
            )

            if (index == 2 && activity.activeCount > 3) {
                SUBAGENT_COUNT_PAINT.textSize = maxOf(10f, minDim * 0.022f)
                drawContext.canvas.nativeCanvas.drawText(
                    "+${activity.activeCount - 3}",
                    satellite.x + minDim * 0.016f,
                    satellite.y - minDim * 0.012f,
                    SUBAGENT_COUNT_PAINT,
                )
            }
        }
    }

    if (completionProgress != null) {
        val radius = radiusX * (0.72f + completionProgress * 0.58f)
        drawCircle(
            color = SUBAGENT_ORBIT_COLOR.copy(alpha = (1f - completionProgress) * 0.72f),
            radius = radius,
            center = center,
            style = Stroke(width = maxOf(1.5f, minDim * 0.002f)),
        )
    }
}

/** Gradient background — shifts with environment state. */
private fun DrawScope.drawDeepSeaBackground(w: Float, h: Float, env: EnvironmentVisualState) {
    val topColor = when (env) {
        EnvironmentVisualState.DARK -> BG_DARK_TOP
        EnvironmentVisualState.CALM -> TerrariumColors.ShallowWater
        EnvironmentVisualState.ACTIVE -> BG_ACTIVE_TOP
        EnvironmentVisualState.ALERT -> BG_ALERT_TOP
    }
    val bottomColor = TerrariumColors.DeepSea

    drawRect(
        brush = Brush.verticalGradient(
            colors = listOf(topColor, TerrariumColors.MidWater, bottomColor),
            startY = 0f,
            endY = h,
        ),
        size = Size(w, h),
    )
}
