#if os(macOS)
// ApmeHttpRoutes.swift — HTTP API routes for APME data.
// Mounted into DaemonServer's HTTPServer alongside existing routes.

import Foundation

enum ApmeHttpRoutes {
    private static let schemaVersion = "agentdeck-eval/v1"

    private static func unauthorizedResponse() -> HTTPServer.HTTPResponse {
        .json(["error": "Unauthorized — token required for APME routes"], status: 401)
    }

    private static func requireToken(_ request: HTTPServer.HTTPRequest) -> HTTPServer.HTTPResponse? {
        let token = request.queryParams["token"] ?? ""
        return AuthManager.shared.validateToken(token) ? nil : unauthorizedResponse()
    }

    private static func evalDict(_ e: ApmeEval, includeRaw: Bool = false) -> [String: Any] {
        var ed: [String: Any] = [
            "layer": e.layer,
            "metric": e.metric,
            "score": e.score,
            "createdAt": e.createdAt,
        ]
        if let v = e.rubricVer { ed["rubricVer"] = v }
        if let v = e.judgeModel { ed["judgeModel"] = v }
        if includeRaw, let v = e.raw { ed["raw"] = v }
        return ed
    }

    private static func vibeDict(_ vibe: (verdict: String, note: String?, ts: Int)?) -> [String: Any]? {
        guard let vibe else { return nil }
        var dict: [String: Any] = [
            "verdict": vibe.verdict,
            "ts": vibe.ts,
        ]
        if let note = vibe.note { dict["note"] = note }
        return dict
    }

    /// Register all /apme/* routes on the given HTTP server.
    static func register(on httpServer: HTTPServer, store: ApmeStore) async {
        await httpServer.get("/apme/communications") { request in
            if let denied = Self.requireToken(request) { return denied }
            let capturedAt = Int(Date().timeIntervalSince1970 * 1000)
            let since = capturedAt - CollaborationPresentation.networkHistoryWindowMs
            let limit = CollaborationPresentation.networkEventLimit
            guard let events = try? store.listCommunicationEvents(since: since, limit: limit + 1) else {
                return .json(["error": "Communication history unavailable"], status: 503)
            }
            return .json(["schema": "agentdeck-communications/v1", "capturedAt": capturedAt,
                          "since": since, "truncated": events.count > limit,
                          "events": Array(events.prefix(limit))])
        }
        // Dashboard HTML — same self-contained SPA as Node.js bridge.
        // Fetches data from /apme/* JSON endpoints (relative URLs, so port-agnostic).
        await httpServer.get("/apme") { request in
            if let denied = Self.requireToken(request) { return denied }
            return HTTPServer.HTTPResponse(
                status: 200,
                headers: ["Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"],
                body: Data(Self.dashboardHtml.utf8)
            )
        }

        await httpServer.get("/apme/runs") { request in
            if let denied = Self.requireToken(request) { return denied }
            let limit = Int(request.queryParams["limit"] ?? "") ?? 50
            let agent = request.queryParams["agent"]

            let runs = store.listRuns(limit: limit, agentType: agent)
            let result = runs.map { run -> [String: Any] in
                let evals = store.listEvalsForRun(run.id)
                let overall = evals.first(where: { $0.layer == "llm_judge" && $0.metric == "overall" })
                let vibe = store.latestVibeForRun(run.id)
                var dict: [String: Any] = [
                    "id": run.id,
                    "sessionId": run.sessionId,
                    "agentType": run.agentType,
                    "startedAt": run.startedAt,
                ]
                if let v = run.modelId { dict["modelId"] = v }
                if let v = run.projectName { dict["projectName"] = v }
                if let v = run.taskPrompt { dict["taskPrompt"] = v }
                if let v = run.endedAt { dict["endedAt"] = v }
                if let v = run.inputTokens { dict["inputTokens"] = v }
                if let v = run.outputTokens { dict["outputTokens"] = v }
                if let v = run.costUsd { dict["costUsd"] = v }
                if let v = run.exitCode { dict["exitCode"] = v }
                if let v = run.taskCategory { dict["taskCategory"] = v }
                if let v = run.outcome { dict["outcome"] = v }
                if let v = run.compositeScore { dict["compositeScore"] = v }
                if let score = overall?.score ?? run.compositeScore { dict["overallScore"] = score }
                if let reason = ApmeRunner.layer1SkippedReason { dict["layer1SkippedReason"] = reason }
                dict["evals"] = evals.map { Self.evalDict($0) }
                if let vibe = Self.vibeDict(vibe) { dict["vibe"] = vibe }
                return dict
            }
            return .json(["schema": Self.schemaVersion, "runs": result])
        }

        // Daemon-owner-neutral activity projection. Source SQLite rows remain
        // untouched; cached peer rows are merged only for display/export.
        await httpServer.get("/apme/activity") { request in
            if let denied = Self.requireToken(request) { return denied }
            return .json(ApmeActivityHistory.snapshot(store: store).dictionary)
        }

        // Run detail — supports both Node-compatible /apme/run/<id> and the
        // older Swift fallback /apme/run?id=<id>.
        await httpServer.get("/apme/run/*") { request in
            if let denied = Self.requireToken(request) { return denied }
            let id = String(request.path.dropFirst("/apme/run/".count))
            return Self.runDetailResponse(id: id, store: store)
        }

        await httpServer.get("/apme/run") { request in
            if let denied = Self.requireToken(request) { return denied }
            guard let id = request.queryParams["id"], !id.isEmpty else {
                return .json(["error": "missing ?id= parameter"], status: 400)
            }
            return Self.runDetailResponse(id: id, store: store)
        }

        // Tasks: the accumulating browse surface — mirrors Node bridge
        // `GET /apme/tasks` (bridge/src/apme/http.ts). Paged + filtered +
        // faceted; `view` selects a Work-board lifecycle bucket and
        // `sort=attention` floats the attention bucket first. Serving this
        // here is what makes the bundled dashboard's Work board reachable
        // when the Swift daemon owns port 9120 (it used to be Node-only).
        await httpServer.get("/apme/tasks") { request in
            if let denied = Self.requireToken(request) { return denied }
            let q = request.queryParams
            let limit = min(max(Int(q["limit"] ?? "") ?? 50, 1), 500)
            let offset = min(max(Int(q["offset"] ?? "") ?? 0, 0), 1_000_000)
            let views: Set<String> = ["attention", "inprogress", "judged", "reported", "orphaned"]
            let view = q["view"].flatMap { views.contains($0) ? $0 : nil }
            let state = (q["state"] == "closed" || q["state"] == "open") ? q["state"] : nil
            let page = store.listTaskPage(
                limit: limit, offset: offset,
                agentType: q["agent"], sessionId: q["session"], projectName: q["project"],
                category: q["category"], outcome: q["outcome"],
                state: state, view: view,
                // Attention-first is the Work board's ordering and ONLY the
                // Work board's — every other consumer keeps pure recency.
                order: q["sort"] == "attention" ? "attention" : nil,
                q: q["q"])
            // Work-board display projections, enriched here so the store
            // keeps returning raw facts: intent title (generated
            // TaskTitleRules — the same rules that name the timeline's
            // task_start header, over the task's OWN first prompt, never the
            // run fallback) and the folded action line (ActionFoldRules)
            // over one grouped tool query.
            let toolCounts = store.toolCountsForTasks(page.tasks.compactMap { $0["id"] as? String })
            let enriched = page.tasks.map { t -> [String: Any] in
                var d = t
                let tools = toolCounts[t["id"] as? String ?? ""] ?? []
                if let title = TaskTitleRules.deriveTaskTitle(t["ownFirstPrompt"] as? String) {
                    d["title"] = title
                }
                if let fold = ActionFoldRules.foldActionCounts(
                    tools: tools, filesTouched: t["filesTouched"] as? Int) {
                    d["actionFold"] = fold
                }
                if let coord = ActionFoldRules.agentCoordinationSummary(tools) {
                    d["coordination"] = ["dispatches": coord.dispatches, "messages": coord.messages]
                }
                return d
            }
            return .json([
                "schema": Self.schemaVersion,
                "total": page.total, "limit": limit, "offset": offset,
                "tasks": enriched,
                "facets": store.taskFacets(),
                // Badges honor the same narrowing filters as the rows.
                "viewCounts": store.taskViewCounts(
                    agentType: q["agent"], sessionId: q["session"], projectName: q["project"],
                    category: q["category"], outcome: q["outcome"], q: q["q"]),
            ])
        }

        // Read-only row-store graph — parity with bridge/src/apme/graph.ts.
        // This route is what makes the bundled Graph tab available when the
        // sandboxed Swift daemon, rather than the Node daemon, owns port 9120.
        await httpServer.get("/apme/graph") { request in
            if let denied = Self.requireToken(request) { return denied }
            let q = request.queryParams
            var options = ApmeGraphProjection.Options()
            options.limit = min(max(Int(q["limit"] ?? "") ?? 60, 1), 400)
            options.minHubDegree = min(max(Int(q["minHubDegree"] ?? "") ?? 2, 1), 50)
            options.includeTurns = q["turns"] != "0"
            options.includeFiles = q["files"] != "0"
            options.agentType = q["agent"]
            options.projectName = q["project"]
            options.category = q["category"]
            var body = ApmeGraphProjection.build(store: store, options: options)
            body["schema"] = Self.schemaVersion
            return .json(body)
        }

        await httpServer.post("/apme/task-feedback") { request in
            if let denied = Self.requireToken(request) { return denied }
            guard let body = request.body,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let taskId = json["taskId"] as? String,
                  let verdict = json["verdict"] as? String,
                  ApmeReviewRules.verdicts.contains(verdict),
                  json["note"] == nil || json["note"] is NSNull || json["note"] is String,
                  (json["note"] as? String ?? "").utf8.count <= ApmeReviewRules.noteBytes else {
                return .json(["error": "expected taskId, completed|partial|incorrect|clear, optional note (up to 4096 UTF-8 bytes)"], status: 400)
            }
            guard store.getTask(id: taskId) != nil else { return .json(["error": "task not found"], status: 404) }
            guard store.recordTaskFeedback(taskId: taskId, verdict: verdict, note: json["note"] as? String) else {
                return .json(["error": "correction could not be saved"], status: 500)
            }
            return .json(["ok": true, "feedback": store.latestTaskFeedback(taskId) as Any? ?? NSNull()])
        }

        // Single task detail — mirrors Node bridge `GET /apme/tasks/:id`.
        // Returns the task row, its evals, and the turns belonging to it.
        await httpServer.get("/apme/tasks/*") { request in
            if let denied = Self.requireToken(request) { return denied }
            let taskId = String(request.path.dropFirst("/apme/tasks/".count))
            return Self.taskDetailResponse(id: taskId, store: store)
        }

        await httpServer.get("/apme/scorecard") { request in
            if let denied = Self.requireToken(request) { return denied }
            return .json(["schema": Self.schemaVersion, "scorecards": store.scorecard()])
        }

        await httpServer.get("/apme/categories") { request in
            if let denied = Self.requireToken(request) { return denied }
            return .json(["schema": Self.schemaVersion, "categories": store.categoryScorecard()])
        }

        // Local judge-provider detection (onboarding + REVIEW setup). HTTP-only
        // loopback probe — no subprocess, App Store safe. Mirrors the Node
        // GET /apme/judge/detect.
        await httpServer.get("/apme/judge/detect") { request in
            if let denied = Self.requireToken(request) { return denied }
            let providers = await ApmeJudgeDetect.detect()
            let payload = providers.map { ["provider": $0.provider, "label": $0.label, "endpoint": $0.endpoint, "models": $0.models] as [String: Any] }
            return .json(["schema": Self.schemaVersion, "providers": payload])
        }

        // Sample-granularity scorecard (quality vs cost per agent/model/category).
        await httpServer.get("/apme/samples") { request in
            if let denied = Self.requireToken(request) { return denied }
            return .json(["schema": Self.schemaVersion, "scorecards": store.sampleScorecard()])
        }

        // Pareto frontier (quality vs cost) — the model-orchestration menu.
        await httpServer.get("/apme/pareto") { request in
            if let denied = Self.requireToken(request) { return denied }
            let category = request.queryParams["category"]
            return Self.paretoResponse(store: store, category: category)
        }

        await httpServer.get("/apme/rubric/current") { request in
            if let denied = Self.requireToken(request) { return denied }
            guard let rubric = store.getCurrentRubric() else {
                return .json(["error": "no rubric"], status: 404)
            }
            return .json(["schema": Self.schemaVersion, "rubric": rubric])
        }

        // Phase 2: model recommendation endpoint backed by v_model_scorecard.
        // Query params: ?budget=<usd>&models=<comma-separated> (both optional)
        await httpServer.get("/apme/recommend") { request in
            if let denied = Self.requireToken(request) { return denied }
            var input = ApmeRecommendInput()
            if let b = request.queryParams["budget"], let d = Double(b) { input.budgetUsd = d }
            if let models = request.queryParams["models"], !models.isEmpty {
                input.availableModels = models.split(separator: ",").map { String($0) }
            }
            return Self.recommendResponse(store: store, input: input)
        }

        await httpServer.post("/apme/recommend") { request in
            if let denied = Self.requireToken(request) { return denied }
            var input = ApmeRecommendInput()
            if let body = request.body,
               let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                if let taskKind = json["taskKind"] as? String { input.taskKind = taskKind }
                if let budget = json["budgetUsd"] as? Double { input.budgetUsd = budget }
                if let budget = json["budgetUsd"] as? Int { input.budgetUsd = Double(budget) }
                if let latency = json["latencyBudgetMs"] as? Double { input.latencyBudgetMs = latency }
                if let latency = json["latencyBudgetMs"] as? Int { input.latencyBudgetMs = Double(latency) }
                if let preferLocal = json["preferLocal"] as? Bool { input.preferLocal = preferLocal }
                if let models = json["availableModels"] as? [String] { input.availableModels = models }
            }
            return Self.recommendResponse(store: store, input: input)
        }

        // Foundation Models judge — routes TS bridge `callFoundationModels`
        // (bridge/src/apme/runner.ts) into `ApmeJudgeFoundationModels.judge`.
        // Phase 1: no auth header — caller already reached the daemon's bound
        // 127.0.0.1 port, which is same-machine-only per App Review notes.
        //
        // Contract (matches bridge/src/apme/runner.ts callFoundationModels):
        //   Request : { "prompt": "..." }
        //   Response: { "text": "..." } | { "error": "unavailable", "reason": "..." }
        await httpServer.post("/apme/judge/foundation-models") { request in
            guard let body = request.body,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let prompt = json["prompt"] as? String,
                  !prompt.isEmpty else {
                return .json(["error": "bad_request", "reason": "expected { prompt: string }"], status: 400)
            }
            if !ApmeJudgeFoundationModels.isAvailable {
                return .json([
                    "error": "unavailable",
                    "reason": ApmeJudgeFoundationModels.unavailableReason,
                ])
            }
            guard let text = await ApmeJudgeFoundationModels.judge(prompt: prompt) else {
                return .json([
                    "error": "unavailable",
                    "reason": "judge returned nil (content filter, timeout, or session error)",
                ])
            }
            return .json(["text": text])
        }

        await httpServer.post("/apme/vibe") { request in
            if let denied = Self.requireToken(request) { return denied }
            guard let body = request.body,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let runId = json["runId"] as? String,
                  let verdict = json["verdict"] as? String,
                  ["approve", "reject", "neutral"].contains(verdict) else {
                return .json(["error": "expected { runId, verdict, note? }"], status: 400)
            }
            guard store.getRun(id: runId) != nil else {
                return .json(["error": "run not found"], status: 404)
            }
            store.insertVibe(runId: runId, verdict: verdict, note: json["note"] as? String)
            return .json(["ok": true])
        }
    }

    private static func runDetailResponse(id: String, store: ApmeStore) -> HTTPServer.HTTPResponse {
        guard !id.isEmpty else {
            return .json(["error": "missing run id"], status: 400)
        }
        guard let run = store.getRun(id: id) else {
            return .json(["error": "run not found"], status: 404)
        }

        let evals = store.listEvalsForRun(run.id)
        let steps = store.listSteps(runId: run.id)
        let rawTurns = store.listTurns(runId: run.id)
        let turns = rawTurns.map { turn -> [String: Any] in
            var row = turn
            if let turnId = turn["id"] as? String {
                row["turnEvals"] = store.listEvalsForTurn(turnId).map { evalDict($0, includeRaw: true) }
            }
            return row
        }
        let tasks = store.listTasksForRun(run.id).map { t -> [String: Any] in
            var dict = taskDict(t)
            dict["evals"] = store.listEvalsForTask(t.id).map { evalDict($0, includeRaw: true) }
            // The canonical SessionSample (typed trajectory + cost) for this task.
            if let sample = store.getSampleDict(t.id) { dict["sample"] = sample }
            return dict
        }
        let vibe = store.latestVibeForRun(run.id)

        var runDict: [String: Any] = [
            "id": run.id,
            "session_id": run.sessionId,
            "agent_type": run.agentType,
            "started_at": run.startedAt,
        ]
        if let v = run.modelId { runDict["model_id"] = v }
        if let v = run.projectName { runDict["project_name"] = v }
        if let v = run.taskPrompt { runDict["task_prompt"] = v }
        if let v = run.endedAt { runDict["ended_at"] = v }
        if let v = run.taskCategory { runDict["task_category"] = v }
        if let v = run.outcome { runDict["outcome"] = v }
        if let v = run.outcomeConfidence { runDict["outcome_confidence"] = v }
        if let v = run.efficiencyJson { runDict["efficiency_json"] = v }
        if let v = run.compositeScore { runDict["composite_score"] = v }
        if let reason = ApmeRunner.layer1SkippedReason { runDict["layer1SkippedReason"] = reason }

        var body: [String: Any] = [
            "schema": schemaVersion,
            "run": runDict,
            "evals": evals.map { evalDict($0, includeRaw: true) },
            "steps": steps.count,
            "turns": turns,
            "tasks": tasks,
            "vibe": vibeDict(vibe) ?? NSNull(),
        ]
        if let score = evals.first(where: { $0.layer == "llm_judge" && $0.metric == "overall" })?.score
            ?? run.compositeScore {
            body["overallScore"] = score
        }
        return .json(body)
    }

    private static func taskDetailResponse(id: String, store: ApmeStore) -> HTTPServer.HTTPResponse {
        guard !id.isEmpty else {
            return .json(["error": "missing task id"], status: 400)
        }
        guard let task = store.getTask(id: id) else {
            return .json(["error": "task not found"], status: 404)
        }
        let evals = store.listEvalsForTask(id)
        let turns = store.listTurnsForTask(id)
        var body: [String: Any] = [
            "schema": schemaVersion,
            "task": taskDict(task),
            "feedback": store.latestTaskFeedback(id) as Any? ?? NSNull(),
            "evaluation": ["attempt": store.taskAttempt(id) as Any? ?? NSNull(),
                           "enabled": ApmeSettings.load().enabled, "backend": ApmeSettings.load().judge.backend.rawValue],
            "evals": evals.map { evalDict($0, includeRaw: true) },
            "turns": turns,
            "overallScore": evals.last(where: { $0.layer == "task_judge" && $0.metric == "overall" })?.score
                ?? task.compositeScore
                ?? NSNull(),
        ]
        // Run context: the task row alone names no agent, model or project —
        // a task reached directly (the Work board's click path) had no way to
        // say whose work it was. Mirrors Node's GET /apme/tasks/:id.
        if let run = store.getRun(id: task.runId) {
            var runDict: [String: Any] = [
                "id": run.id,
                "sessionId": run.sessionId,
                "agentType": run.agentType,
                "startedAt": run.startedAt,
            ]
            if let v = run.modelId { runDict["modelId"] = v }
            if let v = run.projectName { runDict["projectName"] = v }
            if let v = run.endedAt { runDict["endedAt"] = v }
            body["run"] = runDict
        }
        // The canonical SessionSample — the typed trajectory the detail pane
        // replays. Without it a task page can show scores but not the work.
        if let sample = store.getSampleDict(id) { body["sample"] = sample }
        return .json(body)
    }

    /// Serialize ApmeTask → JSON dict. camelCase, key-for-key with Node's
    /// rowToTask (bridge/src/apme/store.ts) — the shared dashboard reads
    /// `t.taskIndex`/`t.startedAt`/… and the run-detail Tasks section
    /// normalizes both casings, so camelCase is the parity shape. (The old
    /// snake_case keys here claimed "Node-bridge parity" but Node's route
    /// returns camelCase — the detail pane rendered blanks on this daemon.)
    private static func taskDict(_ t: ApmeTask) -> [String: Any] {
        var dict: [String: Any] = [
            "id": t.id,
            "runId": t.runId,
            "taskIndex": t.taskIndex,
            "boundarySignal": t.boundarySignal,
            "startedAt": t.startedAt,
        ]
        if let v = t.endedAt { dict["endedAt"] = v }
        if let v = t.firstTurnIndex { dict["firstTurnIndex"] = v }
        if let v = t.lastTurnIndex { dict["lastTurnIndex"] = v }
        if let v = t.summary { dict["summary"] = v }
        if let v = t.outcome { dict["outcome"] = v }
        if let v = t.compositeScore { dict["compositeScore"] = v }
        if let v = t.taskCategory { dict["taskCategory"] = v }
        if let v = t.notesJson { dict["notesJson"] = v }
        if let v = t.modelId { dict["modelId"] = v }
        if let v = t.provider { dict["provider"] = v }
        if let v = t.modelConfig { dict["modelConfig"] = v }
        if let v = t.inputTokens { dict["inputTokens"] = v }
        if let v = t.outputTokens { dict["outputTokens"] = v }
        if let v = t.costUsd { dict["costUsd"] = v }
        dict["costKnown"] = t.costKnown
        if let v = t.latencyMs { dict["latencyMs"] = v }
        return dict
    }

    private static func recommendResponse(store: ApmeStore, input: ApmeRecommendInput) -> HTTPServer.HTTPResponse {
        var input = input
        let configured = ApmeSettings.load().availableModels
        if !configured.isEmpty {
            input.availableModels = input.availableModels.map { requested in configured.filter { requested.contains($0) } } ?? configured
        }
        let candidates = ApmeRecommender.recommend(store: store, input: input)
        let json = candidates.map { c -> [String: Any] in
            [
                "modelId": c.modelId,
                "agentType": c.agentType,
                "provider": c.provider ?? NSNull(),
                "expectedScore": c.expectedScore,
                "expectedCostUsd": c.expectedCostUsd ?? NSNull(),
                "confidence": c.confidence,
                "samples": c.samples,
                "taskCategory": c.taskCategory ?? NSNull(),
                "rationale": c.rationale,
            ]
        }
        return .json(["schema": schemaVersion, "candidates": json, "minSamples": ApmeComparisonRules.minSamples])
    }

    /// Pareto frontier (quality vs cost). Partitions the sample scorecard into
    /// the non-dominated frontier and the dominated set. Mirrors
    /// bridge/src/apme/pareto.ts.
    private static func paretoResponse(store: ApmeStore, category: String?) -> HTTPServer.HTTPResponse {
        let result = ApmeRecommender.pareto(rows: store.sampleScorecard(), category: category)
        return .json([
            "schema": schemaVersion,
            "category": category.map { $0 as Any } ?? NSNull(),
            "frontier": result.frontier.map(\.dictionary),
            "dominated": result.dominated.map(\.dictionary),
        ])
    }

    /// Dashboard HTML, resolved at first access in priority order:
    ///   1. App bundle resource (`apme-dashboard.html` — shipped with App Store
    ///      build, updated at `pnpm generate-protocol` time).
    ///   2. `~/.agentdeck/apme-dashboard.html` (written by the Node.js bridge
    ///      on boot, may be newer than the bundled copy when both stacks coexist).
    ///   3. Minimal inline fallback pointing at the JSON API.
    ///
    /// This order means App Store users always get a working dashboard even
    /// when no Node bridge has ever run on the machine.
    static let dashboardHtml: String = {
        // 1. Bundled resource
        if let url = Bundle.main.url(forResource: "apme-dashboard", withExtension: "html"),
           let html = try? String(contentsOf: url, encoding: .utf8) {
            return html
        }
        // 2. Node.js bridge's write-target (newer when both stacks run)
        let path = AuthManager.agentDeckDir.appendingPathComponent("apme-dashboard.html").path
        if let html = try? String(contentsOfFile: path, encoding: .utf8) {
            return html
        }
        // 3. Minimal fallback — should not be reached in shipped builds
        return """
        <!DOCTYPE html><html><head><meta charset="utf-8">
        <title>APME Dashboard</title>
        <style>body{background:#0f172a;color:#e2e8f0;font-family:system-ui;padding:40px;text-align:center}
        a{color:#3b82f6}</style></head><body>
        <h2>APME Dashboard</h2>
        <p>Dashboard HTML resource missing from this build.</p>
        <p><a href="/apme/runs">/apme/runs</a> · <a href="/apme/scorecard">/apme/scorecard</a> · <a href="/apme/categories">/apme/categories</a></p>
        </body></html>
        """
    }()
}
#endif
