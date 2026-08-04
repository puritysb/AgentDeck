package dev.agentdeck.util

import android.content.Context
import android.util.Log
import dev.agentdeck.AgentDeckApp
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Process-wide access to the resolved [DeviceProfile].
 *
 * `MainActivity` resolves the profile once — with the user's panel override
 * applied — and [install]s it before the first frame. Everything that needs the
 * device class but has no `Context` at hand (the terrarium renderer, the
 * WebSocket registration payload) reads [current] instead of re-deriving a
 * class from `Build.*`, so an overridden panel is honoured everywhere rather
 * than only in the UI tree.
 *
 * Reads before [install] fall back to auto-detection against the application
 * context, and to an LCD profile if even that is unavailable (unit tests that
 * never start the Application). The fallback is cached the same way, so the
 * value stays stable within a process.
 */
object DeviceProfileHolder {

    @Volatile
    private var installed: DeviceProfile? = null

    @Volatile
    private var authoritative = false

    private val listeners = CopyOnWriteArraySet<(DeviceProfile) -> Unit>()

    /**
     * Publish the authoritative profile — one resolved *with* the user's panel
     * override applied. Called from `MainActivity.onCreate` and
     * `MonitorService.onCreate`, whichever runs first. Re-installing the same
     * value only logs once; a genuine change (the user flipping the override)
     * is logged because it implies an activity recreate.
     */
    @Synchronized
    fun install(profile: DeviceProfile): Boolean {
        val previous = installed
        authoritative = true
        if (previous == profile) return false
        installed = profile
        if (previous == null) {
            Log.i(TAG, "Device profile: ${profile.describe()}")
        } else {
            Log.i(TAG, "Device profile changed: ${previous.describe()} → ${profile.describe()}")
        }
        listeners.forEach { listener ->
            try {
                listener(profile)
            } catch (error: Throwable) {
                Log.w(TAG, "Device profile listener failed: ${error.message}")
            }
        }
        return true
    }

    /** Subscribe to genuine profile changes. Installing the same value is a no-op. */
    fun addListener(listener: (DeviceProfile) -> Unit) {
        listeners.add(listener)
    }

    fun removeListener(listener: (DeviceProfile) -> Unit) {
        listeners.remove(listener)
    }

    /**
     * True once [install] has published an override-aware profile. Lets a second
     * entry point skip its own blocking preference read instead of duplicating
     * the work the first one already did.
     */
    val hasAuthoritativeProfile: Boolean
        get() = authoritative

    /**
     * The current profile, auto-detecting if nothing has been installed yet.
     */
    val current: DeviceProfile
        get() = installed ?: fallback()

    private fun fallback(): DeviceProfile {
        val context = applicationContextOrNull()
        val profile = if (context != null) {
            DeviceProfile.detect(context)
        } else {
            // No Application yet (unit tests, very early static init). LCD is
            // the safe default: it never forces landscape and never writes
            // system rotation settings.
            classifyDevice(
                DeviceFingerprint(
                    manufacturer = "",
                    brand = "",
                    model = "",
                    product = "",
                    device = "",
                    hardware = "",
                    characteristics = "",
                    hasVendorEinkApi = false,
                    hasEinkSystemProperty = false,
                    hasColorEinkSignal = false,
                    hasTouchScreen = true,
                    uiModeType = 0,
                    shortestWidthDp = DeviceProfile.MEDIUM_MIN_WIDTH_DP,
                )
            )
        }
        installed = profile
        return profile
    }

    private fun applicationContextOrNull(): Context? = try {
        AgentDeckApp.instance.applicationContext
    } catch (_: Throwable) {
        null
    }

    private const val TAG = "DeviceProfile"
}
