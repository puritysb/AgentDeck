// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/openclaw-session-key.ts
// Regenerate: pnpm generate-openclaw-session-key-rules (drift gated by shared/src/__tests__/openclaw-session-key-sync.test.ts)
import Foundation

/// Which OpenClaw Gateway session a device's prompt, stop or setting targets.
/// The activity key (whatever spoke last) still drives state; only a key with
/// a conversation shape becomes the steering key, so a cron tick, heartbeat or
/// eval run never captures the deck's next prompt. Behaviour is pinned by
/// `shared/openclaw-session-key-vectors.json` (`OpenClawSessionKeyRulesTests`).
enum OpenClawSessionKeyRules {
    static let conversationKeyPatterns: [String] = [
        #"^agent:[^:]+:(?:main|voice)$"#,
        #"^agent:[^:]+:dashboard:[^:]+$"#,
        #"^agent:[^:]+:[a-z0-9_-]+:(?:group|dm|direct|channel|thread):[^:]+$"#,
    ]

    private static let conversationRegexes: [NSRegularExpression] =
        conversationKeyPatterns.map { try! NSRegularExpression(pattern: $0) }

    static func isConversationKey(_ key: String?) -> Bool {
        guard let key, !key.isEmpty else { return false }
        let range = NSRange(key.startIndex..., in: key)
        return conversationRegexes.contains { $0.firstMatch(in: key, range: range) != nil }
    }

    /// The steering key from a `sessions.list` answer (newest first): the
    /// newest conversation key, else the newest key (previous behaviour).
    static func pickSteeringKey(_ keysNewestFirst: [String]) -> String? {
        keysNewestFirst.first(where: { isConversationKey($0) }) ?? keysNewestFirst.first
    }

    /// The steering key after an event names `eventKey`: a conversation key
    /// takes over; a background key only fills an empty slot.
    static func nextSteeringKey(current: String?, eventKey: String?) -> String? {
        guard let eventKey, !eventKey.isEmpty else { return current }
        if isConversationKey(eventKey) { return eventKey }
        return current ?? eventKey
    }
}
