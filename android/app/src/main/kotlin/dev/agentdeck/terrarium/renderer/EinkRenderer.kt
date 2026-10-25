package dev.agentdeck.terrarium.renderer

import android.graphics.Bitmap
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
import dev.agentdeck.terrarium.ciCompanionActive
import dev.agentdeck.terrarium.ciCompanionBitmap
import dev.agentdeck.terrarium.drawCiCompanion
import dev.agentdeck.terrarium.TerrariumRules
import dev.agentdeck.terrarium.aquariumResidents
import dev.agentdeck.terrarium.visibleAquariumResidents
import dev.agentdeck.terrarium.CrayfishVisualState
import dev.agentdeck.terrarium.CreatureGeometry
import dev.agentdeck.terrarium.OctopusVisualState
import dev.agentdeck.terrarium.TetraVisualState
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

private fun Int.floorMod(modulus: Int): Int = ((this % modulus) + modulus) % modulus

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
        val ciSprite=remember(hostView.context){ciCompanionBitmap(hostView.context)}
        val ciTypeface = remember(hostView.context) {
            dev.agentdeck.terrarium.ciCompanionTypeface(hostView.context)
        }
        val physicalEink = remember(hostView) { EinkRefreshHelper.isPhysicalEink(hostView) }
        val habitat = remember(hostView, physicalEink) {
            AquariumHabitat.load(hostView.context, einkColorEnabled, physicalEink)
        }
        // Reusable render target — NOT displayed directly, only used as renderEinkFrame target
        var reusableBitmap by remember { mutableStateOf<Bitmap?>(null) }
        var animFrame by remember { mutableFloatStateOf(0f) }
        var residentTimeSeconds by remember { mutableStateOf(0.0) }
        val currentState by rememberUpdatedState(state)
        // Persistent swimming state — survives recomposition, state lives across frames
        val fishSchool = remember { EinkFishSchool() }
        val residentMotion = remember { EinkResidentMotion() }

        val visibleResidents = visibleAquariumResidents(aquariumResidents(state), state.focusedSessionId)
        val hasActiveCreatures = visibleResidents.any { it.state != OctopusVisualState.SLEEPING }
        val isAnimating = hasActiveCreatures && !snapshotMode

        // Vsync pacing drops overdue frames instead of adding render time to a sleep.
        LaunchedEffect(isAnimating, snapshotMode, widthPx, heightPx) {
            if (!isAnimating) {
                // Static or host-asleep snapshot state: render once and let the
                // caller decide whether that frame warrants an EPD refresh.
                val bmp = reusableBitmap?.takeIf { it.width == widthPx && it.height == heightPx }
                    ?: Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { reusableBitmap = it }
                renderedBitmap = renderEinkFrame(currentState, widthPx, heightPx, 0f, bmp, fishSchool = fishSchool, habitat = habitat, textScale = density.density,ciSprite = ciSprite, ciTypeface = ciTypeface, residentTimeSeconds = residentTimeSeconds, residentMotion = residentMotion)
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
                    residentTimeSeconds += frameAdvance.toDouble() * EINK_MOTION_UNIT_MS / 1000.0
                    val s = currentState
                    val streaming = s.tetra == TetraVisualState.STREAMING
                    fishSchool.update(streaming, frameAdvance,
                        hovering = s.tetra == TetraVisualState.HOVERING)
                    renderedBitmap = renderEinkFrame(currentState, widthPx, heightPx, animFrame, bmp,
                        skipDither = true, fishSchool = fishSchool, habitat = habitat, textScale = density.density,ciSprite = ciSprite, ciTypeface = ciTypeface, residentTimeSeconds = residentTimeSeconds, residentMotion = residentMotion)
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
        LaunchedEffect(snapshotMode, state, widthPx, heightPx) {
            val bmp = reusableBitmap?.takeIf { it.width == widthPx && it.height == heightPx }
                ?: Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { reusableBitmap = it }
            val frame = if (snapshotMode) 0f else animFrame
            renderedBitmap = renderEinkFrame(currentState, widthPx, heightPx, frame, bmp, fishSchool = fishSchool, habitat = habitat, textScale = density.density,ciSprite = ciSprite, ciTypeface = ciTypeface, residentTimeSeconds = residentTimeSeconds, residentMotion = residentMotion)
            hostView.postInvalidate()
            onFrameRendered?.invoke(false)
        }

        // Initial render
        LaunchedEffect(widthPx, heightPx) {
            if (renderedBitmap == null || renderedBitmap?.width != widthPx || renderedBitmap?.height != heightPx) {
                val bmp = reusableBitmap?.takeIf { it.width == widthPx && it.height == heightPx }
                    ?: Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888).also { reusableBitmap = it }
                renderedBitmap = renderEinkFrame(state, widthPx, heightPx, 0f, bmp, fishSchool = fishSchool, habitat = habitat, textScale = density.density,ciSprite = ciSprite, ciTypeface = ciTypeface, residentTimeSeconds = residentTimeSeconds, residentMotion = residentMotion)
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

/** Repeated static captions overlap; the paper list retains each full CI status. */
internal fun showEinkCiCompanionCaptions(state: TerrariumState): Boolean {
    val residents = state.agents + state.cloudCreatures + state.openCodeCreatures + state.antigravityCreatures
    return residents.count {
        it.visualState != OctopusVisualState.ASKING && ciCompanionActive(state.ciWaits[it.sessionId])
    } <= 1
}

/** Neutral geometric effort cues stay legible on monochrome EPD; working never flashes. */
private fun drawEinkResidentActivity(
    canvas: android.graphics.Canvas, paint: Paint,
    item: dev.agentdeck.terrarium.AquariumResident, pose: EinkResidentPose,
    x: Float, y: Float, selected: Boolean,
) {
    val unit = pose.home.body * .55f
    paint.style = Paint.Style.FILL
    paint.alpha = 255
    paint.color = GRAY_CREATURE
    if (selected) {
        for (side in -1..1 step 2) {
            val rail = x + side * unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_X
            canvas.drawRect(rail - unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_WIDTH / 2,
                y - unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_HEIGHT / 2,
                rail + unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_WIDTH / 2,
                y + unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_HEIGHT / 2, paint)
        }
    }
    if (item.state == OctopusVisualState.ASKING) {
        val radius = pose.home.body * .18f
        val bubbleX = einkQuestionBubbleX(x, pose.home.body, canvas.width)
        paint.style = Paint.Style.FILL
        paint.color = einkPick(GRAY_AIR, COLOR_AIR)
        canvas.drawCircle(bubbleX, y, radius, paint)
        paint.style = Paint.Style.STROKE
        paint.color = GRAY_CREATURE
        paint.strokeWidth = pose.home.body * .012f
        canvas.drawCircle(bubbleX, y, radius, paint)
        paint.style = Paint.Style.FILL
        paint.textSize = radius * 1.5f
        paint.textAlign = Paint.Align.CENTER
        canvas.drawText("?", bubbleX, y + radius * .5f, paint)
        paint.textAlign = Paint.Align.LEFT
    }
    // Work has a place and an action: a small disturbed patch accompanies a
    // grounded resident's task strokes. Travel is expressed by gait, not meter bars.
    if (!pose.home.grounded && pose.workAmount > .1f) {
        paint.color = einkPick(GRAY_SIGNAL, COLOR_BUBBLE)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = maxOf(1.2f, pose.home.body * .01f)
        for (index in 0..2) {
            val progress = (pose.workPhase * .13f + index / 3f) % 1f
            val reach = pose.home.body * (.68f - progress * .16f)
            canvas.drawCircle(x + reach * .75f,
                y + pose.home.body * (.40f - progress * .55f),
                pose.home.body * .022f * pose.workAmount, paint)
        }
        paint.style = Paint.Style.FILL
    }
    if (pose.home.grounded && pose.workAmount > .1f) {
        paint.color = einkPick(GRAY_GRAVEL, COLOR_SAND)
        for (index in 0..2) {
            val phase = (pose.workPhase * .22f + index / 3f) % 1f
            val direction = if (index % 2 == 0) -1f else 1f
            canvas.drawCircle(x + direction * pose.home.body * (.35f + phase * .17f),
                y + pose.home.body * (.36f - phase * .16f),
                pose.home.body * .018f * (1f - phase) * pose.workAmount, paint)
        }
    }
}

/** Water trails indicate direction; they disappear when a resident stops to work or wait. */
private fun drawEinkTravelWake(canvas: android.graphics.Canvas, paint: Paint, pose: EinkResidentPose, width: Int, height: Int) {
    if (pose.home.grounded || pose.locomotionAmount <= .01f) return
    // Retained orientation and the eased gait envelope let the wake shorten
    // through braking instead of disappearing at a velocity threshold.
    val ux = pose.lookX
    val uy = pose.lookY
    val effort = pose.locomotionAmount
    val body = pose.home.body
    val cx = pose.slot.centerXFraction * width
    val cy = pose.slot.centerYFraction * height
    paint.color = einkPick(GRAY_SIGNAL, COLOR_BUBBLE)
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = maxOf(.5f, body * .009f * effort)
    paint.strokeCap = Paint.Cap.ROUND
    for (side in -1..1 step 2) {
        val startX = cx - ux * body * .52f - uy * body * .18f * side
        val startY = cy - uy * body * .52f + ux * body * .18f * side
        val path = android.graphics.Path().apply {
            moveTo(startX, startY)
            quadTo(startX - ux * body * .15f * effort - uy * body * .06f * side * effort,
                startY - uy * body * .15f * effort + ux * body * .06f * side * effort,
                startX - ux * body * .30f * effort, startY - uy * body * .30f * effort)
        }
        canvas.drawPath(path, paint)
    }
    paint.style = Paint.Style.FILL
    paint.strokeCap = Paint.Cap.BUTT
}

/**
 * Render a single e-ink frame with optional animation. Reuses [target] bitmap to avoid allocation.
 * Live residents render with alpha over a cached habitat; the physical monochrome
 * background is quantized once at load time. Separate composition, avoiding a full background copy on every frame.
 */
internal fun renderEinkFrame(
    state: TerrariumState, width: Int, height: Int, animFrame: Float = 0f,
    target: Bitmap? = null, skipDither: Boolean = false,
    fishSchool: EinkFishSchool? = null,
    habitat: AquariumHabitat? = null,
    textScale: Float = 1f,
    ciSprite: Bitmap? = null,
    ciTypeface: android.graphics.Typeface? = null,
    residentTimeSeconds: Double = animFrame.toDouble() * EINK_MOTION_UNIT_MS / 1000.0,
    residentMotion: EinkResidentMotion? = null,
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
    drawEinkFishSchool(canvas, paint, width, height, state.tetra, layer = 0, fishSchool = fishSchool)

    // Reuse the native aquarium's priority and capacity policy. The roster
    // retains every session; a crowd never shrinks the scene into tiny marks.
    val residents = visibleAquariumResidents(aquariumResidents(state), state.focusedSessionId)
    val poses = (residentMotion ?: EinkResidentMotion()).advance(residents, residentTimeSeconds, width, height)
    val anchors = mutableMapOf<String, Pair<Float, Float>>()
    // A small contact shadow travels with the creature rather than marking a fixed icon slot.
    poses.filter { it.home.grounded }.forEach { pose ->
        val x = pose.slot.centerXFraction * width
        val y = pose.slot.centerYFraction * height
        val body = pose.home.body
        paint.style = Paint.Style.FILL
        paint.color = einkPick(GRAY_GRAVEL, COLOR_SAND)
        canvas.drawOval(x - body * .43f, y + body * .32f,
            x + body * .43f, y + body * .39f, paint)
    }
    for (pose in poses) drawEinkTravelWake(canvas, paint, pose, width, height)
    // Far residents paint first. Labels remain upright and are resolved together below.
    residents.indices.sortedBy { poses[it].slot.centerYFraction }.forEach { i ->
        val resident = residents[i]
        val pose = poses[i]
        val slot = pose.slot
        val cx = slot.centerXFraction * width
        val cy = slot.centerYFraction * height
        canvas.save()
        canvas.rotate(pose.rollDegrees, cx, cy)
        canvas.scale(pose.widthScale, pose.heightScale, cx, cy)
        when (resident.kind) {
            "claudecode" -> drawEinkOctopus(canvas, paint, width, height, resident.state,
                centerXFraction = slot.centerXFraction, centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor, displayName = resident.title, pose = pose)
            "codex" -> drawEinkCloud(canvas, paint, width, height, resident.state,
                centerXFraction = slot.centerXFraction, centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor, displayName = resident.title, pose = pose)
            "opencode", "kiro", "hermes" -> drawEinkOpenCode(canvas, paint, width, height, resident.state,
                centerXFraction = slot.centerXFraction, centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor,
                agentType = if (resident.kind == "kiro") "kiro-cli" else resident.kind,
                displayName = resident.title, pose = pose)
            "antigravity" -> drawEinkAntigravity(canvas, paint, width, height, resident.state,
                centerXFraction = slot.centerXFraction, centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor, displayName = resident.title, pose = pose)
            "openclaw" -> drawEinkCrayfish(canvas, paint, width, height, state.crayfish, animFrame,
                centerXFraction = slot.centerXFraction, centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor, pose = pose)
        }
        canvas.restore()
        anchors[resident.id] = slot.centerXFraction to slot.centerYFraction
        drawEinkResidentActivity(canvas, paint, resident, pose, cx, cy,
            resident.id == state.focusedSessionId)
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


    if(ciSprite!=null) {
        val ciPaint = Paint(paint).apply { typeface = ciTypeface }
        val all = residents
        for(item in all) {
            val wait=state.ciWaits[item.id] ?: continue
            if(!ciCompanionActive(wait) || item.state==OctopusVisualState.ASKING)continue
            // Preserve each renderer's actual rest/swim home rather than relocating it.
            val center=anchors[item.id] ?: continue
            drawCiCompanion(canvas,ciPaint,ciSprite,center,einkCompanionPosition(poses[all.indexOf(item)], width, height),
                wait,textScale=textScale,ink=if(einkColorEnabled)null else GRAY_CREATURE,
                showCaption=showEinkCiCompanionCaptions(state))
        }
    }

    // Name tags, resolved together after the last creature (DESIGN.md §6.4).
    val queuedTags = einkTagQueue.get()
    einkTagQueue.set(null)
    if (queuedTags != null) flushEinkNameTags(canvas, paint, queuedTags)

    // Front-layer fish (in front of creatures for 3D depth)
    drawEinkFishSchool(canvas, paint, width, height, state.tetra, layer = 1, fishSchool = fishSchool)

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

/** Close the exact source feature cutouts before moving their opaque layers.
 * Union preserves the shaded silhouette, avoiding old eyes or a second prompt.
 */
private fun einkBodyWithoutFeatures(source: android.graphics.Path, agent: String): android.graphics.Path =
    android.graphics.Path(source).apply {
        for (layer in dev.agentdeck.terrarium.CreatureBrandFeatures.layers[agent].orEmpty()) {
            if (!layer.hole) for (feature in layer.nativePaths) op(feature, android.graphics.Path.Op.UNION)
        }
    }
private val einkClaudeBody by lazy { einkBodyWithoutFeatures(CreatureGeometry.octopusNativePath, "claudecode") }
private val einkCodexBody by lazy { einkBodyWithoutFeatures(CreatureGeometry.codexNativePath, "codex") }
private val einkOpenClawBody by lazy { einkBodyWithoutFeatures(CreatureGeometry.openClawBodyNativePaths.first(), "openclaw") }

/** The source eyes/prompt look ahead while remaining legible, never reflected. */
private fun drawEinkLookingFeatures(
    canvas: android.graphics.Canvas, paint: Paint, agent: String, pose: EinkResidentPose?,
    centerY: Float, reachX: Float, reachY: Float,
) {
    canvas.save()
    if (pose != null) {
        canvas.translate(pose.lookX * reachX, pose.lookY * reachY)
        canvas.scale(1f - kotlin.math.abs(pose.lookX) * .16f, 1f, 12f, centerY)
    }
    dev.agentdeck.terrarium.CreatureBrandFeatures.drawNative(canvas, paint, agent, monochromeCreature = !einkColorEnabled)
    canvas.restore()
}

/** A bounded edge-on projection keeps a turning swimmer present on paper. */
private fun einkSwimmerWidth(pose: EinkResidentPose?): Float =
    if (pose == null) 1f else .18f + .82f * kotlin.math.abs(pose.facing)

/** Blend only the narrow middle of a turn, never flip a full-width silhouette.
 * Layers are bounded in source-art coordinates, so the normal opaque path does
 * not allocate a full-scene intermediate bitmap for each resident.
 */
private inline fun drawEinkFacingSilhouette(
    canvas: android.graphics.Canvas, pose: EinkResidentPose?, nativeSide: Float,
    width: Float, height: Float, draw: () -> Unit,
) {
    if (pose == null) { draw(); return }
    val rightWeight = ((pose.facing + .15f) / .30f).coerceIn(0f, 1f)
    val projection = einkSwimmerWidth(pose)
    for (side in -1..1 step 2) {
        val weight = if (side > 0) rightWeight else 1f - rightWeight
        val alpha = (weight * 255f).toInt()
        if (alpha == 0) continue
        val save = if (alpha == 255) canvas.save() else
            canvas.saveLayerAlpha(-width * .3f, -height * .3f, width * 1.3f, height * 1.3f, alpha)
        canvas.translate(width / 2f, height / 2f)
        canvas.scale(side * nativeSide * projection, 1f)
        canvas.translate(-width / 2f, -height / 2f)
        draw()
        canvas.restoreToCount(save)
    }
}

/** E-ink octopus — 14×5 pixel block rendering matching the color OctopusCreature grid. */
@Suppress("UNUSED_PARAMETER")
private fun drawMonochromeCreatureOutline(canvas: android.graphics.Canvas, paint: Paint, path: android.graphics.Path) {
    val outline = Paint(paint).apply {
        shader = null
        color = GRAY_CREATURE
        alpha = 255
        style = Paint.Style.STROKE
        strokeWidth = dev.agentdeck.terrarium.CreatureBrandFeatures.MONOCHROME_OUTLINE_WIDTH
    }
    canvas.drawPath(path, outline)
}

internal fun drawEinkOctopus(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: OctopusVisualState,
    _agentType: String? = null,
    centerXFraction: Float = 0.38f,
    centerYFraction: Float = 0.42f,
    scaleFactor: Float = 1f,
    animFrame: Float = 0f,
    displayName: String? = null,
    pose: EinkResidentPose? = null,
) {
    val cx = w * centerXFraction
    val cy = h * centerYFraction


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
    if (!einkColorEnabled && dev.agentdeck.terrarium.CreatureBrandFeatures.monochromeLightBodyAgents.contains("claudecode")) paint.color = GRAY_AIR
    val phase = pose?.phase ?: 0f
    val gait = pose?.locomotionAmount ?: 0f
    val work = pose?.workAmount ?: 0f
    fun drawPart(left: Float, top: Float, right: Float, bottom: Float, dx: Float = 0f, dy: Float = 0f) {
        canvas.save()
        canvas.translate(dx, dy)
        canvas.clipRect(left, top, right, bottom)
        drawAquariumMark(canvas, paint, einkClaudeBody)
        if (!einkColorEnabled) drawMonochromeCreatureOutline(canvas, paint, einkClaudeBody)
        canvas.restore()
    }
    drawPart(3f, 0f, 21f, 17.079f)
    for (side in -1..1 step 2) {
        val reach = kotlin.math.sin((pose?.workPhase ?: 0f) * 1.25f + if (side > 0) 1.8f else 0f) * work
        drawPart(if (side < 0) -1f else 21f, 10.949f,
            if (side < 0) 3f else 25f, 14.051f,
            dy = reach * 1.1f + (pose?.lookX ?: 0f) * side * .32f)
    }
    val feet = listOf(4.487f to 6f, 7.488f to 9f, 15f to 16.513f, 18f to 19.513f)
    feet.forEachIndexed { index, (left, right) ->
        val stroke = kotlin.math.sin(phase + index % 2 * kotlin.math.PI.toFloat())
        drawPart(left, 17.079f, right, 20.1f,
            dx = stroke * gait * .55f * (pose?.facing ?: 1f),
            dy = -maxOf(0f, stroke) * gait * 1.15f)
    }
    drawEinkLookingFeatures(canvas, paint, "claudecode", pose, 9.5f, 1.85f, .70f)
    canvas.restore()

    // Name tag FIRST (behind bubble) — multi-session only
    if (displayName != null) {
        drawEinkNameTag(canvas, paint, cx, startY, scaleFactor, displayName, w, labelRankOf(state))
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

    val textX = cx.coerceIn(layout.tagWidth / 2f + 2f, w - layout.tagWidth / 2f - 2f)
    paint.textSize = layout.fontSize
    fun line(value: String, baseline: Float) {
        val visible = android.text.TextUtils.ellipsize(value, android.text.TextPaint(paint),
            layout.tagWidth * CreatureNameTagStyle.TEXT_WIDTH_RATIO, android.text.TextUtils.TruncateAt.END).toString()
        paint.style = Paint.Style.STROKE
        paint.strokeJoin = Paint.Join.ROUND
        paint.strokeWidth = maxOf(2f, layout.fontSize * .26f)
        paint.color = GRAY_AIR
        canvas.drawText(visible, textX, baseline, paint)
        paint.style = Paint.Style.FILL
        paint.color = GRAY_CREATURE
        canvas.drawText(visible, textX, baseline, paint)
    }
    if (layout.lines.size == 1) {
        line(layout.lines[0], tagTop + layout.tagHeight * .75f)
    } else {
        val firstY = tagTop + layout.fontSize * CreatureNameTagStyle.MULTILINE_EXTRA_RATIO + layout.fontSize
        layout.lines.forEachIndexed { index, value -> line(value, firstY + index * layout.lineHeight) }
    }

    paint.textAlign = Paint.Align.LEFT
}

/**
 * E-ink Codex creature using the canonical design/brand/codex.svg path.
 *
 * Its position and state-driven pose are supplied by the habitat projection.
 */
internal fun drawEinkCloud(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: OctopusVisualState,
    centerXFraction: Float = 0.55f,
    centerYFraction: Float = 0.20f,
    scaleFactor: Float = 1f,
    animFrame: Float = 0f,
    displayName: String? = null,
    pose: EinkResidentPose? = null,
) {
    val cx = w * centerXFraction
    val cy = h * centerYFraction


    val bodyColor = if (state == OctopusVisualState.SLEEPING) {
        einkPick(GRAY_CLOUD_SLEEP, COLOR_CLOUD_SLEEP)
    } else {
        einkPick(GRAY_CLOUD_BODY, COLOR_CLOUD_BODY)
    }

    // Keep it a little larger than the tablet color renderer: e-ink loses fine
    // detail and the prompt cutout must stay readable from a desk distance.
    val bodyRadius = w * 0.070f * scaleFactor
    val br = bodyRadius
    paint.style = Paint.Style.FILL
    paint.color = bodyColor

    val markSize = br * 1.25f
    canvas.save()
    canvas.translate(cx, cy)
    canvas.scale(markSize / CreatureGeometry.CODEX_VIEWBOX, markSize / CreatureGeometry.CODEX_VIEWBOX)
    canvas.translate(-CreatureGeometry.CODEX_VIEWBOX / 2f, -CreatureGeometry.CODEX_VIEWBOX / 2f)
    // The cloud has depth in its travel direction; its terminal remains >_, not _<.
    canvas.save()
    if (pose != null) {
        canvas.translate(12f, 12f)
        canvas.skew(0f, -pose.lookX * .055f)
        canvas.translate(-12f, -12f)
    }
    drawAquariumMark(canvas, paint, einkCodexBody)
    canvas.restore()
    drawEinkLookingFeatures(canvas, paint, "codex", pose, 12f, 1.65f, .85f)
    canvas.restore()

    // Effective body extents for positioning
    val bodyHeight = markSize / 2f
    val bodyExtentX = markSize / 2f

    // Name tag above cloud (reuse the shared name tag renderer)
    if (displayName != null) {
        drawEinkNameTag(canvas, paint, cx, cy - bodyHeight, scaleFactor, displayName, w, labelRankOf(state))
    }


}

/** E-ink crayfish — front-facing SVG path rendering with claw/antenna animation. */
/**
 * E-ink OpenCode creature — nested-square logo with smooth rounded rects.
 * Outer frame (#F1ECEC) + inner square (#4B4646).
 * Geometric and clean — no organic features.
 */
internal fun drawEinkOpenCode(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: OctopusVisualState,
    centerXFraction: Float = 0.48f,
    centerYFraction: Float = 0.40f,
    scaleFactor: Float = 1f,
    animFrame: Float = 0f,
    agentType: String? = "opencode",
    displayName: String? = null,
    pose: EinkResidentPose? = null,
) {
    val isKiro = agentType == "kiro-cli" || agentType == "kiro-ide"
    val isHermes = agentType == "hermes"
    val cx = w * centerXFraction
    val cy = h * centerYFraction


    // Canonical OpenCode ring, Kiro ghost or Hermes Nous girl. They share the
    // motion/layout mechanics, but never substitute one agent's silhouette for
    // another's. Hermes is three separate paths, drawn one by one.
    if (isKiro || isHermes) {
        val geometry = dev.agentdeck.terrarium.CreatureGeometry
        val viewBox = if (isHermes) geometry.HERMES_VIEWBOX else geometry.KIRO_VIEWBOX
        val markPaths = if (isHermes) geometry.hermesNativePaths else listOf(geometry.kiroNativePath)
        val bodyColor = if (isHermes) einkPick(GRAY_HERMES_BODY, COLOR_HERMES_BODY) else einkPick(GRAY_KIRO_BODY, COLOR_KIRO_BODY)
        val markSize = w * 0.052f * scaleFactor * if (einkColorEnabled) 2.0f else 1.75f
        // The mermaid includes the canonical 40-high tail below the 24-high head.
        // Fit the complete generated art into the body envelope, never crop its fluke.
        val artworkWidth = if (isHermes) dev.agentdeck.terrarium.HermesMermaid2D.VIEW_W else viewBox
        val artworkHeight = if (isHermes) dev.agentdeck.terrarium.HermesMermaid2D.VIEW_H else viewBox
        val svgScale = markSize / artworkHeight
        paint.style = Paint.Style.FILL
        paint.color = if (state == OctopusVisualState.SLEEPING) {
            if (isHermes) einkPick(GRAY_HERMES_SLEEP, COLOR_HERMES_SLEEP) else einkPick(GRAY_KIRO_SLEEP, COLOR_KIRO_SLEEP)
        } else {
            bodyColor
        }
        canvas.save()
        canvas.translate(cx, cy)
        canvas.scale(svgScale, svgScale)
        canvas.translate(-artworkWidth / 2f, -artworkHeight / 2f)
        if (isHermes) {
            drawEinkHermesMermaid(canvas, paint, state, pose)
        } else {
            canvas.save()
            canvas.translate(viewBox / 2f, viewBox / 2f)
            if (pose != null) canvas.rotate(pose.lookX * pose.locomotionAmount * 13f)
            canvas.translate(-viewBox / 2f, -viewBox / 2f)
            drawEinkFacingSilhouette(canvas, pose, 1f, viewBox, viewBox) {
                for (markPath in markPaths) drawAquariumMark(canvas, paint, markPath)
            }
            canvas.restore()
        }
        canvas.restore()

        if (displayName != null) {
            val pitch = Math.toRadians(((pose?.lookX ?: 0f) * (pose?.locomotionAmount ?: 0f) *
                if (isHermes) 26f else 13f).toDouble())
            val facingWidth = einkSwimmerWidth(pose)
            val halfHeight = markSize / 2f * (kotlin.math.abs(kotlin.math.cos(pitch)).toFloat() +
                artworkWidth / artworkHeight * facingWidth * kotlin.math.abs(kotlin.math.sin(pitch)).toFloat())
            drawEinkNameTag(canvas, paint, cx, cy - halfHeight, scaleFactor, displayName, w, labelRankOf(state))
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

    // Use the exact source ring, including its true opening and square corners.
    val ring = android.graphics.Path(CreatureGeometry.openCodeNativePath)
    val bounds = android.graphics.RectF().also { ring.computeBounds(it, true) }
    val ringScale = rectH / bounds.height()
    val transform = android.graphics.Matrix().apply {
        setScale(ringScale, ringScale)
        postTranslate(cx - bounds.centerX() * ringScale, cy - bounds.centerY() * ringScale)
    }
    ring.transform(transform)
    paint.style = Paint.Style.FILL
    paint.color = frameColor
    canvas.save()
    if (pose != null) {
        canvas.translate(cx, cy)
        canvas.scale(.84f + .16f * kotlin.math.abs(pose.lookX), 1f)
        canvas.skew(0f, -pose.lookX * .13f)
        canvas.translate(-cx, -cy)
    }
    drawAquariumMark(canvas, paint, ring)
    canvas.restore()

    paint.style = Paint.Style.FILL

    // Name tag (behind bubble)
    if (displayName != null) {
        drawEinkNameTag(canvas, paint, cx, cy - outerHalf * (1f + .104f * kotlin.math.abs(pose?.lookX ?: 0f)), scaleFactor, displayName, w, labelRankOf(state))
    }


}

private fun drawEinkAntigravity(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: OctopusVisualState,
    centerXFraction: Float = 0.6f,
    centerYFraction: Float = 0.28f,
    scaleFactor: Float = 1f,
    animFrame: Float = 0f,
    displayName: String? = null,
    pose: EinkResidentPose? = null,
) {
    val cx = w * centerXFraction
    val cy = h * centerYFraction


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
    if (pose != null) {
        canvas.rotate(pose.lookX * 11f + pose.turnAmount * 4f)
        canvas.scale(.84f + .16f * kotlin.math.abs(pose.lookX), 1f)
    }
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


}

internal fun drawEinkCrayfish(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: CrayfishVisualState,
    animFrame: Float = 0f,
    centerXFraction: Float = 0.75f,
    centerYFraction: Float? = null,
    scaleFactor: Float = 1f,
    pose: EinkResidentPose? = null,
) {
    // Canonical projection uses DORMANT when there is no active OpenClaw row.
    // Availability/authentication flags alone must not invent a visible creature.
    if (state == CrayfishVisualState.DORMANT) return
    val cx = w * centerXFraction
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
    val cy = centerYFraction?.let { h * it } ?: (baseY + bobOffset)
    val bodyWidth = w * 0.11f * scaleFactor

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

    // Articulate the separate canonical claw paths around their real shoulders.
    paint.style = Paint.Style.FILL
    paint.color = if (state == CrayfishVisualState.SICK) {
        einkPick(GRAY_CRAY_SICK, COLOR_CRAY_SICK)
    } else {
        einkPick(GRAY_CRAY_BODY, COLOR_CRAY_BODY)
    }
    paint.alpha = if (state == CrayfishVisualState.DORMANT) 105 else 255
    if (!einkColorEnabled && dev.agentdeck.terrarium.CreatureBrandFeatures.monochromeLightBodyAgents.contains("openclaw")) paint.color = GRAY_AIR
    val clawOrder = intArrayOf(1, 2, 0)
    for (index in clawOrder) {
        val path = if (index == 0) einkOpenClawBody else CreatureGeometry.openClawBodyNativePaths[index]
        canvas.save()
        if (index > 0 && pose != null) {
            val side = if (index == 1) -1f else 1f
            val offset = if (index == 1) 0f else 1.8f
            val gaitStroke = kotlin.math.sin(pose.phase + offset) * pose.locomotionAmount * 9f
            val workStroke = kotlin.math.sin(pose.workPhase + offset) * pose.workAmount * 23f
            val shoulderX = if (index == 1) 4f else 20f
            canvas.scale(1f + side * pose.lookX * .10f, 1f, shoulderX, 10.5f)
            canvas.rotate(side * (gaitStroke + workStroke) + pose.lookX * 5f,
                if (index == 1) 4f else 20f, 10.5f)
        }
        drawAquariumMark(canvas, paint, path)
        if (!einkColorEnabled) drawMonochromeCreatureOutline(canvas, paint, path)
        canvas.restore()
    }
    drawEinkLookingFeatures(canvas, paint, "openclaw", pose, 8f, 1.45f, .65f)
    paint.alpha = 255

    canvas.restore() // main transform

    // ROUTING: signal arcs (outside SVG transform)
    if (state == CrayfishVisualState.ROUTING && pose == null) {
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

private fun drawEinkFishSchool(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: TetraVisualState, layer: Int, fishSchool: EinkFishSchool?,
) {
    if (state == TetraVisualState.ABSENT || fishSchool == null) return
    val fishSize = w * .012f
    for (fish in fishSchool.fish) {
        val fishLayer = if (fish.depth < .86f) 0 else 1
        if (fishLayer != layer) continue
        drawEinkFish(canvas, paint, fish.x * w, fish.y * h, fishSize * fish.depth,
            fish.facing, fish.pitch, fish.tailBeat)
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
// Mermaid tail on B/W paper: mid gray body, dark rim, light fluke.
private const val GRAY_HERMES_TAIL = 0xFF777777.toInt()
private const val GRAY_HERMES_RIM = 0xFF444444.toInt()
private const val GRAY_HERMES_FLUKE = 0xFFAAAAAA.toInt()
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
// Kelp tokens (design/tokens.css), the tail colours on Kaleido colour e-ink.
private val COLOR_HERMES_TAIL = 0xFF2F8A7C.toInt()
private val COLOR_HERMES_RIM = 0xFF1F6157.toInt()
private val COLOR_HERMES_FLUKE = 0xFF6FB6A8.toInt()
private val COLOR_HERMES_TAIL_SLEEP = 0xFF6F8F89.toInt()

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

// --- Hermes 2D mermaid (e-ink) ---------------------------------------------
// The generated kelp tail (scripts/generate-hermes-mermaid-2d.mjs) under the
// official Nous girl head, whose crop fades into the tail — a mermaid, never a
// floating head. Drawn in the head-anchored mark space (viewBox 24, head at
// the origin), so the name tag and bubble above it stay where they were.
private val hermesTailPath by lazy { androidx.core.graphics.PathParser.createPathFromPathData(dev.agentdeck.terrarium.HermesMermaid2D.TAIL) }
private val hermesRimPath by lazy { androidx.core.graphics.PathParser.createPathFromPathData(dev.agentdeck.terrarium.HermesMermaid2D.RIM) }
private val hermesFlukePath by lazy { androidx.core.graphics.PathParser.createPathFromPathData(dev.agentdeck.terrarium.HermesMermaid2D.FLUKE) }

internal fun drawEinkHermesMermaid(canvas: android.graphics.Canvas, paint: Paint, state: OctopusVisualState, pose: EinkResidentPose? = null) {
    val asleep = state == OctopusVisualState.SLEEPING
    val headColor = paint.color
    canvas.save()
    // Nous girl's source face looks left. Turn the complete figure so her tail
    // trails the same way; the name remains outside this body transform.
    val centerX = dev.agentdeck.terrarium.HermesMermaid2D.VIEW_W / 2f
    val centerY = dev.agentdeck.terrarium.HermesMermaid2D.VIEW_H / 2f
    canvas.translate(centerX, centerY)
    if (pose != null) canvas.rotate(pose.lookX * pose.locomotionAmount * 26f)
    canvas.translate(-centerX, -centerY)
    drawEinkFacingSilhouette(canvas, pose, -1f, centerX * 2f, centerY * 2f) {
    paint.style = Paint.Style.FILL
    paint.shader = null
    val stroke = kotlin.math.sin(pose?.phase ?: 0f) * (pose?.locomotionAmount ?: 0f)
    canvas.save()
    canvas.rotate(stroke * 9f, 12f, 20f)
    paint.color = if (asleep) einkPick(GRAY_HERMES_SLEEP, COLOR_HERMES_TAIL_SLEEP) else einkPick(GRAY_HERMES_TAIL, COLOR_HERMES_TAIL)
    canvas.drawPath(hermesTailPath, paint)
    paint.color = if (asleep) einkPick(GRAY_HERMES_SLEEP, COLOR_HERMES_TAIL_SLEEP) else einkPick(GRAY_HERMES_RIM, COLOR_HERMES_RIM)
    canvas.drawPath(hermesRimPath, paint)
    paint.color = if (asleep) einkPick(GRAY_HERMES_SLEEP, COLOR_HERMES_TAIL_SLEEP) else einkPick(GRAY_HERMES_FLUKE, COLOR_HERMES_FLUKE)
    canvas.save()
    canvas.rotate(stroke * 8f, 21f, 33.6f)
    canvas.drawPath(hermesFlukePath, paint)
    canvas.restore()
    canvas.restore()
    val fade = android.graphics.LinearGradient(
        0f, dev.agentdeck.terrarium.HermesMermaid2D.FADE_START, 0f, dev.agentdeck.terrarium.HermesMermaid2D.FADE_END,
        headColor, headColor and 0x00FFFFFF, android.graphics.Shader.TileMode.CLAMP,
    )
    paint.shader = fade
    for (markPath in dev.agentdeck.terrarium.CreatureGeometry.hermesNativePaths) canvas.drawPath(markPath, paint)
    paint.shader = null
    paint.color = headColor
    }
    canvas.restore()
}
