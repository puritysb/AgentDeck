// GENERATED from shared/src/usage-presentation.ts. DO NOT EDIT.
import Foundation

enum UsagePresentation {
    static let heading = "USAGE"
    static func lunaActive(_ primary: Double, _ secondary: Double, _ reserve: Double) -> Bool { return reserve >= 0 && (primary >= 100 || secondary >= 100) }
    /// usageCreditsActive: balance is -1 when unknown, +infinity when unlimited.
    static func creditsActive(_ primary: Double, _ secondary: Double, _ balance: Double) -> Bool { return balance > 0 && (primary >= 100 || secondary >= 100) }
    /// formatCreditBalance: truncated, integer-only, "∞" when unlimited.
    static func formatCreditBalance(_ balance: Double) -> String {
        if balance == .infinity { return "\u{221E}" }
        if !balance.isFinite || balance <= 0 { return "0" }
        for (divisor, suffix) in [(1000000.0, "M"), (1000.0, "K")] where balance >= divisor {
            let tenths = Int((balance * 10 / divisor).rounded(.down))
            return tenths >= 1000 || tenths % 10 == 0 ? "\(tenths / 10)\(suffix)" : "\(tenths / 10).\(tenths % 10)\(suffix)"
        }
        if balance >= 10 { return "\(Int(balance.rounded(.down)))" }
        let tenths = Int((balance * 10).rounded(.down))
        return tenths % 10 == 0 ? "\(tenths / 10)" : "\(tenths / 10).\(tenths % 10)"
    }
    /// usageSubscriptionTier: the subscription name without its provider prefix.
    static func subscriptionTier(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        for prefix in ["Claude", "ChatGPT", "Codex", "GLM Coding Plan", "z.ai", "Google AI", "Antigravity", "AGY"]
            where trimmed.lowercased().hasPrefix(prefix.lowercased()) {
            let tail = trimmed.dropFirst(prefix.count).drop { " ·:-".contains($0) }
            let tier = tail.trimmingCharacters(in: .whitespaces)
            return tier
        }
        return trimmed
    }
}
