package dev.agentdeck

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.lifecycleScope
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.data.DashboardOrientation
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DimConfig
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.ui.monitor.MonitorScreen
import dev.agentdeck.ui.screen.EinkMonitorScreen
import dev.agentdeck.ui.theme.AgentDeckTheme
import dev.agentdeck.ui.screen.UnsupportedDeviceScreen
import dev.agentdeck.util.DeviceProfile
import dev.agentdeck.util.DeviceProfileHolder
import dev.agentdeck.util.PanelOverride
import android.content.Intent
import android.provider.Settings
import android.util.Log
import android.view.Surface
import android.view.WindowManager
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import dev.agentdeck.net.BridgeDiscovery
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.service.MonitorService
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private lateinit var deviceProfile: DeviceProfile

    /**
     * The device-class preferences this instance was built for. The collector
     * below compares against them so a change recreates the activity exactly
     * once — they decide the whole UI tree plus pre-first-frame window flags,
     * none of which can be swapped in place.
     */
    private var appliedPanelOverride: PanelOverride = PanelOverride.Auto
    private var appliedAllowUnsupported: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Declared once, here, rather than toggled from the display-sync
        // collector: the screen only goes dark after full-off dimming lets the
        // system sleep it, and Android STOPS this activity at that point, so the
        // collector is not running when the flag would be needed. Set up front it
        // is already in effect when MonitorService brings us back to the front,
        // which is what turns the panel on. showWhenLocked keeps that working
        // when the device locked itself while asleep.
        setShowWhenLocked(true)
        setTurnScreenOn(true)

        // Device class first: it decides the UI tree, the theme, and window
        // flags that RK3566 readers only honour before the first frame. The
        // override has to be read synchronously for the same reason — see
        // `readStartupOverridesBlocking`.
        val startup = DisplayPreferences(this).readStartupOverridesBlocking()
        appliedPanelOverride = startup.panelOverride
        appliedAllowUnsupported = startup.allowUnsupportedDevice
        deviceProfile = DeviceProfile.detect(this, startup.panelOverride)
        DeviceProfileHolder.install(deviceProfile)

        // Unsupported devices get guidance instead of a broken layout, unless
        // the user has explicitly overruled that.
        val showDashboard = deviceProfile.isRenderable || startup.allowUnsupportedDevice

        // E-ink: set landscape IMMEDIATELY — before any async/layout.
        // Pantone 6 (RK3566) ignores late requestedOrientation changes,
        // so this must happen before the first frame renders.
        if (deviceProfile.isEink && showDashboard) {
            applyOrientationPreference(DashboardOrientation.defaultFor(isEink = true))

            @Suppress("DEPRECATION")
            window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)
            hideSystemBars()
        }

        val stateHolder = AgentStateHolder.instance
        val connection = BridgeConnection.instance
        val displayPrefs = DisplayPreferences(this, isEink = deviceProfile.isEink)

        // Apply saved orientation preference (async — for user changes via Settings)
        lifecycleScope.launch {
            displayPrefs.orientationFlow.collect { orientation ->
                applyOrientationPreference(orientation)
            }
        }

        // Keep the dashboard awake while active, but let LCD tablets actually
        // sleep when the Mac display sends a full-off dim instruction. E-ink
        // surfaces intentionally keep their panel awake and only dim lighting.
        lifecycleScope.launch {
            combine(
                displayPrefs.keepAwakeFlow,
                displayPrefs.displaySyncEnabledFlow,
                stateHolder.state,
            ) { keepAwake, displaySyncEnabled, state ->
                shouldKeepDashboardScreenOn(
                    isEink = deviceProfile.isEink,
                    keepAwake = keepAwake,
                    displaySyncEnabled = displaySyncEnabled,
                    hostDisplayOn = state.hostDisplayOn,
                    hostDim = state.hostDim,
                )
            }.collect { keepScreenOn ->
                // Only KEEP_SCREEN_ON is toggled here. The turn-on capability is
                // declared once in onCreate — see the note there: this collector
                // is not running at the moment it would be needed, because the
                // activity is stopped while the screen is dark.
                if (keepScreenOn) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        // Start/stop MonitorService based on keepAwake preference
        lifecycleScope.launch {
            displayPrefs.keepAwakeFlow.collect { keepAwake ->
                val serviceIntent = Intent(this@MainActivity, MonitorService::class.java)
                if (keepAwake) {
                    ContextCompat.startForegroundService(this@MainActivity, serviceIntent)
                } else {
                    stopService(serviceIntent)
                }
            }
        }

        // Both device-class preferences are whole-tree changes; recreate rather
        // than trying to swap the dashboard under a live composition.
        //
        // Watching `allowUnsupportedDevice` here is also the recovery path for a
        // startup read that expired: `onCreate` then built this instance from
        // defaults, and `false` is not neutral — it re-blocks a user who had
        // already chosen to show the dashboard anyway. Nothing else would notice,
        // because a stored panel override of `Auto` matches the default too.
        lifecycleScope.launch {
            combine(
                displayPrefs.panelOverrideFlow,
                displayPrefs.allowUnsupportedDeviceFlow,
            ) { override, allowUnsupported -> override to allowUnsupported }
                .collect { (override, allowUnsupported) ->
                    if (shouldRecreateForDeviceOverrides(
                            appliedPanelOverride = appliedPanelOverride,
                            appliedAllowUnsupported = appliedAllowUnsupported,
                            storedPanelOverride = override,
                            storedAllowUnsupported = allowUnsupported,
                        )
                    ) {
                        appliedPanelOverride = override
                        appliedAllowUnsupported = allowUnsupported
                        recreate()
                    }
                }
        }

        setContent {
            AgentDeckTheme(profile = deviceProfile) {
                when {
                    !showDashboard -> UnsupportedDeviceScreen(
                        profile = deviceProfile,
                        // Persist only — the collector above observes the change
                        // and recreates, so this and the timeout-recovery path
                        // share one mechanism instead of racing two.
                        onShowAnyway = {
                            lifecycleScope.launch {
                                displayPrefs.setAllowUnsupportedDevice(true)
                            }
                        },
                    )
                    deviceProfile.isEink -> EinkMonitorScreen(stateHolder, connection, displayPrefs)
                    else -> TabletDashboard(stateHolder, connection, displayPrefs)
                }
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Re-hide system bars after Dialog dismissal (Dialog creates a new window
        // which resets immersive mode flags on the main window)
        if (hasFocus && deviceProfile.isEink) {
            hideSystemBars()
        }
    }

    /**
     * Apply system-level rotation for RK3566 devices that ignore requestedOrientation.
     * Auto-requests WRITE_SETTINGS permission if not granted (lost on APK reinstall).
     */
    private fun applyOrientationPreference(orientation: Int) {
        requestedOrientation = DashboardOrientation.requestedActivityOrientation(orientation)

        if (!deviceProfile.isEink) return

        when {
            orientation == DashboardOrientation.Landscape -> applySystemFixedRotation(Surface.ROTATION_90)
            orientation == DashboardOrientation.Portrait -> applySystemFixedRotation(Surface.ROTATION_0)
            DashboardOrientation.isAuto(orientation) -> applySystemAutoRotation()
            else -> Log.w(TAG, "Unsupported orientation preference: $orientation")
        }
    }

    private fun applySystemFixedRotation(rotation: Int) {
        if (Settings.System.canWrite(this)) {
            try {
                Settings.System.putInt(contentResolver, Settings.System.ACCELEROMETER_ROTATION, 0)
                Settings.System.putInt(contentResolver, Settings.System.USER_ROTATION, rotation)
            } catch (e: Exception) {
                Log.w(TAG, "System rotation fallback failed: ${e.message}")
            }
        } else {
            // WRITE_SETTINGS lost (APK reinstall) — auto-request via system UI
            Log.w(TAG, "WRITE_SETTINGS not granted — requesting permission")
            try {
                startActivity(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS).apply {
                    data = android.net.Uri.parse("package:$packageName")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
            } catch (e: Exception) {
                Log.e(TAG, "Cannot open WRITE_SETTINGS screen: ${e.message}")
            }
        }
    }

    private fun applySystemAutoRotation() {
        if (Settings.System.canWrite(this)) {
            try {
                Settings.System.putInt(contentResolver, Settings.System.ACCELEROMETER_ROTATION, 1)
            } catch (e: Exception) {
                Log.w(TAG, "System auto-rotation fallback failed: ${e.message}")
            }
        } else {
            Log.w(TAG, "WRITE_SETTINGS not granted — auto-rotation fallback unavailable")
        }
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).let { controller ->
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }
}

private const val TAG = "MainActivity"
private const val VERBOSE_MAIN_LOGS = false

/**
 * Whether the stored device-class preferences differ from the ones this activity
 * instance was built from, and therefore need a recreate.
 *
 * Extracted so the recovery case has a test: when the bounded startup read
 * expires, the instance is built from defaults, and `allowUnsupportedDevice`
 * defaulting to `false` silently re-blocks a user who had already chosen to show
 * the dashboard anyway. Comparing only the panel override misses that entirely,
 * because a stored `Auto` equals the default it was built with.
 *
 * Convergence: the recreate re-reads a DataStore that this process has already
 * collected once, so the second read is served warm and the applied pair then
 * matches storage. It is a one-shot correction, not a loop.
 */
internal fun shouldRecreateForDeviceOverrides(
    appliedPanelOverride: PanelOverride,
    appliedAllowUnsupported: Boolean,
    storedPanelOverride: PanelOverride,
    storedAllowUnsupported: Boolean,
): Boolean = storedPanelOverride != appliedPanelOverride ||
    storedAllowUnsupported != appliedAllowUnsupported

internal fun shouldKeepDashboardScreenOn(
    isEink: Boolean,
    keepAwake: Boolean,
    displaySyncEnabled: Boolean,
    hostDisplayOn: Boolean,
    hostDim: DimConfig?,
): Boolean {
    if (!keepAwake) return false
    if (isEink) return true
    if (!displaySyncEnabled) return true
    if (hostDisplayOn) return true
    if (hostDim?.enabled == false) return true

    // `min` means "stay visible at low brightness"; absent or any unknown mode
    // preserves the legacy full-off behavior and must release KEEP_SCREEN_ON.
    return hostDim?.mode == "min"
}

private inline fun mainDebug(message: () -> String) {
    if (VERBOSE_MAIN_LOGS || Log.isLoggable(TAG, Log.DEBUG)) {
        Log.d(TAG, message())
    }
}

private fun shouldPersistBridgeUrl(url: String?): Boolean {
    return url != null && !url.contains("127.0.0.1") && !url.contains("localhost")
}

@Composable
fun TabletDashboard(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
) {
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    val context = LocalContext.current

    // Auto-connect: localhost (USB) → saved URL → mDNS (WiFi)
    LaunchedEffect(Unit) {
        val rawSavedUrl = displayPrefs.lastBridgeUrlFlow.first()
        val savedUrl = rawSavedUrl?.takeUnless { !shouldPersistBridgeUrl(it) }
        if (rawSavedUrl != null && savedUrl == null) {
            displayPrefs.setLastBridgeUrl(null)
        }
        mainDebug { "Auto-connect: savedUrl=$savedUrl" }
        // Try localhost (adb reverse USB connection) before mDNS
        if (connection.status.value != ConnectionStatus.CONNECTED) {
            mainDebug { "Trying localhost:${BridgeConstants.WS_PORT} (USB)..." }
            connection.connect(BridgeConstants.LOCALHOST_WS_URL)
            delay(3000)
        }
        if (savedUrl != null && connection.status.value != ConnectionStatus.CONNECTED) {
            connection.autoConnect(savedUrl)
            delay(5000)
        }
        // If still disconnected, try mDNS discovery
        if (connection.status.value != ConnectionStatus.CONNECTED) {
            mainDebug { "Saved URL failed, trying mDNS discovery..." }
            val discovery = BridgeDiscovery(context)
            // Phase 1: collect bridges, connect immediately if daemon found
            withTimeoutOrNull(6000) {
                discovery.discover().collect { bridges ->
                    val daemon = bridges.firstOrNull {
                        it.agentType == "daemon" && it.port == BridgeConstants.WS_PORT
                    }
                    if (daemon != null) {
                        mainDebug { "mDNS auto-connect (daemon): ${daemon.name} at ${daemon.wsUrl()}" }
                        connection.connect(daemon.wsUrl(), daemon.fallbackWsUrl())
                        return@collect
                    }
                }
            }
            // No non-daemon fallback — daemon only
        }
    }

    // Persist URL on successful connection
    LaunchedEffect(connectionStatus) {
        if (connectionStatus == ConnectionStatus.CONNECTED) {
            val url = currentUrl
            if (shouldPersistBridgeUrl(url)) displayPrefs.setLastBridgeUrl(url)
        }
    }

    // Preempt the localhost (USB) phase whenever mDNS can see a daemon: adb reverse
    // only exists under the Node CLI daemon, so against the Swift in-process daemon
    // the ws://127.0.0.1 attempt can never succeed and the bounded discovery windows
    // in the effects above/below can keep missing a slow NSD resolve. Runs whenever
    // not connected; re-resolving per connection also heals a saved URL whose port
    // went stale after a daemon restart (e.g. 9121→9120).
    LaunchedEffect(connectionStatus, currentUrl) {
        if (connectionStatus == ConnectionStatus.CONNECTED) return@LaunchedEffect
        val discovery = BridgeDiscovery(context)
        discovery.discover().collect { bridges ->
            val daemon = bridges.firstOrNull {
                it.agentType == "daemon" && it.port == BridgeConstants.WS_PORT
            }
            val cur = connection.url.value
            val curIsLocalOrNone = cur == null ||
                cur.contains("127.0.0.1") || cur.contains("localhost")
            if (daemon != null && curIsLocalOrNone &&
                connection.status.value != ConnectionStatus.CONNECTED) {
                mainDebug { "mDNS preempts USB attempt: ${daemon.name} at ${daemon.wsUrl()}" }
                connection.connect(daemon.wsUrl(), daemon.fallbackWsUrl())
            }
        }
    }

    // Recovery after BridgeConnection gives up on localhost and clears URL.
    // Keep cycling so devices reconnect when the daemon starts after the app.
    LaunchedEffect(connectionStatus, currentUrl) {
        if (connectionStatus == ConnectionStatus.DISCONNECTED && currentUrl == null) {
            delay(500) // brief pause before re-discovery
            mainDebug { "Disconnected with no URL — re-discovering via mDNS" }
            val discovery = BridgeDiscovery(context)
            withTimeoutOrNull(6000) {
                discovery.discover().collect { bridges ->
                    val daemon = bridges.firstOrNull {
                        it.agentType == "daemon" && it.port == BridgeConstants.WS_PORT
                    }
                    if (daemon != null) {
                        mainDebug { "Re-discover (daemon): ${daemon.name} at ${daemon.wsUrl()}" }
                        connection.connect(daemon.wsUrl(), daemon.fallbackWsUrl())
                        return@collect
                    }
                }
            }
            if (connection.status.value != ConnectionStatus.CONNECTED && connection.url.value == null) {
                delay(10_000)
                if (connection.status.value != ConnectionStatus.CONNECTED && connection.url.value == null) {
                    mainDebug { "mDNS recovery timed out — retrying localhost:${BridgeConstants.WS_PORT} (USB)" }
                    connection.connect(BridgeConstants.LOCALHOST_WS_URL)
                }
            }
            // No non-daemon fallback — daemon only.
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        MonitorScreen(
            stateHolder = stateHolder,
            connection = connection,
            displayPrefs = displayPrefs,
        )
    }
}
