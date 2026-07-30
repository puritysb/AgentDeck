package dev.agentdeck

import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.util.PanelOverride
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Recreate policy for the two device-class preferences, and in particular the
 * recovery case when the bounded startup read expires.
 *
 * `MainActivity` builds its whole UI tree — plus window flags e-ink readers only
 * honour before the first frame — from a synchronous read of these two keys. If
 * that read times out the instance is built from defaults, and the defaults are
 * not neutral: `allowUnsupportedDevice = false` re-blocks a user who had already
 * chosen to show the dashboard anyway.
 */
class MainActivityOverrideRecoveryTest {

    @Test
    fun `no recreate when storage matches what the instance was built from`() {
        assertFalse(
            shouldRecreateForDeviceOverrides(
                appliedPanelOverride = PanelOverride.Auto,
                appliedAllowUnsupported = false,
                storedPanelOverride = PanelOverride.Auto,
                storedAllowUnsupported = false,
            )
        )
        assertFalse(
            shouldRecreateForDeviceOverrides(
                appliedPanelOverride = PanelOverride.Eink,
                appliedAllowUnsupported = true,
                storedPanelOverride = PanelOverride.Eink,
                storedAllowUnsupported = true,
            )
        )
    }

    @Test
    fun `recreate when the user changes the panel override`() {
        assertTrue(
            shouldRecreateForDeviceOverrides(
                appliedPanelOverride = PanelOverride.Auto,
                appliedAllowUnsupported = false,
                storedPanelOverride = PanelOverride.Lcd,
                storedAllowUnsupported = false,
            )
        )
    }

    @Test
    fun `expired startup read recovers a persisted show-anyway choice`() {
        // The regression: the timeout leaves allowUnsupported=false while storage
        // says true, and the stored panel override is the default Auto — so a
        // panel-override-only comparison sees no difference and the user stays
        // blocked on the unsupported-device screen.
        assertTrue(
            shouldRecreateForDeviceOverrides(
                appliedPanelOverride = PanelOverride.Auto,
                appliedAllowUnsupported = false,
                storedPanelOverride = PanelOverride.Auto,
                storedAllowUnsupported = true,
            )
        )
    }

    @Test
    fun `pressing show anyway takes effect through the same comparison`() {
        // The button only persists; this comparison is what drives the recreate,
        // so the button and the timeout recovery share one mechanism.
        assertTrue(
            shouldRecreateForDeviceOverrides(
                appliedPanelOverride = PanelOverride.Auto,
                appliedAllowUnsupported = false,
                storedPanelOverride = PanelOverride.Auto,
                storedAllowUnsupported = true,
            )
        )
    }

    @Test
    fun `a timed-out startup read is distinguishable from genuine defaults`() {
        // Both carry the same values, so the flag is the only thing that says
        // whether they were confirmed against storage.
        val timedOut = DisplayPreferences.StartupOverrides(timedOut = true)
        val genuine = DisplayPreferences.StartupOverrides()

        assertEquals(PanelOverride.Auto, timedOut.panelOverride)
        assertFalse(timedOut.allowUnsupportedDevice)
        assertTrue(timedOut.timedOut)
        assertFalse(genuine.timedOut)
    }
}
