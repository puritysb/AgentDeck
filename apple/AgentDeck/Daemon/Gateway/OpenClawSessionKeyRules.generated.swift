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
        #"^agent:[^:]+:[a-z0-9_-]+:(?:dm|direct):[^:]+$"#,
    ]

    private static let conversationRegexes: [NSRegularExpression] =
        conversationKeyPatterns.map { try! NSRegularExpression(pattern: $0) }

    static func isConversationKey(_ key: String?, mainSessionKey: String? = nil) -> Bool {
        guard let key, !key.isEmpty else { return false }
        if let mainSessionKey, !mainSessionKey.isEmpty, key == mainSessionKey { return true }
        let range = NSRange(key.startIndex..., in: key)
        return conversationRegexes.contains { $0.firstMatch(in: key, range: range) != nil }
    }

    /// The steering key from a `sessions.list` answer (newest first): the
    /// newest conversation key, else the Gateway's main session key, else the
    /// newest key (previous behaviour).
    static func pickSteeringKey(_ keysNewestFirst: [String], mainSessionKey: String? = nil) -> String? {
        if let key = keysNewestFirst.first(where: { isConversationKey($0, mainSessionKey: mainSessionKey) }) { return key }
        if let mainSessionKey, !mainSessionKey.isEmpty { return mainSessionKey }
        return keysNewestFirst.first
    }

    /// The steering key after an event names `eventKey`: a conversation key
    /// takes over; a background key only fills an empty slot (main first).
    static func nextSteeringKey(current: String?, eventKey: String?, mainSessionKey: String? = nil) -> String? {
        guard let eventKey, !eventKey.isEmpty else { return current }
        if isConversationKey(eventKey, mainSessionKey: mainSessionKey) { return eventKey }
        if let current { return current }
        if let mainSessionKey, !mainSessionKey.isEmpty { return mainSessionKey }
        return eventKey
    }

    /// `hello-ok.snapshot.sessionDefaults.mainSessionKey`, when the Gateway sent one.
    static func mainSessionKey(fromHello hello: [String: Any]?) -> String? {
        guard let snapshot = hello?["snapshot"] as? [String: Any],
              let defaults = snapshot["sessionDefaults"] as? [String: Any],
              let key = defaults["mainSessionKey"] as? String,
              !key.isEmpty, key.count <= 512 else { return nil }
        return key
    }
}
