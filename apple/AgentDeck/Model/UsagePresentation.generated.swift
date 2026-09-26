// GENERATED from shared/src/usage-presentation.ts. DO NOT EDIT.
import Foundation

enum UsagePresentation {
    static let heading = "USAGE"
    static func lunaActive(_ primary: Double, _ secondary: Double, _ reserve: Double) -> Bool { return reserve >= 0 && (primary >= 100 || secondary >= 100) }
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
