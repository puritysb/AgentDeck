package dev.agentdeck.terrarium

import android.graphics.Paint
import androidx.compose.ui.graphics.nativeCanvas

object CreatureNameTagStyle {
    // Use the tablet OpenCode creature as the SSOT for name-tag sizing.
    const val REFERENCE_BODY_FRACTION = 0.064f
    const val GAP_RATIO = 0.05f
    const val WIDTH_RATIO = 1.6f
    const val BASE_FONT_RATIO = 0.40f
    const val MIN_HEIGHT_RATIO = 0.25f
    const val TEXT_WIDTH_RATIO = 0.9f
    const val PADDING_RATIO = 0.12f
    const val LINE_HEIGHT_RATIO = 1.3f
    const val MULTILINE_EXTRA_RATIO = 0.3f

    val FONT_TIERS = floatArrayOf(0.60f, 0.45f, 0.35f)
}

data class CreatureNameTagLayout(
    val bodyMetric: Float,
    val tagBottomY: Float,
    val tagWidth: Float,
    val tagHeight: Float,
    val fontSize: Float,
    val lines: List<String>,
    val lineHeight: Float,
)

fun creatureNameTagMetric(canvasWidth: Float, scaleFactor: Float): Float {
    return canvasWidth * CreatureNameTagStyle.REFERENCE_BODY_FRACTION * scaleFactor
}

fun resolveCreatureNameTagLayout(
    name: String,
    bodyTopY: Float,
    bodyMetric: Float,
    paint: Paint,
): CreatureNameTagLayout {
    val tagWidth = bodyMetric * CreatureNameTagStyle.WIDTH_RATIO
    val maxTextWidth = tagWidth * CreatureNameTagStyle.TEXT_WIDTH_RATIO
    var chosenSize = bodyMetric * CreatureNameTagStyle.BASE_FONT_RATIO * CreatureNameTagStyle.FONT_TIERS.first()
    var lines = listOf(name)

    for (tier in CreatureNameTagStyle.FONT_TIERS) {
        chosenSize = bodyMetric * CreatureNameTagStyle.BASE_FONT_RATIO * tier
        paint.textSize = chosenSize
        val textWidth = paint.measureText(name)
        if (textWidth <= maxTextWidth) {
            lines = listOf(name)
            break
        }
        if (tier == CreatureNameTagStyle.FONT_TIERS.last()) {
            lines = wrapCreatureNameTagToTwoLines(name, paint)
        }
    }

    val lineHeight = chosenSize * CreatureNameTagStyle.LINE_HEIGHT_RATIO
    val tagHeight = if (lines.size == 1) {
        bodyMetric * CreatureNameTagStyle.MIN_HEIGHT_RATIO
    } else {
        lineHeight * lines.size + chosenSize * CreatureNameTagStyle.MULTILINE_EXTRA_RATIO
    }

    return CreatureNameTagLayout(
        bodyMetric = bodyMetric,
        tagBottomY = bodyTopY - bodyMetric * CreatureNameTagStyle.GAP_RATIO,
        tagWidth = tagWidth,
        tagHeight = tagHeight,
        fontSize = chosenSize,
        lines = lines,
        lineHeight = lineHeight,
    )
}

fun wrapCreatureNameTagToTwoLines(text: String, paint: Paint): List<String> {
    val spaces = text.indices.filter { text[it] == ' ' }
    if (spaces.isEmpty()) return listOf(text)

    var bestSplit = spaces.minByOrNull { kotlin.math.abs(it - text.length / 2) } ?: return listOf(text)
    var bestMax = Float.MAX_VALUE

    for (sp in spaces) {
        val line1 = text.substring(0, sp)
        val line2 = text.substring(sp + 1)
        val maxWidth = maxOf(paint.measureText(line1), paint.measureText(line2))
        if (maxWidth < bestMax) {
            bestMax = maxWidth
            bestSplit = sp
        }
    }

    return listOf(text.substring(0, bestSplit), text.substring(bestSplit + 1))
}

/**
 * One 2D creature name tag, measured but not yet painted (DESIGN.md §6.4).
 *
 * Each creature used to paint its own tag inside its own `draw`, so a tag's
 * z-order was the creature order and a front tag could sit over any resident
 * behind it. While [CreatureNameTagLayer.active] is set, creatures submit their
 * tags here and the renderer resolves them all with [resolveResidentLabels] —
 * the rule the 3D aquarium uses — after the last creature.
 */
internal class CreatureNameTagRequest(
    val cx: Float,
    val tagBottomY: Float,
    val tagWidth: Float,
    val tagHeight: Float,
    val fontSize: Float,
    val lines: List<String>,
    val lineHeight: Float,
    val background: androidx.compose.ui.graphics.Color,
    val paint: Paint,
    val rank: Int,
    val bodyTopY: Float,
    val bodyMetric: Float,
) {
    val box get() = LabelBox(cx - tagWidth / 2, tagBottomY - tagHeight, cx + tagWidth / 2, tagBottomY)
    val body get() = LabelBox(cx - bodyMetric * 0.7f, bodyTopY, cx + bodyMetric * 0.7f, bodyTopY + bodyMetric * 1.2f)
}

/** Base alpha of a 2D tag's brand-tinted backing; the resolver scales it. */
private const val TAG_BACKING_BASE_ALPHA = 0.6f

internal fun labelRankOf(state: OctopusVisualState): Int = when (state) {
    OctopusVisualState.ASKING -> LABEL_RANK_AWAITING
    OctopusVisualState.WORKING -> LABEL_RANK_WORKING
    else -> LABEL_RANK_IDLE
}

internal object CreatureNameTagLayer {
    /** Set by the renderer for one frame; Compose draws on a single thread. */
    var active: MutableList<CreatureNameTagRequest>? = null

    /** Paints every queued tag, lowest priority first, then clears the queue. */
    fun flush(scope: androidx.compose.ui.graphics.drawscope.DrawScope, requests: MutableList<CreatureNameTagRequest>) {
        val inputs = requests.mapIndexed { index, r -> ResidentLabelInput(index.toString(), r.rank, r.body, r.box, r.box) }
        for (decision in resolveResidentLabels(inputs)) {
            if (decision.mode == ResidentLabelMode.HIDDEN) continue
            val request = requests[decision.id.toInt()]
            paintCreatureNameTag(scope, request, TAG_BACKING_BASE_ALPHA * decision.backingAlpha, decision.textAlpha)
        }
        requests.clear()
    }
}

/** Queue [request] when a frame layer is active; otherwise paint it in place. */
internal fun submitCreatureNameTag(scope: androidx.compose.ui.graphics.drawscope.DrawScope, request: CreatureNameTagRequest) {
    val layer = CreatureNameTagLayer.active
    if (layer != null) layer += request
    else paintCreatureNameTag(scope, request, TAG_BACKING_BASE_ALPHA, 1f)
}

internal fun paintCreatureNameTag(
    scope: androidx.compose.ui.graphics.drawscope.DrawScope,
    request: CreatureNameTagRequest,
    backingAlpha: Float,
    textAlpha: Float,
) {
    scope.drawRoundRect(
        color = request.background,
        alpha = backingAlpha,
        topLeft = androidx.compose.ui.geometry.Offset(request.cx - request.tagWidth / 2, request.tagBottomY - request.tagHeight),
        size = androidx.compose.ui.geometry.Size(request.tagWidth, request.tagHeight),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(4f, 4f),
    )
    val canvas = scope.drawContext.canvas.nativeCanvas
    val paint = request.paint
    val baseAlpha = paint.alpha
    paint.textSize = request.fontSize
    paint.alpha = (baseAlpha * textAlpha).toInt()
    if (request.lines.size == 1) {
        canvas.drawText(request.lines[0], request.cx, request.tagBottomY - request.tagHeight * 0.25f, paint)
    } else {
        val topY = request.tagBottomY - request.tagHeight + request.fontSize * 0.3f + request.fontSize
        for (i in request.lines.indices) {
            canvas.drawText(request.lines[i], request.cx, topY + i * request.lineHeight, paint)
        }
    }
    paint.alpha = baseAlpha
}
