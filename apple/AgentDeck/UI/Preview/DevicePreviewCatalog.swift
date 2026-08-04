// DevicePreviewCatalog.swift — enum of previewable device types + the view factory.
//
// Device Preview lets users see what AgentDeck looks like on each supported
// device without owning the hardware. The full catalog has 20 representative
// entries; the standalone App Store app shows the 17 entries it can drive
// without an external desktop bridge, and the 3 ADB-tier entries reappear
// automatically when such a bridge is connected.

import SwiftUI

/// A single previewable device. `rawValue` is the stable UI id; `displayName`
/// is what appears in the sidebar.
enum PreviewDevice: String, CaseIterable, Identifiable {
    case streamDeckKey
    case streamDeckPlus
    case d200hKey
    case d200hDeck
    case iPadLandscape
    case androidTablet
    case einkMono
    case einkColor
    case inkDeck
    case esp32_86box
    case esp32_35Landscape
    case esp32_35Portrait
    case esp32Round
    case esp32Ttgo
    case esp32Ips10
    case ulanziMatrix
    case pixoo64
    case timeboxMini
    case iDotMatrix
    case terminalTerrarium

    var id: String { rawValue }

    // Categories follow how the UIs actually differ, not form factor alone:
    // the Android tablet and Android e-ink apps are entirely different
    // Compose layouts (grouped under one Android platform header), while
    // InkDeck is AgentDeck ESP32 firmware and sits with the other boards.
    enum Category: String, CaseIterable, Identifiable {
        case desk, apple, android, esp32, matrix, terminal

        var id: String { rawValue }

        var displayName: String {
            switch self {
            case .desk:     return "Desk"
            case .apple:    return "Apple"
            case .android:  return "Android"
            case .esp32:    return "ESP32"
            case .matrix:   return "Matrix"
            case .terminal: return "Terminal"
            }
        }
    }

    var category: Category {
        switch self {
        case .streamDeckKey, .streamDeckPlus, .d200hKey, .d200hDeck:            return .desk
        case .iPadLandscape:                                     return .apple
        case .androidTablet, .einkMono, .einkColor:              return .android
        case .esp32_86box, .esp32_35Landscape,
             .esp32_35Portrait, .esp32Round,
             .esp32Ttgo, .esp32Ips10, .inkDeck:                  return .esp32
        case .ulanziMatrix, .pixoo64,
             .timeboxMini, .iDotMatrix:                          return .matrix
        case .terminalTerrarium:                                 return .terminal
        }
    }

    var displayName: String {
        switch self {
        case .streamDeckKey:      return "Stream Deck Key"
        case .streamDeckPlus:     return "Stream Deck+ Session"
        case .d200hKey:           return "Ulanzi D200H Key"
        case .d200hDeck:          return "Ulanzi D200H Deck"
        case .iPadLandscape:      return "iPad (Landscape)"
        case .androidTablet:      return "Android Tablet"
        case .einkMono:           return "Android E-ink Mono (CremaS)"
        case .einkColor:          return "Android E-ink Color (Pantone6)"
        case .inkDeck:            return "InkDeck 7.5\" E-ink"
        case .esp32_86box:        return "ESP32 86Box 4\""
        case .esp32_35Landscape:  return "ESP32 IPS 3.5\" Landscape"
        case .esp32_35Portrait:   return "ESP32 IPS 3.5\" Portrait"
        case .esp32Round:         return "ESP32 Round AMOLED 1.8\""
        case .esp32Ttgo:          return "ESP32 TTGO T-Display 1.14\""
        case .esp32Ips10:         return "ESP32 IPS 10.1\""
        case .ulanziMatrix:       return "Ulanzi TC001 Matrix"
        case .pixoo64:            return "Pixoo 64"
        case .timeboxMini:        return "Divoom Timebox Mini"
        case .iDotMatrix:         return "iDotMatrix 32×32"
        case .terminalTerrarium:  return "Terminal Terrarium (TUI)"
        }
    }

    /// True when the device only reaches AgentDeck through an external
    /// desktop bridge (ADB-tunneled). The standalone app hides these
    /// from the picker so the catalog matches what it can actually drive
    /// — they reappear automatically once the bridge is connected.
    var requiresDesktopBridge: Bool {
        switch self {
        // TC001 (`ulanziMatrix`) is deliberately NOT here: it is an ESP32
        // serial board the standalone Swift daemon drives directly
        // (docs/appstore-feature-matrix.md), not an ADB-tunneled device.
        case .androidTablet, .einkMono, .einkColor: return true
        default: return false
        }
    }

    /// Short byline for the main-canvas header.
    var byline: String {
        switch self {
        case .streamDeckKey:      return "72×72 default Stream Deck key."
        case .streamDeckPlus:     return "144×144 session button, driven by the plugin."
        case .d200hKey:           return "One 120×120 key tile, as the layout engine assigns it."
        case .d200hDeck:          return "Full 5×3 deck via buildSessionDeck — tiles + usage gauges."
        case .iPadLandscape:      return "Dashboard-style aquarium — sidebar + terrarium + HUD."
        case .androidTablet:      return "Compose canvas (Lenovo / generic tablet)."
        case .einkMono:           return "Dithered silhouette + name tag. Kobo / CremaS."
        case .einkColor:          return "Pantone6 colour e-ink — brand-tinted creature."
        case .inkDeck:            return "800×480 1-bit e-ink — session cards + usage footer."
        case .esp32_86box:        return "4\" 480×480 wall-box IPS — terrarium + HUD."
        case .esp32_35Landscape:  return "3.5\" IPS landscape — wide canvas, LVGL."
        case .esp32_35Portrait:   return "3.5\" IPS portrait — split HUD + creature."
        case .esp32Round:         return "1.8\" 360×360 round AMOLED — terrarium + HUD."
        case .esp32Ttgo:          return "1.14\" 135×240 LCD — mini terrarium + metric panel."
        case .esp32Ips10:         return "10.1\" 1280×800 — office scene + session cards (D1)."
        case .ulanziMatrix:       return "8×32 WS2812B matrix — ultra-minimal HUD."
        case .pixoo64:            return "64×64 pixel art canvas, dot-matrix simplified."
        case .timeboxMini:        return "11×11 BLE pixel display — native micro glyphs."
        case .iDotMatrix:         return "32×32 BLE LED — downscaled 64×64 aquarium."
        case .terminalTerrarium:  return "agentdeck dashboard TUI — characters-only aquarium."
        }
    }
}

// MARK: - Selection value object

/// The toolbar picker state plus which device is being shown.
struct DevicePreviewSelection {
    var agent: PixooPreviewAgent
    var state: PixooPreviewState
    /// Must be one of {0, 1, 2, 4}. The screen clamps the picker to this set.
    var sessionCount: Int
    var device: PreviewDevice
    var animationFrame: Int = 0
    /// Real daemon data, present only in live-follow mode. Device previews that
    /// can consume rich per-session data (D200H first) render this verbatim —
    /// actual project names, models, and usage % — instead of the coarse
    /// agent/state/count synthesis the toolbar pickers produce. `nil` in manual
    /// (toolbar) mode. See `DevicePreviewScreen.deviceBody`.
    var live: LivePreviewData?
}

// MARK: - Live-follow snapshot

/// A snapshot of the daemon's real session + usage state, captured by the
/// Device Preview window when the "Live" toggle is on. It is device-agnostic:
/// each per-device view converts it into its own layout input (the D200H
/// preview feeds it straight into `D200HLayoutModel.buildSessionDeck`). This is
/// the second emulator step — the previews stop approximating and mirror the
/// exact sessions/usage a physical device is rendering right now.
struct LivePreviewData {
    /// The full daemon state, verbatim. The Pixoo-pipeline previews
    /// (Pixoo 64 / Timebox / iDotMatrix) feed this straight into the real
    /// `PixooRenderer`, so they become pixel-exact emulators with no separate
    /// synthesis. The fields below are pre-extracted conveniences for the
    /// schematic previews (D200H, ESP32, InkDeck, …). Defaulted only so the
    /// snapshot tests can build a synthetic snapshot without a full state;
    /// the production path (`from`) always sets the real state.
    var source: DashboardState = DashboardState()
    /// Alive sessions, exactly as the daemon reports them (project/model/state).
    var sessions: [SessionInfo]
    /// Daemon aggregate state rawValue — drives the OFFLINE gate.
    var topLevelState: String
    var focusedSessionId: String?
    /// The focused session's live options are treated as navigable (TUI ❯).
    var navigable: Bool
    /// The focused session's live prompt options (top-level `state_update`).
    var focusedOptions: [PromptOption]
    // Usage snapshot (hide-if-absent: nil → the device omits that gauge tile).
    var fiveHourPercent: Double?
    var sevenDayPercent: Double?
    /// False → the Claude tiles are suppressed (usage state not trusted).
    var usageKnown: Bool
    var codexPrimaryPercent: Double?
    var codexPrimaryWindowMinutes: Int?
    var codexPrimaryStale: Bool
    var codexSecondaryPercent: Double?
    var codexSecondaryWindowMinutes: Int?
    var codexSecondaryStale: Bool
    /// When the Codex snapshot was written (`CodexRateLimits.capturedAt`) — the
    /// device mirrors dim an aged reading instead of rendering it as live.
    var codexCapturedAt: String?

    /// Extract the live snapshot from the daemon state. Usage windows are
    /// hide-if-absent, mirroring the real device renderers.
    static func from(_ state: DashboardState) -> LivePreviewData {
        LivePreviewData(
            source: state,
            sessions: state.siblingSessions.filter(\.alive),
            topLevelState: state.state.rawValue,
            focusedSessionId: state.focusedSessionId ?? state.sessionId,
            navigable: state.navigable,
            focusedOptions: state.options,
            fiveHourPercent: state.fiveHourPercent,
            sevenDayPercent: state.sevenDayPercent,
            usageKnown: !(state.usageStale ?? false),
            codexPrimaryPercent: state.codexRateLimits?.primary?.usedPercent,
            codexPrimaryWindowMinutes: state.codexRateLimits?.primary?.windowMinutes,
            codexPrimaryStale: state.codexRateLimits?.primary?.stale ?? false,
            codexSecondaryPercent: state.codexRateLimits?.secondary?.usedPercent,
            codexSecondaryWindowMinutes: state.codexRateLimits?.secondary?.windowMinutes,
            codexSecondaryStale: state.codexRateLimits?.secondary?.stale ?? false,
            codexCapturedAt: state.codexRateLimits?.capturedAt
        )
    }
}
