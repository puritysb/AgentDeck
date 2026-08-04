package dev.agentdeck.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DeviceProfileHolderTest {

    @Test
    fun `listeners receive genuine changes but not repeated installation`() {
        val original = DeviceProfileHolder.current
        val first = profile(PanelKind.Lcd, "Holder LCD")
        val second = profile(PanelKind.EinkMono, "Holder E-ink")
        DeviceProfileHolder.install(first)

        val seen = mutableListOf<DeviceProfile>()
        val listener: (DeviceProfile) -> Unit = { seen += it }
        DeviceProfileHolder.addListener(listener)
        try {
            assertTrue(DeviceProfileHolder.install(second))
            assertFalse(DeviceProfileHolder.install(second))
            assertEquals(listOf(second), seen)
        } finally {
            DeviceProfileHolder.removeListener(listener)
            DeviceProfileHolder.install(original)
        }
    }

    private fun profile(panel: PanelKind, name: String) = DeviceProfile(
        panel = panel,
        sizeClass = ScreenSizeClass.Medium,
        formFactor = if (panel.isEink) FormFactor.Reader else FormFactor.Tablet,
        support = SupportLevel.Full,
        unsupportedReason = null,
        caveats = emptyList(),
        einkEvidence = if (panel.isEink) EinkEvidence.UserOverride else EinkEvidence.None,
        shortestWidthDp = 600,
        overridden = true,
        displayName = name,
        shortLabel = if (panel.isEink) "Reader" else "Tablet",
    )
}
