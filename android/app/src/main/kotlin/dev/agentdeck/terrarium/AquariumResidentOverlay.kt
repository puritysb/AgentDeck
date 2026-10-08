package dev.agentdeck.terrarium

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.ui.graphics.toArgb
import dev.agentdeck.ui.theme.DesignTokens
import kotlin.math.max
import kotlin.math.sin

/** Display-resolution cues shared by every native resident, independent of Filament lighting. */
internal class AquariumResidentOverlay(context: Context) {
    private val density = context.resources.displayMetrics.density
    private val regular = Typeface.createFromAsset(context.assets, "fonts/IBMPlexSans-Regular.ttf")
    private val bold = Typeface.create(regular, Typeface.BOLD)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    fun drawCompanionCaption(canvas: Canvas,wait: dev.agentdeck.net.CiWaitStatus,x: Float,y: Float,size: Float) {
        paint.typeface=regular;paint.textAlign=Paint.Align.CENTER;paint.textSize=11f*density
        paint.color=ciCompanionColor(wait).toArgb();paint.alpha=255;paint.style=Paint.Style.FILL
        canvas.drawText(ciCompanionBadge(wait),x,y+size/2+8f*density,paint)
    }

    /** Selection rails and the working bars — body cues, drawn whether or not tags are. */
    fun drawCues(canvas: Canvas, item: AquariumResident, bodyX: Float, bodyY: Float, unit: Float,
        phase: Float, selected: Boolean) {
        paint.style = Paint.Style.FILL
        paint.alpha = 255
        if (selected) {
            paint.color = TerrariumColors.TetraNeon.toArgb()
            for (side in -1..1 step 2) {
                val railX = bodyX + side * unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_X
                canvas.drawRect(railX - unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_WIDTH / 2f, bodyY - unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_HEIGHT / 2f,
                    railX + unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_WIDTH / 2f, bodyY + unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_HEIGHT / 2f, paint)
            }
        }
        if (item.ciWait != null && item.state != OctopusVisualState.ASKING) {
            paint.color = ciCompanionColor(item.ciWait).toArgb()
            paint.textAlign = Paint.Align.CENTER; paint.typeface = bold; paint.textSize = max(12f*density, unit*.3f)
            val mark = when (item.ciWait.phase) { "passed" -> "✓"; "failed" -> "!"; "unknown" -> "?"; else -> "CI" }
            canvas.drawText(mark, bodyX+unit*.8f, bodyY, paint)
        }
        if (item.state == OctopusVisualState.WORKING && item.ciWait?.agentWaiting != true) {
            // Neutral bars move; the semantic WORKING badge stays steady.
            paint.color = DesignTokens.Tide.s50.toArgb()
            for (index in 0 until TerrariumRules.NATIVE_ACTIVITY_BAR_COUNT.toInt()) {
                val scale = TerrariumRules.NATIVE_ACTIVITY_BAR_MINIMUM + TerrariumRules.NATIVE_ACTIVITY_BAR_RANGE *
                    (.5f + .5f * sin(phase * TerrariumRules.NATIVE_ACTIVITY_BAR_RATE + index * TerrariumRules.NATIVE_ACTIVITY_BAR_PHASE))
                val barX = bodyX + unit * (TerrariumRules.NATIVE_ACTIVITY_BAR_X + index * TerrariumRules.NATIVE_ACTIVITY_BAR_SPACING)
                val centerY = bodyY - unit * TerrariumRules.NATIVE_ACTIVITY_BAR_Y
                val halfHeight = unit * TerrariumRules.NATIVE_ACTIVITY_BAR_HEIGHT / 2f * scale
                canvas.drawRoundRect(barX - unit * TerrariumRules.NATIVE_ACTIVITY_BAR_WIDTH / 2f, centerY - halfHeight,
                    barX + unit * TerrariumRules.NATIVE_ACTIVITY_BAR_WIDTH / 2f, centerY + halfHeight, unit * TerrariumRules.NATIVE_ACTIVITY_BAR_RADIUS, unit * TerrariumRules.NATIVE_ACTIVITY_BAR_RADIUS, paint)
            }
        }
    }

    private fun title(item: AquariumResident) = item.title.take(22)

    private fun status(item: AquariumResident) = item.ciWaitLabel ?: (when (item.state) {
        OctopusVisualState.WORKING -> "WORKING"
        OctopusVisualState.ASKING -> "WAITING"
        else -> "IDLE"
    } + if (item.helpers > 0) " · ${item.helpers} agents" else "")

    /** Session state colour (DESIGN.md §2.7), never the marketing Status palette. */
    private fun stateColor(item: AquariumResident) = (if (item.state != OctopusVisualState.ASKING && item.ciWait != null) ciCompanionColor(item.ciWait) else when (item.state) {
        OctopusVisualState.WORKING -> DesignTokens.Session.working
        OctopusVisualState.ASKING -> DesignTokens.Session.awaiting
        else -> DesignTokens.Session.idle
    }).toArgb()

    /** Full two-line tag, anchored above the body at (x, y). */
    fun fullTagBox(item: AquariumResident, x: Float, y: Float): LabelBox {
        paint.textSize = 12f * density
        paint.typeface = regular
        val titleWidth = paint.measureText(title(item))
        paint.typeface = bold
        val half = max(titleWidth, paint.measureText(status(item))) / 2f + 10f * density
        return LabelBox(x - half, y - 18f * density, x + half, y + 25f * density)
    }

    /** Title-only chip, sitting on the same baseline as the full tag's bottom edge. */
    fun compactTagBox(item: AquariumResident, x: Float, y: Float): LabelBox {
        paint.textSize = 11f * density
        paint.typeface = regular
        val half = paint.measureText(title(item)) / 2f + 7f * density
        return LabelBox(x - half, y + 6f * density, x + half, y + 25f * density)
    }

    fun drawTag(canvas: Canvas, item: AquariumResident, x: Float, y: Float, decision: ResidentLabelDecision) {
        if (decision.mode == ResidentLabelMode.HIDDEN) return
        paint.style = Paint.Style.FILL
        paint.textAlign = Paint.Align.CENTER
        val textAlpha = (decision.textAlpha * 255).toInt()
        val backingAlpha = (decision.backingAlpha * 255).toInt()
        if (decision.mode == ResidentLabelMode.COMPACT) {
            val box = compactTagBox(item, x, y)
            paint.color = TerrariumColors.DeepSea.toArgb(); paint.alpha = backingAlpha
            canvas.drawRoundRect(box.left, box.top, box.right, box.bottom, 5f * density, 5f * density, paint)
            paint.typeface = regular; paint.textSize = 11f * density
            paint.color = DesignTokens.UI.hudSubtext.toArgb(); paint.alpha = textAlpha
            canvas.drawText(title(item), x, box.bottom - 6f * density, paint)
            paint.alpha = 255
            return
        }
        val working = item.state == OctopusVisualState.WORKING
        val color = stateColor(item)
        val box = fullTagBox(item, x, y)
        paint.color = TerrariumColors.DeepSea.toArgb(); paint.alpha = backingAlpha
        canvas.drawRoundRect(box.left, box.top, box.right, box.bottom, 6f*density, 6f*density, paint)
        val signalAlpha = (decision.signalAlpha * 255).toInt()
        if (working) {
            // The WORKING badge is the state signal; it fades only when the tag
            // yields to another resident's body. `setColor` resets alpha, so the
            // alpha is applied after it.
            paint.color = color; paint.alpha = signalAlpha
            canvas.drawRoundRect(box.left+3f*density, y+3f*density, box.right-3f*density, y+23f*density,
                4f*density, 4f*density, paint)
        }
        paint.typeface = regular; paint.textSize = 12f * density
        paint.color = DesignTokens.UI.hudText.toArgb(); paint.alpha = textAlpha
        canvas.drawText(title(item), x, y-3f*density, paint)
        paint.typeface = bold
        paint.color = if (working) DesignTokens.Ink.s900.toArgb() else color
        paint.alpha = if (working) signalAlpha else textAlpha
        canvas.drawText(status(item), x, y+17f*density, paint)
        paint.alpha = 255
    }

    fun drawOverflow(canvas: Canvas, count: Int) {
        paint.textAlign = Paint.Align.CENTER
        paint.typeface = regular
        paint.textSize = 12f * density
        paint.color = DesignTokens.UI.hudText.toArgb()
        canvas.drawText("$count sessions · select a session in the list to bring it into view",
            canvas.width / 2f, 30f * density, paint)
    }
}
