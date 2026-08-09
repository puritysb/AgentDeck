package dev.agentdeck.net

import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import dev.agentdeck.data.DisplayPreferences
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first

private const val TAG = "BridgeAutoConnect"
private const val VERBOSE_AUTOCONNECT_LOGS = false

private inline fun autoConnectDebug(message: () -> String) {
    if (VERBOSE_AUTOCONNECT_LOGS || Log.isLoggable(TAG, Log.DEBUG)) {
        Log.d(TAG, message())
    }
}

/**
 * The connection ladder — loopback (adb reverse / USB) → saved URL → mDNS.
 *
 * There used to be two of these, one in `MainActivity.TabletDashboard` and one
 * in `EinkMonitorScreen`, and they drifted exactly the way duplicated policy
 * does: the fix that taught the ladder to let the USB path answer first and to
 * stop redialling an endpoint that refused us (commit a5ef2779) landed in the
 * tablet copy only. The devices it was written for are e-ink readers, which
 * take the OTHER copy — so a Crema S went on opening ~19 connections a SECOND
 * to a daemon that closed every one of them 4001, while showing its user a USB
 * attempt that dropped as fast as it appeared.
 *
 * One copy now, and the rules it enforces at every dial site:
 *
 *  - **The loopback probe answers first.** Over `adb reverse` the device is
 *    same-machine and needs no pairing token at all, which matters most on a
 *    reader with no camera to scan a QR with. mDNS visibility says nothing
 *    about whether that tunnel works, so it must not preempt the probe.
 *  - **An endpoint that closed us 4001 is not dialled again** until we have a
 *    credential to offer it. See [PairingCredential.mayDialDiscovered]; the
 *    memory lives in [BridgeConnection.unauthorizedEndpoints] because the
 *    socket layer clears the URL in the same breath as it stops reconnecting.
 *  - **Every retry is paced.** A device that can reach neither path settles
 *    into one loopback probe every couple of minutes, not a permanent cycle of
 *    "connecting over USB" / "USB bridge not found".
 *
 * @param onDiscoveredBridges receives the live mDNS list for the screen's
 *   manual-connect UI, and an empty list once connected.
 */
@Composable
fun BridgeAutoConnect(
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    onDiscoveredBridges: (List<DiscoveredBridge>) -> Unit = {},
) {
    val context = LocalContext.current
    val discovery = remember { BridgeDiscovery(context) }
    val status by connection.status.collectAsState()
    val url by connection.url.collectAsState()

    // The startup window before the first loopback dial has been issued. After
    // that the turn is held by the connection's URL, which the socket layer
    // clears when an attempt gives up — see mayDialDiscovered for why this is
    // deliberately not a re-armed latch.
    var loopbackTried by remember { mutableStateOf(false) }
    // Consecutive loopback probes that found no tunnel, for the retry pacing.
    var loopbackMisses by remember { mutableStateOf(0) }
    // The daemon endpoint mDNS last showed us, so the effect below can tell a
    // steady advertisement from a daemon that just (re)appeared.
    var lastSeenDaemon by remember { mutableStateOf<String?>(null) }

    fun mayDial(daemon: DiscoveredBridge): Boolean = PairingCredential.mayDialDiscovered(
        discoveredUrl = daemon.wsUrl(),
        currentUrl = connection.url.value,
        loopbackTried = loopbackTried,
        unauthorizedEndpoints = connection.unauthorizedEndpoints.value,
        savedUrl = connection.pairedUrl,
    )

    // ── 1. Startup: loopback, then the saved URL ──────────────────────────
    // mDNS is not a step here — the discovery effect below runs for as long as
    // we are disconnected and dials as soon as a daemon is both visible and
    // dialable. A bounded discovery window in this effect only duplicated it,
    // with its own collector racing the same shared flow.
    LaunchedEffect(Unit) {
        // The loopback dial goes first, before anything that can suspend. It
        // needs no stored credential (same-machine over the tunnel), and until
        // it is issued nothing holds the LAN fallback back but `loopbackTried`
        // — so a DataStore read that took its time would hand the turn away.
        if (connection.status.value != ConnectionStatus.CONNECTED) {
            autoConnectDebug { "Trying localhost:${BridgeConstants.WS_PORT} (USB)..." }
            connection.connect(BridgeConstants.LOCALHOST_WS_URL)
        }
        // Issued: the connection's URL holds the turn from here.
        loopbackTried = true

        val rawSavedUrl = displayPrefs.lastBridgeUrlFlow.first()
        val savedUrl = rawSavedUrl?.takeIf { isStorableBridgeUrl(it) }
        if (rawSavedUrl != null && savedUrl == null) {
            displayPrefs.setLastBridgeUrl(null)
        }
        // Seed the credential the connection layer re-attaches to tokenless
        // discovered endpoints (PairingCredential) — discovery stopped carrying
        // tokens in #145, so this is the only copy the device has.
        connection.pairedUrl = savedUrl
        autoConnectDebug { "Auto-connect: savedUrl=$savedUrl" }

        delay(AutoConnectRules.LOOPBACK_SETTLE_MS)
        if (savedUrl != null && connection.status.value != ConnectionStatus.CONNECTED) {
            connection.autoConnect(savedUrl)
        }
    }

    // ── 2. Persist the URL that worked ────────────────────────────────────
    LaunchedEffect(status) {
        if (status != ConnectionStatus.CONNECTED) return@LaunchedEffect
        loopbackMisses = 0
        val connectedUrl = connection.url.value
        // mayPersist, not isStorableBridgeUrl: a tokenless URL must never
        // overwrite a stored credential for the same daemon. CONNECTED fires at
        // the WebSocket handshake, which the daemon completes before closing an
        // unauthorized peer 4001 — so a doomed attempt could otherwise race in
        // and erase a working pairing.
        if (PairingCredential.mayPersist(connectedUrl, displayPrefs.lastBridgeUrlFlow.first())) {
            displayPrefs.setLastBridgeUrl(connectedUrl)
            connection.pairedUrl = connectedUrl
        }
    }

    // ── 3. mDNS while disconnected: publish the list, dial when allowed ───
    // Keyed on loopbackTried as well: the shared discovery flow replays its
    // last emission to a new subscriber but does not re-emit on its own, so an
    // effect that subscribed while the probe still held the turn would sit on a
    // daemon it had already decided not to dial.
    LaunchedEffect(status, url, loopbackTried) {
        if (status == ConnectionStatus.CONNECTED) {
            onDiscoveredBridges(emptyList())
            return@LaunchedEffect
        }
        discovery.discover().collect { bridges ->
            onDiscoveredBridges(bridges)
            val daemon = AutoConnectRules.pickDaemon(bridges)
            // A daemon that just appeared is news for the loopback path too:
            // a reverse tunnel to a daemon that was down cannot answer either,
            // so the backoff earned while it was gone should not outlive it.
            // Keyed on the transition, not on the emission — the shared flow
            // replays to every re-subscribe, and this effect re-keys on each
            // probe, so resetting per emission would erase the pacing entirely.
            val seen = PairingCredential.endpointOf(daemon?.wsUrl())
            if (seen != lastSeenDaemon) {
                lastSeenDaemon = seen
                if (seen != null) loopbackMisses = 0
            }
            if (connection.status.value == ConnectionStatus.CONNECTED) return@collect
            if (daemon == null) return@collect
            if (!mayDial(daemon)) return@collect
            autoConnectDebug { "mDNS dial: ${daemon.name} at ${daemon.wsUrl()}" }
            connection.connect(daemon.wsUrl(), daemon.fallbackWsUrl())
        }
    }

    // ── 4. Recovery: nothing in flight, so re-probe the loopback ──────────
    // Reached when every path has given up and cleared the URL. The daemon may
    // start after the app, or a reverse tunnel may be attached later, so this
    // never stops — but it backs off, because on a device that has neither the
    // probe is the only thing on screen.
    LaunchedEffect(status, url) {
        if (status != ConnectionStatus.DISCONNECTED || url != null) return@LaunchedEffect
        delay(AutoConnectRules.loopbackProbeDelayMs(loopbackMisses))
        if (connection.status.value != ConnectionStatus.DISCONNECTED) return@LaunchedEffect
        if (connection.url.value != null) return@LaunchedEffect
        loopbackMisses++
        autoConnectDebug { "Recovery probe #$loopbackMisses — localhost:${BridgeConstants.WS_PORT} (USB)" }
        connection.connect(BridgeConstants.LOCALHOST_WS_URL)
    }
}

/** A URL worth remembering across launches: a real endpoint, never loopback. */
private fun isStorableBridgeUrl(url: String?): Boolean =
    !url.isNullOrBlank() && !PairingCredential.isLoopback(url)

/**
 * Adopt a credential the user just obtained as this device's pairing, and dial it.
 *
 * The one entry point for "the user handed us a token", so the two ways that can
 * happen — redeeming a pairing code, or typing a `?token=` URL — cannot drift on
 * the part that matters: seeding [BridgeConnection.pairedUrl] as well as
 * persisting. Only `pairedUrl` is consulted by [PairingCredential.resolve], so a
 * pairing that is persisted but not seeded works until the app restarts and then
 * looks like a device that was never paired.
 *
 * The dial happens whether or not the store accepts the URL. [PairingCredential.mayPersist]
 * refuses a *downgrade*, which is a statement about what to keep on disk, not
 * about whether this credential works — and a user who just typed a code is owed
 * a connection attempt either way.
 */
suspend fun adoptPairedUrl(
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    wsUrl: String,
) {
    if (PairingCredential.mayPersist(wsUrl, displayPrefs.lastBridgeUrlFlow.first())) {
        displayPrefs.setLastBridgeUrl(wsUrl)
    }
    if (PairingCredential.tokenIn(wsUrl) != null) {
        connection.pairedUrl = wsUrl
    }
    connection.connect(wsUrl)
}

/** Pure ladder rules, kept out of the composable so they have a test. */
object AutoConnectRules {

    /** How long the startup ladder gives the loopback dial before the saved URL. */
    const val LOOPBACK_SETTLE_MS = 3_000L

    /** First recovery probe delay; also the step the backoff doubles from. */
    const val LOOPBACK_PROBE_BASE_MS = 10_000L

    /** Ceiling for the recovery probe interval. */
    const val LOOPBACK_PROBE_MAX_MS = 120_000L

    /**
     * The daemon to dial out of an mDNS emission.
     *
     * Only the daemon hub serves external clients, so agent type decides
     * membership. Port decides preference, not membership: the hub normally
     * holds [BridgeConstants.WS_PORT] but legitimately falls back to 9121+ when
     * something else won the port, and a filter that required the canonical
     * port made that daemon invisible to the tablet ladder.
     */
    fun pickDaemon(bridges: List<DiscoveredBridge>): DiscoveredBridge? {
        val daemons = bridges.filter { it.agentType == "daemon" }
        return daemons.firstOrNull { it.port == BridgeConstants.WS_PORT } ?: daemons.firstOrNull()
    }

    /**
     * How long to wait before the next loopback probe, after [misses] in a row
     * found no tunnel.
     *
     * Doubling, capped. A device that is genuinely USB-attached answers on the
     * first probe and never gets here; a device that is not would otherwise
     * spend its whole life announcing a USB attempt and losing it, which is the
     * symptom an unpaired e-ink reader shows its user.
     */
    fun loopbackProbeDelayMs(misses: Int): Long {
        if (misses <= 0) return LOOPBACK_PROBE_BASE_MS
        // Clamped before the shift: the ceiling is reached in 4 doublings, so
        // 20 can never overflow a Long, and past that the answer is the cap.
        val scaled = LOOPBACK_PROBE_BASE_MS shl misses.coerceAtMost(20)
        return scaled.coerceAtMost(LOOPBACK_PROBE_MAX_MS)
    }
}
