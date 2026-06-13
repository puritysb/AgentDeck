package dev.agentdeck.ui.monitor

import android.content.res.Configuration
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ScreenRotation
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import dev.agentdeck.R
import dev.agentdeck.data.DashboardOrientation
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.BridgeDiscovery
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.net.PromptOption
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.TimelineStore
import dev.agentdeck.terrarium.CrayfishVisualState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumLayout
import dev.agentdeck.terrarium.TerrariumState
import dev.agentdeck.terrarium.creature.BubbleSystem
import dev.agentdeck.terrarium.creature.CrayfishCreature
import dev.agentdeck.terrarium.creature.DataParticleSystem
import dev.agentdeck.terrarium.creature.CloudCreature
import dev.agentdeck.terrarium.creature.OpenCodeCreature
import dev.agentdeck.terrarium.creature.OctopusCreature
import dev.agentdeck.terrarium.environment.KelpField
import dev.agentdeck.terrarium.environment.LightRaySystem
import dev.agentdeck.terrarium.environment.PlanktonSystem
import dev.agentdeck.terrarium.environment.RockFormation
import dev.agentdeck.terrarium.environment.SandDisturbance
import dev.agentdeck.terrarium.environment.WaterEffect
import dev.agentdeck.terrarium.environment.WaterSurface
import dev.agentdeck.terrarium.AgentLayoutInfo
import dev.agentdeck.terrarium.layoutOctopuses
import dev.agentdeck.terrarium.layoutOctopusesByProject
import dev.agentdeck.terrarium.layoutCloudCreatures
import dev.agentdeck.terrarium.layoutOpenCodeCreatures
import dev.agentdeck.terrarium.layoutWorkerCrayfish
import dev.agentdeck.terrarium.renderer.ColorTerrariumCanvas
import dev.agentdeck.terrarium.toTerrariumState
import dev.agentdeck.ui.theme.AgentDeckColors
import kotlinx.coroutines.launch

private const val TABLET_CRAYFISH_CENTER_X_FRACTION = 0.70f
private const val TABLET_CRAYFISH_CENTER_Y_FRACTION = 0.575f

/**
 * Unified Dashboard screen — terrarium fills the background,
 * semi-transparent HUD panels overlay with agent info.
 * When disconnected, shows a connection overlay with USB + mDNS options.
 */
@Composable
fun MonitorScreen(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
) {
    val dashState by stateHolder.state.collectAsState()
    val terrariumState = remember(dashState) { dashState.toTerrariumState() }
    val timelineEntries by TimelineStore.instance.entries.collectAsState()
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    val lastError by connection.lastError.collectAsState()
    val isReconnecting by connection.isReconnecting.collectAsState()
    val reconnectAttempt by connection.reconnectAttempt.collectAsState()
    val showSessionList by displayPrefs.showSessionListFlow.collectAsState(initial = true)
    val showTankStatus by displayPrefs.showTankStatusFlow.collectAsState(initial = true)
    val showDeviceDiagnostic by displayPrefs.showDeviceDiagnosticFlow.collectAsState(initial = true)
    val showTimeline by displayPrefs.showTimelineFlow.collectAsState(initial = true)
    val showSettingsButton by displayPrefs.showSettingsButtonFlow.collectAsState(initial = true)
    val currentOrientation by displayPrefs.orientationFlow.collectAsState(
        initial = DashboardOrientation.defaultFor(isEink = false)
    )
    val configuration = LocalConfiguration.current
    val isCurrentlyLandscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    val coroutineScope = rememberCoroutineScope()

    // mDNS discovery — active while not connected (including reconnect)
    val context = LocalContext.current
    val discovery = remember { BridgeDiscovery(context) }
    var discoveredBridges by remember { mutableStateOf<List<DiscoveredBridge>>(emptyList()) }

    LaunchedEffect(connectionStatus, currentUrl) {
        when {
            connectionStatus == ConnectionStatus.CONNECTED -> {
                discoveredBridges = emptyList()
            }
            else -> {
                // DISCONNECTED or CONNECTING — run mDNS to show WiFi alternatives
                discovery.discover().collect { bridges ->
                    discoveredBridges = bridges
                }
            }
        }
    }

    val showDisconnected = connectionStatus != ConnectionStatus.CONNECTED &&
        dashState.agentState == AgentState.DISCONNECTED
    val monitorScale = rememberMonitorLayoutScale()
    val crayfishCenterX = if (monitorScale.isTablet) {
        TABLET_CRAYFISH_CENTER_X_FRACTION
    } else {
        TerrariumLayout.CRAYFISH_CENTER_X_FRACTION
    }
    val crayfishCenterY = if (monitorScale.isTablet) {
        TABLET_CRAYFISH_CENTER_Y_FRACTION
    } else {
        TerrariumLayout.CRAYFISH_CENTER_Y_FRACTION
    }
    val mainCrayfish = remember(monitorScale.isTablet) {
        CrayfishCreature(crayfishCenterX, crayfishCenterY)
    }
    val drawCrayfishForeground = monitorScale.isTablet &&
        !showDisconnected &&
        showTimeline &&
        terrariumState.crayfish != CrayfishVisualState.DORMANT

    var showSettingsDialog by remember { mutableStateOf(false) }
    // "Aquarium viewing" mode — when on, SessionListPanel + TopologyRail
    // fade out so the user can watch the terrarium uninterrupted. Toggled
    // by tapping empty water (mirrors ESP32 firmware aquarium screen).
    var hudHidden by remember { mutableStateOf(false) }

    // Pre-compute attention card visibility so we can gate the background
    // tap detector — tapping outside the question card during an awaiting
    // turn shouldn't accidentally collapse the HUD behind it.
    val attentionVisible = run {
        val awaiting = buildAwaitingList(dashState)
        (awaiting.firstOrNull { it.id == dashState.sessionId } ?: awaiting.firstOrNull()) != null
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(TerrariumColors.DeepSea),
    ) {
        // Layer 1: Terrarium background (always renders)
        ColorTerrariumBackground(
            state = terrariumState,
            mainCrayfish = mainCrayfish,
            mainCrayfishCenterXFraction = crayfishCenterX,
            mainCrayfishCenterYFraction = crayfishCenterY,
            drawMainCrayfishInBackground = !drawCrayfishForeground,
        )

        // Layer 1.5: Background tap detector — sits between terrarium and
        // HUD so panel children (which don't consume taps) still fall
        // through here. Gated:
        //   • bridge disconnected → ConnectionOverlay owns the screen
        //   • attention card up → user is mid-answer, tap-toggle off
        if (!showDisconnected && !attentionVisible) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(Unit) {
                        detectTapGestures { hudHidden = !hudHidden }
                    },
            )
        }

        if (showDisconnected) {
            // Layer 2: Connection overlay when disconnected
            ConnectionOverlay(
                connectionStatus = connectionStatus,
                discoveredBridges = discoveredBridges,
                lastError = lastError,
                isReconnecting = isReconnecting,
                reconnectAttempt = reconnectAttempt,
                reconnectUrl = currentUrl,
                onConnectToBridge = { bridge ->
                    connection.connect(bridge.wsUrl())
                },
                onConnectLocalhost = {
                    connection.connect(BridgeConstants.LOCALHOST_WS_URL)
                },
                onStopReconnecting = {
                    connection.disconnect()
                },
            )
        } else {
            // Layer 2: Timeline over sand area
            if (showTimeline) {
                TimelineStrip(
                    entries = timelineEntries,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .fillMaxHeight(TerrariumLayout.SAND_HEIGHT_FRACTION)
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                )

                // Layer 3: Tablet foreground. Keep OpenClaw visible over the
                // lower TIMELINE detail pane without lifting all fish/canvas
                // layers above the text.
                if (drawCrayfishForeground) {
                    OpenClawForegroundLayer(
                        mainCrayfish = mainCrayfish,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }

            // Layer 4: HUD overlay panels. Draw after the foreground crayfish
            // so right-side topology text remains readable when their areas
            // intersect.
            MonitorHUD(
                dashState = dashState,
                hudHidden = hudHidden,
                showSessionList = showSessionList,
                showTopologyRail = showTankStatus || showDeviceDiagnostic,
            )
        }

        // Layer 5: Rotation + settings controls. Rotation stays available
        // even when the optional Settings button is hidden; this keeps
        // portrait/landscape reachable on tablets with system rotation locked.
        Row(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = {
                    coroutineScope.launch {
                        displayPrefs.setOrientation(
                            DashboardOrientation.nextManualOrientation(
                                currentOrientation,
                                isCurrentlyLandscape,
                            )
                        )
                    }
                },
            ) {
                Icon(
                    imageVector = Icons.Default.ScreenRotation,
                    contentDescription = "Rotate screen",
                    tint = Color.White.copy(alpha = 0.45f),
                )
            }
            if (showSettingsButton) {
                IconButton(
                    onClick = { showSettingsDialog = true },
                ) {
                    Icon(
                        imageVector = Icons.Default.Settings,
                        contentDescription = "Settings",
                        tint = Color.White.copy(alpha = 0.6f),
                    )
                }
            }
        }
    }

    if (showSettingsDialog) {
        TabletSettingsDialog(
            connection = connection,
            displayPrefs = displayPrefs,
            onDismiss = { showSettingsDialog = false },
        )
    }
}

/**
 * Semi-transparent connection overlay shown over the terrarium when disconnected.
 */
@Composable
private fun ConnectionOverlay(
    connectionStatus: ConnectionStatus,
    discoveredBridges: List<DiscoveredBridge>,
    lastError: String?,
    isReconnecting: Boolean,
    reconnectAttempt: Int,
    reconnectUrl: String?,
    onConnectToBridge: (DiscoveredBridge) -> Unit,
    onConnectLocalhost: () -> Unit,
    onStopReconnecting: () -> Unit,
) {
    // Semi-transparent dark scrim
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xCC0F172A)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 360.dp)
                .background(
                    color = Color(0xE61E293B),
                    shape = RoundedCornerShape(16.dp),
                )
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Image(
                painter = painterResource(R.drawable.agentdeck_icon),
                contentDescription = "AgentDeck",
                modifier = Modifier
                    .size(80.dp)
                    .clip(RoundedCornerShape(16.dp)),
                contentScale = ContentScale.Fit,
            )

            Text(
                text = "AgentDeck",
                style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold),
                color = AgentDeckColors.WhiteText,
                textAlign = TextAlign.Center,
            )

            Text(
                text = when {
                    isReconnecting -> "Reconnecting..."
                    connectionStatus == ConnectionStatus.DISCONNECTED -> "Searching for bridges..."
                    connectionStatus == ConnectionStatus.CONNECTING -> "Connecting..."
                    else -> "Connected"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = AgentDeckColors.SlateText,
                textAlign = TextAlign.Center,
            )

            if (isReconnecting) {
                // Stop reconnecting button
                OutlinedButton(
                    onClick = onStopReconnecting,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Text(
                        text = "Stop Reconnecting",
                        color = AgentDeckColors.SlateText,
                    )
                }
            }

            // Error message
            if (lastError != null && connectionStatus == ConnectionStatus.DISCONNECTED) {
                Text(
                    text = lastError,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = AgentDeckColors.Red,
                    textAlign = TextAlign.Center,
                )
            }

            if (connectionStatus == ConnectionStatus.CONNECTING && !isReconnecting) {
                Text(
                    text = "Connecting...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = AgentDeckColors.Amber,
                )
            }

            // Show connection options when not actively connecting (or when reconnecting with alternatives)
            if (connectionStatus == ConnectionStatus.DISCONNECTED || isReconnecting) {
                Spacer(modifier = Modifier.height(4.dp))

                // mDNS discovered bridges (show first — WiFi alternatives are primary action during reconnect)
                if (discoveredBridges.isNotEmpty()) {
                    Text(
                        text = if (isReconnecting) "Or connect via WiFi:" else "Discovered",
                        style = MaterialTheme.typography.labelMedium,
                        color = AgentDeckColors.SlateText,
                    )
                    discoveredBridges.forEach { bridge ->
                        OutlinedButton(
                            onClick = { onConnectToBridge(bridge) },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(8.dp),
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(text = bridge.name, color = AgentDeckColors.WhiteText)
                                Text(
                                    text = "${bridge.host}:${bridge.port}",
                                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                    color = AgentDeckColors.SlateText,
                                )
                            }
                        }
                    }
                } else if (!isReconnecting) {
                    Text(
                        text = "Searching for bridges...",
                        style = MaterialTheme.typography.bodySmall,
                        color = AgentDeckColors.SlateText,
                    )
                }

                // USB quick-connect (show below WiFi options during reconnect)
                if (!isReconnecting) {
                    Button(
                        onClick = onConnectLocalhost,
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = AgentDeckColors.Blue),
                        shape = RoundedCornerShape(8.dp),
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.padding(vertical = 4.dp),
                        ) {
                            Text(
                                text = "USB Connect",
                                style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                            )
                            Text(
                                text = BridgeConstants.LOCALHOST_DISPLAY,
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                color = Color.White.copy(alpha = 0.7f),
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(4.dp))

            Text(
                text = "Manual URL entry in Settings",
                style = MaterialTheme.typography.bodySmall,
                color = AgentDeckColors.SlateText.copy(alpha = 0.7f),
                textAlign = TextAlign.Center,
            )
        }
    }
}

/**
 * Full-screen terrarium rendering — extracted from TerrariumScreen.
 * 60fps animation loop with all creatures and environment.
 */
@Composable
private fun ColorTerrariumBackground(
    state: TerrariumState,
    mainCrayfish: CrayfishCreature,
    mainCrayfishCenterXFraction: Float,
    mainCrayfishCenterYFraction: Float,
    drawMainCrayfishInBackground: Boolean = true,
) {
    // Create environment instances
    val waterEffect = remember { WaterEffect() }
    val rockFormation = remember { RockFormation() }
    val kelpField = remember { KelpField() }
    val lightRaySystem = remember { LightRaySystem() }
    val planktonSystem = remember { PlanktonSystem() }
    val waterSurface = remember { WaterSurface() }
    val sandDisturbance = remember { SandDisturbance() }
    val dataParticles = remember { DataParticleSystem() }
    val bubbleSystem = remember { BubbleSystem() }

    // Multi-octopus: project-based clustering layout
    val octopusSlots = layoutOctopusesByProject(
        state.agents.map { AgentLayoutInfo(it.sessionId, it.displayName) }
    )
    val octopuses = remember { mutableStateListOf<OctopusCreature>() }

    LaunchedEffect(state.agents) {
        val targetCount = state.agents.size
        // Add missing creatures
        while (octopuses.size < targetCount) {
            val idx = octopuses.size
            val slot = octopusSlots.getOrElse(idx) { octopusSlots.last() }
            val agent = state.agents.getOrNull(idx)
            octopuses.add(OctopusCreature(
                slot.centerXFraction, slot.centerYFraction, slot.scaleFactor,
                phaseOffset = idx * 1.7f,
                displayName = agent?.displayName,
            ).also {
                if (agent != null) {
                    it.setState(agent.visualState)
                    it.setMark(agent.mark)
                }
                // Wire pop burst callback
                it.onAskingExit = { nx, ny -> bubbleSystem.emitPopBurst(nx, ny) }
            })
        }
        // Remove excess
        while (octopuses.size > targetCount) {
            octopuses.removeAt(octopuses.lastIndex)
        }
        // Update ALL creatures' home positions + states (handles session swap, name change, state change)
        for (i in octopuses.indices) {
            val slot = octopusSlots.getOrElse(i) { octopusSlots.last() }
            octopuses[i].setHomePosition(slot.centerXFraction, slot.centerYFraction, slot.scaleFactor)
            if (i < state.agents.size) {
                octopuses[i].setState(state.agents[i].visualState)
                octopuses[i].setMark(state.agents[i].mark)
                octopuses[i].setDisplayName(
                    state.agents[i].displayName,
                    show = true,
                )
            }
        }
    }

    // Cloud creatures (Codex CLI agents)
    val cloudSlots = layoutCloudCreatures(state.cloudCreatures.size)
    val cloudCreatures = remember { mutableStateListOf<CloudCreature>() }

    LaunchedEffect(state.cloudCreatures) {
        val targetCount = state.cloudCreatures.size
        // Add missing creatures
        while (cloudCreatures.size < targetCount) {
            val idx = cloudCreatures.size
            val slot = cloudSlots.getOrElse(idx) { cloudSlots.last() }
            val agent = state.cloudCreatures.getOrNull(idx)
            cloudCreatures.add(CloudCreature(
                slot.centerXFraction, slot.centerYFraction, slot.scaleFactor,
                phaseOffset = idx * 2.1f,
                displayName = agent?.displayName,
            ).also {
                if (agent != null) it.setState(agent.visualState)
                it.onAskingExit = { nx, ny -> bubbleSystem.emitPopBurst(nx, ny) }
            })
        }
        // Remove excess
        while (cloudCreatures.size > targetCount) {
            cloudCreatures.removeAt(cloudCreatures.lastIndex)
        }
        // Update positions + states
        for (i in cloudCreatures.indices) {
            val slot = cloudSlots.getOrElse(i) { cloudSlots.last() }
            cloudCreatures[i].setHomePosition(slot.centerXFraction, slot.centerYFraction, slot.scaleFactor)
            if (i < state.cloudCreatures.size) {
                cloudCreatures[i].setState(state.cloudCreatures[i].visualState)
                cloudCreatures[i].setDisplayName(
                    state.cloudCreatures[i].displayName,
                    show = true,
                )
            }
        }
    }

    // OpenCode creatures (nested-square logo agents)
    val openCodeSlots = layoutOpenCodeCreatures(state.openCodeCreatures.size)
    val openCodeCreatures = remember { mutableStateListOf<OpenCodeCreature>() }

    LaunchedEffect(state.openCodeCreatures) {
        val targetCount = state.openCodeCreatures.size
        while (openCodeCreatures.size < targetCount) {
            val idx = openCodeCreatures.size
            val slot = openCodeSlots.getOrElse(idx) { openCodeSlots.last() }
            val agent = state.openCodeCreatures.getOrNull(idx)
            openCodeCreatures.add(OpenCodeCreature(
                slot.centerXFraction, slot.centerYFraction, slot.scaleFactor,
                phaseOffset = idx * 1.9f,
                displayName = agent?.displayName,
            ).also {
                if (agent != null) it.setState(agent.visualState)
                it.onAskingExit = { nx, ny -> bubbleSystem.emitPopBurst(nx, ny) }
            })
        }
        while (openCodeCreatures.size > targetCount) {
            openCodeCreatures.removeAt(openCodeCreatures.lastIndex)
        }
        for (i in openCodeCreatures.indices) {
            val slot = openCodeSlots.getOrElse(i) { openCodeSlots.last() }
            openCodeCreatures[i].setHomePosition(slot.centerXFraction, slot.centerYFraction, slot.scaleFactor)
            if (i < state.openCodeCreatures.size) {
                openCodeCreatures[i].setState(state.openCodeCreatures[i].visualState)
                openCodeCreatures[i].setDisplayName(
                    state.openCodeCreatures[i].displayName,
                    show = true,
                )
            }
        }
    }

    // Worker crayfish for multi-agent OpenClaw
    val workerSlots = layoutWorkerCrayfish(
        count = state.workerCrayfishCount,
        mainX = mainCrayfishCenterXFraction,
        mainY = mainCrayfishCenterYFraction,
    )
    val workerCrayfish = remember(mainCrayfishCenterXFraction, mainCrayfishCenterYFraction) {
        mutableStateListOf<CrayfishCreature>()
    }

    LaunchedEffect(state.workerCrayfishCount, mainCrayfishCenterXFraction, mainCrayfishCenterYFraction) {
        while (workerCrayfish.size < state.workerCrayfishCount) {
            val slot = workerSlots.getOrElse(workerCrayfish.size) { workerSlots.last() }
            workerCrayfish.add(CrayfishCreature(slot.centerXFraction, slot.centerYFraction, slot.scaleFactor))
        }
        while (workerCrayfish.size > state.workerCrayfishCount) {
            workerCrayfish.removeAt(workerCrayfish.lastIndex)
        }
    }

    LaunchedEffect(state.crayfish) { mainCrayfish.setState(state.crayfish) }
    LaunchedEffect(state.tetra) { dataParticles.setState(state.tetra) }
    LaunchedEffect(state.agents, octopusSlots) {
        dataParticles.setAgentPositions(octopusSlots, state.agents)
    }
    LaunchedEffect(state.environment) {
        waterEffect.setState(state.environment)
        bubbleSystem.setState(state.environment)
        rockFormation.setState(state.environment)
        lightRaySystem.setState(state.environment)
        planktonSystem.setState(state.environment)
        waterSurface.setState(state.environment)
        sandDisturbance.setState(state.environment)
    }

    // Pre-allocated lists for per-frame position passing (avoids GC pressure)
    val livePositions = remember { mutableListOf<Pair<Float, Float>>() }
    val workingPositions = remember { mutableListOf<Pair<Float, Float>>() }
    val allCreaturePositions = remember { mutableListOf<Pair<Float, Float>>() }

    // Creature bubble exhale timers
    var octoBubbleTimer by remember { mutableFloatStateOf(0f) }
    var crayfishBubbleTimer by remember { mutableFloatStateOf(0f) }
    var cloudBubbleTimer by remember { mutableFloatStateOf(0f) }
    var openCodeBubbleTimer by remember { mutableFloatStateOf(0f) }

    // 60fps animation loop
    var lastFrameTime by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) {
        while (true) {
            withFrameMillis { frameTimeMs ->
                val dt = if (lastFrameTime == 0L) 0f
                else (frameTimeMs - lastFrameTime) / 1000f
                lastFrameTime = frameTimeMs

                val clampedDt = dt.coerceAtMost(0.1f)

                waterEffect.update(clampedDt)
                rockFormation.update(clampedDt)
                kelpField.update(clampedDt)
                lightRaySystem.update(clampedDt)
                planktonSystem.update(clampedDt)
                waterSurface.update(clampedDt)
                mainCrayfish.update(clampedDt)
                for (wc in workerCrayfish) wc.update(clampedDt)
                for (oct in octopuses) oct.update(clampedDt)
                for (cloud in cloudCreatures) cloud.update(clampedDt)
                for (oc in openCodeCreatures) oc.update(clampedDt)
                // Pass live positions + working positions to tetra school (reuse lists)
                livePositions.clear()
                workingPositions.clear()
                allCreaturePositions.clear()
                for (oct in octopuses) {
                    val pos = oct.currentPosition()
                    livePositions.add(pos)
                    if (oct.isWorking()) workingPositions.add(pos)
                    allCreaturePositions.add(pos)
                }
                for (cloud in cloudCreatures) {
                    val pos = cloud.currentPosition()
                    livePositions.add(pos)
                    if (cloud.isWorking()) workingPositions.add(pos)
                    allCreaturePositions.add(pos)
                }
                for (oc in openCodeCreatures) {
                    val pos = oc.currentPosition()
                    livePositions.add(pos)
                    if (oc.isWorking()) workingPositions.add(pos)
                    allCreaturePositions.add(pos)
                }
                // Add crayfish position for sand disturbance
                val crayfishPos = mainCrayfish.currentPosition()
                allCreaturePositions.add(crayfishPos)
                sandDisturbance.setCreaturePositions(allCreaturePositions)
                sandDisturbance.update(clampedDt)

                dataParticles.setLiveAgentPositions(livePositions)
                dataParticles.setWorkingAgentPositions(workingPositions)
                // Pass crayfish position + routing state for food spawning + school attraction
                dataParticles.setCrayfishState(crayfishPos, mainCrayfish.isRouting())
                dataParticles.update(clampedDt)
                bubbleSystem.update(clampedDt)

                // Creature bubble exhales
                octoBubbleTimer += clampedDt
                crayfishBubbleTimer += clampedDt
                cloudBubbleTimer += clampedDt
                openCodeBubbleTimer += clampedDt
                // WORKING octopuses: 2 bubbles every 2.5s
                if (octoBubbleTimer >= 2.5f) {
                    octoBubbleTimer -= 2.5f
                    for (oct in octopuses) {
                        if (oct.isWorking()) {
                            val pos = oct.currentPosition()
                            bubbleSystem.emitCreatureBubbles(pos.first, pos.second, 2)
                        }
                    }
                }
                // ROUTING crayfish: 3 bubbles every 1.5s
                if (crayfishBubbleTimer >= 1.5f) {
                    crayfishBubbleTimer -= 1.5f
                    if (mainCrayfish.isRouting()) {
                        bubbleSystem.emitCreatureBubbles(crayfishPos.first, crayfishPos.second, 3)
                    }
                }
                // WORKING clouds: 1 bubble every 3.0s
                if (cloudBubbleTimer >= 3.0f) {
                    cloudBubbleTimer -= 3.0f
                    for (cloud in cloudCreatures) {
                        if (cloud.isWorking()) {
                            val pos = cloud.currentPosition()
                            bubbleSystem.emitCreatureBubbles(pos.first, pos.second, 1)
                        }
                    }
                }
                // WORKING OpenCode: 1 bubble every 3.5s
                if (openCodeBubbleTimer >= 3.5f) {
                    openCodeBubbleTimer -= 3.5f
                    for (oc in openCodeCreatures) {
                        if (oc.isWorking()) {
                            val pos = oc.currentPosition()
                            bubbleSystem.emitCreatureBubbles(pos.first, pos.second, 1)
                        }
                    }
                }
            }
        }
    }

    ColorTerrariumCanvas(
        state = state,
        waterEffect = waterEffect,
        rockFormation = rockFormation,
        kelpField = kelpField,
        mainCrayfish = mainCrayfish,
        workerCrayfish = workerCrayfish,
        dataParticles = dataParticles,
        octopuses = octopuses,
        cloudCreatures = cloudCreatures,
        openCodeCreatures = openCodeCreatures,
        bubbleSystem = bubbleSystem,
        lightRaySystem = lightRaySystem,
        planktonSystem = planktonSystem,
        waterSurface = waterSurface,
        sandDisturbance = sandDisturbance,
        drawMainCrayfish = drawMainCrayfishInBackground,
        modifier = Modifier.fillMaxSize(),
    )
}

@Composable
private fun OpenClawForegroundLayer(
    mainCrayfish: CrayfishCreature,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier) {
        mainCrayfish.draw(this)
    }
}

/**
 * HUD overlay — semi-transparent panels positioned over the terrarium.
 * Top-left: agent list (logo + sessions + mode badge).
 * Top-right: tank status (aquarium-themed engine panel).
 */
@Composable
private fun MonitorHUD(
    dashState: DashboardState,
    hudHidden: Boolean = false,
    showSessionList: Boolean = true,
    showTopologyRail: Boolean = true,
) {
    val systemBarsPadding = WindowInsets.systemBars.asPaddingValues()
    val scale = rememberMonitorLayoutScale()
    BoxWithConstraints(modifier = Modifier.fillMaxSize().padding(top = systemBarsPadding.calculateTopPadding())) {
        // Tablet-only: mirror the SwiftUI MonitorHUD proportions
        // (`min(width * 0.22, 220)` / `min(width * 0.32, 300)`) so Android
        // tablets do not inflate the dashboard rails into oversized cards.
        val parentWidth = maxWidth
        val sessionPanelWidth = minOf(parentWidth * 0.22f, scale.sessionPanelMaxWidth)
        val topologyPanelWidth = minOf(parentWidth * 0.32f, scale.topologyPanelMaxWidth)
        // Top-left: Agent list (logo + sessions + mode). AnimatedVisibility
        // both fades AND removes from composition when hidden so the
        // collapsed panels stop intercepting any future tap dispatch.
        AnimatedVisibility(
            visible = !hudHidden && showSessionList,
            enter = fadeIn(animationSpec = tween(durationMillis = 250)),
            exit = fadeOut(animationSpec = tween(durationMillis = 250)),
            modifier = Modifier.align(Alignment.TopStart),
        ) {
            SessionListPanel(
                projectName = dashState.projectName,
                agentType = dashState.agentType,
                modelName = dashState.modelName,
                effortLevel = dashState.effortLevel,
                agentState = dashState.agentState,
                sessionId = dashState.sessionId,
                siblingSessions = dashState.siblingSessions,
                workerSessionCount = dashState.workerSessionCount?.takeIf { dashState.gatewayConnected == true },
                permissionMode = dashState.permissionMode,
                scale = scale,
                onFocusSession = { BridgeConnection.instance.sendFocusSession(it) },
                modifier = Modifier
                    .padding(start = scale.panelEdgeInset, top = scale.panelEdgeInset)
                    .then(
                        if (scale.isTablet) Modifier.width(sessionPanelWidth)
                        else Modifier.widthIn(max = scale.sessionPanelMaxWidth)
                    ),
            )
        }

        // Top-right: Relationship-centric topology rail replaces the former
        // TankStatusPanel. Shows upstream providers → AgentDeck hub →
        // downstream devices as a single vertical flow instead of disjoint
        // list boxes.
        AnimatedVisibility(
            visible = !hudHidden && showTopologyRail,
            enter = fadeIn(animationSpec = tween(durationMillis = 250)),
            exit = fadeOut(animationSpec = tween(durationMillis = 250)),
            modifier = Modifier.align(Alignment.TopEnd),
        ) {
            TopologyRail(
                state = dashState,
                scale = scale,
                modifier = Modifier
                    .padding(end = scale.panelEdgeInset, top = scale.panelEdgeInset)
                    .then(
                        if (scale.isTablet) Modifier.width(topologyPanelWidth)
                        else Modifier.widthIn(max = scale.topologyPanelMaxWidth)
                    ),
            )
        }

        // Floating attention theater — renders whatever PromptOption[] the
        // bridge is currently surfacing. E-ink handles the same commands in
        // its readable projection, while this overlay is tablet-focused.
        val awaiting = buildAwaitingList(dashState)
        val featuredSession = awaiting.firstOrNull { it.id == dashState.sessionId } ?: awaiting.firstOrNull()
        if (featuredSession != null) {
            val isFocused = featuredSession.id == dashState.sessionId
            // Gated PreToolUse (observed) sessions carry a requestId but no PTY
            // options — present a fixed Allow/Deny pair and reply via permission_decision.
            val gateRequestId = featuredSession.requestId
            val featured = buildAttentionFeatured(
                session = featuredSession,
                question = featuredSession.question ?: (if (isFocused) dashState.question else null),
                options = if (gateRequestId != null)
                    listOf(
                        PromptOption(label = "Allow", index = 0, shortcut = "y", recommended = true),
                        PromptOption(label = "Deny", index = 1, shortcut = "n"),
                    )
                else if (isFocused) dashState.options else emptyList(),
                promptType = if (isFocused) dashState.promptType else null,
                cursorIndex = if (isFocused) dashState.cursorIndex ?: 0 else 0,
                navigable = if (isFocused) dashState.navigable ?: false else false,
            )
            AttentionTheaterHUD(
                featured = featured,
                queuedCount = (awaiting.size - 1).coerceAtLeast(0),
                onRespond = { index ->
                    if (gateRequestId != null) {
                        BridgeConnection.instance.sendPermissionDecision(gateRequestId, if (index == 0) "allow" else "deny")
                    } else {
                        featured.sessionId?.let { BridgeConnection.instance.sendFocusSession(it) }
                        BridgeConnection.instance.sendSelectOption(index)
                    }
                },
                onFocus = {
                    featured.sessionId?.let { BridgeConnection.instance.sendFocusSession(it) }
                },
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 14.dp),
            )
        }
    }
}

/**
 * Surface every session that's currently in an awaiting_* state, preferring
 * the primary (local) session when its agentType is unique. Mirrors the
 * Swift side's `attentionSessions` list.
 */
private fun buildAwaitingList(state: DashboardState): List<dev.agentdeck.net.SessionInfo> {
    val out = mutableListOf<dev.agentdeck.net.SessionInfo>()

    // Primary session — synthesize a SessionInfo so the theater can share
    // its payload type with the siblings list.
    val primaryAwaits = state.agentState.isAwaiting()
    val primaryAgentType = state.agentType
    if (primaryAwaits && primaryAgentType != null && primaryAgentType != "daemon" &&
        state.siblingSessions.none { it.agentType == primaryAgentType }
    ) {
        out += dev.agentdeck.net.SessionInfo(
            id = state.sessionId ?: "primary",
            port = 0,
            projectName = state.projectName,
            agentType = primaryAgentType,
            alive = true,
            state = state.agentState.wireName(),
            modelName = state.modelName,
        )
    }

    for (session in state.siblingSessions) {
        val s = dev.agentdeck.ui.eink.mapSessionState(session)
        if (s.isAwaiting()) out += session
    }
    return out
}

/** Wire-format the agent state back to its serial string — used when
 * synthesizing a SessionInfo for the primary session from DashboardState.
 */
private fun dev.agentdeck.net.AgentState.wireName(): String = when (this) {
    dev.agentdeck.net.AgentState.AWAITING_PERMISSION -> "awaiting_permission"
    dev.agentdeck.net.AgentState.AWAITING_OPTION -> "awaiting_option"
    dev.agentdeck.net.AgentState.AWAITING_DIFF -> "awaiting_diff"
    dev.agentdeck.net.AgentState.PROCESSING -> "processing"
    dev.agentdeck.net.AgentState.IDLE -> "idle"
    dev.agentdeck.net.AgentState.DISCONNECTED -> "disconnected"
}
