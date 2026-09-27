package dev.agentdeck.terrarium

import org.junit.Assert.*
import org.junit.Test

class ResidentLabelLayoutTest {
    private fun input(id: String, rank: Int, x: Float, bodyBottom: Float = 400f) = ResidentLabelInput(
        id, rank,
        body = LabelBox(x - 40f, bodyBottom - 80f, x + 40f, bodyBottom),
        fullTag = LabelBox(x - 60f, bodyBottom - 140f, x + 60f, bodyBottom - 90f),
        compactTag = LabelBox(x - 45f, bodyBottom - 110f, x + 45f, bodyBottom - 90f),
    )

    private fun List<ResidentLabelDecision>.of(id: String) = first { it.id == id }

    @Test fun `a sparse tank keeps every tag whole and translucent`() {
        val out = resolveResidentLabels(listOf(input("a", LABEL_RANK_IDLE, 100f), input("b", LABEL_RANK_WORKING, 400f)))
        assertTrue(out.all { it.mode == ResidentLabelMode.FULL })
        assertTrue(out.all { it.backingAlpha < 1f })
        assertEquals(TerrariumRules.NATIVE_LABEL_BACKING_OPACITY, out.of("a").backingAlpha, 0f)
        assertEquals(TerrariumRules.NATIVE_LABEL_IDLE_TEXT_OPACITY, out.of("a").textAlpha, 0f)
        assertEquals(1f, out.of("b").textAlpha, 0f)
    }

    @Test fun `a dense tank collapses idle tags but never working, awaiting or focused ones`() {
        val ids = listOf(LABEL_RANK_FOCUSED, LABEL_RANK_AWAITING, LABEL_RANK_WORKING, LABEL_RANK_IDLE, LABEL_RANK_IDLE)
            .mapIndexed { i, rank -> input("r$i", rank, 150f + i * 300f) }
        val out = resolveResidentLabels(ids)
        assertEquals(ResidentLabelMode.FULL, out.of("r0").mode)
        assertEquals(ResidentLabelMode.FULL, out.of("r1").mode)
        assertEquals(ResidentLabelMode.FULL, out.of("r2").mode)
        assertEquals(ResidentLabelMode.COMPACT, out.of("r3").mode)
        assertEquals(ResidentLabelMode.COMPACT, out.of("r4").mode)
    }

    @Test fun `a tag over another resident's body yields so the body shows through`() {
        // Front idle resident's tag sits exactly over a rear working resident's body.
        val front = input("front", LABEL_RANK_IDLE, 300f, bodyBottom = 500f)
        val rear = input("rear", LABEL_RANK_WORKING, 800f).copy(body = front.fullTag)
        val out = resolveResidentLabels(listOf(front, rear))
        assertEquals(TerrariumRules.NATIVE_LABEL_YIELD_BACKING_OPACITY, out.of("front").backingAlpha, 0f)
        assertEquals(TerrariumRules.NATIVE_LABEL_YIELD_TEXT_OPACITY, out.of("front").textAlpha, 0f)
        assertEquals(TerrariumRules.NATIVE_LABEL_YIELD_SIGNAL_OPACITY, out.of("front").signalAlpha, 0f)
        assertEquals("An unobstructed tag keeps a solid signal", 1f, out.of("rear").signalAlpha, 0f)
    }

    @Test fun `an idle tag colliding with a higher-priority tag drops out and priority draws last`() {
        val working = input("working", LABEL_RANK_WORKING, 300f)
        val idle = input("idle", LABEL_RANK_IDLE, 320f, bodyBottom = 390f)
        val out = resolveResidentLabels(listOf(idle, working))
        assertEquals(ResidentLabelMode.HIDDEN, out.of("idle").mode)
        assertEquals("working", out.last().id)
    }

    @Test fun `two colliding working tags both stay, the lower one yields`() {
        val near = input("near", LABEL_RANK_WORKING, 300f, bodyBottom = 420f)
        val far = input("far", LABEL_RANK_WORKING, 320f, bodyBottom = 400f)
        val out = resolveResidentLabels(listOf(far, near))
        assertEquals(ResidentLabelMode.FULL, out.of("far").mode)
        assertEquals(TerrariumRules.NATIVE_LABEL_YIELD_BACKING_OPACITY, out.of("far").backingAlpha, 0f)
        assertEquals("near", out.last().id)
    }
}
