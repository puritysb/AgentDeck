package dev.agentdeck.ui.eink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The LIMITS corner card is a fixed-width overlay drawing one monospace row per
 * limit, so a row that overruns the card is clipped — silently, and from the
 * tail, which is where the number is. The row that overruns first is the one
 * that matters most: a per-model cap at 100% has both the longest label and the
 * widest percentage, and its severity is `critical`.
 *
 * These pin the property that prevents it: every row is the same width.
 */
class EinkLimitRowTextTest {

    private fun width(s: String) = s.length

    @Test
    fun `no row overruns the card, whatever the label and percentage`() {
        // The invariant is the budget, not a fixed gauge: a row may come in
        // under it, but never over — over is what gets clipped.
        val rows = listOf(
            einkLimitRowText("5h", 84),
            einkLimitRowText("7d", 85),
            einkLimitRowText("Fable", 100),
            einkLimitRowText("30d", 0),
            einkLimitRowText("5h", 84, stale = true),
            einkLimitRowText("Fable", 100, stale = true),
            einkLimitRowText("Sonnet", 7),
        )
        rows.forEach {
            assertTrue("row overruns the card (${width(it)} cols): '$it'", width(it) <= EINK_LIMIT_ROW_COLUMNS)
        }
    }

    @Test
    fun `the common two-character row keeps the full eight-cell gauge`() {
        // The fix must not quietly redraw the rows that were already correct.
        assertEquals("5h ██████░░ 84%", einkLimitRowText("5h", 84))
    }

    @Test
    fun `a maxed scoped cap keeps its digits and pays for them in gauge cells`() {
        val row = einkLimitRowText("Fable", 100)
        assertTrue("the percentage must survive: '$row'", row.endsWith(" 100%"))
        assertTrue("the label must survive: '$row'", row.startsWith("Fable "))
    }

    @Test
    fun `the percentage is never truncated, even by an over-long label`() {
        val row = einkLimitRowText("VeryLongName", 100, stale = true)
        assertTrue("percentage lost to the label: '$row'", row.endsWith(" 100%!"))
        assertEquals(EINK_LIMIT_ROW_COLUMNS, width(row))
    }

    @Test
    fun `the gauge still reads as a proportion`() {
        // Empty at 0, full at 100 — the cell COUNT may differ between the two
        // (100% spends cells on its third digit), the proportion may not.
        assertTrue(einkLimitRowText("5h", 0).let { !it.contains("█") && it.contains("░") })
        assertTrue(einkLimitRowText("5h", 100).let { it.contains("█") && !it.contains("░") })
        // Out-of-range input is clamped rather than drawn past the cells.
        assertTrue(width(einkLimitRowText("5h", 250)) <= EINK_LIMIT_ROW_COLUMNS)
        assertTrue(width(einkLimitRowText("5h", -10)) <= EINK_LIMIT_ROW_COLUMNS)
    }
}
