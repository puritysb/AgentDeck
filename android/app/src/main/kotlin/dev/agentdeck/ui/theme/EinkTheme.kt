package dev.agentdeck.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** B&W e-ink color scheme (Crema S, monochrome panels). */
val EinkColorScheme = lightColorScheme(
    primary = Color.Black,
    secondary = Color.DarkGray,
    tertiary = Color.DarkGray,
    background = Color.White,
    surface = Color.White,
    surfaceVariant = Color.White,
    onBackground = Color.Black,
    onSurface = Color.Black,
    onSurfaceVariant = Color.DarkGray,
    error = Color.Black,
    onPrimary = Color.White,
    onSecondary = Color.White,
    onTertiary = Color.White,
    onError = Color.White,
    outline = Color.Black,
)

/**
 * Color e-ink scheme (Kaleido 3 / Gallery 3+).
 * Text stays pure black for 300 PPI sharpness; color accents for status only.
 * Kaleido renders color at 1/4 resolution, so colored text below 14sp is blurry.
 */
val EinkColorColorScheme = lightColorScheme(
    primary = Color(0xFF335588),       // navy blue — headers, active state
    secondary = Color(0xFF227733),     // green — connected, OK
    tertiary = Color(0xFFBB7700),      // amber — warning
    background = Color.White,
    surface = Color.White,
    surfaceVariant = Color(0xFFF5F0EB),// warm off-white
    onBackground = Color.Black,
    onSurface = Color.Black,
    onSurfaceVariant = Color.DarkGray,
    error = Color(0xFFCC2222),         // red — error, critical
    onPrimary = Color.White,
    onSecondary = Color.White,
    onTertiary = Color.Black,
    onError = Color.White,
    outline = Color(0xFF335588),
)

/** Same two roles as every surface (DESIGN.md §3): sans for people, mono for machine output. */
val EinkTypography = Typography(
    headlineLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 32.sp,
        lineHeight = 40.sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 26.sp,
        lineHeight = 32.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 20.sp,
        lineHeight = 26.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 18.sp,
        lineHeight = 28.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 18.sp,
        lineHeight = 26.sp,
    ),
    bodySmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = 18.sp,
        lineHeight = 24.sp,
    ),
)
