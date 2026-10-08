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

    @Test fun `CI orbit keeps identity and passive results expire while motion is paused`() {
        assertEquals(.1723f,ciCompanionSeed("hello"),.00001f)
        assertEquals(.1909f,ciCompanionSeed("ci:한글"),.00001f)
        val motion=CiCompanionMotion("ci")
        val unknown=dev.agentdeck.net.CiWaitStatus(phase="unknown",agentWaiting=true)
        val first=motion.angle
        motion.update(unknown,1f,now=10.0)
        assertTrue(motion.angle!=first)
        val last=motion.angle
        val result=unknown.copy(phase="passed",agentWaiting=false)
        motion.update(result,0f,now=11.0)
        assertEquals(last,motion.angle,0f)
        assertTrue(motion.visible(result,now=12.0))
        assertFalse(motion.visible(result,now=16.0))
        for(phase in listOf("queued","running","unknown","passed","failed"))assertFalse(ciCompanionActive(unknown.copy(phase=phase,agentWaiting=false)))
        for(phase in listOf("unknown","queued","running")) {
            val fresh=CiCompanionMotion("ci")
            fresh.update(result,0f,now=20.0)
            val inactive=unknown.copy(phase=phase,agentWaiting=false,openedAt=2)
            fresh.update(inactive,0f,now=21.0)
            assertFalse(fresh.visible(inactive,now=21.0))
        }
    }

    @Test fun `original Octocat helper remains neutral for unknown and readable at device density`() {
        fun snapshot(phase: String,time: Float,textScale: Float=1f): IntArray {
            val wait=dev.agentdeck.net.CiWaitStatus(phase=phase,agentWaiting=phase !in listOf("passed","failed"),checks=dev.agentdeck.net.CiWaitChecks(10,7,0,3))
            val bitmap=Bitmap.createBitmap(1000,700,Bitmap.Config.ARGB_8888)
            val canvas=Canvas(bitmap)
            canvas.drawColor(TerrariumColors.DeepSea.toArgb())
            val context=RuntimeEnvironment.getApplication() as android.content.Context
            val paint=android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
            val center=.5f to .5f
            val angle=if(ciCompanionActive(wait))time else TerrariumRules.CI_COMPANION_STATIC_ANGLE
            drawCiCompanion(canvas,paint,ciCompanionBitmap(context),center,ciCompanionPosition(center,angle,1000f,700f),wait,textScale)
            return IntArray(bitmap.width*bitmap.height).also { bitmap.getPixels(it,0,bitmap.width,0,0,bitmap.width,bitmap.height);bitmap.recycle() }
        }
        assertFalse(snapshot("unknown",0f).any { it==DesignTokens.UI.ok.toArgb() })
        assertFalse(snapshot("unknown",0f).contentEquals(snapshot("unknown",1f)))
        assertTrue(snapshot("passed",0f).any { it==DesignTokens.UI.ok.toArgb() })
        val regular=snapshot("passed",0f)
        val dense=snapshot("passed",0f,2f)
        assertTrue(dense.count { it==DesignTokens.UI.ok.toArgb() }>regular.count { it==DesignTokens.UI.ok.toArgb() })
    }

    private val painter get() = AquariumResidentOverlay(RuntimeEnvironment.getApplication())

    @Test fun `all six kinds render a filled working badge and keep activity when labels hide`() {
        for (kind in listOf("claudecode", "codex", "openclaw", "opencode", "antigravity", "kiro")) {
            val item = AquariumResident(kind, kind, kind, OctopusVisualState.WORKING)
            val pixels = render(item, labels = true)
            assertTrue(kind, pixels.count { it == DesignTokens.Session.working.toArgb() } > 100)
            val viewing = render(item, labels = false)
            assertTrue("Activity survives viewing mode: $kind", viewing.any { it != 0 })
            assertFalse("Badge is hidden with labels", viewing.any { it == DesignTokens.Session.working.toArgb() })
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
            assertFalse(render(stopped, labels = true).any { it == DesignTokens.Session.working.toArgb() })
        }
    }

    @Test fun `a yielding WORKING tag leaves no opaque badge over the resident behind it`() {
        val item = AquariumResident("s", "claudecode", "Project", OctopusVisualState.WORKING)
        val solid = DesignTokens.Session.working.toArgb()
        val whole = renderTag(item, ResidentLabelDecision("s", ResidentLabelMode.FULL,
            TerrariumRules.NATIVE_LABEL_BACKING_OPACITY, 1f, 1f))
        assertTrue("An unobstructed badge is solid", whole.count { it == solid } > 100)
        val yielding = renderTag(item, ResidentLabelDecision("s", ResidentLabelMode.FULL,
            TerrariumRules.NATIVE_LABEL_YIELD_BACKING_OPACITY, 1f, TerrariumRules.NATIVE_LABEL_YIELD_SIGNAL_OPACITY))
        assertEquals("A yielding badge is never opaque", 0, yielding.count { it == solid })
        assertTrue("…but still drawn", yielding.count { it ushr 24 in 1..254 } > 100)
    }

    private fun renderTag(item: AquariumResident, decision: ResidentLabelDecision): IntArray {
        val bitmap = Bitmap.createBitmap(600, 500, Bitmap.Config.ARGB_8888)
        painter.drawTag(Canvas(bitmap), item, 250f, 100f, decision)
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        bitmap.recycle()
        return pixels
    }

    private fun render(item: AquariumResident, labels: Boolean, phase: Float = 0f, selected: Boolean = false): IntArray {
        val bitmap = Bitmap.createBitmap(600, 500, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val overlay = painter
        overlay.drawCues(canvas, item, 250f, 300f, 100f, phase, selected)
        if (labels) overlay.drawTag(canvas, item, 250f, 100f, ResidentLabelDecision(item.id, ResidentLabelMode.FULL, 1f, 1f))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        bitmap.recycle()
        return pixels
    }
}
