package dev.agentdeck.ui.common

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.net.PairingCodeClient
import dev.agentdeck.net.PairingCodeRules
import dev.agentdeck.ui.theme.AgentDeckColors
import dev.agentdeck.ui.theme.LocalIsEink
import kotlinx.coroutines.launch

// ── Connection-state lexicon ──────────────────────────────────────────
// Kotlin mirror of shared/src/connection-status.ts. Self-connecting clients
// (this app, Apple app, ESP32) surface the phase they are actually in;
// update the TS SSOT and all mirrors together when copy changes.
object ConnectionLexicon {
    const val SEARCHING = "Searching for AgentDeck..."
    const val SEARCHING_COMPACT = "Searching..."
    const val CONNECTING = "Connecting..."
    const val RECONNECTING = "Reconnecting..."
}

// ── Status Badge ──────────────────────────────────────────────────────

@Composable
fun ConnectionStatusBadge(
    connectionStatus: ConnectionStatus,
    currentUrl: String?,
    modifier: Modifier = Modifier,
) {
    val isEink = LocalIsEink.current
    Column(modifier = modifier) {
        Text(
            text = when (connectionStatus) {
                ConnectionStatus.CONNECTED -> "\u25CF Connected"
                ConnectionStatus.CONNECTING -> "\u25CB ${ConnectionLexicon.CONNECTING}"
                ConnectionStatus.DISCONNECTED -> "\u25CB ${ConnectionLexicon.SEARCHING_COMPACT}"
            },
            style = MaterialTheme.typography.bodyMedium,
            color = if (isEink) {
                MaterialTheme.colorScheme.onSurface
            } else {
                when (connectionStatus) {
                    ConnectionStatus.CONNECTED -> AgentDeckColors.Green
                    ConnectionStatus.CONNECTING -> AgentDeckColors.Amber
                    ConnectionStatus.DISCONNECTED -> AgentDeckColors.SlateText
                }
            },
        )
        if (currentUrl != null) {
            Text(
                text = redactedConnectionUrl(currentUrl),
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun redactedConnectionUrl(url: String): String {
    val tokenPrefix = "token="
    val tokenStart = url.indexOf(tokenPrefix)
    if (tokenStart < 0) return url

    val valueStart = tokenStart + tokenPrefix.length
    val valueEnd = url.indexOf('&', startIndex = valueStart).let { end ->
        if (end < 0) url.length else end
    }
    return url.replaceRange(valueStart, valueEnd, "redacted")
}

// ── Error Message ─────────────────────────────────────────────────────

@Composable
fun ConnectionErrorMessage(
    lastError: String?,
    connectionStatus: ConnectionStatus,
    modifier: Modifier = Modifier,
) {
    if (lastError != null && connectionStatus == ConnectionStatus.DISCONNECTED) {
        val isEink = LocalIsEink.current
        Text(
            text = lastError,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = if (isEink) MaterialTheme.colorScheme.onSurfaceVariant else AgentDeckColors.Red,
            modifier = modifier,
        )
    }
}

// ── USB Quick Connect ─────────────────────────────────────────────────

@Composable
fun UsbConnectButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val isEink = LocalIsEink.current
    if (isEink) {
        Surface(
            modifier = modifier.clickable(onClick = onClick),
            shape = RoundedCornerShape(4.dp),
            border = BorderStroke(2.dp, Color.Black),
            color = MaterialTheme.colorScheme.background,
        ) {
            Column(modifier = Modifier.padding(8.dp)) {
                Text(
                    text = "USB (adb reverse)",
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = BridgeConstants.LOCALHOST_DISPLAY,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    } else {
        Button(
            onClick = onClick,
            modifier = modifier.fillMaxWidth(),
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

// ── Discovered Bridge List ────────────────────────────────────────────

@Composable
fun DiscoveredBridgeList(
    bridges: List<DiscoveredBridge>,
    onConnectToBridge: (DiscoveredBridge) -> Unit,
    modifier: Modifier = Modifier,
) {
    val isEink = LocalIsEink.current
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (bridges.isNotEmpty()) {
            Text(
                text = "Discovered",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            bridges.forEach { bridge ->
                if (isEink) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .border(1.dp, Color.DarkGray, RoundedCornerShape(4.dp))
                            .clickable { onConnectToBridge(bridge) }
                            .padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("\u25CF", color = MaterialTheme.colorScheme.onSurface)
                        Column {
                            Text(
                                text = bridge.name,
                                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                text = "${bridge.host}:${bridge.port}",
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                } else {
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
            }
        } else {
            Text(
                text = ConnectionLexicon.SEARCHING,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ── Manual URL Input ──────────────────────────────────────────────────

@Composable
fun ManualUrlInput(
    onConnect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val isEink = LocalIsEink.current
    var urlInput by remember { mutableStateOf("") }
    val doConnect = {
        if (urlInput.isNotBlank()) {
            val url = if (urlInput.startsWith("ws://")) urlInput else "ws://$urlInput"
            onConnect(url)
        }
    }

    if (isEink) {
        Row(
            modifier = modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = urlInput,
                onValueChange = { urlInput = it },
                placeholder = {
                    Text("192.168.1.5:9120", style = MaterialTheme.typography.bodySmall)
                },
                modifier = Modifier.weight(1f),
                singleLine = true,
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { doConnect() }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Color.Black,
                    unfocusedBorderColor = Color.DarkGray,
                    cursorColor = Color.Black,
                ),
            )
            Button(
                onClick = { doConnect() },
                enabled = urlInput.isNotBlank(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color.Black,
                    contentColor = Color.White,
                ),
                shape = RoundedCornerShape(4.dp),
            ) {
                Text("Connect")
            }
        }
    } else {
        Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            OutlinedTextField(
                value = urlInput,
                onValueChange = { urlInput = it },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("ws://192.168.1.x:9120?token=abc") },
                singleLine = true,
                label = { Text("Manual URL") },
            )
            Button(
                onClick = { doConnect() },
                modifier = Modifier.fillMaxWidth(),
                enabled = urlInput.isNotBlank(),
            ) {
                Text("Connect")
            }
        }
    }
}

// ── Disconnect Button ─────────────────────────────────────────────────

@Composable
fun DisconnectButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val isEink = LocalIsEink.current
    if (isEink) {
        OutlinedButton(
            onClick = onClick,
            modifier = modifier.fillMaxWidth(),
            shape = RoundedCornerShape(4.dp),
            border = BorderStroke(1.dp, Color.Black),
        ) {
            Text("Disconnect", color = Color.Black)
        }
    } else {
        OutlinedButton(
            onClick = onClick,
            modifier = modifier,
        ) {
            Text("Disconnect")
        }
    }
}

// ── Pairing code ──────────────────────────────────────────────────────

/**
 * Redeem an operator-issued pairing code for this daemon's token.
 *
 * The pairing path for a reader with no camera and no cable. Everything above
 * this input either needs a camera (the QR flow this app has never had), a USB
 * tunnel (`adb reverse`, which dies on reboot), or a 32-hex-character URL typed
 * on an e-ink keyboard. Six digits is the thing a person can actually do.
 *
 * Deliberately only offered when mDNS has found a daemon: the code is worthless
 * without an endpoint to spend it at, and asking for both a code and a host is
 * the two-field form this exists to replace.
 */
@Composable
fun PairingCodeInput(
    bridges: List<DiscoveredBridge>,
    onPaired: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val isEink = LocalIsEink.current
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }

    // The daemon hub is the only thing that serves external clients, and the
    // canonical port is preferred but not required — it legitimately falls back
    // to 9121+ when something else won the port.
    val daemon = remember(bridges) {
        val daemons = bridges.filter { it.agentType == "daemon" }
        daemons.firstOrNull { it.port == BridgeConstants.WS_PORT } ?: daemons.firstOrNull()
    }
    if (daemon == null) return

    val ready = PairingCodeRules.normalize(code) != null && !busy
    val submit = submit@{
        if (!ready) return@submit
        busy = true
        message = null
        scope.launch {
            val result = PairingCodeClient.redeem(daemon, code)
            busy = false
            when (result) {
                is PairingCodeClient.Result.Paired -> {
                    code = ""
                    message = "Paired with ${daemon.name}."
                    onPaired(result.wsUrl)
                }
                is PairingCodeClient.Result.WrongCode -> {
                    message = if (result.attemptsRemaining >= 0) {
                        "Wrong code — ${result.attemptsRemaining} tries left."
                    } else {
                        "Wrong code."
                    }
                }
                // The daemon answers these two identically on the wire so a
                // closed daemon cannot be probed for "is someone pairing"; the
                // copy here is what turns that into something actionable.
                PairingCodeClient.Result.NoWindow ->
                    message = "No pairing window. Run \"agentdeck pair\" on your Mac."
                PairingCodeClient.Result.WindowClosed ->
                    message = "That window closed. Run \"agentdeck pair\" again."
                is PairingCodeClient.Result.Unreachable ->
                    message = "Could not reach ${daemon.name}: ${result.detail}"
            }
        }
    }

    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = "Pair with a code — run \"agentdeck pair\" on your Mac",
            style = MaterialTheme.typography.bodySmall,
            color = if (isEink) Color.DarkGray else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = code,
                onValueChange = { typed ->
                    // Digits only, capped at the code length: on a reader the
                    // keyboard is slow and the undo is worse, so the field
                    // refuses what cannot be a code rather than spending one of
                    // the operator's five attempts finding out.
                    code = typed.filter { it.isDigit() }.take(PairingCodeRules.DIGITS)
                },
                placeholder = { Text("000000", style = MaterialTheme.typography.bodySmall) },
                modifier = Modifier.weight(1f),
                singleLine = true,
                enabled = !busy,
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.NumberPassword,
                    imeAction = ImeAction.Go,
                ),
                keyboardActions = KeyboardActions(onGo = { submit() }),
                colors = if (isEink) {
                    OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Color.Black,
                        unfocusedBorderColor = Color.DarkGray,
                        cursorColor = Color.Black,
                    )
                } else {
                    OutlinedTextFieldDefaults.colors()
                },
            )
            Button(
                onClick = { submit() },
                enabled = ready,
                colors = if (isEink) {
                    ButtonDefaults.buttonColors(containerColor = Color.Black, contentColor = Color.White)
                } else {
                    ButtonDefaults.buttonColors()
                },
                shape = RoundedCornerShape(4.dp),
            ) {
                Text(if (busy) "Pairing..." else "Pair")
            }
        }
        message?.let { text ->
            Text(
                text = text,
                style = MaterialTheme.typography.bodySmall,
                color = if (isEink) Color.Black else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ── Connection Panel (composite) ──────────────────────────────────────

/**
 * Complete connection management panel — status, error, USB connect,
 * mDNS bridges, pairing code, manual URL input, and disconnect.
 * Automatically adapts to e-ink/tablet theme via LocalIsEink.
 *
 * @param onPaired called with a `ws://host:port?token=…` URL once a pairing code
 *   has been redeemed. Null hides the pairing-code section — a caller that
 *   cannot persist the credential must not offer a flow whose result it drops.
 */
@Composable
fun ConnectionPanel(
    connectionStatus: ConnectionStatus,
    currentUrl: String?,
    lastError: String?,
    discoveredBridges: List<DiscoveredBridge>,
    onConnectToBridge: (DiscoveredBridge) -> Unit,
    onConnectLocalhost: () -> Unit,
    onConnectManualUrl: (String) -> Unit,
    onDisconnect: () -> Unit,
    modifier: Modifier = Modifier,
    onPaired: ((String) -> Unit)? = null,
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        ConnectionStatusBadge(
            connectionStatus = connectionStatus,
            currentUrl = currentUrl,
        )

        ConnectionErrorMessage(
            lastError = lastError,
            connectionStatus = connectionStatus,
        )

        if (connectionStatus == ConnectionStatus.CONNECTED) {
            DisconnectButton(onClick = onDisconnect)
        }

        if (connectionStatus == ConnectionStatus.DISCONNECTED) {
            UsbConnectButton(onClick = onConnectLocalhost)

            DiscoveredBridgeList(
                bridges = discoveredBridges,
                onConnectToBridge = onConnectToBridge,
            )

            if (onPaired != null) {
                PairingCodeInput(
                    bridges = discoveredBridges,
                    onPaired = onPaired,
                )
            }

            ManualUrlInput(onConnect = onConnectManualUrl)
        }

        if (connectionStatus == ConnectionStatus.CONNECTING) {
            Text(
                text = "Trying to reach bridge...",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
