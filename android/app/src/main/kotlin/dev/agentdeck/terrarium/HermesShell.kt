package dev.agentdeck.terrarium

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path

/** Screen-space scallop home, shared by LCD and static e-ink renderers. Coordinates are local pixels. */
internal object HermesShell {
    private val valve = Path().apply {
        moveTo(-.5f, 0f); cubicTo(-.75f,-.55f,.75f,-.55f,.5f,0f)
        lineTo(.10f,.15f); lineTo(-.10f,.15f); close()
    }
    fun draw(canvas: Canvas, paint: Paint, x: Float, y: Float, width: Float, open: Float, fill: Int, rim: Int) {
        val color=paint.color; val style=paint.style; val stroke=paint.strokeWidth; val shader=paint.shader
        paint.shader=null
        canvas.save(); canvas.translate(x,y); canvas.scale(width,width)
        paint.color=fill;paint.style=Paint.Style.FILL
        canvas.save();canvas.scale(1f,.25f+open*.9f);canvas.drawPath(valve,paint)
        paint.color=rim;paint.style=Paint.Style.STROKE;paint.strokeWidth=.025f
        canvas.drawPath(valve,paint)
        for (i in -3..3) canvas.drawLine(i*.12f,-.28f, i*.02f,.1f,paint)
        canvas.restore()
        paint.color=fill;paint.style=Paint.Style.FILL
        canvas.drawOval(-.55f,-.04f,.55f,.2f,paint)
        paint.color=rim;paint.style=Paint.Style.STROKE;paint.strokeWidth=.025f
        canvas.drawOval(-.55f,-.04f,.55f,.2f,paint)
        canvas.restore();paint.color=color;paint.style=style;paint.strokeWidth=stroke;paint.shader=shader
    }
}
