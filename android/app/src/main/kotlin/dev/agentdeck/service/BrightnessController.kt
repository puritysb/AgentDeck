package dev.agentdeck.service

import android.content.ContentResolver
import android.content.Context
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import org.json.JSONObject

/**
 * Controls display brightness/timeout in response to host display sleep events.
 *
 * LCD tablets: brightness→0, SCREEN_OFF_TIMEOUT→2s → screen turns off.
 * On wake: restores timeout, wakes screen, restores brightness + mode.
 *
 * E-ink devices: keep the EPD awake, dim only the frontlight/backlight.
 * Primary path is sysfs/procfs frontlight control; fallback is Android's
 * Settings.System brightness for readers whose vendor frontlight node is
 * SELinux-protected. Saved values are persisted for crash recovery.
 */
class BrightnessController(
    private val context: Context,
    private val contentResolver: ContentResolver,
    private val powerManager: PowerManager,
    private val isEink: Boolean,
) {
    companion object {
        private const val TAG = "BrightnessController"
        private const val LCD_OFF_TIMEOUT_MS = 2_000
        private const val PREFS_NAME = "brightness_controller"
        private const val PREF_DIMMED = "is_dimmed"
        private const val PREF_FRONTLIGHT_PREFIX = "frontlight_"
        private const val PREF_SYSTEM_BRIGHTNESS = "system_brightness"
        private const val PREF_SYSTEM_BRIGHTNESS_MODE = "system_brightness_mode"
        private const val PREF_SCREEN_OFF_TIMEOUT = "screen_off_timeout"
        private const val BACKLIGHT_BASE = "/sys/class/backlight"
        private const val RESTORE_FALLBACK_BRIGHTNESS = 128

        /** Known sysfs frontlight device names across e-ink vendors. */
        private val KNOWN_BACKLIGHT_DEVICES = listOf(
            "warm", "white",                       // Crema S (RK3566 B&W)
            "aw99703", "aw99703_sec",              // MOAAN Pantone 6 sysfs (not app-writable)
            "rk_backlight",                        // Generic Rockchip
            "backlight", "lcd-backlight",           // Common Android
        )

        private val KNOWN_FRONTLIGHT_FILES = listOf(
            "/proc/aw99703/led_white",              // MOAAN/Pantone frontlight procfs
            "/proc/aw99703/led_warm",
            "/proc/aw99703/brightness",
        )

        /** Derive a stable SharedPreferences key from path (parent dir name). */
        private fun prefKeyForPath(path: String): String =
            java.io.File(path).parentFile?.name ?: path.substringAfterLast('/')
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val moaanFrontlight = createMoaanFrontlight()
    private val frontlightPaths: List<String> = discoverFrontlightPaths()
    private var isDimmed = false
    /** "mode|level" of the last applied dim, so a live level change (re-dim
     *  while host stays asleep) bypasses the `isDimmed` early-return. */
    private var lastDimSignature = ""
    private var savedBrightness: Int? = null
    private var savedBrightnessMode: Int? = null
    private var savedScreenOffTimeout: Int? = null
    private var savedFrontlight: Map<String, Int>? = null

    init {
        if (isEink && moaanFrontlight?.pending == true) {
            isDimmed = !moaanFrontlight.restore()
        }
        // Recover from crash/restart while dimmed. E-ink should not stay dark
        // if the service died before a wake event; LCD values are kept so a
        // later wake can restore even if the process was recreated.
        if (isEink && prefs.getBoolean(PREF_DIMMED, false)) {
            val saved = mutableMapOf<String, Int>()
            for (path in frontlightPaths) {
                val key = PREF_FRONTLIGHT_PREFIX + prefKeyForPath(path)
                val value = prefs.getInt(key, -1)
                if (value >= 0) saved[path] = value
            }
            if (saved.isNotEmpty()) {
                Log.i(TAG, "Recovering frontlight from previous crash: $saved")
                saved.forEach { (path, value) ->
                    try { java.io.File(path).writeText(value.toString()) }
                    catch (e: Exception) { Log.w(TAG, "Cannot recover $path: ${e.message}") }
                }
            }
            restoreSystemBrightnessIfSaved()
            clearSystemBrightnessPrefs()
        } else if (!isEink && prefs.getBoolean(PREF_DIMMED, false)) {
            isDimmed = true
            savedBrightness = prefs.getInt(PREF_SYSTEM_BRIGHTNESS, -1).takeIf { it >= 0 }
            savedBrightnessMode = prefs.getInt(PREF_SYSTEM_BRIGHTNESS_MODE, -1).takeIf { it >= 0 }
            savedScreenOffTimeout = prefs.getInt(PREF_SCREEN_OFF_TIMEOUT, -1).takeIf { it >= 0 }
        }
    }

    fun canWriteSettings(): Boolean = isEink || Settings.System.canWrite(context)

    /**
     * Dim the screen per the host instruction. [mode] is "off" (full dark) or
     * "min" (dim to [level] percent, screen stays on). Re-invocable while
     * already dimmed to apply a changed level live.
     */
    fun dim(mode: String = "off", level: Int = 0) {
        val sig = "$mode|$level"
        if (isDimmed && sig == lastDimSignature) return

        if (!isEink && !Settings.System.canWrite(context)) {
            Log.w(TAG, "Cannot dim LCD — WRITE_SETTINGS not granted. " +
                "Grant via: adb shell appops set ${context.packageName} WRITE_SETTINGS allow")
            return
        }

        if (isEink && moaanFrontlight?.available == true) {
            val applied = moaanFrontlight.dim(mode, level)
            isDimmed = moaanFrontlight.pending
            lastDimSignature = if (applied) sig else ""
            Log.i(TAG, "MOAAN frontlight mode: ${if (applied) "applied" else "pending retry"} ($mode)")
            return
        }

        val firstDim = !isDimmed
        isDimmed = true
        lastDimSignature = sig

        if (isEink) {
            dimEink(mode, level, firstDim)
        } else {
            dimLcd(mode, level, firstDim)
        }
    }

    fun restore() {
        if (!isDimmed) return
        if (isEink && moaanFrontlight?.pending == true) {
            if (!moaanFrontlight.restore()) {
                Log.w(TAG, "MOAAN frontlight restore pending; original settings retained")
                return
            }
            isDimmed = false
            lastDimSignature = ""
            Log.i(TAG, "MOAAN frontlight mode and presets restored")
            return
        }
        isDimmed = false
        lastDimSignature = ""

        if (isEink) {
            restoreEink()
        } else {
            restoreLcd()
        }
    }

    fun isDimmed(): Boolean = isDimmed

    // ── LCD ─────────────────────────────────────────────────────────────

    private fun dimLcd(mode: String, level: Int, firstDim: Boolean) {
        try {
            // Capture the user's brightness/mode/timeout only on the first dim,
            // so a live level change doesn't save the already-dimmed value.
            if (firstDim) {
                captureSystemBrightness()
            }
            Settings.System.putInt(
                contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
            )
            if (mode == "min") {
                // Keep the screen on at minimum brightness (level% → 0-255),
                // restore the user's screen-off timeout, and wake if it slept.
                val target = (level * 255 / 100).coerceIn(1, 255)
                Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, target)
                savedScreenOffTimeout?.let {
                    Settings.System.putInt(contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, it)
                }
                wakeScreen()
                Log.i(TAG, "LCD dim(min): brightness ${savedBrightness}→$target")
            } else {
                // Full-off: brightness 0 + short timeout so the screen sleeps.
                Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, 0)
                Settings.System.putInt(
                    contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, LCD_OFF_TIMEOUT_MS
                )
                Log.i(TAG, "LCD dim(off): brightness ${savedBrightness}→0, timeout ${savedScreenOffTimeout}→${LCD_OFF_TIMEOUT_MS}ms")
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot dim LCD (no WRITE_SETTINGS): ${e.message}")
            clearSystemBrightnessMemory()
        }
    }

    private fun restoreLcd() {
        try {
            loadSystemBrightnessFromPrefsIfNeeded()
            savedScreenOffTimeout?.let { timeout ->
                Settings.System.putInt(contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, timeout)
            }
            wakeScreen()
            Settings.System.putInt(
                contentResolver,
                Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
            )
            val brightness = (savedBrightness ?: RESTORE_FALLBACK_BRIGHTNESS)
                .takeIf { it > 0 } ?: RESTORE_FALLBACK_BRIGHTNESS
            Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, brightness)
            savedBrightnessMode?.let { mode ->
                Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE, mode)
            }
            Log.i(TAG, "LCD restored: brightness=$brightness, mode=${savedBrightnessMode}, timeout=${savedScreenOffTimeout}")
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot restore LCD: ${e.message}")
        }
        clearSystemBrightnessMemory()
        clearSystemBrightnessPrefs()
    }

    // ── E-ink ───────────────────────────────────────────────────────────

    private fun dimEink(mode: String, level: Int, firstDim: Boolean) {
        // Capture the current frontlight values once, so a live level change
        // (re-dim while asleep) scales from the original, not the dimmed value.
        if (firstDim) {
            val saved = mutableMapOf<String, Int>()
            for (path in frontlightPaths) {
                try {
                    val current = java.io.File(path).readText().trim().toIntOrNull() ?: continue
                    if (current == 0) continue
                    saved[path] = current
                } catch (_: Exception) {}
            }
            savedFrontlight = saved.ifEmpty { null }
            // Persist to disk for crash recovery
            prefs.edit().apply {
                putBoolean(PREF_DIMMED, true)
                saved.forEach { (path, value) ->
                    putInt(PREF_FRONTLIGHT_PREFIX + prefKeyForPath(path), value)
                }
            }.apply()
        }

        // Apply target: full-off ⇒ 0; min ⇒ level% of each path's saved value.
        var sysfsWorked = false
        for (path in frontlightPaths) {
            try {
                val target = if (mode == "min") {
                    val base = savedFrontlight?.get(path) ?: continue
                    (base * level / 100).coerceAtLeast(1)
                } else {
                    0
                }
                java.io.File(path).writeText(target.toString())
                sysfsWorked = true
            } catch (_: Exception) {}
        }

        if (sysfsWorked) {
            Log.i(TAG, "E-ink dim($mode): sysfs OK, ${savedFrontlight?.size ?: 0} paths")
        } else {
            // Pantone 6 and some MOAAN firmwares protect aw99703 nodes from
            // third-party app contexts. Try the Android brightness provider;
            // on several readers this is wired to the frontlight instead of
            // the electrophoretic panel itself.
            if (dimEinkViaSystemBrightness(mode, level, firstDim)) {
                Log.i(TAG, "E-ink dim($mode): system brightness fallback OK")
            } else {
                Log.w(TAG, "E-ink dim: no writable sysfs/procfs or system brightness path")
            }
        }
    }

    private fun restoreEink() {
        val toRestore = savedFrontlight ?: run {
            val fromDisk = mutableMapOf<String, Int>()
            for (path in frontlightPaths) {
                val key = PREF_FRONTLIGHT_PREFIX + prefKeyForPath(path)
                val value = prefs.getInt(key, -1)
                if (value > 0) fromDisk[path] = value
            }
            fromDisk.ifEmpty { null }
        }
        toRestore?.forEach { (path, value) ->
            try { java.io.File(path).writeText(value.toString()) }
            catch (e: Exception) { Log.w(TAG, "Cannot restore $path: ${e.message}") }
        }
        restoreSystemBrightnessIfSaved()
        // Clear disk state
        prefs.edit().apply {
            putBoolean(PREF_DIMMED, false)
            frontlightPaths.forEach { path ->
                remove(PREF_FRONTLIGHT_PREFIX + prefKeyForPath(path))
            }
        }.apply()
        clearSystemBrightnessPrefs()
        Log.i(TAG, "E-ink restored: ${toRestore?.entries?.joinToString { "${prefKeyForPath(it.key)}=${it.value}" } ?: "nothing"}")
        savedFrontlight = null
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private fun createMoaanFrontlight(): MoaanFrontlightControl? {
        if (!isEink) return null
        return try {
            val journal = prefs.getString("moaan_mode_snapshot", null)?.let { raw ->
                val json = JSONObject(raw)
                require(json.getInt("version") == 1)
                val values = json.getJSONObject("presets")
                require(values.keys().asSequence().toSet() == MoaanFrontlightControl.savedKeys.toSet())
                MoaanFrontlightControl.Snapshot(json.getInt("mode"), json.getInt("light"), json.getInt("warm"),
                    json.getBoolean("lightEnabled"), json.getBoolean("warmEnabled"),
                    MoaanFrontlightControl.savedKeys.associateWith { if (values.isNull(it)) null else values.getString(it) })
            }
            MoaanFrontlightControl(
                read = { Settings.Global.getString(contentResolver, it) },
                write = { key, value ->
                    if (value == null) {
                        // putString(null) leaves a null-valued row on this ROM.
                        // Restore a previously absent preset as absent.
                        contentResolver.delete(Settings.Global.getUriFor(key), null, null)
                        true
                    } else Settings.Global.putString(contentResolver, key, value)
                },
                save = { snapshot ->
                    val editor = prefs.edit()
                    if (snapshot == null) editor.remove("moaan_mode_snapshot")
                    else {
                        val values = JSONObject()
                        snapshot.presets.forEach { (key, value) -> values.put(key, value ?: JSONObject.NULL) }
                        editor.putString("moaan_mode_snapshot", JSONObject().put("version", 1)
                            .put("mode", snapshot.mode).put("light", snapshot.light).put("warm", snapshot.warm)
                            .put("lightEnabled", snapshot.lightEnabled).put("warmEnabled", snapshot.warmEnabled)
                            .put("presets", values).toString())
                    }
                    editor.commit()
                }, restored = journal,
            )
        } catch (e: Exception) {
            Log.w(TAG, "MOAAN recovery could not be loaded; journal retained: ${e.message}")
            null
        }
    }

    /** Probe known sysfs backlight device paths. */
    private fun discoverFrontlightPaths(): List<String> {
        val sysfs = KNOWN_BACKLIGHT_DEVICES
            .map { "$BACKLIGHT_BASE/$it/brightness" }
            .filter { path -> try { java.io.File(path).exists() } catch (_: Exception) { false } }
        val procfs = KNOWN_FRONTLIGHT_FILES
            .filter { path -> try { java.io.File(path).exists() } catch (_: Exception) { false } }
        val found = (sysfs + procfs).distinct()
        Log.i(TAG, "Discovered frontlight paths: $found")
        return found
    }

    private fun captureSystemBrightness() {
        savedBrightnessMode = Settings.System.getInt(
            contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE,
            Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
        )
        val currentBrightness = Settings.System.getInt(
            contentResolver, Settings.System.SCREEN_BRIGHTNESS, RESTORE_FALLBACK_BRIGHTNESS
        )
        savedBrightness = currentBrightness.takeIf { it > 0 }
            ?: prefs.getInt(PREF_SYSTEM_BRIGHTNESS, RESTORE_FALLBACK_BRIGHTNESS)
                .takeIf { it > 0 }
            ?: RESTORE_FALLBACK_BRIGHTNESS
        savedScreenOffTimeout = Settings.System.getInt(
            contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, 60_000
        )
        prefs.edit()
            .putBoolean(PREF_DIMMED, true)
            .putInt(PREF_SYSTEM_BRIGHTNESS, savedBrightness ?: RESTORE_FALLBACK_BRIGHTNESS)
            .putInt(PREF_SYSTEM_BRIGHTNESS_MODE, savedBrightnessMode ?: Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
            .putInt(PREF_SCREEN_OFF_TIMEOUT, savedScreenOffTimeout ?: 60_000)
            .apply()
    }

    private fun loadSystemBrightnessFromPrefsIfNeeded() {
        if (savedBrightness == null) {
            savedBrightness = prefs.getInt(PREF_SYSTEM_BRIGHTNESS, -1).takeIf { it >= 0 }
        }
        if (savedBrightnessMode == null) {
            savedBrightnessMode = prefs.getInt(PREF_SYSTEM_BRIGHTNESS_MODE, -1).takeIf { it >= 0 }
        }
        if (savedScreenOffTimeout == null) {
            savedScreenOffTimeout = prefs.getInt(PREF_SCREEN_OFF_TIMEOUT, -1).takeIf { it >= 0 }
        }
    }

    private fun dimEinkViaSystemBrightness(mode: String, level: Int, firstDim: Boolean): Boolean {
        if (!Settings.System.canWrite(context)) return false
        return try {
            if (firstDim || savedBrightness == null) captureSystemBrightness()
            Settings.System.putInt(
                contentResolver,
                Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
            )
            val base = savedBrightness ?: RESTORE_FALLBACK_BRIGHTNESS
            val target = if (mode == "min") {
                (base * level / 100).coerceAtLeast(1)
            } else {
                0
            }
            Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, target)
            true
        } catch (e: SecurityException) {
            Log.w(TAG, "E-ink system brightness fallback denied: ${e.message}")
            false
        }
    }

    private fun restoreSystemBrightnessIfSaved() {
        if (!Settings.System.canWrite(context)) return
        loadSystemBrightnessFromPrefsIfNeeded()
        val brightness = savedBrightness ?: return
        try {
            Settings.System.putInt(
                contentResolver,
                Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
            )
            Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, brightness)
            savedBrightnessMode?.let { mode ->
                Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE, mode)
            }
            Log.i(TAG, "System brightness restored: brightness=$brightness, mode=${savedBrightnessMode}")
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot restore system brightness: ${e.message}")
        }
    }

    private fun clearSystemBrightnessMemory() {
        savedBrightness = null
        savedBrightnessMode = null
        savedScreenOffTimeout = null
    }

    private fun clearSystemBrightnessPrefs() {
        prefs.edit()
            .remove(PREF_SYSTEM_BRIGHTNESS)
            .remove(PREF_SYSTEM_BRIGHTNESS_MODE)
            .remove(PREF_SCREEN_OFF_TIMEOUT)
            .putBoolean(PREF_DIMMED, false)
            .apply()
    }

    private fun wakeScreen() {
        if (!powerManager.isInteractive) {
            @Suppress("DEPRECATION")
            try {
                powerManager.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                    "AgentDeck:ScreenWake"
                ).acquire(3_000L)
                Log.d(TAG, "Acquired SCREEN_BRIGHT wake lock to wake screen")
            } catch (e: Exception) {
                Log.w(TAG, "Wake lock failed, trying KEYCODE_WAKEUP: ${e.message}")
                try { Runtime.getRuntime().exec(arrayOf("input", "keyevent", "KEYCODE_WAKEUP")) }
                catch (e2: Exception) { Log.w(TAG, "KEYCODE_WAKEUP also failed: ${e2.message}") }
            }
        }
    }
}
