// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/apme-classifier-rules.ts
// Regenerate: pnpm generate-apme-classifier-rules (drift gated by shared/src/__tests__/apme-classifier-rules-sync.test.ts)

import Foundation

#if os(macOS)

/// Prompt, backend try-order, and label-validation rules shared with the
/// Node classifier (bridge/src/apme/classifier.ts). Both daemons must reach
/// the same category for the same task.
enum ApmeClassifierRules {
    /// Every label the classifier prompt advertises and label validation
    /// accepts. Matches `ApmeClassifier.TaskCategory` — kept as a plain
    /// string list here (rather than sharing that enum) so this file has no
    /// dependency on the hand-written rule-based classifier's type.
    static let labels: [String] = [
        "planning",
        "research",
        "coding",
        "debugging",
        "refactoring",
        "review",
        "ops",
        "conversation",
        "multi_agent",
        "unknown",
    ]

    /// Backends the LLM-assist classifier may call, in try-order. `"rules"`
    /// is not a network call — it means "give up and return the rule-based
    /// `unknown`" — and is always last so a fully offline daemon still
    /// classifies. `api`/`openai` are never members: classification runs on
    /// every closed task with `unknown` rules, so routing it through a paid
    /// backend would bill the user for a call the eval pipeline makes
    /// silently, on every session, whatever judge backend they picked for
    /// actual eval scoring.
    static let backendOrder: [String] = [
        "mlx",
        "foundationModels",
        "rules",
    ]

    /// Output cap. One word from a ten-item vocabulary; a latency bound, not
    /// a cost control — deliberately far below the eval judge's 800-token
    /// cap, which is a DIFFERENT call with a different purpose.
    static let maxTokens = 20

    /// Per-call timeout in milliseconds (bridged to `TimeInterval` at the
    /// call site). Classification runs synchronously in the task-close path,
    /// so it must fail fast into the rule fallback.
    static let timeoutMs: Double = 15000

    static var timeoutSeconds: TimeInterval { timeoutMs / 1000 }

    static let systemPrompt = """
        You are a task classifier for coding agent sessions.
        Given the user's prompt and tool usage summary, classify this task into exactly ONE category.

        Categories:
        - planning: architecture design, plan mode, thinking about approach
        - research: searching code, reading docs, web search, investigating
        - coding: writing/editing code, creating files, implementing features
        - debugging: fixing bugs, running tests, investigating failures
        - refactoring: restructuring existing code without changing behavior
        - review: reading code for understanding, code review
        - ops: git operations, deployments, config changes, CI/CD
        - conversation: quick question, chat, no tools used
        - multi_agent: delegating to sub-agents

        Respond with ONLY the category name, nothing else.
        """

    /// Normalize a raw model response into one of `labels`, or nil when the
    /// response names no known category — callers must fall back to the
    /// rule-based result on nil, never guess. Exact match first (the
    /// instructed shape), then substring (models routinely wrap the answer
    /// in prose despite being told not to). Mirrors
    /// `normalizeClassifierLabel` in shared/src/apme-classifier-rules.ts.
    static func normalizeLabel(_ raw: String) -> String? {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz_")
        let cleaned = String(raw.lowercased().unicodeScalars.filter { allowed.contains($0) })
        if labels.contains(cleaned) { return cleaned }
        return labels.first(where: { cleaned.contains($0) })
    }

    /// The exact user-message shape both daemons send. `taskPrompt` is
    /// clipped to 500 chars by the caller (matches existing behavior).
    static func buildUserMessage(
        taskPrompt: String,
        toolSummary: String,
        totalToolCalls: Int,
        filesModified: Int,
        filesCreated: Int,
        sessionDurationSec: Int,
        turnCount: Int
    ) -> String {
        """
        Prompt: "\(taskPrompt)"
        Tools used: \(toolSummary.isEmpty ? "none" : toolSummary) (\(totalToolCalls) total)
        Files modified: \(filesModified), created: \(filesCreated)
        Duration: \(sessionDurationSec)s, turns: \(turnCount)
        """
    }
}

#endif
