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
import dev.agentdeck.terrarium.normalizeSvgArcFlags
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
 * Codex CLI creature using the exact design/brand/codex.svg geometry with a
 * blue-purple gradient. The official path contains the `>_` cutout.
 *
 * Colors: lavender (#B394E5) top → deep blue (#3342C7) bottom gradient.
 * Working state shows bioluminescent orbiting particles.
 * Same public API as OctopusCreature for interchangeable use.
 */
class CloudCreature(
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

    // Bioluminescent particle state (8 orbiting particles when WORKING)
    private data class GlowParticle(
        val orbitRadius: Float,
        val orbitSpeed: Float,
        val phaseOffset: Float,
        val size: Float,
        val color: Color,
    )

    private val glowParticles = List(GLOW_PARTICLE_COUNT) { i ->
        GlowParticle(
            orbitRadius = 0.7f + kotlin.random.Random.nextFloat() * 0.6f, // 0.7–1.3 of body radius
            orbitSpeed = 0.8f + kotlin.random.Random.nextFloat() * 0.6f,
            phaseOffset = i * (2f * PI.toFloat() / GLOW_PARTICLE_COUNT),
            size = 0.04f + kotlin.random.Random.nextFloat() * 0.03f,
            color = if (i % 2 == 0) GLOW_CYAN else GLOW_LAVENDER,
        )
    }

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

    /** Update home position — creature lerps naturally (no teleport). */
    fun setHomePosition(x: Float, y: Float, scale: Float) {
        homeX = x
        homeY = y
        scaleFactor = scale
    }

    /** Current live position for tetra attractor tracking. */
    fun simulationPosition(): Pair<Float, Float> = currentX to currentY
    fun currentPosition(): Pair<Float, Float> = simulationPosition()

    /** Whether this cloud is currently working (swimming, scattering data). */
    fun isWorking(): Boolean = visualState == OctopusVisualState.WORKING

    override fun update(dt: Float) {
        time += dt
        if (transitionProgress < 1f) {
            transitionProgress = (transitionProgress + dt * 3f).coerceAtMost(1f)
        }

        when (visualState) {
            OctopusVisualState.SLEEPING -> {
                val myDeepY = STANDING_Y_DEEP + standingJitter * 0.5f
                currentX += (homeX - currentX) * dt * 4f
                currentY += (myDeepY - currentY) * dt * 4f
            }
            OctopusVisualState.FLOATING -> {
                // homeY-relative (not the shared Octopus STANDING_Y) so idle Cloud
                // creatures rest in their own strip instead of converging with
                // Octopus/OpenCode/Antigravity onto the same standing row.
                val myStandingY = (homeY + 0.30f).coerceIn(0.58f, 0.62f) + standingJitter
                val breathBob = sin(time * 0.6f) * 0.003f
                val idleSway = sin(time * 0.25f) * 0.004f
                currentX += (homeX + idleSway - currentX) * dt * 4f
                currentY += (myStandingY + breathBob - currentY) * dt * 4f
            }
            OctopusVisualState.ASKING -> {
                val myStandingY = (homeY + 0.18f).coerceIn(0.48f, 0.54f) + standingJitter
                val fidgetX = sin(time * 1.0f) * 0.006f
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
        val radiusX = maxOf(0.07f, (lane.maxX - lane.minX) * 0.48f)
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
        val halfWidth = minOf(0.16f, maxOf(0.09f, 0.08f + scaleFactor * 0.05f))
        val centerX = homeX.coerceIn(TerrariumLayout.CLOUD_SWIM_MIN_X + 0.06f, TerrariumLayout.CLOUD_SWIM_MAX_X - 0.06f)
        val centerY = homeY.coerceIn(WORKING_MIN_Y + 0.04f, WORKING_MAX_Y - 0.04f)
        val verticalSlack = minOf(0.08f, maxOf(0.04f, 0.04f + scaleFactor * 0.02f))
        return SwimLane(
            minX = maxOf(TerrariumLayout.CLOUD_SWIM_MIN_X, centerX - halfWidth),
            maxX = minOf(TerrariumLayout.CLOUD_SWIM_MAX_X, centerX + halfWidth),
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

        // Bob animation
        val bobOffset = when (visualState) {
            OctopusVisualState.WORKING -> sin(time * 2f * PI.toFloat() / (TerrariumTiming.FLOAT_PERIOD_MS / 1000f)) *
                h * TerrariumTiming.FLOAT_AMPLITUDE_FRACTION
            OctopusVisualState.FLOATING -> sin(time * 0.6f) * h * 0.003f
            else -> 0f
        }
        val centerY = h * currentY + bobOffset

        val bodyAlpha = when (visualState) {
            OctopusVisualState.SLEEPING -> 0.35f
            else -> 1f
        }

        // Bioluminescent glow particles (behind body, WORKING only)
        if (visualState == OctopusVisualState.WORKING) {
            drawGlowParticles(scope, centerX, centerY, bodyRadius, bodyAlpha)
        }

        // Draw canonical Codex mark
        drawCloudBody(scope, centerX, centerY, bodyRadius, bodyAlpha)

        // ASKING: speech bubble with "?"
        if (visualState == OctopusVisualState.ASKING) {
            drawSpeechBubble(scope, centerX, centerY, bodyRadius)
        }

        // Name tag
        if (showNameTag && nameTag != null) {
            drawNameTag(scope, centerX, centerY, bodyRadius, nameTag!!)
        }
    }

    /** Draw the canonical Codex path; animation changes scale/color only. */
    private fun drawCloudBody(
        scope: DrawScope,
        cx: Float, cy: Float,
        bodyRadius: Float,
        alpha: Float,
    ) {
        val breathScale = when (visualState) {
            OctopusVisualState.WORKING -> 1f + sin(time * TerrariumTiming.THINKING_PULSE_SPEED) * 0.04f
            OctopusVisualState.FLOATING -> 1f + sin(time * 0.8f) * 0.015f
            OctopusVisualState.ASKING -> 1f + sin(time * 1.2f) * 0.02f
            OctopusVisualState.SLEEPING -> 0.95f
        }

        // Gradient colors with working pulse
        val topColor = when (visualState) {
            OctopusVisualState.WORKING -> {
                val t = sin(time * TerrariumTiming.THINKING_PULSE_SPEED) * 0.5f + 0.5f
                lerpColor(LAVENDER_TOP, LAVENDER_BRIGHT, t)
            }
            OctopusVisualState.SLEEPING -> LAVENDER_DIM
            else -> LAVENDER_TOP
        }
        val bottomColor = when (visualState) {
            OctopusVisualState.SLEEPING -> DEEP_BLUE_DIM
            else -> DEEP_BLUE_BOTTOM
        }

        val gradient = Brush.linearGradient(
            colors = listOf(topColor, bottomColor),
            start = Offset.Zero,
            end = Offset(CreatureGeometry.CODEX_VIEWBOX, CreatureGeometry.CODEX_VIEWBOX),
        )
        val markSize = bodyRadius * 1.55f * breathScale
        val markScale = markSize / CreatureGeometry.CODEX_VIEWBOX
        scope.withTransform({
            translate(cx - markSize / 2f, cy - markSize / 2f)
            scale(markScale, markScale, pivot = Offset.Zero)
        }) {
            drawPath(codexPath, brush = gradient, alpha = alpha)
            dev.agentdeck.terrarium.CreatureBrandFeatures.draw(this, "codex")
        }
    }

    /**
     * Bioluminescent orbiting particles — shown when WORKING.
     * 8 particles orbit the cloud body at varying speeds/radii.
     */
    private fun drawGlowParticles(
        scope: DrawScope,
        cx: Float, cy: Float,
        bodyRadius: Float,
        alpha: Float,
    ) {
        for (particle in glowParticles) {
            val angle = time * particle.orbitSpeed + particle.phaseOffset
            val orbitR = bodyRadius * particle.orbitRadius
            val px = cx + cos(angle) * orbitR
            val py = cy + sin(angle) * orbitR * 0.7f // oval orbit

            val particleSize = bodyRadius * particle.size
            val pulseAlpha = (sin(time * 3f + particle.phaseOffset) * 0.3f + 0.7f) * alpha * 0.6f

            // Outer glow
            scope.drawCircle(
                color = particle.color,
                alpha = pulseAlpha * 0.3f,
                radius = particleSize * 2.5f,
                center = Offset(px, py),
            )
            // Core
            scope.drawCircle(
                color = Color.White,
                alpha = pulseAlpha * 0.8f,
                radius = particleSize,
                center = Offset(px, py),
            )
        }
    }

    // Pre-allocated speech bubble tail Path
    private val bubbleTailPath = Path()

    /** Speech bubble with "?" — shown during ASKING state. */
    private fun drawSpeechBubble(scope: DrawScope, cx: Float, cy: Float, bodyRadius: Float) {
        val bubbleX = cx + bodyRadius * 1.3f
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
        bubbleTailPath.lineTo(cx + bodyRadius * 0.6f, cy)
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

    /** Name tag above the cloud — only shown in multi-session mode. */
    private fun drawNameTag(scope: DrawScope, cx: Float, cy: Float, bodyRadius: Float, name: String) {
        val bodyMetric = creatureNameTagMetric(scope.size.width, scaleFactor)
        val bodyTopY = cy - bodyRadius * 0.60f
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
                background = DEEP_BLUE_BOTTOM, paint = nameTagPaint,
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
        // Positions
        /** SLEEPING: dim, near bottom. */
        private const val STANDING_Y_DEEP = 0.75f
        /** WORKING: floats near surface, wide drift zone. */
        private const val WORKING_CENTER_Y = 0.10f
        private const val WORKING_MIN_Y = 0.05f
        private const val WORKING_MAX_Y = 0.25f

        // Gradient colors — from official codex-color.svg: #B1A7FF → #7A9DFF → #3941FF
        private val LAVENDER_TOP = Color(0xFFB1A7FF)       // lavender (official top)
        private val DEEP_BLUE_BOTTOM = Color(0xFF3941FF)   // vivid blue (official bottom)
        private val LAVENDER_BRIGHT = Color(0xFFD0C4FF)    // working pulse bright
        private val LAVENDER_DIM = Color(0xFF7A7099)       // sleeping top
        private val DEEP_BLUE_DIM = Color(0xFF2A2F80)      // sleeping bottom

        // Bioluminescent glow particle colors
        private val GLOW_CYAN = Color(0xFF66DDFF)
        private val GLOW_LAVENDER = Color(0xFFD0AAFF)
        private const val GLOW_PARTICLE_COUNT = 8

        // Normalise arc-flag compression before parsing — Compose's PathParser
        // is mostly tolerant of SVG flag compression but the core graphics
        // parser that backs the e-ink path is not. Normalising here keeps the
        // two surfaces byte-for-byte equivalent in input shape.
        private val codexPath = PathParser()
            .parsePathString(normalizeSvgArcFlags(CreatureGeometry.CODEX_PATH_DATA))
            .toPath().apply {
                fillType = PathFillType.EvenOdd
            }
    }
}
