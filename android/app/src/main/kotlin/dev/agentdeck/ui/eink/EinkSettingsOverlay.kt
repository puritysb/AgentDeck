package dev.agentdeck.ui.eink

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.agentdeck.data.DashboardOrientation
import dev.agentdeck.ui.screen.PANEL_OVERRIDE_HELP
import dev.agentdeck.ui.screen.deviceCaveatCopy
import dev.agentdeck.ui.screen.panelOverrideLabel
import dev.agentdeck.ui.theme.LocalDeviceProfile
import dev.agentdeck.util.PanelOverride
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.state.DashboardState
import dev.agentdeck.ui.common.ConnectionPanel
import kotlinx.coroutines.launch

@Composable
fun EinkSettingsOverlay(
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    dashState: DashboardState,
    discoveredBridges: List<DiscoveredBridge> = emptyList(),
    onDismiss: () -> Unit,
) {
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    val lastError by connection.lastError.collectAsState()
    val currentOrientation by displayPrefs.orientationFlow.collectAsState(
        initial = DashboardOrientation.defaultFor(isEink = true)
    )
    val panelOverride by displayPrefs.panelOverrideFlow.collectAsState(initial = PanelOverride.Auto)
    val deviceProfile = LocalDeviceProfile.current
    val keepAwake by displayPrefs.keepAwakeFlow.collectAsState(initial = true)
    val displaySyncEnabled by displayPrefs.displaySyncEnabledFlow.collectAsState(initial = true)
    val idleTimeoutMinutes by displayPrefs.idleTimeoutMinutesFlow.collectAsState(initial = 5)
    val showSessionList by displayPrefs.showSessionListFlow.collectAsState(initial = true)
    val showTankStatus by displayPrefs.showTankStatusFlow.collectAsState(initial = true)
    val showDeviceDiagnostic by displayPrefs.showDeviceDiagnosticFlow.collectAsState(initial = true)
    val showTimeline by displayPrefs.showTimelineFlow.collectAsState(initial = true)
    val showSettingsButton by displayPrefs.showSettingsButtonFlow.collectAsState(initial = true)
    val scope = rememberCoroutineScope()

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            shape = RoundedCornerShape(4.dp),
            color = MaterialTheme.colorScheme.background,
            modifier = Modifier
                .fillMaxWidth(0.85f)
                .fillMaxHeight(0.9f)
                .border(2.dp, Color.Black, RoundedCornerShape(4.dp)),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "Settings",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                )

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                SectionTitle(
                    title = "Connection",
                    subtitle = "How this device pairs with your Mac. mDNS auto-discovery and manual URL.",
                )
                ConnectionPanel(
                    connectionStatus = connectionStatus,
                    currentUrl = currentUrl,
                    lastError = lastError,
                    discoveredBridges = discoveredBridges,
                    onConnectToBridge = { bridge -> connection.connect(bridge.wsUrl(), bridge.fallbackWsUrl()) },
                    onConnectLocalhost = { connection.connect(BridgeConstants.LOCALHOST_WS_URL) },
                    onConnectManualUrl = { url -> connection.connect(url) },
                    onDisconnect = {
                        connection.disconnect()
                        scope.launch { displayPrefs.setLastBridgeUrl(null) }
                    },
                )

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                SectionTitle(
                    title = "Mac integrations",
                    subtitle = "Status only. Set these up in AgentDeck on your Mac.",
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

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                SectionTitle(
                    title = "Display panels",
                    subtitle = "Choose which sections of the dashboard appear.",
                )
                EinkSwitchRow("Session list", showSessionList) {
                    scope.launch { displayPrefs.setShowSessionList(it) }
                }
                EinkSwitchRow("Tank status", showTankStatus) {
                    scope.launch { displayPrefs.setShowTankStatus(it) }
                }
                EinkSwitchRow("Device diagnostic", showDeviceDiagnostic) {
                    scope.launch { displayPrefs.setShowDeviceDiagnostic(it) }
                }
                EinkSwitchRow("Timeline strip", showTimeline) {
                    scope.launch { displayPrefs.setShowTimeline(it) }
                }
                EinkSwitchRow("Settings button", showSettingsButton) {
                    scope.launch { displayPrefs.setShowSettingsButton(it) }
                }

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                SectionTitle(title = "Display")
                EinkSwitchRow(
                    label = "Keep Dashboard Active",
                    checked = keepAwake,
                    detail = "Prevents screen sleep and keeps the bridge connection alive.",
                    onCheckedChange = { scope.launch { displayPrefs.setKeepAwake(it) } },
                )
                EinkSwitchRow(
                    label = "Sync with Host Display",
                    checked = displaySyncEnabled,
                    detail = "Dim when the host sleeps; restore on wake.",
                    onCheckedChange = { scope.launch { displayPrefs.setDisplaySyncEnabled(it) } },
                )
                if (displaySyncEnabled) {
                    Text(
                        text = "Idle timeout: $idleTimeoutMinutes min",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        listOf(1, 5, 15, 30).forEach { minutes ->
                            SegmentOption(
                                label = "${minutes}m",
                                selected = idleTimeoutMinutes == minutes,
                                onClick = { scope.launch { displayPrefs.setIdleTimeoutMinutes(minutes) } },
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                SectionTitle(title = "Orientation")
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    SegmentOption(
                        label = "Portrait",
                        selected = currentOrientation == DashboardOrientation.Portrait,
                        onClick = {
                            scope.launch { displayPrefs.setOrientation(DashboardOrientation.Portrait) }
                        },
                        modifier = Modifier.weight(1f),
                    )
                    SegmentOption(
                        label = "Landscape",
                        selected = currentOrientation == DashboardOrientation.Landscape,
                        onClick = {
                            scope.launch { displayPrefs.setOrientation(DashboardOrientation.Landscape) }
                        },
                        modifier = Modifier.weight(1f),
                    )
                    SegmentOption(
                        label = "Auto",
                        selected = DashboardOrientation.isAuto(currentOrientation),
                        onClick = {
                            scope.launch { displayPrefs.setOrientation(DashboardOrientation.Auto) }
                        },
                        modifier = Modifier.weight(1f),
                    )
                }

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                SectionTitle(
                    title = "Display panel",
                    subtitle = deviceProfile.describe(),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    PanelOverride.entries.forEach { option ->
                        SegmentOption(
                            label = panelOverrideLabel(option),
                            selected = panelOverride == option,
                            onClick = { scope.launch { displayPrefs.setPanelOverride(option) } },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                Text(
                    text = PANEL_OVERRIDE_HELP,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                deviceProfile.caveats.forEach { caveat ->
                    Text(
                        text = "- ${deviceCaveatCopy(caveat)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                Spacer(modifier = Modifier.height(2.dp))

                Text(
                    text = "AgentDeck Android - Monitoring dashboard for AI coding agents",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Button(
                    onClick = onDismiss,
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color.Black,
                        contentColor = Color.White,
                    ),
                    shape = RoundedCornerShape(4.dp),
                ) {
                    Text("Close")
                }
            }
        }
    }
}

@Composable
private fun SectionTitle(
    title: String,
    subtitle: String? = null,
) {
    Text(
        text = title,
        style = MaterialTheme.typography.bodyLarge,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.onSurface,
    )
    if (subtitle != null) {
        Text(
            text = subtitle,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun EinkSwitchRow(
    label: String,
    checked: Boolean,
    detail: String? = null,
    onCheckedChange: (Boolean) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Switch(
                checked = checked,
                onCheckedChange = onCheckedChange,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = Color.White,
                    checkedTrackColor = Color.Black,
                    uncheckedThumbColor = Color.DarkGray,
                    uncheckedTrackColor = Color.LightGray,
                ),
            )
        }
        if (detail != null) {
            Text(
                text = detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
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
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text = status,
            style = MaterialTheme.typography.bodySmall,
            color = if (ok) Color.Black else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SegmentOption(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.clickable(onClick = onClick),
        shape = RoundedCornerShape(4.dp),
        color = if (selected) Color.Black else MaterialTheme.colorScheme.background,
        border = BorderStroke(
            1.dp,
            if (selected) Color.Black else Color.DarkGray,
        ),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = if (selected) Color.White else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
        )
    }
}
