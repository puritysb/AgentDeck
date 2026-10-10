package dev.agentdeck.net

import android.content.Context
import org.robolectric.RuntimeEnvironment
import dev.agentdeck.data.DisplayPreferences
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PairingPersistenceTest {
    @Test fun `switch and disconnect preserve each hosts credential on disk`() = runBlocking {
        val context = RuntimeEnvironment.getApplication()
        val preferences = DisplayPreferences(context)
        val first = "ws://first.local:9120?token=first"
        val second = "ws://second.local:9120?token=second"
        preferences.setLastBridgeUrl(first)
        preferences.setLastBridgeUrl(second)
        preferences.setLastBridgeUrl("ws://first.local:9120")
        assertEquals(first, preferences.lastBridgeUrlFlow.first())
        preferences.setLastBridgeUrl(null)
        val reloaded = DisplayPreferences(context).pairedBridgeUrlsFlow.first()
        assertEquals(first, reloaded["first.local:9120"])
        assertEquals(second, reloaded["second.local:9120"])
    }
}
