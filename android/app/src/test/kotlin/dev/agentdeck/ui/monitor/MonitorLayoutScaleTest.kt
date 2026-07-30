package dev.agentdeck.ui.monitor

import dev.agentdeck.ui.eink.EinkLayoutScale
import dev.agentdeck.util.ScreenSizeClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The density dispatch both dashboards share. Guards two things a rename or a
 * new size class could silently break: that `isTablet` still means "there is
 * room for fixed-width side rails", and that every [ScreenSizeClass] maps to a
 * scale rather than falling through a `when`.
 */
class MonitorLayoutScaleTest {

    @Test
    fun `size class boundaries match the device profile`() {
        assertEquals(ScreenSizeClass.Tiny, screenSizeClassFor(200))
        assertEquals(ScreenSizeClass.Compact, screenSizeClassFor(320))
        assertEquals(ScreenSizeClass.Compact, screenSizeClassFor(599))
        assertEquals(ScreenSizeClass.Medium, screenSizeClassFor(600))
        assertEquals(ScreenSizeClass.Medium, screenSizeClassFor(839))
        assertEquals(ScreenSizeClass.Expanded, screenSizeClassFor(840))
    }

    @Test
    fun `every size class resolves to a monitor scale`() {
        assertEquals(MonitorLayoutScale.phone, scaleFor(ScreenSizeClass.Tiny))
        assertEquals(MonitorLayoutScale.phone, scaleFor(ScreenSizeClass.Compact))
        assertEquals(MonitorLayoutScale.tablet, scaleFor(ScreenSizeClass.Medium))
        assertEquals(MonitorLayoutScale.expanded, scaleFor(ScreenSizeClass.Expanded))
    }

    @Test
    fun `isTablet is true exactly for the classes with room for side rails`() {
        assertFalse(scaleFor(ScreenSizeClass.Tiny).isTablet)
        assertFalse(scaleFor(ScreenSizeClass.Compact).isTablet)
        assertTrue(scaleFor(ScreenSizeClass.Medium).isTablet)
        assertTrue(scaleFor(ScreenSizeClass.Expanded).isTablet)
    }

    @Test
    fun `larger classes never render denser than smaller ones`() {
        val ordered = listOf(
            MonitorLayoutScale.phone,
            MonitorLayoutScale.tablet,
            MonitorLayoutScale.expanded,
        )
        ordered.zipWithNext { smaller, larger ->
            assertTrue(
                "font must not shrink from ${smaller.sizeClass} to ${larger.sizeClass}",
                larger.fontBody.value >= smaller.fontBody.value,
            )
            assertTrue(
                "session rail must not narrow from ${smaller.sizeClass} to ${larger.sizeClass}",
                larger.sessionPanelMaxWidth.value >= smaller.sessionPanelMaxWidth.value,
            )
        }
    }

    @Test
    fun `every size class resolves to an eink scale`() {
        assertEquals(EinkLayoutScale.compact, EinkLayoutScale.forSizeClass(ScreenSizeClass.Tiny))
        assertEquals(EinkLayoutScale.compact, EinkLayoutScale.forSizeClass(ScreenSizeClass.Compact))
        assertEquals(EinkLayoutScale.regular, EinkLayoutScale.forSizeClass(ScreenSizeClass.Medium))
        assertEquals(EinkLayoutScale.expanded, EinkLayoutScale.forSizeClass(ScreenSizeClass.Expanded))
    }

    @Test
    fun `eink bands grow with the panel and portrait is never shorter than landscape`() {
        val ordered = listOf(
            EinkLayoutScale.compact,
            EinkLayoutScale.regular,
            EinkLayoutScale.expanded,
        )
        ordered.forEach { scale ->
            assertTrue(
                "portrait attention band must not be shorter than landscape (${scale.sizeClass})",
                scale.attentionHeightPortrait.value >= scale.attentionHeightLandscape.value,
            )
        }
        ordered.zipWithNext { smaller, larger ->
            assertTrue(
                "chrome must not shrink from ${smaller.sizeClass} to ${larger.sizeClass}",
                larger.chromeHeight.value >= smaller.chromeHeight.value,
            )
        }
    }
}
