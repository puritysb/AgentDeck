package dev.agentdeck.util

import android.content.res.Configuration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Rules for [classifyDevice]. Pure input → pure output, so no Robolectric.
 *
 * The false-positive cases are the point of the exercise: the previous detector
 * matched bare model substrings and handed a monochrome e-ink dashboard —
 * forced landscape and system-rotation writes included — to ordinary phones.
 */
class DeviceProfileTest {

    // MARK: - False positives the bare-substring detector produced

    @Test
    fun `redmi note is not an eink device`() {
        val profile = classifyDevice(fingerprint(manufacturer = "Xiaomi", brand = "Redmi", model = "Redmi Note 13"))
        assertEquals(PanelKind.Lcd, profile.panel)
        assertEquals(EinkEvidence.None, profile.einkEvidence)
    }

    @Test
    fun `huawei nova is not an eink device`() {
        val profile = classifyDevice(fingerprint(manufacturer = "HUAWEI", model = "nova 11"))
        assertEquals(PanelKind.Lcd, profile.panel)
    }

    @Test
    fun `generic models named leaf or poke are not eink devices`() {
        listOf("Leaf Phone X", "Pokemon Poke Tab", "Galaxy Note20 Ultra").forEach { model ->
            val profile = classifyDevice(fingerprint(manufacturer = "Samsung", model = model))
            assertEquals("$model must not classify as e-ink", PanelKind.Lcd, profile.panel)
        }
    }

    @Test
    fun `oneplus x is not an eink device despite its onyx codename`() {
        // Device codename collision: the OnePlus X is an LCD phone whose
        // DEVICE/PRODUCT is "onyx". Vendor rules must read identity fields only.
        val profile = classifyDevice(
            fingerprint(
                manufacturer = "OnePlus",
                brand = "OnePlus",
                model = "ONE E1003",
                product = "onyx",
                device = "onyx",
            )
        )
        assertEquals(PanelKind.Lcd, profile.panel)
    }

    @Test
    fun `reader with a generic manufacturer is detected from the brand in its model`() {
        val profile = classifyDevice(fingerprint(manufacturer = "rockchip", model = "Onyx Boox Nova3"))
        assertEquals(PanelKind.EinkMono, profile.panel)
        assertEquals(EinkEvidence.KnownVendor, profile.einkEvidence)
    }

    @Test
    fun `hisense lcd phone is not an eink device`() {
        // Hisense ships both, so a model token is required — the bare
        // manufacturer must not be decisive.
        val profile = classifyDevice(fingerprint(manufacturer = "Hisense", model = "Infinity H60"))
        assertEquals(PanelKind.Lcd, profile.panel)
    }

    @Test
    fun `hisense q5 is a reflective lcd not an eink panel`() {
        // The Q5 (HITV105C) is a monochrome reflective LCD with no EPD
        // controller. Classifying it as e-ink would switch on the e-ink UI,
        // vendor refresh modes and forced landscape — none of which apply.
        listOf("HITV105C", "Hisense Q5", "Q5").forEach { model ->
            val profile = classifyDevice(fingerprint(manufacturer = "Hisense", model = model))
            assertEquals("$model must classify as LCD", PanelKind.Lcd, profile.panel)
            assertEquals(EinkEvidence.None, profile.einkEvidence)
        }
    }

    @Test
    fun `hisense eink reader is detected by model`() {
        val profile = classifyDevice(fingerprint(manufacturer = "Hisense", model = "Hi Reader A5"))
        assertEquals(PanelKind.EinkMono, profile.panel)
        assertEquals(EinkEvidence.KnownModel, profile.einkEvidence)
    }

    @Test
    fun `hisense lcd television model numbers do not match short eink families`() {
        listOf("75A7N", "43A7N").forEach { model ->
            val profile = classifyDevice(
                fingerprint(
                    manufacturer = "Hisense",
                    model = model,
                    hasTouchScreen = false,
                    uiModeType = Configuration.UI_MODE_TYPE_TELEVISION,
                    shortestWidthDp = 960,
                )
            )
            assertEquals("$model must remain LCD", PanelKind.Lcd, profile.panel)
            assertEquals(FormFactor.Television, profile.formFactor)
            assertEquals(EinkEvidence.None, profile.einkEvidence)
        }
    }

    @Test
    fun `verified hisense eink families retain model detection`() {
        listOf("A5", "A5 Pro", "A5C", "A7", "A7 CC", "A7CC", "A9", "A9 Pro", "HiReader")
            .forEach { model ->
                val profile = classifyDevice(fingerprint(manufacturer = "Hisense", model = model))
                assertTrue("$model must remain e-ink", profile.panel.isEink)
                assertEquals(EinkEvidence.KnownModel, profile.einkEvidence)
            }
    }

    // MARK: - Devices the previous detector recognised must keep working

    @Test
    fun `crema stays eink`() {
        val profile = classifyDevice(fingerprint(manufacturer = "crema", model = "Crema S"))
        assertEquals(PanelKind.EinkMono, profile.panel)
        assertEquals(EinkEvidence.KnownVendor, profile.einkEvidence)
        assertEquals(FormFactor.Reader, profile.formFactor)
    }

    @Test
    fun `onyx boox stays eink`() {
        val profile = classifyDevice(fingerprint(manufacturer = "ONYX", model = "Nova3"))
        assertEquals(PanelKind.EinkMono, profile.panel)
    }

    @Test
    fun `kobo stays eink`() {
        val profile = classifyDevice(fingerprint(manufacturer = "Kobo", model = "Clara HD"))
        assertEquals(PanelKind.EinkMono, profile.panel)
    }

    @Test
    fun `moaan pantone is color eink`() {
        val profile = classifyDevice(fingerprint(manufacturer = "MOAAN", model = "Pantone 6"))
        assertEquals(PanelKind.EinkColor, profile.panel)
        assertTrue(profile.isColorEink)
    }

    @Test
    fun `onyx note air 3 c is color eink`() {
        val profile = classifyDevice(fingerprint(manufacturer = "ONYX", model = "Note Air3 C"))
        assertEquals(PanelKind.EinkColor, profile.panel)
    }

    @Test
    fun `onyx mono model is not color eink`() {
        val profile = classifyDevice(fingerprint(manufacturer = "ONYX", model = "Note Air3"))
        assertEquals(PanelKind.EinkMono, profile.panel)
    }

    // MARK: - Capability probes widen coverage past the allowlists

    @Test
    fun `unlisted reader with vendor eink api is detected`() {
        val profile = classifyDevice(
            fingerprint(manufacturer = "SomeNewReaderCo", model = "R7", hasVendorEinkApi = true)
        )
        assertEquals(PanelKind.EinkMono, profile.panel)
        assertEquals(EinkEvidence.VendorApi, profile.einkEvidence)
        // A strong signal must not raise the "verify this" caveat.
        assertFalse(profile.caveats.contains(DeviceCaveat.UnverifiedEinkPanel))
    }

    @Test
    fun `unlisted reader with eink system property is detected`() {
        val profile = classifyDevice(
            fingerprint(manufacturer = "Unknown", model = "X1", hasEinkSystemProperty = true)
        )
        assertEquals(EinkEvidence.SystemProperty, profile.einkEvidence)
    }

    @Test
    fun `build characteristics eink is detected`() {
        val profile = classifyDevice(
            fingerprint(manufacturer = "rockchip", model = "rk3566", characteristics = "tablet,eink")
        )
        assertEquals(EinkEvidence.BuildCharacteristics, profile.einkEvidence)
    }

    @Test
    fun `build string only match is flagged as unverified`() {
        val profile = classifyDevice(
            fingerprint(manufacturer = "Unknown", model = "Slate", product = "eink_slate")
        )
        assertEquals(PanelKind.EinkMono, profile.panel)
        assertEquals(EinkEvidence.BuildString, profile.einkEvidence)
        assertTrue(profile.caveats.contains(DeviceCaveat.UnverifiedEinkPanel))
    }

    @Test
    fun `color signal upgrades an otherwise mono verdict`() {
        val profile = classifyDevice(
            fingerprint(
                manufacturer = "Unknown",
                model = "X1",
                hasVendorEinkApi = true,
                hasColorEinkSignal = true,
            )
        )
        assertEquals(PanelKind.EinkColor, profile.panel)
    }

    @Test
    fun `color signal alone establishes eink evidence`() {
        val profile = classifyDevice(
            fingerprint(
                manufacturer = "Unknown",
                model = "Color Reader",
                hasColorEinkSignal = true,
            )
        )
        assertEquals(PanelKind.EinkColor, profile.panel)
        assertEquals(EinkEvidence.SystemProperty, profile.einkEvidence)
    }

    // MARK: - System property truthiness

    @Test
    fun `false-like property values are not eink signals`() {
        // Vendors ship these keys defined and negative. An `isNotEmpty()` check
        // reads `ro.eink_display=false` and `persist.sys.eink.mode=0` as "this
        // is an e-ink panel", which misclassifies ordinary LCD builds.
        listOf("", "  ", "0", "false", "FALSE", " False ", "off", "no", "none", "null", "unset", "unknown", "disabled")
            .forEach { value ->
                assertFalse("\"$value\" must not count as a signal", isTruthySystemProperty(value))
            }
    }

    @Test
    fun `false-like color property values remain rejected`() {
        listOf("", "0", "false", "off", "no", "none", "null", "disabled")
            .forEach { value ->
                assertFalse("color property \"$value\" must not count as a signal", isTruthySystemProperty(value))
            }
    }

    @Test
    fun `real property values are eink signals`() {
        // Booleans, enum modes and free-form values all have to pass: the probed
        // keys are a mix of `ro.eink.color=1`, `persist.sys.eink.mode=2`,
        // `ro.eink.version=1.2` and `ro.epd.type=UC8179`.
        listOf("1", "true", "TRUE", "2", "12", "14", "1.2", "UC8179", "yes", "on")
            .forEach { value ->
                assertTrue("\"$value\" must count as a signal", isTruthySystemProperty(value))
            }
    }

    @Test
    fun `aggregate property check ignores false-like values`() {
        assertFalse(anyTruthySystemProperty(listOf("", "0", "false")))
        assertFalse(anyTruthySystemProperty(emptyList()))
        assertTrue(anyTruthySystemProperty(listOf("", "0", "2")))
    }

    // MARK: - Size classes

    @Test
    fun `size class boundaries`() {
        assertEquals(ScreenSizeClass.Tiny, classifyDevice(fingerprint(shortestWidthDp = 319)).sizeClass)
        assertEquals(ScreenSizeClass.Compact, classifyDevice(fingerprint(shortestWidthDp = 320)).sizeClass)
        assertEquals(ScreenSizeClass.Compact, classifyDevice(fingerprint(shortestWidthDp = 599)).sizeClass)
        assertEquals(ScreenSizeClass.Medium, classifyDevice(fingerprint(shortestWidthDp = 600)).sizeClass)
        assertEquals(ScreenSizeClass.Medium, classifyDevice(fingerprint(shortestWidthDp = 839)).sizeClass)
        assertEquals(ScreenSizeClass.Expanded, classifyDevice(fingerprint(shortestWidthDp = 840)).sizeClass)
    }

    @Test
    fun `phone sized lcd is handheld and tablet sized lcd is tablet`() {
        assertEquals(
            FormFactor.Handheld,
            classifyDevice(fingerprint(shortestWidthDp = 400)).formFactor,
        )
        assertEquals(
            FormFactor.Tablet,
            classifyDevice(fingerprint(shortestWidthDp = 800)).formFactor,
        )
    }

    @Test
    fun `compact screens are supported but flagged as tight`() {
        val profile = classifyDevice(fingerprint(shortestWidthDp = 400))
        assertEquals(SupportLevel.Full, profile.support)
        assertTrue(profile.caveats.contains(DeviceCaveat.TightWidth))
        assertTrue(profile.isRenderable)
    }

    // MARK: - Support levels

    @Test
    fun `watch is unsupported regardless of size`() {
        val profile = classifyDevice(
            fingerprint(shortestWidthDp = 400, uiModeType = Configuration.UI_MODE_TYPE_WATCH)
        )
        assertEquals(SupportLevel.Unsupported, profile.support)
        assertEquals(UnsupportedReason.WatchFormFactor, profile.unsupportedReason)
        assertEquals(FormFactor.Watch, profile.formFactor)
        assertFalse(profile.isRenderable)
    }

    @Test
    fun `screen below the floor is unsupported`() {
        val profile = classifyDevice(fingerprint(shortestWidthDp = 200))
        assertEquals(SupportLevel.Unsupported, profile.support)
        assertEquals(UnsupportedReason.ScreenTooSmall, profile.unsupportedReason)
    }

    @Test
    fun `television renders with a no-touch caveat`() {
        val profile = classifyDevice(
            fingerprint(
                shortestWidthDp = 960,
                uiModeType = Configuration.UI_MODE_TYPE_TELEVISION,
                hasTouchScreen = false,
            )
        )
        assertEquals(SupportLevel.Limited, profile.support)
        assertEquals(FormFactor.Television, profile.formFactor)
        assertTrue(profile.caveats.contains(DeviceCaveat.NoTouchInput))
        assertTrue(profile.isRenderable)
    }

    @Test
    fun `automotive renders with its own caveat`() {
        val profile = classifyDevice(
            fingerprint(shortestWidthDp = 700, uiModeType = Configuration.UI_MODE_TYPE_CAR)
        )
        assertEquals(SupportLevel.Limited, profile.support)
        assertTrue(profile.caveats.contains(DeviceCaveat.AutomotiveUnverified))
    }

    @Test
    fun `a touchless tablet is limited even without a tv ui mode`() {
        val profile = classifyDevice(fingerprint(shortestWidthDp = 800, hasTouchScreen = false))
        assertEquals(SupportLevel.Limited, profile.support)
        assertTrue(profile.caveats.contains(DeviceCaveat.NoTouchInput))
    }

    // MARK: - Overrides

    @Test
    fun `lcd override wins over a positive detection`() {
        val profile = classifyDevice(
            fingerprint(manufacturer = "ONYX", model = "Nova3"),
            PanelOverride.Lcd,
        )
        assertEquals(PanelKind.Lcd, profile.panel)
        assertEquals(EinkEvidence.UserOverride, profile.einkEvidence)
        assertTrue(profile.overridden)
    }

    @Test
    fun `eink override wins over a negative detection`() {
        val profile = classifyDevice(
            fingerprint(manufacturer = "Lenovo", model = "TB-J606F"),
            PanelOverride.Eink,
        )
        assertEquals(PanelKind.EinkMono, profile.panel)
        assertEquals(FormFactor.Reader, profile.formFactor)
    }

    @Test
    fun `eink override keeps a color panel in color`() {
        val profile = classifyDevice(
            fingerprint(manufacturer = "Unknown", model = "R1", hasColorEinkSignal = true),
            PanelOverride.Eink,
        )
        assertEquals(PanelKind.EinkColor, profile.panel)
    }

    @Test
    fun `auto override is not reported as overridden`() {
        assertFalse(classifyDevice(fingerprint(), PanelOverride.Auto).overridden)
    }

    @Test
    fun `panel override round trips through storage`() {
        PanelOverride.entries.forEach { option ->
            val stored = option.toStored()
            assertEquals(option, PanelOverride.fromStored(stored))
        }
        // Unknown / absent values fall back to Auto rather than throwing.
        assertEquals(PanelOverride.Auto, PanelOverride.fromStored(null))
        assertEquals(PanelOverride.Auto, PanelOverride.fromStored("nonsense"))
    }

    // MARK: - Wire + display shape

    @Test
    fun `wire kind keeps the two value vocabulary the swift topology maps`() {
        assertEquals("eink", classifyDevice(fingerprint(manufacturer = "Kobo", model = "Libra 2")).wireKind)
        assertEquals("tablet", classifyDevice(fingerprint(manufacturer = "Lenovo", model = "TB-J606F")).wireKind)
        assertEquals(
            "tablet",
            classifyDevice(fingerprint(shortestWidthDp = 400, manufacturer = "Google", model = "Pixel 8")).wireKind,
        )
    }

    @Test
    fun `display name does not repeat an embedded brand`() {
        assertEquals(
            "Lenovo TB-J606F",
            classifyDevice(fingerprint(manufacturer = "Lenovo", model = "Lenovo TB-J606F")).displayName,
        )
        assertEquals(
            "Lenovo TB-J606F",
            classifyDevice(fingerprint(manufacturer = "Lenovo", model = "TB-J606F")).displayName,
        )
    }

    @Test
    fun `display name degrades gracefully when build fields are empty`() {
        assertEquals(
            "Unknown Android device",
            classifyDevice(fingerprint(manufacturer = "", model = "")).displayName,
        )
    }

    @Test
    fun `short label prefers a named vendor and otherwise names the form factor`() {
        assertEquals("Crema", classifyDevice(fingerprint(manufacturer = "crema", model = "Crema S")).shortLabel)
        assertEquals("Pantone", classifyDevice(fingerprint(manufacturer = "MOAAN", model = "Pantone 6")).shortLabel)
        assertEquals("Kobo", classifyDevice(fingerprint(manufacturer = "Kobo", model = "Libra 2")).shortLabel)
        assertEquals("Reader", classifyDevice(fingerprint(manufacturer = "ONYX", model = "Nova3")).shortLabel)
        assertEquals(
            "Tablet",
            classifyDevice(fingerprint(manufacturer = "Lenovo", model = "TB-J606F", shortestWidthDp = 800)).shortLabel,
        )
        assertEquals(
            "Phone",
            classifyDevice(fingerprint(manufacturer = "Google", model = "Pixel 8", shortestWidthDp = 411)).shortLabel,
        )
        assertEquals(
            "TV",
            classifyDevice(
                fingerprint(shortestWidthDp = 960, uiModeType = Configuration.UI_MODE_TYPE_TELEVISION)
            ).shortLabel,
        )
    }

    @Test
    fun `describe names the panel size and evidence`() {
        val description = classifyDevice(
            fingerprint(manufacturer = "ONYX", model = "Note Air3 C", shortestWidthDp = 700)
        ).describe()
        assertTrue(description, description.contains("ONYX Note Air3 C"))
        assertTrue(description, description.contains("EinkColor"))
        assertTrue(description, description.contains("Medium"))
        assertTrue(description, description.contains("700dp"))
        assertTrue(description, description.contains("KnownVendor"))
    }

    private fun fingerprint(
        manufacturer: String = "Generic",
        brand: String = manufacturer,
        model: String = "Model",
        product: String = "product",
        device: String = "device",
        hardware: String = "hardware",
        characteristics: String = "",
        hasVendorEinkApi: Boolean = false,
        hasEinkSystemProperty: Boolean = false,
        hasColorEinkSignal: Boolean = false,
        hasTouchScreen: Boolean = true,
        uiModeType: Int = Configuration.UI_MODE_TYPE_NORMAL,
        shortestWidthDp: Int = 600,
    ) = DeviceFingerprint(
        manufacturer = manufacturer,
        brand = brand,
        model = model,
        product = product,
        device = device,
        hardware = hardware,
        characteristics = characteristics,
        hasVendorEinkApi = hasVendorEinkApi,
        hasEinkSystemProperty = hasEinkSystemProperty,
        hasColorEinkSignal = hasColorEinkSignal,
        hasTouchScreen = hasTouchScreen,
        uiModeType = uiModeType,
        shortestWidthDp = shortestWidthDp,
    )
}
