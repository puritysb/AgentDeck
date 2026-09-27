package dev.agentdeck.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import dev.agentdeck.util.DeviceProfile
import dev.agentdeck.util.DeviceProfileHolder
import dev.agentdeck.util.PanelKind

/**
 * Legacy colour names, now bindings to the design tokens (DESIGN.md §2.6).
 * New code reaches for [DesignTokens] directly; these names stay so existing
 * call sites keep compiling while they migrate.
 */
object AgentDeckColors {
    val DeepCharcoal = DesignTokens.UI.popupBgDark
    val Surface = DesignTokens.Ink.s800
    val SurfaceVariant = DesignTokens.Ink.s700
    val Green = DesignTokens.UI.ok
    /** Product accent (link, primary action, activity) — the cyan chrome, not a blue. */
    val Blue = DesignTokens.UI.cyan
    val Amber = DesignTokens.UI.attn
    val Red = DesignTokens.UI.error
    val Cyan = DesignTokens.UI.cyan
    /** Timeline "memory" accent — a category hue, not a state; no token yet. */
    val Purple = Color(0xFFA855F7)
    val SlateText = DesignTokens.UI.hudSubtext
    val WhiteText = DesignTokens.UI.hudText
}

private val DarkColorScheme = darkColorScheme(
    primary = DesignTokens.UI.cyan,
    secondary = DesignTokens.UI.ok,
    tertiary = DesignTokens.UI.attn,
    background = DesignTokens.UI.popupBgDark,
    surface = DesignTokens.Ink.s800,
    surfaceVariant = DesignTokens.Ink.s700,
    onBackground = DesignTokens.UI.hudText,
    onSurface = DesignTokens.UI.hudText,
    onSurfaceVariant = DesignTokens.UI.hudSubtext,
    error = DesignTokens.UI.error,
    onPrimary = DesignTokens.Ink.s900,
    onSecondary = DesignTokens.Ink.s900,
    onTertiary = DesignTokens.Ink.s900,
    onError = DesignTokens.Ink.s900,
)

private val AppTypography = Typography(
    headlineLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 28.sp,
        lineHeight = 36.sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 18.sp,
        lineHeight = 24.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    bodySmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
)

val LocalIsEink = staticCompositionLocalOf { false }

/** The resolved device class, so any composable can branch without re-deriving one. */
val LocalDeviceProfile = staticCompositionLocalOf { DeviceProfileHolder.current }

/**
 * Installs the colour scheme and typography for [profile]'s panel.
 *
 * The panel comes in as data rather than being probed here, so the user's panel
 * override reaches the theme and `@Preview`s can render either variant.
 */
@Composable
fun AgentDeckTheme(
    profile: DeviceProfile = DeviceProfileHolder.current,
    content: @Composable () -> Unit,
) {
    val colorScheme = when (profile.panel) {
        PanelKind.EinkColor -> EinkColorColorScheme
        PanelKind.EinkMono -> EinkColorScheme
        PanelKind.Lcd -> DarkColorScheme
    }
    val typography = if (profile.isEink) EinkTypography else AppTypography

    CompositionLocalProvider(
        LocalIsEink provides profile.isEink,
        LocalDeviceProfile provides profile,
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = typography,
            content = content,
        )
    }
}
