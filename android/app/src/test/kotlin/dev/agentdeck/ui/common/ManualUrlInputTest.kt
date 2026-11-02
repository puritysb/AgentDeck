package dev.agentdeck.ui.common

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.ui.theme.LocalIsEink
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [33], qualifiers = "w600dp-h900dp-mdpi")
class ManualUrlInputTest {
    @get:Rule val compose = createComposeRule()

    @Test fun `button and keyboard reject invalid addresses on LCD and e-ink`() {
        val connection = BridgeConnection()
        val eink = mutableStateOf(false)
        var calls = 0
        compose.setContent {
            CompositionLocalProvider(LocalIsEink provides eink.value) {
                MaterialTheme { ManualUrlInput(onConnect = { calls++; connection.connect(it) }) }
            }
        }
        for (isEink in listOf(false, true)) {
            compose.runOnIdle { eink.value = isEink }
            for (input in listOf("192.168.1.5:abc", "192.168.1.5:99999", ":9120")) {
                compose.onNode(hasSetTextAction()).performTextReplacement(input)
                compose.onNodeWithText("Connect").performClick()
                compose.runOnIdle {
                    assertEquals(ConnectionStatus.DISCONNECTED, connection.status.value)
                    assertNotNull(connection.lastError.value)
                }
                compose.onNode(hasSetTextAction()).performImeAction()
                compose.runOnIdle {
                    assertEquals(ConnectionStatus.DISCONNECTED, connection.status.value)
                    assertNotNull(connection.lastError.value)
                }
            }
        }
        assertEquals(12, calls)
        connection.disconnect()
    }

    @Test fun `manual input preserves secure WebSocket schemes and trims whitespace`() {
        val received = mutableListOf<String>()
        compose.setContent { MaterialTheme { ManualUrlInput(onConnect = { received.add(it) }) } }
        compose.onNode(hasSetTextAction()).performTextReplacement("  wss://example.test:9443  ")
        compose.onNodeWithText("Connect").performClick()
        assertEquals(listOf("wss://example.test:9443"), received)
    }
}
