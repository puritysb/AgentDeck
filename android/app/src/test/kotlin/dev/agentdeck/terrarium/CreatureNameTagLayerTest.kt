package dev.agentdeck.terrarium

import android.graphics.Bitmap
import android.graphics.Paint
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import dev.agentdeck.ui.theme.DesignTokens
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode

/** The 2D habitat's tag pass (DESIGN.md §6.4), rendered for real. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CreatureNameTagLayerTest {
    private fun request(cx: Float, rank: Int, bodyTopY: Float = 200f) = CreatureNameTagRequest(
        cx = cx, tagBottomY = bodyTopY - 4f, tagWidth = 80f, tagHeight = 20f, fontSize = 12f,
        lines = listOf("Project"), lineHeight = 15f, background = DesignTokens.UI.waterMid,
        paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER },
        rank = rank, bodyTopY = bodyTopY, bodyMetric = 40f,
    )

    private fun render(requests: MutableList<CreatureNameTagRequest>): Bitmap {
        val bitmap = Bitmap.createBitmap(400, 300, Bitmap.Config.ARGB_8888)
        CanvasDrawScope().draw(Density(1f), LayoutDirection.Ltr, Canvas(bitmap.asImageBitmap()), Size(400f, 300f)) {
            CreatureNameTagLayer.flush(this, requests)
        }
        return bitmap
    }

    private fun painted(bitmap: Bitmap, left: Int, right: Int, top: Int, bottom: Int): Int {
        var n = 0
        for (x in left until right) for (y in top until bottom) if (bitmap.getPixel(x, y) ushr 24 != 0) n++
        return n
    }

    @Test fun `an idle tag colliding with a working tag is dropped, the working tag is drawn`() {
        val bitmap = render(mutableListOf(request(110f, LABEL_RANK_IDLE), request(100f, LABEL_RANK_WORKING)))
        // Only the working tag's footprint (60..140) is painted; the idle one would reach 150.
        assertTrue(painted(bitmap, 60, 140, 176, 196) > 500)
        assertEquals(0, painted(bitmap, 141, 151, 176, 196))
    }

    @Test fun `separate tags are both drawn and the queue is emptied`() {
        val requests = mutableListOf(request(80f, LABEL_RANK_IDLE), request(300f, LABEL_RANK_IDLE))
        val bitmap = render(requests)
        assertTrue(painted(bitmap, 40, 120, 176, 196) > 500)
        assertTrue(painted(bitmap, 260, 340, 176, 196) > 500)
        assertTrue(requests.isEmpty())
    }
}
