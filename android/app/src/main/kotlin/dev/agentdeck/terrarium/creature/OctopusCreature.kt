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
 * Claude Code mascot — Antigravity robot from claudecode.svg (terracotta).
 * SVG viewBox 0 0 24 24, fill-rule evenodd (eyes are transparent cutouts).
 * Rectangular body with protruding legs and two square eye holes.
 *
 * WORKING state shows rotating Anthropic starburst behind the body.
 */
class OctopusCreature(
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
    /** Whether to show name tag (only for multi-session). */
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
    // Per-instance standing Y offset for natural multi-agent depth staggering
    private val standingJitter = kotlin.random.Random.nextFloat() * 0.06f - 0.03f

    /** Callback invoked when transitioning away from ASKING (bubble pop trigger). */
    var onAskingExit: ((nx: Float, ny: Float) -> Unit)? = null

    fun setState(newState: OctopusVisualState) {
        if (newState != visualState) {
            // Trigger pop burst when leaving ASKING state
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

    /** Update home position — creature lerps naturally (no teleport). */
    fun setHomePosition(x: Float, y: Float, scale: Float) {
        homeX = x
        homeY = y
        scaleFactor = scale
    }

    /** Current live position for tetra attractor tracking. */
    fun simulationPosition(): Pair<Float, Float> = currentX to currentY
    fun currentPosition(): Pair<Float, Float> = simulationPosition()

    /** Floor position after the shared spacing pass; null while swimming. */
    var restX: Float? = null

    /** (home X, layout width) while standing on the floor, null while swimming. */
    fun floorFootprint(): Pair<Float, Float>? =
        if (visualState == OctopusVisualState.WORKING) null else homeX to LAYOUT_WIDTH * scaleFactor

    /** Whether this octopus is currently working (swimming, scattering data). */
    fun isWorking(): Boolean = visualState == OctopusVisualState.WORKING

    override fun update(dt: Float) {
        time += dt
        if (transitionProgress < 1f) {
            transitionProgress = (transitionProgress + dt * 3f).coerceAtMost(1f)
        }

        // Movement: only WORKING swims freely; FLOATING/ASKING stand on bottom,
        // at the spaced floor position when the renderer has assigned one.
        val homeX = restX ?: this.homeX
        when (visualState) {
            OctopusVisualState.SLEEPING -> {
                // Sleeping: settle to deep bottom, dim — per-instance variation
                val myDeepY = STANDING_Y_DEEP + standingJitter * 0.5f
                currentX += (homeX - currentX) * dt * 4f
                currentY += (myDeepY - currentY) * dt * 4f
            }
            OctopusVisualState.FLOATING -> {
                // IDLE: stand near bottom with per-instance depth variation + gentle breath bob
                val myStandingY = (STANDING_Y + standingJitter + (homeX - 0.4f) * 0.15f).coerceAtMost(0.65f)
                val breathBob = sin(time * 0.8f) * 0.002f
                val idleSway = sin(time * 0.3f) * 0.005f
                currentX += (homeX + idleSway - currentX) * dt * 4f
                currentY += (myStandingY + breathBob - currentY) * dt * 4f
            }
            OctopusVisualState.ASKING -> {
                // Awaiting input: near bottom with per-instance depth variation
                val myStandingY = (STANDING_Y + standingJitter + (homeX - 0.4f) * 0.15f).coerceAtMost(0.65f)
                val fidgetX = sin(time * 1.2f) * 0.008f
                currentX += (homeX + fidgetX - currentX) * dt * 4f
                currentY += (myStandingY - currentY) * dt * 4f
            }
            OctopusVisualState.WORKING -> {
                val lane = swimLane()
                // WORKING: free swimming with waypoints
                waypointTimer += dt
                if (waypointTimer >= waypointInterval) {
                    waypointTimer = 0f
                    waypointInterval = TerrariumTiming.WAYPOINT_MIN_INTERVAL +
                        kotlin.random.Random.nextFloat() * (TerrariumTiming.WAYPOINT_MAX_INTERVAL - TerrariumTiming.WAYPOINT_MIN_INTERVAL)
                    pickNewWaypoint()
                }

                // Lerp toward target
                val rate = TerrariumTiming.SWIM_LERP_RATE * dt
                currentX += (targetX - currentX) * rate
                currentY += (targetY - currentY) * rate

                // Clamp to swim boundaries
                currentX = currentX.coerceIn(lane.minX, lane.maxX)
                currentY = currentY.coerceIn(lane.minY, lane.maxY)
            }
        }
    }

    private fun pickNewWaypoint() {
        val lane = swimLane()
        val angle = kotlin.random.Random.nextFloat() * 2f * PI.toFloat()
        val radiusX = maxOf(0.06f, (lane.maxX - lane.minX) * 0.46f)
        val radiusY = maxOf(0.04f, (lane.maxY - lane.minY) * 0.42f)
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
        val verticalSlack = minOf(0.09f, maxOf(0.05f, 0.05f + scaleFactor * 0.03f))
        val centerX = homeX.coerceIn(TerrariumLayout.SWIM_MIN_X + 0.06f, TerrariumLayout.SWIM_MAX_X - 0.06f)
        val centerY = homeY.coerceIn(TerrariumLayout.SWIM_MIN_Y + 0.08f, TerrariumLayout.SWIM_MAX_Y - 0.08f)
        return SwimLane(
            minX = maxOf(TerrariumLayout.SWIM_MIN_X, centerX - halfWidth),
            maxX = minOf(TerrariumLayout.SWIM_MAX_X, centerX + halfWidth),
            minY = maxOf(TerrariumLayout.SWIM_MIN_Y, centerY - verticalSlack),
            maxY = minOf(TerrariumLayout.SWIM_MAX_Y, centerY + verticalSlack),
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
                h * TerrariumTiming.FLOAT_AMPLITUDE_FRACTION
            else -> 0f
        }
        val centerY = h * currentY + bobOffset

        val bodyAlpha = if (visualState == OctopusVisualState.SLEEPING) 0.4f else 1f

        // Draw SVG robot body
        drawSvgBody(scope, centerX, centerY, bodyRadius, bodyAlpha)

        // WORKING: compact starburst sparkle in front of body
        if (visualState == OctopusVisualState.WORKING) {
            drawStarburst(scope, centerX, centerY, bodyRadius * 0.55f, bodyAlpha * 0.7f)
        }

        // ASKING: speech bubble with "?"
        if (visualState == OctopusVisualState.ASKING) {
            drawSpeechBubble(scope, centerX, centerY, bodyRadius)
        }

        // Name tag (multi-session only)
        if (showNameTag && nameTag != null) {
            drawNameTag(scope, centerX, centerY, bodyRadius, nameTag!!)
        }
    }

    // --- SVG Robot Body ---

    private fun drawSvgBody(
        scope: DrawScope,
        cx: Float, cy: Float,
        bodyRadius: Float,
        alpha: Float,
    ) {
        val bodyColor = bodyColorForState()
        // The SVG viewBox is 24×24. The robot occupies roughly 24×15 (y: 5→20).
        // Scale so the robot width = bodyRadius * 2
        val svgScale = (bodyRadius * 2f) / SVG_VIEWBOX

        // Subtle breath scale when not sleeping
        val breathScale = when (visualState) {
            OctopusVisualState.SLEEPING -> 1f
            OctopusVisualState.WORKING -> 1f + sin(time * 2f) * 0.015f
            else -> 1f + sin(time * 0.6f) * 0.008f
        }

        // Effective scale including breath animation
        val effScale = svgScale * breathScale

        // Center the SVG at (cx, cy):
        // 1. Shift SVG so its center (12,12) goes to origin
        // 2. Scale around origin
        // 3. Translate to screen (cx, cy)
        scope.withTransform({
            translate(left = cx, top = cy)
            scale(scaleX = effScale, scaleY = effScale, pivot = Offset.Zero)
            translate(left = -SVG_VIEWBOX / 2f, top = -SVG_VIEWBOX / 2f)
        }) {
            drawPath(robotPath, color = bodyColor, alpha = alpha)

            dev.agentdeck.terrarium.CreatureBrandFeatures.draw(this, "claudecode")
        }
    }

    private fun bodyColorForState(): Color {
        return when (visualState) {
            OctopusVisualState.WORKING -> {
                val t = sin(time * TerrariumTiming.THINKING_PULSE_SPEED) * 0.5f + 0.5f
                lerpColor(TerrariumColors.ClaudeBody, TerrariumColors.ClaudeBodyLight, t)
            }
            else -> TerrariumColors.ClaudeBody
        }
    }

    /**
     * Anthropic sparkle/starburst — 10 radiating arms behind the robot body.
     * Slowly rotates and pulses during WORKING state.
     */
    private fun drawStarburst(scope: DrawScope, cx: Float, cy: Float, radius: Float, alpha: Float) {
        val rotation = time * 0.5f
        val pulse = sin(time * TerrariumTiming.THINKING_PULSE_SPEED) * 0.15f + 0.85f

        for (i in 0 until STARBURST_ARM_COUNT) {
            val baseAngle = (i.toFloat() / STARBURST_ARM_COUNT) * 2f * PI.toFloat() + rotation
            val armLen = radius * pulse * STARBURST_ARM_LENGTHS[i % STARBURST_ARM_LENGTHS.size]
            val endX = cx + cos(baseAngle) * armLen
            val endY = cy + sin(baseAngle) * armLen

            scope.drawLine(
                color = TerrariumColors.ClaudeBody,
                alpha = alpha * 0.35f,
                start = Offset(cx, cy),
                end = Offset(endX, endY),
                strokeWidth = radius * 0.10f,
                cap = StrokeCap.Round,
            )
        }
    }

    // Pre-allocated speech bubble tail Path
    private val bubbleTailPath = Path()

    /** Speech bubble with "?" — shown during ASKING state. */
    private fun drawSpeechBubble(scope: DrawScope, cx: Float, cy: Float, bodyRadius: Float) {
        // Position: right side at body center — avoids overlapping name tag above
        val bubbleX = cx + bodyRadius * 1.2f
        val bubbleY = cy  // Body center — clear of name tag above
        val bubbleR = bodyRadius * 0.7f

        // Gentle pulse
        val pulse = sin(time * 2.5f) * 0.08f + 1f
        val r = bubbleR * pulse

        // Bubble fill
        scope.drawCircle(
            color = Color.White,
            alpha = 0.25f,
            radius = r,
            center = Offset(bubbleX, bubbleY),
        )
        // Bubble border
        scope.drawCircle(
            color = TerrariumColors.HUDText,
            alpha = 0.5f,
            radius = r,
            center = Offset(bubbleX, bubbleY),
            style = Stroke(width = bodyRadius * 0.04f),
        )

        // Tail triangle pointing toward body right edge
        bubbleTailPath.reset()
        bubbleTailPath.moveTo(bubbleX - r * 0.3f, bubbleY + r * 0.3f)
        bubbleTailPath.lineTo(cx + bodyRadius * 0.5f, cy)
        bubbleTailPath.lineTo(bubbleX - r * 0.05f, bubbleY + r * 0.5f)
        bubbleTailPath.close()
        scope.drawPath(bubbleTailPath, color = Color.White, alpha = 0.25f)

        // "?" text via nativeCanvas
        val canvas = scope.drawContext.canvas.nativeCanvas
        val textSize = r * 1.2f
        canvas.drawText(
            "?", bubbleX, bubbleY + textSize * 0.35f,
            questionMarkPaint.apply { this.textSize = textSize },
        )
    }

    // Cached name tag TEXT layout (lines, font size, dimensions) — avoids per-frame measureText.
    // Position (tagBottomY) is NOT cached — it depends on creature's live Y position.
    private var cachedNameLayout: CachedNameLayout? = null
    private data class CachedNameLayout(
        val name: String, val bodyMetric: Float,
        val lines: List<String>, val lineHeight: Float,
        val tagWidth: Float, val tagHeight: Float, val fontSize: Float,
    )

    /** Name tag hat above the robot — only shown in multi-session mode. */
    private fun drawNameTag(scope: DrawScope, cx: Float, cy: Float, bodyRadius: Float, name: String) {
        val bodyMetric = creatureNameTagMetric(scope.size.width, scaleFactor)
        val bodyTopY = cy - bodyRadius
        // Position: always computed from live creature Y
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
                background = TerrariumColors.ClaudeBody, paint = nameTagPaint,
                rank = labelRankOf(visualState), bodyTopY = bodyTopY, bodyMetric = bodyMetric,
            ),
        )
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
        color = android.graphics.Color.argb(180, 226, 232, 240) // HUDText ~70%
        textAlign = Paint.Align.CENTER
        typeface = Typeface.DEFAULT_BOLD
    }

    private val nameTagPaint = Paint().apply {
        isAntiAlias = true
        color = android.graphics.Color.argb(220, 226, 232, 240) // HUDText ~86%
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create("sans-serif", Typeface.NORMAL)
    }

    companion object {
        /** Band width the layout reserves for one octopus (creature-layout.ts). */
        const val LAYOUT_WIDTH = 0.11f
        /** Standing position Y — just above the sand line (0.65). */
        private const val STANDING_Y = 0.635f
        /** Deep sleeping position Y — lower, partially hidden. */
        private const val STANDING_Y_DEEP = 0.75f

        /** SVG viewBox dimension (24×24) — canonical robot geometry (see CreatureGeometry). */
        private const val SVG_VIEWBOX = CreatureGeometry.OCTOPUS_VIEWBOX

        private val robotPath: Path by lazy {
            PathParser().parsePathString(CreatureGeometry.OCTOPUS_PATH_DATA).toPath().apply {
                fillType = PathFillType.EvenOdd
            }
        }

        // Starburst (Anthropic sparkle) — 10 arms with varying lengths
        private const val STARBURST_ARM_COUNT = 10
        private val STARBURST_ARM_LENGTHS = floatArrayOf(
            1.0f, 0.75f, 0.95f, 0.70f, 1.0f,
            0.80f, 0.90f, 0.72f, 0.98f, 0.78f,
        )
    }
}
