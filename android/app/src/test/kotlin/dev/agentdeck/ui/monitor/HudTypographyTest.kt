package dev.agentdeck.ui.monitor

import androidx.compose.material3.Typography
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.createFontFamilyResolver
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HudTypographyTest {
    private fun measure(text: String, style: TextStyle, fontScale: Float): TextLayoutResult =
        TextMeasurer(
            defaultFontFamilyResolver = createFontFamilyResolver(RuntimeEnvironment.getApplication()),
            defaultDensity = Density(1f, fontScale),
            defaultLayoutDirection = LayoutDirection.Ltr,
        ).measure(AnnotatedString(text), style = style, constraints = Constraints(maxWidth = 300))

    @Test
    fun `project and metadata lines use measured natural leading at every HUD scale`() {
        val ambient = Typography().bodyLarge
        for (scale in listOf(MonitorLayoutScale.phone, MonitorLayoutScale.tablet, MonitorLayoutScale.expanded)) {
            for (fontScale in listOf(1f, 1.5f)) {
                for (text in listOf("Sample workspace\nSearch regression tests", "샘플 작업 공간\n검색 회귀 테스트")) {
                    for (fontSize in listOf(scale.fontBody, scale.fontSub)) {
                        val beforeStyle = ambient.copy(fontSize = fontSize, fontFamily = FontFamily.SansSerif)
                        val afterStyle = dashboardHudTextStyle(ambient).copy(fontSize = fontSize, fontFamily = FontFamily.SansSerif)
                        val before = measure(text, beforeStyle, fontScale)
                        val after = measure(text, afterStyle, fontScale)
                        println("HUD ${scale.sizeClass} $fontSize ×$fontScale ${if (text.startsWith("Sample")) "en" else "ko"}: height ${before.size.height} -> ${after.size.height}")
                        assertEquals(text, 2, after.lineCount)
                        assertFalse(text, after.hasVisualOverflow)
                        assertTrue("$text $fontSize ×$fontScale: inherited ${before.size.height}, natural ${after.size.height}",
                            after.size.height < before.size.height)
                        assertTrue(text, after.getLineBottom(0) > after.getLineTop(0))
                    }
                }
            }
        }
    }

    @Test
    fun `native fonts retain their roles and explicit mono kicker tracking`() {
        val ambient = Typography().bodyLarge
        val hud = dashboardHudTextStyle(ambient)
        assertEquals(ambient.fontSize, hud.fontSize)
        assertEquals(ambient.fontFamily, hud.fontFamily)
        assertEquals(ambient.fontWeight, hud.fontWeight)
        assertEquals(0.sp, hud.letterSpacing)
        val kicker = hud.copy(fontFamily = FontFamily.Monospace, letterSpacing = 1.4.sp)
        assertEquals(1.4.sp, kicker.letterSpacing)
        assertTrue(measure("UPSTREAM", kicker, 1f).size.width > 0)
    }
}
