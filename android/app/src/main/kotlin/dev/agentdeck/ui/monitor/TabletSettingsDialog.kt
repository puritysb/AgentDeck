package dev.agentdeck.ui.monitor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.agentdeck.data.DashboardOrientation
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.BridgeDiscovery
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.net.adoptPairedUrl
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.ui.common.ConnectionPanel
import dev.agentdeck.ui.screen.AboutFooter
import dev.agentdeck.ui.screen.DeviceProfileCard
import dev.agentdeck.ui.screen.DisplaySettingsCard
import dev.agentdeck.ui.theme.LocalDeviceProfile
import dev.agentdeck.util.PanelOverride
import kotlinx.coroutines.launch

@Composable
fun TabletSettingsDialog(
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    onDismiss: () -> Unit,
) {
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    val lastError by connection.lastError.collectAsState()
    val keepAwake by displayPrefs.keepAwakeFlow.collectAsState(initial = true)
    val displaySyncEnabled by displayPrefs.displaySyncEnabledFlow.collectAsState(initial = true)
    val idleTimeoutMinutes by displayPrefs.idleTimeoutMinutesFlow.collectAsState(initial = 5)
    val showSessionList by displayPrefs.showSessionListFlow.collectAsState(initial = true)
    val showTankStatus by displayPrefs.showTankStatusFlow.collectAsState(initial = true)
    val showDeviceDiagnostic by displayPrefs.showDeviceDiagnosticFlow.collectAsState(initial = true)
    val showTimeline by displayPrefs.showTimelineFlow.collectAsState(initial = true)
    val showSettingsButton by displayPrefs.showSettingsButtonFlow.collectAsState(initial = true)
    val currentOrientation by displayPrefs.orientationFlow.collectAsState(
        initial = DashboardOrientation.defaultFor(isEink = false)
    )
    val panelOverride by displayPrefs.panelOverrideFlow.collectAsState(initial = PanelOverride.Auto)
    val dashState by AgentStateHolder.instance.state.collectAsState()
    val coroutineScope = rememberCoroutineScope()

    var discoveredBridges by remember { mutableStateOf(emptyList<DiscoveredBridge>()) }

    val context = LocalContext.current
    val discovery = remember { BridgeDiscovery(context) }
    LaunchedEffect(connectionStatus) {
        if (connectionStatus == ConnectionStatus.DISCONNECTED) {
            discovery.discover().collect { bridges ->
                discoveredBridges = bridges
            }
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.85f),
            color = Color(0xE61E293B),
            shape = RoundedCornerShape(16.dp),
        ) {
            Column(
                modifier = Modifier
                    .padding(24.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = "Settings",
                    style = MaterialTheme.typography.headlineSmall,
                    color = Color.White,
                )

                // Connection section. Subtitle mirrors the iOS
                // settingsCard(subtitle:) tone so first-run users on
                // tablet read the same "this is how this device pairs
                // with your Mac" framing they'd see on iPad.
                Card(
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF334155)),
                ) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text(
                            text = "Connection",
                            style = MaterialTheme.typography.titleMedium,
                            color = Color(0xFF94A3B8),
                        )
                        Text(
                            text = "How this device pairs with your Mac. mDNS auto-discovery + manual URL.",
                            style = MaterialTheme.typography.bodySmall,
                            color = Color(0xFF94A3B8).copy(alpha = 0.75f),
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        ConnectionPanel(
                            connectionStatus = connectionStatus,
                            currentUrl = currentUrl,
                            lastError = lastError,
                            discoveredBridges = discoveredBridges,
                            onConnectToBridge = { bridge -> connection.connect(bridge.wsUrl(), bridge.fallbackWsUrl()) },
                            onConnectLocalhost = { connection.connect(BridgeConstants.LOCALHOST_WS_URL) },
                            onConnectManualUrl = { url -> connection.connect(url) },
                            onDisconnect = { connection.disconnect() },
                            onPaired = { url ->
                                coroutineScope.launch { adoptPairedUrl(connection, displayPrefs, url) }
                            },
                        )
                    }
                }

                MacIntegrationsReadOnlyCard(dashState = dashState)

                DashboardPanelsCard(
                    showSessionList = showSessionList,
                    showTankStatus = showTankStatus,
                    showDeviceDiagnostic = showDeviceDiagnostic,
                    showTimeline = showTimeline,
                    showSettingsButton = showSettingsButton,
                    displayPrefs = displayPrefs,
                    coroutineScope = coroutineScope,
                )

                // Display section
                DisplaySettingsCard(
                    keepAwake = keepAwake,
                    displaySyncEnabled = displaySyncEnabled,
                    idleTimeoutMinutes = idleTimeoutMinutes,
                    coroutineScope = coroutineScope,
                    displayPrefs = displayPrefs,
                )

                DashboardOrientationCard(
                    currentOrientation = currentOrientation,
                    displayPrefs = displayPrefs,
                    coroutineScope = coroutineScope,
                )

                // Resolved device class + the panel override. Also where a
                // Limited-support caveat (no touchscreen, head unit) is stated.
                DeviceProfileCard(
                    profile = LocalDeviceProfile.current,
                    override = panelOverride,
                    onOverrideChange = { option ->
                        coroutineScope.launch { displayPrefs.setPanelOverride(option) }
                    },
                )

                // About
                AboutFooter()

                // Close button
                Button(
                    onClick = onDismiss,
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF475569)),
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Text("Close", color = Color.White)
                }
            }
        }
    }
}

@Composable
private fun DashboardOrientationCard(
    currentOrientation: Int,
    displayPrefs: DisplayPreferences,
    coroutineScope: kotlinx.coroutines.CoroutineScope,
) {
    Card(
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFF334155)),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = "Orientation",
                style = MaterialTheme.typography.titleMedium,
                color = Color(0xFF94A3B8),
            )
            Text(
                text = "Use Auto for normal tablet rotation, or pin the dashboard when the device rotation lock is on.",
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xFF94A3B8).copy(alpha = 0.75f),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                DashboardOrientationOption(
                    label = "Auto",
                    selected = DashboardOrientation.isAuto(currentOrientation),
                    onClick = {
                        coroutineScope.launch { displayPrefs.setOrientation(DashboardOrientation.Auto) }
                    },
                    modifier = Modifier.weight(1f),
                )
                DashboardOrientationOption(
                    label = "Portrait",
                    selected = currentOrientation == DashboardOrientation.Portrait,
                    onClick = {
                        coroutineScope.launch { displayPrefs.setOrientation(DashboardOrientation.Portrait) }
                    },
                    modifier = Modifier.weight(1f),
                )
                DashboardOrientationOption(
                    label = "Landscape",
                    selected = currentOrientation == DashboardOrientation.Landscape,
                    onClick = {
                        coroutineScope.launch { displayPrefs.setOrientation(DashboardOrientation.Landscape) }
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun DashboardOrientationOption(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.clickable(onClick = onClick),
        shape = RoundedCornerShape(8.dp),
        color = if (selected) Color(0xFF64748B) else Color(0xFF1E293B),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) Color(0xFFCBD5E1) else Color(0xFF475569),
        ),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
            color = Color.White,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun MacIntegrationsReadOnlyCard(dashState: DashboardState) {
    Card(
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFF334155)),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = "Mac integrations",
                style = MaterialTheme.typography.titleMedium,
                color = Color(0xFF94A3B8),
            )
            Text(
                text = "Status only. Set these up in AgentDeck on your Mac.",
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xFF94A3B8).copy(alpha = 0.75f),
            )
            IntegrationStatusRow(
                label = "Claude",
                status = when (dashState.oauthConnected) {
                    true -> "Connected"
                    false -> "Not connected"
                    null -> "Unknown"
                },
                ok = dashState.oauthConnected == true,
            )
            IntegrationStatusRow(
                label = "Codex",
                status = when (dashState.usage.codexWebAuthConnected) {
                    true -> dashState.usage.codexPlanType ?: "Connected"
                    false -> "Not connected"
                    null -> dashState.usage.codexAuthMode ?: "Unknown"
                },
                ok = dashState.usage.codexWebAuthConnected == true,
            )
            IntegrationStatusRow(
                label = "OpenClaw",
                status = when {
                    dashState.gatewayHasError == true -> "Error"
                    dashState.gatewayConnected == true -> "Connected"
                    dashState.gatewayAvailable == true -> "Available"
                    else -> "Not available"
                },
                ok = dashState.gatewayConnected == true,
            )
            IntegrationStatusRow(
                label = "Ollama",
                status = when {
                    dashState.ollamaStatus?.available == true -> "Available"
                    dashState.ollamaStatus != null -> "Stopped"
                    else -> "Unknown"
                },
                ok = dashState.ollamaStatus?.available == true,
            )
        }
    }
}

@Composable
private fun DashboardPanelsCard(
    showSessionList: Boolean,
    showTankStatus: Boolean,
    showDeviceDiagnostic: Boolean,
    showTimeline: Boolean,
    showSettingsButton: Boolean,
    displayPrefs: DisplayPreferences,
    coroutineScope: kotlinx.coroutines.CoroutineScope,
) {
    Card(
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFF334155)),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = "Display panels",
                style = MaterialTheme.typography.titleMedium,
                color = Color(0xFF94A3B8),
            )
            Text(
                text = "Choose which sections of the dashboard appear.",
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xFF94A3B8).copy(alpha = 0.75f),
            )
            DashboardPanelToggle("Session list", showSessionList) {
                coroutineScope.launch { displayPrefs.setShowSessionList(it) }
            }
            DashboardPanelToggle("Tank status", showTankStatus) {
                coroutineScope.launch { displayPrefs.setShowTankStatus(it) }
            }
            DashboardPanelToggle("Device diagnostic", showDeviceDiagnostic) {
                coroutineScope.launch { displayPrefs.setShowDeviceDiagnostic(it) }
            }
            DashboardPanelToggle("Timeline strip", showTimeline) {
                coroutineScope.launch { displayPrefs.setShowTimeline(it) }
            }
            DashboardPanelToggle("Settings button", showSettingsButton) {
                coroutineScope.launch { displayPrefs.setShowSettingsButton(it) }
            }
        }
    }
}

@Composable
private fun DashboardPanelToggle(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = Color.White,
        )
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
        )
    }
}

@Composable
private fun IntegrationStatusRow(
    label: String,
    status: String,
    ok: Boolean,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
            color = Color.White,
        )
        Text(
            text = status,
            style = MaterialTheme.typography.bodySmall,
            color = if (ok) Color(0xFF22C55E) else Color(0xFF94A3B8),
        )
    }
}
