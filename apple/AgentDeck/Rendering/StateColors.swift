// StateColors.swift — SwiftUI lookups for session-state and agent-brand colours.
//
// Both are bindings, not palettes. State colours come from the generated
// SessionStatePresentation (shared/src/session-state-presentation.ts, the
// `Session` token group — DESIGN.md §2.7); brand colours come from
// DesignTokens.Brand (design/brand/*.svg). Never add a state or brand literal
// here — change design/tokens.css and regenerate.

import SwiftUI

enum StateColors {

    // MARK: - Session state

    static func color(for state: AgentConnectionState, onPaper: Bool = false) -> Color {
        Color(rgb: state.sessionTone.colorHex(onPaper: onPaper))
    }

    /// Accepts raw wire state strings — mirrors stateColor() in TS: missing →
    /// offline, unknown → idle.
    static func color(for stateKey: String?, onPaper: Bool = false) -> Color {
        Color(rgb: SessionTone(wire: stateKey).colorHex(onPaper: onPaper))
    }

    // MARK: - Agent brand

    /// Brand hue as legible on dark product screens (mirrors agentBrandColor()
    /// in TS). OpenCode's upstream mark is near-black, so dark screens use its
    /// light variant; `monitor` and unknown agents are the neutral HUD grey.
    static func brand(agent agentType: String?) -> Color {
        switch agentType {
        case "claude-code": return DesignTokens.Brand.claudeCode
        case "openclaw":    return DesignTokens.Brand.openclaw
        case "codex-cli", "codex-app": return DesignTokens.Brand.codex
        case "opencode":    return DesignTokens.Brand.opencodeOnDark
        case "antigravity": return DesignTokens.Brand.antigravity
        case "kiro-cli", "kiro-ide": return DesignTokens.Brand.kiro
        default:            return DesignTokens.UI.hudSubtext
        }
    }

    // MARK: - Helpers

    /// Mix a hex color toward black by `ratio` (0 = original, 1 = black). Matches dimColor() in TS.
    static func dim(_ hex: String, ratio: Double) -> String {
        guard let (r, g, b) = parseHex(hex) else { return hex }
        let clamped = max(0.0, min(1.0, ratio))
        let dr = UInt8(Double(r) * (1.0 - clamped))
        let dg = UInt8(Double(g) * (1.0 - clamped))
        let db = UInt8(Double(b) * (1.0 - clamped))
        return String(format: "#%02x%02x%02x", dr, dg, db)
    }

    fileprivate static func parseHex(_ hex: String) -> (UInt8, UInt8, UInt8)? {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        return (UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff))
    }
}

// MARK: - Color conveniences

extension Color {
    /// Initialize from "#rrggbb" or "rrggbb". Invalid input returns opaque magenta (fails loud in dev).
    init(hex: String) {
        guard let (r, g, b) = StateColors.parseHex(hex) else {
            self = Color(red: 1.0, green: 0.0, blue: 1.0)
            return
        }
        self = Color(red: Double(r) / 255.0, green: Double(g) / 255.0, blue: Double(b) / 255.0)
    }

    /// Initialize from a generated RGB888 value (`0xRRGGBB`).
    init(rgb: UInt32) {
        self = Color(red: Double((rgb >> 16) & 0xff) / 255.0,
                     green: Double((rgb >> 8) & 0xff) / 255.0,
                     blue: Double(rgb & 0xff) / 255.0)
    }
}
