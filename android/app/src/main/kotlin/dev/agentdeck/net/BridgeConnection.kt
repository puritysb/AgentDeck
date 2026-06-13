package dev.agentdeck.net

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import kotlin.math.min

private const val TAG = "BridgeConnection"

enum class ConnectionStatus {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
}

class BridgeConnection private constructor() {

    companion object {
        val instance: BridgeConnection by lazy { BridgeConnection() }
        private const val INITIAL_BACKOFF_MS = 1000L
        private const val MAX_BACKOFF_MS = 8_000L
        /** Max localhost retries before giving up and clearing URL for mDNS fallback. */
        private const val MAX_LOCALHOST_ATTEMPTS = 5
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
    private var backoffMs = INITIAL_BACKOFF_MS
    private var shouldReconnect = false

    private val _status = MutableStateFlow(ConnectionStatus.DISCONNECTED)
    val status: StateFlow<ConnectionStatus> = _status.asStateFlow()

    private val _url = MutableStateFlow<String?>(null)
    val url: StateFlow<String?> = _url.asStateFlow()

    /** Last connection error message (cleared on next connect attempt). */
    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    /** True when actively trying to reconnect to a known URL. */
    private val _isReconnecting = MutableStateFlow(false)
    val isReconnecting: StateFlow<Boolean> = _isReconnecting.asStateFlow()

    /** Current reconnect attempt number (reset on connect/disconnect). */
    private val _reconnectAttempt = MutableStateFlow(0)
    val reconnectAttempt: StateFlow<Int> = _reconnectAttempt.asStateFlow()

    var onEvent: ((BridgeEvent) -> Unit)? = null

    fun connect(wsUrl: String) {
        Log.i(TAG, "connect($wsUrl) — current status=${_status.value}")
        // Cancel any existing connection/reconnect loop before starting fresh
        shouldReconnect = false
        webSocket?.close(1000, "New connection")
        webSocket = null

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
        shouldReconnect = false
        _isReconnecting.value = false
        _reconnectAttempt.value = 0
        _url.value = null
        _lastError.value = null
        webSocket?.close(1000, "User disconnect")
        webSocket = null
        _status.value = ConnectionStatus.DISCONNECTED
        onEvent?.invoke(BridgeEvent.Disconnected)
    }

    fun send(message: String) {
        webSocket?.send(message)
    }

    fun sendRespond(value: String) = send(PluginCommands.respond(value))
    fun sendSelectOption(index: Int) = send(PluginCommands.selectOption(index))
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
            Log.d(TAG, "doConnect($wsUrl) — skipped, already CONNECTING")
            return
        }
        Log.i(TAG, "doConnect($wsUrl) — opening WebSocket")
        _status.value = ConnectionStatus.CONNECTING

        val request = Request.Builder()
            .url(wsUrl)
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "onOpen — connected to $wsUrl")
                _status.value = ConnectionStatus.CONNECTED
                _isReconnecting.value = false
                _reconnectAttempt.value = 0
                backoffMs = INITIAL_BACKOFF_MS
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val event = parseBridgeMessage(text)
                if (event != null) {
                    if (event is BridgeEvent.State) {
                        Log.d("Terrarium", "WS raw state_update: agentType=${event.data.agentType}, state=${event.data.state}, gwAvail=${event.data.gatewayAvailable}, gwErr=${event.data.gatewayHasError}")
                    }
                    onEvent?.invoke(event)
                } else {
                    Log.w(TAG, "Unparsed WS message: ${text.take(200)}")
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "onClosing — code=$code reason=$reason")
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.w(TAG, "onClosed — code=$code reason=$reason")
                _status.value = ConnectionStatus.DISCONNECTED
                onEvent?.invoke(BridgeEvent.Disconnected)
                // Don't reconnect on auth rejection — token required
                if (code == 4001) {
                    Log.w(TAG, "Auth rejected (4001) — stopping reconnect")
                    shouldReconnect = false
                    _url.value = null
                    _lastError.value = "Unauthorized — check pairing token"
                } else {
                    scheduleReconnect()
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // Prefer HTTP handshake details when the upgrade was rejected — a bare
                // t.message like "Failed to connect" hides the actual reason (4xx code,
                // server message). When response is null, fall back to the exception.
                val msg = if (response != null) {
                    "HTTP ${response.code} ${response.message} — ${t.message ?: t.javaClass.simpleName}"
                } else {
                    "${t.javaClass.simpleName}: ${t.message ?: "unknown"}"
                }
                Log.e(TAG, "onFailure — $msg", t)
                _status.value = ConnectionStatus.DISCONNECTED
                _lastError.value = msg
                onEvent?.invoke(BridgeEvent.Disconnected)
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        val currentUrl = _url.value ?: return

        _isReconnecting.value = true
        _reconnectAttempt.value++

        val isLocalhost = isLocalhostUrl(currentUrl)

        // Fast-fail: after a short burst of retries (5), give up and clear the URL
        // so the caller's LaunchedEffect can trigger mDNS discovery.
        // Continuing to hammer a stale/dead URL would block the discovery path indefinitely.
        if (_reconnectAttempt.value > MAX_LOCALHOST_ATTEMPTS) {
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
        Log.d(TAG, "scheduleReconnect — attempt=${_reconnectAttempt.value} backoff=${delayMs}ms url=$currentUrl")
        scope.launch {
            delay(delayMs)
            backoffMs = min(backoffMs * 2, MAX_BACKOFF_MS)
            if (shouldReconnect && _status.value == ConnectionStatus.DISCONNECTED) {
                doConnect(currentUrl)
            }
        }
    }
}
