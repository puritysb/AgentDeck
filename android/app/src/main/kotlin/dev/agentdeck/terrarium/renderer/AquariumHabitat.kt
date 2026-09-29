package dev.agentdeck.terrarium.renderer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import dev.agentdeck.R

/** Baked lighting costs one bitmap draw; residents and their labels remain live. */
internal class AquariumHabitat private constructor(private val bitmap: Bitmap, private val physicalMonochrome: Boolean = false) {
    private val source = Rect()
    private val destination = RectF()
    private val bitmapPaint = Paint(Paint.FILTER_BITMAP_FLAG)

    fun draw(canvas: Canvas, width: Int, height: Int) {
        // Center crop instead of stretching the rocks when the device rotates.
        val scale = maxOf(width.toFloat() / bitmap.width, height.toFloat() / bitmap.height)
        val cropWidth = (width / scale).toInt().coerceIn(1, bitmap.width)
        val cropHeight = (height / scale).toInt().coerceIn(1, bitmap.height)
        val left = (bitmap.width - cropWidth) / 2
        val top = (bitmap.height - cropHeight) / 2
        source.set(left, top, left + cropWidth, top + cropHeight)
        destination.set(0f, 0f, width.toFloat(), height.toFloat())
        canvas.drawBitmap(bitmap, source, destination, bitmapPaint)
    }

    /** Small background residents have no labels/status and cannot be confused with agents. */
    fun drawResidents(canvas: Canvas, paint: Paint, width: Int, height: Int, frame: Float) {
        val phase = frame / 32f * (Math.PI * 2).toFloat()
        val unit = minOf(width, height).toFloat()
        val oldColor = paint.color
        val oldStyle = paint.style
        val oldWidth = paint.strokeWidth
        canvas.save()
        // Local sway at the edges, never a moving light/texture across the whole panel.
        paint.color = Color.GRAY
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = unit * 0.004f
        for (side in 0..1) {
            val rootX = width * if (side == 0) 0.04f else 0.96f
            for (leaf in 0..2) {
                val sway = kotlin.math.sin(phase + leaf * 0.8f) * unit * 0.012f
                val x = rootX + (leaf - 1) * unit * 0.015f
                residentPath.reset()
                residentPath.moveTo(x, height * 0.94f)
                residentPath.cubicTo(x - sway, height * 0.89f,
                    x + sway, height * 0.83f, x + sway * 1.5f, height * (0.76f + leaf * 0.025f))
                canvas.drawPath(residentPath, paint)
            }
        }
        // A grazing snail: slow bounded travel, shell spiral and gently probing antennae.
        val snailX = width * 0.82f + kotlin.math.sin(phase) * unit * 0.018f
        val snailY = height * 0.93f
        val radius = unit * 0.018f
        paint.style = Paint.Style.FILL
        paint.color = Color.DKGRAY
        canvas.drawOval(snailX - radius * 1.4f, snailY, snailX + radius * 1.8f,
            snailY + radius * 0.5f, paint)
        paint.color = Color.LTGRAY
        canvas.drawCircle(snailX, snailY - radius * 0.55f, radius, paint)
        paint.style = Paint.Style.STROKE
        paint.color = Color.DKGRAY
        paint.strokeWidth = unit * 0.002f
        canvas.drawCircle(snailX, snailY - radius * 0.55f, radius, paint)
        canvas.drawArc(snailX - radius * 0.55f, snailY - radius * 1.1f,
            snailX + radius * 0.55f, snailY, 20f, 290f, false, paint)
        val feel = kotlin.math.sin(phase * 2f) * radius * 0.15f
        for (antenna in 0..1) {
            canvas.drawLine(snailX + radius * 1.3f, snailY + radius * 0.15f,
                snailX + radius * (1.5f + antenna * 0.35f) + feel,
                snailY - radius * (0.7f - antenna * 0.25f), paint)
        }
        // Bubbles remain an LCD/color detail: grayscale fast waveforms lose soft alpha.
        if (!physicalMonochrome) {
            paint.color = Color.LTGRAY
            for (bubble in 0..2) {
                val travel = (frame / 32f + bubble / 3f) % 1f
                paint.alpha = (kotlin.math.sin(travel * Math.PI) * 100).toInt()
                val x = width * 0.93f + kotlin.math.sin(phase + bubble) * unit * 0.007f
                canvas.drawCircle(x, height * (0.78f - travel * 0.52f), unit * 0.004f, paint)
            }
        }
        canvas.restore()
        paint.color = oldColor
        paint.style = oldStyle
        paint.strokeWidth = oldWidth
    }

    private val residentPath = Path()

    companion object {
        fun load(context: Context, color: Boolean, physicalEink: Boolean = false): AquariumHabitat? {
            val source = BitmapFactory.decodeResource(context.resources, R.drawable.aquarium_habitat)
                ?: return null
            if (color) return AquariumHabitat(source)
            val gray = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
            val paint = Paint().apply {
                colorFilter = ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(0f) })
            }
            Canvas(gray).drawBitmap(source, 0f, 0f, paint)
            source.recycle()
            if (physicalEink) {
                // Fixed 16-level, lifted background preserves agent contrast. This is
                // computed once, not temporal dithering that would shimmer each frame.
                val pixels = IntArray(gray.width * gray.height)
                gray.getPixels(pixels, 0, gray.width, 0, 0, gray.width, gray.height)
                for (index in pixels.indices) {
                    val value = einkHabitatGray(Color.red(pixels[index]))
                    pixels[index] = Color.rgb(value, value, value)
                }
                gray.setPixels(pixels, 0, gray.width, 0, 0, gray.width, gray.height)
            }
            return AquariumHabitat(gray, physicalEink)
        }
    }
}

/** The canonical path, including its holes, receives the habitat's top-left light. */
internal fun drawAquariumMark(canvas: Canvas, paint: Paint, path: Path) {
    if (!paint.isAntiAlias || paint.shader != null) {
        canvas.drawPath(path, paint)
        return
    }
    val bounds = RectF()
    path.computeBounds(bounds, true)
    if (bounds.isEmpty) return
    fun shade(factor: Float): Int = Color.argb(
        255, // Paint already carries opacity; shader alpha must not dim dormant marks twice.
        (Color.red(paint.color) * factor).toInt().coerceIn(0, 255),
        (Color.green(paint.color) * factor).toInt().coerceIn(0, 255),
        (Color.blue(paint.color) * factor).toInt().coerceIn(0, 255),
    )
    paint.shader = LinearGradient(bounds.left, bounds.top, bounds.right, bounds.bottom,
        shade(1.4f), shade(0.72f), Shader.TileMode.CLAMP)
    canvas.drawPath(path, paint)
    paint.shader = null
}

/** Reserve the dark end of the panel for live marks and labels. */
internal fun einkHabitatGray(luminance: Int): Int =
    (kotlin.math.round((102f + luminance.coerceIn(0, 255) * 0.6f) / 17f).toInt() * 17).coerceIn(0, 255)
