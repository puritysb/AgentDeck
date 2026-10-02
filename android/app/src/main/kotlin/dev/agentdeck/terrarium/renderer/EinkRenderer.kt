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
import androidx.compose.runtime.withFrameNanos
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
import androidx.compose.ui.graphics.nativeCanvas
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
import dev.agentdeck.terrarium.labelRankOf
import dev.agentdeck.terrarium.LABEL_RANK_IDLE
import dev.agentdeck.terrarium.resolveResidentLabels
import dev.agentdeck.terrarium.ResidentLabelMode
import dev.agentdeck.terrarium.ResidentLabelInput
import dev.agentdeck.terrarium.LabelBox
import android.util.Log
import kotlinx.coroutines.isActive
import kotlin.math.floor

/** Motion time unit stays independent of how often a panel presents frames. */
private const val EINK_MOTION_UNIT_MS = 400L
private const val EINK_PARTIAL_FRAME_MS = 100L

/** Total animation cycle frames — fish patrol uses the full range, creatures use % 4. */
private const val EINK_ANIM_CYCLE = 32

// Octopus (Claude robot) and crayfish (OpenClaw) silhouettes are rendered from the
// canonical SVG paths in CreatureGeometry via canvas.drawPath — drawPath works on
// supported e-ink (the old "no drawPath" comments were based on an unverified claim).

// Codex and OpenCode also preserve their canonical geometry; Codex uses the
// cached path below while OpenCode's rectangular ring is equivalent primitives.

/** LCD previews run on every vsync; physical EPDs receive at most 10 partial updates/s. */
internal fun einkAnimationFrameIntervalMs(physicalEink: Boolean): Long =
    if (physicalEink) EINK_PARTIAL_FRAME_MS else 0L

internal fun einkAnimationFrameAdvance(elapsedMs: Long): Float =
    (elapsedMs.coerceAtLeast(0).toFloat() / EINK_MOTION_UNIT_MS).coerceAtMost(1.5f)

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
        val physicalEink = remember(hostView) { EinkRefreshHelper.isPhysicalEink(hostView) }
        val habitat = remember(hostView, physicalEink) {
            AquariumHabitat.load(hostView.context, einkColorEnabled, physicalEink)
        }
        // Reusable render target — NOT displayed directly, only used as renderEinkFrame target
        var reusableBitmap by remember { mutableStateOf<Bitmap?>(null) }
        var animFrame by remember { mutableFloatStateOf(0f) }
        val currentState by rememberUpdatedState(state)
        // Persistent swimming state — survives recomposition, state lives across frames
        val fishSchool = remember { EinkFishSchool() }

        val hasActiveCreatures = state.octopus != OctopusVisualState.SLEEPING ||
            state.crayfish != CrayfishVisualState.DORMANT ||
            state.cloudCreatures.any { it.visualState != OctopusVisualState.SLEEPING } ||
            state.openCodeCreatures.any { it.visualState != OctopusVisualState.SLEEPING } ||
            state.antigravityCreatures.any { it.visualState != OctopusVisualState.SLEEPING }
        val isAnimating = hasActiveCreatures && !snapshotMode

        // Vsync pacing drops overdue frames instead of adding render time to a sleep.
        LaunchedEffect(isAnimating, snapshotMode, widthPx, heightPx) {
            if (!isAnimating) {
                // Static or host-asleep snapshot state: render once and let the
                // caller decide whether that frame warrants an EPD refresh.
                val bmp = reusableBitmap?.takeIf { it.width == widthPx && it.height == heightPx }
                    ?: Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { reusableBitmap = it }
                renderedBitmap = renderEinkFrame(currentState, widthPx, heightPx, 0f, bmp, fishSchool = fishSchool, habitat = habitat)
                hostView.postInvalidate()
                onFrameRendered?.invoke(false)
                return@LaunchedEffect
            }
            val frameInterval = einkAnimationFrameIntervalMs(EinkRefreshHelper.isPhysicalEink(hostView))
            var lastFrameAt = android.os.SystemClock.uptimeMillis()
            while (isActive) {
                withFrameNanos { }
                val now = android.os.SystemClock.uptimeMillis()
                if (now - lastFrameAt < frameInterval) continue
                try {
                    val bmp = reusableBitmap?.takeIf { it.width == widthPx && it.height == heightPx }
                        ?: Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { reusableBitmap = it }
                    val frameAdvance = einkAnimationFrameAdvance(now - lastFrameAt)
                    lastFrameAt = now
                    animFrame = (animFrame + frameAdvance) % EINK_ANIM_CYCLE.toFloat()
                    val s = currentState
                    val streaming = s.tetra == TetraVisualState.STREAMING
                    fishSchool.update(streaming, frameAdvance,
                        hovering = s.tetra == TetraVisualState.HOVERING)
                    renderedBitmap = renderEinkFrame(currentState, widthPx, heightPx, animFrame, bmp,
                        skipDither = true, fishSchool = fishSchool, habitat = habitat)
                    hostView.postInvalidate()
                    onFrameRendered?.invoke(true)
                } catch (e: Exception) {
                    android.util.Log.e("EinkAnim", "Animation loop crash", e)
                }
            }
        }

        // Force immediate re-render on state change (e.g. FLOATING→WORKING).
        // The animation loop picks up currentState automatically, but we also render
        // one frame immediately so the transition does not wait for the next animation frame.
        val agentsKey = state.agents.map { it.visualState }
        val cloudsKey = state.cloudCreatures.map { it.visualState }
        val openCodeKey = state.openCodeCreatures.map { it.visualState }
        val antigravityKey = state.antigravityCreatures.map { it.visualState }
        LaunchedEffect(snapshotMode, state.octopus, state.crayfish, state.tetra, state.environment, agentsKey, cloudsKey, openCodeKey, antigravityKey, widthPx, heightPx) {
            val bmp = reusableBitmap?.takeIf { it.width == widthPx && it.height == heightPx }
                ?: Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { reusableBitmap = it }
            val frame = if (snapshotMode) 0f else animFrame
            renderedBitmap = renderEinkFrame(currentState, widthPx, heightPx, frame, bmp, fishSchool = fishSchool, habitat = habitat)
            hostView.postInvalidate()
            onFrameRendered?.invoke(false)
        }

        // Initial render
        LaunchedEffect(widthPx, heightPx) {
            if (renderedBitmap == null || renderedBitmap?.width != widthPx || renderedBitmap?.height != heightPx) {
                val bmp = reusableBitmap?.takeIf { it.width == widthPx && it.height == heightPx }
                    ?: Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { reusableBitmap = it }
                renderedBitmap = renderEinkFrame(state, widthPx, heightPx, 0f, bmp, fishSchool = fishSchool, habitat = habitat)
                hostView.postInvalidate()
                onFrameRendered?.invoke(false)
            }
        }

        Canvas(modifier = Modifier.fillMaxSize()) {
            val bmp = renderedBitmap ?: return@Canvas
            habitat?.draw(drawContext.canvas.nativeCanvas, size.width.toInt(), size.height.toInt())
            drawImage(
                image = bmp.asImageBitmap(),
                dstSize = IntSize(size.width.toInt(), size.height.toInt()),
            )
        }
    }
}

/**
 * Render a single e-ink frame with optional animation. Reuses [target] bitmap to avoid allocation.
 * Live residents render with alpha over a cached habitat; the physical monochrome
 * background is quantized once at load time. Separate composition, avoiding a full background copy on every frame.
 */
private fun renderEinkFrame(
    state: TerrariumState, width: Int, height: Int, animFrame: Float = 0f,
    target: Bitmap? = null, skipDither: Boolean = false,
    fishSchool: EinkFishSchool? = null,
    habitat: AquariumHabitat? = null,
): Bitmap {
    val bitmap = if (target != null && target.width == width && target.height == height) {
        target.eraseColor(0)
        target
    } else {
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    }
    val canvas = android.graphics.Canvas(bitmap)
    val paint = Paint().apply { isAntiAlias = habitat != null }

    einkTagQueue.set(mutableListOf())

    if (Log.isLoggable("EinkFrame", Log.VERBOSE)) {
        Log.v("EinkFrame", "agents=${state.agents.size} clouds=${state.cloudCreatures.size} oc=${state.openCodeCreatures.size} cf=${state.crayfish} frame=$animFrame")
    }

    if (habitat == null) {
        drawEinkEnvironment(canvas, paint, width, height, animFrame)
    } else {
        habitat.drawResidents(canvas, paint, width, height, animFrame)
    }

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
                allowHorizontalWander = state.cloudCreatures.size == 1,
                displayName = state.cloudCreatures[i].displayName)
        }
    }

    // OpenCode creatures (nested-square logo agents)
    if (state.openCodeCreatures.isNotEmpty()) {
        val openCodeSlots = dev.agentdeck.terrarium.vectorMarkSlots(state.openCodeCreatures)
        for (i in state.openCodeCreatures.indices) {
            val slot = openCodeSlots.getOrElse(i) { openCodeSlots.last() }
            drawEinkOpenCode(canvas, paint, width, height,
                state.openCodeCreatures[i].visualState,
                centerXFraction = slot.centerXFraction,
                centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor,
                animFrame = animFrame,
                swimFrame = animFrame,
                agentType = state.openCodeCreatures[i].agentType,
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

    // Name tags, resolved together after the last creature (DESIGN.md §6.4).
    val queuedTags = einkTagQueue.get()
    einkTagQueue.set(null)
    if (queuedTags != null) flushEinkNameTags(canvas, paint, queuedTags)

    // Front-layer fish (in front of creatures for 3D depth)
    drawEinkDataParticles(canvas, paint, width, height, state.tetra, state.agents.size, state.crayfish, animFrame, layer = 1, fishSchool = fishSchool)

    // Snap to native 16-level grayscale — only on B&W e-ink state-change renders.
    // Color e-ink: skip to preserve RGB colors for CFA rendering.
    if (!skipDither && !einkColorEnabled && habitat == null) {
        DitherEngine.snapToNearestGray(bitmap)
    }

    return bitmap
}

// --- Environment ---

private fun drawEinkEnvironment(
    canvas: android.graphics.Canvas, paint: Paint, width: Int, height: Int, animFrame: Float,
) {
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
}


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
    drawAquariumMark(canvas, paint, CreatureGeometry.octopusNativePath)
    canvas.restore()

    // Name tag FIRST (behind bubble) — multi-session only
    if (displayName != null) {
        drawEinkNameTag(canvas, paint, cx, startY, scaleFactor, displayName, w, labelRankOf(state))
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

/** A measured e-ink tag waiting for the frame's resolve pass (DESIGN.md §6.4). */
private class EinkTagRequest(
    val cx: Float, val bodyTopY: Float, val scaleFactor: Float, val name: String, val w: Int, val rank: Int,
)

/**
 * Tags queued during one e-ink frame. Paper has no translucency to spend, so
 * e-ink takes the ordering half of the rule only: priority tags paint last, and
 * an idle tag that would collide with one already placed is dropped (the
 * roster still lists it).
 */
private val einkTagQueue = ThreadLocal<MutableList<EinkTagRequest>?>()  // frames may render off the main thread

private fun flushEinkNameTags(canvas: android.graphics.Canvas, paint: Paint, requests: List<EinkTagRequest>) {
    val inputs = requests.mapIndexed { index, r ->
        val bodyMetric = creatureNameTagMetric(r.w.toFloat(), r.scaleFactor)
        val layout = resolveCreatureNameTagLayout(r.name, r.bodyTopY, bodyMetric, paint)
        val box = LabelBox(r.cx - layout.tagWidth / 2, layout.tagBottomY - layout.tagHeight, r.cx + layout.tagWidth / 2, layout.tagBottomY)
        val body = LabelBox(r.cx - bodyMetric * 0.7f, r.bodyTopY, r.cx + bodyMetric * 0.7f, r.bodyTopY + bodyMetric * 1.2f)
        ResidentLabelInput(index.toString(), r.rank, body, box, box)
    }
    for (decision in resolveResidentLabels(inputs)) {
        if (decision.mode == ResidentLabelMode.HIDDEN) continue
        val r = requests[decision.id.toInt()]
        paintEinkNameTag(canvas, paint, r.cx, r.bodyTopY, r.scaleFactor, r.name, r.w)
    }
}

/** E-ink name tag above a creature; queued when a frame pass is active. */
private fun drawEinkNameTag(
    canvas: android.graphics.Canvas, paint: Paint,
    cx: Float, bodyTopY: Float, scaleFactor: Float,
    name: String, w: Int, rank: Int = LABEL_RANK_IDLE,
) {
    val queue = einkTagQueue.get()
    if (queue != null) {
        queue += EinkTagRequest(cx, bodyTopY, scaleFactor, name, w, rank)
        return
    }
    paintEinkNameTag(canvas, paint, cx, bodyTopY, scaleFactor, name, w)
}

/** E-ink name tag above octopus — adaptive font with 2-line wrapping, text-fit width. */
private fun paintEinkNameTag(
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
    allowHorizontalWander: Boolean = true,
) {
    // Horizontal wander when WORKING (same pattern as octopus)
    val wanderX = if (allowHorizontalWander && state == OctopusVisualState.WORKING) {
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
    drawAquariumMark(canvas, paint, path)

    // Effective body extents for positioning
    val bodyHeight = markSize / 2f
    val bodyExtentX = markSize / 2f

    // Name tag above cloud (reuse the shared name tag renderer)
    if (displayName != null) {
        drawEinkNameTag(canvas, paint, cx, cy - bodyHeight, scaleFactor, displayName, w, labelRankOf(state))
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
    agentType: String? = "opencode",
    displayName: String? = null,
) {
    val isKiro = agentType == "kiro-cli" || agentType == "kiro-ide"
    val isHermes = agentType == "hermes"
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

    // Canonical OpenCode ring, Kiro ghost or Hermes Nous girl. They share the
    // motion/layout mechanics, but never substitute one agent's silhouette for
    // another's. Hermes is three separate paths, drawn one by one.
    if (isKiro || isHermes) {
        val geometry = dev.agentdeck.terrarium.CreatureGeometry
        val viewBox = if (isHermes) geometry.HERMES_VIEWBOX else geometry.KIRO_VIEWBOX
        val markPaths = if (isHermes) geometry.hermesNativePaths else listOf(geometry.kiroNativePath)
        val bodyColor = if (isHermes) einkPick(GRAY_HERMES_BODY, COLOR_HERMES_BODY) else einkPick(GRAY_KIRO_BODY, COLOR_KIRO_BODY)
        val markSize = w * 0.052f * scaleFactor * if (einkColorEnabled) 2.0f else 1.75f
        val svgScale = markSize / viewBox
        paint.style = Paint.Style.FILL
        paint.color = if (state == OctopusVisualState.SLEEPING) {
            if (isHermes) einkPick(GRAY_HERMES_SLEEP, COLOR_HERMES_SLEEP) else einkPick(GRAY_KIRO_SLEEP, COLOR_KIRO_SLEEP)
        } else {
            bodyColor
        }
        canvas.save()
        canvas.translate(cx, cy)
        canvas.scale(svgScale, svgScale)
        canvas.translate(-viewBox / 2f, -viewBox / 2f)
        for (markPath in markPaths) drawAquariumMark(canvas, paint, markPath)
        canvas.restore()

        if (displayName != null) {
            drawEinkNameTag(canvas, paint, cx, cy - markSize / 2f, scaleFactor, displayName, w, labelRankOf(state))
        }
        if (state == OctopusVisualState.ASKING) {
            val bubbleR = markSize * 0.25f * scaleFactor
            val bubbleX = cx + markSize * 0.6f
            paint.color = einkPick(GRAY_AIR, COLOR_AIR)
            paint.style = Paint.Style.FILL
            canvas.drawCircle(bubbleX, cy, bubbleR, paint)
            paint.color = bodyColor
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 1.5f * scaleFactor
            canvas.drawCircle(bubbleX, cy, bubbleR, paint)
            paint.color = android.graphics.Color.BLACK
            paint.style = Paint.Style.FILL
            paint.textSize = bubbleR * 1.4f
            paint.textAlign = Paint.Align.CENTER
            canvas.drawText("?", bubbleX, cy + bubbleR * 0.45f, paint)
            paint.textAlign = Paint.Align.LEFT
        }
        return
    }

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
        drawEinkNameTag(canvas, paint, cx, cy - outerHalf, scaleFactor, displayName, w, labelRankOf(state))
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
        drawAquariumMark(canvas, paint, dev.agentdeck.terrarium.CreatureGeometry.antigravityNativePath)
        paint.strokeWidth = 0.55f
        paint.color = 0xFFF6FAFC.toInt()
        drawAquariumMark(canvas, paint, dev.agentdeck.terrarium.CreatureGeometry.antigravityNativePath)
        paint.style = Paint.Style.FILL
        paint.shader = antigravityShader
    }
    drawAquariumMark(canvas, paint, dev.agentdeck.terrarium.CreatureGeometry.antigravityNativePath)
    canvas.restore()
    paint.shader = null
    paint.style = Paint.Style.FILL

    // Name tag
    if (displayName != null) {
        drawEinkNameTag(canvas, paint, cx, cy - markHalf, scaleFactor, displayName, w, labelRankOf(state))
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
    for (path in CreatureGeometry.openClawBodyNativePaths) drawAquariumMark(canvas, paint, path)
    for (path in CreatureGeometry.openClawEyeNativePaths) drawAquariumMark(canvas, paint, path)
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
    val fishSize = w * 0.012f

    if (fishSchool != null) {
        // Depth controls occlusion as well as size: the far side of the circuit
        // passes behind agents, so a neon stripe cannot paint over their marks.
        for (f in fishSchool.fish) {
            val fishLayer = if (f.depth < 0.86f) 0 else 1
            if (layer != -1 && fishLayer != layer) continue
            drawEinkFish(canvas, paint, f.x * w, f.y * h, fishSize * f.depth,
                f.facing, f.pitch, f.tailBeat)
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
    }
}

/** Side-view silhouette with yaw foreshortening and a continuous tail stroke. */
private fun drawEinkFish(
    canvas: android.graphics.Canvas, paint: Paint,
    cx: Float, cy: Float, size: Float, facing: Float, pitch: Float, tailBeat: Float,
) {
    canvas.save()
    canvas.translate(cx, cy)
    canvas.rotate(pitch)
    // The fish turns into depth at each end of the circuit. Its back stays up.
    val side = kotlin.math.abs(facing)
    val direction = if (facing >= 0f) 1f else -1f
    canvas.scale(direction, 1f)
    val length = size * (0.28f + 1.45f * side)
    val height = size * 0.52f
    val tail = tailBeat * size * 0.30f
    val savedCap = paint.strokeCap

    paint.style = Paint.Style.FILL
    paint.color = einkPick(GRAY_FISH_BODY, COLOR_FISH_BODY)
    val body = android.graphics.Path().apply {
        moveTo(length, 0f)
        cubicTo(length * 0.65f, -height, -length * 0.25f, -height, -length, tail * 0.25f)
        cubicTo(-length * 0.25f, height, length * 0.65f, height, length, 0f)
        close()
    }
    drawAquariumMark(canvas, paint, body)
    val fin = android.graphics.Path().apply {
        moveTo(-length * 0.85f, tail * 0.25f)
        lineTo(-length - size * 0.60f * side, tail - height * 0.75f)
        lineTo(-length - size * 0.36f * side, tail)
        lineTo(-length - size * 0.60f * side, tail + height * 0.75f)
        close()
    }
    canvas.drawPath(fin, paint)

    paint.style = Paint.Style.STROKE
    paint.color = einkPick(GRAY_FISH_STRIPE, COLOR_FISH_STRIPE)
    paint.strokeWidth = size * 0.18f
    paint.strokeCap = Paint.Cap.ROUND
    canvas.drawLine(-length * 0.55f, 0f, length * 0.65f, 0f, paint)
    paint.strokeCap = savedCap
    if (side > 0.22f) {
        paint.style = Paint.Style.FILL
        paint.color = GRAY_AIR
        canvas.drawCircle(length * 0.60f, -height * 0.18f, size * 0.12f, paint)
        paint.color = GRAY_CREATURE
        canvas.drawCircle(length * 0.63f, -height * 0.18f, size * 0.055f, paint)
    }
    paint.style = Paint.Style.FILL
    canvas.restore()
}

/**
 * Vendor-specific EPD refresh control.
 *
 * Rockchip RK3566 (Pantone 6, Xiaomi Reader, etc.):
 *   Uses `android.os.EinkManager` system service with string-based mode constants.
 *   Reference: KOReader's RK35xxEPDController.
 *   EPD modes: "2"=FULL_GC16, "7"=PART_GC16, "12"=A2, "14"=DU
 *
 * Onyx Boox (Qualcomm):
 *   Uses `com.onyx.android.sdk.device.BaseDevice` with UpdateMode enum.
 */
object EinkRefreshHelper {

    private var physicalEink: Boolean? = null

    /** Layout override is not a display controller: probe the panel without that override. */
    fun isPhysicalEink(view: View): Boolean = physicalEink ?: run {
        dev.agentdeck.util.DeviceProfile.detect(view.context.applicationContext).isEink
            .also { physicalEink = it }
    }

    // Crema S (sdm660) exposes Onyx extensions directly on framework View.
    // Probe once: the SDK jar is not bundled with the app or required on this device.
    private val nativeOnyx by lazy { NativeOnyxRefresh.probe() }

    // Rockchip EPD mode constants (string values for EinkManager.setMode)
    private const val RK_EPD_FULL_GC16 = "2"
    private const val RK_EPD_A2 = "12"
    private const val RK_EPD_DU = "14"

    // Animation uses A2 partial updates on both monochrome and color panels.
    // Full/normal refresh is reserved for state changes, never a per-frame flash.

    /** Full/normal refresh — clears ghosting and exits fast animation mode. */
    fun requestFullRefresh(view: View) {
        if (!isPhysicalEink(view)) { view.invalidate(); return }
        // B&W e-ink gets an explicit full-frame GC16 flash. Color e-ink uses
        // the same mode switch without forcing a full monochrome frame, which
        // restores quality after animation/A2 frames.
        if (nativeOnyx?.refresh(view, 2, full = true) == true) return
        if (tryRockchipRefresh(view, RK_EPD_FULL_GC16, sendFullFrame = !einkColorEnabled)) return

        try {
            // Onyx: com.onyx.android.sdk.device.Device.requestScreenUpdate()
            val onyxClass = Class.forName("com.onyx.android.sdk.device.Device")
            onyxClass.getMethod("requestScreenUpdate", View::class.java).invoke(null, view)
            return
        } catch (_: Exception) {}

        view.invalidate()
    }

    /** Gray-preserving regional update, without the full-screen clearing waveform. */
    fun requestQualityRefresh(view: View) {
        if (!isPhysicalEink(view)) { view.invalidate(); return }
        if (nativeOnyx?.refresh(view, 2) == true) return
        if (tryRockchipRefresh(view, "7")) return
        view.invalidate()
    }

    fun requestPartialRefresh(view: View) {
        view.invalidate()
    }

    /** A2 mode — fastest binary refresh, ideal for state markers and timeline. */
    fun requestA2Refresh(view: View) {
        if (!isPhysicalEink(view)) { view.invalidate(); return }
        if (nativeOnyx?.refresh(view, 4) == true) return
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

        // Fallback
        view.invalidate()
    }

    /** Fast partial animation confined to the aquarium view; no periodic full flash. */
    fun requestAnimationRefresh(view: View) {
        requestA2Refresh(view)
    }

    /** DU mode — fast monochrome refresh, ideal for usage gauges, footer,
     *  and B&W animation frames (flash-min policy). */
    fun requestDURefresh(view: View) {
        if (!isPhysicalEink(view)) { view.invalidate(); return }
        if (nativeOnyx?.refresh(view, 1) == true) return
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
private const val GRAY_KIRO_BODY = 0xFF444444.toInt()
private const val GRAY_KIRO_SLEEP = 0xFF999999.toInt()
// Hermes on paper is the upstream BLACK Nous girl (Brand.hermes #000000).
private const val GRAY_HERMES_BODY = 0xFF222222.toInt()
private const val GRAY_HERMES_SLEEP = 0xFF999999.toInt()
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
private val COLOR_KIRO_BODY = 0xFF7C3AED.toInt()
private val COLOR_KIRO_SLEEP = 0xFF7A6A91.toInt()
private val COLOR_HERMES_BODY = 0xFF1A1A1A.toInt()
private val COLOR_HERMES_SLEEP = 0xFF8A8A8A.toInt()

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
