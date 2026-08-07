package dev.agentdeck.ui.monitor

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.util.DeviceProfile
import dev.agentdeck.util.ScreenSizeClass

/**
 * Timeline layout dispatch:
 *   - Compact: phone-class device in portrait. Single-column with
 *     tap-to-expand inline detail. No right-side detail pane (the 35% pane
 *     would be ~120dp on a 340dp phone screen — too narrow to be useful).
 *   - Regular: tablet (any orientation), phone landscape, or anything else.
 *     The 65/35 HStack with right-side detail pane stays.
 *
 * Mirrors `TimelineLayoutMode` in
 * apple/AgentDeck/UI/Monitor/TimelineStripView.swift.
 */
enum class TimelineLayoutMode { Compact, Regular }

@Composable
@ReadOnlyComposable
fun rememberTimelineLayoutMode(): TimelineLayoutMode {
    val config = LocalConfiguration.current
    val sizeClass = screenSizeClassFor(config.smallestScreenWidthDp)
    val isNarrow = sizeClass == ScreenSizeClass.Compact || sizeClass == ScreenSizeClass.Tiny
    val isPortrait = config.orientation == Configuration.ORIENTATION_PORTRAIT
    return if (isNarrow && isPortrait) TimelineLayoutMode.Compact else TimelineLayoutMode.Regular
}

/**
 * Density + typography scale the Monitor HUD uses to adapt between phone
 * and tablet form-factors. Tablet values intentionally stay close to the
 * macOS HUD density: this is an operational dashboard, not a card-heavy
 * tablet landing page.
 *
 * Keep this the single source: every panel reads from the same
 * `MonitorLayoutScale` instance so density stays consistent across the
 * left/right rails.
 */
data class MonitorLayoutScale(
    val sizeClass: ScreenSizeClass,
    val sessionPanelMaxWidth: Dp,
    val topologyPanelMaxWidth: Dp,
    /** Share of the parent width each side rail may take. The two rails are
     *  independently anchored (TopStart / TopEnd) inside one Box, so nothing
     *  stops them from meeting in the middle — only these fractions do. They
     *  must therefore sum to less than 1, with room left for the gap. */
    val sessionPanelWidthFraction: Float,
    val topologyPanelWidthFraction: Float,
    val panelPadding: Dp,
    val panelEdgeInset: Dp,
    val sessionRowSpacing: Dp,
    val topologyRowSpacing: Dp,
    val topologySectionSpacing: Dp,
    val providerRowSpacing: Dp,
    val fontBody: TextUnit,
    val fontSub: TextUnit,
    val fontHeader: TextUnit,
) {
    /**
     * Retained as the coarse "is there room for fixed-width side rails"
     * predicate the panels already branch on. Anything wider than a phone
     * qualifies, so large tablets keep the rails they had before the
     * [ScreenSizeClass.Expanded] step existed.
     */
    val isTablet: Boolean
        get() = sizeClass == ScreenSizeClass.Medium || sizeClass == ScreenSizeClass.Expanded

    companion object {
        /** Phone density — fonts shrunk by one step from the tablet baseline
         *  because phone HUD areas (~340 dp wide) are too cramped at the
         *  tablet defaults. Sub goes 10→9 sp, body 12→11 sp, header 11→10 sp. */
        val phone = MonitorLayoutScale(
            sizeClass = ScreenSizeClass.Compact,
            sessionPanelMaxWidth = 220.dp,
            topologyPanelMaxWidth = 300.dp,
            sessionPanelWidthFraction = 0.42f,
            topologyPanelWidthFraction = 0.46f,
            panelPadding = 8.dp,
            panelEdgeInset = 12.dp,
            sessionRowSpacing = 4.dp,
            topologyRowSpacing = 2.dp,
            topologySectionSpacing = 5.dp,
            providerRowSpacing = 5.dp,
            fontBody = 11.sp,
            fontSub = 9.sp,
            fontHeader = 10.sp,
        )

        /** Tablet density — macOS HUD proportions, not enlarged tablet cards.
         *  Session panel runs wider than the macOS 220dp cap: long worktree
         *  project names dominate the list on tablets and 220dp wrapped nearly
         *  every row (user request 2026-07-06). */
        val tablet = MonitorLayoutScale(
            sizeClass = ScreenSizeClass.Medium,
            sessionPanelMaxWidth = 300.dp,
            topologyPanelMaxWidth = 300.dp,
            sessionPanelWidthFraction = 0.22f,
            topologyPanelWidthFraction = 0.32f,
            panelPadding = 8.dp,
            panelEdgeInset = 12.dp,
            sessionRowSpacing = 4.dp,
            topologyRowSpacing = 0.dp,
            topologySectionSpacing = 6.dp,
            providerRowSpacing = 5.dp,
            fontBody = 12.sp,
            fontSub = 10.sp,
            fontHeader = 11.sp,
        )

        /** Large-tablet / desktop-mode density (shortest edge ≥840dp).
         *  The rails were sized for a 7-9" panel and left the 11-13" class
         *  reading as a scaled-up phone: measurably more room, identical
         *  density. One step up in font and rail width, no layout change —
         *  the terrarium keeps the space it gains. */
        val expanded = MonitorLayoutScale(
            sizeClass = ScreenSizeClass.Expanded,
            sessionPanelMaxWidth = 340.dp,
            topologyPanelMaxWidth = 340.dp,
            sessionPanelWidthFraction = 0.22f,
            topologyPanelWidthFraction = 0.32f,
            panelPadding = 10.dp,
            panelEdgeInset = 16.dp,
            sessionRowSpacing = 5.dp,
            topologyRowSpacing = 1.dp,
            topologySectionSpacing = 7.dp,
            providerRowSpacing = 6.dp,
            fontBody = 13.sp,
            fontSub = 11.sp,
            fontHeader = 12.sp,
        )
    }
}

/**
 * Bucket a shortest-edge width. Delegates to [DeviceProfile]'s boundaries so
 * the layout scale and the device profile can never disagree about what counts
 * as a tablet.
 */
internal fun screenSizeClassFor(shortestWidthDp: Int): ScreenSizeClass = when {
    shortestWidthDp < DeviceProfile.MIN_SUPPORTED_WIDTH_DP -> ScreenSizeClass.Tiny
    shortestWidthDp < DeviceProfile.MEDIUM_MIN_WIDTH_DP -> ScreenSizeClass.Compact
    shortestWidthDp < DeviceProfile.EXPANDED_MIN_WIDTH_DP -> ScreenSizeClass.Medium
    else -> ScreenSizeClass.Expanded
}

/**
 * Picks the right scale for the current window. Uses `smallestScreenWidthDp`
 * (sw-qualifier equivalent) so foldables in folded state and phones in
 * landscape both count as "phone".
 *
 * Reads the live `Configuration` rather than the startup `DeviceProfile`: on a
 * foldable the size class changes at runtime while the device class does not.
 */
@Composable
@ReadOnlyComposable
fun rememberMonitorLayoutScale(): MonitorLayoutScale {
    val config = LocalConfiguration.current
    return scaleFor(screenSizeClassFor(config.smallestScreenWidthDp))
}

internal fun scaleFor(sizeClass: ScreenSizeClass): MonitorLayoutScale = when (sizeClass) {
    // Tiny only reaches here when the user overrode the unsupported-device
    // guidance; the phone rails are the densest thing available.
    ScreenSizeClass.Tiny, ScreenSizeClass.Compact -> MonitorLayoutScale.phone
    ScreenSizeClass.Medium -> MonitorLayoutScale.tablet
    ScreenSizeClass.Expanded -> MonitorLayoutScale.expanded
}
