package dev.agentdeck.ui.screen

import dev.agentdeck.ui.eink.EinkPaperBoard

import android.content.res.Configuration
import dev.agentdeck.ui.common.ConnectionLexicon
import dev.agentdeck.ui.common.ConnectionSetupGuide
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ScreenRotation
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeAutoConnect
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.net.PairingCredential
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.TimelineStore
import dev.agentdeck.state.TimelineSessionFilter
import dev.agentdeck.ui.component.AgentDeckMark
import dev.agentdeck.ui.monitor.subscriptionTrailing
import dev.agentdeck.util.ChatGPTPlan
import dev.agentdeck.util.formatResetTime
import dev.agentdeck.util.providerLimitRows
import java.time.Instant
import dev.agentdeck.ui.eink.EinkAttentionPanel
import dev.agentdeck.ui.eink.EinkAquariumFrame
import dev.agentdeck.ui.eink.EinkSettingsOverlay
import dev.agentdeck.ui.eink.rememberEinkLayoutScale
import dev.agentdeck.ui.eink.buildEinkAttentionFeatured
import dev.agentdeck.terrarium.toTerrariumState
import dev.agentdeck.ui.eink.EinkAnimatedRefreshZone
import dev.agentdeck.ui.eink.EinkRefreshZone
import dev.agentdeck.state.matchesTimelineFilter
import dev.agentdeck.ui.eink.Zone
import dev.agentdeck.data.DashboardOrientation
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch

private val EinkInspectionSaver = listSaver<TimelineSessionFilter?, String>(
    save = { filter ->
        filter?.let {
            listOf(it.sessionId, it.projectName.orEmpty(), it.agentType.orEmpty()) + it.memberSessionIds
        } ?: emptyList()
    },
    restore = { values ->
        values.takeIf { it.size >= 3 }?.let {
            TimelineSessionFilter(
                sessionId = it[0],
                projectName = it[1].takeIf(String::isNotEmpty),
                agentType = it[2].takeIf(String::isNotEmpty),
                memberSessionIds = it.drop(3),
            )
        }
    },
)

@Composable
fun EinkMonitorScreen(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
) {
    val state by stateHolder.state.collectAsState()
    val connectionStatus by connection.status.collectAsState()
    val allTimelineEntries by TimelineStore.instance.entries.collectAsState()
    var inspection by rememberSaveable(stateSaver = EinkInspectionSaver) {
        mutableStateOf<TimelineSessionFilter?>(null)
    }
    val inspectSession: (String) -> Unit = { id ->
        inspection = if (inspection?.sessionId == id) null else dev.agentdeck.state.timelineInspectionFilter(id, state)
    }
    val timelineEntries = remember(allTimelineEntries, inspection) {
        inspection?.let { filter -> allTimelineEntries.filter { it.matchesTimelineFilter(filter) } } ?: allTimelineEntries
    }
    var showSettings by remember { mutableStateOf(false) }
    var frameMode by rememberSaveable { mutableStateOf(false) }

    val configuration = LocalConfiguration.current
    val snapshotTime = java.text.SimpleDateFormat("HH:mm", java.util.Locale.US).format(java.util.Date())
    val isLandscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    val einkScale = rememberEinkLayoutScale()
    val currentUrl by connection.url.collectAsState()

    // mDNS discovery list, for the manual-connect UI below. Filled by the
    // shared ladder, which is also the only thing that dials.
    var discoveredBridges by remember { mutableStateOf<List<DiscoveredBridge>>(emptyList()) }

    // The connection ladder — loopback (USB) → saved URL → mDNS — shared with
    // MainActivity.TabletDashboard. This screen used to carry its own copy,
    // which is how it kept the version that preempted the USB attempt the
    // moment mDNS resolved anything and redialled a refused endpoint on every
    // emission. E-ink readers are the devices that copy served, and the ones
    // least able to recover: no camera for a pairing QR, and over `adb reverse`
    // no pairing needed at all.
    BridgeAutoConnect(
        connection = connection,
        displayPrefs = displayPrefs,
        onDiscoveredBridges = { discoveredBridges = it },
    )

    // mDNS-discovered bridges are also shown in the UI for manual selection
    // in the not-connected screen or use Settings for manual URL entry.

    val rawLastError by connection.lastError.collectAsState()
    val unauthorizedEndpoints by connection.unauthorizedEndpoints.collectAsState()
    // A refusal outranks the last attempt's error: the recovery ladder keeps
    // probing the USB path, and "USB bridge not found" kept overwriting the one
    // message this device's user can act on.
    val lastError = PairingCredential.disconnectedDetail(rawLastError, unauthorizedEndpoints.keys, currentUrl, connection.selectedUrl)
    val isReconnecting by connection.isReconnecting.collectAsState()
    val reconnectAttempt by connection.reconnectAttempt.collectAsState()
    val showSessionList by displayPrefs.showSessionListFlow.collectAsState(initial = true)
    val showTimeline by displayPrefs.showTimelineFlow.collectAsState(initial = true)
    val storedSettingsButton by displayPrefs.showSettingsButtonFlow.collectAsState(initial = true)
    val dashboardType by displayPrefs.dashboardTypeFlow.collectAsState(initial = dev.agentdeck.data.DashboardType.Default)
    val showSettingsButton = storedSettingsButton || dashboardType == dev.agentdeck.data.DashboardType.Paper
    val displaySyncEnabled by displayPrefs.displaySyncEnabledFlow.collectAsState(initial = true)
    val featuredAttention = remember(state) { buildEinkAttentionFeatured(state) }
    val sleepSnapshotMode = displaySyncEnabled && !state.hostDisplayOn && state.hostDim?.enabled != false

    // Show not-connected screen only when truly disconnected (not reconnecting)
    val showNotConnected = connectionStatus != ConnectionStatus.CONNECTED &&
        state.agentState == AgentState.DISCONNECTED &&
        !isReconnecting

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        if (showNotConnected) {
            EinkNotConnectedScreen(
                connectionStatus = connectionStatus,
                discoveredBridges = discoveredBridges,
                lastError = lastError,
                retryUrl = currentUrl ?: connection.selectedUrl,
                onRetry = { (connection.url.value ?: connection.selectedUrl)?.let { connection.connect(it) } },
                onConnectToBridge = { bridge ->
                    connection.connect(bridge.wsUrl(), bridge.fallbackWsUrl())
                },
                onConnectLocalhost = {
                    connection.connect(BridgeConstants.LOCALHOST_WS_URL)
                },
                onSettingsClick = { showSettings = true },
                showSettingsButton = showSettingsButton,
            )
        } else if (isReconnecting && state.agentState == AgentState.DISCONNECTED) {
            EinkReconnectingScreen(
                url = currentUrl,
                attempt = reconnectAttempt,
                lastError = lastError,
                discoveredBridges = discoveredBridges,
                onConnectToBridge = { bridge ->
                    connection.connect(bridge.wsUrl(), bridge.fallbackWsUrl())
                },
                onStopReconnecting = { connection.disconnect() },
                onSettingsClick = { showSettings = true },
                showSettingsButton = showSettingsButton,
            )
        } else {
            // Keep one composition across rotation: board mode, reading position,
            // and local session inspection survive the responsive layout change.
            // Use state as key so toTerrariumState() recomputes when siblingSessions etc. change.
            // derivedStateOf + remember would capture the initial state parameter (plain value,
            // not a Compose State) and never re-evaluate — causing stale creature counts.
            val terrariumState = remember(state) { state.toTerrariumState() }
            val terrariumRefreshKey = remember(state, terrariumState) {
                buildEinkTerrariumRefreshKey(state, terrariumState)
            }

            Column(modifier = Modifier.fillMaxSize()) {
                EinkRefreshZone(
                    mode = Zone.CHROME.mode,
                    debounceMs = Zone.CHROME.debounceMs,
                    triggerKey = listOf(state.dot, snapshotTime, frameMode, configuration.orientation, configuration.fontScale),
                    sleepSnapshotMode = sleepSnapshotMode,
                    wrapContentHeight = true,
                    modifier = Modifier.heightIn(min = einkScale.chromeHeight).fillMaxWidth(),
                ) {
                    EinkDashboardChromeBar(
                        state = state,
                        snapshotTime = snapshotTime,
                        displayPrefs = displayPrefs,
                        showSettingsButton = showSettingsButton,
                        onSettingsClick = { showSettings = true },
                        frameMode = frameMode,
                        onToggleFrame = {
                            inspection = null
                            frameMode = !frameMode
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                if (featuredAttention != null) {
                    HorizontalDivider(thickness = 1.dp, color = Color.Black)
                    val attentionIdentity = listOf(
                        featuredAttention.sessionId,
                        featuredAttention.question,
                        featuredAttention.promptType,
                        featuredAttention.options.map { it.label },
                    )
                    EinkRefreshZone(
                        mode = Zone.ATTENTION.mode,
                        debounceMs = Zone.ATTENTION.debounceMs,
                        triggerKey = attentionIdentity,
                        softTriggerKey = featuredAttention.cursorIndex,
                        modifier = Modifier
                            .height(
                                (if (isLandscape) einkScale.attentionHeightLandscape else einkScale.attentionHeightPortrait) *
                                    configuration.fontScale.coerceAtLeast(1f),
                            )
                            .fillMaxWidth(),
                    ) {
                        EinkAttentionPanel(
                            featured = featuredAttention,
                            onFocusSession = { connection.sendFocusSession(it) },
                            onSelectOption = { index ->
                                connection.sendSelectOption(
                                    index, featuredAttention.sessionId, featuredAttention.question,
                                )
                            },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }

                HorizontalDivider(thickness = 2.dp, color = Color.Black)
                EinkPaperBoard(
                    state = state,
                    timelineEntries = if (showTimeline || inspection != null) timelineEntries else emptyList(),
                    landscape = isLandscape,
                    onFocusSession = inspectSession,
                    inspectionLabel = inspection?.label,
                    inspectionSessionId = inspection?.sessionId,
                    onClearInspection = { inspection = null },
                    usage = buildEinkUsageGroups(state),
                    sleepSnapshotMode = sleepSnapshotMode,
                    showSessionList = showSessionList,
                    frameMode = frameMode,
                    onExitFrame = { frameMode = false },
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                ) { tankModifier ->
                    EinkAnimatedRefreshZone(
                        stateKey = terrariumRefreshKey,
                        sleepSnapshotMode = sleepSnapshotMode,
                        modifier = tankModifier,
                    ) { onFrameRendered ->
                        EinkAquariumFrame(
                            state = terrariumState,
                            snapshotMode = sleepSnapshotMode,
                            onFrameRendered = onFrameRendered,
                        )
                    }
                }
            }
        }

        if (showSettings) {
            EinkSettingsOverlay(
                connection = connection,
                displayPrefs = displayPrefs,
                dashState = state,
                discoveredBridges = discoveredBridges,
                onDismiss = { showSettings = false },
            )
        }
    }
}

internal fun buildEinkTerrariumRefreshKey(
    state: DashboardState,
    terrariumState: dev.agentdeck.terrarium.TerrariumState,
): List<Any?> {
    val sessionProjection = state.siblingSessions.map {
        "${it.id}:${it.agentType}:${it.state}:${it.projectName}:${it.waitingOn}"
    }
    return listOf(
        state.sessionId,
        state.agentType,
        state.agentState,
        state.projectName,
        sessionProjection,
        state.usage.fiveHourPercent,
        state.usage.sevenDayPercent,
        state.usage.usageStale,
        state.usage.scopedLimits,
        state.codexRateLimits,
        state.zaiRateLimits,
        state.subscriptions,
        state.antigravityStatus?.planName,
        state.antigravityStatus?.availableCredits,
        state.antigravityStatus?.minimumCreditAmountForUsage,
        terrariumState.ciWaits,
        terrariumState.ciWaitingIds,
        terrariumState.agents.map { "${it.sessionId}:${it.agentType}:${it.visualState}" },
        terrariumState.cloudCreatures.map { "${it.sessionId}:${it.agentType}:${it.visualState}" },
        terrariumState.openCodeCreatures.map { "${it.sessionId}:${it.agentType}:${it.visualState}" },
        terrariumState.antigravityCreatures.map { "${it.sessionId}:${it.agentType}:${it.visualState}" },
    )
}

internal data class EinkLimitLine(
    val label: String,
    val percent: Double? = null,
    val value: String? = null,
    val agentType: String? = null,
    val stale: Boolean = false,
    /** Time left until the window resets ("2h 15m"), or a freshness note when stale. */
    val reset: String? = null,
    /** [percent] is what REMAINS (the Codex Luna reserve): the bar fills by it,
     *  but severity reads the consumed complement. */
    val remaining: Boolean = false,
)

internal fun buildEinkLimitRows(state: DashboardState, now: Instant = Instant.now()): List<EinkLimitLine> {
    val rows = mutableListOf<EinkLimitLine>()
    if (state.usage.usageStale != true) {
        state.usage.fiveHourPercent?.let {
            rows.add(EinkLimitLine(label = "5h", percent = it, agentType = "claude-code",
                reset = state.usage.fiveHourResetsAt?.let(::formatResetTime)))
        }
        state.usage.sevenDayPercent?.let {
            rows.add(EinkLimitLine(label = "7d", percent = it, agentType = "claude-code",
                reset = state.usage.sevenDayResetsAt?.let(::formatResetTime)))
        }
        // Per-model scoped weekly caps (e.g. "Fable") beneath the account-wide windows.
        state.usage.scopedLimits?.forEach { s ->
            rows.add(EinkLimitLine(label = s.label.trim(), percent = s.percent, agentType = "claude-code",
                reset = s.resetsAt?.let(::formatResetTime)))
        }
    }
    // Codex (ChatGPT) rolling windows — independent of Claude's usageStale, each
    // carries its own stale flag. We keep BOTH primary (5h) and secondary (7d)
    // even when a window has elapsed: dropping stale ones made the 7d window
    // vanish entirely once Codex went idle (its window slides into the past). A
    // stale window keeps its last-known percent and is flagged with a trailing
    // "!" instead of disappearing. The leading brand mark identifies the provider,
    // so labels stay plain 5h/7d.
    providerLimitRows(state.codexRateLimits, state.zaiRateLimits).forEach {
        // The provider line above the windows names GLM; the row names only
        // the window, and the MCP quota by its quantity.
        val label = if (it.label.equals("mcp", ignoreCase = true)) "MCP" else it.label
        // A credit balance rides `value` with no percent: it has no cap to fill.
        rows.add(EinkLimitLine(label = label, percent = if (it.value != null) null else it.percent, value = it.value,
            agentType = it.agentType, stale = it.stale, reset = it.footnote ?: it.resetIso?.let(::formatResetTime),
            remaining = it.remaining))
    }
    return rows
}

/**
 * One provider on the e-ink usage zone: its name, its plan when the daemon
 * knows one ("Plus · until Oct 10"), and its usage windows. A provider with a
 * plan but no metered windows (Antigravity) is a group with no rows; a
 * provider with neither is absent, so one subscription shows one group and
 * none shows no zone at all.
 */
internal data class EinkUsageGroup(
    val agentType: String,
    val provider: String,
    val plan: String?,
    val windows: List<EinkLimitLine>,
)

private val USAGE_PROVIDER_ORDER = listOf("claude-code", "codex", "zai", "antigravity")

internal fun buildEinkUsageGroups(state: DashboardState, now: Instant = Instant.now()): List<EinkUsageGroup> {
    val windows = buildEinkLimitRows(state, now).groupBy { it.agentType }
    val plans = mutableMapOf<String, String?>()
    fun untilText(until: String?): String? {
        val trailing = subscriptionTrailing(until, now) ?: return null
        return if (trailing.expired) "renew" else formatEinkExpiry(until)?.let { "until ${it.removePrefix("→ ")}" }
    }
    fun planLine(tier: String?, until: String?): String? =
        listOfNotNull(tier?.takeIf { it.isNotBlank() }, untilText(until)).joinToString(" · ").ifEmpty { null }
    state.subscriptions.forEach { sub ->
        when {
            sub.name.startsWith("ChatGPT", ignoreCase = true) ->
                plans["codex"] = planLine(sub.name.removePrefix("ChatGPT").trim(), sub.until)
            sub.name.startsWith("GLM Coding Plan", ignoreCase = true) ->
                plans["zai"] = planLine(sub.name.substringAfter(" · ", "").ifEmpty { null }, sub.until)
            sub.name.equals("Claude", ignoreCase = true) ->
                plans["claude-code"] = planLine(null, sub.until)
        }
    }
    // The Swift (App Store) daemon sends no ChatGPT subscription row, only the
    // plan fields on the usage event; both daemons send those, so the Codex
    // plan reads the same whichever daemon this device is attached to.
    if ("codex" !in plans) {
        state.usage.codexPlanType?.takeIf { it.isNotBlank() }?.let { raw ->
            val tier = ChatGPTPlan.displayName(raw).removePrefix("ChatGPT").trim()
            plans["codex"] = planLine(tier, state.usage.codexSubscriptionActiveUntil)
        }
    }
    state.antigravityStatus?.let { status ->
        val tier = status.planName?.replace("Google AI ", "")?.replace("Antigravity ", "")
            ?.takeIf { it.isNotBlank() } ?: "Pro"
        plans["antigravity"] = planLine(tier, status.subscriptionActiveUntil)
    }
    val names = mapOf("claude-code" to "Claude", "codex" to "Codex", "zai" to "GLM", "antigravity" to "Antigravity")
    return USAGE_PROVIDER_ORDER.mapNotNull { type ->
        val rows = windows[type].orEmpty()
        if (rows.isEmpty() && type !in plans) return@mapNotNull null
        EinkUsageGroup(type, names.getValue(type), plans[type], rows)
    }
}

/** ISO date → "→ Mon D" for the clock-less e-ink chips; null when absent/unparseable. */
private fun formatEinkExpiry(iso: String?): String? {
    val raw = iso?.takeIf { it.isNotBlank() } ?: return null
    return try {
        val dateStr = raw.split("T")[0]
        val parts = dateStr.split("-")
        if (parts.size == 3) {
            val months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
            val monthIdx = parts[1].toIntOrNull()?.minus(1) ?: 0
            val month = if (monthIdx in 0..11) months[monthIdx] else parts[1]
            val day = parts[2].toIntOrNull()?.toString() ?: parts[2]
            "→ $month $day"
        } else {
            "→ $dateStr"
        }
    } catch (e: Exception) {
        null
    }
}

@Composable
internal fun EinkDashboardChromeBar(
    state: DashboardState,
    snapshotTime: String,
    displayPrefs: DisplayPreferences,
    showSettingsButton: Boolean,
    onSettingsClick: () -> Unit,
    modifier: Modifier = Modifier,
    frameMode: Boolean = false,
    onToggleFrame: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val isCurrentlyLandscape =
        LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val currentOrientation by displayPrefs.orientationFlow.collectAsState(
        initial = DashboardOrientation.defaultFor(isEink = true),
    )
    Column(
        modifier = modifier.padding(horizontal = 10.dp, vertical = 5.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AgentDeckMark(
                size = 28.dp,
                color = MaterialTheme.colorScheme.onSurface,
            )
            // Stack the capture time with the identity, so the frame control
            // shares this row instead of consuming a second navigation band.
            // Session counts belong to the work pane and cannot displace it.
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "AgentDeck",
                    fontSize = 18.sp,
                    lineHeight = 21.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = snapshotTime,
                    fontSize = 12.sp,
                    lineHeight = 15.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Surface(
                modifier = Modifier
                    .heightIn(min = 44.dp)
                    .widthIn(min = 44.dp)
                    .semantics {
                        contentDescription = if (frameMode) "Return to work" else "Open frame mode"
                    }
                    .clickable(role = Role.Button, onClick = onToggleFrame),
                shape = RoundedCornerShape(4.dp),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface),
                color = MaterialTheme.colorScheme.background,
            ) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(horizontal = 8.dp)) {
                    Text(
                        text = if (frameMode) "Work" else "Frame",
                        fontSize = 12.sp,
                        lineHeight = 15.sp,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
            EinkChromeIconButton(
                onClick = {
                    scope.launch {
                        val newOrientation = DashboardOrientation.nextManualOrientation(
                            currentOrientation,
                            isCurrentlyLandscape,
                        )
                        displayPrefs.setOrientation(newOrientation)
                    }
                },
            ) {
                Icon(
                    imageVector = Icons.Default.ScreenRotation,
                    contentDescription = "Rotate screen",
                    tint = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.size(22.dp),
                )
            }
            if (showSettingsButton) {
                EinkChromeIconButton(onClick = onSettingsClick) {
                    Icon(
                        imageVector = Icons.Default.Settings,
                        contentDescription = "Settings",
                        tint = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
        }
        state.dot?.takeIf { it.configured }?.let { dot ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                dev.agentdeck.ui.monitor.DotPaperGlyph(dot)
                val label = dev.agentdeck.net.DotSurfaceRules.labels[dot.effectiveCode(System.currentTimeMillis())]
                Text(
                    text = "Dot · $label",
                    fontSize = 11.sp,
                    lineHeight = 14.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun EinkChromeIconButton(
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = Modifier
            .size(44.dp)
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(4.dp),
        border = BorderStroke(1.dp, Color.Black),
        color = MaterialTheme.colorScheme.background,
    ) {
        Box(contentAlignment = Alignment.Center) {
            content()
        }
    }
}

@Composable
private fun EinkNotConnectedScreen(
    connectionStatus: ConnectionStatus,
    discoveredBridges: List<DiscoveredBridge>,
    lastError: String?,
    retryUrl: String?,
    onRetry: () -> Unit,
    onConnectToBridge: (DiscoveredBridge) -> Unit,
    onConnectLocalhost: () -> Unit,
    onSettingsClick: () -> Unit,
    showSettingsButton: Boolean,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp)
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        AgentDeckMark(
            size = 48.dp,
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "AgentDeck",
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold),
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(modifier = Modifier.height(4.dp))

        Text(
            text = ConnectionLexicon.statusText(connectionStatus, lastError, discoveredBridges.isNotEmpty()),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(modifier = Modifier.height(16.dp))

        if (connectionStatus == ConnectionStatus.DISCONNECTED && retryUrl == null && discoveredBridges.isEmpty() && lastError == null) {
            Text(
                text = ConnectionSetupGuide.REQUIRED,
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "${ConnectionSetupGuide.MAC}\n${ConnectionSetupGuide.CLI}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(modifier = Modifier.height(16.dp))
        }

        // Error message from last connection attempt
        if (lastError != null && connectionStatus == ConnectionStatus.DISCONNECTED) {
            Text(
                text = lastError,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(modifier = Modifier.height(16.dp))
        }

        if (connectionStatus == ConnectionStatus.DISCONNECTED && retryUrl != null) {
            androidx.compose.material3.Button(onClick = onRetry) { Text(ConnectionLexicon.RETRY_CONNECTION) }
            Text(PairingCredential.endpointOf(retryUrl).orEmpty())
            Spacer(modifier = Modifier.height(8.dp))
        }

        if (connectionStatus == ConnectionStatus.DISCONNECTED) {
            // USB (adb reverse) quick connect
            Surface(
                modifier = Modifier
                    .fillMaxWidth(0.6f)
                    .clickable(onClick = onConnectLocalhost),
                shape = RoundedCornerShape(8.dp),
                border = BorderStroke(2.dp, Color.Black),
                color = MaterialTheme.colorScheme.background,
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        text = "USB (adb reverse)",
                        style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        text = BridgeConstants.LOCALHOST_DISPLAY,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // mDNS discovered bridges
            if (discoveredBridges.isNotEmpty()) {
                Text(
                    text = "Discovered",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.height(4.dp))
                discoveredBridges.forEach { bridge ->
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth(0.6f)
                            .clickable { onConnectToBridge(bridge) },
                        shape = RoundedCornerShape(8.dp),
                        border = BorderStroke(1.dp, Color.Black),
                        color = MaterialTheme.colorScheme.background,
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text(
                                text = "\u25CF ${bridge.name}",
                                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                text = "${bridge.host}:${bridge.port}",
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                }
            } else if (retryUrl == null && lastError == null) {
                Text(
                    text = ConnectionLexicon.SEARCHING,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        if (showSettingsButton) {
            Text(
                text = "\u2699 Settings",
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.clickable(onClick = onSettingsClick),
            )
        }
    }
}

@Composable
private fun EinkReconnectingScreen(
    url: String?,
    attempt: Int,
    lastError: String?,
    discoveredBridges: List<DiscoveredBridge>,
    onConnectToBridge: (DiscoveredBridge) -> Unit,
    onStopReconnecting: () -> Unit,
    onSettingsClick: () -> Unit,
    showSettingsButton: Boolean,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        AgentDeckMark(
            size = 48.dp,
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "AgentDeck",
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold),
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(modifier = Modifier.height(4.dp))

        Text(
            text = ConnectionLexicon.RECONNECTING,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(modifier = Modifier.height(8.dp))

        if (url != null) {
            Text(
                text = url,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Text(
            text = "Attempt $attempt",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Error block — above the action button so it's always visible.
        // Use a bordered Surface to clearly separate diagnostic info from status text.
        if (lastError != null) {
            Spacer(modifier = Modifier.height(12.dp))
            Surface(
                modifier = Modifier.fillMaxWidth(0.8f),
                shape = RoundedCornerShape(4.dp),
                border = BorderStroke(1.dp, Color.Black),
                color = MaterialTheme.colorScheme.background,
            ) {
                Column(modifier = Modifier.padding(10.dp)) {
                    Text(
                        text = "Connection error",
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Bold),
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = lastError,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Stop reconnecting button
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.6f)
                .clickable(onClick = onStopReconnecting),
            shape = RoundedCornerShape(8.dp),
            border = BorderStroke(2.dp, Color.Black),
            color = MaterialTheme.colorScheme.background,
        ) {
            Text(
                text = "Stop Reconnecting",
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(8.dp),
            )
        }

        // Show discovered bridges as alternatives
        if (discoveredBridges.isNotEmpty()) {
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = "Or connect via WiFi:",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(4.dp))
            discoveredBridges.forEach { bridge ->
                Surface(
                    modifier = Modifier
                        .fillMaxWidth(0.6f)
                        .clickable { onConnectToBridge(bridge) },
                    shape = RoundedCornerShape(4.dp),
                    border = BorderStroke(1.dp, Color.Gray),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(
                            text = "\u25CF ${bridge.name}",
                            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Text(
                            text = "${bridge.host}:${bridge.port}",
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Spacer(modifier = Modifier.height(4.dp))
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        if (showSettingsButton) {
            Text(
                text = "\u2699 Settings",
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.clickable(onClick = onSettingsClick),
            )
        }
    }
}
