package dev.agentdeck.ui.screen

import android.content.res.Configuration
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.BridgeDiscovery
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.ui.common.ConnectionPanel
import dev.agentdeck.util.EinkDetector
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    isEink: Boolean,
) {
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    val lastError by connection.lastError.collectAsState()
    val keepAwake by displayPrefs.keepAwakeFlow.collectAsState(initial = true)
    val displaySyncEnabled by displayPrefs.displaySyncEnabledFlow.collectAsState(initial = true)
    val idleTimeoutMinutes by displayPrefs.idleTimeoutMinutesFlow.collectAsState(initial = 5)
    val coroutineScope = rememberCoroutineScope()

    var discoveredBridges by remember { mutableStateOf(emptyList<DiscoveredBridge>()) }

    // mDNS discovery when disconnected
    val context = LocalContext.current
    val discovery = remember { BridgeDiscovery(context) }
    LaunchedEffect(connectionStatus) {
        if (connectionStatus == ConnectionStatus.DISCONNECTED) {
            discovery.discover().collect { bridges ->
                discoveredBridges = bridges
            }
        }
    }

    val isLandscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE

    if (isLandscape) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Left: Connection
            Card(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight(),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Connection",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
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
                    )
                }
            }

            // Right: Settings + About
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight(),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = "Settings",
                    style = MaterialTheme.typography.headlineMedium,
                )
                DisplaySettingsCard(keepAwake, displaySyncEnabled, idleTimeoutMinutes, coroutineScope, displayPrefs)
                Spacer(modifier = Modifier.weight(1f))
                AboutFooter()
            }
        }
    } else {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "Settings",
                style = MaterialTheme.typography.headlineMedium,
            )

            // Connection
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Connection",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
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
                    )
                }
            }

            DisplaySettingsCard(keepAwake, displaySyncEnabled, idleTimeoutMinutes, coroutineScope, displayPrefs)

            Spacer(modifier = Modifier.weight(1f))
            AboutFooter()
        }
    }
}

@Composable
internal fun DisplaySettingsCard(
    keepAwake: Boolean,
    displaySyncEnabled: Boolean,
    idleTimeoutMinutes: Int,
    coroutineScope: CoroutineScope,
    displayPrefs: DisplayPreferences,
) {
    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = "Display",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Keep Dashboard Active",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Switch(
                    checked = keepAwake,
                    onCheckedChange = {
                        coroutineScope.launch { displayPrefs.setKeepAwake(it) }
                    },
                )
            }
            Text(
                text = "Prevents screen sleep and maintains connection in background",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(modifier = Modifier.height(12.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Sync with Host Display",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Switch(
                    checked = displaySyncEnabled,
                    onCheckedChange = {
                        coroutineScope.launch { displayPrefs.setDisplaySyncEnabled(it) }
                    },
                )
            }
            Text(
                text = "Dim display when host monitor sleeps, restore on wake",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            // WRITE_SETTINGS permission warning (LCD tablets only)
            if (displaySyncEnabled && !EinkDetector.isEinkDevice()) {
                val context = LocalContext.current
                val canWrite = remember { mutableStateOf(Settings.System.canWrite(context)) }
                if (!canWrite.value) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "⚠ Requires 'Modify system settings' permission",
                            style = MaterialTheme.typography.bodySmall,
                            color = Color(0xFFFFA726),
                            modifier = Modifier.weight(1f),
                        )
                        androidx.compose.material3.TextButton(
                            onClick = {
                                val intent = Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS).apply {
                                    data = Uri.parse("package:${context.packageName}")
                                }
                                context.startActivity(intent)
                            },
                        ) {
                            Text("Grant", color = Color(0xFF3B82F6))
                        }
                    }
                }
            }

            if (displaySyncEnabled) {
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = "Idle Timeout: ${idleTimeoutMinutes} min",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Slider(
                    value = idleTimeoutMinutes.toFloat(),
                    onValueChange = { value ->
                        coroutineScope.launch { displayPrefs.setIdleTimeoutMinutes(value.toInt()) }
                    },
                    valueRange = 1f..30f,
                    steps = 28,
                )
                Text(
                    text = "Dim display after this period when bridge is disconnected",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
internal fun AboutFooter() {
    Text(
        text = "AgentDeck Android \u00B7 v0.2.3 \u00B7 Monitoring dashboard for AI coding agents",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
