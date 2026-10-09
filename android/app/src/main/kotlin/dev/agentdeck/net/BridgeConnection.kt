package dev.agentdeck.net

import android.os.Build
import android.util.Log
import dev.agentdeck.util.DeviceProfile
import dev.agentdeck.util.DeviceProfileHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import kotlin.math.min

private const val TAG = "BridgeConnection"
private const val VERBOSE_BRIDGE_LOGS = false

private inline fun bridgeDebug(tag: String = TAG, message: () -> String) {
    if (VERBOSE_BRIDGE_LOGS || Log.isLoggable(tag, Log.DEBUG)) {
        Log.d(tag, message())
    }
}

enum class ConnectionStatus {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
}

class BridgeConnection internal constructor() {

    companion object {
        val instance: BridgeConnection by lazy { BridgeConnection() }
        private const val INITIAL_BACKOFF_MS = 1000L
        private const val MAX_BACKOFF_MS = 8_000L
        /** Max retries on a network URL before giving up and clearing it for mDNS fallback. */
        private const val MAX_ATTEMPTS = 5
        /**
         * Max retries on the loopback (adb reverse) URL.
         *
         * A loopback dial is answered by the kernel: with no reverse tunnel it
         * is refused in milliseconds, and with one it connects just as fast.
         * Retrying it five times with backoff spends ~15s claiming to be
         * "connecting over USB" on a device where nothing is listening, which
         * is what an unpaired e-ink reader shows on screen while it waits.
         * One retry covers a tunnel that is mid-setup; beyond that the answer
         * will not change, and the recovery ladder re-probes on its own clock.
         */
        private const val MAX_LOOPBACK_ATTEMPTS = 2
        /** Failed attempts on the primary (TXT-ip) URL before switching to the resolved-host fallback. */
        private const val PRIMARY_ATTEMPTS_BEFORE_FALLBACK = 2
        /** How many refused endpoints to remember; see [unauthorizedEndpoints]. */
        private const val MAX_REMEMBERED_REFUSALS = 8
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    // Liveness detection is pong-based, not data-based: OkHttp sends a ping every
    // pingInterval and fails the socket if no frame (pong or data) arrives within
    // readTimeout. We can't drive a data-silence "stale" timer off onMessage —
    // OkHttp never surfaces ping/pong to the listener, so an idle-but-alive
    // connection would look silent and false-positive. Instead we keep detection
    // tight (read 22s > ping 15s leaves a full ping cycle of margin) so a
    // silently-dead daemon surfaces as DISCONNECTED within ~22s — matching the
    // 20s stale window the TUI and macOS app use — rather than the old ~45s lag
    // where a dead daemon's sessions lingered on screen as if live.
    private val client = OkHttpClient.Builder()
        .readTimeout(22, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private val generation = java.util.concurrent.atomic.AtomicLong()
    @Volatile var selectedUrl: String? = null
    @Volatile var pairedUrls: Map<String, String> = emptyMap()
    private var backoffMs = INITIAL_BACKOFF_MS
    private var shouldReconnect = false
    /** Secondary URL (NSD-resolved host) to try once the primary keeps failing; null when none. */
    private var fallbackUrl: String? = null
    /** Whether we've already switched to [fallbackUrl] this connect cycle. */
    private var triedFallback = false

    private val registrationCoordinator = AndroidDashboardRegistrationCoordinator { payload ->
        val socket = webSocket
        _status.value == ConnectionStatus.CONNECTED && socket != null && socket.send(payload)
    }
    private val profileListener: (DeviceProfile) -> Unit = { profile ->
        registrationCoordinator.profileChanged(androidDashboardIdentity(Build.MODEL, profile))
    }

    init {
        DeviceProfileHolder.addListener(profileListener)
    }

    private val _status = MutableStateFlow(ConnectionStatus.DISCONNECTED)
    val status: StateFlow<ConnectionStatus> = _status.asStateFlow()

    private val _url = MutableStateFlow<String?>(null)
    val url: StateFlow<String?> = _url.asStateFlow()

    /** Last connection error message (cleared on next connect attempt). */
    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    /**
     * Endpoints (host:port) that closed us 4001, remembered as their own fact.
     *
     * Stopping the socket-level reconnect is not enough: the same handler
     * clears `_url`, and the auto-connect layer reads a null URL as "nothing
     * has been tried", so it redialled on every mDNS emission. A rejection has
     * to survive that clearing — see `PairingCredential.mayDialDiscovered`.
     *
     * Keyed per spelling, not a single value: a dual-homed daemon is offered
     * under two (TXT ip and NSD-resolved host) and the reconnect ladder fails
     * over between them, so one slot would let the two take turns looking new.
     * The value is WHEN the refusal happened, because the memory expires on
     * read (`PairingCredential.UNAUTHORIZED_REDIAL_HOLDOFF_MS`) — operator
     * approval grants access without minting a token, so a refusal remembered
     * without an age could never be retired by the one flow that makes the
     * endpoint dialable again. Bounded at [MAX_REMEMBERED_REFUSALS] — this is
     * a hint that stops a hammer, not an audit log.
     */
    private val _unauthorizedEndpoints = MutableStateFlow<Map<String, Long>>(emptyMap())
    val unauthorizedEndpoints: StateFlow<Map<String, Long>> = _unauthorizedEndpoints.asStateFlow()

    /** True when actively trying to reconnect to a known URL. */
    private val _isReconnecting = MutableStateFlow(false)
    val isReconnecting: StateFlow<Boolean> = _isReconnecting.asStateFlow()

    /** Current reconnect attempt number (reset on connect/disconnect). */
    private val _reconnectAttempt = MutableStateFlow(0)
    val reconnectAttempt: StateFlow<Int> = _reconnectAttempt.asStateFlow()

    var onEvent: ((BridgeEvent) -> Unit)? = null

    /**
     * Connect to [wsUrl]. When [fallbackUrl] is provided (the daemon's NSD-resolved
     * address, distinct from the TXT-ip primary), the reconnect loop fails over to it
     * once after [PRIMARY_ATTEMPTS_BEFORE_FALLBACK] failed attempts on the primary,
     * before clearing the URL for re-discovery.
     */
    /**
     * Last URL known to carry a working pairing token, seeded from persisted
     * prefs. Discovered bridge URLs have carried no token since #145, so a
     * rediscovered endpoint we are already paired with re-attaches its
     * credential here instead of dialing unauthenticated. Set it wherever the
     * saved URL is read or written; see [PairingCredential].
     */
    @Volatile
    var pairedUrl: String? = null

    fun connect(requestedUrl: String, fallbackUrl: String? = null) {
        generation.incrementAndGet()
        pairedUrls = PairingCredential.remember(pairedUrl, pairedUrls)
        val wsUrl = PairingCredential.resolveFromStore(requestedUrl, pairedUrls)
        if (!PairingCredential.isLoopback(wsUrl)) selectedUrl = wsUrl
        bridgeDebug { "connect($wsUrl) — current status=${_status.value}" }
        // Cancel any existing connection/reconnect loop before starting fresh
        shouldReconnect = false
        webSocket?.close(1000, "New connection")
        webSocket = null
        registrationCoordinator.socketClosed()

        // Only keep a fallback that's actually distinct from the primary.
        this.fallbackUrl = fallbackUrl?.takeIf { it != wsUrl }
        triedFallback = false

        // A dial that carries a credential is new information about THIS
        // endpoint, so it retires that endpoint's earlier refusal — and only
        // that one. Dialling the loopback path says nothing about whether we
        // may now authenticate to a LAN daemon; clearing the whole memory there
        // is how the recovery ladder used to re-arm the hammer once a minute.
        PairingCredential.endpointOf(wsUrl)
            ?.takeIf { PairingCredential.tokenIn(wsUrl) != null }
            ?.let { endpoint -> _unauthorizedEndpoints.update { it - endpoint } }

        _url.value = wsUrl
        _status.value = ConnectionStatus.DISCONNECTED
        _lastError.value = null
        _reconnectAttempt.value = 0
        _isReconnecting.value = false
        shouldReconnect = true
        backoffMs = INITIAL_BACKOFF_MS
        doConnect(wsUrl)
    }

    fun disconnect() {
        generation.incrementAndGet()
        selectedUrl = null
        shouldReconnect = false
        _isReconnecting.value = false
        _reconnectAttempt.value = 0
        _url.value = null
        _lastError.value = null
        webSocket?.close(1000, "User disconnect")
        webSocket = null
        registrationCoordinator.socketClosed()
        _status.value = ConnectionStatus.DISCONNECTED
        onEvent?.invoke(BridgeEvent.Disconnected)
    }

    fun send(message: String) {
        webSocket?.send(message)
    }

    fun sendRespond(value: String) = send(PluginCommands.respond(value))
    fun sendSelectOption(index: Int, sessionId: String? = null, question: String? = null) =
        send(PluginCommands.selectOption(index, sessionId, question))
    fun sendPermissionDecision(requestId: String, decision: String) =
        send(PluginCommands.permissionDecision(requestId, decision))
    fun sendFocusSession(sessionId: String) = send(PluginCommands.focusSession(sessionId))
    fun sendPrompt(text: String) = send(PluginCommands.sendPrompt(text))
    fun sendInterrupt() = send(PluginCommands.interrupt())
    fun sendEscape() = send(PluginCommands.escape())
    fun sendQueryUsage() = send(PluginCommands.queryUsage())
    fun sendSwitchMode() = send(PluginCommands.switchMode())
    /** Connect to a saved URL if not already connected. */
    fun autoConnect(savedUrl: String?) {
        if (savedUrl != null && _status.value == ConnectionStatus.DISCONNECTED) {
            connect(savedUrl)
        }
    }

    private fun isLocalhostUrl(url: String): Boolean {
        return url.contains("127.0.0.1") || url.contains("localhost")
    }

    private fun doConnect(wsUrl: String) {
        if (_status.value == ConnectionStatus.CONNECTING) {
            bridgeDebug { "doConnect($wsUrl) — skipped, already CONNECTING" }
            return
        }
        bridgeDebug { "doConnect($wsUrl) — opening WebSocket" }
        _status.value = ConnectionStatus.CONNECTING

        val request = Request.Builder()
            .url(wsUrl)
            .apply {
                // Lets the daemon approve THIS device rather than its address —
                // see DeviceIdentity. Omitted when there is no id to send, which
                // leaves the daemon on its address-scoped fallback rather than
                // sending it a value that changes every connect.
                DeviceIdentity.current?.let { addHeader(PairingCodeRules.DEVICE_ID_HEADER, it) }
            }
            .build()

        val attempt = generation.incrementAndGet()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (generation.get() != attempt) return
                bridgeDebug { "onOpen — connected to $wsUrl" }
                // Authentication is confirmed by the first parsed daemon frame.

            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (generation.get() != attempt) return
                val event = parseBridgeMessage(text)
                if (event != null) {
                    if (_status.value != ConnectionStatus.CONNECTED) {
                        _status.value = ConnectionStatus.CONNECTED
                        _isReconnecting.value = false
                        _reconnectAttempt.value = 0
                        backoffMs = INITIAL_BACKOFF_MS
                        // Volunteer this dashboard's identity so the daemon topology can
                        // show an Android row. Without it a WiFi-connected tablet is an
                        // anonymous consumer with no visibility anywhere in the UI.
                        // Some models already embed the brand ("Lenovo TB-J606F") —
                        // `DeviceProfile.displayName` is where that de-duplication lives.
                        registrationCoordinator.socketOpened(
                            androidDashboardIdentity(Build.MODEL, DeviceProfileHolder.current)
                        )
                        PairingCredential.endpointOf(wsUrl)?.let { endpoint ->
                            _unauthorizedEndpoints.update { it - endpoint }
                        }
                    }
                    if (event is BridgeEvent.State) {
                        bridgeDebug("Terrarium") {
                            "WS state_update: agentType=${event.data.agentType}, state=${event.data.state}, gwAvail=${event.data.gatewayAvailable}, gwErr=${event.data.gatewayHasError}"
                        }
                    }
                    onEvent?.invoke(event)
                } else {
                    Log.w(TAG, "Unparsed WS message: ${text.take(200)}")
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (generation.get() != attempt) return
                bridgeDebug { "onClosing — code=$code reason=$reason" }
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (generation.get() != attempt) return
                bridgeDebug { "onClosed — code=$code reason=$reason" }
                registrationCoordinator.socketClosed()
                _status.value = ConnectionStatus.DISCONNECTED
                onEvent?.invoke(BridgeEvent.Disconnected)
                // Don't reconnect on auth rejection — token required
                if (code == 4001) {
                    authenticationRequired(wsUrl)
                } else {
                    scheduleReconnect()
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (generation.get() != attempt) return
                // Prefer HTTP handshake details when the upgrade was rejected — a bare
                // t.message like "Failed to connect" hides the actual reason (4xx code,
                // server message). When response is null, fall back to the exception.
                val msg = if (response != null) {
                    "HTTP ${response.code} ${response.message} — ${t.message ?: t.javaClass.simpleName}"
                } else {
                    "${t.javaClass.simpleName}: ${t.message ?: "unknown"}"
                }
                if (VERBOSE_BRIDGE_LOGS || Log.isLoggable(TAG, Log.DEBUG)) {
                    Log.e(TAG, "onFailure — $msg", t)
                } else {
                    Log.w(TAG, "onFailure — $msg")
                }
                if (response?.code == 401) {
                    authenticationRequired(wsUrl)
                    return
                }
                registrationCoordinator.socketClosed()
                _status.value = ConnectionStatus.DISCONNECTED
                _lastError.value = msg
                onEvent?.invoke(BridgeEvent.Disconnected)
                scheduleReconnect()
            }
        })
        // A peer may upgrade and then send nothing while answering pings.
        // Bound confirmation independently of WebSocket keepalive.
        scope.launch {
            delay(client.readTimeoutMillis.toLong())
            if (generation.get() == attempt && _status.value == ConnectionStatus.CONNECTING) {
                generation.incrementAndGet()
                webSocket?.cancel()
                _status.value = ConnectionStatus.DISCONNECTED
                _lastError.value = "No response from ${PairingCredential.endpointOf(wsUrl)}"
                scheduleReconnect()
            }
        }
    }

    private fun authenticationRequired(wsUrl: String) {
        shouldReconnect = false
        _isReconnecting.value = false
        _reconnectAttempt.value = 0
        registrationCoordinator.socketClosed()
        PairingCredential.endpointOf(wsUrl)?.let { endpoint ->
            _unauthorizedEndpoints.update { current ->
                (current + (endpoint to System.currentTimeMillis())).entries
                    .sortedByDescending { it.value }.take(MAX_REMEMBERED_REFUSALS)
                    .associate { it.key to it.value }
            }
        }
        // Keep the selected URL: discovery must not treat a refusal as a fresh
        // opportunity to dial another host or hammer the same host.
        _lastError.value = PairingCredential.approvalMessage(wsUrl)
        _status.value = ConnectionStatus.DISCONNECTED
        onEvent?.invoke(BridgeEvent.Disconnected)
        val refusedGeneration = generation.get()
        scope.launch {
            delay(PairingCredential.UNAUTHORIZED_REDIAL_HOLDOFF_MS)
            // Operator approval must still work without touching an e-ink
            // reader. Recheck only this host, and never revive a replaced or
            // explicitly disconnected attempt. Expiry is checked on read.
            val endpoint = PairingCredential.endpointOf(wsUrl) ?: return@launch
            if (generation.get() == refusedGeneration && _url.value == wsUrl &&
                PairingCredential.mayDialDiscovered(
                    discoveredUrl = "ws://$endpoint", currentUrl = null,
                    loopbackTried = true, unauthorizedAt = _unauthorizedEndpoints.value,
                    savedUrl = null, nowMs = System.currentTimeMillis(),
                )
            ) connect(wsUrl)
        }
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        val currentUrl = _url.value ?: return
        val retryGeneration = generation.get()

        _isReconnecting.value = true
        _reconnectAttempt.value++

        // Dual-homed fallback: when the primary (TXT-ip) URL keeps failing and the
        // daemon also advertised a distinct NSD-resolved host, switch to it once
        // before giving up. Covers a multi-NIC same-subnet daemon whose advertised
        // interface has a broken return path while the resolved address is reachable.
        val fb = fallbackUrl
        if (fb != null && !triedFallback && fb != currentUrl &&
            _reconnectAttempt.value >= PRIMARY_ATTEMPTS_BEFORE_FALLBACK
        ) {
            Log.w(
                TAG,
                "Primary $currentUrl failing after ${_reconnectAttempt.value} attempts — switching to resolved-host fallback $fb"
            )
            triedFallback = true
            _reconnectAttempt.value = 0
            backoffMs = INITIAL_BACKOFF_MS
            _url.value = fb
            _lastError.value = null
            scope.launch {
                delay(backoffMs)
                if (generation.get() == retryGeneration && shouldReconnect && _status.value == ConnectionStatus.DISCONNECTED) {
                    doConnect(fb)
                }
            }
            return
        }

        val isLocalhost = isLocalhostUrl(currentUrl)

        // Fast-fail: after a short burst of retries, give up and clear the URL
        // so the caller's LaunchedEffect can trigger mDNS discovery.
        // Continuing to hammer a stale/dead URL would block the discovery path indefinitely.
        val maxAttempts = if (isLocalhost) MAX_LOOPBACK_ATTEMPTS else MAX_ATTEMPTS
        if (_reconnectAttempt.value > maxAttempts) {
            Log.w(
                TAG,
                "Connection to $currentUrl still failing after ${_reconnectAttempt.value} attempts — giving up, clearing URL for mDNS fallback"
            )
            shouldReconnect = false
            _isReconnecting.value = false
            _reconnectAttempt.value = 0
            _url.value = null
            _lastError.value = if (isLocalhost) "USB bridge not found — try WiFi" else "Bridge not found — re-discovering"
            _status.value = ConnectionStatus.DISCONNECTED
            onEvent?.invoke(BridgeEvent.Disconnected)
            return
        }

        val delayMs = backoffMs
        bridgeDebug { "scheduleReconnect — attempt=${_reconnectAttempt.value} backoff=${delayMs}ms url=$currentUrl" }
        scope.launch {
            delay(delayMs)
            backoffMs = min(backoffMs * 2, MAX_BACKOFF_MS)
            if (generation.get() == retryGeneration && shouldReconnect && _status.value == ConnectionStatus.DISCONNECTED) {
                doConnect(currentUrl)
            }
        }
    }
}
