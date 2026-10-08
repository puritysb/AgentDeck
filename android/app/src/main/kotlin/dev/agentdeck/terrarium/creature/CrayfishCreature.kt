package dev.agentdeck.terrarium.creature

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import dev.agentdeck.terrarium.CrayfishVisualState
import dev.agentdeck.terrarium.CreatureGeometry
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumLayout
import dev.agentdeck.terrarium.TerrariumTiming
import dev.agentdeck.terrarium.normalizeSvgArcFlags
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * OpenClaw — exact design/brand/openclaw.svg silhouette with state motion and
 * shell gradient. Animation moves the whole mark without redrawing its anatomy.
 *
 * SITTING/DORMANT: completely still on the rocks (no floating).
 * ROUTING: full animation — claw rotation, signal waves, eye flash, antenna wiggle.
 */
class CrayfishCreature(
    private val centerXFraction: Float = TerrariumLayout.CRAYFISH_CENTER_X_FRACTION,
    private val centerYFraction: Float = TerrariumLayout.CRAYFISH_CENTER_Y_FRACTION,
    private val scaleFactor: Float = 1f,
) : Creature {

    private var visualState by mutableStateOf(CrayfishVisualState.SITTING)
    private var time by mutableFloatStateOf(0f)
    private var transitionProgress by mutableFloatStateOf(1f)

    private val bodyPaths by lazy {
        CreatureGeometry.OPENCLAW_BODY_PATHS.map { parseSvgPath(it).apply { fillType = PathFillType.EvenOdd } }
    }

    fun setState(newState: CrayfishVisualState) {
        if (newState != visualState) {
            visualState = newState
            transitionProgress = 0f
        }
    }

    /** Current center position in fraction coords (for DataParticleSystem targeting). */
    fun currentPosition(): Pair<Float, Float> = currentXFraction to currentYFraction

    /** Whether the crayfish is actively routing (orchestrating). */
    fun isRouting(): Boolean = visualState == CrayfishVisualState.ROUTING

    private var currentXFraction = centerXFraction
    private var currentYFraction = centerYFraction
    private var heartbeatPhase = 0f

    override fun update(dt: Float) {
        time += dt
        if (transitionProgress < 1f) {
            transitionProgress = (transitionProgress + dt * 2f).coerceAtMost(1f)
        }
        // Track heartbeat phase for SITTING pulse (~4 second cycle)
        heartbeatPhase += dt
    }

    override fun draw(scope: DrawScope) {
        val w = scope.size.width
        val h = scope.size.height
        val baseWidth = minOf(w, h * 2f)

        val cx = w * centerXFraction
        val cy = h * centerYFraction
        val bodyWidth = baseWidth * TerrariumLayout.CRAYFISH_WIDTH_FRACTION * scaleFactor

        val alpha = when (visualState) {
            CrayfishVisualState.DORMANT -> 0.4f
            CrayfishVisualState.SICK -> 0.7f
            else -> 1f
        }

        val effectiveCX: Float
        val effectiveCY: Float
        when (visualState) {
            CrayfishVisualState.DORMANT -> {
                effectiveCX = cx
                effectiveCY = cy + bodyWidth * 0.3f
            }
            CrayfishVisualState.ROUTING -> {
                effectiveCX = cx
                effectiveCY = cy + sin(time * 3f) * bodyWidth * 0.05f
            }
            CrayfishVisualState.SITTING -> {
                effectiveCX = cx
                effectiveCY = cy + sin(time * 0.5f) * bodyWidth * 0.008f
            }
            CrayfishVisualState.SICK -> {
                // Slow labored breathing — droops slightly lower
                effectiveCX = cx
                effectiveCY = cy + bodyWidth * 0.08f + sin(time * 0.7f) * bodyWidth * 0.02f
            }
            else -> {
                effectiveCX = cx
                effectiveCY = cy
            }
        }

        // Track current position for DataParticleSystem targeting
        currentXFraction = effectiveCX / w
        currentYFraction = effectiveCY / h

        // ROUTING: draw signal waves BEHIND creature
        if (visualState == CrayfishVisualState.ROUTING) {
            drawSignalWaves(scope, effectiveCX, effectiveCY, bodyWidth, baseWidth)
        }

        // ROUTING: shell glow pulse underneath
        if (visualState == CrayfishVisualState.ROUTING) {
            val glowPulse = (sin(time * 4f) * 0.5f + 0.5f)
            val glowRadius = bodyWidth * (0.4f + glowPulse * 0.15f)
            scope.drawCircle(
                color = TerrariumColors.CrayfishEye.copy(alpha = 0.15f * glowPulse),
                radius = glowRadius,
                center = Offset(effectiveCX, effectiveCY),
            )
        }

        // SITTING: subtle heartbeat glow every ~4 seconds
        if (visualState == CrayfishVisualState.SITTING) {
            val cycle = heartbeatPhase % 4f
            // Double-pulse heartbeat: two quick pulses then rest
            val pulse = if (cycle < 0.15f) sin(cycle / 0.15f * PI.toFloat())
                else if (cycle in 0.25f..0.40f) sin((cycle - 0.25f) / 0.15f * PI.toFloat()) * 0.6f
                else 0f
            if (pulse > 0.01f) {
                val glowRadius = bodyWidth * (0.25f + pulse * 0.08f)
                scope.drawCircle(
                    color = TerrariumColors.CrayfishEye.copy(alpha = 0.08f * pulse),
                    radius = glowRadius,
                    center = Offset(effectiveCX, effectiveCY),
                )
            }
        }

        // Draw SVG-based creature
        drawSvgCreature(scope, effectiveCX, effectiveCY, bodyWidth, alpha)
    }

    private fun drawSvgCreature(
        scope: DrawScope,
        cx: Float, cy: Float,
        bodyWidth: Float,
        alpha: Float,
    ) {
        val scale = bodyWidth / CreatureGeometry.OPENCLAW_VIEWBOX
        val offsetX = cx - CreatureGeometry.OPENCLAW_VIEWBOX / 2f * scale
        val offsetY = cy - CreatureGeometry.OPENCLAW_VIEWBOX / 2f * scale

        val brush = bodyBrush()

        val sickTilt = if (visualState == CrayfishVisualState.SICK) -12f else 0f

        scope.withTransform({
            translate(left = offsetX, top = offsetY)
            scale(scaleX = scale, scaleY = scale, pivot = Offset.Zero)
            if (sickTilt != 0f) {
                rotate(sickTilt, pivot = Offset(CreatureGeometry.OPENCLAW_VIEWBOX / 2f, CreatureGeometry.OPENCLAW_VIEWBOX / 2f))
            }
        }) {
            for (path in bodyPaths) drawPath(path, brush = brush, alpha = alpha)
            dev.agentdeck.terrarium.CreatureBrandFeatures.draw(this, "openclaw")
        }
    }

    private fun bodyBrush(): Brush {
        return when (visualState) {
            CrayfishVisualState.ROUTING -> {
                val pulse = (sin(time * 4f) * 0.5f + 0.5f) * 0.3f
                val startColor = lerpColor(TerrariumColors.CrayfishShell, TerrariumColors.CrayfishBodyLight, pulse)
                val endColor = lerpColor(TerrariumColors.CrayfishDark, TerrariumColors.CrayfishShell, pulse)
                Brush.linearGradient(
                    colors = listOf(startColor, endColor),
                    start = Offset(0f, 0f),
                    end = Offset(CreatureGeometry.OPENCLAW_VIEWBOX, CreatureGeometry.OPENCLAW_VIEWBOX),
                )
            }
            CrayfishVisualState.SICK -> {
                // Desaturated — gray-pinkish tint
                val sickStart = lerpColor(TerrariumColors.CrayfishShell, Color(0xFF8B7B7B), 0.55f)
                val sickEnd = lerpColor(TerrariumColors.CrayfishDark, Color(0xFF5A4A4A), 0.55f)
                Brush.linearGradient(
                    colors = listOf(sickStart, sickEnd),
                    start = Offset(0f, 0f),
                    end = Offset(CreatureGeometry.OPENCLAW_VIEWBOX, CreatureGeometry.OPENCLAW_VIEWBOX),
                )
            }
            else -> {
                Brush.linearGradient(
                    colors = listOf(TerrariumColors.CrayfishShell, TerrariumColors.CrayfishDark),
                    start = Offset(0f, 0f),
                    end = Offset(CreatureGeometry.OPENCLAW_VIEWBOX, CreatureGeometry.OPENCLAW_VIEWBOX),
                )
            }
        }
    }

    private fun shellColorForState(): Color {
        return when (visualState) {
            CrayfishVisualState.ROUTING -> {
                val pulse = (sin(time * 4f) * 0.5f + 0.5f) * 0.3f
                lerpColor(TerrariumColors.CrayfishShell, TerrariumColors.CrayfishBodyLight, pulse)
            }
            CrayfishVisualState.SICK -> lerpColor(TerrariumColors.CrayfishShell, Color(0xFF8B7B7B), 0.55f)
            else -> TerrariumColors.CrayfishShell
        }
    }

    private fun clawAngleForState(side: Float): Float {
        return when (visualState) {
            CrayfishVisualState.ROUTING -> {
                val phase = time * 2f * PI.toFloat() / (TerrariumTiming.CLAW_CLAP_PERIOD_MS / 1000f)
                val clap = sin(phase + side * 0.3f)
                side * clap * 28f
            }
            CrayfishVisualState.SITTING -> {
                side * sin(time * 0.4f) * 1.5f
            }
            CrayfishVisualState.WAITING -> side * 15f
            CrayfishVisualState.OBSERVING -> side * (3f + sin(time * 2f) * 5f)
            CrayfishVisualState.SICK -> side * (-8f + sin(time * 0.5f) * 2f)  // claws droop
            else -> 0f
        }
    }

    private fun drawSignalWaves(scope: DrawScope, cx: Float, cy: Float, bodyWidth: Float, canvasWidth: Float) {
        val waveSpeed = time * 2f
        val maxRadius = canvasWidth * 0.15f

        for (i in 0 until 4) {
            val progress = ((waveSpeed + i * 0.25f) % 1f)
            val radius = bodyWidth * 0.3f + progress * maxRadius
            val waveAlpha = (1f - progress) * 0.35f

            scope.drawArc(
                color = TerrariumColors.CrayfishEye.copy(alpha = waveAlpha),
                startAngle = 120f,
                sweepAngle = 120f,
                useCenter = false,
                topLeft = Offset(cx - radius, cy - radius),
                size = Size(radius * 2, radius * 2),
                style = Stroke(width = 3f + (1f - progress) * 2f),
            )
        }

        for (i in 0 until 6) {
            val dotProgress = ((time * 3f + i * 0.16f) % 1f)
            val dotRadius = bodyWidth * 0.3f + dotProgress * maxRadius
            val dotAngle = (150f + dotProgress * 40f) * PI.toFloat() / 180f
            val dotX = cx + cos(dotAngle) * dotRadius
            val dotY = cy + sin(dotAngle) * dotRadius
            val dotAlpha = (1f - dotProgress) * 0.6f

            scope.drawCircle(
                color = TerrariumColors.TetraNeon.copy(alpha = dotAlpha),
                radius = bodyWidth * 0.015f,
                center = Offset(dotX, dotY),
            )
        }
    }

    private fun lerpColor(a: Color, b: Color, t: Float): Color {
        return Color(
            red = a.red + (b.red - a.red) * t,
            green = a.green + (b.green - a.green) * t,
            blue = a.blue + (b.blue - a.blue) * t,
            alpha = a.alpha + (b.alpha - a.alpha) * t,
        )
    }

    private fun parseSvgPath(data: String): Path {
        return PathParser().parsePathString(normalizeSvgArcFlags(data)).toPath()
    }

    companion object {
    }
}
