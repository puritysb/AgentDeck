import Foundation

/// Model, reasoning effort and permission mode of an observed session, in the
/// agent's OWN words (#463). Mirrors `claudeHookSettings` in
/// `bridge/src/hook-claude-sessions.ts` and the Codex `turn_context` read in
/// `bridge/src/passive-observer.ts`.
///
/// Every value is passed through verbatim and nothing is ever defaulted: the
/// level sets are open (they differ per agent and per model and change with
/// agent updates), so a surface that has not been told a value shows none.
///
/// Sources, measured 2026-10-06:
/// - Claude Code 2.1.289 hooks: `SessionStart.model`, `effort.level` (on Stop;
///   follows a live `/effort`), `permission_mode` (every event).
/// - Codex 0.156 hooks: `model` (every event). Its hook `permission_mode` is a
///   Claude-compatible label derived from `approval_policy`, not Codex's own
///   vocabulary, so it is ignored here. Effort and mode come from the
///   rollout's latest `turn_context` instead.
enum ObservedAgentSettings {
    struct Reading: Equatable {
        var model: String?
        var effortLevel: String?
        var permissionMode: String?

        var isEmpty: Bool { model == nil && effortLevel == nil && permissionMode == nil }
    }

    static func claude(fromHook json: [String: Any]) -> Reading {
        Reading(
            model: token(json["model"]),
            effortLevel: token((json["effort"] as? [String: Any])?["level"]),
            permissionMode: token(json["permission_mode"]))
    }

    static func codex(fromHook json: [String: Any]) -> Reading {
        Reading(model: token(json["model"]))
    }

    /// Codex `turn_context.payload`: `effort`, and `plan` while the
    /// collaboration mode is plan, otherwise `sandbox_policy.type`.
    static func codex(turnContext payload: [String: Any]) -> Reading {
        let collaboration = (payload["collaboration_mode"] as? [String: Any])?["mode"] as? String
        let sandbox = token((payload["sandbox_policy"] as? [String: Any])?["type"])
        return Reading(
            model: token(payload["model"]),
            effortLevel: token(payload["effort"]),
            permissionMode: collaboration == "plan" ? "plan" : sandbox)
    }

    /// Overlay a reading onto what the row already says: a field the reading
    /// does not carry is retained, never cleared.
    static func merge(_ reading: Reading, into current: Reading) -> Reading {
        Reading(
            model: reading.model ?? current.model,
            effortLevel: reading.effortLevel ?? current.effortLevel,
            permissionMode: reading.permissionMode ?? current.permissionMode)
    }

    /// The latest `turn_context` payload in a rollout tail (JSONL, oldest
    /// first). A partial first line from a mid-file seek simply fails to parse.
    static func latestTurnContext(inRolloutTail text: String) -> [String: Any]? {
        for line in text.split(separator: "\n").reversed() where line.contains("\"turn_context\"") {
            guard let record = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  record["type"] as? String == "turn_context",
                  let payload = record["payload"] as? [String: Any] else { continue }
            return payload
        }
        return nil
    }

    /// A short printable token, or nil.
    static func token(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let clean = String(raw.prefix(256).unicodeScalars.filter {
            !CharacterSet.controlCharacters.contains($0)
        }).trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? nil : String(clean.prefix(64))
    }
}
