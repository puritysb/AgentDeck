#if os(macOS)
// ApmeRunner.swift — Swift port of bridge/src/apme/runner.ts.
//
// Phase 0 scope (App Store MVP):
//   - Layer 2 (LLM judge) only. Layer 1 (deterministic pnpm/xcodebuild/git)
//     is graceful-disabled under App Sandbox because it requires subprocess
//     spawn (`Process`/`posix_spawn`) which the sandbox denies.
//     `isLayer1Available` below is the single source of truth for that gate.
//     When Layer 1 is skipped, the HTTP/WS response payload carries
//     `layer1SkippedReason` so the dashboard + Swift Settings UI can surface
//     "LLM-only evaluation" instead of silently omitting scores.
//   - A future phase will port the Layer 1 signals (files touched, tests
//     passed/failed, lines changed) into pure Swift using LibGit2 + the
//     Xcode results bundle reader. Until then Layer 1 runs nowhere.
//   - Turn-level eval via `enqueueTurn(runId:turnId:category:)` — this is the
//     path the category-aware rubric pipeline flows through. When the user
//     asks a conversation/research/planning/review question and the Swift
//     daemon captures the response, this method fires the judge and writes
//     `turn_judge` rows scored on the category's specific axes (accuracy,
//     helpfulness, thoroughness, etc.).
//   - Run-level eval via `enqueue(runId:)` is a pass-through: picks the
//     category rubric, calls the judge, writes `llm_judge` rows on the run.
//
// Parity notes with TS runner.ts (commit e76325f7):
//   - `parseJudgeJson` accepts ANY numeric field except a reserved set
//     {reasoning, done, missed, notes}. This is critical — the hardcoded
//     whitelist bug in the TS version dropped conversation rubric axes
//     (accuracy/helpfulness/conciseness) entirely until the fix.
//   - clamp01 rescales 0..10 input to 0..1 by dividing by 10.
//   - Category rubric lookup via `store.getCurrentRubric(purpose:)` with
//     fallback to `general`.

import Foundation

// MARK: - Public types

struct ApmeEvalJobResult {
    let runId: String
    /// Set when this result came from a turn-level eval.
    let turnId: String?
    /// Set when this result came from a task-level (rollup) eval.
    var taskId: String? = nil
    let layer1Ran: Bool
    let layer2Ran: Bool
    let overall: Double?
    /// Machine-readable reason Layer 1 was skipped for this result, or `nil`
    /// when Layer 1 either ran or wasn't expected to.
    ///
    /// Current known values:
    ///   - "sandbox" — subprocess spawn blocked by App Sandbox (App Store build).
    ///   - "not_implemented" — Swift Layer 1 port not yet written.
    ///
    /// Shipped in the `apme_eval` WS event + HTTP payloads so the dashboard
    /// can render an "LLM-only" badge when present.
    var layer1SkippedReason: String? = nil
}

/// Fired after `runTaskEval` writes the per-axis `task_judge` rows + summary
/// + compositeScore + outcome onto the `tasks` row. Carries enough context
/// for `DaemonServer` to re-emit the corresponding `task_end` timeline row
/// with the score badge metadata. Mirrors `TaskEvaluatedEvent` in
/// `bridge/src/apme/runner.ts`.
struct ApmeTaskEvaluatedEvent: Sendable {
    let runId: String
    let taskId: String
    let sessionId: String
    let agentType: String?
    let projectName: String?
    let startedAt: Int
    let endedAt: Int
    let compositeScore: Double?
    /// `"success" | "partial" | "fail" | "pending"` — coarse outcome class
    /// derived from `compositeScore` (mirrors TS `deriveTaskOutcome`).
    let outcome: String
    let taskCategory: String?
    let summary: String?
    let boundarySignal: String
    /// Turn count the task spanned. The timeline emitter mirrors it into the
    /// upserted task_end row text (parity with TS `TaskEvaluatedEvent.turns`).
    let turns: Int?
}

/// Parsed judge output.
struct ApmeParsedJudge {
    /// All numeric axes from the JSON response. Must include `overall` or
    /// the parse returns nil.
    let scores: [String: Double]
    let reasoning: String
    let done: [String]?
    let missed: [String]?
    /// One-line task summary emitted by the `task_rollup` rubric. Nil for
    /// non-rollup judgements (turn/run level) which don't request it.
    var summary: String? = nil
}

// MARK: - Runner

actor ApmeRunner {
    private let store: ApmeStore
    private var config: ApmeConfig
    /// Listeners notified after each successful eval. DaemonServer registers
    /// one to broadcast `apmeEval` WebSocket events and append `eval_result`
    /// timeline entries.
    private var listeners: [@Sendable (ApmeEvalJobResult) -> Void] = []

    /// Listeners notified after a task_judge writes its rollup. DaemonServer
    /// registers one to upsert the original `task_end` timeline row with the
    /// score + outcome metadata so dashboard task headers render the badge.
    private var taskEvaluatedListeners: [@Sendable (ApmeTaskEvaluatedEvent) -> Void] = []
    private var runningRunIds: Set<String> = []
    private var runningTurnIds: Set<String> = []
    private var runningTaskIds: Set<String> = []

    /// Coarse outcome class derived from `compositeScore`. Parity with
    /// `bridge/src/apme/runner.ts::deriveTaskOutcome`.
    static func deriveTaskOutcome(_ score: Double?) -> String {
        guard let s = score else { return "pending" }
        if s >= 0.75 { return "success" }
        if s >= 0.5 { return "partial" }
        return "fail"
    }

    // MARK: - Layer 1 availability gate

    /// Single source of truth: can Layer 1 (deterministic pnpm/xcodebuild/git)
    /// run in the current process?
    ///
    /// Currently returns `false` everywhere because (a) inside App Sandbox
    /// subprocess spawn is denied, and (b) the Swift port of the TS Layer 1
    /// signal extractors in `bridge/src/apme/runner.ts` hasn't been written
    /// yet. Phase 2+ will flip this to a runtime-computed value once the
    /// LibGit2 + results-bundle port lands.
    ///
    /// Gating on this lets callers produce a stable `layer1SkippedReason` so
    /// the dashboard + Settings UI can render "LLM-only evaluation" instead
    /// of looking broken when Layer 1 rows never appear.
    static var isLayer1Available: Bool {
        // TODO(phase2): replace with `!AgentDeckRuntime.isSandboxed && swiftLayer1Implemented`
        //               once the Swift Layer 1 port lands.
        return false
    }

    /// Machine-readable reason Layer 1 was skipped for this process.
    /// Returns `nil` when Layer 1 is available. Used to tag eval results
    /// shipped over WS/HTTP so the UI can surface the gap.
    static var layer1SkippedReason: String? {
        if isLayer1Available { return nil }
        if AgentDeckRuntime.isSandboxed { return "sandbox" }
        // Outside sandbox we're still skipping Layer 1 until the Swift port
        // lands. Label it distinct from "sandbox" so future dashboards can
        // tell a user-facing "App Store build" story apart from an internal
        // "not yet implemented" one.
        return "not_implemented"
    }

    init(store: ApmeStore, config: ApmeConfig = ApmeSettings.load()) {
        self.store = store
        self.config = config
    }

    /// Update config (e.g. after settings UI change in Phase 2).
    func setConfig(_ cfg: ApmeConfig) { self.config = cfg }

    /// Register a result listener. The closure must be `@Sendable` because
    /// listeners are invoked from within the actor and dispatched across
    /// arbitrary tasks.
    func onTaskEvaluated(_ handler: @Sendable @escaping (ApmeTaskEvaluatedEvent) -> Void) {
        taskEvaluatedListeners.append(handler)
    }

    func onResult(_ handler: @Sendable @escaping (ApmeEvalJobResult) -> Void) {
        listeners.append(handler)
    }

    // MARK: - Turn-level eval

    /// Fire a category-aware judge on a single completed turn.
    /// Fire-and-forget — runs on a detached Task so callers (the collector's
    /// mid-session response handler) don't block.
    nonisolated func enqueueTurn(runId: String, turnId: String, category: String) {
        Task.detached { [weak self] in
            await self?.runTurnEvalIfNeeded(runId: runId, turnId: turnId, category: category)
        }
    }

    private func runTurnEvalIfNeeded(runId: String, turnId: String, category: String) async {
        if runningTurnIds.contains(turnId) {
            DaemonLogger.shared.debug("APME", "skip duplicate turn eval turn=\(turnId.prefix(8))")
            return
        }
        runningTurnIds.insert(turnId)
        defer { runningTurnIds.remove(turnId) }
        await runTurnEval(runId: runId, turnId: turnId, category: category)
    }

    private func runTurnEval(runId: String, turnId: String, category: String) async {
        guard config.enabled else { return }

        guard let turn = store.getTurn(id: turnId) else { return }
        let prompt = (turn["prompt"] as? String) ?? ""
        let response = (turn["response"] as? String) ?? ""
        if prompt.isEmpty && response.isEmpty { return }
        // Skip turns the agent answered with tool calls only (or nothing) —
        // the rubric prompt can't score "silence" meaningfully. The collector
        // tags turns.efficiency_json.response_kind on setTurnResponse so we
        // can distinguish these from genuine short answers like "4".
        let kind = Self.readResponseKind(turn: turn)
        if kind == "tool_only" || kind == "empty" {
            DaemonLogger.shared.debug("APME", "runTurnEval skip turn=\(turnId.prefix(8)) kind=\(kind)")
            return
        }

        // Select category rubric, fall back to conversation (the closest
        // non-code rubric) if the specific category rubric is missing.
        let rubric = store.getCurrentRubric(purpose: category)
            ?? store.getCurrentRubric(purpose: "conversation")
        guard let rubric = rubric,
              let rubricPrompt = rubric["prompt"] as? String
        else { return }

        let judgePrompt = Self.buildTurnJudgePrompt(
            rubricPrompt: rubricPrompt,
            category: category,
            userPrompt: prompt,
            agentResponse: response
        )

        guard let judgeOutput = await callJudge(prompt: judgePrompt) else {
            DaemonLogger.shared.debug("APME", "turn judge returned nil for turn=\(turnId.prefix(8)) category=\(category)")
            return
        }
        guard let parsed = Self.parseJudgeJson(judgeOutput.text) else {
            DaemonLogger.shared.debug("APME", "turn judge unparseable for turn=\(turnId.prefix(8))")
            return
        }

        let now = Int(Date().timeIntervalSince1970 * 1000)
        let rubricVer = rubric["version"] as? Int
        let judgeModel = judgeOutput.label

        for (axis, score) in parsed.scores {
            var raw: String? = nil
            if axis == "overall" {
                let meta: [String: Any] = [
                    "reasoning": parsed.reasoning,
                    "done": parsed.done ?? [],
                    "missed": parsed.missed ?? [],
                ]
                if let data = try? JSONSerialization.data(withJSONObject: meta),
                   let s = String(data: data, encoding: .utf8) {
                    raw = s
                }
            }
            let eval = ApmeEval(
                id: 0,
                runId: runId,
                layer: "turn_judge",
                metric: axis,
                score: score,
                raw: raw,
                rubricVer: rubricVer,
                judgeModel: judgeModel,
                createdAt: now
            )
            store.insertEvalForTurn(eval, turnId: turnId)
        }

        let overall = parsed.scores["overall"]
        DaemonLogger.shared.debug("APME", "turn eval \(turnId.prefix(8)): overall=\(overall ?? -1)")
        let result = ApmeEvalJobResult(
            runId: runId,
            turnId: turnId,
            layer1Ran: false,
            layer2Ran: true,
            overall: overall,
            // Turn-level evals never ran Layer 1 in any build, but label the
            // reason anyway so downstream consumers don't have to branch on
            // "turn vs run" to decide if Layer 1 was applicable.
            layer1SkippedReason: Self.layer1SkippedReason
        )
        for listener in listeners { listener(result) }
    }

    // MARK: - Task-level eval (rollup across multiple turns)

    /// Judge a closed task (group of turns between boundary signals —
    /// TodoWrite all-completed / /clear / session_end). Fires-and-forgets on
    /// a detached Task. Writes a one-line summary + axis scores into the
    /// `tasks` row and per-axis `evals` rows with `layer='task_judge'`.
    /// Mirrors bridge/src/apme/runner.ts enqueueTask.
    nonisolated func enqueueTask(runId: String, taskId: String, category: String? = nil, boundarySignal: String? = nil) {
        Task.detached { [weak self] in
            await self?.runTaskEvalIfNeeded(runId: runId, taskId: taskId, category: category, boundarySignal: boundarySignal)
        }
    }

    private func runTaskEvalIfNeeded(runId: String, taskId: String, category: String?, boundarySignal: String?) async {
        if runningTaskIds.contains(taskId) {
            DaemonLogger.shared.debug("APME", "skip duplicate task eval task=\(taskId.prefix(8))")
            return
        }
        runningTaskIds.insert(taskId)
        defer { runningTaskIds.remove(taskId) }
        await runTaskEval(runId: runId, taskId: taskId, category: category, boundarySignal: boundarySignal)
    }

    private func runTaskEval(runId: String, taskId: String, category: String?, boundarySignal: String?) async {
        guard config.enabled else { return }
        guard let task = store.getTask(id: taskId) else { return }
        let turns = store.listTurnsForTask(taskId)
        if turns.isEmpty { return }

        // A verdict about the agent's work needs the agent's work. This is the
        // generated Swift mirror of bridge/src/apme/task-gradeability.ts: it
        // rejects silence, abort notices, and trivial greetings while keeping
        // replyless headless/workflow tasks with a real tool/file trajectory.
        if let reason = TaskGradeabilityRules.notGradeableReason(turns) {
            store.updateTask(id: taskId, fields: [
                "notesJson": TaskGradeabilityRules.notGradeableNotes(reason) as Any?
            ])
            DaemonLogger.shared.debug(
                "APME", "runTaskEval declined task=\(taskId.prefix(8)) — \(reason)")
            return
        }

        // Select rubric: task_rollup preferred, fall back to category, then general.
        let rubric = store.getCurrentRubric(purpose: "task_rollup")
            ?? (category.flatMap { store.getCurrentRubric(purpose: $0) })
            ?? store.getCurrentRubric(purpose: "general")
        guard let rubric = rubric,
              let rubricPrompt = rubric["prompt"] as? String
        else { return }

        let judgePrompt = Self.buildTaskJudgePrompt(
            rubricPrompt: rubricPrompt,
            category: category ?? task.taskCategory ?? "unknown",
            boundarySignal: boundarySignal ?? task.boundarySignal,
            turns: turns,
            sample: store.getSampleDict(taskId)
        )

        guard let judgeOutput = await callJudge(prompt: judgePrompt) else {
            DaemonLogger.shared.debug("APME", "task judge returned nil task=\(taskId.prefix(8))")
            return
        }
        guard let parsed = Self.parseJudgeJson(judgeOutput.text) else {
            DaemonLogger.shared.debug("APME", "task judge unparseable task=\(taskId.prefix(8))")
            return
        }

        let now = Int(Date().timeIntervalSince1970 * 1000)
        let rubricVer = rubric["version"] as? Int
        let judgeModel = judgeOutput.label

        for (axis, score) in parsed.scores {
            var raw: String? = nil
            if axis == "overall" {
                let meta: [String: Any] = [
                    "summary": parsed.summary ?? NSNull(),
                    "reasoning": parsed.reasoning,
                    "done": parsed.done ?? [],
                    "missed": parsed.missed ?? [],
                ]
                if let data = try? JSONSerialization.data(withJSONObject: meta),
                   let s = String(data: data, encoding: .utf8) {
                    raw = s
                }
            }
            let eval = ApmeEval(
                id: 0,
                runId: runId,
                layer: "task_judge",
                metric: axis,
                score: score,
                raw: raw,
                rubricVer: rubricVer,
                judgeModel: judgeModel,
                createdAt: now
            )
            store.insertEvalForTask(eval, taskId: taskId)
        }

        // Pure sample-trajectory scorers (tool churn, error rate). Stored under
        // layer="trajectory" so they don't collide with task_judge axes.
        // Mirrors bridge/src/apme/runner.ts runSampleScorers.
        if let sample = store.getSampleDict(taskId),
           let events = sample["events"] as? [[String: Any]] {
            for r in ApmeScorers.run(events: events) {
                store.insertEvalForTask(
                    ApmeEval(id: 0, runId: runId, layer: "trajectory", metric: r.metric,
                             score: r.score, raw: r.reasoning, rubricVer: nil,
                             judgeModel: "scorer:\(r.scorer)", createdAt: now),
                    taskId: taskId)
            }
        }

        // Persist the summary + composite score + outcome on the task row so
        // listTasksForRun returns them without a join. Preserve any
        // previously-set outcome — that only happens when the user closed
        // the task manually with an outcome override (CLI `agentdeck task
        // cancel`, App-target detail-pane button, or future
        // /task/close caller). `closeTask` itself never writes outcome —
        // only the manual path does — so a non-nil read here unambiguously
        // means "user gesture, do not overwrite". Mirrors the same guard
        // in bridge/src/apme/runner.ts::runTaskEval.
        let overall = parsed.scores["overall"]
        let derivedOutcome = Self.deriveTaskOutcome(overall)
        let existingOutcome = store.getTask(id: taskId)?.outcome
        let taskOutcome = (existingOutcome?.isEmpty == false) ? existingOutcome! : derivedOutcome
        var taskFields: [String: Any?] = [:]
        taskFields["summary"] = parsed.summary as Any?
        taskFields["compositeScore"] = overall as Any?
        taskFields["outcome"] = taskOutcome as Any?
        let notes: [String: Any] = [
            "reasoning": parsed.reasoning,
            "done": parsed.done ?? [],
            "missed": parsed.missed ?? [],
        ]
        if let data = try? JSONSerialization.data(withJSONObject: notes),
           let s = String(data: data, encoding: .utf8) {
            taskFields["notesJson"] = s
        }
        store.updateTask(id: taskId, fields: taskFields)

        DaemonLogger.shared.debug("APME", "task eval \(taskId.prefix(8)): overall=\(overall ?? -1) outcome=\(taskOutcome) summary=\(parsed.summary?.prefix(40) ?? "-")")

        var result = ApmeEvalJobResult(
            runId: runId,
            turnId: nil,
            layer1Ran: false,
            layer2Ran: true,
            overall: overall,
            layer1SkippedReason: Self.layer1SkippedReason
        )
        result.taskId = taskId
        for listener in listeners { listener(result) }

        if !taskEvaluatedListeners.isEmpty {
            let run = store.getRun(id: runId)
            let refreshedTask = store.getTask(id: taskId) ?? task
            let event = ApmeTaskEvaluatedEvent(
                runId: runId,
                taskId: taskId,
                sessionId: run?.sessionId ?? "",
                agentType: run?.agentType,
                projectName: run?.projectName,
                startedAt: refreshedTask.startedAt,
                endedAt: refreshedTask.endedAt ?? Int(Date().timeIntervalSince1970 * 1000),
                compositeScore: overall,
                outcome: taskOutcome,
                taskCategory: category ?? refreshedTask.taskCategory,
                summary: parsed.summary,
                boundarySignal: boundarySignal ?? refreshedTask.boundarySignal,
                turns: turns.count
            )
            for listener in taskEvaluatedListeners { listener(event) }
        }
    }

    // MARK: - Run-level eval (layer 2 only in Phase 1)

    /// Enqueue a run-level eval. Phase 1 calls the judge against the run's
    /// category rubric using its accumulated turns as context (no git diff,
    /// no deterministic results).
    nonisolated func enqueue(runId: String) {
        Task.detached { [weak self] in
            await self?.runOneIfNeeded(runId: runId)
        }
    }

    private func runOneIfNeeded(runId: String) async {
        if runningRunIds.contains(runId) {
            DaemonLogger.shared.debug("APME", "skip duplicate run eval run=\(runId.prefix(8))")
            return
        }
        runningRunIds.insert(runId)
        defer { runningRunIds.remove(runId) }
        await runOne(runId: runId)
    }

    private func runOne(runId: String) async {
        guard config.enabled else { return }
        guard let run = store.getRun(id: runId) else { return }
        if !store.listEvalsForRun(runId).isEmpty {
            DaemonLogger.shared.debug("APME", "run eval skip run=\(runId.prefix(8)) — eval rows already exist")
            return
        }

        // Phase 0: Layer 1 graceful-disabled (see `isLayer1Available` above —
        // subprocess spawn blocked by App Sandbox). Gate Layer 2 on the
        // sampling config but bypass `onlyWhenDisagreement` since there's no
        // deterministic signal to disagree with. The result payload carries
        // `layer1SkippedReason` so the dashboard can render an "LLM-only
        // evaluation" badge instead of looking broken.
        if !ApmeSettings.shouldJudge(config.judge, deterministicPassed: nil) {
            return
        }

        let category = run.taskCategory ?? "general"
        let rubric = store.getCurrentRubric(purpose: category)
            ?? store.getCurrentRubric(purpose: "general")
        guard let rubric = rubric,
              let rubricPrompt = rubric["prompt"] as? String
        else { return }

        let judgePrompt = Self.buildRunJudgePrompt(
            rubricPrompt: rubricPrompt,
            run: run,
            store: store
        )

        guard let judgeOutput = await callJudge(prompt: judgePrompt) else { return }
        guard let parsed = Self.parseJudgeJson(judgeOutput.text) else { return }

        let now = Int(Date().timeIntervalSince1970 * 1000)
        let rubricVer = rubric["version"] as? Int
        let judgeModel = judgeOutput.label
        for (axis, score) in parsed.scores {
            var raw: String? = nil
            if axis == "overall" {
                let meta: [String: Any] = [
                    "reasoning": parsed.reasoning,
                    "done": parsed.done ?? [],
                    "missed": parsed.missed ?? [],
                ]
                if let data = try? JSONSerialization.data(withJSONObject: meta),
                   let s = String(data: data, encoding: .utf8) {
                    raw = s
                }
            }
            let eval = ApmeEval(
                id: 0,
                runId: runId,
                layer: "llm_judge",
                metric: axis,
                score: score,
                raw: raw,
                rubricVer: rubricVer,
                judgeModel: judgeModel,
                createdAt: now
            )
            store.insertEval(eval)
        }

        let overall = parsed.scores["overall"]
        let result = ApmeEvalJobResult(
            runId: runId,
            turnId: nil,
            layer1Ran: false,
            layer2Ran: true,
            overall: overall,
            layer1SkippedReason: Self.layer1SkippedReason
        )
        for listener in listeners { listener(result) }
    }

    // MARK: - Judge dispatch

    /// Route to the configured backend. Phase 2 wires MLX + API adapters
    /// alongside Foundation Models. Per feedback_cost_sensitive_defaults
    /// memory, never silently fall back from a paid/local backend to the
    /// free on-device one — if the user picked MLX and it's offline, the
    /// eval is skipped so the user notices, rather than paying a mental
    /// cost wondering why "their" model didn't run.
    ///
    /// `openclaw` remains a round-trip compatibility stub (settings.json
    /// can round-trip it but the adapter isn't wired yet). It degrades to
    /// Foundation Models until Phase 3.
    /// Judge output plus the label of the backend that ACTUALLY produced it.
    /// The default chain can answer from either leg, and a row attributed to
    /// the leg that did not run is worse than no attribution — the whole
    /// point of measuring per-backend judge quality is lost. Mirrors the Node
    /// runner's `JudgeResult`.
    struct JudgeOutput {
        let text: String
        let label: String
    }

    private func callJudge(prompt: String) async -> JudgeOutput? {
        switch config.judge.backend {
        case .foundationModels:
            return await ApmeJudgeFoundationModels.judge(prompt: prompt)
                .map { JudgeOutput(text: $0, label: ApmeJudgeFoundationModels.judgeModelLabel) }
        case .mlx:
            if let text = await ApmeJudgeMlx.judge(prompt: prompt, config: config.judge) {
                return JudgeOutput(text: text, label: ApmeJudgeMlx.judgeModelLabel)
            }
            // Default chain only: an explicitly named `mlx` keeps the
            // cost-sensitive-defaults rule that an offline backend produces a
            // visible skip rather than a silent downgrade. The loader clears
            // this flag whenever the user named the backend.
            guard config.judge.fallbackToFoundationModels else { return nil }
            DaemonLogger.shared.debug("APME", "mlx unavailable, falling back to foundationModels")
            return await ApmeJudgeFoundationModels.judge(prompt: prompt)
                .map { JudgeOutput(text: $0, label: ApmeJudgeFoundationModels.judgeModelLabel) }
        case .openai:
            return await ApmeJudgeOpenAI.judge(prompt: prompt, config: config.judge)
                .map { JudgeOutput(text: $0, label: ApmeJudgeOpenAI.judgeModelLabel) }
        case .api:
            return await ApmeJudgeApi.judge(prompt: prompt, config: config.judge)
                .map { JudgeOutput(text: $0, label: ApmeJudgeApi.judgeModelLabel) }
        case .openclaw:
            DaemonLogger.shared.debug("APME", "openclaw backend not wired, degrading to foundationModels")
            return await ApmeJudgeFoundationModels.judge(prompt: prompt)
                .map { JudgeOutput(text: $0, label: ApmeJudgeFoundationModels.judgeModelLabel) }
        }
    }

    // MARK: - Response-kind helper (parity with TS runner.ts readResponseKind)

    /// Inspect `turns.efficiency_json.response_kind` written by the collector on
    /// `setTurnResponse`. Falls back to heuristic classification when the tag is
    /// missing (older rows or third-party callers).
    ///
    /// Returned values: "text" | "tool_only" | "empty" — the runner skips judge
    /// for anything other than "text".
    static func readResponseKind(turn: [String: Any]) -> String {
        if let raw = turn["efficiency_json"] as? String,
           !raw.isEmpty,
           let data = raw.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let k = obj["response_kind"] as? String,
           ["text", "tool_only", "empty"].contains(k) {
            return k
        }
        let response = ((turn["response"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let toolCalls = (turn["tool_calls"] as? Int) ?? 0
        if !response.isEmpty { return "text" }
        return toolCalls > 0 ? "tool_only" : "empty"
    }

    // MARK: - Prompt builders

    /// Build the judge prompt for a task-unit rollup. Includes up to 10 turns
    /// (user prompt + agent response each) and the boundary signal so the
    /// rubric can weigh completion signals. Mirrors bridge/src/apme/runner.ts
    /// runTaskEval prompt composition.
    static func buildTaskJudgePrompt(
        rubricPrompt: String,
        category: String,
        boundarySignal: String,
        turns: [[String: Any]],
        sample: [String: Any]? = nil
    ) -> String {
        let cap = 10
        let clipped = Array(turns.prefix(cap))
        var lines: [String] = []
        for t in clipped {
            let idx = t["turn_index"] as? Int ?? 0
            let prompt = String(((t["prompt"] as? String) ?? "").prefix(1500))
            let response = String(((t["response"] as? String) ?? "").prefix(2500))
            lines.append("[Turn \(idx)] User: \(prompt.isEmpty ? "(empty)" : prompt)")
            if !response.isEmpty { lines.append("Agent: \(response)") }
        }
        if turns.count > cap {
            lines.append("… (\(turns.count - cap) more turns omitted)")
        }

        let trajectoryLines = sample.map { buildTrajectoryLines(sample: $0) } ?? []
        var costLine: String? = nil
        if let cost = sample?["cost"] as? [String: Any],
           let model = sample?["model"] as? [String: Any] {
            let input = cost["inputTokens"] as? Int ?? 0
            let output = cost["outputTokens"] as? Int ?? 0
            let usd = cost["costUsd"] as? Double ?? 0
            let modelId = model["modelId"] as? String ?? "unknown"
            costLine = String(format: "cost: %din/%dout tok, $%.4f, model %@", input, output, usd, modelId)
        }

        var sections: [String] = [
            rubricPrompt,
            "",
            "--- TASK CONTEXT ---",
            "task_category: \(category)",
            "turn_count: \(turns.count)",
            "boundary_signal: \(boundarySignal)",
        ]
        if let costLine { sections.append(costLine) }
        sections.append("")
        sections.append("--- TURNS ---")
        sections.append(contentsOf: lines)
        if !trajectoryLines.isEmpty {
            sections.append("")
            sections.append("--- TASK TRAJECTORY ---")
            sections.append(contentsOf: trajectoryLines)
        }
        sections.append("")
        sections.append("Respond with strict JSON only.")
        return sections.joined(separator: "\n")
    }

    /// Compact typed SessionSample evidence for the task judge. In particular,
    /// child-agent lifecycle rows make delegated work visible even though child
    /// hooks never enter the parent's ordinary state machine.
    static func buildTrajectoryLines(sample: [String: Any], cap: Int = 30) -> [String] {
        guard let allEvents = sample["events"] as? [[String: Any]] else { return [] }
        var lines: [String] = []
        for event in allEvents.prefix(cap) {
            switch event["kind"] as? String {
            case "tool":
                let name = event["name"] as? String ?? "tool"
                var input = ""
                if let value = event["input"],
                   let data = try? JSONSerialization.data(
                    withJSONObject: value, options: [.fragmentsAllowed]),
                   let string = String(data: data, encoding: .utf8) {
                    input = String(string.prefix(120))
                }
                let status = (event["status"] as? String).map { " → \($0)" } ?? ""
                let error = (event["error"] as? String).map { " [err: \(String($0.prefix(80)))]" } ?? ""
                lines.append("  tool \(name)(\(input))\(status)\(error)")
            case "model":
                let model = event["model"] as? String ?? "unknown"
                let input = event["inputTokens"] as? Int ?? 0
                let output = event["outputTokens"] as? Int ?? 0
                let usd = event["costUsd"] as? Double ?? 0
                let cost = usd == 0 ? "" : String(format: " ($%.4f)", usd)
                lines.append("  model \(model): \(input)in/\(output)out tok\(cost)")
            case "subagent":
                let name = event["name"] as? String ?? "Subagent"
                let phase = event["phase"] as? String ?? "completed"
                let duration: String
                if let ms = event["durationMs"] as? Int {
                    duration = " (\(Int((Double(ms) / 1000).rounded()))s)"
                } else {
                    duration = ""
                }
                let summary = (event["summary"] as? String)
                    .map { ": \(String($0.prefix(160)))" } ?? ""
                lines.append("  subagent \(name) → \(phase)\(duration)\(summary)")
            case "state":
                lines.append("  state → \(event["to"] as? String ?? "unknown")")
            default:
                break
            }
        }
        if allEvents.count > cap {
            lines.append("  … (\(allEvents.count - cap) more events)")
        }
        return lines
    }

    static func buildTurnJudgePrompt(
        rubricPrompt: String,
        category: String,
        userPrompt: String,
        agentResponse: String
    ) -> String {
        let clampedPrompt = String(userPrompt.prefix(2000))
        let clampedResponse = String(agentResponse.prefix(4000))
        return [
            rubricPrompt,
            "",
            "--- TURN CONTEXT ---",
            "task_category: \(category)",
            "",
            "--- USER PROMPT ---",
            clampedPrompt.isEmpty ? "(not captured)" : clampedPrompt,
            "",
            "--- AGENT RESPONSE ---",
            clampedResponse.isEmpty ? "(not captured)" : clampedResponse,
            "",
            "Respond with strict JSON only.",
        ].joined(separator: "\n")
    }

    static func buildRunJudgePrompt(
        rubricPrompt: String,
        run: ApmeRun,
        store: ApmeStore
    ) -> String {
        let task = String((run.taskPrompt ?? "").prefix(4000))
        let isNonCode = run.taskCategory.map { ["conversation", "planning", "research", "review"].contains($0) } ?? false

        var sections: [String] = [
            rubricPrompt,
            "",
            "--- RUN CONTEXT ---",
            "agent_type: \(run.agentType)",
            "model: \(run.modelId ?? "unknown")",
            "project: \(run.projectName ?? "unknown")",
            "task_category: \(run.taskCategory ?? "unknown")",
            "deterministic_checks: unknown",
            "",
            "--- TASK PROMPT ---",
            task.isEmpty ? "(not captured)" : task,
        ]

        if isNonCode {
            sections.append("")
            sections.append("--- CONVERSATION ---")
            let turns = store.listTurns(runId: run.id).prefix(10)
            for t in turns {
                let idx = t["turn_index"] as? Int ?? 0
                let prompt = ((t["prompt"] as? String) ?? "").prefix(2000)
                let response = ((t["response"] as? String) ?? "").prefix(3000)
                sections.append("[Turn \(idx)] User: \(prompt)")
                if !response.isEmpty { sections.append("Agent: \(response)") }
            }
        } else {
            // Phase 1: no diff collection (sandbox). Leave a placeholder so
            // the rubric knows there's no artifact to review.
            sections.append("")
            sections.append("--- DIFF (truncated) ---")
            sections.append("(diff not provided)")
        }

        sections.append("")
        sections.append("Respond with strict JSON only.")
        return sections.joined(separator: "\n")
    }

    // MARK: - parseJudgeJson (parity with runner.ts post-e76325f7)

    /// Reserved JSON fields that are NOT numeric axes.
    /// Must match the TS `RESERVED` set in runner.ts exactly. `summary` is
    /// the one-line rollup emitted by the `task_rollup` rubric.
    private static let reservedFields: Set<String> = ["reasoning", "done", "missed", "notes", "summary"]

    /// Parse the judge's JSON response into scores + metadata.
    ///
    /// Robustness:
    ///   - Extracts the first `{...}` block (handles code-fence wrapping and
    ///     prose prefixes that models sometimes emit even at temperature=0).
    ///   - Accepts ANY numeric field except the reserved set — this is the
    ///     critical fix that makes category rubric axes (accuracy, thoroughness,
    ///     etc.) actually land in the evals table.
    ///   - Rescales 0..10 input to 0..1 when max > 1 (models occasionally
    ///     ignore the "float in [0,1]" instruction).
    ///   - Requires an `overall` score — returns nil otherwise.
    static func parseJudgeJson(_ text: String) -> ApmeParsedJudge? {
        // Grab first {...} block via a regex that matches the outermost braces.
        guard let jsonBlock = extractFirstJsonBlock(text) else { return nil }
        guard let data = jsonBlock.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }

        var scores: [String: Double] = [:]
        for (key, value) in obj {
            if reservedFields.contains(key) { continue }
            if let num = value as? Double {
                scores[key] = Self.clamp01(num)
            } else if let num = value as? Int {
                scores[key] = Self.clamp01(Double(num))
            }
            // Non-numeric fields (strings, arrays, objects) are ignored.
        }
        guard scores["overall"] != nil else { return nil }

        let reasoning = (obj["reasoning"] as? String) ?? ""
        let done = (obj["done"] as? [Any])?.compactMap { $0 as? String }
        let missed = (obj["missed"] as? [Any])?.compactMap { $0 as? String }
        // `summary` is produced by the task_rollup rubric — clip defensively
        // so a runaway model can't blow up the tasks.summary column.
        let summaryRaw = (obj["summary"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let summary: String? = summaryRaw.isEmpty ? nil : String(summaryRaw.prefix(280))

        return ApmeParsedJudge(
            scores: scores,
            reasoning: reasoning,
            done: done,
            missed: missed,
            summary: summary
        )
    }

    /// Whether `text` carries a JSON object that closed — the same extraction
    /// `parseJudgeJson` performs, minus the rubric-level field checks. Read by
    /// `ApmeJudgeChatResponse` so a `finish_reason: "length"` body is refused
    /// only when it was actually cut mid-object; mirrors `holdsCompleteJsonObject`
    /// in bridge/src/apme/runner.ts and is pinned by
    /// shared/apme-judge-response-vectors.json.
    static func holdsCompleteJsonObject(_ text: String) -> Bool {
        // Purely STRUCTURAL: did a `{…}` close. Deliberately not "does it
        // parse" — the two daemons' JSON parsers do not agree on leniency
        // (measured: `JSONSerialization` accepts the trailing commas Gemma 4
        // emits and Node's `JSON.parse` does not), so a gate phrased that way
        // answers differently on each daemon, which is the one thing the shared
        // vectors exist to prevent. The balanced scanners ARE identical, so
        // this question is. Whether the closed object is a usable verdict is
        // `parseJudgeJson`'s job, where the leniency already lives.
        extractFirstJsonBlock(text) != nil
    }

    /// Extract the first balanced `{...}` block from arbitrary text.
    /// Handles the common case of models wrapping JSON in ```json fences
    /// or adding "Here is the JSON:" prefixes.
    private static func extractFirstJsonBlock(_ text: String) -> String? {
        guard let firstBrace = text.firstIndex(of: "{") else { return nil }
        var depth = 0
        var i = firstBrace
        var inString = false
        var escaped = false
        while i < text.endIndex {
            let c = text[i]
            if escaped {
                escaped = false
            } else if c == "\\" && inString {
                escaped = true
            } else if c == "\"" {
                inString.toggle()
            } else if !inString {
                if c == "{" { depth += 1 }
                else if c == "}" {
                    depth -= 1
                    if depth == 0 {
                        return String(text[firstBrace...i])
                    }
                }
            }
            i = text.index(after: i)
        }
        return nil
    }

    /// Clamp a score to [0,1], rescaling 0..10 inputs by /10 when max > 1.
    /// Matches TS `clamp01` in runner.ts exactly.
    static func clamp01(_ n: Double) -> Double {
        var v = n
        if v > 1 && v <= 10 { v = v / 10 }
        if v > 1 { v = 1 }
        if v < 0 { v = 0 }
        return v
    }
}
#endif
