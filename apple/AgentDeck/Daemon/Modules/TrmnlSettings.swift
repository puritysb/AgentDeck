#if os(macOS)
// TrmnlSettings.swift — TRMNL BYOS config + shared value types for the Swift daemon.
//
// Mirrors bridge/src/trmnl/trmnl-settings.ts. The App Store daemon reads the
// `trmnl` block from settings.json for the enable gate / cadence / auto-register
// policy; device enrollment + telemetry are held in-memory by TrmnlModule (no
// settings.json writes from the daemon — a panel that survives a daemon restart
// simply re-enrolls on its next poll, which is safe because auth is soft).

import Foundation

/// Static config read from settings.json `trmnl` block.
struct TrmnlConfig: Sendable {
    var enabled: Bool = false
    /// Idle/working cadence (seconds) — slow + battery-friendly.
    var refreshRate: Int = 180
    /// Cadence (seconds) while a session is AWAITING the user.
    var refreshActive: Int = 60
    /// Image-download timeout (seconds) handed to the firmware as image_url_timeout.
    var imageUrlTimeout: Int = 30
    var autoRegister: Bool = true

    /// Too-frequent polls drain the panel battery + full-flash the e-ink.
    static let minRefresh = 30

    /// Cadence for a poll: only AWAITING speeds it up (a deep-sleep e-ink panel
    /// can't be pushed and each wake flashes the screen). Mirrors trmnl-settings.ts.
    func effectiveRefresh(awaiting: Int, working: Int) -> Int {
        max(TrmnlConfig.minRefresh, awaiting > 0 ? refreshActive : refreshRate)
    }
}

/// One live session row, parsed from a `sessions_list` broadcast.
struct TrmnlSession: Sendable {
    let agentType: String
    let projectName: String
    let modelName: String
    let state: String
}

/// The renderable dashboard state (mirrors the fields trmnl-layout.ts consumes).
struct TrmnlDashState: Sendable {
    var sessions: [TrmnlSession] = []
    var fiveHourPercent: Double = 0
    var sevenDayPercent: Double = 0
    var totalTokens: Int = 0
    var totalCost: Double = 0
    /// True only when subscription quota is actually known, so the renderer shows
    /// "—" instead of a confident 0% when the hub is OAuth-blind / has no relay.
    var usageKnown: Bool = false
    /// ISO timestamps when each quota window resets (for a countdown). nil ⇒ hidden.
    var fiveHourResetsAt: String?
    var sevenDayResetsAt: String?
    /// "HH:MM" stamp baked at render time (the device pulls; this is render-time).
    var nowText: String = ""
}

/// BYOS telemetry headers a panel sends on /api/setup + /api/display.
struct TrmnlHeaders: Sendable {
    let mac: String
    let accessToken: String
    let fwVersion: String
    let batteryVoltage: Double?
    let rssi: Double?
    let refreshRate: Int?
    /// Sanitized panel size (nil ⇒ caller defaults to 800×480).
    let width: Int?
    let height: Int?
    let userAgent: String
}

enum TrmnlSettings {
    static var settingsPath: String {
        if let override = ProcessInfo.processInfo.environment["AGENTDECK_DATA_DIR"] {
            return (override as NSString).appendingPathComponent("settings.json")
        }
        return AgentDeckPaths.settingsJson.path
    }

    /// Load the trmnl config with defaults. Returns defaults on any failure.
    static func load() -> TrmnlConfig {
        var cfg = TrmnlConfig()
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: settingsPath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let t = json["trmnl"] as? [String: Any]
        else { return cfg }
        if let e = t["enabled"] as? Bool { cfg.enabled = e }
        if let r = t["refreshRate"] as? Int, r >= 5 { cfg.refreshRate = r }
        else if let r = t["refreshRate"] as? Double, r >= 5 { cfg.refreshRate = Int(r) }
        if let r = t["refreshActive"] as? Int, r >= 5 { cfg.refreshActive = r }
        else if let r = t["refreshActive"] as? Double, r >= 5 { cfg.refreshActive = Int(r) }
        if let v = t["imageUrlTimeout"] as? Int, v > 0 { cfg.imageUrlTimeout = min(65, v) }
        else if let v = t["imageUrlTimeout"] as? Double, v > 0 { cfg.imageUrlTimeout = min(65, Int(v)) }
        if let a = t["autoRegister"] as? Bool { cfg.autoRegister = a }
        return cfg
    }

    /// Canonical MAC identity (mirrors trmnl-settings.ts normalizeMac): 12-hex →
    /// uppercase colon pairs; any other id → its bare uppercase hex digits so
    /// varied punctuation collapses to one key.
    static func normalizeMac(_ mac: String) -> String {
        let hex = String(mac.uppercased().filter { $0.isHexDigit })
        if hex.count == 12 {
            var pairs: [String] = []
            var idx = hex.startIndex
            while idx < hex.endIndex {
                let next = hex.index(idx, offsetBy: 2)
                pairs.append(String(hex[idx..<next]))
                idx = next
            }
            return pairs.joined(separator: ":")
        }
        return hex.isEmpty ? mac.trimmingCharacters(in: .whitespaces).uppercased() : hex
    }
}
#endif
