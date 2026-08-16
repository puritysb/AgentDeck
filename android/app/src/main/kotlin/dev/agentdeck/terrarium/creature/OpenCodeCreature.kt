package dev.agentdeck.terrarium.creature

import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.vector.PathParser
import dev.agentdeck.terrarium.CreatureGeometry
import dev.agentdeck.terrarium.CreatureNameTagStyle
import dev.agentdeck.terrarium.creatureNameTagMetric
import dev.agentdeck.terrarium.resolveCreatureNameTagLayout
import dev.agentdeck.terrarium.OctopusVisualState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumLayout
import dev.agentdeck.terrarium.TerrariumTiming
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * Vector-mark creature using the canonical OpenCode or Kiro brand path.
 * No added eyes, tentacles, or limbs. Animation is limited to bob/pulse only.
 *
 * Same public API as OctopusCreature/CloudCreature for interchangeable use.
 */
class OpenCodeCreature(
    centerXFraction: Float = TerrariumLayout.OPENCODE_CENTER_X_FRACTION,
    centerYFraction: Float = TerrariumLayout.OPENCODE_CENTER_Y_FRACTION,
    private var scaleFactor: Float = 1f,
    phaseOffset: Float = 0f,
    displayName: String? = null,
    agentType: String? = "opencode",
) : Creature {

    private var visualState by mutableStateOf(OctopusVisualState.FLOATING)
    private var time by mutableFloatStateOf(phaseOffset)
    private var transitionProgress by mutableFloatStateOf(1f)
    private var nameTag: String? by mutableStateOf(displayName)
    private var showNameTag by mutableStateOf(displayName != null)
    private var renderedAgentType by mutableStateOf(agentType)

    // Swimming state
    private var homeX = centerXFraction
    private var homeY = centerYFraction
    private var currentX = centerXFraction
    private var currentY = centerYFraction
    private var targetX = centerXFraction
    private var targetY = centerYFraction
    private var waypointTimer = 0f
    private var waypointInterval = TerrariumTiming.WAYPOINT_MIN_INTERVAL +
        kotlin.random.Random.nextFloat() * (TerrariumTiming.WAYPOINT_MAX_INTERVAL - TerrariumTiming.WAYPOINT_MIN_INTERVAL)
    private val standingJitter = kotlin.random.Random.nextFloat() * 0.06f - 0.03f

    /** Callback invoked when transitioning away from ASKING (bubble pop trigger). */
    var onAskingExit: ((nx: Float, ny: Float) -> Unit)? = null

    fun setState(newState: OctopusVisualState) {
        if (newState != visualState) {
            if (visualState == OctopusVisualState.ASKING) {
                onAskingExit?.invoke(currentX, currentY)
            }
            visualState = newState
            transitionProgress = 0f
        }
    }

    fun setDisplayName(name: String?, show: Boolean = name != null) {
        nameTag = name
        showNameTag = show
    }

    fun setAgentType(type: String?) {
        renderedAgentType = type
    }

    private fun isKiro(): Boolean = renderedAgentType == "kiro-cli" || renderedAgentType == "kiro-ide"

    /** Update home position -- creature lerps naturally (no teleport). */
    fun setHomePosition(x: Float, y: Float, scale: Float) {
        homeX = x
        homeY = y
        scaleFactor = scale
    }

    /** Current live position for tetra attractor tracking. */
    fun currentPosition(): Pair<Float, Float> = currentX to currentY

    /** Whether this OpenCode is currently working (swimming, scattering data). */
    fun isWorking(): Boolean = visualState == OctopusVisualState.WORKING

    override fun update(dt: Float) {
        time += dt
        if (transitionProgress < 1f) {
            transitionProgress = (transitionProgress + dt * 3f).coerceAtMost(1f)
        }

        when (visualState) {
            OctopusVisualState.SLEEPING -> {
                val myDeepY = STANDING_Y_DEEP + standingJitter * 0.5f
                val restX = homeX.coerceAtMost(TerrariumLayout.CRAYFISH_CLEAR_MAX_X)
                currentX += (restX - currentX) * dt * 4f
                currentY += (myDeepY - currentY) * dt * 4f
            }
            OctopusVisualState.FLOATING -> {
                // homeY-relative (not the shared Octopus STANDING_Y) so idle OpenCode
                // creatures rest in their own strip instead of converging with
                // Octopus/Cloud/Antigravity onto the same standing row. Rest X stays
                // left of the crayfish floor territory — the band's right edge (0.68)
                // otherwise drops idle OpenCode onto the OpenClaw crayfish.
                val myStandingY = (homeY + 0.18f).coerceIn(0.59f, 0.63f) + standingJitter
                val restX = homeX.coerceAtMost(TerrariumLayout.CRAYFISH_CLEAR_MAX_X)
                val breathBob = sin(time * 0.5f) * 0.003f
                val idleSway = sin(time * 0.2f) * 0.003f
                currentX += (restX + idleSway - currentX) * dt * 4f
                currentY += (myStandingY + breathBob - currentY) * dt * 4f
            }
            OctopusVisualState.ASKING -> {
                val myStandingY = (homeY + 0.10f).coerceIn(0.46f, 0.52f) + standingJitter
                val fidgetX = sin(time * 0.8f) * 0.004f
                currentX += (homeX + fidgetX - currentX) * dt * 4f
                currentY += (myStandingY - currentY) * dt * 4f
            }
            OctopusVisualState.WORKING -> {
                val lane = swimLane()
                waypointTimer += dt
                if (waypointTimer >= waypointInterval) {
                    waypointTimer = 0f
                    waypointInterval = TerrariumTiming.WAYPOINT_MIN_INTERVAL +
                        kotlin.random.Random.nextFloat() * (TerrariumTiming.WAYPOINT_MAX_INTERVAL - TerrariumTiming.WAYPOINT_MIN_INTERVAL)
                    pickNewWaypoint()
                }
                val rate = TerrariumTiming.SWIM_LERP_RATE * dt
                currentX += (targetX - currentX) * rate
                currentY += (targetY - currentY) * rate
                currentX = currentX.coerceIn(lane.minX, lane.maxX)
                currentY = currentY.coerceIn(lane.minY, lane.maxY)
            }
        }
    }

    private fun pickNewWaypoint() {
        val lane = swimLane()
        val angle = kotlin.random.Random.nextFloat() * 2f * PI.toFloat()
        val radiusX = maxOf(0.06f, (lane.maxX - lane.minX) * 0.45f)
        val radiusY = maxOf(0.04f, (lane.maxY - lane.minY) * 0.40f)
        targetX = (lane.centerX + cos(angle) * radiusX).coerceIn(lane.minX, lane.maxX)
        targetY = (lane.centerY + sin(angle) * radiusY).coerceIn(lane.minY, lane.maxY)
    }

    private data class SwimLane(
        val minX: Float,
        val maxX: Float,
        val minY: Float,
        val maxY: Float,
        val centerX: Float,
        val centerY: Float,
    )

    private fun swimLane(): SwimLane {
        val halfWidth = minOf(0.14f, maxOf(0.08f, 0.07f + scaleFactor * 0.05f))
        val centerX = homeX.coerceIn(TerrariumLayout.OPENCODE_SWIM_MIN_X + 0.06f, TerrariumLayout.OPENCODE_SWIM_MAX_X - 0.06f)
        val centerY = homeY.coerceIn(WORKING_MIN_Y + 0.04f, WORKING_MAX_Y - 0.04f)
        val verticalSlack = minOf(0.08f, maxOf(0.04f, 0.04f + scaleFactor * 0.02f))
        return SwimLane(
            minX = maxOf(TerrariumLayout.OPENCODE_SWIM_MIN_X, centerX - halfWidth),
            maxX = minOf(TerrariumLayout.OPENCODE_SWIM_MAX_X, centerX + halfWidth),
            minY = maxOf(WORKING_MIN_Y, centerY - verticalSlack),
            maxY = minOf(WORKING_MAX_Y, centerY + verticalSlack),
            centerX = centerX,
            centerY = centerY,
        )
    }

    override fun draw(scope: DrawScope) {
        val w = scope.size.width
        val h = scope.size.height
        val baseWidth = minOf(w, h * 2f)

        val bodySize = baseWidth * BODY_SIZE_FRACTION * scaleFactor

        val centerX = w * currentX

        // Bob animation
        val bobOffset = when (visualState) {
            OctopusVisualState.WORKING -> sin(time * 2f * PI.toFloat() / (TerrariumTiming.FLOAT_PERIOD_MS / 1000f)) *
                h * TerrariumTiming.FLOAT_AMPLITUDE_FRACTION
            OctopusVisualState.FLOATING -> sin(time * 0.5f) * h * 0.003f
            else -> 0f
        }
        val centerY = h * currentY + bobOffset

        val bodyAlpha = when (visualState) {
            OctopusVisualState.SLEEPING -> 0.35f
            else -> 1f
        }

        // Working pulse
        val pulseScale = when (visualState) {
            OctopusVisualState.WORKING -> 1f + sin(time * TerrariumTiming.THINKING_PULSE_SPEED) * 0.03f
            else -> 1f
        }
        val scaledSize = bodySize * pulseScale

        // Draw the canonical vector mark for this agent.
        drawBrandMark(scope, centerX, centerY, scaledSize, bodyAlpha)

        // ASKING: speech bubble with "?"
        if (visualState == OctopusVisualState.ASKING) {
            drawSpeechBubble(scope, centerX, centerY, scaledSize)
        }

        // Name tag
        if (showNameTag && nameTag != null) {
            drawNameTag(scope, centerX, centerY, scaledSize, nameTag!!)
        }
    }

    /** Draw the canonical OpenCode ring or Kiro ghost. */
    private fun drawBrandMark(
        scope: DrawScope,
        cx: Float, cy: Float,
        size: Float,
        alpha: Float,
    ) {
        val kiro = isKiro()
        val baseColor = if (kiro) KIRO_PURPLE else OUTER_FRAME
        val brightColor = if (kiro) KIRO_BRIGHT else OUTER_BRIGHT
        val dimColor = if (kiro) KIRO_DIM else OUTER_DIM
        val frameColor = when (visualState) {
            OctopusVisualState.SLEEPING -> dimColor
            OctopusVisualState.WORKING -> {
                val t = sin(time * TerrariumTiming.THINKING_PULSE_SPEED) * 0.5f + 0.5f
                lerpColor(baseColor, brightColor, t)
            }
            else -> baseColor
        }

        val viewBox = if (kiro) CreatureGeometry.KIRO_VIEWBOX else CreatureGeometry.OPENCODE_VIEWBOX
        val path = if (kiro) kiroPath else openCodePath
        val pathScale = size / viewBox
        scope.withTransform({
            translate(cx - size / 2f, cy - size / 2f)
            scale(pathScale, pathScale, pivot = Offset.Zero)
        }) {
            drawPath(path, color = frameColor, alpha = alpha)
        }

        // Working state: subtle outer glow
        if (visualState == OctopusVisualState.WORKING) {
            val glowAlpha = (sin(time * 2f) * 0.15f + 0.15f) * alpha
            scope.drawRect(
                color = if (kiro) KIRO_PURPLE else GLOW_COLOR,
                alpha = glowAlpha,
                topLeft = Offset(cx - size * 0.34f - 2f, cy - size * 0.43f - 2f),
                size = Size(size * 0.68f + 4f, size * 0.86f + 4f),
                style = Stroke(width = 2f),
            )
        }
    }

    /** Speech bubble with "?" -- shown during ASKING state. */
    private fun drawSpeechBubble(scope: DrawScope, cx: Float, cy: Float, bodySize: Float) {
        val bubbleX = cx + bodySize * 0.7f
        val bubbleY = cy
        val bubbleR = bodySize * 0.3f

        val pulse = sin(time * 2.5f) * 0.08f + 1f
        val r = bubbleR * pulse

        scope.drawCircle(
            color = Color.White,
            alpha = 0.25f,
            radius = r,
            center = Offset(bubbleX, bubbleY),
        )
        scope.drawCircle(
            color = TerrariumColors.HUDText,
            alpha = 0.5f,
            radius = r,
            center = Offset(bubbleX, bubbleY),
            style = Stroke(width = bodySize * 0.02f),
        )

        val canvas = scope.drawContext.canvas.nativeCanvas
        val textSize = r * 1.2f
        canvas.drawText(
            "?", bubbleX, bubbleY + textSize * 0.35f,
            questionMarkPaint.apply { this.textSize = textSize },
        )
    }

    // Cached name tag TEXT layout — avoids per-frame measureText.
    // Position (tagBottomY) NOT cached — depends on creature's live Y.
    private var cachedNameLayout: CachedNameLayout? = null
    private data class CachedNameLayout(
        val name: String, val bodyMetric: Float,
        val lines: List<String>, val lineHeight: Float,
        val tagWidth: Float, val tagHeight: Float, val fontSize: Float,
    )

    /** Name tag above the square -- only shown in multi-session mode. */
    private fun drawNameTag(scope: DrawScope, cx: Float, cy: Float, bodySize: Float, name: String) {
        val bodyMetric = creatureNameTagMetric(scope.size.width, scaleFactor)
        val bodyTopY = cy - bodySize * 0.5f
        val tagBottomY = bodyTopY - bodyMetric * CreatureNameTagStyle.GAP_RATIO

        val cached = cachedNameLayout
        val tagWidth: Float
        val tagHeight: Float
        val chosenSize: Float
        val lines: List<String>
        val lineHeight: Float

        if (cached != null && cached.name == name && cached.bodyMetric == bodyMetric) {
            tagWidth = cached.tagWidth
            tagHeight = cached.tagHeight
            chosenSize = cached.fontSize
            lines = cached.lines
            lineHeight = cached.lineHeight
        } else {
            val layout = resolveCreatureNameTagLayout(
                name = name,
                bodyTopY = bodyTopY,
                bodyMetric = bodyMetric,
                paint = nameTagPaint,
            )
            tagWidth = layout.tagWidth
            tagHeight = layout.tagHeight
            chosenSize = layout.fontSize
            lines = layout.lines
            lineHeight = layout.lineHeight
            cachedNameLayout = CachedNameLayout(
                name = name,
                bodyMetric = bodyMetric,
                lines = lines,
                lineHeight = lineHeight,
                tagWidth = tagWidth,
                tagHeight = tagHeight,
                fontSize = chosenSize,
            )
        }

        val canvas = scope.drawContext.canvas.nativeCanvas

        // Hat background -- neutral dark gray
        scope.drawRoundRect(
            color = INNER_SQUARE,
            alpha = 0.6f,
            topLeft = Offset(cx - tagWidth / 2, tagBottomY - tagHeight),
            size = Size(tagWidth, tagHeight),
            cornerRadius = CornerRadius(4f, 4f),
        )

        nameTagPaint.textSize = chosenSize
        if (lines.size == 1) {
            canvas.drawText(
                lines[0], cx, tagBottomY - tagHeight * 0.25f,
                nameTagPaint,
            )
        } else {
            val topY = tagBottomY - tagHeight + chosenSize * 0.3f + chosenSize
            for (i in lines.indices) {
                canvas.drawText(
                    lines[i], cx, topY + i * lineHeight,
                    nameTagPaint,
                )
            }
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

    private val questionMarkPaint = Paint().apply {
        isAntiAlias = true
        color = android.graphics.Color.argb(180, 226, 232, 240)
        textAlign = Paint.Align.CENTER
        typeface = Typeface.DEFAULT_BOLD
    }

    private val nameTagPaint = Paint().apply {
        isAntiAlias = true
        color = android.graphics.Color.argb(220, 226, 232, 240)
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create("sans-serif", Typeface.NORMAL)
    }

    companion object {
        private val openCodePath = PathParser().parsePathString(CreatureGeometry.OPENCODE_PATH_DATA).toPath().apply {
            fillType = PathFillType.EvenOdd
        }
        private val kiroPath = PathParser().parsePathString(CreatureGeometry.KIRO_PATH_DATA).toPath().apply {
            fillType = PathFillType.EvenOdd
        }
        // Body size as fraction of canvas width
        private const val BODY_SIZE_FRACTION = 0.064f

        // Positions
        private const val STANDING_Y_DEEP = 0.75f
        private const val WORKING_CENTER_Y = 0.35f
        private const val WORKING_MIN_Y = 0.25f
        private const val WORKING_MAX_Y = 0.50f

        // Colors from opencode-logo-dark.svg
        private val OUTER_FRAME = Color(0xFFF1ECEC)   // light warm gray outer
        private val INNER_SQUARE = Color(0xFF4B4646)   // dark brown-gray inner
        private val OUTER_BRIGHT = Color(0xFFFFF5F5)   // working pulse bright
        private val OUTER_DIM = Color(0xFF8A8585)       // sleeping outer
        private val INNER_DIM = Color(0xFF353232)        // sleeping inner
        private val GLOW_COLOR = Color(0xFFF1ECEC)       // working border glow
        private val KIRO_PURPLE = Color(0xFF7C3AED)
        private val KIRO_BRIGHT = Color(0xFFA78BFA)
        private val KIRO_DIM = Color(0xFF6D5A8A)
    }
}
