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

// Brand colors
object AgentDeckColors {
    val DeepCharcoal = Color(0xFF0F172A)
    val Surface = Color(0xFF1E293B)
    val SurfaceVariant = Color(0xFF334155)
    val Green = Color(0xFF22C55E)
    val Blue = Color(0xFF3B82F6)
    val Amber = Color(0xFFF59E0B)
    val Red = Color(0xFFEF4444)
    val Cyan = Color(0xFF06B6D4)
    val Purple = Color(0xFFA855F7)
    val SlateText = Color(0xFF94A3B8)
    val WhiteText = Color(0xFFF8FAFC)
}

private val DarkColorScheme = darkColorScheme(
    primary = AgentDeckColors.Blue,
    secondary = AgentDeckColors.Green,
    tertiary = AgentDeckColors.Amber,
    background = AgentDeckColors.DeepCharcoal,
    surface = AgentDeckColors.Surface,
    surfaceVariant = AgentDeckColors.SurfaceVariant,
    onBackground = AgentDeckColors.WhiteText,
    onSurface = AgentDeckColors.WhiteText,
    onSurfaceVariant = AgentDeckColors.SlateText,
    error = AgentDeckColors.Red,
    onPrimary = Color.White,
    onSecondary = Color.White,
    onTertiary = Color.Black,
    onError = Color.White,
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
