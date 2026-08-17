// StateColors.swift — Canonical state / agent-brand palette.
// Swift port of shared/src/state-colors.ts (single source of truth across platforms).
//
// New callers should use `StateColors.color(for:)` / `StateColors.brand(agent:)`.
// Existing callers with inline palettes (StatusBadge, ControlTowerPanel, SessionListPanel,
// TerrariumConfig) can migrate incrementally — this file does not
// modify them.

import SwiftUI

#if canImport(CoreGraphics)
import CoreGraphics
#endif

enum StateColors {

    // MARK: - Hex constants (authoritative)

    enum Hex {
        // State
        static let idle          = "#22c55e"  // green-500
        static let processing    = "#3b82f6"  // blue-500
        static let awaiting      = "#f59e0b"  // amber-500  (permission / option / diff)
        static let disconnected  = "#6b7280"  // gray-500

        // Agent brand
        static let claudeCode = "#C07058"  // terracotta
        static let openclaw   = "#ff4d4d"  // red
        static let codexCli   = "#6366f1"  // indigo-500
        static let opencode   = "#F1ECEC"  // cream
        static let antigravity = "#5F6368"  // Google gray
        static let kiro       = "#7C3AED"  // Kiro violet
        static let monitor    = "#94a3b8"  // slate-400
    }

    // MARK: - RGB triples (0–255) for Core Graphics callers

    enum RGB255 {
        static let idle:         (UInt8, UInt8, UInt8) = (34, 197, 94)
        static let processing:   (UInt8, UInt8, UInt8) = (59, 130, 246)
        static let awaiting:     (UInt8, UInt8, UInt8) = (245, 158, 11)
        static let disconnected: (UInt8, UInt8, UInt8) = (107, 114, 128)

        static let claudeCode:   (UInt8, UInt8, UInt8) = (192, 112, 88)
        static let openclaw:     (UInt8, UInt8, UInt8) = (255, 77, 77)
        static let codexCli:     (UInt8, UInt8, UInt8) = (99, 102, 241)
        static let opencode:     (UInt8, UInt8, UInt8) = (241, 236, 236)
        static let antigravity:  (UInt8, UInt8, UInt8) = (95, 99, 104)
        static let monitor:      (UInt8, UInt8, UInt8) = (148, 163, 184)
    }

    // MARK: - SwiftUI Color lookups

    static func color(for state: AgentConnectionState) -> Color {
        switch state {
        case .disconnected:       return Color(hex: Hex.disconnected)
        case .idle:               return Color(hex: Hex.idle)
        case .processing:         return Color(hex: Hex.processing)
        case .awaitingPermission,
             .awaitingOption,
             .awaitingDiff:       return Color(hex: Hex.awaiting)
        }
    }

    /// Accepts raw state strings (e.g., from JSON payloads) — mirrors stateColor() in TS.
    static func color(for stateKey: String?) -> Color {
        guard let stateKey, let state = AgentConnectionState(rawValue: stateKey) else {
            return Color(hex: Hex.idle)  // TS fallback is IDLE, not disconnected
        }
        return color(for: state)
    }

    static func brand(agent agentType: String?) -> Color {
        switch agentType {
        case "claude-code": return Color(hex: Hex.claudeCode)
        case "openclaw":    return Color(hex: Hex.openclaw)
        case "codex-cli":   return Color(hex: Hex.codexCli)
        case "codex-app":   return Color(hex: Hex.codexCli)
        case "opencode":    return Color(hex: Hex.opencode)
        case "antigravity": return Color(hex: Hex.antigravity)
        case "kiro-cli", "kiro-ide": return Color(hex: Hex.kiro)
        case "monitor":     return Color(hex: Hex.monitor)
        default:            return Color(hex: Hex.monitor)  // slate fallback
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

// MARK: - Color(hex:) convenience

extension Color {
    /// Initialize from "#rrggbb" or "rrggbb". Invalid input returns opaque magenta (fails loud in dev).
    init(hex: String) {
        guard let (r, g, b) = StateColors.parseHex(hex) else {
            self = Color(red: 1.0, green: 0.0, blue: 1.0)
            return
        }
        self = Color(red: Double(r) / 255.0, green: Double(g) / 255.0, blue: Double(b) / 255.0)
    }
}
