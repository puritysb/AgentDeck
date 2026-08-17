// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/session-utils.ts (OBSERVED_SESSION_AGENT_KEYS)
//                  shared/src/timeline.ts      (TOOL_EXEC_SUPPRESSED_AGENTS)
// Regenerate: pnpm generate-observed-agent-rules (drift gated by shared/src/__tests__/observed-agent-rules.test.ts)

import Foundation

/// Observed-session id prefixes and the agents whose observed tool rows stay
/// out of the timeline. See the TypeScript sources for why these are generated
/// rather than written twice.
enum ObservedAgentRules {
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
    ]

    /// Bare id form — unchanged when the id carries no observed prefix.
    static func rawSessionId(_ value: String) -> String {
        for prefix in sessionPrefixes where value.hasPrefix(prefix) {
            return String(value.dropFirst(prefix.count))
        }
        return value
    }
}
