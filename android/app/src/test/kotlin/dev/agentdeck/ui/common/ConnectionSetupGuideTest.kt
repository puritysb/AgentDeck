package dev.agentdeck.ui.common

import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionSetupGuideTest {
    @Test
    fun `disconnected guidance states the host prerequisite and both setup paths`() {
        assertTrue(ConnectionSetupGuide.REQUIRED.contains("computer"))
        assertTrue(ConnectionSetupGuide.MAC.contains("AgentDeck Dashboard"))
        assertTrue(ConnectionSetupGuide.CLI.contains("npx @agentdeck/setup"))
        assertTrue(ConnectionSetupGuide.CLI.contains("Windows"))
        assertTrue(ConnectionSetupGuide.CLI.contains("Linux"))
    }
}
