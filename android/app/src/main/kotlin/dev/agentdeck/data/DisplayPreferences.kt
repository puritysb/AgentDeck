package dev.agentdeck.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.agentdeck.util.PanelOverride
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

private val Context.dataStore by preferencesDataStore("display_prefs")

class DisplayPreferences(
    private val context: Context,
    private val isEink: Boolean = false,
) {

    companion object {
        private val ORIENTATION_KEY = intPreferencesKey("orientation")
        private val KEEP_AWAKE_KEY = booleanPreferencesKey("keep_awake")
        private val LAST_BRIDGE_URL_KEY = stringPreferencesKey("last_bridge_url")
        private val DISPLAY_SYNC_ENABLED_KEY = booleanPreferencesKey("display_sync_enabled")
        private val IDLE_TIMEOUT_MINUTES_KEY = intPreferencesKey("idle_timeout_minutes")
        private val SHOW_SESSION_LIST_KEY = booleanPreferencesKey("show_session_list")
        private val SHOW_TANK_STATUS_KEY = booleanPreferencesKey("show_tank_status")
        private val SHOW_DEVICE_DIAGNOSTIC_KEY = booleanPreferencesKey("show_device_diagnostic")
        private val SHOW_TIMELINE_KEY = booleanPreferencesKey("show_timeline")
        private val SHOW_SETTINGS_BUTTON_KEY = booleanPreferencesKey("show_settings_button")
        private val PANEL_OVERRIDE_KEY = stringPreferencesKey("panel_override")
        private val ALLOW_UNSUPPORTED_KEY = booleanPreferencesKey("allow_unsupported_device")

        private const val STARTUP_READ_TIMEOUT_MS = 500L
    }

    val orientationFlow: Flow<Int> = context.dataStore.data.map { prefs ->
        prefs[ORIENTATION_KEY] ?: DashboardOrientation.defaultFor(isEink)
    }

    val keepAwakeFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[KEEP_AWAKE_KEY] ?: true
    }

    suspend fun setOrientation(orientation: Int) {
        context.dataStore.edit { prefs ->
            prefs[ORIENTATION_KEY] = orientation
        }
    }

    suspend fun setKeepAwake(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[KEEP_AWAKE_KEY] = enabled
        }
    }

    val lastBridgeUrlFlow: Flow<String?> = context.dataStore.data.map { prefs ->
        prefs[LAST_BRIDGE_URL_KEY]
    }

    suspend fun setLastBridgeUrl(url: String?) {
        context.dataStore.edit { prefs ->
            if (url != null) {
                prefs[LAST_BRIDGE_URL_KEY] = url
            } else {
                prefs.remove(LAST_BRIDGE_URL_KEY)
            }
        }
    }

    val displaySyncEnabledFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[DISPLAY_SYNC_ENABLED_KEY] ?: true
    }

    suspend fun setDisplaySyncEnabled(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[DISPLAY_SYNC_ENABLED_KEY] = enabled
        }
    }

    val idleTimeoutMinutesFlow: Flow<Int> = context.dataStore.data.map { prefs ->
        prefs[IDLE_TIMEOUT_MINUTES_KEY] ?: 5
    }

    suspend fun setIdleTimeoutMinutes(minutes: Int) {
        context.dataStore.edit { prefs ->
            prefs[IDLE_TIMEOUT_MINUTES_KEY] = minutes
        }
    }

    val showSessionListFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SHOW_SESSION_LIST_KEY] ?: true
    }

    suspend fun setShowSessionList(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[SHOW_SESSION_LIST_KEY] = enabled
        }
    }

    val showTankStatusFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SHOW_TANK_STATUS_KEY] ?: true
    }

    suspend fun setShowTankStatus(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[SHOW_TANK_STATUS_KEY] = enabled
        }
    }

    val showDeviceDiagnosticFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SHOW_DEVICE_DIAGNOSTIC_KEY] ?: true
    }

    suspend fun setShowDeviceDiagnostic(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[SHOW_DEVICE_DIAGNOSTIC_KEY] = enabled
        }
    }

    val showTimelineFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SHOW_TIMELINE_KEY] ?: true
    }

    suspend fun setShowTimeline(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[SHOW_TIMELINE_KEY] = enabled
        }
    }

    val showSettingsButtonFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SHOW_SETTINGS_BUTTON_KEY] ?: true
    }

    suspend fun setShowSettingsButton(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[SHOW_SETTINGS_BUTTON_KEY] = enabled
        }
    }

    /**
     * Manual panel classification. Auto-detection covers the readers we know
     * about plus anything exposing a vendor EPD surface, but an unlisted reader
     * with no vendor layer — or, in the other direction, an emissive device
     * whose build strings happen to mention e-ink — needs a way out that does
     * not require an app update.
     */
    val panelOverrideFlow: Flow<PanelOverride> = context.dataStore.data.map { prefs ->
        PanelOverride.fromStored(prefs[PANEL_OVERRIDE_KEY])
    }

    suspend fun setPanelOverride(override: PanelOverride) {
        context.dataStore.edit { prefs ->
            prefs[PANEL_OVERRIDE_KEY] = override.toStored()
        }
    }

    /**
     * Set once the user chooses "show it anyway" on the unsupported-device
     * screen. Persisted rather than session-local because the dashboard is a
     * launcher: an activity recreate must not silently revoke the choice.
     */
    val allowUnsupportedDeviceFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[ALLOW_UNSUPPORTED_KEY] ?: false
    }

    suspend fun setAllowUnsupportedDevice(allow: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[ALLOW_UNSUPPORTED_KEY] = allow
        }
    }

    /**
     * Both device-class preferences from a **single** DataStore snapshot.
     *
     * One snapshot rather than two `first()` calls: the two keys are read
     * together to decide one thing (which screen to compose), so reading them
     * from separate emissions both doubles the read cost inside the startup
     * budget and admits a torn pair.
     */
    suspend fun readOverrides(): StartupOverrides {
        val prefs = context.dataStore.data.first()
        return StartupOverrides(
            panelOverride = PanelOverride.fromStored(prefs[PANEL_OVERRIDE_KEY]),
            allowUnsupportedDevice = prefs[ALLOW_UNSUPPORTED_KEY] ?: false,
            timedOut = false,
        )
    }

    /**
     * Device-class decisions that must be known *before* the first frame:
     * e-ink readers on RK3566 ignore a late `requestedOrientation`, so the
     * panel kind has to be settled while `onCreate` is still running.
     *
     * DataStore is asynchronous, so this blocks — bounded, and with safe
     * defaults on timeout. A timeout is reported in [StartupOverrides.timedOut]
     * rather than being indistinguishable from genuinely-default preferences:
     * the defaults are not neutral (`allowUnsupportedDevice = false` re-blocks a
     * user who previously chose to show the dashboard anyway), so the caller has
     * to know the values are provisional. `MainActivity` recovers by observing
     * both keys and recreating once the real pair arrives.
     */
    fun readStartupOverridesBlocking(
        timeoutMs: Long = STARTUP_READ_TIMEOUT_MS,
    ): StartupOverrides = runBlocking {
        withTimeoutOrNull(timeoutMs) { readOverrides() }
            ?: StartupOverrides(timedOut = true)
    }

    /** Snapshot of the pre-first-frame preferences. */
    data class StartupOverrides(
        val panelOverride: PanelOverride = PanelOverride.Auto,
        val allowUnsupportedDevice: Boolean = false,
        /**
         * True when the bounded read expired, so the other fields are defaults
         * that have not been confirmed against storage.
         */
        val timedOut: Boolean = false,
    )
}
