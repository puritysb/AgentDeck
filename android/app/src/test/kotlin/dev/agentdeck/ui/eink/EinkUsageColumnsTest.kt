package dev.agentdeck.ui.eink

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** #415: the usage table must fit its zone, so the used and time-left figures never run together. */
class EinkUsageColumnsTest {

    // Crema S portrait, measured from the 1.6.1 Play capture: a ~239 dp zone,
    // `100%!` about 48 dp and `23h 59m` about 59 dp in their monospace styles.
    private val pct = 48.dp
    private val time = 59.dp + UsageColumnGap

    @Test
    fun `a Crema-width zone keeps every column inside it`() {
        val cols = usageColumns(239.dp, pct, time)
        assertTrue("table ${cols.total} exceeds 239.dp", cols.total <= 239.dp)
        assertEquals(pct, cols.pct)
        assertEquals(time, cols.time)
        assertTrue("bar ${cols.bar} vanished", cols.bar > 0.dp)
    }

    @Test
    fun `a wide zone caps the bar instead of stretching it across the page`() {
        val cols = usageColumns(600.dp, pct, time)
        assertEquals(150.dp, cols.bar)
        assertEquals(50.dp, cols.label)
    }

    @Test
    fun `a narrow zone shrinks the label before dropping the bar, never the figures`() {
        val cols = usageColumns(200.dp, pct, time)
        assertTrue(cols.label < 50.dp)
        assertEquals(pct, cols.pct)
        assertEquals(time, cols.time)
        assertTrue(cols.total <= 200.dp)
    }
}
