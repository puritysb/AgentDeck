package dev.agentdeck.net

import dev.agentdeck.ui.common.ConnectionLexicon
import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionPresentationTest {
    @Test fun `discovered hosts ask for selection instead of claiming a search`() {
        assertEquals(ConnectionLexicon.CHOOSE_HOST,
            ConnectionLexicon.statusText(ConnectionStatus.DISCONNECTED, hasDiscoveredHosts = true))
    }

    @Test fun `approval and network failures have distinct terminal states`() {
        assertEquals(ConnectionLexicon.APPROVAL_REQUIRED,
            ConnectionLexicon.statusText(ConnectionStatus.DISCONNECTED, PairingCredential.approvalMessage("ws://a.local:9120"), true))
        assertEquals(ConnectionLexicon.UNREACHABLE,
            ConnectionLexicon.statusText(ConnectionStatus.DISCONNECTED, "Bridge not found", true))
    }

    @Test fun `an active retry outranks a previous failure`() {
        assertEquals(ConnectionLexicon.CONNECTING,
            ConnectionLexicon.statusText(ConnectionStatus.CONNECTING, "Bridge not found"))
        assertEquals(ConnectionLexicon.RECONNECTING,
            ConnectionLexicon.statusText(ConnectionStatus.DISCONNECTED, "Bridge not found", isReconnecting = true))
    }
}
