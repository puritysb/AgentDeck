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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.vector.PathParser
import dev.agentdeck.terrarium.CreatureGeometry
import dev.agentdeck.terrarium.CreatureNameTagStyle
import dev.agentdeck.terrarium.creatureNameTagMetric
import dev.agentdeck.terrarium.resolveCreatureNameTagLayout
import dev.agentdeck.terrarium.labelRankOf
import dev.agentdeck.terrarium.CreatureNameTagRequest
import dev.agentdeck.terrarium.submitCreatureNameTag
import dev.agentdeck.terrarium.OctopusVisualState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumLayout
import dev.agentdeck.terrarium.TerrariumTiming
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * Antigravity peak/arc creature — geometric brand mark, NOT biomorphic.
 * Renders the canonical Antigravity "double-peak / mountain arc" silhouette
 * (CreatureGeometry.ANTIGRAVITY_PATH_DATA, viewBox 0 0 24 24) filled with the
 * reference rainbow gradient. The creature IS the logo, so it carries no watermark.
 *
 * WORKING state shows a rising-spark shimmer above the peaks (anti-gravity nod).
 * Same public API as OctopusCreature/CloudCreature/OpenCodeCreature for
 * interchangeable use.
 */
class AntigravityCreature(
    centerXFraction: Float = TerrariumLayout.OCTOPUS_CENTER_X_FRACTION,
    centerYFraction: Float = TerrariumLayout.OCTOPUS_CENTER_Y_FRACTION,
    private var scaleFactor: Float = 1f,
    phaseOffset: Float = 0f,
    displayName: String? = null,
) : Creature {

    private var visualState by mutableStateOf(OctopusVisualState.FLOATING)
    private var time by mutableFloatStateOf(phaseOffset)
    private var transitionProgress by mutableFloatStateOf(1f)
    private var nameTag: String? by mutableStateOf(displayName)
    private var showNameTag by mutableStateOf(displayName != null)

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
            if (newState == OctopusVisualState.WORKING) {
                waypointTimer = 0f
                waypointInterval = WORKING_FIRST_WAYPOINT_INTERVAL
                pickNewWaypoint()
            }
        }
    }

    fun setDisplayName(name: String?, show: Boolean = name != null) {
        nameTag = name
        showNameTag = show
    }

    /** Update home position — creature lerps naturally (no teleport). */
    fun setHomePosition(x: Float, y: Float, scale: Float) {
        homeX = x
        homeY = y
        scaleFactor = scale
    }

    /** Current live position for tetra attractor tracking. */
    fun currentPosition(): Pair<Float, Float> = currentX to currentY

    /** Whether this Antigravity is currently working (swimming, scattering data). */
    fun isWorking(): Boolean = visualState == OctopusVisualState.WORKING

    override fun update(dt: Float) {
        time += dt
        if (transitionProgress < 1f) {
            transitionProgress = (transitionProgress + dt * 3f).coerceAtMost(1f)
        }

        when (visualState) {
            OctopusVisualState.SLEEPING -> {
                // Sleeping sinks to the floor — drift left of the crayfish
                // territory so a right-band sleeper doesn't settle onto the
                // OpenClaw crayfish column.
                val myDeepY = STANDING_Y_DEEP + standingJitter * 0.5f
                val restX = homeX.coerceAtMost(TerrariumLayout.CRAYFISH_CLEAR_MAX_X)
                currentX += (restX - currentX) * dt * 4f
                currentY += (myDeepY - currentY) * dt * 4f
            }
            OctopusVisualState.FLOATING -> {
                // Idle HOVERS above the floor strip instead of landing: the band
                // reaches x 0.82, so a floor rest would sit directly on the
                // OpenClaw crayfish home (0.78, 0.64). Hover keeps homeX spacing.
                val myStandingY = (homeY + 0.26f).coerceIn(0.48f, 0.54f) + standingJitter
                val breathBob = sin(time * 0.72f) * 0.006f
                val idleSway = sin(time * 0.34f) * 0.010f
                currentX += (homeX + idleSway - currentX) * dt * 4f
                currentY += (myStandingY + breathBob - currentY) * dt * 4f
            }
            OctopusVisualState.ASKING -> {
                val myStandingY = (homeY + 0.22f).coerceIn(0.46f, 0.52f) + standingJitter
                val fidgetX = sin(time * 1.2f) * 0.012f
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
        val radiusX = maxOf(0.06f, (lane.maxX - lane.minX) * 0.46f)
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
        val halfWidth = minOf(0.15f, maxOf(0.08f, 0.08f + scaleFactor * 0.05f))
        val centerX = homeX.coerceIn(TerrariumLayout.ANTIGRAVITY_SWIM_MIN_X + 0.06f, TerrariumLayout.ANTIGRAVITY_SWIM_MAX_X - 0.06f)
        val centerY = homeY.coerceIn(WORKING_MIN_Y + 0.04f, WORKING_MAX_Y - 0.04f)
        val verticalSlack = minOf(0.08f, maxOf(0.04f, 0.04f + scaleFactor * 0.02f))
        return SwimLane(
            minX = maxOf(TerrariumLayout.ANTIGRAVITY_SWIM_MIN_X, centerX - halfWidth),
            maxX = minOf(TerrariumLayout.ANTIGRAVITY_SWIM_MAX_X, centerX + halfWidth),
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

        val bodyRadius = baseWidth * TerrariumLayout.OCTOPUS_BODY_RADIUS_FRACTION * scaleFactor
        val centerX = w * currentX

        // Bob only when swimming (WORKING); standing states have no bob
        val bobOffset = when (visualState) {
            OctopusVisualState.WORKING -> sin(time * 2f * PI.toFloat() / (TerrariumTiming.FLOAT_PERIOD_MS / 1000f)) *
                h * TerrariumTiming.FLOAT_AMPLITUDE_FRACTION * 1.35f
            OctopusVisualState.FLOATING -> sin(time * 0.72f) * h * 0.005f
            else -> 0f
        }
        val centerY = h * currentY + bobOffset

        val bodyAlpha = when (visualState) {
            OctopusVisualState.SLEEPING -> 0.4f
            else -> 1f
        }

        // WORKING: rising sparks shimmer above the peaks (behind body)
        if (visualState == OctopusVisualState.WORKING) {
            drawRisingSparks(scope, centerX, centerY, bodyRadius, bodyAlpha)
        }

        // Draw the peak/arc SVG body
        drawSvgBody(scope, centerX, centerY, bodyRadius, bodyAlpha)

        // ASKING: speech bubble with "?"
        if (visualState == OctopusVisualState.ASKING) {
            drawSpeechBubble(scope, centerX, centerY, bodyRadius)
        }

        // Name tag (multi-session only)
        if (showNameTag && nameTag != null) {
            drawNameTag(scope, centerX, centerY, bodyRadius, nameTag!!)
        }
    }

    // --- SVG peak/arc body ---

    private fun drawSvgBody(
        scope: DrawScope,
        cx: Float, cy: Float,
        bodyRadius: Float,
        alpha: Float,
    ) {
        // The SVG viewBox is 24×24. Scale so the mark width = bodyRadius * 2.
        val svgScale = (bodyRadius * 2f) / SVG_VIEWBOX

        // Subtle breath scale when not sleeping
        val breathScale = when (visualState) {
            OctopusVisualState.SLEEPING -> 1f
            OctopusVisualState.WORKING -> 1f + sin(time * 2f) * 0.02f
            else -> 1f + sin(time * 0.6f) * 0.01f
        }
        val effScale = svgScale * breathScale

        // Center the SVG at (cx, cy): shift center (12,12) to origin, scale, translate.
        scope.withTransform({
            translate(left = cx, top = cy)
            rotate(degrees = bodyTiltDegrees())
            scale(scaleX = effScale, scaleY = effScale, pivot = Offset.Zero)
            translate(left = -SVG_VIEWBOX / 2f, top = -SVG_VIEWBOX / 2f)
        }) {
            if (visualState == OctopusVisualState.SLEEPING) {
                drawPath(peakPath, color = TerrariumColors.AntigravityDim, alpha = alpha * 0.72f)
            } else {
                drawPath(
                    peakPath,
                    color = TerrariumColors.AntigravityLight,
                    alpha = alpha * 0.34f,
                    style = Stroke(width = 0.72f, cap = StrokeCap.Round),
                )
                drawAntigravityRainbow(alpha)
            }
        }
    }

    private fun bodyTiltDegrees(): Float {
        return when (visualState) {
            OctopusVisualState.WORKING -> sin(time * 2.4f) * 8f
            OctopusVisualState.ASKING -> sin(time * 1.8f) * 5f
            OctopusVisualState.FLOATING -> sin(time * 0.75f) * 3f
            OctopusVisualState.SLEEPING -> -4f
        }
    }

    private fun DrawScope.drawAntigravityRainbow(alpha: Float) {
        val pulse = if (visualState == OctopusVisualState.WORKING) {
            0.10f + (sin(time * TerrariumTiming.THINKING_PULSE_SPEED).coerceAtLeast(0f) * 0.18f)
        } else {
            0f
        }
        val bodyAlpha = (alpha + pulse).coerceAtMost(1f)
        drawPath(
            peakPath,
            brush = Brush.linearGradient(
                colors = BASE_RAINBOW_COLORS,
                start = Offset(3f, 22f),
                end = Offset(22f, 2f),
            ),
            alpha = bodyAlpha,
        )
        drawPath(
            peakPath,
            brush = Brush.radialGradient(
                colors = TOP_WARM_OVERLAY,
                center = Offset(9f, 2.2f),
                radius = 8.5f,
            ),
            alpha = bodyAlpha,
        )
        drawPath(
            peakPath,
            brush = Brush.radialGradient(
                colors = LEFT_GREEN_OVERLAY,
                center = Offset(4.2f, 10f),
                radius = 8.2f,
            ),
            alpha = bodyAlpha,
        )
        drawPath(
            peakPath,
            brush = Brush.radialGradient(
                colors = RIGHT_PURPLE_OVERLAY,
                center = Offset(20f, 9f),
                radius = 8.5f,
            ),
            alpha = bodyAlpha,
        )
    }

    /**
     * Rising sparks — particles drift upward above the peaks during WORKING
     * (a playful anti-gravity cue), pulsing softly.
     */
    private fun drawRisingSparks(scope: DrawScope, cx: Float, cy: Float, radius: Float, alpha: Float) {
        for (i in 0 until SPARK_COUNT) {
            val phase = i * (2f * PI.toFloat() / SPARK_COUNT)
            val rise = (time * 0.4f + i * 0.27f) % 1f
            val sx = cx + cos(phase + time * 0.5f) * radius * 0.55f
            val sy = cy - radius * (0.4f + rise * 1.0f)
            val sparkAlpha = ((1f - rise) * 0.5f + sin(time * 3f + phase) * 0.1f) * alpha
            scope.drawLine(
                color = TerrariumColors.AntigravityYellow,
                alpha = sparkAlpha.coerceIn(0f, 1f),
                start = Offset(sx, sy + radius * 0.08f),
                end = Offset(sx, sy - radius * 0.08f),
                strokeWidth = radius * 0.06f,
                cap = StrokeCap.Round,
            )
        }
    }

    // Pre-allocated speech bubble tail Path
    private val bubbleTailPath = Path()

    /** Speech bubble with "?" — shown during ASKING state. */
    private fun drawSpeechBubble(scope: DrawScope, cx: Float, cy: Float, bodyRadius: Float) {
        val bubbleX = cx + bodyRadius * 1.2f
        val bubbleY = cy
        val bubbleR = bodyRadius * 0.7f

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
            style = Stroke(width = bodyRadius * 0.04f),
        )

        bubbleTailPath.reset()
        bubbleTailPath.moveTo(bubbleX - r * 0.3f, bubbleY + r * 0.3f)
        bubbleTailPath.lineTo(cx + bodyRadius * 0.5f, cy)
        bubbleTailPath.lineTo(bubbleX - r * 0.05f, bubbleY + r * 0.5f)
        bubbleTailPath.close()
        scope.drawPath(bubbleTailPath, color = Color.White, alpha = 0.25f)

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

    /** Name tag above the peaks — only shown in multi-session mode. */
    private fun drawNameTag(scope: DrawScope, cx: Float, cy: Float, bodyRadius: Float, name: String) {
        val bodyMetric = creatureNameTagMetric(scope.size.width, scaleFactor)
        val bodyTopY = cy - bodyRadius
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

        submitCreatureNameTag(
            scope,
            CreatureNameTagRequest(
                cx = cx, tagBottomY = tagBottomY, tagWidth = tagWidth, tagHeight = tagHeight,
                fontSize = chosenSize, lines = lines, lineHeight = lineHeight,
                background = TerrariumColors.AntigravityBody, paint = nameTagPaint,
                rank = labelRankOf(visualState), bodyTopY = bodyTopY, bodyMetric = bodyMetric,
            ),
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
        /** Deep sleeping position Y — lower, partially hidden. */
        private const val STANDING_Y_DEEP = 0.75f
        /** WORKING swim band — upper-mid water. */
        private const val WORKING_MIN_Y = 0.18f
        private const val WORKING_MAX_Y = 0.42f
        private const val WORKING_FIRST_WAYPOINT_INTERVAL = 0.15f

        /** SVG viewBox dimension (24×24) — canonical peak/arc geometry. */
        private const val SVG_VIEWBOX = CreatureGeometry.ANTIGRAVITY_VIEWBOX

        private val peakPath: Path by lazy {
            PathParser().parsePathString(CreatureGeometry.ANTIGRAVITY_PATH_DATA).toPath().apply {
                fillType = PathFillType.EvenOdd
            }
        }

        private val BASE_RAINBOW_COLORS = listOf(
            TerrariumColors.AntigravityLime,
            TerrariumColors.AntigravityTeal,
            TerrariumColors.AntigravityCyan,
            TerrariumColors.AntigravityBlue,
            TerrariumColors.AntigravityViolet,
            TerrariumColors.AntigravityPink,
            TerrariumColors.AntigravityRed,
            TerrariumColors.AntigravityOrange,
            TerrariumColors.AntigravityYellow,
        )

        private val TOP_WARM_OVERLAY = listOf(
            TerrariumColors.AntigravityYellow.copy(alpha = 0.58f),
            TerrariumColors.AntigravityOrange.copy(alpha = 0.28f),
            Color.Transparent,
        )

        private val LEFT_GREEN_OVERLAY = listOf(
            TerrariumColors.AntigravityLime.copy(alpha = 0.55f),
            TerrariumColors.AntigravityTeal.copy(alpha = 0.30f),
            Color.Transparent,
        )

        private val RIGHT_PURPLE_OVERLAY = listOf(
            TerrariumColors.AntigravityPink.copy(alpha = 0.42f),
            TerrariumColors.AntigravityViolet.copy(alpha = 0.34f),
            Color.Transparent,
        )

        // Rising sparks (WORKING anti-gravity shimmer)
        private const val SPARK_COUNT = 6
    }
}
