package dev.agentdeck.net

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BridgeConnectionInputTest {
    @Test fun `malformed manual endpoints never start a connection or latch CONNECTING`() {
        val connection = BridgeConnection()
        for (url in listOf("ws://192.168.1.5:abc", "ws://192.168.1.5:99999", "ws://:9120", "file:///tmp/socket", "http://192.168.1.5:9120")) {
            connection.connect(url)
            assertEquals(ConnectionStatus.DISCONNECTED, connection.status.value)
            assertNull(connection.url.value)
            assertNull(connection.selectedUrl)
            assertNotNull(connection.lastError.value)
            assertFalse(connection.isReconnecting.value)
        }
        connection.disconnect()
    }

    @Test fun `invalid fallback cannot replace selected endpoint state`() {
        val connection = BridgeConnection()
        connection.selectedUrl = "ws://saved.example:9120"
        connection.connect("ws://192.0.2.1:9120", "ws://192.0.2.2:no-port")
        assertEquals("ws://saved.example:9120", connection.selectedUrl)
        assertEquals(ConnectionStatus.DISCONNECTED, connection.status.value)
        assertNotNull(connection.lastError.value)
        connection.disconnect()
    }
}
