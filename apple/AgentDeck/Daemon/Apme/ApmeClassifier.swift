#if os(macOS)
// ApmeClassifier.swift — Task classification for APME runs.
// 1:1 port of bridge/src/apme/classifier.ts rule-based classifier.

import Foundation

// MARK: - Task signals (agent-agnostic feature vector)

struct TaskSignals: Codable {
    var toolCounts: [String: Int] = [:]
    var dominantTool: String?
    var totalToolCalls: Int = 0
    var turnCount: Int = 0
    var sessionDurationSec: Int = 0
    var promptLengthChars: Int = 0
    var planModeUsed: Bool = false
    var permissionRequests: Int = 0
    var diffReviews: Int = 0
    var filesCreated: Int = 0
    var filesModified: Int = 0
    var testCommandsRun: Int = 0
    var webSearches: Int = 0
    var agentDelegations: Int = 0
    var isAutomated: Bool?
    var ocToolNames: [String]?
}

// MARK: - Task categories

enum TaskCategory: String, Codable, CaseIterable {
    case planning, research, coding, debugging, refactoring
    case review, ops, conversation
    case multiAgent = "multi_agent"
    case unknown
}

// MARK: - Classifier

enum ApmeClassifier {
    private static let testPattern = try! NSRegularExpression(
        pattern: #"\b(test|vitest|jest|pytest|cargo\s+test|go\s+test|xcodebuild\s+test|gradlew\s+test|pnpm\s+test|npm\s+test)\b"#,
        options: .caseInsensitive
    )

    static func computeSignals(store: ApmeStore, runId: String) -> TaskSignals {
        let run = store.getRun(id: runId)
        let steps = store.listSteps(runId: runId)

        var signals = TaskSignals()
        var ocTools = Set<String>()

        for step in steps {
            if step.kind == "tool_start" || step.kind == "PreToolUse", let tool = step.toolName {
                signals.toolCounts[tool, default: 0] += 1
                if tool == "Write" { signals.filesCreated += 1 }
                if tool == "Edit" { signals.filesModified += 1 }
                if tool == "WebSearch" || tool == "WebFetch" { signals.webSearches += 1 }
                if tool == "Agent" { signals.agentDelegations += 1 }
                if tool == "Bash" {
                    if let data = step.payload.data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let cmd = json["command"] as? String {
                        let range = NSRange(cmd.startIndex..., in: cmd)
                        if testPattern.firstMatch(in: cmd, range: range) != nil {
                            signals.testCommandsRun += 1
                        }
                    }
                }
            }
            if step.kind == "user_prompt_submit" || step.kind == "UserPromptSubmit" {
                signals.turnCount += 1
            }
            // Plan mode detection
            if let data = step.payload.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let mode = json["mode"] as? String, mode == "plan" {
                    signals.planModeUsed = true
                }
                if step.kind == "permission_prompt" { signals.permissionRequests += 1 }
                if step.kind == "diff_prompt" { signals.diffReviews += 1 }
                if let auto = json["chatIsAutomated"] as? Bool { signals.isAutomated = auto }
                if let tools = json["chatToolNames"] as? [String] {
                    ocTools.formUnion(tools)
                }
            }
        }

        signals.totalToolCalls = signals.toolCounts.values.reduce(0, +)
        signals.dominantTool = signals.toolCounts.max(by: { $0.value < $1.value })?.key
        if let run {
            signals.sessionDurationSec = run.endedAt != nil && run.startedAt > 0
                ? (run.endedAt! - run.startedAt) / 1000
                : 0
            signals.promptLengthChars = run.taskPrompt?.count ?? 0
        }
        if !ocTools.isEmpty { signals.ocToolNames = Array(ocTools) }

        return signals
    }

    static func classify(_ signals: TaskSignals) -> TaskCategory {
        func toolPct(_ tools: String...) -> Double {
            guard signals.totalToolCalls > 0 else { return 0 }
            let sum = tools.reduce(0) { $0 + (signals.toolCounts[$1] ?? 0) }
            return Double(sum) / Double(signals.totalToolCalls)
        }

        // Priority-ordered rules (matches bridge/src/apme/classifier.ts)
        if signals.agentDelegations >= 2 { return .multiAgent }
        if signals.planModeUsed { return .planning }
        if signals.totalToolCalls <= 2 && signals.sessionDurationSec < 120 { return .conversation }
        if signals.turnCount >= 1 && signals.turnCount <= 3 && signals.totalToolCalls <= 5
            && signals.filesModified == 0 && signals.filesCreated == 0 { return .planning }
        if signals.webSearches > 0 || (toolPct("Grep", "Glob") > 0.4
            && signals.filesModified == 0 && signals.filesCreated == 0) { return .research }
        if signals.testCommandsRun >= 1 && (signals.filesModified > 0 || signals.filesCreated > 0)
            && toolPct("Bash") > 0.2 { return .debugging }
        if toolPct("Edit") > 0.5 && signals.filesCreated == 0 && signals.filesModified >= 3 { return .refactoring }
        if toolPct("Edit", "Write") > 0.3 && (signals.filesModified >= 1 || signals.filesCreated >= 1) { return .coding }
        if toolPct("Read") > 0.5 && signals.totalToolCalls >= 5
            && signals.filesModified <= 1 && signals.filesCreated == 0 { return .review }
        if toolPct("Bash") > 0.5 && toolPct("Edit", "Write") < 0.2 { return .ops }

        return .unknown
    }

    static func classifyRun(store: ApmeStore, runId: String) -> (signals: TaskSignals, category: TaskCategory) {
        let signals = computeSignals(store: store, runId: runId)
        let category = classify(signals)
        return (signals, category)
    }

    // MARK: - LLM-assisted classification (Phase 2)
    //
    // Mirrors bridge/src/apme/classifier.ts `classifyWithLlm` + `classifyRunSmart`.
    // Rule-based runs first (cheap + deterministic). If rules give .unknown
    // AND the run has a prompt, we fall back to the configured judge backend
    // for a single-shot category classification.
    //
    // Cost posture per feedback_cost_sensitive_defaults memory: the default
    // backend is Foundation Models, so fallback is on-device and free. MLX
    // or API backends only fire when the user explicitly picks them.

    private static let llmClassifyPrompt = """
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

    /// Classify a run using the LLM judge backend. Returns rule-based
    /// fallback when the prompt is too short or the judge is unavailable.
    /// Cost: $0 on the default (Foundation Models) backend.
    static func classifyWithLlm(taskPrompt: String, signals: TaskSignals) async -> TaskCategory {
        let trimmed = taskPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count < 5 { return classify(signals) }

        let toolSummary = signals.toolCounts
            .sorted { $0.value > $1.value }
            .prefix(5)
            .map { "\($0.key)×\($0.value)" }
            .joined(separator: ", ")

        let promptSlice = String(taskPrompt.prefix(500))
        let userMsg = """
            Prompt: "\(promptSlice)"
            Tools used: \(toolSummary.isEmpty ? "none" : toolSummary) (\(signals.totalToolCalls) total)
            Files modified: \(signals.filesModified), created: \(signals.filesCreated)
            Duration: \(signals.sessionDurationSec)s, turns: \(signals.turnCount)
            """

        // Use whatever judge backend the user configured. The judge module's
        // interface is "pass a full prompt, get a text response" — we wrap
        // the system prompt + user message into one text blob to stay compatible
        // with all backends without a chat-completions abstraction.
        let fullPrompt = llmClassifyPrompt + "\n\n" + userMsg
        guard let response = await callConfiguredJudge(prompt: fullPrompt) else {
            return classify(signals)
        }

        // Accept either the bare category name or any response containing it.
        // Normalize: lowercase, strip non-alpha-underscore.
        let normalized = response
            .lowercased()
            .components(separatedBy: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz_").inverted)
            .joined()

        let allCategories = TaskCategory.allCases.map { $0.rawValue }
        if let exact = allCategories.first(where: { $0 == normalized }),
           let cat = TaskCategory(rawValue: exact) {
            return cat
        }
        // Partial match — models often wrap the answer in prose even
        // when told not to.
        if let partial = allCategories.first(where: { normalized.contains($0) }),
           let cat = TaskCategory(rawValue: partial) {
            return cat
        }
        return classify(signals)
    }

    /// Invoke the configured judge backend for a one-shot classification.
    /// Routes through ApmeJudgeFoundationModels by default; other backends
    /// (MLX, API) are reached via the same dispatch path ApmeRunner uses
    /// for eval scoring, keeping the classifier/eval backend choice in sync.
    /// `config` is a parameter rather than a `load()` inside the body so this
    /// dispatch — including the penalty exclusion below — can be driven in a
    /// test without depending on the machine's real settings.json. Flipping
    /// that exclusion back on was invisible to the suite until this seam
    /// existed.
    static func callConfiguredJudge(prompt: String, config: ApmeConfig = ApmeSettings.load()) async -> String? {
        switch config.judge.backend {
        case .foundationModels:
            return await ApmeJudgeFoundationModels.judge(prompt: prompt)
        case .mlx:
            // No repetition penalty: the measurement behind it is about judge
            // prompts, and Node's classifier never carried the field.
            if let text = await ApmeJudgeMlx.judge(prompt: prompt, config: config.judge,
                                                   sendsRepetitionPenalty: false) {
                return text
            }
            // Default chain (mlx → on-device FM). Cleared by the loader when
            // the user named the backend, so an explicit MLX still fails
            // visibly into the rule-based classifier.
            guard config.judge.fallbackToFoundationModels else { return nil }
            return await ApmeJudgeFoundationModels.judge(prompt: prompt)
        case .openai:
            return await ApmeJudgeOpenAI.judge(prompt: prompt, config: config.judge)
        case .api:
            return await ApmeJudgeApi.judge(prompt: prompt, config: config.judge)
        case .openclaw:
            // Not wired in Phase 2 — degrade to Foundation Models.
            return await ApmeJudgeFoundationModels.judge(prompt: prompt)
        }
    }

    /// Smart classification: rule-based first, LLM fallback on .unknown.
    /// Returns the source so callers can persist `task_category_source`
    /// ('rule' vs 'llm') for downstream analytics.
    static func classifyRunSmart(
        store: ApmeStore,
        runId: String
    ) async -> (signals: TaskSignals, category: TaskCategory, source: String) {
        let signals = computeSignals(store: store, runId: runId)
        let ruleCategory = classify(signals)
        if ruleCategory != .unknown {
            return (signals, ruleCategory, "rule")
        }
        // Rule-based gave up — try LLM if we have a prompt to feed it.
        guard let run = store.getRun(id: runId),
              let prompt = run.taskPrompt,
              !prompt.isEmpty
        else {
            return (signals, .unknown, "rule")
        }
        let llmCategory = await classifyWithLlm(taskPrompt: prompt, signals: signals)
        return (signals, llmCategory, llmCategory != .unknown ? "llm" : "rule")
    }
}
#endif
