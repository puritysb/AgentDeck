package dev.agentdeck.terrarium

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.content.Context
import dev.agentdeck.R
import dev.agentdeck.net.CiWaitStatus
import dev.agentdeck.ui.theme.DesignTokens
import androidx.compose.ui.graphics.toArgb
import kotlin.math.*

internal fun ciCompanionLabel(wait: CiWaitStatus): String {
    val phase = if (wait.phase in listOf("queued", "running", "passed", "failed")) wait.phase.uppercase() else "UNKNOWN"
    return "CI $phase" + (wait.pr?.let { " #$it" } ?: "") + (wait.checks?.let { " · ${it.passed}/${it.total}" } ?: "")
}
internal fun ciCompanionBadge(wait: CiWaitStatus) = when (wait.phase) {
    "running" -> wait.checks?.let { "${it.passed}/${it.total}" } ?: "CI running"
    "queued" -> "CI queued"; "passed" -> "CI ✓"; "failed" -> "CI !"; else -> "CI ?"
}
internal fun ciCompanionColor(wait: CiWaitStatus?) = when (wait?.phase) {
    "queued", "running" -> DesignTokens.Session.working
    "passed" -> DesignTokens.UI.ok
    "failed" -> DesignTokens.Session.error
    else -> DesignTokens.Session.idle
}
internal fun ciCompanionActive(wait: CiWaitStatus?) = wait?.agentWaiting == true && wait.phase != "passed" && wait.phase != "failed"
internal fun ciCompanionSeed(id: String): Float {
    var hash = TerrariumRules.CI_COMPANION_SEED_OFFSET
    for (byte in id.toByteArray(Charsets.UTF_8)) hash = ((hash xor (byte.toLong() and 255L))*TerrariumRules.CI_COMPANION_SEED_PRIME) and 0xffffffffL
    return (hash%TerrariumRules.CI_COMPANION_SEED_MODULUS).toFloat()/TerrariumRules.CI_COMPANION_SEED_MODULUS
}
internal fun ciCompanionSpeed(wait: CiWaitStatus): Float = TerrariumRules.CI_COMPANION_RADIANS_PER_SECOND * when(wait.phase) {
    "running" -> 1f; "queued" -> TerrariumRules.CI_COMPANION_QUEUED_SPEED; else -> TerrariumRules.CI_COMPANION_UNKNOWN_SPEED
}
internal class CiCompanionMotion(id: String) {
    var angle = ciCompanionSeed(id) * 2f * PI.toFloat()
        private set
    private var key: String? = null
    private var resultDeadline: Double? = null

    fun update(wait: CiWaitStatus, dt: Float, now: Double = System.nanoTime() / 1_000_000_000.0) {
        val next = "${wait.openedAt}:${wait.phase}"
        if (next != key && wait.phase in listOf("passed", "failed")) {
            if (key == null) angle = TerrariumRules.CI_COMPANION_STATIC_ANGLE
            resultDeadline = now + TerrariumRules.CI_COMPANION_RESULT_SECONDS
        } else if (wait.phase !in listOf("passed", "failed")) resultDeadline = null
        key = next
        if (ciCompanionActive(wait)) angle += dt * ciCompanionSpeed(wait)
    }

    fun visible(wait: CiWaitStatus, now: Double = System.nanoTime() / 1_000_000_000.0) =
        ciCompanionActive(wait) || (wait.phase in listOf("passed", "failed") && resultDeadline?.let { now < it } == true)
}
internal fun ciCompanionPosition(center: Pair<Float,Float>,angle: Float,w: Float,h: Float): Pair<Float,Float> {
    val short = min(w,h); val inset = TerrariumRules.CI_COMPANION_EDGE_INSET
    return (center.first+cos(angle)*TerrariumRules.CI_COMPANION_ORBIT_RADIUS_X*short/w).coerceIn(inset,1f-inset) to
        (center.second+sin(angle)*TerrariumRules.CI_COMPANION_ORBIT_RADIUS_Y*short/h).coerceIn(inset,1f-inset)
}
internal fun ciCompanionTypeface(context: Context): Typeface =
    Typeface.createFromAsset(context.assets, "fonts/IBMPlexSans-Regular.ttf")

internal fun ciCompanionBitmap(context: Context): Bitmap = BitmapFactory.decodeResource(context.resources,R.drawable.ci_companion)
internal fun drawCiCompanion(canvas: Canvas,paint: Paint,bitmap: Bitmap,center: Pair<Float,Float>,position: Pair<Float,Float>,wait: CiWaitStatus,textScale: Float=1f,ink: Int?=null,showCaption: Boolean=true) {
    val width=min(canvas.width,canvas.height)*TerrariumRules.CI_COMPANION_SIZE_FRAC
    val x=position.first*canvas.width;val y=position.second*canvas.height
    paint.shader=null;paint.style=Paint.Style.FILL;paint.alpha=90;paint.color=ink ?: ciCompanionColor(wait).toArgb();paint.strokeWidth=1f
    canvas.drawLine(center.first*canvas.width,center.second*canvas.height,x,y,paint)
    paint.alpha=255;canvas.drawBitmap(bitmap,null,RectF(x-width/2,y-width/2,x+width/2,y+width/2),paint)
    if (!showCaption) return
    paint.textAlign=Paint.Align.CENTER;paint.textSize=11f*textScale;paint.color=ink ?: ciCompanionColor(wait).toArgb()
    canvas.drawText(ciCompanionBadge(wait),x,y+width/2+8f*textScale,paint)
}
