package dev.agentdeck.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceTimeBy

class BridgeDiscoveryTest {

    @Test
    fun `ws url uses primary host and preserves pairing token`() {
        val bridge = DiscoveredBridge(
            name = "daemon-9120",
            host = "192.168.1.20",
            port = 9120,
            token = "abcdef0123456789",
            agentType = "daemon",
            fallbackHost = "192.168.1.21",
        )

        assertEquals("ws://192.168.1.20:9120?token=abcdef0123456789", bridge.wsUrl())
        assertEquals("ws://192.168.1.21:9120?token=abcdef0123456789", bridge.fallbackWsUrl())
    }

    @Test
    fun `fallback url is absent without a fallback host`() {
        val bridge = DiscoveredBridge(
            name = "daemon-9120",
            host = "192.168.1.20",
            port = 9120,
            token = "abcdef0123456789",
            agentType = "daemon",
        )

        assertEquals("ws://192.168.1.20:9120?token=abcdef0123456789", bridge.wsUrl())
        assertNull(bridge.fallbackWsUrl())
    }
}

@RunWith(org.robolectric.RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [33], shadows = [RecordingNsdManager::class])
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class BridgeDiscoveryLifecycleTest {
    private fun service(name: String, port: Int? = null, agent: String? = "daemon", ip: String? = null) =
        android.net.nsd.NsdServiceInfo().apply {
            serviceName = name
            serviceType = "_agentdeck._tcp."
            port?.let { setAttribute("port", it.toString()) }
            agent?.let { setAttribute("agent", it) }
            ip?.let { setAttribute("ip", it) }
        }

    @Test fun `daemon TXT ports survive discovery while legacy session ports remain filtered`() = kotlinx.coroutines.test.runTest {
        val context = org.robolectric.RuntimeEnvironment.getApplication()
        val manager = context.getSystemService(android.content.Context.NSD_SERVICE) as android.net.nsd.NsdManager
        val fake = org.robolectric.shadow.api.Shadow.extract<RecordingNsdManager>(manager)
        val emissions = mutableListOf<List<DiscoveredBridge>>()
        val job = backgroundScope.launch(kotlinx.coroutines.test.UnconfinedTestDispatcher(testScheduler)) {
            BridgeDiscovery.rawDiscover(context).collect { emissions.add(it) }
        }
        runCurrent()
        fake.discovery.onServiceFound(service("custom", 19200, ip = "192.0.2.1"))
        fake.discovery.onServiceFound(service("legacy-session", 9121, "claude", "192.0.2.2"))
        fake.discovery.onServiceFound(service("invalid", 99999, ip = "192.0.2.3"))
        fake.discovery.onServiceFound(service("standard", 9120, null, "192.0.2.4"))
        fake.discovery.onServiceFound(service("resolved-custom", 19201))
        val (request, listener) = fake.resolves.single()
        request.port = 19201
        request.host = java.net.InetAddress.getByName("192.0.2.5")
        listener.onServiceResolved(request)
        runCurrent()
        val bridges = emissions.last()
        assertEquals(setOf("custom", "standard", "resolved-custom"), bridges.map { it.name }.toSet())
        assertEquals(19200, bridges.first { it.name == "custom" }.port)
        assertEquals("ws://192.0.2.5:19201", bridges.first { it.name == "resolved-custom" }.wsUrl())
        job.cancel()
    }

    @Test fun `busy resolution retries and can resolve the original service`() = kotlinx.coroutines.test.runTest {
        val context = org.robolectric.RuntimeEnvironment.getApplication()
        val manager = context.getSystemService(android.content.Context.NSD_SERVICE) as android.net.nsd.NsdManager
        val fake = org.robolectric.shadow.api.Shadow.extract<RecordingNsdManager>(manager)
        val emissions = mutableListOf<List<DiscoveredBridge>>()
        val job = backgroundScope.launch(kotlinx.coroutines.test.UnconfinedTestDispatcher(testScheduler)) {
            BridgeDiscovery.rawDiscover(context).collect { emissions.add(it) }
        }
        runCurrent()
        fake.discovery.onServiceFound(service("busy"))
        val (first, callback) = fake.resolves.single()
        callback.onResolveFailed(first, android.net.nsd.NsdManager.FAILURE_ALREADY_ACTIVE)
        advanceTimeBy(251)
        runCurrent()
        assertEquals(2, fake.resolves.size)
        val (retry, resolved) = fake.resolves.last()
        retry.port = 9120
        retry.host = java.net.InetAddress.getByName("192.0.2.6")
        resolved.onServiceResolved(retry)
        runCurrent()
        assertEquals("busy", emissions.last().single().name)
        job.cancel()
    }

    @Test fun `stopped discovery cannot retry or publish into a restarted discovery`() = kotlinx.coroutines.test.runTest {
        val context = org.robolectric.RuntimeEnvironment.getApplication()
        val manager = context.getSystemService(android.content.Context.NSD_SERVICE) as android.net.nsd.NsdManager
        val fake = org.robolectric.shadow.api.Shadow.extract<RecordingNsdManager>(manager)
        val old = backgroundScope.launch(kotlinx.coroutines.test.UnconfinedTestDispatcher(testScheduler)) {
            BridgeDiscovery.rawDiscover(context).collect {}
        }
        runCurrent()
        fake.discovery.onServiceFound(service("old"))
        val (request, callback) = fake.resolves.single()
        callback.onResolveFailed(request, android.net.nsd.NsdManager.FAILURE_ALREADY_ACTIVE)
        old.cancel()
        runCurrent()
        val emissions = mutableListOf<List<DiscoveredBridge>>()
        val fresh = backgroundScope.launch(kotlinx.coroutines.test.UnconfinedTestDispatcher(testScheduler)) {
            BridgeDiscovery.rawDiscover(context).collect { emissions.add(it) }
        }
        runCurrent()
        fake.discovery.onServiceFound(service("fresh", 9120, ip = "192.0.2.7"))
        advanceTimeBy(251)
        request.port = 9120
        request.host = java.net.InetAddress.getByName("192.0.2.8")
        callback.onServiceResolved(request)
        runCurrent()
        assertEquals(1, fake.resolves.size)
        assertEquals(listOf("fresh"), emissions.last().map { it.name })
        fresh.cancel()
    }
}

@org.robolectric.annotation.Implements(android.net.nsd.NsdManager::class)
class RecordingNsdManager {
    lateinit var discovery: android.net.nsd.NsdManager.DiscoveryListener
    val resolves = mutableListOf<Pair<android.net.nsd.NsdServiceInfo, android.net.nsd.NsdManager.ResolveListener>>()
    @org.robolectric.annotation.Implementation
    fun discoverServices(type: String, protocol: Int, listener: android.net.nsd.NsdManager.DiscoveryListener) {
        discovery = listener
        listener.onDiscoveryStarted(type)
    }
    @org.robolectric.annotation.Implementation
    fun stopServiceDiscovery(listener: android.net.nsd.NsdManager.DiscoveryListener) {
        listener.onDiscoveryStopped("_agentdeck._tcp.")
    }
    @org.robolectric.annotation.Implementation
    fun resolveService(info: android.net.nsd.NsdServiceInfo, listener: android.net.nsd.NsdManager.ResolveListener) {
        resolves.add(info to listener)
    }
}
