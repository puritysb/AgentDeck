// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/hook-harness.ts
// Regenerate: pnpm generate-hook-harness (drift gated by shared/src/__tests__/hook-harness-sync.test.ts)
import Foundation

/// Which harness a hook POST came from — decided by the payload, never by the
/// endpoint name alone and never by the model (#490). Codex speaks Claude's
/// lifecycle vocabulary and can run a Claude-shaped hook command, so an
/// unprefixed hook carrying a Codex thread was ingested as a Claude Code
/// session. Behaviour is pinned by `shared/hook-harness-vectors.json`
/// (`CodexHookHarnessTests`).
enum CodexHookHarness {
    enum Route: Equatable {
        /// Ingest under the name it arrived with.
        case asPosted
        /// A Codex payload under an unprefixed name: ingest as this event.
        case codex(String)
        /// A Codex payload for an event with no Codex route: ingest nothing.
        case drop
    }

    static let threadIdKeys = ["thread-id", "thread_id", "threadId", "codex.thread_id", "thread.id"]
    static let notifyTurnCompleteType = "agent-turn-complete"
    static let harnessPrefixes = ["codex_", "opencode_", "antigravity_", "kiro_", "hermes_"]
    static let replayWindow: TimeInterval = 10
    private static let rolloutBasenamePattern = #"^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f-]{8,}\.jsonl$"#

    private static let routes: [String: String] = [
        "sessionstart": "codex_session_start",
        "userpromptsubmit": "codex_user_prompt_submit",
        "pretooluse": "codex_tool_start",
        "toolstart": "codex_tool_start",
        "posttooluse": "codex_tool_end",
        "toolend": "codex_tool_end",
        "posttoolusefailure": "codex_tool_end",
        "toolfailure": "codex_tool_end",
        "stop": "codex_stop",
        "permissionrequest": "codex_permission_request",
        "interrupt": "codex_interrupt",
        "subagentstart": "codex_subagent_start",
        "subagentstop": "codex_subagent_stop",
        "agentturncomplete": "codex_turn_complete",
        "turncomplete": "codex_turn_complete",
    ]

    private static let fingerprintFields: [String: [String]] = [
        "codex_user_prompt_submit": ["turn_id", "turn-id"],
        "codex_stop": ["turn_id", "turn-id"],
        "codex_interrupt": ["turn_id", "turn-id"],
        "codex_turn_complete": ["turn_id", "turn-id"],
        "codex_tool_start": ["tool_use_id"],
        "codex_tool_end": ["tool_use_id"],
        "codex_permission_request": ["tool_use_id"],
        "codex_session_start": ["source"],
        "codex_subagent_start": ["agent_id"],
        "codex_subagent_stop": ["agent_id"],
    ]

    private static let fingerprintContentFields: [String: [String]] = [
        "codex_user_prompt_submit": ["prompt", "user_prompt"],
        "codex_stop": ["last_assistant_message"],
        "codex_turn_complete": ["last-assistant-message", "last_assistant_message"],
    ]

    private static func nonEmpty(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func stripCodexPrefix(_ id: String) -> String {
        id.hasPrefix("codex:") ? String(id.dropFirst("codex:".count)) : id
    }

    /// Bare Codex thread id named under one of Codex's thread keys.
    static func threadId(from json: [String: Any]) -> String? {
        for key in threadIdKeys {
            if let raw = nonEmpty(json[key]) { return stripCodexPrefix(raw) }
        }
        return nil
    }

    /// True when the payload carries evidence only Codex produces.
    static func isCodexPayload(_ json: [String: Any]) -> Bool {
        if threadId(from: json) != nil { return true }
        if json["type"] as? String == notifyTurnCompleteType { return true }
        // An ephemeral Codex run has no rollout: a turn id without any
        // transcript path is Codex (every Claude hook names its transcript).
        guard let tp = nonEmpty(json["transcript_path"]) else { return nonEmpty(json["turn_id"]) != nil }
        let base = tp.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        return base.range(of: rolloutBasenamePattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func route(event: String, json: [String: Any]) -> Route {
        if harnessPrefixes.contains(where: { event.hasPrefix($0) }) { return .asPosted }
        guard isCodexPayload(json) else { return .asPosted }
        // Codex notify names its event in the body, whatever URL it was POSTed to.
        let key = json["type"] as? String == notifyTurnCompleteType
            ? "agentturncomplete"
            : event.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "")
        if let routed = routes[key] { return .codex(routed) }
        return .drop
    }

    /// One Codex event instance: event + thread + the field that tells two
    /// instances of that event apart. Nil when that field is missing — then
    /// the caller must not deduplicate.
    static func fingerprint(event: String, json: [String: Any]) -> String? {
        guard let thread = nonEmpty(json["session_id"]) ?? threadId(from: json) else { return nil }
        guard let discriminator = (fingerprintFields[event] ?? []).lazy.compactMap({ nonEmpty(json[$0]) }).first
        else { return nil }
        let key = "\(event)|\(stripCodexPrefix(thread))|\(discriminator)"
        guard let contentFields = fingerprintContentFields[event] else { return key }
        let content = contentFields.lazy.compactMap { json[$0] as? String }.first { !$0.isEmpty } ?? ""
        return "\(key)|\(fnv1a32Utf16(content))"
    }

    /// FNV-1a (32-bit) over UTF-16 code units, 8 lowercase hex digits — the
    /// same units JavaScript's `charCodeAt` walks.
    static func fnv1a32Utf16(_ text: String) -> String {
        var hash: UInt32 = 0x811c9dc5
        for unit in text.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x01000193
        }
        let hex = String(hash, radix: 16)
        return String(repeating: "0", count: 8 - hex.count) + hex
    }
}
