package dev.agentdeck.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import dev.agentdeck.AgentDeckApp
import dev.agentdeck.MainActivity
import dev.agentdeck.R
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.DimConfig
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.ui.component.stateLabel
import dev.agentdeck.util.EinkDetector
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MonitorService : Service() {

    companion object {
        private const val TAG = "MonitorService"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP = "dev.agentdeck.STOP_MONITOR"
        private const val KEEPALIVE_INTERVAL_MS = 60_000L
        // BIT_PLUGGED_AC | BIT_PLUGGED_USB — stay on while charging via either
        private const val STAY_ON_PLUGGED = 3
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var lastState: AgentState = AgentState.DISCONNECTED
    private var cpuWakeLock: PowerManager.WakeLock? = null
    private val isEink = EinkDetector.isEinkDevice()
    private val handler = Handler(Looper.getMainLooper())
    private var savedStayOn: Int? = null
    private var savedScreenOffTimeout: Int? = null
    private lateinit var brightnessController: BrightnessController
    private lateinit var displayPrefs: DisplayPreferences
    private var idleTimeoutJob: Job? = null

    private val keepaliveRunnable = object : Runnable {
        override fun run() {
            ensureStayAwake()
            handler.postDelayed(this, KEEPALIVE_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        brightnessController = BrightnessController(this, contentResolver, pm, isEink)
        displayPrefs = DisplayPreferences(this, isEink)

        acquireCpuWakeLock()

        if (isEink) {
            enableStayOn()
            handler.postDelayed(keepaliveRunnable, KEEPALIVE_INTERVAL_MS)
        }

        serviceScope.launch {
            AgentStateHolder.instance.state.collect { state ->
                if (state.agentState != lastState) {
                    lastState = state.agentState
                    updateNotification(state.agentState, state.projectName)
                    // Only wake screen if host display is on
                    if (isEink && state.hostDisplayOn) wakeIfSleeping()
                }
                handleDisplaySync(state.hostDisplayOn, state.bridgeConnected, state.agentState, state.hostDim)
            }
        }
    }

    private fun handleDisplaySync(hostDisplayOn: Boolean, bridgeConnected: Boolean, agentState: AgentState, hostDim: DimConfig?) {
        serviceScope.launch {
            val syncEnabled = displayPrefs.displaySyncEnabledFlow.first()
            // Host dim instruction (absent ⇒ legacy enabled/full-off).
            val dimEnabled = hostDim?.enabled ?: true
            val dimMode = if (hostDim?.mode == "min") "min" else "off"
            val dimLevel = (hostDim?.level ?: 10).coerceIn(1, 100)
            Log.d(TAG, "handleDisplaySync: hostDisplayOn=$hostDisplayOn, bridgeConnected=$bridgeConnected, agentState=$agentState, syncEnabled=$syncEnabled, dim=$dimEnabled/$dimMode/$dimLevel, isDimmed=${brightnessController.isDimmed()}, canWrite=${brightnessController.canWriteSettings()}")

            if (!syncEnabled) {
                // Sync disabled — restore if we dimmed, cancel any idle timeout
                if (brightnessController.isDimmed()) {
                    Log.d(TAG, "Sync disabled — restoring brightness")
                    brightnessController.restore()
                }
                idleTimeoutJob?.cancel()
                idleTimeoutJob = null
                return@launch
            }

            if (bridgeConnected) {
                // Bridge connected — use host display state directly
                idleTimeoutJob?.cancel()
                idleTimeoutJob = null
                if (!hostDisplayOn && dimEnabled) {
                    Log.i(TAG, "Host display off — dimming ($dimMode)")
                    brightnessController.dim(dimMode, dimLevel)
                } else {
                    // Display on, or host disabled device dimming → restore.
                    if (brightnessController.isDimmed()) {
                        Log.i(TAG, "Host display on / dim disabled — restoring brightness")
                    }
                    brightnessController.restore()
                }
            } else {
                // Bridge not connected — use idle timeout fallback
                // If dimmed from previous bridge-connected sync, restore immediately
                if (brightnessController.isDimmed()) {
                    Log.d(TAG, "Bridge disconnected while dimmed — restoring brightness")
                    brightnessController.restore()
                }
                val isIdle = agentState == AgentState.DISCONNECTED || agentState == AgentState.IDLE
                if (isIdle) {
                    if (idleTimeoutJob == null) {
                        val timeoutMinutes = displayPrefs.idleTimeoutMinutesFlow.first()
                        Log.d(TAG, "Starting idle timeout: ${timeoutMinutes}m")
                        idleTimeoutJob = serviceScope.launch {
                            delay(timeoutMinutes * 60_000L)
                            Log.i(TAG, "Idle timeout reached — dimming")
                            brightnessController.dim()
                        }
                    }
                } else {
                    // Agent active — cancel timeout and restore
                    idleTimeoutJob?.cancel()
                    idleTimeoutJob = null
                    brightnessController.restore()
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            BridgeConnection.instance.disconnect()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification(AgentState.DISCONNECTED, null))
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        idleTimeoutJob?.cancel()
        if (brightnessController.isDimmed()) brightnessController.restore()
        handler.removeCallbacks(keepaliveRunnable)
        restoreStayOn()
        releaseCpuWakeLock()
        serviceScope.cancel()
        super.onDestroy()
    }

    // --- CPU wake lock (PARTIAL — keeps CPU from sleeping) ---

    private fun acquireCpuWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AgentDeck:CPU")
            wl.acquire()
            // Some vendor firmware (e.g. Crema) silently rejects wake locks —
            // acquire() doesn't throw but isHeld returns false.
            if (wl.isHeld) {
                cpuWakeLock = wl
                Log.i(TAG, "CPU wake lock acquired")
            } else {
                Log.w(TAG, "CPU wake lock silently rejected by firmware — relying on system settings")
            }
        } catch (e: Exception) {
            Log.w(TAG, "CPU wake lock failed: ${e.message}")
        }
    }

    private fun releaseCpuWakeLock() {
        cpuWakeLock?.let { if (it.isHeld) it.release() }
        cpuWakeLock = null
    }

    // --- System-level stay-on (e-ink devices block wake locks, so use settings instead) ---

    private fun enableStayOn() {
        // Strategy 1: stay_on_while_plugged_in (Global setting)
        // This is a system-level policy — vendor firmware respects it even when
        // it blocks third-party wake locks. Requires WRITE_SECURE_SETTINGS
        // (granted via: adb shell pm grant dev.agentdeck android.permission.WRITE_SECURE_SETTINGS)
        try {
            savedStayOn = Settings.Global.getInt(
                contentResolver, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, 0
            )
            Settings.Global.putInt(
                contentResolver, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, STAY_ON_PLUGGED
            )
            Log.i(TAG, "stay_on_while_plugged_in: $savedStayOn → $STAY_ON_PLUGGED")
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot set stay_on_while_plugged_in (need WRITE_SECURE_SETTINGS via adb): ${e.message}")
            savedStayOn = null
        }

        // Strategy 2: screen_off_timeout (System setting)
        // Extend to max so OS sleep timer doesn't fire.
        // Requires WRITE_SETTINGS permission.
        try {
            savedScreenOffTimeout = Settings.System.getInt(
                contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, 60_000
            )
            Settings.System.putInt(
                contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, Int.MAX_VALUE
            )
            Log.i(TAG, "screen_off_timeout: ${savedScreenOffTimeout}ms → max")
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot set screen_off_timeout (no WRITE_SETTINGS): ${e.message}")
            savedScreenOffTimeout = null
        }
    }

    private fun restoreStayOn() {
        savedStayOn?.let { saved ->
            try {
                Settings.Global.putInt(
                    contentResolver, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, saved
                )
                Log.i(TAG, "stay_on_while_plugged_in restored to $saved")
            } catch (e: SecurityException) {
                Log.w(TAG, "Cannot restore stay_on_while_plugged_in: ${e.message}")
            }
        }
        savedStayOn = null

        savedScreenOffTimeout?.let { saved ->
            try {
                Settings.System.putInt(
                    contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, saved
                )
                Log.i(TAG, "screen_off_timeout restored to ${saved}ms")
            } catch (e: SecurityException) {
                Log.w(TAG, "Cannot restore screen_off_timeout: ${e.message}")
            }
        }
        savedScreenOffTimeout = null
    }

    // --- Periodic keepalive: re-check system settings haven't been reverted ---

    private fun ensureStayAwake() {
        // Re-acquire CPU wake lock only if we successfully held one before
        cpuWakeLock?.let { wl ->
            if (!wl.isHeld) {
                Log.w(TAG, "CPU wake lock released — re-acquiring")
                wl.acquire()
            }
        }
        // Re-apply stay_on if another app or system reset it
        // (keep device awake even when dimmed — frontlight off ≠ sleep)
        try {
            val current = Settings.Global.getInt(
                contentResolver, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, 0
            )
            if (current == 0) {
                Settings.Global.putInt(
                    contentResolver, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, STAY_ON_PLUGGED
                )
                Log.w(TAG, "stay_on_while_plugged_in was reset — re-applied")
            }
        } catch (_: SecurityException) { /* no permission */ }
    }

    // --- Wake screen on state change (e-ink: use input event as wake locks are blocked) ---

    private fun wakeIfSleeping() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isInteractive) {
            // Use input keyevent — more reliable than wake locks on devices that block them
            try {
                Runtime.getRuntime().exec(arrayOf("input", "keyevent", "KEYCODE_WAKEUP"))
                Log.d(TAG, "Sent KEYCODE_WAKEUP to wake screen")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to send KEYCODE_WAKEUP: ${e.message}")
                // Fallback: try wake lock anyway (may be blocked but harmless)
                @Suppress("DEPRECATION")
                try {
                    pm.newWakeLock(
                        PowerManager.SCREEN_DIM_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                        "AgentDeck:ScreenRefresh"
                    ).acquire(3_000L)
                } catch (_: Exception) { }
            }
        }
    }

    // --- Notifications ---

    private fun updateNotification(state: AgentState, projectName: String?) {
        val notification = buildNotification(state, projectName)
        val manager = getSystemService(android.app.NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(state: AgentState, projectName: String?): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val openPending = PendingIntent.getActivity(
            this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, MonitorService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this, 0, stopIntent, PendingIntent.FLAG_IMMUTABLE
        )

        val title = projectName ?: "AgentDeck"
        val text = stateLabel(state)

        return NotificationCompat.Builder(this, AgentDeckApp.CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(openPending)
            .addAction(0, "Stop", stopPending)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }
}
