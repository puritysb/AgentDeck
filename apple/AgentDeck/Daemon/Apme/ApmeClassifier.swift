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

    // MARK: - LLM-assisted classification (#299)
    //
    // Mirrors bridge/src/apme/classifier.ts `classifyWithLlm`. Rule-based
    // runs first (cheap + deterministic). If rules give .unknown AND the run
    // has a prompt, we walk `ApmeClassifierRules.backendOrder` — the
    // generated mirror of shared/src/apme-classifier-rules.ts — for a
    // single-shot category classification.
    //
    // This used to route through `callConfiguredJudge`, i.e. WHATEVER judge
    // backend the user configured for eval scoring — including the paid
    // `api`/`openai` legs, with the judge's own 800-token/60s budget. A user
    // who set `judge.backend: "api"` was billed per classification, for a
    // call that decides nothing more than which of ten labels a task gets,
    // on Swift only (Node's classifier always called MLX-or-rules). The
    // backend order below is local-only and shared byte-for-byte with Node.

    /// Classify a run using the LLM-assist backend order. Returns the
    /// rule-based fallback when the prompt is too short or every backend in
    /// `ApmeClassifierRules.backendOrder` is unavailable, unreachable, or
    /// answers outside the label vocabulary.
    ///
    /// `config` is a parameter (not a bare `ApmeSettings.load()` inside the
    /// body) for the same reason `classifyWithBackend`'s is: a test must be
    /// able to pin the MLX model/endpoint without depending on this
    /// machine's real settings.json or its real local MLX server — without
    /// this seam, a test exercising the MLX leg with no explicit model
    /// silently round-trips a real `/v1/models` probe against whatever
    /// happens to be listening on the default endpoint.
    static func classifyWithLlm(
        taskPrompt: String, signals: TaskSignals, config: ApmeConfig = ApmeSettings.load()
    ) async -> TaskCategory {
        let trimmed = taskPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count < 5 { return classify(signals) }

        let toolSummary = signals.toolCounts
            .sorted { $0.value > $1.value }
            .prefix(5)
            .map { "\($0.key)×\($0.value)" }
            .joined(separator: ", ")

        let userMsg = ApmeClassifierRules.buildUserMessage(
            taskPrompt: String(taskPrompt.prefix(500)),
            toolSummary: toolSummary,
            totalToolCalls: signals.totalToolCalls,
            filesModified: signals.filesModified,
            filesCreated: signals.filesCreated,
            sessionDurationSec: signals.sessionDurationSec,
            turnCount: signals.turnCount
        )

        for backend in ApmeClassifierRules.backendOrder {
            if backend == "rules" { break }
            if let raw = await classifyWithBackend(backend, prompt: userMsg, config: config),
               let label = ApmeClassifierRules.normalizeLabel(raw),
               let category = TaskCategory(rawValue: label) {
                return category
            }
        }
        return classify(signals)
    }

    /// Dispatch ONE entry of `ApmeClassifierRules.backendOrder`. Deliberately
    /// a closed switch over that SSOT's own vocabulary — `"api"`/`"openai"`
    /// are not members of `backendOrder` and therefore cannot be reached
    /// from here, unlike the `callConfiguredJudge` dispatch this replaces,
    /// which read whatever judge backend the user configured.
    ///
    /// `config` is a parameter (not a `load()` inside the body) so the
    /// dispatch can be driven in a test without depending on the machine's
    /// real settings.json.
    static func classifyWithBackend(_ backend: String, prompt: String, config: ApmeConfig) async -> String? {
        switch backend {
        case "foundationModels":
            if let injected = currentFoundationModelsTransport() { return await injected(prompt) }
            return await ApmeJudgeFoundationModels.judge(prompt: prompt)
        case "mlx":
            return await ApmeJudgeMlx.classifyTaskCategory(prompt: prompt, config: config.judge)
        default:
            return nil
        }
    }

    /// Injectable ONLY so the Foundation Models leg of the classifier
    /// dispatch can be driven in tests, without depending on real on-device
    /// Apple Intelligence availability (which CI cannot guarantee). Mirrors
    /// `ApmeJudgeMlx.withTransportForTests`'s closure-restore pattern.
    typealias FoundationModelsClassifyTransport = @Sendable (String) async -> String?
    nonisolated(unsafe) private static var injectedFoundationModelsTransport: FoundationModelsClassifyTransport?
    private static let fmTransportLock = NSLock()

    static func withFoundationModelsTransportForTests<T>(
        _ transport: @escaping FoundationModelsClassifyTransport,
        _ body: () async throws -> T
    ) async rethrows -> T {
        setFoundationModelsTransport(transport)
        defer { setFoundationModelsTransport(nil) }
        return try await body()
    }

    private static func setFoundationModelsTransport(_ t: FoundationModelsClassifyTransport?) {
        fmTransportLock.lock(); defer { fmTransportLock.unlock() }
        injectedFoundationModelsTransport = t
    }

    private static func currentFoundationModelsTransport() -> FoundationModelsClassifyTransport? {
        fmTransportLock.lock(); defer { fmTransportLock.unlock() }
        return injectedFoundationModelsTransport
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
