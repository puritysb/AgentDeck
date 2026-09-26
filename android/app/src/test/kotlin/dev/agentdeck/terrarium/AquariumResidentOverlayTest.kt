package dev.agentdeck.terrarium

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.graphics.toArgb
import dev.agentdeck.ui.theme.DesignTokens
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AquariumResidentOverlayTest {
    private val painter get() = AquariumResidentOverlay(RuntimeEnvironment.getApplication())

    @Test fun `all six kinds render a filled working badge and keep activity when labels hide`() {
        for (kind in listOf("claudecode", "codex", "openclaw", "opencode", "antigravity", "kiro")) {
            val item = AquariumResident(kind, kind, kind, OctopusVisualState.WORKING)
            val pixels = render(item, labels = true)
            assertTrue(kind, pixels.count { it == DesignTokens.Status.processing.toArgb() } > 100)
            val viewing = render(item, labels = false)
            assertTrue("Activity survives viewing mode: $kind", viewing.any { it != 0 })
            assertFalse("Badge is hidden with labels", viewing.any { it == DesignTokens.Status.processing.toArgb() })
            assertFalse("Bars move with phase", viewing.contentEquals(render(item, labels = false, phase = 1f)))
            assertArrayEquals("Frozen phase is stable", viewing, render(item, labels = false))
        }
    }

    @Test fun `state changes clear work cue immediately even with frozen phase and selection`() {
        val item = AquariumResident("session", "claudecode", "Project", OctopusVisualState.WORKING)
        for (state in listOf(OctopusVisualState.FLOATING, OctopusVisualState.ASKING, OctopusVisualState.SLEEPING)) {
            val stopped = item.copy(state = state)
            assertTrue(render(stopped, labels = false).all { it == 0 })
            assertTrue("Selection remains independent", render(stopped, labels = false, selected = true).any { it != 0 })
            assertFalse(render(stopped, labels = true).any { it == DesignTokens.Status.processing.toArgb() })
        }
    }

    private fun render(item: AquariumResident, labels: Boolean, phase: Float = 0f, selected: Boolean = false): IntArray {
        val bitmap = Bitmap.createBitmap(600, 500, Bitmap.Config.ARGB_8888)
        painter.draw(Canvas(bitmap), item, 250f, 100f, 250f, 300f, 100f, phase, selected, labels)
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        bitmap.recycle()
        return pixels
    }
}
