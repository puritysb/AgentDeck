// AgentState.swift — State enums & prompt types
// Ported from shared/src/states.ts

import Foundation

// MARK: - State

enum AgentConnectionState: String, Codable, Sendable, CaseIterable {
    case disconnected
    case idle
    case processing
    case awaitingPermission = "awaiting_permission"
    case awaitingOption = "awaiting_option"
    case awaitingDiff = "awaiting_diff"

    var isAwaiting: Bool {
        switch self {
        case .awaitingPermission, .awaitingOption, .awaitingDiff: true
        default: false
        }
    }

    var isActive: Bool {
        self == .processing
    }

    var displayLabel: String {
        switch self {
        case .disconnected: "DISCONNECTED"
        case .idle: "IDLE"
        case .processing: "PROCESSING"
        case .awaitingPermission: "PERMISSION"
        case .awaitingOption: "SELECT"
        case .awaitingDiff: "DIFF REVIEW"
        }
    }
}

// MARK: - Permission Mode

enum PermissionMode: String, Codable, Sendable {
    case `default`
    case plan
    case acceptEdits
    case dontAsk
    case bypassPermissions
}

// MARK: - Prompt Option

struct PromptOption: Codable, Sendable, Identifiable {
    let index: Int
    let label: String
    var shortcut: String?
    var recommended: Bool?
    var selected: Bool?
    var kind: String? = nil

    var id: Int { index }

    var isFreeformInput: Bool { kind == "freeform_input" }
}

// MARK: - Prompt Type

enum PromptType: String, Codable, Sendable {
    case yesNo = "yes_no"
    case yesNoAlways = "yes_no_always"
    case multiSelect = "multi_select"
    case diffReview = "diff_review"
}

// MARK: - Dashboard State (composite observable state)

struct DashboardState: Sendable {
    // Connection
    var bridgeConnected = false
    /// Session that produced the latest state/update payload. This is used
    /// for attribution and may change automatically as hooks arrive.
    var sessionId: String?
    /// Session explicitly focused by the user via a session row, creature tap,
    /// menubar row, or hardware session switch. Visual selection should use
    /// this field, not `sessionId`, so activity does not look like selection.
    var focusedSessionId: String?

    // Agent state
    var state: AgentConnectionState = .disconnected
    var permissionMode: PermissionMode = .default
    var agentType: String?  // "claude-code" | "openclaw"
    var agentCapabilities: AgentCapabilities?

    // Tool info
    var currentTool: String?
    var toolInput: String?
    var toolProgress: String?

    // Project / Model
    var projectName: String?
    var modelName: String?
    var effortLevel: String?
    var billingType: BillingType = .unknown

    // Prompt
    var options: [PromptOption] = []
    var promptType: PromptType?
    var question: String?
    var navigable = false
    var cursorIndex = 0
    var suggestedPrompt: String?

    // Model catalog
    var modelCatalog: [ModelCatalogEntry] = []
    var sessionStatus: OcSessionStatus?

    // Remote / Gateway
    var remoteUrl: String?
    var pairingUrl: String?
    var workerSessionCount: Int?
    var gatewayAvailable = false
    var gatewayConnected = false
    var gatewayHasError = false
    var gatewayAuthStatus: String?
    var gatewayAuthRequestId: String?
    var gatewayAuthMessage: String?
    /// Locally-generated Gateway identity (Ed25519 public-key SHA-256 hex).
    /// Surfaced in pairing hints when auth is blocked on signature failure.
    var gatewayDeviceId: String?
    var daemonPort: Int?

    // Usage
    var sessionDurationSec = 0
    var inputTokens = 0
    var outputTokens = 0
    var toolCalls = 0
    var estimatedCostUsd: Double?
    var sessionPercent: Double?
    var costSpent: Double?
    var costLimit: Double?
    var resetTime: String?
    var resetDate: String?
    var fiveHourPercent: Double?
    var fiveHourResetsAt: String?
    var sevenDayPercent: Double?
    var sevenDayResetsAt: String?
    var previousFiveHourPercent: Double?
    var previousSevenDayPercent: Double?
    var extraUsageEnabled: Bool?
    var extraUsageMonthlyLimit: Double?
    var extraUsageUsedCredits: Double?
    var extraUsageUtilization: Double?
    var oauthConnected: Bool?
    var ollamaStatus: OllamaStatus?
    var usageStale: Bool?
    var codexAuthMode: String?
    var codexWebAuthConnected: Bool?
    var codexPlanType: String?
    var codexAccountId: String?
    var codexSubscriptionActiveUntil: String?
    var codexLastRefreshAt: String?
    var mlxModels: [String] = []
    var mlxModelCatalog: [String] = []
    var subscriptions: [SubscriptionInfo] = []
    var antigravityStatus: AntigravityStatusInfo?

    // Anthropic Admin API (optional — org-wide token usage when user
    // pastes a Console Admin API key in Settings). Separate from
    // `fiveHourPercent` / `sevenDayPercent` above (Pro/Max subscription
    // quota) because API usage billing is a different metric tier.
    var adminApiKeyPresent: Bool = false
    var adminApiTodayInputTokens: Int?
    var adminApiTodayOutputTokens: Int?
    var adminApiTodayCacheReadTokens: Int?
    var adminApiTodayCacheCreationTokens: Int?
    var adminApiMonthInputTokens: Int?
    var adminApiMonthOutputTokens: Int?
    var adminApiMonthCacheReadTokens: Int?
    var adminApiMonthCacheCreationTokens: Int?
    var adminApiTopModels: [AdminApiModelUsage] = []
    var adminApiFetchedAt: Double?
    var adminApiStale: Bool?

    // Voice
    var voiceState: String?  // idle | recording | transcribing | error
    var voiceText: String?
    var voiceError: String?

    // Voice Assistant (wake word pipeline)
    var voiceAssistantState: String?  // idle | listening | processing | speaking | disabled
    var voiceAssistantText: String?
    var voiceAssistantResponseText: String?

    // Display
    var hostDisplayOn = true

    // Multi-session
    var siblingSessions: [SessionInfo] = []

    // Device module health (from daemon statusSnapshot aggregation)
    var moduleHealth: ModuleHealthState?

}

// MARK: - Anthropic Admin API

struct AdminApiModelUsage: Sendable, Codable, Equatable {
    let model: String
    let totalTokens: Int
}

// MARK: - Module Health

struct ModuleHealthState: Sendable {
    var adb: AdbHealth?
    var d200h: D200hHealth?
    var pixoo: PixooHealth?
    var trmnl: TrmnlHealth?
    var serial: SerialHealth?
    var streamDeck: StreamDeckHealth?
    /// Divoom Timebox Mini (11×11 BLE) — daemon `statusSnapshot()`.
    var timebox: BLEMatrixHealth?
    /// iDotMatrix (32×32 BLE) — daemon `statusSnapshot()`.
    var idotmatrix: BLEMatrixHealth?
}

/// Shared shape for the BLE matrix panels (Timebox Mini, iDotMatrix). Both
/// daemon modules (`TimeboxModule`, `IDotMatrixModule`) emit an identical
/// `statusSnapshot()` — connection state plus a human `statusReason` ("connected",
/// "connecting…", "retrying (backed off)", "paused: host display asleep", or an
/// error string) — so the topology rail can show *why* a panel isn't streaming
/// instead of silently omitting it.
struct BLEMatrixHealth: Sendable {
    var configuredDeviceCount: Int = 0
    var connected: Bool = false
    var deviceName: String?
    var statusReason: String?
    var displayDimmed: Bool = false
    var hasFrame: Bool = false
    var lastError: String?
}

struct StreamDeckHealth: Sendable {
    /// Physical Stream Deck devices the Elgato plugin is driving, as
    /// reported via the `client_register` announcement.
    var devices: [StreamDeckDeviceInfo] = []
}

struct StreamDeckDeviceInfo: Sendable, Hashable {
    var id: String
    var name: String
    /// "streamdeck" | "streamdeckplus" | "streamdeckmini" | "streamdeckxl"
    /// | "streamdeckpedal" | "streamdeck-unknown". Kept as a String so
    /// future Elgato families decode without a model update.
    var family: String?
    var columns: Int?
    var rows: Int?
}

struct AdbHealth: Sendable {
    var available: Bool = false
    var devices: [String] = []
    var classifiedDevices: [ClassifiedDevice] = []
    var reverseReadyCount: Int = 0
    var lastError: String?
}

struct ClassifiedDevice: Sendable, Hashable {
    var serial: String
    var manufacturer: String?
    var model: String?
    /// Raw class string from the wire (e.g. `"e-ink.crema"`, `"ulanzi.tc001"`,
    /// `"android.tablet"`). Kept as String rather than enum so older
    /// daemons that emit unknown class names still decode.
    var deviceClass: String
}

/// What kind of Android device is attached. Used for raw-value constants
/// in the UI; wire format is a plain string so unknown classes from
/// newer daemons still round-trip.
///
/// - `.eInkCrema` / `.eInkPantone` / `.eInkKobo`: e-ink devices that need
///   slow, low-contrast UI and avoid animation. Wrong refresh strategy =
///   ghosting + flicker.
/// - `.androidTablet`: everything else (Lenovo, dev phones, generic).
///   Full-colour UI, normal refresh.
///
/// The Ulanzi TC001 8×32 LED matrix is intentionally absent: it is an ESP32
/// board (env `led8x32`) driven over USB serial / WiFi WS and surfaces through
/// the serial pipeline (`esp32DisplayName`), never the ADB tier. The legacy
/// `.ulanziTc001` case was removed on 2026-06-25.
///
/// Not gated by `#if os(macOS)` because the iOS companion's topology view
/// consumes the same wire format.
enum AdbDeviceClass: String, Sendable {
    case eInkCrema = "e-ink.crema"
    case eInkPantone = "e-ink.pantone"
    case eInkKobo = "e-ink.kobo"
    case androidTablet = "android.tablet"
}

struct D200hHealth: Sendable {
    var connected: Bool = false
    var managerOpened: Bool = false
    var sandboxEnabled: Bool = false
    var usbEntitlementPresent: Bool = false
    var buttonPressCount: Int = 0
    var hidReportCount: Int = 0
    var writeOK: Int = 0
    var writeFail: Int = 0
    var lastWriteError: String?
    var lastOpenError: String?
}

struct PixooHealth: Sendable {
    var configuredDeviceCount: Int = 0
    var deviceIps: [String] = []
    var hasFrame: Bool = false
    var displayDimmed: Bool = false
    var lastPushError: String?
    var devices: [PixooDeviceHealth] = []
}

struct PixooDeviceHealth: Sendable {
    var ip: String
    var online: Bool
    var failures: Int
    var backedOff: Bool
}

struct TrmnlHealth: Sendable {
    var deviceCount: Int = 0
    var staleDeviceCount: Int = 0
    var currentRefreshRate: Int = 180
    var telemetry: [TrmnlDeviceHealth] = []
}

struct TrmnlDeviceHealth: Sendable {
    var mac: String
    var width: Int?
    var height: Int?
    var rssi: Double?
    var batteryVoltage: Double?
    var secondsSinceSeen: Int?
    var stale: Bool
}

struct SerialHealth: Sendable {
    var connectedPorts: [String] = []
    var connectedBoards: [SerialPortInfo] = []
    var lastError: String?
}

struct SerialPortInfo: Sendable, Hashable {
    var port: String
    var board: String?
    var firmwareVersion: String?
}

extension SerialPortInfo {
    /// Human-friendly label for an ESP32 `board` wire string
    /// (`DeviceInfoMessage.board`). The descriptive suffix mirrors the friendly
    /// column in docs/hardware-compatibility.md (the naming SSOT). Unknown or
    /// missing boards fall back to a plain "ESP32" during the ~2s window before
    /// the firmware's first `device_info` frame arrives.
    ///
    /// This is the single source of truth — `TopologyRail` and
    /// `MenuBarTopologyList` both call it so the two surfaces can't drift.
    static func esp32DisplayName(for board: String?) -> String {
        switch board {
        case "ips_35":         return "ESP32 · IPS 3.5\""
        case "ips_10":         return "ESP32 · IPS 10.1\""
        case "round_amoled":   return "ESP32 · Round AMOLED 1.8\""
        case "86box":          return "ESP32 · 86 Box 4\""
        case "ttgo_t_display": return "ESP32 · TTGO T-Display 1.14\""
        case "esp32_c6_147":   return "ESP32 · C6 1.47\""
        // Ulanzi TC001 is an ESP32 under the hood but sold as a finished
        // product, so surface the brand instead of the raw board name.
        case "ulanzi_tc001":   return "Ulanzi TC001"
        case .some(let b) where !b.isEmpty: return "ESP32 · \(b)"
        default:               return "ESP32"
        }
    }
}
