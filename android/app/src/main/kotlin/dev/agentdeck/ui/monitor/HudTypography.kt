package dev.agentdeck.ui.monitor

import androidx.compose.material3.LocalTextStyle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp

/** DESIGN §3.3–3.4: native HUD text uses its font's natural leading and
 * normal body tracking. Keep caller font sizes, families and weights; explicit
 * mono kicker tracking still overrides this ambient body style. */
internal fun dashboardHudTextStyle(ambient: TextStyle): TextStyle =
    ambient.copy(lineHeight = TextUnit.Unspecified, letterSpacing = 0.sp)

@Composable
internal fun DashboardHudTypography(content: @Composable () -> Unit) {
    // ProvideTextStyle merges unspecified fields, which would retain the
    // enclosing Material bodyLarge's 24sp leading. Replace the local directly.
    CompositionLocalProvider(
        LocalTextStyle provides dashboardHudTextStyle(LocalTextStyle.current),
        content = content,
    )
}
