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

    fun draw(canvas: Canvas, item: AquariumResident, x: Float, y: Float,
        bodyX: Float, bodyY: Float, unit: Float, phase: Float, selected: Boolean, labelsVisible: Boolean) {
        paint.style = Paint.Style.FILL
        if (selected) {
            paint.color = TerrariumColors.TetraNeon.toArgb()
            for (side in -1..1 step 2) {
                val railX = bodyX + side * unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_X
                canvas.drawRect(railX - unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_WIDTH / 2f, bodyY - unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_HEIGHT / 2f,
                    railX + unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_WIDTH / 2f, bodyY + unit * TerrariumRules.NATIVE_ACTIVITY_SELECTION_HEIGHT / 2f, paint)
            }
        }
        val working = item.state == OctopusVisualState.WORKING
        if (working) {
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
        if (!labelsVisible) return
        val status = when (item.state) {
            OctopusVisualState.WORKING -> "WORKING"
            OctopusVisualState.ASKING -> "WAITING"
            else -> "IDLE"
        } + if (item.helpers > 0) " · ${item.helpers} agents" else ""
        val color = when (item.state) {
            OctopusVisualState.WORKING -> DesignTokens.Status.processing
            OctopusVisualState.ASKING -> DesignTokens.Status.awaiting
            else -> DesignTokens.Status.idle
        }.toArgb()
        paint.textAlign = Paint.Align.CENTER
        paint.typeface = regular
        paint.textSize = 12f * density
        val title = item.title.take(22)
        val titleWidth = paint.measureText(title)
        paint.typeface = bold
        val half = max(titleWidth, paint.measureText(status)) / 2f + 10f * density
        paint.color = TerrariumColors.DeepSea.toArgb()
        canvas.drawRoundRect(x-half, y-18f*density, x+half, y+25f*density, 6f*density, 6f*density, paint)
        if (working) {
            paint.color = color
            canvas.drawRoundRect(x-half+3f*density, y+3f*density, x+half-3f*density, y+23f*density,
                4f*density, 4f*density, paint)
        }
        paint.typeface = regular
        paint.color = DesignTokens.Tide.s50.toArgb()
        canvas.drawText(title, x, y-3f*density, paint)
        paint.typeface = bold
        paint.color = if (working) DesignTokens.Ink.s900.toArgb() else color
        canvas.drawText(status, x, y+17f*density, paint)
    }

    fun drawOverflow(canvas: Canvas, count: Int) {
        paint.textAlign = Paint.Align.CENTER
        paint.typeface = regular
        paint.textSize = 12f * density
        paint.color = DesignTokens.Tide.s50.toArgb()
        canvas.drawText("$count sessions · select a session in the list to bring it into view",
            canvas.width / 2f, 30f * density, paint)
    }
}
