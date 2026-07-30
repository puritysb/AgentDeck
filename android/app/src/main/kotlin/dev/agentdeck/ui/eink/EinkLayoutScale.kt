package dev.agentdeck.ui.eink

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.agentdeck.util.DeviceProfile
import dev.agentdeck.util.ScreenSizeClass

/**
 * Fixed band heights for the e-ink dashboard, scaled by panel size.
 *
 * The e-ink tree branches on orientation but used to hard-code its chrome and
 * attention bands at one size, tuned on a ~7.8" reader. On a 6" reader those
 * bands eat a disproportionate share of a short panel, and on a 10-13" one they
 * read as a thin strip. Everything else in the layout is weight-based and
 * needs no scaling.
 *
 * The e-ink counterpart of `MonitorLayoutScale`; both bucket the same
 * `smallestScreenWidthDp` through [DeviceProfile]'s boundaries.
 */
data class EinkLayoutScale(
    val sizeClass: ScreenSizeClass,
    val chromeHeight: Dp,
    val attentionHeightLandscape: Dp,
    val attentionHeightPortrait: Dp,
) {
    companion object {
        /** 6" class readers (shortest edge under 600dp) — reclaim vertical space. */
        val compact = EinkLayoutScale(
            sizeClass = ScreenSizeClass.Compact,
            chromeHeight = 36.dp,
            attentionHeightLandscape = 92.dp,
            attentionHeightPortrait = 112.dp,
        )

        /** 7-10" class readers: the original hand-tuned values (Crema, Pantone). */
        val regular = EinkLayoutScale(
            sizeClass = ScreenSizeClass.Medium,
            chromeHeight = 44.dp,
            attentionHeightLandscape = 112.dp,
            attentionHeightPortrait = 136.dp,
        )

        /** 10-13" class readers (Boox Tab X, Max Lumi) — bands scale with the panel. */
        val expanded = EinkLayoutScale(
            sizeClass = ScreenSizeClass.Expanded,
            chromeHeight = 52.dp,
            attentionHeightLandscape = 128.dp,
            attentionHeightPortrait = 156.dp,
        )

        internal fun forSizeClass(sizeClass: ScreenSizeClass): EinkLayoutScale = when (sizeClass) {
            ScreenSizeClass.Tiny, ScreenSizeClass.Compact -> compact
            ScreenSizeClass.Medium -> regular
            ScreenSizeClass.Expanded -> expanded
        }
    }
}

/**
 * Reads the live `Configuration` rather than the startup profile so a reader
 * that reports a different size after a rotation still picks the right bands.
 */
@Composable
@ReadOnlyComposable
fun rememberEinkLayoutScale(): EinkLayoutScale {
    val shortestWidthDp = LocalConfiguration.current.smallestScreenWidthDp
    val sizeClass = when {
        shortestWidthDp < DeviceProfile.MEDIUM_MIN_WIDTH_DP -> ScreenSizeClass.Compact
        shortestWidthDp < DeviceProfile.EXPANDED_MIN_WIDTH_DP -> ScreenSizeClass.Medium
        else -> ScreenSizeClass.Expanded
    }
    return EinkLayoutScale.forSizeClass(sizeClass)
}
