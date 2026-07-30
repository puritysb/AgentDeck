package dev.agentdeck.ui.screen

import android.content.res.Configuration
import dev.agentdeck.ui.common.ConnectionLexicon
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ScreenRotation
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.R
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.BridgeDiscovery
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.TimelineStore
import dev.agentdeck.ui.component.AgentDeckMark
import dev.agentdeck.ui.component.BrandIcon
import dev.agentdeck.ui.monitor.subscriptionTrailing
import dev.agentdeck.util.codexLimitRows
import java.time.Instant
import dev.agentdeck.ui.eink.EinkAgentPanel
import dev.agentdeck.ui.eink.EinkAttentionPanel
import dev.agentdeck.ui.eink.EinkAquariumFrame
import dev.agentdeck.ui.eink.EinkSettingsOverlay
import dev.agentdeck.ui.eink.EinkTimelinePanel
import dev.agentdeck.ui.eink.rememberEinkLayoutScale
import dev.agentdeck.ui.eink.buildEinkAttentionFeatured
import dev.agentdeck.terrarium.renderer.einkColorEnabled
import dev.agentdeck.terrarium.toTerrariumState
import dev.agentdeck.ui.eink.EinkAnimatedRefreshZone
import dev.agentdeck.ui.eink.EinkRefreshZone
import dev.agentdeck.ui.eink.Zone
import dev.agentdeck.data.DashboardOrientation
import android.util.Log
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

private const val TAG = "EinkMonitor"
private const val VERBOSE_EINK_LOGS = false

private inline fun einkDebug(message: () -> String) {
    if (VERBOSE_EINK_LOGS || Log.isLoggable(TAG, Log.DEBUG)) {
        Log.d(TAG, message())
    }
}

private fun shouldPersistBridgeUrl(url: String?): Boolean {
    return url != null && !url.contains("127.0.0.1") && !url.contains("localhost")
}

@Composable
fun EinkMonitorScreen(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
) {
    val state by stateHolder.state.collectAsState()
    val connectionStatus by connection.status.collectAsState()
    val timelineEntries by TimelineStore.instance.entries.collectAsState()
    var showSettings by remember { mutableStateOf(false) }

    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val isLandscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    val einkScale = rememberEinkLayoutScale()
    val currentUrl by connection.url.collectAsState()

    // mDNS discovery — active while disconnected (url cleared)
    val discovery = remember { BridgeDiscovery(context) }
    var discoveredBridges by remember { mutableStateOf<List<DiscoveredBridge>>(emptyList()) }

    // Discovery + URL save — keyed on both status AND url
    // Run mDNS discovery whenever not connected (including while reconnecting)
    LaunchedEffect(connectionStatus, currentUrl) {
        when {
            connectionStatus == ConnectionStatus.CONNECTED -> {
                discoveredBridges = emptyList()
                // Keep the last network URL stable; localhost is always known implicitly.
                if (shouldPersistBridgeUrl(currentUrl)) {
                    displayPrefs.setLastBridgeUrl(currentUrl)
                }
            }
            else -> {
                // DISCONNECTED or CONNECTING — run mDNS to show alternatives
                discovery.discover().collect { bridges ->
                    discoveredBridges = bridges
                    // Preempt the localhost (USB) phase: adb reverse only exists under
                    // the Node CLI daemon, so against the Swift in-process daemon the
                    // ws://127.0.0.1 attempt can never succeed and the bounded discovery
                    // windows below can keep missing a slow NSD resolve. Re-resolving per
                    // connection also heals a saved URL whose port went stale after a
                    // daemon restart (e.g. 9121→9120).
                    val daemon = bridges.firstOrNull { it.agentType == "daemon" }
                    val cur = connection.url.value
                    val curIsLocalOrNone = cur == null ||
                        cur.contains("127.0.0.1") || cur.contains("localhost")
                    if (daemon != null && curIsLocalOrNone &&
                        connection.status.value != ConnectionStatus.CONNECTED) {
                        einkDebug { "mDNS preempts USB attempt: ${daemon.name} at ${daemon.wsUrl()}" }
                        connection.connect(daemon.wsUrl(), daemon.fallbackWsUrl())
                    }
                }
            }
        }
    }

    // Auto-connect: localhost (USB) → saved URL → mDNS (WiFi)
    LaunchedEffect(Unit) {
        val rawSavedUrl = displayPrefs.lastBridgeUrlFlow.first()
        val savedUrl = rawSavedUrl?.takeUnless { !shouldPersistBridgeUrl(it) }
        if (rawSavedUrl != null && savedUrl == null) {
            displayPrefs.setLastBridgeUrl(null)
        }
        einkDebug { "Auto-connect: savedUrl=$savedUrl" }
        // Try localhost (adb reverse USB connection) before mDNS
        if (connection.status.value != ConnectionStatus.CONNECTED) {
            einkDebug { "Trying localhost:${BridgeConstants.WS_PORT} (USB)..." }
            connection.connect(BridgeConstants.LOCALHOST_WS_URL)
            delay(3000)
        }
        if (savedUrl != null && connection.status.value != ConnectionStatus.CONNECTED) {
            connection.autoConnect(savedUrl)
            delay(5000)
        }
        // If still disconnected, try mDNS discovery with daemon grace period
        if (connection.status.value != ConnectionStatus.CONNECTED) {
            einkDebug { "Saved URL failed, trying mDNS discovery..." }
            var bestBridges = emptyList<DiscoveredBridge>()
            withTimeoutOrNull(6000) {
                discovery.discover().collect { bridges ->
                    bestBridges = bridges
                    if (bridges.isNotEmpty() && connection.status.value != ConnectionStatus.CONNECTED) {
                        val daemon = bridges.firstOrNull { it.agentType == "daemon" }
                        if (daemon != null) {
                            einkDebug { "mDNS daemon found: ${daemon.name} at ${daemon.wsUrl()}" }
                            connection.connect(daemon.wsUrl(), daemon.fallbackWsUrl())
                            return@collect
                        }
                    }
                }
            }
            // No non-daemon fallback — session bridges don't serve external clients.
            if (false && bestBridges.isNotEmpty() &&
                connection.status.value != ConnectionStatus.CONNECTED) {
                val bridge = bestBridges.first()
                einkDebug { "mDNS daemon not found, fallback: ${bridge.name} (agent=${bridge.agentType}) at ${bridge.wsUrl()}" }
                connection.connect(bridge.wsUrl(), bridge.fallbackWsUrl())
            }
        }
    }

    // Recovery after BridgeConnection gives up on localhost and clears URL.
    // Keep cycling so devices reconnect when the daemon starts after the app.
    LaunchedEffect(connectionStatus, currentUrl) {
        if (connectionStatus == ConnectionStatus.DISCONNECTED && currentUrl == null) {
            delay(500) // brief pause before re-discovery
            einkDebug { "Disconnected with no URL — re-discovering via mDNS" }
            withTimeoutOrNull(6000) {
                discovery.discover().collect { bridges ->
                    val daemon = bridges.firstOrNull { it.agentType == "daemon" }
                    if (daemon != null && connection.status.value != ConnectionStatus.CONNECTED) {
                        einkDebug { "mDNS re-discover (daemon): ${daemon.name} at ${daemon.wsUrl()}" }
                        connection.connect(daemon.wsUrl(), daemon.fallbackWsUrl())
                        return@collect
                    }
                }
            }
            if (connection.status.value != ConnectionStatus.CONNECTED && connection.url.value == null) {
                delay(10_000)
                if (connection.status.value != ConnectionStatus.CONNECTED && connection.url.value == null) {
                    einkDebug { "mDNS recovery timed out — retrying localhost:${BridgeConstants.WS_PORT} (USB)" }
                    connection.connect(BridgeConstants.LOCALHOST_WS_URL)
                }
            }
        }
    }

    // mDNS-discovered bridges are also shown in the UI for manual selection
    // in the not-connected screen or use Settings for manual URL entry.

    val lastError by connection.lastError.collectAsState()
    val isReconnecting by connection.isReconnecting.collectAsState()
    val reconnectAttempt by connection.reconnectAttempt.collectAsState()
    val showSessionList by displayPrefs.showSessionListFlow.collectAsState(initial = true)
    val showTimeline by displayPrefs.showTimelineFlow.collectAsState(initial = true)
    val showSettingsButton by displayPrefs.showSettingsButtonFlow.collectAsState(initial = true)
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
        } else if (isLandscape) {
            // App Store-ready E-ink projection:
            //   chrome + optional attention strip
            //   top row: Sessions | Terrarium
            //   bottom row: text timeline
            // Models/devices/large limits are intentionally absent; limits
            // appear only as a small corner card when fresh usage data exists.
            // Use state as key so toTerrariumState() recomputes when siblingSessions etc. change.
            // derivedStateOf + remember would capture the initial state parameter (plain value,
            // not a Compose State) and never re-evaluate — causing stale creature counts.
            val terrariumState = remember(state) { state.toTerrariumState() }
            val terrariumRefreshKey = remember(state, terrariumState) {
                buildEinkTerrariumRefreshKey(state, terrariumState)
            }

            // Stable key that captures session count + individual states (for refresh triggers)
            val sessionsKey = state.siblingSessions.joinToString(",") {
                "${it.id}:${it.agentType}:${it.state}:${it.projectName}"
            }

            Column(modifier = Modifier.fillMaxSize()) {
                EinkRefreshZone(
                    mode = Zone.CHROME.mode,
                    debounceMs = Zone.CHROME.debounceMs,
                    triggerKey = Triple(state.agentState, sessionsKey, state.workerSessionCount),
                    sleepSnapshotMode = sleepSnapshotMode,
                    modifier = Modifier.height(einkScale.chromeHeight).fillMaxWidth(),
                ) {
                    EinkDashboardChromeBar(
                        state = state,
                        displayPrefs = displayPrefs,
                        showSettingsButton = showSettingsButton,
                        onSettingsClick = { showSettings = true },
                        modifier = Modifier.fillMaxSize(),
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
                        modifier = Modifier.height(einkScale.attentionHeightLandscape).fillMaxWidth(),
                    ) {
                        EinkAttentionPanel(
                            featured = featuredAttention,
                            onFocusSession = { connection.sendFocusSession(it) },
                            onSelectOption = { connection.sendSelectOption(it) },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }

                Column(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    Row(
                        modifier = Modifier
                            .weight(if (showTimeline) 0.64f else 1f)
                            .fillMaxWidth(),
                    ) {
                        if (showSessionList) {
                            EinkRefreshZone(
                                mode = Zone.CHROME.mode,
                                debounceMs = Zone.CHROME.debounceMs,
                                triggerKey = Triple(state.agentState, sessionsKey, state.workerSessionCount),
                                sleepSnapshotMode = sleepSnapshotMode,
                                modifier = Modifier.weight(0.36f).fillMaxHeight(),
                            ) {
                                EinkAgentPanel(
                                    state = state,
                                    onSettingsClick = { showSettings = true },
                                    onFocusSession = { connection.sendFocusSession(it) },
                                    showSettingsButton = showSettingsButton,
                                    displayPrefs = displayPrefs,
                                    showBrandHeader = false,
                                    showFooterControls = false,
                                    modifier = Modifier.fillMaxSize(),
                                )
                            }

                            VerticalDivider(thickness = 2.dp, color = Color.Black)
                        }

                        Box(modifier = Modifier.weight(if (showSessionList) 0.64f else 1f).fillMaxHeight()) {
                            EinkAnimatedRefreshZone(
                                stateKey = terrariumRefreshKey,
                                sleepSnapshotMode = sleepSnapshotMode,
                                modifier = Modifier.fillMaxSize(),
                            ) { onFrameRendered ->
                                EinkAquariumFrame(
                                    state = terrariumState,
                                    snapshotMode = sleepSnapshotMode,
                                    onFrameRendered = onFrameRendered,
                                )
                            }
                            if (hasEinkLimitData(state)) {
                                EinkLimitsCornerCard(
                                    state = state,
                                    compact = true,
                                    modifier = Modifier
                                        .align(Alignment.BottomStart)
                                        .padding(start = 12.dp, bottom = 12.dp),
                                )
                            }
                        }
                    }

                    if (showTimeline) {
                        HorizontalDivider(thickness = 2.dp, color = Color.Black)
                        EinkRefreshZone(
                            mode = Zone.TIMELINE.mode,
                            debounceMs = Zone.TIMELINE.debounceMs,
                            triggerKey = timelineEntries.size,
                            sleepSnapshotMode = sleepSnapshotMode,
                            modifier = Modifier.weight(0.36f).fillMaxWidth(),
                        ) {
                            EinkTimelinePanel(entries = timelineEntries, modifier = Modifier.fillMaxSize())
                        }
                    }
                }
            }
        } else {
            EinkPortraitLayout(
                state = state,
                timelineEntries = timelineEntries,
                connection = connection,
                displayPrefs = displayPrefs,
                sleepSnapshotMode = sleepSnapshotMode,
                showSessionList = showSessionList,
                showTimeline = showTimeline,
                showSettingsButton = showSettingsButton,
                onSettingsClick = { showSettings = true },
            )
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

private fun buildEinkTerrariumRefreshKey(
    state: DashboardState,
    terrariumState: dev.agentdeck.terrarium.TerrariumState,
): List<Any?> {
    val sessionProjection = state.siblingSessions.map {
        "${it.id}:${it.agentType}:${it.state}:${it.projectName}"
    }
    return listOf(
        state.sessionId,
        state.agentType,
        state.agentState,
        state.projectName,
        sessionProjection,
        state.usage.fiveHourPercent,
        state.usage.sevenDayPercent,
        state.antigravityStatus?.planName,
        state.antigravityStatus?.availableCredits,
        state.antigravityStatus?.minimumCreditAmountForUsage,
        terrariumState.agents.map { "${it.sessionId}:${it.agentType}:${it.visualState}" },
        terrariumState.cloudCreatures.map { "${it.sessionId}:${it.agentType}:${it.visualState}" },
        terrariumState.openCodeCreatures.map { "${it.sessionId}:${it.agentType}:${it.visualState}" },
        terrariumState.antigravityCreatures.map { "${it.sessionId}:${it.agentType}:${it.visualState}" },
    )
}

private fun hasEinkLimitData(state: DashboardState): Boolean {
    return buildEinkLimitRows(state).isNotEmpty()
}

@Composable
private fun EinkLimitsCornerCard(
    state: DashboardState,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val rows = buildEinkLimitRows(state)
    val width = if (compact) 164.dp else 190.dp
    // Corner source tag: derive from the providers actually feeding this card
    // rather than a hardcoded "node" (the daemon may be the Swift in-process one,
    // and a Codex-only card mislabeled as "node" reads as the wrong provider).
    // One provider → its name; two → "a+b"; three+ → "mix". The per-row brand
    // marks already disambiguate, so this only needs to stay honest and short.
    val sourceTag = einkLimitsSourceTag(rows, state)
    // Height grows with row count (Claude 5h/7d + Codex 5h/7d + subscription
    // expiry lines + the Antigravity chip can stack up to ~6 rows). A fixed
    // per-row step keeps the card from clipping when several providers are live,
    // while a card with no rows never renders (gated by hasEinkLimitData).
    // perRow must cover a gauge row (≈13.sp line / 11.dp icon) PLUS the 3.dp
    // Column gap, and base must cover vertical padding (14.dp) + the header row
    // (≈12.dp); under-provisioning clipped the bottom-most (7d) gauge.
    val perRow = if (compact) 17.dp else 18.dp
    val base = if (compact) 28.dp else 31.dp
    val height = base + perRow * rows.size.coerceAtLeast(1)
    Surface(
        modifier = modifier
            .width(width)
            .height(height),
        shape = RoundedCornerShape(3.dp),
        border = BorderStroke(1.dp, Color.Black),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 7.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "LIMITS",
                    fontSize = 10.sp,
                    lineHeight = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = sourceTag,
                    fontSize = 9.sp,
                    lineHeight = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            rows.forEach { row ->
                if (row.percent != null) {
                    EinkLimitGaugeRow(label = row.label, percent = row.percent, agentType = row.agentType, stale = row.stale)
                } else {
                    EinkLimitTextRow(label = row.label, value = row.value.orEmpty())
                }
            }
        }
    }
}

private data class EinkLimitLine(
    val label: String,
    val percent: Double? = null,
    val value: String? = null,
    val agentType: String? = null,
    val stale: Boolean = false,
)

private fun buildEinkLimitRows(state: DashboardState, now: Instant = Instant.now()): List<EinkLimitLine> {
    val rows = mutableListOf<EinkLimitLine>()
    if (state.usage.usageStale != true) {
        state.usage.fiveHourPercent?.let { rows.add(EinkLimitLine(label = "5h", percent = it, agentType = "claude-code")) }
        state.usage.sevenDayPercent?.let { rows.add(EinkLimitLine(label = "7d", percent = it, agentType = "claude-code")) }
    }
    // Codex (ChatGPT) rolling windows — independent of Claude's usageStale, each
    // carries its own stale flag. We keep BOTH primary (5h) and secondary (7d)
    // even when a window has elapsed: dropping stale ones made the 7d window
    // vanish entirely once Codex went idle (its window slides into the past). A
    // stale window keeps its last-known percent and is flagged with a trailing
    // "!" instead of disappearing. The leading brand mark identifies the provider,
    // so labels stay plain 5h/7d.
    codexLimitRows(state.codexRateLimits).forEach {
        rows.add(EinkLimitLine(label = it.label, percent = it.percent, agentType = it.agentType, stale = it.stale))
    }
    // Subscription expiry rows — show "<provider> → M D" when the plan carries an
    // expiry (Antigravity has its own chip below, so skip it here). When the
    // daemon can't supply an expiry (e.g. the App Store Swift daemon exposes no
    // subscription `until`), subscriptionTrailing returns null and the row is
    // simply omitted — the card stays honest rather than showing a blank date.
    state.subscriptions.forEach { sub ->
        // The daemon stores the Antigravity subscription under its raw plan name
        // ("Google AI Pro"), so skip it here — it's rendered by the AGY chip below.
        if (isAntigravityPlanName(sub.name)) return@forEach
        val trailing = subscriptionTrailing(sub.until, now) ?: return@forEach
        val expiry = if (trailing.expired) "→ renew" else formatEinkExpiry(sub.until) ?: return@forEach
        rows.add(EinkLimitLine(label = "", value = "${sub.name.substringBefore(' ')} $expiry"))
    }
    buildAntigravityLimitValue(state)?.let { rows.add(EinkLimitLine(label = "", value = it)) }
    return rows
}

/**
 * Short provider tag for the LIMITS card corner. Derives from the providers
 * that actually contribute gauge rows (plus the native Antigravity chip), so a
 * Codex-only card reads "codex" instead of the stale hardcoded "node" source
 * badge — which was both wrong (the source may be the Swift daemon) and read as
 * the row's provider. One provider → its name; two → "a+b"; three+ → "mix".
 */
private fun einkLimitsSourceTag(rows: List<EinkLimitLine>, state: DashboardState): String {
    val providers = LinkedHashSet<String>()
    rows.forEach { row ->
        when (row.agentType) {
            "claude-code" -> providers.add("claude")
            "codex" -> providers.add("codex")
        }
    }
    if (state.antigravityStatus != null) providers.add("agy")
    return when {
        providers.isEmpty() -> "node"
        providers.size <= 2 -> providers.joinToString("+")
        else -> "mix"
    }
}

/**
 * True when a subscription entry's name is really the Antigravity plan. The
 * daemon stores it as the raw plan name (e.g. "Google AI Pro"), not a literal
 * "Antigravity …" string. Mirrors ESP32 `UsageFormat::isAntigravityPlanName`.
 */
private fun isAntigravityPlanName(name: String): Boolean =
    name.startsWith("Google AI", ignoreCase = true) ||
        name.startsWith("Antigravity", ignoreCase = true) ||
        name.startsWith("AGY", ignoreCase = true)

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

private fun buildAntigravityLimitValue(state: DashboardState): String? {
    val status = state.antigravityStatus ?: return null
    // Shorten the plan to "AGY <tier>" (e.g. "Google AI Pro" → "AGY Pro"). The raw
    // availableCredits count is deliberately NOT surfaced — it's a backend metering
    // number that means nothing at a glance.
    val tier = status.planName
        ?.replace("Google AI ", "")
        ?.replace("Antigravity ", "")
        ?.takeIf { it.isNotBlank() } ?: "Pro"
    val plan = "AGY $tier"
    val until = formatEinkExpiry(status.subscriptionActiveUntil)
    return if (until != null) "$plan $until" else plan
}

@Composable
private fun EinkLimitGaugeRow(label: String, percent: Double, agentType: String? = null, stale: Boolean = false) {
    val pct = percent.coerceIn(0.0, 100.0).toInt()
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (agentType != null) {
            BrandIcon(agentType = agentType, isEink = true, size = 11.dp)
        }
        Text(
            text = "$label ${einkBlockGauge(pct)} $pct%${if (stale) "!" else ""}",
            fontSize = 11.sp,
            lineHeight = 13.sp,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
        )
    }
}

@Composable
private fun EinkLimitTextRow(label: String, value: String) {
    Text(
        text = if (label.isBlank()) value else "$label $value",
        fontSize = 11.sp,
        lineHeight = 13.sp,
        fontFamily = FontFamily.Monospace,
        color = MaterialTheme.colorScheme.onSurface,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

private fun einkBlockGauge(percent: Int): String {
    val cells = 8
    val filled = ((percent.coerceIn(0, 100) / 100.0) * cells).toInt()
    return "\u2588".repeat(filled) + "\u2591".repeat(cells - filled)
}

@Composable
private fun EinkDashboardChromeBar(
    state: dev.agentdeck.state.DashboardState,
    displayPrefs: DisplayPreferences,
    showSettingsButton: Boolean,
    onSettingsClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val isCurrentlyLandscape =
        LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val currentOrientation by displayPrefs.orientationFlow.collectAsState(
        initial = DashboardOrientation.defaultFor(isEink = true),
    )
    Row(
        modifier = modifier.padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AgentDeckMark(
            size = 30.dp,
            color = MaterialTheme.colorScheme.onSurface,
        )
        // Wordmark uses default sans (IBM Plex Sans where bundled, system sans
        // otherwise). DESIGN.md §10-3 reserves Monospace for diagnostic/data
        // glyphs — the brand line itself stays sans for identity.
        Text(
            text = "AgentDeck",
            fontSize = 18.sp,
            lineHeight = 21.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text = "· :9120",
            fontSize = 12.sp,
            lineHeight = 15.sp,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.weight(1f))
        state.workerSessionCount?.takeIf { state.gatewayConnected == true && it > 0 }?.let {
            Text(
                text = "W:$it",
                fontSize = 12.sp,
                lineHeight = 15.sp,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            text = "S:${einkSessionCount(state)}",
            fontSize = 12.sp,
            lineHeight = 15.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurface,
        )
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
                modifier = Modifier.size(19.dp),
            )
        }
        if (showSettingsButton) {
            EinkChromeIconButton(
                onClick = onSettingsClick,
            ) {
                Icon(
                    imageVector = Icons.Default.Settings,
                    contentDescription = "Settings",
                    tint = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.size(18.dp),
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
            .size(32.dp)
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(3.dp),
        border = BorderStroke(1.dp, Color.Black),
        color = MaterialTheme.colorScheme.background,
    ) {
        Box(contentAlignment = Alignment.Center) {
            content()
        }
    }
}

private fun einkSessionCount(state: dev.agentdeck.state.DashboardState): Int {
    val primaryIsAggregate = state.agentType == "daemon" ||
        state.agentType == "openclaw" ||
        state.siblingSessions.any { it.agentType == state.agentType }
    val primaryCount = if (!primaryIsAggregate && state.agentType != null) 1 else 0
    return primaryCount + state.siblingSessions.count { it.agentType != "daemon" }
}


@Composable
private fun EinkNotConnectedScreen(
    connectionStatus: ConnectionStatus,
    discoveredBridges: List<DiscoveredBridge>,
    lastError: String?,
    onConnectToBridge: (DiscoveredBridge) -> Unit,
    onConnectLocalhost: () -> Unit,
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
            text = when (connectionStatus) {
                ConnectionStatus.DISCONNECTED -> ConnectionLexicon.SEARCHING
                ConnectionStatus.CONNECTING -> ConnectionLexicon.CONNECTING
                ConnectionStatus.CONNECTED -> "Connected"
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Error message from last connection attempt
        if (lastError != null && connectionStatus == ConnectionStatus.DISCONNECTED) {
            Text(
                text = lastError,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(modifier = Modifier.height(16.dp))
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
            } else {
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

@Composable
private fun EinkPortraitLayout(
    state: dev.agentdeck.state.DashboardState,
    timelineEntries: List<dev.agentdeck.state.TimelineEntry>,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    sleepSnapshotMode: Boolean,
    showSessionList: Boolean,
    showTimeline: Boolean,
    showSettingsButton: Boolean,
    onSettingsClick: () -> Unit,
) {
    val einkScale = rememberEinkLayoutScale()
    val terrariumState = remember(state) { state.toTerrariumState() }
    val terrariumRefreshKey = remember(state, terrariumState) {
        buildEinkTerrariumRefreshKey(state, terrariumState)
    }
    val featuredAttention = remember(state) { buildEinkAttentionFeatured(state) }
    val sessionsKey = state.siblingSessions.joinToString(",") {
        "${it.id}:${it.agentType}:${it.state}:${it.projectName}"
    }

    Column(modifier = Modifier.fillMaxSize()) {
        EinkRefreshZone(
            mode = Zone.CHROME.mode,
            debounceMs = Zone.CHROME.debounceMs,
            triggerKey = Triple(state.agentState, sessionsKey, state.workerSessionCount),
            sleepSnapshotMode = sleepSnapshotMode,
            modifier = Modifier.height(einkScale.chromeHeight).fillMaxWidth(),
        ) {
            EinkDashboardChromeBar(
                state = state,
                displayPrefs = displayPrefs,
                showSettingsButton = showSettingsButton,
                onSettingsClick = onSettingsClick,
                modifier = Modifier.fillMaxSize(),
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
                modifier = Modifier.height(einkScale.attentionHeightPortrait).fillMaxWidth(),
            ) {
                EinkAttentionPanel(
                    featured = featuredAttention,
                    onFocusSession = { connection.sendFocusSession(it) },
                    onSelectOption = { connection.sendSelectOption(it) },
                )
            }
        }

        if (showSessionList) {
            EinkRefreshZone(
                mode = Zone.CHROME.mode,
                debounceMs = Zone.CHROME.debounceMs,
                triggerKey = Triple(state.agentState, sessionsKey, state.workerSessionCount),
                sleepSnapshotMode = sleepSnapshotMode,
                modifier = Modifier.weight(if (showTimeline) 0.26f else 0.34f).fillMaxWidth(),
            ) {
                EinkAgentPanel(
                    state = state,
                    onSettingsClick = onSettingsClick,
                    onFocusSession = { connection.sendFocusSession(it) },
                    showSettingsButton = showSettingsButton,
                    displayPrefs = displayPrefs,
                    showBrandHeader = false,
                    showFooterControls = false,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            HorizontalDivider(thickness = 2.dp, color = Color.Black)
        }

        Box(modifier = Modifier.weight(if (showTimeline) 0.32f else 0.66f).fillMaxWidth()) {
            EinkAnimatedRefreshZone(
                stateKey = terrariumRefreshKey,
                sleepSnapshotMode = sleepSnapshotMode,
                modifier = Modifier.fillMaxSize(),
            ) { onFrameRendered ->
                EinkAquariumFrame(
                    state = terrariumState,
                    snapshotMode = sleepSnapshotMode,
                    onFrameRendered = onFrameRendered,
                )
            }
            if (hasEinkLimitData(state)) {
                EinkLimitsCornerCard(
                    state = state,
                    compact = true,
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(start = 10.dp, bottom = 10.dp),
                )
            }
        }

        if (showTimeline) {
            HorizontalDivider(thickness = 2.dp, color = Color.Black)
            EinkRefreshZone(
                mode = Zone.TIMELINE.mode,
                debounceMs = Zone.TIMELINE.debounceMs,
                triggerKey = timelineEntries.size,
                sleepSnapshotMode = sleepSnapshotMode,
                modifier = Modifier.weight(0.42f).fillMaxWidth(),
            ) {
                EinkTimelinePanel(entries = timelineEntries, modifier = Modifier.fillMaxSize())
            }
        }
    }
}
