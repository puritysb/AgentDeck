// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/session-utils.ts (OBSERVED_SESSION_AGENT_KEYS)
//                  shared/src/timeline.ts      (TOOL_EXEC_SUPPRESSED_AGENTS)
//                  shared/src/timeline-task-display.ts (TIMELINE_TURN_RULES)
// Regenerate: pnpm generate-observed-agent-rules (drift gated by shared/src/__tests__/observed-agent-rules.test.ts)

import Foundation

/// Observed-session id prefixes and the agents whose observed tool rows stay
/// out of the timeline. See the TypeScript sources for why these are generated
/// rather than written twice.
enum ObservedAgentRules {
    static let openCodePendingRequestLimit = 64
    #if os(macOS)
    static let codexMetadataHeadBytes = 131072
    static let codexMetadataCacheLimit = 256
    static let codexMetadataInFlightLimit = 8
    static let codexMetadataRetryMs: Double = 60000
    #endif
    static let turnMergeMaxGapMs: Double = 43200000
    static let turnActivityTypes: Set<String> = ["tool_exec"]

    #if os(macOS)
    /// Explicit rollout discriminators; a parent id alone does not prove a child.
    static func codexSessionMetaIsSubagent(_ payload: [String: Any]) -> Bool {
        if let source = payload["source"] as? [String: Any], source.keys.contains("subagent") { return true }
        guard payload["thread_source"] as? String == "subagent",
              let parent = payload["parent_thread_id"] as? String else { return false }
        return !parent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func codexSessionMetaSubagentVerdict(_ payload: [String: Any]) -> Bool? {
        if codexSessionMetaIsSubagent(payload) { return true }
        if payload["thread_source"] as? String == "subagent" { return nil }
        let sourceString = payload["source"] as? String
        let sourceObject = payload["source"] as? [String: Any]
        let threadSource = payload["thread_source"] as? String
        if sourceString?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            || sourceObject?.isEmpty == false
            || threadSource?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false { return false }
        return nil
    }
    #endif

    /// A passively-observed session is keyed `observed:<agent>:<uuid>` in
    /// `sessions_list` and on devices, while timeline rows, hook payloads and
    /// transcripts use the bare uuid — so anything comparing one against the
    /// other must strip this first.
    static let sessionPrefixes: [String] = [
        "observed:claude:",
        "observed:codex:",
        "observed:codex-app:",
        "observed:opencode:",
        "observed:antigravity:",
        "observed:kiro:",
        "observed:kiro-ide:",
        "observed:hermes:",
    ]

    /// Agents whose observed per-tool rows would drown their own prompt and
    /// response rows in the bounded timeline buffer.
    static let toolExecSuppressed: Set<String> = [
        "codex-cli",
        "codex-app",
        "opencode",
        "antigravity",
        "kiro-cli",
        "kiro-ide",
        "hermes",
    ]

    /// Bare id form — unchanged when the id carries no observed prefix.
    static func rawSessionId(_ value: String) -> String {
        for prefix in sessionPrefixes where value.hasPrefix(prefix) {
            return String(value.dropFirst(prefix.count))
        }
        return value
    }
}
