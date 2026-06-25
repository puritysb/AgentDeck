package dev.agentdeck.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.shareIn

private const val TAG = "BridgeDiscovery"

data class DiscoveredBridge(
    val name: String,
    val host: String,
    val port: Int,
    val token: String? = null,
    val agentType: String? = null,
) {
    /** Build WebSocket URL with auth token if available */
    fun wsUrl(): String {
        val base = "ws://$host:$port"
        return if (token != null) "$base?token=$token" else base
    }
}

class BridgeDiscovery(context: Context) {

    private val appContext = context.applicationContext

    /**
     * mDNS discovery of `_agentdeck._tcp` daemons.
     *
     * Returns a single process-wide shared flow rather than a fresh NSD discovery
     * per call. This is deliberate: the screens collect discovery from several
     * `LaunchedEffect`s at once (persistent UI list, initial auto-connect, recovery
     * loop) and re-key those effects on the fast-flipping connection status/URL.
     * A per-call cold flow meant each re-key cancelled `discoverServices()` —
     * tearing down the async `resolveService()` before `onServiceResolved` could
     * fire — and concurrent collectors each issued their own resolve, colliding on
     * Android NSD's single-in-flight-resolve limit. The net effect was a livelock:
     * the daemon was discovered but never resolved to a connectable host, so the
     * app fell back to the (often dead) localhost/USB URL forever.
     *
     * Sharing the flow means exactly one underlying discovery+resolve runs no
     * matter how many collectors attach, and `WhileSubscribed(stopTimeoutMillis)`
     * keeps it alive across the sub-second gaps when an effect re-keys, so resolves
     * actually complete. `replay = 1` lets a re-subscriber (e.g. the recovery loop)
     * see the last discovered daemon immediately.
     */
    fun discover(): Flow<List<DiscoveredBridge>> = shared(appContext)

    companion object {
        private const val SERVICE_TYPE = "_agentdeck._tcp."

        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

        @Volatile
        private var sharedFlow: SharedFlow<List<DiscoveredBridge>>? = null

        private fun shared(context: Context): SharedFlow<List<DiscoveredBridge>> {
            sharedFlow?.let { return it }
            return synchronized(this) {
                sharedFlow ?: rawDiscover(context).shareIn(
                    scope,
                    // Keep NSD discovery alive for 5s after the last collector leaves
                    // so brief LaunchedEffect re-keys don't abort in-flight resolves.
                    SharingStarted.WhileSubscribed(stopTimeoutMillis = 5_000),
                    replay = 1,
                ).also { sharedFlow = it }
            }
        }

        private fun rawDiscover(context: Context): Flow<List<DiscoveredBridge>> = callbackFlow {
            val nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
            val bridges = mutableMapOf<String, DiscoveredBridge>()

            val discoveryListener = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(serviceType: String) {}

                override fun onDiscoveryStopped(serviceType: String) {}

                override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                    if (serviceInfo.serviceType.contains("_agentdeck")) {
                        // Each resolveService() call needs its own listener —
                        // NsdManager throws if a listener is reused while active
                        val resolveListener = object : NsdManager.ResolveListener {
                            override fun onResolveFailed(si: NsdServiceInfo, errorCode: Int) {
                                Log.w(TAG, "Resolve failed for ${si.serviceName}: errorCode=$errorCode")
                            }

                            override fun onServiceResolved(si: NsdServiceInfo) {
                                val resolvedHost = si.host?.hostAddress
                                // Parse TXT records for token, agentType, and the advertised LAN ip.
                                // The TXT `ip` is preferred over the NSD-resolved host: the daemon
                                // selects its default-route LAN address explicitly, whereas the NSD
                                // hostname resolve can yield a secondary/unroutable interface on
                                // dual-homed hosts. Both fall back to each other.
                                val token = try {
                                    si.attributes["token"]?.let { String(it, Charsets.UTF_8) }
                                } catch (_: Exception) { null }
                                val agentType = try {
                                    si.attributes["agent"]?.let { String(it, Charsets.UTF_8) }
                                } catch (_: Exception) { null }
                                val txtIp = try {
                                    si.attributes["ip"]?.let { String(it, Charsets.UTF_8) }
                                } catch (_: Exception) { null }

                                val host = txtIp ?: resolvedHost ?: return
                                // Skip link-local addresses (169.254.x.x) — unreachable from WiFi
                                if (host.startsWith("169.254.")) return
                                val bridge = DiscoveredBridge(
                                    name = si.serviceName,
                                    host = host,
                                    port = si.port,
                                    token = token,
                                    agentType = agentType,
                                )
                                Log.i(TAG, "Resolved ${si.serviceName} -> ${bridge.host}:${bridge.port} (agent=$agentType)")
                                bridges[si.serviceName] = bridge
                                trySend(bridges.values.toList())
                            }
                        }
                        nsdManager.resolveService(serviceInfo, resolveListener)
                    }
                }

                override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                    bridges.remove(serviceInfo.serviceName)
                    trySend(bridges.values.toList())
                }

                override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                    Log.w(TAG, "Start discovery failed: errorCode=$errorCode")
                    close()
                }

                override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            }

            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)

            awaitClose {
                try {
                    nsdManager.stopServiceDiscovery(discoveryListener)
                } catch (_: Exception) {
                    // Already stopped
                }
            }
        }
    }
}
