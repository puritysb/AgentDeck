package dev.agentdeck.util

import android.content.Context
import android.content.res.Configuration
import android.os.Build

/**
 * Single source of truth for "what kind of Android device is this, and which
 * dashboard should it render".
 *
 * Everything device-class-dependent in the app derives from [DeviceProfile] —
 * which UI tree `MainActivity` composes, which colour scheme and typography
 * `AgentDeckTheme` installs, the density scale the Monitor HUD picks, the
 * refresh strategy `EinkRenderer` uses, and the `kind` this dashboard reports
 * to the daemon topology. Nothing else may re-derive a device class from
 * `Build.*` strings; add a field here instead.
 *
 * The classifier ([classifyDevice]) is a pure function over [DeviceFingerprint]
 * so every rule is unit-testable without Robolectric shadows. [detect] is the
 * only part that touches the framework.
 *
 * ## Why capability probes come before name matching
 *
 * The previous detector matched bare model substrings (`"note"`, `"nova"`,
 * `"leaf"`, `"poke"`) against `Build.MODEL` with no vendor qualification, so
 * a Redmi Note or a Huawei nova phone silently got the monochrome e-ink UI,
 * forced landscape, and system-rotation writes. Model tokens are now only ever
 * consulted for a vendor that actually ships both panel types, and the primary
 * signals are capability probes (vendor EPD service, e-ink system properties,
 * `ro.build.characteristics`) which also catch readers no allowlist knows
 * about. That widens coverage and removes the false positives at the same time.
 */
enum class PanelKind {
    /** Monochrome electrophoretic panel — 16-level grey, vendor refresh modes. */
    EinkMono,

    /** Kaleido 3 / Gallery 3-4 colour e-ink: colour at 1/4 the B&W resolution. */
    EinkColor,

    /** Ordinary emissive panel (LCD/OLED) — phones, tablets, TV, desktop mode. */
    Lcd,
    ;

    val isEink: Boolean get() = this != Lcd
}

/**
 * Window size bucket, from `smallestScreenWidthDp` — the `sw` resource
 * qualifier equivalent, so a foldable in folded state and a phone in landscape
 * both land in [Compact]. Boundaries follow the Material window size classes
 * (600 / 840) with an extra [Tiny] floor below which no dashboard layout fits.
 */
enum class ScreenSizeClass { Tiny, Compact, Medium, Expanded }

/** UX form factor, from `UiModeManager` plus panel and size. */
enum class FormFactor { Reader, Handheld, Tablet, Television, Automotive, Watch, Desk }

/** How well this device can run the dashboard. */
enum class SupportLevel {
    /** Everything works; render normally. */
    Full,

    /** Renders, but something material is degraded — show a dismissible notice. */
    Limited,

    /** No layout can work here — show [dev.agentdeck.ui.screen.UnsupportedDeviceScreen]. */
    Unsupported,
}

/** Why a device is [SupportLevel.Unsupported]. Drives the guidance copy. */
enum class UnsupportedReason { WatchFormFactor, ScreenTooSmall }

/** Non-blocking caveats. Surfaced as an informational notice, never a block. */
enum class DeviceCaveat {
    /** No touchscreen (TV / set-top): panels render but taps are unavailable. */
    NoTouchInput,

    /** Shortest edge under 600dp — panels collapse to the single-column layout. */
    TightWidth,

    /** Classified as e-ink from a weak signal only; offer the manual override. */
    UnverifiedEinkPanel,

    /** Automotive head unit — untested, and driver-distraction rules may apply. */
    AutomotiveUnverified,
}

/**
 * What convinced the classifier this is an e-ink panel. Ordered strongest
 * first; reported in diagnostics so a misdetection is debuggable from a log
 * line instead of a guess.
 */
enum class EinkEvidence {
    None,
    UserOverride,
    VendorApi,
    SystemProperty,
    BuildCharacteristics,
    BuildString,
    KnownVendor,
    KnownModel,
    ;

    /**
     * A build-string match alone can be coincidental, so it earns a
     * [DeviceCaveat.UnverifiedEinkPanel] pointing the user at the override.
     */
    val isWeak: Boolean get() = this == BuildString
}

/** User-facing escape hatch for a misclassified panel. Persisted in `DisplayPreferences`. */
enum class PanelOverride {
    Auto,
    Eink,
    Lcd,
    ;

    fun toStored(): String = when (this) {
        Auto -> "auto"
        Eink -> "eink"
        Lcd -> "lcd"
    }

    companion object {
        /** Unknown or absent values fall back to [Auto] rather than throwing. */
        fun fromStored(value: String?): PanelOverride = when (value) {
            "eink" -> Eink
            "lcd" -> Lcd
            else -> Auto
        }
    }
}

/**
 * Everything the classifier is allowed to look at. Collected by [detect] from
 * the framework; constructed directly in tests.
 */
data class DeviceFingerprint(
    val manufacturer: String,
    val brand: String,
    val model: String,
    val product: String,
    val device: String,
    val hardware: String,
    /** `ro.build.characteristics` — real readers commonly carry `eink` here. */
    val characteristics: String,
    /** A vendor EPD service or SDK class is present (strongest possible signal). */
    val hasVendorEinkApi: Boolean,
    /** An `*.eink.*` / `*.epd.*` system property is set. */
    val hasEinkSystemProperty: Boolean,
    /** A vendor property or characteristic marks the panel as colour e-ink. */
    val hasColorEinkSignal: Boolean,
    val hasTouchScreen: Boolean,
    /** `Configuration.uiMode and UI_MODE_TYPE_MASK`. */
    val uiModeType: Int,
    val shortestWidthDp: Int,
)

/**
 * The resolved device class. Construct only via [classifyDevice] / [detect].
 */
data class DeviceProfile(
    val panel: PanelKind,
    val sizeClass: ScreenSizeClass,
    val formFactor: FormFactor,
    val support: SupportLevel,
    val unsupportedReason: UnsupportedReason?,
    val caveats: List<DeviceCaveat>,
    val einkEvidence: EinkEvidence,
    val shortestWidthDp: Int,
    val overridden: Boolean,
    val displayName: String,
    /**
     * Short label for topology rows ("Crema", "Pantone", "Tablet", "TV").
     * Vendor names live here rather than in the rail so the two cannot drift.
     */
    val shortLabel: String,
) {
    val isEink: Boolean get() = panel.isEink
    val isColorEink: Boolean get() = panel == PanelKind.EinkColor

    /** True when a dashboard should be composed at all. */
    val isRenderable: Boolean get() = support != SupportLevel.Unsupported

    /**
     * `kind` reported in `client_register{clientType:"android-dashboard"}`.
     *
     * Deliberately still the original two-value vocabulary: the only consumer
     * that renders it is `TopologyRail.swift`, which maps it with a two-way
     * ternary (`kind == "eink" ? "E-ink" : "Tablet"`). Widening the vocabulary
     * is a cross-surface wire change and belongs in its own commit alongside
     * the Swift/Node label mapping.
     */
    val wireKind: String get() = if (isEink) "eink" else "tablet"

    /** One-line diagnostic, e.g. `ONYX Note Air3 C · EinkColor/Medium/Reader (VendorApi)`. */
    fun describe(): String = buildString {
        append(displayName)
        append(" · ")
        append(panel.name).append('/').append(sizeClass.name).append('/').append(formFactor.name)
        append(" · ").append(shortestWidthDp).append("dp")
        append(" (").append(einkEvidence.name)
        if (overridden) append(", override")
        append(')')
        if (caveats.isNotEmpty()) append(" caveats=").append(caveats.joinToString(","))
    }

    companion object {
        /**
         * Narrowest shortest-edge the dashboard can lay out. Below this even the
         * single-column timeline loses its labels, so the device gets guidance
         * instead of an unusable screen. Wear OS rounds sit near 200dp.
         */
        const val MIN_SUPPORTED_WIDTH_DP = 320

        /** Material window size class boundaries. */
        const val MEDIUM_MIN_WIDTH_DP = 600
        const val EXPANDED_MIN_WIDTH_DP = 840

        /**
         * Collect a [DeviceFingerprint] from the framework and classify it.
         *
         * Cheap enough to call per use (a handful of string reads plus cached
         * reflection lookups), but callers that need it before the first frame
         * should hold the result — see `MainActivity`.
         */
        fun detect(context: Context, override: PanelOverride = PanelOverride.Auto): DeviceProfile =
            classifyDevice(fingerprint(context), override)

        fun fingerprint(context: Context): DeviceFingerprint {
            val config = context.resources.configuration
            return DeviceFingerprint(
                manufacturer = Build.MANUFACTURER.orEmpty(),
                brand = Build.BRAND.orEmpty(),
                model = Build.MODEL.orEmpty(),
                product = Build.PRODUCT.orEmpty(),
                device = Build.DEVICE.orEmpty(),
                hardware = Build.HARDWARE.orEmpty(),
                characteristics = SystemPropertyProbe.get("ro.build.characteristics"),
                hasVendorEinkApi = EinkCapabilityProbe.hasVendorEinkApi(context),
                hasEinkSystemProperty = EinkCapabilityProbe.hasEinkSystemProperty(),
                hasColorEinkSignal = EinkCapabilityProbe.hasColorEinkSignal(),
                hasTouchScreen = config.touchscreen != Configuration.TOUCHSCREEN_NOTOUCH,
                uiModeType = config.uiMode and Configuration.UI_MODE_TYPE_MASK,
                shortestWidthDp = config.smallestScreenWidthDp,
            )
        }
    }
}

/**
 * Classify a device. Pure — no framework access, no caching, no I/O.
 *
 * Order matters: form factor and size gate support first (a watch is
 * unsupported whatever its panel is), then the panel is resolved, then
 * caveats are collected from both.
 */
fun classifyDevice(
    fp: DeviceFingerprint,
    override: PanelOverride = PanelOverride.Auto,
): DeviceProfile {
    val sizeClass = sizeClassFor(fp.shortestWidthDp)
    val einkResult = resolvePanel(fp, override)
    val formFactor = formFactorFor(fp, sizeClass, einkResult.panel)

    val unsupportedReason = when {
        formFactor == FormFactor.Watch -> UnsupportedReason.WatchFormFactor
        sizeClass == ScreenSizeClass.Tiny -> UnsupportedReason.ScreenTooSmall
        else -> null
    }

    val caveats = buildList {
        // A television reports a touchscreen of NOTOUCH and is driven by a
        // remote; the dashboard is read-only there, which is a legitimate way
        // to use it (wall display) but worth stating once.
        if (!fp.hasTouchScreen || formFactor == FormFactor.Television) add(DeviceCaveat.NoTouchInput)
        if (formFactor == FormFactor.Automotive) add(DeviceCaveat.AutomotiveUnverified)
        if (sizeClass == ScreenSizeClass.Compact) add(DeviceCaveat.TightWidth)
        if (einkResult.panel.isEink && einkResult.evidence.isWeak) {
            add(DeviceCaveat.UnverifiedEinkPanel)
        }
    }

    val support = when {
        unsupportedReason != null -> SupportLevel.Unsupported
        caveats.contains(DeviceCaveat.NoTouchInput) -> SupportLevel.Limited
        caveats.contains(DeviceCaveat.AutomotiveUnverified) -> SupportLevel.Limited
        else -> SupportLevel.Full
    }

    return DeviceProfile(
        panel = einkResult.panel,
        sizeClass = sizeClass,
        formFactor = formFactor,
        support = support,
        unsupportedReason = unsupportedReason,
        caveats = caveats,
        einkEvidence = einkResult.evidence,
        shortestWidthDp = fp.shortestWidthDp,
        overridden = override != PanelOverride.Auto,
        displayName = displayNameFor(fp),
        shortLabel = shortLabelFor(fp, formFactor),
    )
}

private fun sizeClassFor(shortestWidthDp: Int): ScreenSizeClass = when {
    shortestWidthDp < DeviceProfile.MIN_SUPPORTED_WIDTH_DP -> ScreenSizeClass.Tiny
    shortestWidthDp < DeviceProfile.MEDIUM_MIN_WIDTH_DP -> ScreenSizeClass.Compact
    shortestWidthDp < DeviceProfile.EXPANDED_MIN_WIDTH_DP -> ScreenSizeClass.Medium
    else -> ScreenSizeClass.Expanded
}

private fun formFactorFor(
    fp: DeviceFingerprint,
    sizeClass: ScreenSizeClass,
    panel: PanelKind,
): FormFactor = when {
    fp.uiModeType == Configuration.UI_MODE_TYPE_WATCH -> FormFactor.Watch
    fp.uiModeType == Configuration.UI_MODE_TYPE_TELEVISION -> FormFactor.Television
    fp.uiModeType == Configuration.UI_MODE_TYPE_CAR -> FormFactor.Automotive
    fp.uiModeType == Configuration.UI_MODE_TYPE_DESK -> FormFactor.Desk
    panel.isEink -> FormFactor.Reader
    sizeClass == ScreenSizeClass.Compact || sizeClass == ScreenSizeClass.Tiny -> FormFactor.Handheld
    else -> FormFactor.Tablet
}

private data class PanelResult(val panel: PanelKind, val evidence: EinkEvidence)

private fun resolvePanel(fp: DeviceFingerprint, override: PanelOverride): PanelResult {
    when (override) {
        PanelOverride.Lcd -> return PanelResult(PanelKind.Lcd, EinkEvidence.UserOverride)
        PanelOverride.Eink -> return PanelResult(
            // Honour a colour signal even when the user only forced "e-ink":
            // a colour reader forced to mono would lose its colour fills.
            if (isColorEink(fp)) PanelKind.EinkColor else PanelKind.EinkMono,
            EinkEvidence.UserOverride,
        )
        PanelOverride.Auto -> Unit
    }

    val evidence = einkEvidence(fp)
    if (evidence == EinkEvidence.None) return PanelResult(PanelKind.Lcd, EinkEvidence.None)
    return PanelResult(
        if (isColorEink(fp)) PanelKind.EinkColor else PanelKind.EinkMono,
        evidence,
    )
}

/**
 * Strongest available e-ink signal, or [EinkEvidence.None].
 *
 * Capability probes come first because they generalise to readers no table
 * knows about; the name tables are the fallback for devices whose vendor
 * layer exposes nothing.
 */
private fun einkEvidence(fp: DeviceFingerprint): EinkEvidence {
    if (fp.hasVendorEinkApi) return EinkEvidence.VendorApi
    if (fp.hasEinkSystemProperty) return EinkEvidence.SystemProperty

    val characteristics = fp.characteristics.lowercase()
    if (EINK_TOKENS.any { characteristics.contains(it) }) return EinkEvidence.BuildCharacteristics

    val buildStrings = listOf(fp.product, fp.device, fp.hardware).map { it.lowercase() }
    if (buildStrings.any { s -> EINK_TOKENS.any { s.contains(it) } }) return EinkEvidence.BuildString

    val identity = vendorIdentityOf(fp)
    if (EINK_ONLY_VENDORS.any { vendor -> identity.any { it.contains(vendor) } }) {
        return EinkEvidence.KnownVendor
    }

    val model = fp.model.lowercase()
    for ((vendor, models) in MIXED_VENDOR_EINK_MODELS) {
        if (identity.none { it.contains(vendor) }) continue
        if (models.any { model.contains(it) }) return EinkEvidence.KnownModel
    }

    return EinkEvidence.None
}

private fun isColorEink(fp: DeviceFingerprint): Boolean {
    if (fp.hasColorEinkSignal) return true
    val model = fp.model.lowercase()
    val identity = vendorIdentityOf(fp)
    for ((vendor, models) in COLOR_EINK_MODELS) {
        if (identity.none { it.contains(vendor) }) continue
        if (models.any { model.contains(it) }) return true
    }
    return false
}

/**
 * Vendor identity for the name tables: the manufacturer and brand fields, plus
 * any [DISTINCTIVE_BRAND_WORDS] the model happens to carry.
 *
 * `PRODUCT`, `DEVICE` and `HARDWARE` are deliberately excluded. Those hold
 * codenames, and codenames collide with brand names — the OnePlus X, an LCD
 * phone, has device codename `onyx`, which a naive scan over every build string
 * would read as an Onyx reader. Only the fields that actually identify a vendor
 * may gate a vendor rule; codename fields are consulted for the `eink`/`epd`
 * tokens in [einkEvidence] and nowhere else.
 */
private fun vendorIdentityOf(fp: DeviceFingerprint): Set<String> {
    val identity = mutableSetOf(normalizeVendor(fp.manufacturer), normalizeVendor(fp.brand))
    val model = normalizeVendor(fp.model)
    DISTINCTIVE_BRAND_WORDS.forEach { word -> if (model.contains(word)) identity.add(word) }
    return identity
}

private fun normalizeVendor(value: String): String = value.lowercase().replace(" ", "")

/**
 * Brand words distinctive enough to trust inside a model string, for readers
 * that report a generic manufacturer and carry the brand in `MODEL`
 * (e.g. `"Onyx Boox Nova3"`). `onyx` is absent on purpose — see
 * [vendorIdentityOf] — and `boox` covers those devices anyway.
 */
private val DISTINCTIVE_BRAND_WORDS = setOf(
    "boox",
    "crema",
    "pocketbook",
    "remarkable",
    "supernote",
    "bigme",
    "likebook",
    "meebook",
    "tolino",
    "viwoods",
    "dasung",
    "inkbook",
    "mooink",
    "readmoo",
    "moaan",
    "boyue",
    "kobo",
)

/** Build-string / characteristic tokens that mean "electrophoretic panel". */
private val EINK_TOKENS = listOf("eink", "e-ink", "e_ink", "epd")

/**
 * Vendors that ship electrophoretic panels exclusively, so a brand match alone
 * is decisive and no model token is needed. This is where the previous
 * detector's manufacturer list lands — every device it recognised still
 * classifies as e-ink.
 *
 * A vendor belongs here only if it ships *no* emissive-panel Android devices.
 * Hisense, Xiaomi, Huawei, Barnes & Noble, Fujitsu and Sony all ship both and
 * live in [MIXED_VENDOR_EINK_MODELS] instead. Note `kobo` rather than
 * `rakuten`: Rakuten also shipped LCD phones (Rakuten Mini, Hand).
 */
private val EINK_ONLY_VENDORS = setOf(
    "onyx",
    "boox",
    "crema",
    "kyobo",
    "pocketbook",
    "obreey",
    "remarkable",
    "supernote",
    "ratta",
    "dasung",
    "boyue",
    "likebook",
    "meebook",
    "bigme",
    "viwoods",
    "readmoo",
    "mooink",
    "tolino",
    "netronix",
    "kobo",
    "moaan",
    "inkbook",
)

/**
 * Vendors that ship both panel types: an e-ink verdict requires a model token.
 * Tokens may be short here precisely because the vendor gate already ran — a
 * bare `"note"` cannot reach a Redmi, and `"paper"` cannot reach anything but
 * a Huawei.
 */
private val MIXED_VENDOR_EINK_MODELS: Map<String, Set<String>> = mapOf(
    // Q5 is deliberately absent: the Hisense Q5 (HITV105C) is a monochrome
    // reflective LCD, not an electrophoretic panel. It has no EPD controller,
    // so the e-ink UI, refresh modes and forced landscape would all be wrong.
    "hisense" to setOf("a5", "a7", "a9", "hireader"),
    "xiaomi" to setOf("inkpalm", "moaan"),
    "redmi" to setOf("inkpalm"),
    "huawei" to setOf("paper"),
    "barnesandnoble" to setOf("glowlight", "glow", "nook"),
    "nook" to setOf("glowlight", "glow"),
    "fujitsu" to setOf("quaderno"),
    "sony" to setOf("dpt"),
    "rockchip" to setOf("boox", "crema", "pantone", "inkpalm"),
)

/**
 * Colour e-ink models (Kaleido 3, Gallery 3/4). Vendor-qualified for the same
 * reason as above. Colour renders at 1/4 the monochrome resolution, so this
 * only unlocks large fills — creature bodies and gauge bars, never small text.
 */
private val COLOR_EINK_MODELS: Map<String, Set<String>> = mapOf(
    "onyx" to setOf(
        "ultra c", "ultrac", "air 2 c", "air2 c", "air2c",
        "air 3 c", "air3 c", "air3c", "nova air c", "mini c", "minic", "go color",
    ),
    "boox" to setOf(
        "ultra c", "ultrac", "air2 c", "air3 c", "nova air c", "mini c", "go color",
    ),
    "bigme" to setOf("galy", "inknote color", "hibreak color", "b1051c"),
    "moaan" to setOf("pantone"),
    "xiaomi" to setOf("pantone"),
    "rockchip" to setOf("pantone"),
    "pocketbook" to setOf("inkpad color", "verse color", "era color", "color"),
    "kobo" to setOf("colour"),
    "hisense" to setOf("a7cc", "a5c"),
    "remarkable" to setOf("paper pro"),
    "viwoods" to setOf("color"),
)

/**
 * Short device label for the daemon topology row. Named readers keep their own
 * label so a Crema reads "Crema" rather than the generic "Reader"; everything
 * else falls back to the form factor, which covers phones, TVs and head units.
 */
private fun shortLabelFor(fp: DeviceFingerprint, formFactor: FormFactor): String {
    val identity = vendorIdentityOf(fp)
    val model = normalizeVendor(fp.model)
    val named = when {
        identity.any { it.contains("crema") } || model.contains("crema") -> "Crema"
        identity.any { it.contains("moaan") || it.contains("moan") } ||
            model.contains("pantone") -> "Pantone"
        identity.any { it.contains("kobo") } -> "Kobo"
        else -> null
    }
    if (named != null) return named
    return when (formFactor) {
        FormFactor.Reader -> "Reader"
        FormFactor.Handheld -> "Phone"
        FormFactor.Tablet -> "Tablet"
        FormFactor.Television -> "TV"
        FormFactor.Automotive -> "Car"
        FormFactor.Desk -> "Desktop"
        FormFactor.Watch -> "Watch"
    }
}

private fun displayNameFor(fp: DeviceFingerprint): String {
    val model = fp.model.trim()
    val manufacturer = fp.manufacturer.trim()
    return when {
        model.isEmpty() && manufacturer.isEmpty() -> "Unknown Android device"
        model.isEmpty() -> manufacturer
        manufacturer.isEmpty() -> model
        // Some models already embed the brand ("Lenovo TB-J606F") — don't
        // prepend the manufacturer twice.
        model.contains(manufacturer, ignoreCase = true) -> model
        else -> "$manufacturer $model"
    }
}

/**
 * Whether a system property value counts as a positive signal.
 *
 * Presence is not truth. Vendors ship these keys *defined and negative* — an
 * LCD build may carry `ro.eink_display=false` or `persist.sys.eink.mode=0`, and
 * an `isNotEmpty()` check reads both as "this is an e-ink panel". The keys
 * probed here are a mix of booleans (`ro.eink.color`), enums
 * (`persist.sys.eink.mode`) and free-form values (`ro.epd.type=UC8179`,
 * `ro.eink.version=1.2`), so rather than model each key this rejects the
 * false-like vocabulary and accepts anything else — including `2`, `1.2` and
 * panel part numbers.
 *
 * `0` is treated as false-like on purpose: in every enum-valued key here the
 * zero mode means "none/off", never a usable EPD mode (the Rockchip modes
 * `EinkRenderer` drives are `2`, `12` and `14`).
 */
internal fun isTruthySystemProperty(value: String): Boolean {
    val normalized = value.trim().lowercase()
    if (normalized.isEmpty()) return false
    return normalized !in FALSE_LIKE_PROPERTY_VALUES
}

internal fun anyTruthySystemProperty(values: Collection<String>): Boolean =
    values.any { isTruthySystemProperty(it) }

private val FALSE_LIKE_PROPERTY_VALUES = setOf(
    "0",
    "false",
    "off",
    "no",
    "none",
    "null",
    "unset",
    "unknown",
    "disabled",
)

/**
 * Reflective `android.os.SystemProperties` reader. The class is hidden but
 * present on every Android build; absence is treated as "property unset".
 */
private object SystemPropertyProbe {
    private val getter: java.lang.reflect.Method? by lazy {
        try {
            Class.forName("android.os.SystemProperties")
                .getMethod("get", String::class.java)
        } catch (_: Throwable) {
            null
        }
    }

    fun get(key: String): String = try {
        getter?.invoke(null, key) as? String ?: ""
    } catch (_: Throwable) {
        ""
    }
}

/**
 * Capability probes for an electrophoretic panel. All reflective and all
 * failure-tolerant: a stock tablet simply reports `false` everywhere.
 *
 * The vendor surfaces probed here are the same ones `EinkRenderer` drives for
 * refresh control, so a positive probe also means the refresh path will work:
 * Rockchip RK35xx readers (Crema, MOAAN Pantone) expose an `eink` system
 * service backed by `android.os.EinkManager`, and Onyx ships its SDK classes
 * on-device.
 */
private object EinkCapabilityProbe {

    private val einkSystemProperties = listOf(
        "ro.eink.version",
        "ro.eink_display",
        "ro.hardware.eink",
        "ro.epd.type",
        "persist.sys.eink.mode",
        "persist.sys.eink_mode",
    )

    private val colorEinkSystemProperties = listOf(
        "ro.eink.color",
        "persist.sys.eink.color",
        "ro.epd.color",
    )

    private val vendorEinkClasses = listOf(
        "android.os.EinkManager",
        "com.onyx.android.sdk.device.Device",
    )

    fun hasVendorEinkApi(context: Context): Boolean {
        if (vendorEinkClasses.any { classExists(it) }) return true
        return try {
            context.getSystemService("eink") != null
        } catch (_: Throwable) {
            false
        }
    }

    fun hasEinkSystemProperty(): Boolean =
        anyTruthySystemProperty(einkSystemProperties.map { SystemPropertyProbe.get(it) })

    fun hasColorEinkSignal(): Boolean {
        if (anyTruthySystemProperty(colorEinkSystemProperties.map { SystemPropertyProbe.get(it) })) {
            return true
        }
        val characteristics = SystemPropertyProbe.get("ro.build.characteristics").lowercase()
        return characteristics.contains("einkcolor") || characteristics.contains("eink_color")
    }

    private fun classExists(name: String): Boolean = try {
        Class.forName(name)
        true
    } catch (_: Throwable) {
        false
    }
}
