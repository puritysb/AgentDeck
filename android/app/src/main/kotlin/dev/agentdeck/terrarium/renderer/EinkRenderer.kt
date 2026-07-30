package dev.agentdeck.terrarium.renderer

import android.graphics.Bitmap
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.view.View
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.neverEqualPolicy
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.IntSize
import dev.agentdeck.terrarium.CrayfishVisualState
import dev.agentdeck.terrarium.CreatureGeometry
import dev.agentdeck.terrarium.OctopusVisualState
import dev.agentdeck.terrarium.TetraVisualState
import dev.agentdeck.terrarium.TerrariumLayout
import dev.agentdeck.terrarium.TerrariumState
import dev.agentdeck.terrarium.CreatureNameTagStyle
import dev.agentdeck.terrarium.creatureNameTagMetric
import dev.agentdeck.terrarium.resolveCreatureNameTagLayout
import android.util.Log
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlin.math.floor

/** E-ink animation frame interval (ms). 400ms for smoother movement (~2.5fps). */
private const val EINK_ANIM_FRAME_MS = 400L

/**
 * Color e-ink can display browser video by switching into a fast refresh path.
 * Match that behavior with a modest 10fps loop; motion speed is scaled back to
 * the 400ms logical frame clock so creatures do not move faster than B&W e-ink.
 */
private const val COLOR_EINK_ANIM_FRAME_MS = 100L

/** Total animation cycle frames — fish patrol uses the full range, creatures use % 4. */
private const val EINK_ANIM_CYCLE = 32

// Octopus (Claude robot) and crayfish (OpenClaw) silhouettes are rendered from the
// canonical SVG paths in CreatureGeometry via canvas.drawPath — drawPath works on
// CremaS/RK3566 e-ink (the old "no drawPath" comments were based on an unverified claim).

// Codex and OpenCode also preserve their canonical geometry; Codex uses the
// cached path below while OpenCode's rectangular ring is equivalent primitives.

internal fun einkAnimationFrameIntervalMs(colorEink: Boolean): Long =
    if (colorEink) COLOR_EINK_ANIM_FRAME_MS else EINK_ANIM_FRAME_MS

internal fun einkAnimationFrameAdvance(elapsedMs: Long): Float =
    (elapsedMs.coerceAtLeast(0).toFloat() / EINK_ANIM_FRAME_MS).coerceAtMost(1.5f)

private fun frameMod4(frame: Float): Int = floor(frame).toInt().floorMod(4)

private fun Int.floorMod(modulus: Int): Int = ((this % modulus) + modulus) % modulus

/**
 * E-ink terrarium renderer — draws creatures into an offscreen bitmap,
 * applies 16-level grayscale quantization, then renders the result.
 *
 * Style: "Marine biologist's journal" — pixel blocks + SVG outlines, native 16-level grayscale.
 * Supports low-framerate animation for B&W e-ink and fast partial refresh on
 * color e-ink panels that can run browser video acceptably.
 */
@Composable
fun EinkTerrariumView(
    state: TerrariumState,
    modifier: Modifier = Modifier,
    snapshotMode: Boolean = false,
    onFrameRendered: ((isAnimationFrame: Boolean) -> Unit)? = null,
) {
    androidx.compose.foundation.layout.BoxWithConstraints(modifier = modifier) {
        val density = androidx.compose.ui.platform.LocalDensity.current
        val widthPx = with(density) { maxWidth.toPx().toInt() }.coerceAtLeast(100)
        val heightPx = with(density) { maxHeight.toPx().toInt() }.coerceAtLeast(100)

        // neverEqualPolicy: bitmap is reused (same reference), so every assignment
        // must trigger recomposition even though the reference doesn't change.
        var renderedBitmap by remember { mutableStateOf<Bitmap?>(null, neverEqualPolicy()) }
        // Capture hosting Android View — postInvalidate() flushes the LAYER_TYPE_SOFTWARE
        // cache in the parent EinkRefreshZone FrameLayout, ensuring animation frames reach the EPD.
        val hostView = LocalView.current
        // Reusable render target — NOT displayed directly, only used as renderEinkFrame target
        var reusableBitmap by remember { mutableStateOf<Bitmap?>(null) }
        var animFrame by remember { mutableFloatStateOf(0f) }
        val currentState by rememberUpdatedState(state)
        // Persistent boids fish school — survives recomposition, state lives across frames
        val fishSchool = remember { EinkFishSchool() }

        val hasActiveCreatures = state.octopus != OctopusVisualState.SLEEPING ||
            state.crayfish != CrayfishVisualState.DORMANT ||
            state.cloudCreatures.any { it.visualState != OctopusVisualState.SLEEPING } ||
            state.openCodeCreatures.any { it.visualState != OctopusVisualState.SLEEPING } ||
            state.antigravityCreatures.any { it.visualState != OctopusVisualState.SLEEPING }
        val isAnimating = hasActiveCreatures && !snapshotMode

        // Animation loop — platform-specific:
        // B&W e-ink: 2.5fps GC16 partial animation (400ms).
        // Color Kaleido/Gallery: 10fps fast partial animation, but the logical
        // motion clock stays at 400ms so browser-video-capable panels get smoother
        // interpolation without making fish and creatures sprint.
        LaunchedEffect(isAnimating, snapshotMode, widthPx, heightPx) {
            if (!isAnimating) {
                // Static or host-asleep snapshot state: render once and let the
                // caller decide whether that frame warrants an EPD refresh.
                val bmp = reusableBitmap?.takeIf { it.width == widthPx && it.height == heightPx }
                    ?: Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { reusableBitmap = it }
                renderedBitmap = renderEinkFrame(currentState, widthPx, heightPx, 0f, bmp, fishSchool = fishSchool)
                hostView.postInvalidate()
                onFrameRendered?.invoke(false)
                return@LaunchedEffect
            }
            val frameInterval = einkAnimationFrameIntervalMs(einkColorEnabled)
            var lastFrameAt = android.os.SystemClock.uptimeMillis()
            while (isActive) {
                try {
                    val bmp = reusableBitmap?.takeIf { it.width == widthPx && it.height == heightPx }
                        ?: Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { reusableBitmap = it }
                    val now = android.os.SystemClock.uptimeMillis()
                    val frameAdvance = einkAnimationFrameAdvance(now - lastFrameAt)
                    lastFrameAt = now
                    animFrame = (animFrame + frameAdvance) % EINK_ANIM_CYCLE.toFloat()
                    val s = currentState
                    val streaming = s.tetra == TetraVisualState.STREAMING
                    val agentSlots = dev.agentdeck.terrarium.layoutOctopuses(s.agents.size.coerceAtLeast(1))
                    fishSchool.update(streaming, agentSlots, s.crayfish == CrayfishVisualState.ROUTING, frameAdvance)
                    renderedBitmap = renderEinkFrame(currentState, widthPx, heightPx, animFrame, bmp,
                        skipDither = einkColorEnabled, fishSchool = fishSchool)
                    hostView.postInvalidate()
                    onFrameRendered?.invoke(true)
                } catch (e: Exception) {
                    android.util.Log.e("EinkAnim", "Animation loop crash", e)
                }
                delay(frameInterval)
            }
        }

        // Force immediate re-render on state change (e.g. FLOATING→WORKING).
        // The animation loop picks up currentState automatically, but we also render
        // one frame immediately so the transition isn't delayed by up to 600ms.
        val agentsKey = state.agents.map { it.visualState }
        val cloudsKey = state.cloudCreatures.map { it.visualState }
        val openCodeKey = state.openCodeCreatures.map { it.visualState }
        val antigravityKey = state.antigravityCreatures.map { it.visualState }
        LaunchedEffect(snapshotMode, state.octopus, state.crayfish, state.tetra, state.environment, agentsKey, cloudsKey, openCodeKey, antigravityKey, widthPx, heightPx) {
            val bmp = reusableBitmap?.takeIf { it.width == widthPx && it.height == heightPx }
                ?: Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { reusableBitmap = it }
            val frame = if (snapshotMode) 0f else animFrame
            renderedBitmap = renderEinkFrame(currentState, widthPx, heightPx, frame, bmp, fishSchool = fishSchool)
            hostView.postInvalidate()
            onFrameRendered?.invoke(false)
        }

        // Initial render
        LaunchedEffect(widthPx, heightPx) {
            if (renderedBitmap == null || renderedBitmap?.width != widthPx || renderedBitmap?.height != heightPx) {
                val bmp = reusableBitmap?.takeIf { it.width == widthPx && it.height == heightPx }
                    ?: Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { reusableBitmap = it }
                renderedBitmap = renderEinkFrame(state, widthPx, heightPx, 0f, bmp, fishSchool = fishSchool)
                hostView.postInvalidate()
                onFrameRendered?.invoke(false)
            }
        }

        Canvas(modifier = Modifier.fillMaxSize()) {
            val bmp = renderedBitmap ?: return@Canvas
            drawImage(
                image = bmp.asImageBitmap(),
                dstSize = IntSize(size.width.toInt(), size.height.toInt()),
            )
        }
    }
}

/**
 * Render a single e-ink frame with optional animation. Reuses [target] bitmap to avoid allocation.
 * [skipDither] skips the snapToNearestGray pass — safe because all draw colors are pre-quantized
 * 16-level grays and paint.isAntiAlias=false. Use for animation frames where speed matters.
 */
private fun renderEinkFrame(
    state: TerrariumState, width: Int, height: Int, animFrame: Float = 0f,
    target: Bitmap? = null, skipDither: Boolean = false,
    fishSchool: EinkFishSchool? = null,
): Bitmap {
    val bitmap = if (target != null && target.width == width && target.height == height) {
        target.eraseColor(0)
        target
    } else {
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    }
    val canvas = android.graphics.Canvas(bitmap)
    val paint = Paint().apply { isAntiAlias = false }

    if (Log.isLoggable("EinkFrame", Log.VERBOSE)) {
        Log.v("EinkFrame", "agents=${state.agents.size} clouds=${state.cloudCreatures.size} oc=${state.openCodeCreatures.size} cf=${state.crayfish} frame=$animFrame")
    }

    // Water background — entire frame is the aquarium (no inner border)
    canvas.drawColor(einkPick(GRAY_WATER_BG, COLOR_WATER_BG))

    // Color e-ink: ukiyo-e style water depth lines for paper-print texture
    if (einkColorEnabled) {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.0f
        val waveColor = 0xFF7AAAC0.toInt()  // slightly darker than water bg
        paint.color = waveColor
        for (i in 1..5) {
            val lineY = height * (0.15f + i * 0.12f)
            val wavePath = android.graphics.Path().apply {
                moveTo(0f, lineY)
                var x = 0f
                while (x <= width) {
                    val y = lineY + kotlin.math.sin((x * 0.015f + i * 0.8f).toDouble()).toFloat() * 2.5f
                    lineTo(x, y)
                    x += 3f
                }
            }
            canvas.drawPath(wavePath, paint)
        }
    }

    // Water surface — flat air region above water line, wave only on the boundary
    val discreteFrame = floor(animFrame).toInt()
    val creatureFrame = discreteFrame.floorMod(4)
    val surfaceY = height * 0.08f
    val surfaceAmp = height * 0.012f
    val surfaceFreq = (2.0 * kotlin.math.PI / (width * 0.5)).toFloat()
    val phaseShift = creatureFrame * kotlin.math.PI.toFloat() / 2f

    // Air fill — everything above the sine wave curve.
    // The contrast between GRAY_AIR (0xEE) and GRAY_WATER_BG (0xDD) forms a natural
    // subtle water surface. No separate wave stroke needed (it was too prominent on e-ink).
    paint.style = Paint.Style.FILL
    paint.color = einkPick(GRAY_AIR, COLOR_AIR)
    val airPath = android.graphics.Path().apply {
        moveTo(0f, 0f)
        lineTo(width.toFloat(), 0f)
        // Trace sine wave from right to left (bottom edge of air region)
        var sx = width.toFloat()
        while (sx >= 0f) {
            val sy = surfaceY + kotlin.math.sin((surfaceFreq * sx + phaseShift).toDouble()).toFloat() * surfaceAmp
            lineTo(sx, sy)
            sx -= 4f
        }
        close()
    }
    canvas.drawPath(airPath, paint)

    // Bubbles — filled + outline for e-ink visibility (4-frame cycle)
    val bubbleBasePositions = floatArrayOf(0.15f, 0.35f, 0.55f, 0.75f)
    for (i in 0 until 4) {
        val bx = width * (bubbleBasePositions[i] + (i % 2) * 0.05f) +
            (if (creatureFrame % 2 == 0) 2f else -2f) * (i % 2 * 2 - 1)
        val baseY = surfaceY + height * (0.05f + i * 0.08f)
        val by = baseY - creatureFrame * height * 0.015f
        val r = 3f + i * 0.8f
        // Inner highlight
        paint.style = Paint.Style.FILL
        paint.color = einkPick(GRAY_AIR, COLOR_AIR)
        canvas.drawCircle(bx, by, r * 0.5f, paint)
        // Outer ring
        paint.style = Paint.Style.STROKE
        paint.color = einkPick(GRAY_BUBBLE, COLOR_BUBBLE)
        paint.strokeWidth = 1.0f
        canvas.drawCircle(bx, by, r, paint)
    }

    // Sand floor — subtle darker band at bottom for visual grounding
    paint.style = Paint.Style.FILL
    paint.color = einkPick(GRAY_SAND, COLOR_SAND)
    canvas.drawRect(0f, height * 0.82f, width.toFloat(), height.toFloat(), paint)

    // Light rays — 2 fixed-position gray gradient rectangles
    drawEinkLightRays(canvas, paint, width, height, creatureFrame)

    // Water surface line — 2px wave at y=4%
    drawEinkWaterSurface(canvas, paint, width, height, creatureFrame)

    // Environment (4-frame cycle for seaweed sway)
    drawEinkSeaweed(canvas, paint, width, height, creatureFrame)
    drawEinkRocks(canvas, paint, width, height)
    drawEinkGravel(canvas, paint, width, height)

    // Ground cover grass
    drawEinkGrass(canvas, paint, width, height, creatureFrame)

    // Back-layer fish (behind creatures for 3D depth)
    drawEinkDataParticles(canvas, paint, width, height, state.tetra, state.agents.size, state.crayfish, animFrame, layer = 0, fishSchool = fishSchool)

    // Creatures (4-frame cycle for limb animation)
    if (state.agents.isEmpty()) {
        // No agents — skip octopus drawing
    } else if (state.agents.size > 1) {
        val slots = dev.agentdeck.terrarium.layoutOctopusesByProject(
            state.agents.map { dev.agentdeck.terrarium.AgentLayoutInfo(it.sessionId, it.displayName) }
        )
        for (i in state.agents.indices) {
            val slot = slots.getOrElse(i) { slots.last() }
            drawEinkOctopus(canvas, paint, width, height,
                state.agents[i].visualState, state.agents[i].agentType,
                centerXFraction = slot.centerXFraction, centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor, animFrame = animFrame,
                swimFrame = animFrame, displayName = state.agents[i].displayName)
        }
    } else {
        // Use agent's own visualState (not state.octopus which reflects daemon's state)
        val agent = state.agents[0]
        drawEinkOctopus(canvas, paint, width, height, agent.visualState, agent.agentType,
            animFrame = animFrame, swimFrame = animFrame,
            displayName = agent.displayName)
    }
    // Pop burst particles (1-frame effect when leaving ASKING state)
    if (state.popBurstPositions.isNotEmpty()) {
        paint.style = Paint.Style.FILL
        paint.color = einkPick(GRAY_AIR, COLOR_AIR)
        for ((px, py) in state.popBurstPositions) {
            val burstCx = width * px
            val burstCy = height * py
            val burstR = width * 0.02f
            for (j in 0 until 6) {
                val angle = (j.toFloat() / 6f) * 2f * kotlin.math.PI.toFloat()
                val bx = burstCx + kotlin.math.cos(angle) * burstR
                val by = burstCy + kotlin.math.sin(angle) * burstR
                canvas.drawCircle(bx, by, width * 0.003f, paint)
            }
        }
    }

    drawEinkCrayfish(canvas, paint, width, height, state.crayfish, animFrame)

    // Cloud creatures (Codex CLI agents — float in upper area)
    if (state.cloudCreatures.isNotEmpty()) {
        val cloudSlots = dev.agentdeck.terrarium.layoutCloudCreatures(state.cloudCreatures.size)
        for (i in state.cloudCreatures.indices) {
            val slot = cloudSlots.getOrElse(i) { cloudSlots.last() }
            drawEinkCloud(canvas, paint, width, height,
                state.cloudCreatures[i].visualState,
                centerXFraction = slot.centerXFraction,
                centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor,
                animFrame = animFrame,
                swimFrame = animFrame,
                displayName = state.cloudCreatures[i].displayName)
        }
    }

    // OpenCode creatures (nested-square logo agents)
    if (state.openCodeCreatures.isNotEmpty()) {
        val openCodeSlots = dev.agentdeck.terrarium.layoutOpenCodeCreatures(state.openCodeCreatures.size)
        for (i in state.openCodeCreatures.indices) {
            val slot = openCodeSlots.getOrElse(i) { openCodeSlots.last() }
            drawEinkOpenCode(canvas, paint, width, height,
                state.openCodeCreatures[i].visualState,
                centerXFraction = slot.centerXFraction,
                centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor,
                animFrame = animFrame,
                swimFrame = animFrame,
                displayName = state.openCodeCreatures[i].displayName)
        }
    }

    // Antigravity creatures (peak/arc logo agents)
    if (state.antigravityCreatures.isNotEmpty()) {
        val antigravitySlots = dev.agentdeck.terrarium.layoutAntigravityCreatures(state.antigravityCreatures.size)
        for (i in state.antigravityCreatures.indices) {
            val slot = antigravitySlots.getOrElse(i) { antigravitySlots.last() }
            drawEinkAntigravity(canvas, paint, width, height,
                state.antigravityCreatures[i].visualState,
                centerXFraction = slot.centerXFraction,
                centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor,
                animFrame = animFrame,
                swimFrame = animFrame,
                displayName = state.antigravityCreatures[i].displayName)
        }
    }

    // Front-layer fish (in front of creatures for 3D depth)
    drawEinkDataParticles(canvas, paint, width, height, state.tetra, state.agents.size, state.crayfish, animFrame, layer = 1, fishSchool = fishSchool)

    // Snap to native 16-level grayscale — only on B&W e-ink state-change renders.
    // Color e-ink: skip to preserve RGB colors for CFA rendering.
    if (!skipDither && !einkColorEnabled) {
        DitherEngine.snapToNearestGray(bitmap)
    }

    return bitmap
}

// --- Environment ---

private fun drawEinkRocks(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int) {
    val bottomY = h * 0.82f
    paint.style = Paint.Style.FILL
    paint.color = einkPick(GRAY_ROCK, COLOR_ROCK)

    // Right rock cluster
    val rockPath = android.graphics.Path().apply {
        moveTo(w * 0.65f, h.toFloat())
        lineTo(w * 0.62f, bottomY)
        cubicTo(w * 0.68f, bottomY - h * 0.06f, w * 0.82f, bottomY - h * 0.08f, w * 0.88f, bottomY)
        lineTo(w * 0.92f, h.toFloat())
        close()
    }
    canvas.drawPath(rockPath, paint)
    // Outline for definition on e-ink
    paint.style = Paint.Style.STROKE
    paint.color = einkPick(GRAY_GRAVEL, COLOR_GRAVEL)
    paint.strokeWidth = 1.0f
    canvas.drawPath(rockPath, paint)
    paint.style = Paint.Style.FILL
    paint.color = einkPick(GRAY_ROCK, COLOR_ROCK)

    // Left small rocks
    val leftRock = android.graphics.Path().apply {
        moveTo(w * 0.02f, h.toFloat())
        lineTo(w * 0.04f, bottomY + h * 0.02f)
        cubicTo(w * 0.08f, bottomY - h * 0.02f, w * 0.14f, bottomY - h * 0.01f, w * 0.18f, bottomY + h * 0.03f)
        lineTo(w * 0.20f, h.toFloat())
        close()
    }
    canvas.drawPath(leftRock, paint)
    // Outline for definition
    paint.style = Paint.Style.STROKE
    paint.color = einkPick(GRAY_GRAVEL, COLOR_GRAVEL)
    paint.strokeWidth = 1.0f
    canvas.drawPath(leftRock, paint)

    // Sand texture lines
    paint.color = einkPick(GRAY_GRAVEL, COLOR_GRAVEL)
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 0.5f
    for (i in 0 until 4) {
        val y = bottomY + (h - bottomY) * (0.3f + i * 0.15f)
        canvas.drawLine(w * 0.05f, y, w * 0.25f + i * w * 0.1f, y + 2f, paint)
    }
}

private fun drawEinkSeaweed(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int, animFrame: Int = 0) {
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 2.0f
    paint.color = einkPick(GRAY_SEAWEED, COLOR_SEAWEED)

    // Sway offset per frame: control points shift 1-2px horizontally (4-frame cycle)
    val swayOffsets = floatArrayOf(0f, 1.5f, 0f, -1.5f)
    val sway = swayOffsets[animFrame % 4]

    // Left wall: 2 wavy stems
    for (stem in 0 until 2) {
        val baseX = w * (0.04f + stem * 0.04f)
        val stemSway = sway * (1f + stem * 0.5f) // second stem sways more
        val path = android.graphics.Path().apply {
            moveTo(baseX, h * 0.85f)
            for (seg in 0 until 4) {
                val segY = h * (0.85f - (seg + 1) * 0.12f)
                val cpX = baseX + (if (seg % 2 == 0) w * 0.02f else -w * 0.01f) + stemSway * (seg + 1) * 0.3f
                quadTo(cpX, segY + h * 0.06f, baseX + (seg % 2) * w * 0.01f + stemSway * (seg + 1) * 0.15f, segY)
            }
        }
        canvas.drawPath(path, paint)
    }

    // Right wall: 1 stem near rocks
    val rightBaseX = w * 0.93f
    val rightPath = android.graphics.Path().apply {
        moveTo(rightBaseX, h * 0.85f)
        for (seg in 0 until 3) {
            val segY = h * (0.85f - (seg + 1) * 0.14f)
            val cpX = rightBaseX + (if (seg % 2 == 0) -w * 0.015f else w * 0.01f) - sway * (seg + 1) * 0.3f
            quadTo(cpX, segY + h * 0.07f, rightBaseX - (seg % 2) * w * 0.005f - sway * (seg + 1) * 0.15f, segY)
        }
    }
    canvas.drawPath(rightPath, paint)
}

private fun drawEinkGravel(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int) {
    val bottomY = h * 0.88f
    paint.color = einkPick(GRAY_GRAVEL, COLOR_GRAVEL)

    // Gravel: small dots along bottom
    paint.style = Paint.Style.FILL
    for (i in 0 until 20) {
        val x = w * (0.05f + i * 0.045f)
        val y = bottomY + (i % 3) * 3f
        canvas.drawCircle(x, y, 1.5f + (i % 2) * 0.8f, paint)
    }

    // Pebbles: small ovals
    paint.color = einkPick(GRAY_PEBBLE, COLOR_PEBBLE)
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 1.2f
    canvas.drawOval(RectF(w * 0.20f, bottomY, w * 0.26f, bottomY + h * 0.04f), paint)
    canvas.drawOval(RectF(w * 0.40f, bottomY + 2f, w * 0.45f, bottomY + h * 0.035f), paint)
    canvas.drawOval(RectF(w * 0.60f, bottomY + 1f, w * 0.64f, bottomY + h * 0.03f), paint)

    // Additional ripple strokes for sand texture
    paint.color = einkPick(GRAY_GRAVEL, COLOR_GRAVEL)
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 0.8f
    val rippleY1 = bottomY + (h - bottomY) * 0.2f
    val rippleY2 = bottomY + (h - bottomY) * 0.4f
    val rippleY3 = bottomY + (h - bottomY) * 0.6f
    canvas.drawLine(w * 0.08f, rippleY1, w * 0.30f, rippleY1 + 1f, paint)
    canvas.drawLine(w * 0.35f, rippleY2, w * 0.55f, rippleY2 + 1f, paint)
    canvas.drawLine(w * 0.60f, rippleY3, w * 0.78f, rippleY3 + 1f, paint)
    canvas.drawLine(w * 0.15f, rippleY3 + 4f, w * 0.40f, rippleY3 + 5f, paint)
}

/** E-ink light rays — 2 fixed-position gray gradient rectangles that shift every 8 frames. */
private fun drawEinkLightRays(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int, animFrame: Int) {
    paint.style = Paint.Style.FILL
    // Alternate between 2 position sets every 8 frames
    val set = (animFrame / 8) % 2
    val positions = if (set == 0) floatArrayOf(0.25f, 0.65f) else floatArrayOf(0.35f, 0.78f)

    for (pos in positions) {
        val cx = w * pos
        val topW = w * 0.02f
        val botW = w * 0.06f
        val rayH = h * 0.45f

        // Simple trapezoid with fading gray
        paint.color = einkPick(GRAY_AIR, COLOR_AIR)
        val path = android.graphics.Path().apply {
            moveTo(cx - topW, 0f)
            lineTo(cx + topW, 0f)
            lineTo(cx + botW, rayH)
            lineTo(cx - botW, rayH)
            close()
        }
        // Use a shader for gradient effect
        paint.shader = android.graphics.LinearGradient(
            cx, 0f, cx, rayH,
            einkPick(GRAY_AIR, COLOR_AIR), einkPick(GRAY_WATER_BG, COLOR_WATER_BG),
            android.graphics.Shader.TileMode.CLAMP,
        )
        canvas.drawPath(path, paint)
        paint.shader = null
    }
}

/** E-ink water surface — 2px wave at y=4%, gray 0xAA. */
private fun drawEinkWaterSurface(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int, animFrame: Int) {
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 2.0f
    paint.color = einkPick(GRAY_SURFACE_LINE, 0xFF99BBCC.toInt())

    val surfaceY = h * 0.04f
    val phase = animFrame * 0.3f
    val path = android.graphics.Path().apply {
        moveTo(0f, surfaceY)
        var x = 0f
        while (x <= w) {
            val y = surfaceY + kotlin.math.sin((x * 0.01f + phase).toDouble()).toFloat() * 3f
            lineTo(x, y)
            x += 4f
        }
    }
    canvas.drawPath(path, paint)
}

/** E-ink ground cover grass — 8-10 short 2px strokes near sand, gray 0x55, static. */
private fun drawEinkGrass(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int, animFrame: Int) {
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 2.0f
    paint.color = einkPick(GRAY_SEAWEED, COLOR_GRASS)

    val sandY = h * 0.82f
    val sway = if (animFrame % 4 < 2) 1f else -1f

    // Left cluster
    drawGrassStroke(canvas, paint, w * 0.05f, sandY, h * 0.025f, sway * 0.5f)
    drawGrassStroke(canvas, paint, w * 0.07f, sandY, h * 0.035f, sway)
    drawGrassStroke(canvas, paint, w * 0.10f, sandY, h * 0.030f, sway * 0.7f)
    // Center cluster
    drawGrassStroke(canvas, paint, w * 0.43f, sandY, h * 0.030f, sway * 0.8f)
    drawGrassStroke(canvas, paint, w * 0.45f, sandY, h * 0.040f, sway)
    drawGrassStroke(canvas, paint, w * 0.47f, sandY, h * 0.025f, sway * 0.6f)
    // Right cluster
    drawGrassStroke(canvas, paint, w * 0.84f, sandY, h * 0.035f, -sway)
    drawGrassStroke(canvas, paint, w * 0.87f, sandY, h * 0.030f, -sway * 0.8f)
}

private fun drawGrassStroke(canvas: android.graphics.Canvas, paint: Paint, baseX: Float, baseY: Float, height: Float, sway: Float) {
    canvas.drawLine(baseX, baseY, baseX + sway, baseY - height, paint)
}

// --- Creatures ---

/** E-ink octopus — 14×5 pixel block rendering matching the color OctopusCreature grid. */
@Suppress("UNUSED_PARAMETER")
private fun drawEinkOctopus(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: OctopusVisualState,
    _agentType: String? = null,
    centerXFraction: Float = 0.38f,
    centerYFraction: Float = 0.42f,
    scaleFactor: Float = 1f,
    animFrame: Float = 0f,
    swimFrame: Float = 0f,
    displayName: String? = null,
) {
    // WORKING: slow horizontal wander (sin-based, stateless)
    val wanderX = if (state == OctopusVisualState.WORKING) {
        val phase = swimFrame + ((centerXFraction * 100).toInt() * 13)
        0.08f * kotlin.math.sin(phase * kotlin.math.PI / 16.0).toFloat()
    } else 0f

    val cx = w * (centerXFraction + wanderX)
    // Y-position by state — staggered by X position for natural multi-session variety
    val standingOffset = (centerXFraction - 0.38f) * 0.25f
    val cy = when (state) {
        OctopusVisualState.SLEEPING -> h * (0.78f + standingOffset * 0.5f)
        OctopusVisualState.FLOATING -> h * (0.76f + standingOffset).coerceAtMost(0.80f)
        OctopusVisualState.ASKING -> h * (0.76f + standingOffset).coerceAtMost(0.80f)
        OctopusVisualState.WORKING -> h * (centerYFraction +
            0.02f * kotlin.math.sin(animFrame * kotlin.math.PI / 8).toFloat())
    }

    // Canonical 24×24 Claude Code robot SVG path (EvenOdd eye cutouts) — shared
    // with the tablet renderer via CreatureGeometry, replacing the old 12×8 block grid.
    val bodyWidth = w * 0.10f * scaleFactor

    // SLEEPING: dimmer body
    val bodyColor = if (state == OctopusVisualState.SLEEPING) {
        einkPick(GRAY_SEAWEED, COLOR_OCTO_SLEEP)
    } else {
        einkPick(GRAY_OCTO_BODY, COLOR_OCTO_BODY)
    }

    paint.style = Paint.Style.FILL
    paint.color = bodyColor

    // Map the 24×24 viewBox so the robot width == bodyWidth, centered on (cx, cy).
    val svgScale = bodyWidth / CreatureGeometry.OCTOPUS_VIEWBOX
    // Name tag anchors to the robot's true top (path min-y ≈ viewBox y=5 of 24), not the box edge.
    val startY = cy - bodyWidth / 2f + svgScale * 5f
    canvas.save()
    canvas.translate(cx, cy)
    canvas.scale(svgScale, svgScale)
    canvas.translate(-CreatureGeometry.OCTOPUS_VIEWBOX / 2f, -CreatureGeometry.OCTOPUS_VIEWBOX / 2f)
    canvas.drawPath(CreatureGeometry.octopusNativePath, paint)
    canvas.restore()

    // Name tag FIRST (behind bubble) — multi-session only
    if (displayName != null) {
        drawEinkNameTag(canvas, paint, cx, startY, scaleFactor, displayName, w)
    }

    // ASKING: speech bubble with "?" — beside body center
    if (state == OctopusVisualState.ASKING) {
        val bubbleR = bodyWidth * 0.25f * scaleFactor
        val bubbleX = cx + bodyWidth * 0.6f
        val bubbleY = cy

        paint.color = einkPick(GRAY_AIR, COLOR_AIR)
        paint.style = Paint.Style.FILL
        canvas.drawCircle(bubbleX, bubbleY, bubbleR, paint)
        paint.color = einkPick(GRAY_OCTO_LIMB, COLOR_OCTO_LIMB)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.5f * scaleFactor
        canvas.drawCircle(bubbleX, bubbleY, bubbleR, paint)

        paint.color = android.graphics.Color.BLACK
        paint.style = Paint.Style.FILL
        paint.textSize = bubbleR * 1.4f
        paint.textAlign = Paint.Align.CENTER
        canvas.drawText("?", bubbleX, bubbleY + bubbleR * 0.45f, paint)
        paint.textAlign = Paint.Align.LEFT
    }
}

/** E-ink name tag above octopus — adaptive font with 2-line wrapping, text-fit width. */
private fun drawEinkNameTag(
    canvas: android.graphics.Canvas, paint: Paint,
    cx: Float, bodyTopY: Float, scaleFactor: Float,
    name: String, w: Int,
) {
    val bodyMetric = creatureNameTagMetric(w.toFloat(), scaleFactor)

    paint.textAlign = Paint.Align.CENTER
    val layout = resolveCreatureNameTagLayout(
        name = name,
        bodyTopY = bodyTopY,
        bodyMetric = bodyMetric,
        paint = paint,
    )
    val tagTop = (layout.tagBottomY - layout.tagHeight).coerceAtLeast(2f)

    // Background rounded rect for readability
    paint.color = einkPick(GRAY_WATER_BG, COLOR_WATER_BG)
    paint.style = Paint.Style.FILL
    val rect = RectF(cx - layout.tagWidth / 2, tagTop, cx + layout.tagWidth / 2, tagTop + layout.tagHeight)
    canvas.drawRoundRect(rect, 3f, 3f, paint)
    // Border for separation from background
    paint.color = einkPick(GRAY_OCTO_LIMB, COLOR_OCTO_LIMB)
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 1f
    canvas.drawRoundRect(rect, 3f, 3f, paint)

    // Text in dark gray for contrast
    paint.color = GRAY_CREATURE
    paint.style = Paint.Style.FILL
    paint.textSize = layout.fontSize

    if (layout.lines.size == 1) {
        canvas.drawText(layout.lines[0], cx, layout.tagBottomY - layout.tagHeight * 0.25f, paint)
    } else {
        val topTextY = tagTop + layout.fontSize * CreatureNameTagStyle.MULTILINE_EXTRA_RATIO + layout.fontSize
        for (i in layout.lines.indices) {
            canvas.drawText(layout.lines[i], cx, topTextY + i * layout.lineHeight, paint)
        }
    }

    paint.textAlign = Paint.Align.LEFT
}

/**
 * E-ink Codex creature using the canonical design/brand/codex.svg path.
 *
 * Y position depends on state:
 *  - WORKING: hovers in the layout slot (upper swim area)
 *  - IDLE/FLOATING/ASKING: rests near the ground so idle sessions don't clutter the sky
 *  - SLEEPING: ground level, dim
 */
private fun drawEinkCloud(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: OctopusVisualState,
    centerXFraction: Float = 0.55f,
    centerYFraction: Float = 0.20f,
    scaleFactor: Float = 1f,
    animFrame: Float = 0f,
    swimFrame: Float = 0f,
    displayName: String? = null,
) {
    // Horizontal wander when WORKING (same pattern as octopus)
    val wanderX = if (state == OctopusVisualState.WORKING) {
        val phase = swimFrame + ((centerXFraction * 100).toInt() * 11)
        0.06f * kotlin.math.sin(phase * kotlin.math.PI / 16.0).toFloat()
    } else 0f

    val cx = w * (centerXFraction + wanderX)
    // State-based Y: WORKING uses layout swim slot (top),
    // IDLE/SLEEPING rests near ground so idle sessions don't hover up top.
    // homeY-relative (not a shared constant) so idle Cloud creatures rest in
    // their own strip instead of converging with OpenCode/Antigravity.
    val restY = (centerYFraction + 0.30f).coerceIn(0.58f, 0.62f)
    val baseYFraction = when (state) {
        OctopusVisualState.WORKING -> centerYFraction
        OctopusVisualState.ASKING -> (centerYFraction + restY) * 0.5f
        OctopusVisualState.FLOATING -> restY
        OctopusVisualState.SLEEPING -> restY + 0.02f
    }
    val bobY = when (state) {
        OctopusVisualState.SLEEPING -> h * 0.006f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 12).toFloat()
        OctopusVisualState.FLOATING -> h * 0.008f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 10).toFloat()
        OctopusVisualState.ASKING -> h * 0.006f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 6).toFloat()
        OctopusVisualState.WORKING -> h * 0.02f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 8).toFloat()
    }
    val cy = h * baseYFraction + bobY

    // Breath animation — subtle scale pulse for active states
    val breathScale = when (state) {
        OctopusVisualState.WORKING -> 1f + 0.04f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 2.0).toFloat()
        OctopusVisualState.ASKING -> 1f + 0.02f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 2.0).toFloat()
        OctopusVisualState.FLOATING -> 1f + 0.015f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 2.0).toFloat()
        OctopusVisualState.SLEEPING -> 0.95f
    }

    val bodyColor = if (state == OctopusVisualState.SLEEPING) {
        einkPick(GRAY_CLOUD_SLEEP, COLOR_CLOUD_SLEEP)
    } else {
        einkPick(GRAY_CLOUD_BODY, COLOR_CLOUD_BODY)
    }

    // Keep it a little larger than the tablet color renderer: e-ink loses fine
    // detail and the prompt cutout must stay readable from a desk distance.
    val bodyRadius = w * 0.070f * scaleFactor
    val br = bodyRadius * breathScale
    paint.style = Paint.Style.FILL
    paint.color = bodyColor

    val markSize = br * 1.25f
    val path = android.graphics.Path(CreatureGeometry.codexNativePath)
    val matrix = android.graphics.Matrix().apply {
        setScale(markSize / CreatureGeometry.CODEX_VIEWBOX, markSize / CreatureGeometry.CODEX_VIEWBOX)
        postTranslate(cx - markSize / 2f, cy - markSize / 2f)
    }
    path.transform(matrix)
    canvas.drawPath(path, paint)

    // Effective body extents for positioning
    val bodyHeight = markSize / 2f
    val bodyExtentX = markSize / 2f

    // Name tag above cloud (reuse the shared name tag renderer)
    if (displayName != null) {
        drawEinkNameTag(canvas, paint, cx, cy - bodyHeight, scaleFactor, displayName, w)
    }

    // ASKING: speech bubble with "?" beside body (same pattern as octopus)
    if (state == OctopusVisualState.ASKING) {
        val bubbleR = bodyExtentX * 0.35f
        val bubbleX = cx + bodyExtentX + bubbleR * 0.8f
        val bubbleY = cy

        paint.color = einkPick(GRAY_AIR, COLOR_AIR)
        paint.style = Paint.Style.FILL
        canvas.drawCircle(bubbleX, bubbleY, bubbleR, paint)
        paint.color = einkPick(GRAY_CLOUD_PROMPT, COLOR_CLOUD_PROMPT)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.5f * scaleFactor
        canvas.drawCircle(bubbleX, bubbleY, bubbleR, paint)

        paint.color = android.graphics.Color.BLACK
        paint.style = Paint.Style.FILL
        paint.textSize = bubbleR * 1.4f
        paint.textAlign = Paint.Align.CENTER
        canvas.drawText("?", bubbleX, bubbleY + bubbleR * 0.45f, paint)
        paint.textAlign = Paint.Align.LEFT
    }
}

/** E-ink crayfish — front-facing SVG path rendering with claw/antenna animation. */
/**
 * E-ink OpenCode creature — nested-square logo with smooth rounded rects.
 * Outer frame (#F1ECEC) + inner square (#4B4646).
 * Geometric and clean — no organic features.
 */
private fun drawEinkOpenCode(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: OctopusVisualState,
    centerXFraction: Float = 0.48f,
    centerYFraction: Float = 0.40f,
    scaleFactor: Float = 1f,
    animFrame: Float = 0f,
    swimFrame: Float = 0f,
    displayName: String? = null,
) {
    val wanderX = if (state == OctopusVisualState.WORKING) {
        val phase = swimFrame + ((centerXFraction * 100).toInt() * 9)
        0.06f * kotlin.math.sin(phase * kotlin.math.PI / 16.0).toFloat()
    } else 0f

    // Resting states stay left of the crayfish floor territory (e-ink crayfish
    // sits at x 0.75) — the band's right edge otherwise lands on its claws.
    val anchorX = if (state == OctopusVisualState.WORKING) centerXFraction
    else centerXFraction.coerceAtMost(TerrariumLayout.CRAYFISH_CLEAR_MAX_X)
    val cx = w * (anchorX + wanderX)
    // State-based Y: WORKING uses layout swim slot (mid-upper),
    // IDLE/SLEEPING rests near ground so idle sessions don't hover in the water.
    // homeY-relative (not a shared constant) so idle OpenCode creatures rest in
    // their own strip instead of converging with Cloud/Antigravity.
    val restY = (centerYFraction + 0.18f).coerceIn(0.59f, 0.63f)
    val baseYFraction = when (state) {
        OctopusVisualState.WORKING -> centerYFraction
        OctopusVisualState.ASKING -> (centerYFraction + restY) * 0.5f
        OctopusVisualState.FLOATING -> restY
        OctopusVisualState.SLEEPING -> restY + 0.01f
    }
    val bobY = when (state) {
        OctopusVisualState.SLEEPING -> h * 0.006f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 14).toFloat()
        OctopusVisualState.FLOATING -> h * 0.008f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 10).toFloat()
        OctopusVisualState.ASKING -> h * 0.005f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 6).toFloat()
        OctopusVisualState.WORKING -> h * 0.02f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 8).toFloat()
    }
    val cy = h * baseYFraction + bobY

    // Canonical opencode mark: a single-color vertical rectangular RING (16:20) with a
    // HOLLOW center (water shows through), matching opencode.ai — not a filled square
    // with a dark inner. On B&W e-ink the water is light, so the ring uses the dark gray
    // for contrast; on color e-ink it uses the light brand color against the blue water.
    val rectH = w * 0.052f * scaleFactor * 1.6f
    val rectW = rectH * 0.80f
    val thick = rectW * 0.28f
    val cornerR = rectW * 0.06f
    val outerSize = rectH          // reused by the name tag + asking bubble below
    val outerHalf = rectH / 2f

    val frameColor = if (state == OctopusVisualState.SLEEPING) {
        einkPick(GRAY_OPENCODE_SLEEP, COLOR_OPENCODE_SLEEP)
    } else {
        einkPick(GRAY_OPENCODE_INNER, COLOR_OPENCODE_OUTER)
    }

    // Thick rounded-rect stroke = hollow ring (stroke centered → inset by thick/2).
    paint.style = Paint.Style.STROKE
    paint.color = frameColor
    paint.strokeWidth = thick
    canvas.drawRoundRect(
        cx - rectW / 2f + thick / 2f, cy - rectH / 2f + thick / 2f,
        cx + rectW / 2f - thick / 2f, cy + rectH / 2f - thick / 2f,
        cornerR, cornerR, paint,
    )

    // Working state: subtle outer glow
    if (state == OctopusVisualState.WORKING) {
        val glowAlpha = (kotlin.math.sin(animFrame * kotlin.math.PI / 8) * 0.15f + 0.15f).toFloat()
        paint.color = frameColor
        paint.alpha = (glowAlpha * 255).toInt()
        paint.strokeWidth = 2f * scaleFactor
        canvas.drawRoundRect(
            cx - rectW / 2f - 2f, cy - rectH / 2f - 2f,
            cx + rectW / 2f + 2f, cy + rectH / 2f + 2f,
            cornerR + 2f, cornerR + 2f, paint,
        )
        paint.alpha = 255
    }
    paint.style = Paint.Style.FILL

    // Name tag (behind bubble)
    if (displayName != null) {
        drawEinkNameTag(canvas, paint, cx, cy - outerHalf, scaleFactor, displayName, w)
    }

    // ASKING: speech bubble with "?" beside body
    if (state == OctopusVisualState.ASKING) {
        val bubbleR = outerSize * 0.25f * scaleFactor
        val bubbleX = cx + outerSize * 0.6f
        val bubbleY = cy

        paint.color = einkPick(GRAY_AIR, COLOR_AIR)
        paint.style = Paint.Style.FILL
        canvas.drawCircle(bubbleX, bubbleY, bubbleR, paint)
        paint.color = einkPick(GRAY_OPENCODE_INNER, COLOR_OPENCODE_INNER)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.5f * scaleFactor
        canvas.drawCircle(bubbleX, bubbleY, bubbleR, paint)

        paint.color = android.graphics.Color.BLACK
        paint.style = Paint.Style.FILL
        paint.textSize = bubbleR * 1.4f
        paint.textAlign = Paint.Align.CENTER
        canvas.drawText("?", bubbleX, bubbleY + bubbleR * 0.45f, paint)
        paint.textAlign = Paint.Align.LEFT
    }
}

private fun drawEinkAntigravity(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: OctopusVisualState,
    centerXFraction: Float = 0.6f,
    centerYFraction: Float = 0.28f,
    scaleFactor: Float = 1f,
    animFrame: Float = 0f,
    swimFrame: Float = 0f,
    displayName: String? = null,
) {
    val wanderX = if (state == OctopusVisualState.WORKING) {
        val phase = swimFrame + ((centerXFraction * 100).toInt() * 7)
        0.06f * kotlin.math.sin(phase * kotlin.math.PI / 16.0).toFloat()
    } else 0f

    val cx = w * (centerXFraction + wanderX)
    val restY = (centerYFraction + 0.08f + (centerXFraction - 0.7f) * 0.04f)
        .coerceIn(0.24f, 0.48f)
    val baseYFraction = when (state) {
        OctopusVisualState.WORKING -> centerYFraction
        OctopusVisualState.ASKING -> (centerYFraction + restY) * 0.5f
        OctopusVisualState.FLOATING -> restY
        OctopusVisualState.SLEEPING -> restY + 0.01f
    }
    val bobY = when (state) {
        OctopusVisualState.SLEEPING -> h * 0.006f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 14).toFloat()
        OctopusVisualState.FLOATING -> h * 0.008f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 10).toFloat()
        OctopusVisualState.ASKING -> h * 0.005f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 6).toFloat()
        OctopusVisualState.WORKING -> h * 0.02f *
            kotlin.math.sin(animFrame * kotlin.math.PI / 8).toFloat()
    }
    val cy = h * baseYFraction + bobY

    // Peak/arc mark — filled silhouette of the canonical Antigravity path.
    val markSize = w * 0.052f * scaleFactor * if (einkColorEnabled) 2.15f else 1.8f
    val markHalf = markSize / 2f
    val svgScale = markSize / dev.agentdeck.terrarium.CreatureGeometry.ANTIGRAVITY_VIEWBOX

    val bodyColor = if (state == OctopusVisualState.SLEEPING) {
        einkPick(GRAY_ANTIGRAVITY_SLEEP, COLOR_ANTIGRAVITY_SLEEP)
    } else {
        einkPick(GRAY_ANTIGRAVITY_BODY, COLOR_ANTIGRAVITY_BODY)
    }

    val colorActive = einkColorEnabled && state != OctopusVisualState.SLEEPING
    val antigravityShader = if (colorActive) {
        // Gradient endpoints are in viewBox (0..ANTIGRAVITY_VIEWBOX) space — the
        // shader is sampled under the translate+scale CTM applied below, so device
        // coords here would collapse the whole mark onto stop 0 (solid lime).
        // Matches the canonical Compose creature direction: (3,22) -> (22,2).
        LinearGradient(
            3f, 22f,
            22f, 2f,
            intArrayOf(
                COLOR_ANTIGRAVITY_LIME,
                COLOR_ANTIGRAVITY_CYAN,
                COLOR_ANTIGRAVITY_BLUE,
                COLOR_ANTIGRAVITY_PINK,
                COLOR_ANTIGRAVITY_RED,
                COLOR_ANTIGRAVITY_ORANGE,
                COLOR_ANTIGRAVITY_YELLOW,
            ),
            floatArrayOf(0.00f, 0.18f, 0.38f, 0.58f, 0.74f, 0.88f, 1.00f),
            Shader.TileMode.CLAMP,
        )
    } else {
        null
    }
    paint.style = Paint.Style.FILL
    paint.color = bodyColor
    paint.shader = antigravityShader
    canvas.save()
    canvas.translate(cx, cy)
    canvas.scale(svgScale, svgScale)
    canvas.translate(-dev.agentdeck.terrarium.CreatureGeometry.ANTIGRAVITY_VIEWBOX / 2f,
        -dev.agentdeck.terrarium.CreatureGeometry.ANTIGRAVITY_VIEWBOX / 2f)
    if (colorActive) {
        paint.shader = null
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.55f
        paint.strokeJoin = Paint.Join.ROUND
        paint.color = 0xFF1F2A30.toInt()
        canvas.drawPath(dev.agentdeck.terrarium.CreatureGeometry.antigravityNativePath, paint)
        paint.strokeWidth = 0.55f
        paint.color = 0xFFF6FAFC.toInt()
        canvas.drawPath(dev.agentdeck.terrarium.CreatureGeometry.antigravityNativePath, paint)
        paint.style = Paint.Style.FILL
        paint.shader = antigravityShader
    }
    canvas.drawPath(dev.agentdeck.terrarium.CreatureGeometry.antigravityNativePath, paint)
    canvas.restore()
    paint.shader = null
    paint.style = Paint.Style.FILL

    // Name tag
    if (displayName != null) {
        drawEinkNameTag(canvas, paint, cx, cy - markHalf, scaleFactor, displayName, w)
    }

    // ASKING: speech bubble with "?" beside body
    if (state == OctopusVisualState.ASKING) {
        val bubbleR = markSize * 0.25f * scaleFactor
        val bubbleX = cx + markSize * 0.6f
        val bubbleY = cy

        paint.color = einkPick(GRAY_AIR, COLOR_AIR)
        paint.style = Paint.Style.FILL
        canvas.drawCircle(bubbleX, bubbleY, bubbleR, paint)
        paint.color = einkPick(GRAY_ANTIGRAVITY_BODY, COLOR_ANTIGRAVITY_BODY)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.5f * scaleFactor
        canvas.drawCircle(bubbleX, bubbleY, bubbleR, paint)

        paint.color = android.graphics.Color.BLACK
        paint.style = Paint.Style.FILL
        paint.textSize = bubbleR * 1.4f
        paint.textAlign = Paint.Align.CENTER
        canvas.drawText("?", bubbleX, bubbleY + bubbleR * 0.45f, paint)
        paint.textAlign = Paint.Align.LEFT
    }
}

private fun drawEinkCrayfish(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: CrayfishVisualState,
    animFrame: Float = 0f,
) {
    val cx = w * 0.75f
    // Y-position by state — sitting on rock when idle, floating up when active
    // ROUTING: bob animation (match tablet's sin(time*3f) * 0.05f)
    val baseY = when (state) {
        CrayfishVisualState.DORMANT -> h * 0.82f
        CrayfishVisualState.SITTING -> h * 0.72f
        CrayfishVisualState.ROUTING -> h * 0.55f
        CrayfishVisualState.OBSERVING -> h * 0.62f
        CrayfishVisualState.WAITING -> h * 0.60f
        CrayfishVisualState.SICK -> h * 0.76f  // droops lower than sitting
    }
    val bobOffset = when (state) {
        CrayfishVisualState.ROUTING -> h * 0.015f * kotlin.math.sin(animFrame * kotlin.math.PI / 6).toFloat()
        CrayfishVisualState.SICK -> h * 0.005f * kotlin.math.sin(animFrame * kotlin.math.PI / 8).toFloat()  // very slow bob
        else -> 0f
    }
    val cy = baseY + bobOffset
    val bodyWidth = w * 0.11f

    val scale = bodyWidth / CreatureGeometry.OPENCLAW_VIEWBOX
    val offsetX = cx - CreatureGeometry.OPENCLAW_VIEWBOX / 2f * scale
    val offsetY = cy - CreatureGeometry.OPENCLAW_VIEWBOX / 2f * scale

    canvas.save()
    canvas.translate(offsetX, offsetY)
    canvas.scale(scale, scale)
    if (state == CrayfishVisualState.SICK) {
        canvas.rotate(
            -10f,
            CreatureGeometry.OPENCLAW_VIEWBOX / 2f,
            CreatureGeometry.OPENCLAW_VIEWBOX / 2f,
        )
    }

    // Exact design/brand/openclaw.svg mark. State motion moves the whole official
    // silhouette instead of re-articulating an approximate body/claw construction.
    paint.style = Paint.Style.FILL
    paint.color = if (state == CrayfishVisualState.SICK) {
        einkPick(GRAY_CRAY_SICK, COLOR_CRAY_SICK)
    } else {
        einkPick(GRAY_CRAY_BODY, COLOR_CRAY_BODY)
    }
    paint.alpha = if (state == CrayfishVisualState.DORMANT) 105 else 255
    for (path in CreatureGeometry.openClawBodyNativePaths) canvas.drawPath(path, paint)
    for (path in CreatureGeometry.openClawEyeNativePaths) canvas.drawPath(path, paint)
    paint.alpha = 255

    canvas.restore() // main transform

    // ROUTING: signal arcs (outside SVG transform)
    if (state == CrayfishVisualState.ROUTING) {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.5f
        paint.color = einkPick(GRAY_SIGNAL, COLOR_CRAY_SIGNAL)
        paint.strokeCap = Paint.Cap.BUTT
        for (i in 1..3) {
            val r = bodyWidth * 0.15f * i
            canvas.drawArc(
                RectF(cx - r, cy - r, cx + r, cy + r),
                150f, 60f, false, paint,
            )
        }
    }
}

// --- Data particles & labels ---

/**
 * Two-school neon tetra — 10 fish (5+5) optimized for e-ink 600ms frames.
 *
 * School A (5 fish, indices 0-4): left-start elliptical orbit
 * School B (5 fish, indices 5-9): right-start, different period
 *
 * E-ink strategy: heading from path derivative, per-fish orbit speeds, tail wiggle.
 * Depth layers: indices 0-3/5-8 = front, 4/9 = back (smaller, behind creatures).
 *
 * STREAMING: school centers pull 30% toward WORKING octopus + data particles orbit.
 * HOVERING: 7 fish gather near options area, 3 drift at distance.
 */
private const val EINK_FISH_COUNT = 12
private const val EINK_FISH_PER_SCHOOL = 6

// --- Boids-based fish school ---

/** Persistent fish state for boids simulation. */
class EinkFish(
    var x: Float, var y: Float,
    var vx: Float, var vy: Float,
    val schoolId: Int,
)

/**
 * Persistent boids-based fish school. 12 fish in 2 schools (6+6).
 * Lissajous school centers, separation/alignment/cohesion, wall repulsion.
 * Call [update] each animation frame before drawing. [stepScale] is elapsed
 * time relative to the 400ms B&W e-ink cadence, so faster color e-ink redraws
 * interpolate instead of increasing simulation speed.
 */
class EinkFishSchool {
    val fish: List<EinkFish>

    // Lissajous time accumulator (persistent across frames)
    private var time = 0f

    companion object {
        // Boids weights
        private const val SEPARATION_DIST = 0.06f
        private const val SEPARATION_WEIGHT = 0.008f
        private const val ALIGNMENT_WEIGHT = 0.04f
        private const val COHESION_WEIGHT = 0.02f
        private const val SCHOOL_ATTRACTOR_WEIGHT = 0.4f
        private const val AGENT_PULL = 0.30f
        private const val CRAYFISH_PULL = 0.30f
        // Speed limits (normalized per frame at ~2.5fps)
        private const val MAX_SPEED_CIRCLING = 0.015f
        private const val MAX_SPEED_STREAMING = 0.025f
        // Boundaries (normalized 0..1)
        private const val MIN_X = 0.04f; private const val MAX_X = 0.96f
        private const val MIN_Y = 0.10f; private const val MAX_Y = 0.70f
        private const val WALL_MARGIN = 0.05f
        private const val WALL_FORCE = 0.003f
        private const val VY_DAMPING = 0.85f
    }

    init {
        val rng = java.util.Random(42)
        fish = List(EINK_FISH_COUNT) { i ->
            val sid = if (i < EINK_FISH_PER_SCHOOL) 0 else 1
            // Initialize around school center with small random offset
            val baseX = if (sid == 0) 0.35f else 0.55f
            val baseY = if (sid == 0) 0.35f else 0.40f
            EinkFish(
                x = baseX + (rng.nextFloat() - 0.5f) * 0.08f,
                y = baseY + (rng.nextFloat() - 0.5f) * 0.06f,
                vx = (rng.nextFloat() - 0.5f) * 0.005f,
                vy = (rng.nextFloat() - 0.5f) * 0.003f,
                schoolId = sid,
            )
        }
    }

    /**
     * Advance one frame. Call before drawing.
     * @param streaming true if STREAMING state (faster speed, agent pull)
     * @param agentSlots octopus positions (normalized). Empty = no agent pull.
     * @param crayfishRouting true if crayfish is ROUTING (additional pull)
     */
    fun update(
        streaming: Boolean,
        agentSlots: List<dev.agentdeck.terrarium.CreatureSlot>,
        crayfishRouting: Boolean,
        stepScale: Float = 1f,
    ) {
        val dt = stepScale.coerceIn(0f, 1.5f)
        time += 0.08f * dt // match previous time scale
        val maxSpeed = if (streaming) MAX_SPEED_STREAMING else MAX_SPEED_CIRCLING

        // Lissajous school centers
        val ampScale = if (streaming) 0.4f else 1.0f
        val baseXA = if (streaming) 0.42f else 0.35f
        val baseXB = if (streaming) 0.48f else 0.55f
        val baseYA = if (streaming) 0.38f else 0.35f
        val baseYB = if (streaming) 0.38f else 0.40f
        var cxA = baseXA + 0.18f * ampScale * kotlin.math.sin(time * 0.15f).toFloat()
        var cyA = baseYA + 0.12f * ampScale * kotlin.math.sin(time * 0.21f).toFloat()
        var cxB = baseXB + 0.18f * ampScale * kotlin.math.cos(time * 0.13f).toFloat()
        var cyB = baseYB + 0.12f * ampScale * kotlin.math.cos(time * 0.18f).toFloat()

        // Agent pull on school centers
        if (streaming && agentSlots.isNotEmpty()) {
            // Multi-agent: school A→agent[0], school B→agent[min(1, last)]
            val slotA = agentSlots[0]
            val slotB = if (agentSlots.size > 1) agentSlots[1] else agentSlots[0]
            cxA += (slotA.centerXFraction - cxA) * AGENT_PULL
            cyA += (slotA.centerYFraction - cyA) * AGENT_PULL
            cxB += (slotB.centerXFraction - cxB) * AGENT_PULL
            cyB += (slotB.centerYFraction - cyB) * AGENT_PULL
        } else if (!streaming && agentSlots.isNotEmpty()) {
            // CIRCLING: weak pull
            val pull = 0.15f
            val slot = agentSlots[0]
            cxA += (slot.centerXFraction - cxA) * pull
            cyA += (slot.centerYFraction - cyA) * pull
            cxB += (slot.centerXFraction - cxB) * pull
            cyB += (slot.centerYFraction - cyB) * pull
        }

        // Crayfish pull
        if (crayfishRouting) {
            cxA += (0.75f - cxA) * CRAYFISH_PULL
            cyA += (0.55f - cyA) * CRAYFISH_PULL
            cxB += (0.75f - cxB) * CRAYFISH_PULL
            cyB += (0.55f - cyB) * CRAYFISH_PULL
        }

        val schoolCenters = arrayOf(floatArrayOf(cxA, cyA), floatArrayOf(cxB, cyB))

        for (f in fish) {
            var ax = 0f; var ay = 0f

            // -- Separation (all fish) --
            for (other in fish) {
                if (other === f) continue
                val dx = f.x - other.x; val dy = f.y - other.y
                val dist = kotlin.math.sqrt(dx * dx + dy * dy)
                if (dist < SEPARATION_DIST && dist > 0.001f) {
                    ax += (dx / dist) * SEPARATION_WEIGHT / dist
                    ay += (dy / dist) * SEPARATION_WEIGHT / dist
                }
            }

            // -- Alignment + Cohesion (same school only) --
            var avgVx = 0f; var avgVy = 0f; var avgX = 0f; var avgY = 0f; var n = 0
            for (other in fish) {
                if (other === f || other.schoolId != f.schoolId) continue
                avgVx += other.vx; avgVy += other.vy
                avgX += other.x; avgY += other.y; n++
            }
            if (n > 0) {
                avgVx /= n; avgVy /= n; avgX /= n; avgY /= n
                // Alignment: steer toward average heading
                ax += (avgVx - f.vx) * ALIGNMENT_WEIGHT
                ay += (avgVy - f.vy) * ALIGNMENT_WEIGHT
                // Cohesion: steer toward center of school-mates
                ax += (avgX - f.x) * COHESION_WEIGHT
                ay += (avgY - f.y) * COHESION_WEIGHT
            }

            // -- School attractor (Lissajous center) --
            val sc = schoolCenters[f.schoolId]
            ax += (sc[0] - f.x) * SCHOOL_ATTRACTOR_WEIGHT * maxSpeed
            ay += (sc[1] - f.y) * SCHOOL_ATTRACTOR_WEIGHT * maxSpeed

            // -- Wall repulsion --
            if (f.x < MIN_X + WALL_MARGIN) ax += WALL_FORCE
            if (f.x > MAX_X - WALL_MARGIN) ax -= WALL_FORCE
            if (f.y < MIN_Y + WALL_MARGIN) ay += WALL_FORCE
            if (f.y > MAX_Y - WALL_MARGIN) ay -= WALL_FORCE

            // Apply acceleration
            f.vx += ax * dt; f.vy += ay * dt
            // Vertical damping (fish prefer horizontal movement)
            val damping = (1f - (1f - VY_DAMPING) * dt).coerceIn(0f, 1f)
            f.vy *= damping

            // Speed limit
            val speed = kotlin.math.sqrt(f.vx * f.vx + f.vy * f.vy)
            if (speed > maxSpeed) {
                f.vx = f.vx / speed * maxSpeed
                f.vy = f.vy / speed * maxSpeed
            }

            // Integrate position
            f.x = (f.x + f.vx * dt).coerceIn(MIN_X, MAX_X)
            f.y = (f.y + f.vy * dt).coerceIn(MIN_Y, MAX_Y)
        }
    }
}

private fun drawEinkDataParticles(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: TetraVisualState,
    agentCount: Int,
    crayfishState: CrayfishVisualState = CrayfishVisualState.DORMANT,
    animFrame: Float = 0f,
    layer: Int = -1, // -1 = all, 0 = back (behind creatures), 1 = front
    fishSchool: EinkFishSchool? = null,
) {
    if (state == TetraVisualState.ABSENT) return

    val slots = dev.agentdeck.terrarium.layoutOctopuses(agentCount.coerceAtLeast(1))
    val crayfishRouting = crayfishState == CrayfishVisualState.ROUTING
    val fishSize = w * 0.014f  // slightly larger with fewer fish

    if ((state == TetraVisualState.STREAMING || state == TetraVisualState.CIRCLING) && fishSchool != null) {
        // Boids-based rendering: read persistent positions from fishSchool
        for (i in 0 until EINK_FISH_COUNT) {
            val fishLayer = if (i % EINK_FISH_PER_SCHOOL == EINK_FISH_PER_SCHOOL - 1) 0 else 1
            if (layer != -1 && fishLayer != layer) continue
            val depthScale = if (fishLayer == 0) 0.80f else 1.0f

            val f = fishSchool.fish[i]
            val fx = f.x * w
            val fy = f.y * h
            val heading = if (f.vx >= 0f) 0f else 180f
            val localIdx = i % EINK_FISH_PER_SCHOOL
            val tailPhase = (floor(animFrame).toInt() + localIdx * 2).floorMod(4)

            drawEinkFish(canvas, paint, fx, fy, fishSize * depthScale, heading, tailPhase)
        }

        // STREAMING: data particles (orbit around active agent or crayfish)
        if (state == TetraVisualState.STREAMING && (layer == -1 || layer == 1)) {
            val particleCenterX: Float
            val particleCenterY: Float
            if (agentCount > 0 && slots.isNotEmpty()) {
                particleCenterX = w * slots[0].centerXFraction
                particleCenterY = h * (slots[0].centerYFraction +
                    0.02f * kotlin.math.sin(animFrame * kotlin.math.PI / 8).toFloat())
            } else if (crayfishRouting) {
                particleCenterX = w * 0.75f
                particleCenterY = h * 0.55f
            } else {
                particleCenterX = Float.NaN
                particleCenterY = Float.NaN
            }
            if (!particleCenterX.isNaN()) {
                val agentX = particleCenterX
                val agentY = particleCenterY
                val particleR = w * 0.06f
                paint.style = Paint.Style.FILL
                paint.color = einkPick(GRAY_PARTICLE, COLOR_PARTICLE)
                for (p in 0 until 4) {
                    val angle = animFrame * 0.8 + p * kotlin.math.PI / 2.0
                    val pr = particleR * (0.6f + 0.4f * kotlin.math.sin(animFrame * 0.5 + p * 1.2).toFloat())
                    val px = agentX + kotlin.math.cos(angle).toFloat() * pr
                    val py = agentY + kotlin.math.sin(angle).toFloat() * pr
                    canvas.drawCircle(px, py, 1.5f + (p % 2) * 0.5f, paint)
                }
            }
        }

        // Dashed lines between agents (front layer only)
        if ((layer == -1 || layer == 1) && slots.size > 1) {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 0.5f
            paint.color = GRAY_PARTICLE
            paint.pathEffect = DashPathEffect(floatArrayOf(4f, 4f), 0f)
            for (i in 0 until slots.size - 1) {
                val a = slots[i]; val b = slots[i + 1]
                canvas.drawLine(w * a.centerXFraction, h * a.centerYFraction,
                    w * b.centerXFraction, h * b.centerYFraction, paint)
            }
            paint.pathEffect = null
        }
    } else if (state == TetraVisualState.HOVERING) {
        // HOVERING: fish gather near option area (matching tablet behavior)
        val time = animFrame * 0.08f
        val nearX = w * 0.45f + w * 0.012f * kotlin.math.cos(time * 0.3).toFloat()
        val nearY = h * 0.35f

        for (i in 0 until EINK_FISH_COUNT) {
            val fishLayer = if (i % EINK_FISH_PER_SCHOOL == EINK_FISH_PER_SCHOOL - 1) 0 else 1
            if (layer != -1 && fishLayer != layer) continue
            val depthScale = if (fishLayer == 0) 0.80f else 1.0f

            val isNear = i < 7  // 7 gather, 3 drift
            val localIdx = i % EINK_FISH_PER_SCHOOL
            val wanderSeed = localIdx * 1.47f + i * 0.83f
            val bx: Float; val by: Float; val vx: Float
            if (isNear) {
                val ang = time * (0.4f + localIdx * 0.1f) + wanderSeed
                bx = nearX + kotlin.math.cos(ang.toDouble()).toFloat() * w * 0.04f
                by = nearY + kotlin.math.sin(ang.toDouble() * 0.8).toFloat() * h * 0.03f
                vx = -kotlin.math.sin(ang.toDouble()).toFloat()
            } else {
                val ang = time * (0.3f + i * 0.07f) + wanderSeed
                bx = w * 0.50f + kotlin.math.cos(ang.toDouble()).toFloat() * w * 0.10f
                by = h * 0.45f + kotlin.math.sin(ang.toDouble() * 0.7).toFloat() * h * 0.06f
                vx = -kotlin.math.sin(ang.toDouble()).toFloat()
            }

            val fx = bx.coerceIn(w * 0.05f, w * 0.95f)
            val fy = by.coerceIn(h * 0.10f, h * 0.72f)
            val heading = if (vx >= 0f) 0f else 180f
            val tailPhase = (floor(animFrame).toInt() + localIdx * 2).floorMod(4)

            drawEinkFish(canvas, paint, fx, fy, fishSize * depthScale, heading, tailPhase)
        }
    }
}

/**
 * Draw a single e-ink fish — teardrop body with neon stripe, animated tail.
 * [tailPhase] 0-3 drives tail wiggle (4 positions per cycle).
 */
private fun drawEinkFish(
    canvas: android.graphics.Canvas, paint: Paint,
    cx: Float, cy: Float, size: Float, heading: Float,
    tailPhase: Int = 0,
) {
    canvas.save()
    canvas.rotate(heading, cx, cy)

    val halfLen = size * 1.8f
    val halfH = size * 0.75f
    // Tail wiggle: 4-phase sinusoidal offset (±30% of halfH)
    val tailWiggle = when (tailPhase % 4) {
        0 -> 0f
        1 -> halfH * 0.30f
        2 -> 0f
        else -> -halfH * 0.30f
    }

    // Body — asymmetric diamond (wider toward head for fish shape)
    paint.style = Paint.Style.FILL
    paint.color = einkPick(GRAY_FISH_BODY, COLOR_FISH_BODY)
    val bodyPath = android.graphics.Path().apply {
        moveTo(cx + halfLen, cy)                         // nose
        lineTo(cx + halfLen * 0.1f, cy - halfH)         // top (shifted forward)
        lineTo(cx - halfLen, cy + tailWiggle)            // tail base (wiggle)
        lineTo(cx + halfLen * 0.1f, cy + halfH)         // bottom
        close()
    }
    canvas.drawPath(bodyPath, paint)

    // Body outline for e-ink crispness
    paint.style = Paint.Style.STROKE
    paint.color = GRAY_CREATURE
    paint.strokeWidth = 0.8f
    canvas.drawPath(bodyPath, paint)

    // Neon stripe — lighter highlight for the signature tetra feature
    paint.color = einkPick(GRAY_FISH_STRIPE, COLOR_FISH_STRIPE)
    paint.strokeWidth = size * 0.22f
    paint.strokeCap = Paint.Cap.ROUND
    canvas.drawLine(cx - halfLen * 0.3f, cy, cx + halfLen * 0.6f, cy, paint)

    // Tail — filled forked V with wiggle
    paint.color = einkPick(GRAY_FISH_BODY, COLOR_FISH_BODY)
    paint.style = Paint.Style.FILL
    val tailX = cx - halfLen
    val tailPath = android.graphics.Path().apply {
        moveTo(tailX, cy + tailWiggle)
        lineTo(tailX - halfLen * 0.4f, cy + tailWiggle - halfH * 0.9f)
        lineTo(tailX + halfLen * 0.1f, cy + tailWiggle)
        lineTo(tailX - halfLen * 0.4f, cy + tailWiggle + halfH * 0.9f)
        close()
    }
    canvas.drawPath(tailPath, paint)
    paint.style = Paint.Style.STROKE
    paint.color = GRAY_CREATURE
    paint.strokeWidth = 0.6f
    canvas.drawPath(tailPath, paint)

    // Eye — white with black pupil for visibility
    paint.style = Paint.Style.FILL
    paint.color = android.graphics.Color.WHITE
    canvas.drawCircle(cx + halfLen * 0.45f, cy - halfH * 0.15f, size * 0.14f, paint)
    paint.color = android.graphics.Color.BLACK
    canvas.drawCircle(cx + halfLen * 0.45f, cy - halfH * 0.15f, size * 0.07f, paint)

    canvas.restore()
}

/**
 * Vendor-specific EPD refresh control.
 *
 * Rockchip RK3566 (Crema S, Xiaomi Reader, etc.):
 *   Uses `android.os.EinkManager` system service with string-based mode constants.
 *   Reference: KOReader's RK35xxEPDController.
 *   EPD modes: "2"=FULL_GC16, "7"=PART_GC16, "12"=A2, "14"=DU
 *
 * Onyx Boox (Qualcomm):
 *   Uses `com.onyx.android.sdk.device.BaseDevice` with UpdateMode enum.
 */
object EinkRefreshHelper {

    // Rockchip EPD mode constants (string values for EinkManager.setMode)
    private const val RK_EPD_FULL_GC16 = "2"
    private const val RK_EPD_A2 = "12"
    private const val RK_EPD_DU = "14"

    // B&W animation policy — user priority: minimize flash, accept slower
    // motion / more residual ghost.
    //
    // - No periodic full-frame GC16 cleanup. Forced full refresh on Rockchip
    //   is GC16-only (sendOneFullFrame is hardcoded), and any cadence that
    //   produces visible flashes was unwanted regardless of length. Natural
    //   GC16 events (ATTENTION onset, agent state transition, explicit
    //   [requestFullRefresh] calls) handle cleanup when they occur; pure-
    //   idle terrarium stretches accept accumulated ghost as the trade-off.
    //
    // - Per-frame waveform: DU partial (4-level), not GC16 partial. The
    //   4-level transition has noticeably less per-frame contrast inversion
    //   than 16-level, so individual creature/fish frames read as a quiet
    //   settle rather than a micro-flash. Grayscale detail compresses to
    //   4 levels (creature shading flatter), accepted trade-off.

    /** Full/normal refresh — clears ghosting and exits fast animation mode. */
    fun requestFullRefresh(view: View) {
        // B&W e-ink gets an explicit full-frame GC16 flash. Color e-ink uses
        // the same mode switch without forcing a full monochrome frame, which
        // restores quality after animation/A2 frames.
        if (tryRockchipRefresh(view, RK_EPD_FULL_GC16, sendFullFrame = !einkColorEnabled)) return

        try {
            // Onyx: com.onyx.android.sdk.device.Device.requestScreenUpdate()
            val onyxClass = Class.forName("com.onyx.android.sdk.device.Device")
            onyxClass.getMethod("requestScreenUpdate", View::class.java).invoke(null, view)
            return
        } catch (_: Exception) {}

        // Kobo / Tolino / KOReader-style: write the EPD waveform via mxcfb ioctl
        // wrapper exposed as a system property bridge on some devices.
        if (tryKoboRefresh(view, koboMode = "GC16")) return

        // Fallback: standard invalidate
        view.invalidate()
    }

    /**
     * Kobo / Tolino fallback (KOReader-compatible).
     * Devices that ship neither EinkManager nor the Onyx SDK still expose a
     * waveform hint through the `sys.eink.update` system property, which the
     * vendor's display HAL picks up. This path is best-effort and silently
     * degrades to a normal invalidate on devices that ignore it.
     */
    private fun tryKoboRefresh(view: View, koboMode: String): Boolean {
        return try {
            val systemProps = Class.forName("android.os.SystemProperties")
            val set = systemProps.getMethod("set", String::class.java, String::class.java)
            set.invoke(null, "sys.eink.update", koboMode)
            view.invalidate()
            true
        } catch (_: Exception) {
            false
        }
    }

    fun requestPartialRefresh(view: View) {
        view.invalidate()
    }

    /** A2 mode — fastest binary refresh, ideal for state markers and timeline. */
    fun requestA2Refresh(view: View) {
        if (tryRockchipRefresh(view, RK_EPD_A2)) return

        try {
            // Onyx: setViewDefaultUpdateMode with ANIMATION/A2
            val deviceClass = Class.forName("com.onyx.android.sdk.device.BaseDevice")
            val instance = deviceClass.getMethod("currentDevice").invoke(null)
            val updateModeClass = Class.forName("com.onyx.android.sdk.device.BaseDevice\$UpdateMode")
            val a2Mode = updateModeClass.getField("ANIMATION").get(null)
            deviceClass.getMethod("setViewDefaultUpdateMode", View::class.java, updateModeClass)
                .invoke(instance, view, a2Mode)
            view.invalidate()
            return
        } catch (_: Exception) {}

        // Kobo / Tolino — sys.eink.update bridge accepts mode strings.
        if (tryKoboRefresh(view, koboMode = "A2")) return

        // Fallback
        view.invalidate()
    }

    /** Animation refresh — platform-specific:
     *  B&W e-ink: DU partial (4-level) on every supported vendor path —
     *    Rockchip mode "14", Onyx UpdateMode.DU, Kobo "sys.eink.update=DU".
     *    Each path delivers a low-contrast partial transition per frame,
     *    so flash is minimized uniformly across vendors (not just Rockchip).
     *    No periodic cleanup; ghost accumulates between natural GC16 events
     *    (ATTENTION onset, state transition). Trade-off: flash min > fidelity.
     *  Color e-ink: fast animation/A2 mode. Self-cleaning per frame.
     */
    fun requestAnimationRefresh(view: View) {
        if (einkColorEnabled) {
            requestA2Refresh(view)
            return
        }
        // Delegate to the shared DU path — already wired for Rockchip + Onyx;
        // Kobo branch added below in [requestDURefresh] so all three vendors
        // honor the flash-min animation policy.
        requestDURefresh(view)
    }

    /** DU mode — fast monochrome refresh, ideal for usage gauges, footer,
     *  and B&W animation frames (flash-min policy). */
    fun requestDURefresh(view: View) {
        if (tryRockchipRefresh(view, RK_EPD_DU)) return

        try {
            // Onyx: setViewDefaultUpdateMode with DU
            val deviceClass = Class.forName("com.onyx.android.sdk.device.BaseDevice")
            val instance = deviceClass.getMethod("currentDevice").invoke(null)
            val updateModeClass = Class.forName("com.onyx.android.sdk.device.BaseDevice\$UpdateMode")
            val duMode = updateModeClass.getField("DU").get(null)
            deviceClass.getMethod("setViewDefaultUpdateMode", View::class.java, updateModeClass)
                .invoke(instance, view, duMode)
            view.invalidate()
            return
        } catch (_: Exception) {}

        // Kobo / Tolino — sys.eink.update bridge.
        if (tryKoboRefresh(view, koboMode = "DU")) return

        // Fallback
        view.invalidate()
    }

    /**
     * Rockchip RK35xx EPD refresh via android.os.EinkManager system service.
     * Sets display mode and optionally triggers a full GC16 frame.
     */
    @android.annotation.SuppressLint("WrongConstant")
    private fun tryRockchipRefresh(view: View, mode: String, sendFullFrame: Boolean = false): Boolean {
        return try {
            val einkManagerClass = Class.forName("android.os.EinkManager")
            val einkManager = view.context.getSystemService("eink") ?: return false

            // Set EPD waveform mode
            val setMode = einkManagerClass.getDeclaredMethod("setMode", String::class.java)
            setMode.invoke(einkManager, mode)

            if (sendFullFrame) {
                // Force a single full-screen GC16 refresh (guaranteed grayscale)
                val sendOneFullFrame = einkManagerClass.getDeclaredMethod("sendOneFullFrame")
                sendOneFullFrame.invoke(einkManager)
            }

            view.invalidate()
            true
        } catch (_: Exception) {
            false
        }
    }
}

/** Snap coordinate to nearest grid multiple for retro pixel-art feel. */
private fun snapToGrid(value: Float, grid: Float): Float =
    kotlin.math.round(value / grid) * grid

private const val EINK_WIDTH = 600
private const val EINK_HEIGHT = 300

/**
 * Native 16-level grayscale palette for e-ink hardware.
 * Values mapped to hardware gray levels (0=black, 255=white, step ~17).
 * Spread across the full range for visible tonal separation on e-ink.
 */
private const val GRAY_WATER_BG   = 0xFFDDDDDD.toInt()  // level 13 — water background (frame = water)
private const val GRAY_CREATURE   = 0xFF222222.toInt()  // level 2 — eyes, outlines, darkest details
private const val GRAY_ROCK       = 0xFF999999.toInt()  // level 9 — rocks (lighter than creatures for contrast)
private const val GRAY_OCTO_BODY  = 0xFF444444.toInt()  // level 4 — octopus body (mid-dark gray)
private const val GRAY_OCTO_LIMB  = 0xFF333333.toInt()  // level 3 — octopus arms/tentacles (darker than body)
private const val GRAY_CRAY_BODY  = 0xFF555555.toInt()  // level 5 — crayfish body (medium, distinct from claws)
private const val GRAY_CRAY_CLAW  = 0xFF333333.toInt()  // level 3 — crayfish claws (darker than body)
private const val GRAY_CRAY_SICK  = 0xFF666666.toInt()  // level 6 — washed out when sick
private const val GRAY_CLOUD_BODY = 0xFF555555.toInt()  // level 5 — cloud body (slightly lighter than octopus 0x44)
private const val GRAY_CLOUD_PROMPT = 0xFF222222.toInt()  // level 2 — >_ terminal prompt text
private const val GRAY_CLOUD_SLEEP = 0xFF888888.toInt()  // level 8 — dormant/sleeping cloud (faded)
private const val GRAY_OPENCODE_OUTER = 0xFF888888.toInt() // level 8 — outer frame (visible contrast vs water BG level 13)
private const val GRAY_OPENCODE_INNER = 0xFF444444.toInt() // level 4 — inner square (dark gray)
private const val GRAY_OPENCODE_SLEEP = 0xFFAAAAAA.toInt() // level 10 — sleeping/dormant (faded, distinct from active outer)
private const val GRAY_ANTIGRAVITY_BODY = 0xFF303030.toInt() // dark peak/arc body for B/W e-ink
private const val GRAY_ANTIGRAVITY_SLEEP = 0xFF777777.toInt() // sleeping/dormant (faded)
private const val GRAY_STARBURST  = 0xFF999999.toInt()  // level 9 — WORKING starburst glow
private const val GRAY_DECORATION = 0xFF444444.toInt()  // level 4 — keyboard, review docs
private const val GRAY_SEAWEED    = 0xFF666666.toInt()  // level 6 — seaweed stems
private const val GRAY_SIGNAL     = 0xFF555555.toInt()  // level 5 — signal arcs
private const val GRAY_GRAVEL     = 0xFF777777.toInt()  // level 7 — gravel, sand
private const val GRAY_WAVE       = 0xFF777777.toInt()  // level 7 — water surface stroke
private const val GRAY_PEBBLE     = 0xFF999999.toInt()  // level 9 — pebbles
private const val GRAY_PARTICLE   = 0xFF888888.toInt()  // level 8 — data particles
private const val GRAY_FISH_BODY  = 0xFF555555.toInt()  // level 5 — fish body (darker for water contrast)
private const val GRAY_FISH_STRIPE = 0xFFBBBBBB.toInt() // level 11 — fish neon stripe highlight
private const val GRAY_BUBBLE     = 0xFFAAAAAA.toInt()  // level 10 — bubbles
private const val GRAY_SAND       = 0xFFCCCCCC.toInt()  // level 12 — sand floor (subtle against water)
private const val GRAY_AIR        = 0xFFEEEEEE.toInt()  // level 14 — air above surface
private const val GRAY_SURFACE_LINE = 0xFFAAAAAA.toInt() // level 10 — water surface line

// --- Color e-ink palette (Kaleido 3) ---
// Saturated fills for CFA color rendering. Kaleido renders color at 1/4 resolution (150 PPI),
// so these are used ONLY for large fills (creature bodies, sand, water) — never small text.
// Palette chosen for maximum saturation on Kaleido 3's 4096-color gamut.

/** Lazy-init flag: true when running on a color e-ink device (Kaleido 3, Gallery 3/4). */
internal val einkColorEnabled: Boolean by lazy {
    dev.agentdeck.util.DeviceProfileHolder.current.isColorEink
}

/** Pick gray or color constant based on display capability. */
private fun einkPick(gray: Int, color: Int): Int = if (einkColorEnabled) color else gray

// Warm earth-tone palette for Kaleido 3 — "printed illustration" aesthetic
// Light water background for creature visibility, warm earth tones for paper feel.
// Kaleido CFA adds greenish tint — warm palette compensates.

// Water — light blue-teal (creatures must be clearly visible against this)
private val COLOR_WATER_BG     = 0xFF8BBAD0.toInt()  // soft sky-blue water
private val COLOR_AIR          = 0xFFE8DCC8.toInt()  // warm cream above surface

// Sand — warm ochre
private val COLOR_SAND         = 0xFFD4B896.toInt()  // golden sand
private val COLOR_GRAVEL       = 0xFFB09870.toInt()  // sand shadow/gravel
private val COLOR_PEBBLE       = 0xFF9A8860.toInt()  // pebble

// Environment — muted natural greens and browns
private val COLOR_SEAWEED      = 0xFF3B7B4A.toInt()  // forest green
private val COLOR_GRASS        = 0xFF4A8B52.toInt()  // slightly lighter green
private val COLOR_ROCK         = 0xFF6A6055.toInt()  // warm brown

// Octopus — terracotta (brand, high contrast against light water)
private val COLOR_OCTO_BODY    = 0xFFC07058.toInt()  // terracotta body (brand color)
private val COLOR_OCTO_LIMB    = 0xFF8B4513.toInt()  // saddle brown limbs
private val COLOR_OCTO_SLEEP   = 0xFFB0A090.toInt()  // muted warm sleep

// Crayfish — vivid red (high contrast)
private val COLOR_CRAY_BODY    = 0xFFCC3333.toInt()  // vivid red
private val COLOR_CRAY_CLAW    = 0xFF991111.toInt()  // dark red claws
private val COLOR_CRAY_SICK    = 0xFF998877.toInt()  // warm gray sick
private val COLOR_CRAY_SIGNAL  = 0xFF2A8B6E.toInt()  // teal signals

// Cloud (Codex CLI brand: indigo-violet)
private val COLOR_CLOUD_BODY   = 0xFF5561E0.toInt()  // primary indigo
private val COLOR_CLOUD_PROMPT = 0xFF1A1A3A.toInt()  // dark navy prompt text
private val COLOR_CLOUD_SLEEP  = 0xFF8888AA.toInt()  // muted lavender sleep

// OpenCode (nested-square logo: warm gray outer, dark inner)
private val COLOR_OPENCODE_OUTER = 0xFFF1ECEC.toInt()  // light warm gray outer frame
private val COLOR_OPENCODE_INNER = 0xFF4B4646.toInt()  // dark brown-gray inner square
private val COLOR_OPENCODE_SLEEP = 0xFF9A9595.toInt()  // muted sleep

// Antigravity (peak/arc mark — rainbow in color mode, gray fallback for B/W e-ink)
private val COLOR_ANTIGRAVITY_BODY = 0xFF5F6368.toInt()  // Google gray primary
private val COLOR_ANTIGRAVITY_SLEEP = 0xFF9AA0A6.toInt() // muted gray sleep
private val COLOR_ANTIGRAVITY_SKY = 0xFF29B8EE.toInt()
private val COLOR_ANTIGRAVITY_CYAN = 0xFF3AC7EB.toInt()
private val COLOR_ANTIGRAVITY_LIME = 0xFF5CD64D.toInt()
private val COLOR_ANTIGRAVITY_YELLOW = 0xFFF5CB24.toInt()
private val COLOR_ANTIGRAVITY_ORANGE = 0xFFFF8410.toInt()
private val COLOR_ANTIGRAVITY_RED = 0xFFFF5241.toInt()
private val COLOR_ANTIGRAVITY_PINK = 0xFFB75CB6.toInt()
private val COLOR_ANTIGRAVITY_BLUE = 0xFF247EFF.toInt()

// Fish — distinct against light water
private val COLOR_FISH_BODY    = 0xFF3366AA.toInt()  // royal blue body
private val COLOR_FISH_STRIPE  = 0xFFD4A040.toInt()  // golden neon stripe

// Effects
private val COLOR_BUBBLE       = 0xFFD8E8F0.toInt()  // light blue bubbles
private val COLOR_STARBURST    = 0xFFDDAA44.toInt()  // golden working glow
private val COLOR_PARTICLE     = 0xFF55AACC.toInt()  // cyan particles
