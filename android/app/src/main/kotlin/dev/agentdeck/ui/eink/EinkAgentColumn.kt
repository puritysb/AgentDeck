package dev.agentdeck.ui.eink

import android.content.res.Configuration
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import dev.agentdeck.net.UsageUpdate
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ScreenRotation
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.data.DashboardOrientation
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.AgentState
import dev.agentdeck.state.DashboardState
import dev.agentdeck.terrarium.renderer.einkColorEnabled
import dev.agentdeck.ui.component.AgentDeckLogo
import dev.agentdeck.ui.component.BrandIcon
import kotlinx.coroutines.launch

/**
 * LEFT zone (22%) — Agent panel for e-ink 3-zone layout.
 * Icon + display name (with #N suffix for duplicates) + model + state.
 *
 * Also exported as [EinkAgentColumn] for backward compatibility with portrait layout.
 */
@Composable
fun EinkAgentPanel(
    state: DashboardState,
    onSettingsClick: () -> Unit,
    onFocusSession: (String) -> Unit = {},
    showSettingsButton: Boolean = true,
    displayPrefs: DisplayPreferences? = null,
    showBrandHeader: Boolean = true,
    showFooterControls: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val isCurrentlyLandscape =
        LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val currentOrientation = displayPrefs?.orientationFlow?.collectAsState(
        initial = DashboardOrientation.defaultFor(isEink = true)
    )?.value ?: DashboardOrientation.defaultFor(isEink = true)
    // Build display list: primary + siblings (excluding self)
    data class AgentEntry(
        val projectName: String,
        val agentType: String?,
        val modelName: String?,
        val effortLevel: String?,
        val agentState: AgentState,
        val startedAt: String?,
        val sessionId: String?,
        val weight: Int? = null,
        val activity: String? = null,
    )

    fun compareEntries(left: AgentEntry, right: AgentEntry): Int {
        // Three-way comparison, never subtraction — mirrors shared sortSessions.
        val weightDiff = sessionWeight(left.weight).compareTo(sessionWeight(right.weight))
        if (weightDiff != 0) return weightDiff

        val typeDiff = agentTypeRank(left.agentType) - agentTypeRank(right.agentType)
        if (typeDiff != 0) return typeDiff

        val nameDiff = naturalLabelCompare(left.projectName, right.projectName)
        if (nameDiff != 0) return nameDiff

        val leftStarted = left.startedAt
        val rightStarted = right.startedAt
        if (leftStarted != null && rightStarted != null && leftStarted != rightStarted) {
            return leftStarted.compareTo(rightStarted)
        }
        if (leftStarted != null) return -1
        if (rightStarted != null) return 1

        return naturalLabelCompare(left.sessionId, right.sessionId)
    }

    val entries = mutableListOf<AgentEntry>()

    // Daemon-like: skip primary if daemon, or if sessions already contains
    // an entry with the same agentType (daemon relaying OpenClaw)
    // OpenClaw is a gateway proxy, never a real "primary" session — when the
    // daemon flips agentType to "openclaw" (gateway alive) the canonical OC entry
    // lives in siblingSessions. Always skip the primary in that case so a race
    // between state_update (agentType="openclaw", agentState=DISCONNECTED) and
    // sessions_list arrival cannot leave a stale "abnormal" OC card in the column.
    val isDaemonLike = state.agentType == "daemon" ||
        state.agentType == "openclaw" ||
        state.siblingSessions.any { it.agentType == state.agentType }
    if (!isDaemonLike) {
        entries += AgentEntry(
            projectName = state.projectName ?: "Agent",
            agentType = state.agentType,
            modelName = state.modelName,
            effortLevel = state.effortLevel,
            agentState = state.agentState,
            startedAt = null,
            sessionId = state.sessionId,
            activity = state.sessionId?.let { sid ->
                state.siblingSessions.firstOrNull { it.id == sid }?.activity
            },
        )
    }

    // Siblings (skip self and daemon), stable sort: agentType → numeric-aware
    // projectName → startedAt → id.
    //
    // The "skip self" filter must only fire when we actually added a primary
    // entry above (single-bridge mode). In daemon-like mode, no primary
    // entry was added — and `state.sessionId` is now the focused session id
    // (propagated from `state_update.sessionId` so visual focus tracking
    // works); using it as a filter here would silently drop the focused
    // sibling row from the list. Apple's SessionListPanel relies on the
    // same "primary id only when primary was added" invariant.
    val primarySessionId = if (!isDaemonLike) state.sessionId else null
    state.siblingSessions
        .filter { it.id != primarySessionId && it.agentType != "daemon" }
        .sortedWith(::compareSessionsForDisplay)
        .forEach { session ->
            entries += AgentEntry(
                projectName = session.projectName ?: "Agent",
                agentType = session.agentType,
                modelName = session.modelName,
                effortLevel = null,
                agentState = mapSessionState(session),
                startedAt = session.startedAt,
                sessionId = session.id,
                weight = session.weight,
                activity = session.activity,
            )
        }
    val displayEntries = entries.sortedWith(::compareEntries)

    // Count occurrences per (projectName, agentType) for #N suffix —
    // different agent types (🦞 vs 🐙) with the same project name don't need numbering
    data class NameKey(val projectName: String, val agentType: String?)
    val nameCounts = entries.groupBy { NameKey(it.projectName, it.agentType) }
        .mapValues { it.value.size }
    val nameCounters = mutableMapOf<NameKey, Int>()

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (showBrandHeader) {
            // Brand logo — centered with accent bar.
            AgentDeckLogo(isEink = true, modifier = Modifier.fillMaxWidth())
            Spacer(modifier = Modifier.height(6.dp))
        } else {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 3.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "Sessions",
                    fontSize = 12.sp,
                    lineHeight = 15.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = displayEntries.size.toString(),
                    fontSize = 12.sp,
                    lineHeight = 15.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }

        // Visual selection uses `state.focusedSessionId` directly per the
        // shared/src/protocol.ts contract — that field is the only one
        // promised to track explicit user focus. `state.sessionId` "may
        // move with hook activity" (and is a daemon connection UUID for
        // daemon-bridged clients), so it must NOT drive highlights — the
        // routing-side fallback (`focusedSessionId ?? sessionId`) belongs
        // on focus_session command paths, not the visual highlight.
        // Apple SessionListPanel.swift:194 follows the same rule.
        val focusedId = state.focusedSessionId

        displayEntries.forEach { entry ->
            val key = NameKey(entry.projectName, entry.agentType)
            val needsSuffix = (nameCounts[key] ?: 1) > 1
            val suffix = if (needsSuffix) {
                val idx = (nameCounters[key] ?: 0) + 1
                nameCounters[key] = idx
                " #$idx"
            } else {
                ""
            }
            val displayName = "${entry.projectName}$suffix"
            val sessionId = entry.sessionId
            val isFocused = focusedId != null && sessionId != null && sessionId == focusedId
            val isAwaiting = entry.agentState.isAwaitingInput()

            EinkAgentBlock(
                agentType = entry.agentType,
                displayName = displayName,
                projectName = entry.projectName,
                modelName = entry.modelName,
                effortLevel = entry.effortLevel,
                agentState = entry.agentState,
                activity = entry.activity,
                isFocused = isFocused,
                isAwaiting = isAwaiting,
                modifier = if (sessionId != null) {
                    Modifier.clickable { onFocusSession(sessionId) }
                } else {
                    Modifier
                },
            )
        }

        // Worker count
        state.workerSessionCount?.takeIf { state.gatewayConnected == true && it > 0 }?.let {
            Text(
                text = "Workers: $it",
                fontSize = 14.sp,
                lineHeight = 18.sp,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }


        Spacer(modifier = Modifier.weight(1f))

        if (showFooterControls && (showSettingsButton || displayPrefs != null)) {
            // Settings gear + rotation toggle. Rotation stays available even
            // when the optional Settings entry is hidden by display prefs.
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (showSettingsButton) {
                    Text(
                        text = "\u2699 Settings",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.clickable(onClick = onSettingsClick),
                    )
                }
                if (displayPrefs != null) {
                    Icon(
                        imageVector = Icons.Default.ScreenRotation,
                        contentDescription = "Rotate screen",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .size(18.dp)
                            .clickable {
                                scope.launch {
                                    val newOrientation = DashboardOrientation.nextManualOrientation(
                                        currentOrientation,
                                        isCurrentlyLandscape,
                                    )
                                    displayPrefs.setOrientation(newOrientation)
                                }
                            },
                    )
                }
            }
        }
    }
}

/**
 * Compact agent identity row.
 *
 * Layout (matches docs/design-mockups/eink-screens.jsx SessionRow):
 *   [icon] displayName                    [state]
 *          project + model
 *
 * Focus is rendered as inverse video — the only high-contrast hierarchy
 * break the e-ink panel can carry. Attention (awaiting input) draws a
 * 3.dp left accent bar instead. Focus and attention can co-exist; focus
 * wins because the inversion already dominates visually.
 */
@Composable
internal fun EinkAgentBlock(
    agentType: String?,
    displayName: String,
    projectName: String?,
    modelName: String?,
    effortLevel: String? = null,
    agentState: AgentState,
    activity: String? = null,
    isFocused: Boolean = false,
    isAwaiting: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val stateMarker = compactStateMarker(agentState)
    val abbrevModel = modelName?.let { abbreviateModelName(it) }
    val modelEffort = when {
        abbrevModel != null && effortLevel != null && effortLevel != "medium" && effortLevel != "default" -> "$abbrevModel \u00B7 $effortLevel"
        abbrevModel != null -> abbrevModel
        else -> null
    }
    // Subline keeps project (canonical row identity in the mockup) and
    // appends the abbreviated model when present so the row carries
    // dispatcher info without growing to a third line.
    val subLine = when {
        projectName != null && modelEffort != null -> "$projectName \u00B7 $modelEffort"
        projectName != null -> projectName
        modelEffort != null -> modelEffort
        else -> null
    }

    val paperColor = MaterialTheme.colorScheme.background
    val inkColor = MaterialTheme.colorScheme.onSurface
    val mutedColor = MaterialTheme.colorScheme.onSurfaceVariant
    val accentColor = if (einkColorEnabled) Color(0xFFBB7700) else Color.Black

    val containerModifier = modifier
        .fillMaxWidth()
        .let { base ->
            when {
                isFocused -> base.background(inkColor)
                isAwaiting -> base.drawBehind {
                    drawRect(
                        color = accentColor,
                        size = Size(3.dp.toPx(), size.height),
                    )
                }
                else -> base
            }
        }
        .padding(
            start = if (isAwaiting && !isFocused) 9.dp else 6.dp,
            end = 6.dp,
            top = 4.dp,
            bottom = 4.dp,
        )

    val nameColor = if (isFocused) paperColor else inkColor
    val subColor = if (isFocused) paperColor else mutedColor
    val stateColor = if (isFocused) paperColor else inkColor
    val iconTint = if (isFocused) paperColor else null

    Column(modifier = containerModifier) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            BrandIcon(agentType = agentType, isEink = true, tint = iconTint)
            Text(
                text = displayName,
                fontSize = 15.sp,
                lineHeight = 19.sp,
                fontWeight = FontWeight.Bold,
                color = nameColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = stateMarker,
                fontSize = 11.sp,
                lineHeight = 14.sp,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                color = stateColor,
                maxLines = 1,
            )
        }
        if (subLine != null) {
            Text(
                text = subLine,
                fontSize = 11.sp,
                lineHeight = 14.sp,
                fontFamily = FontFamily.Monospace,
                color = subColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 19.dp),
            )
        }
        // Shared activity one-liner (bridge SSOT — same summary InkDeck cards
        // and the tablet list show, so surfaces don't drift).
        if (activity != null) {
            Text(
                text = activity,
                fontSize = 11.sp,
                lineHeight = 14.sp,
                color = subColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 19.dp),
            )
        }
    }
}

private fun AgentState.isAwaitingInput(): Boolean = when (this) {
    AgentState.AWAITING_PERMISSION,
    AgentState.AWAITING_OPTION,
    AgentState.AWAITING_DIFF -> true
    else -> false
}

/**
 * Backward-compatible alias for [EinkAgentPanel].
 * Used by portrait layout and other screens that reference the old name.
 */
@Composable
fun EinkAgentColumn(
    state: DashboardState,
    onSettingsClick: () -> Unit,
    onFocusSession: (String) -> Unit = {},
    showSettingsButton: Boolean = true,
    displayPrefs: DisplayPreferences? = null,
    showBrandHeader: Boolean = true,
    showFooterControls: Boolean = true,
    modifier: Modifier = Modifier,
) {
    EinkAgentPanel(
        state = state,
        onSettingsClick = onSettingsClick,
        onFocusSession = onFocusSession,
        showSettingsButton = showSettingsButton,
        displayPrefs = displayPrefs,
        showBrandHeader = showBrandHeader,
        showFooterControls = showFooterControls,
        modifier = modifier,
    )
}
