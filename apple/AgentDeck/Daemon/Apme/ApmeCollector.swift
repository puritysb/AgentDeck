#if os(macOS)
// ApmeCollector.swift — Ingests hook events into the APME SQLite store.
// Mirror of bridge/src/apme/collector.ts for the Swift daemon.
//
// Key design: the Swift daemon receives hook POSTs from potentially multiple
// CONCURRENT Claude Code sessions. Every piece of turn/task state is keyed by
// the hook payload's own `session_id` (real Claude session UUID), mirroring
// the Node collector's sessionToTurn/sessionToTask maps. A payload without a
// session id falls back to the most recently opened session so single-session
// legacy callers (gateway tool events, tests) keep working. Before 2026-07,
// this file held ONE activeTurn/activeTask scalar for the whole daemon —
// with concurrent sessions the globally-active taskId got stamped onto every
// session's timeline rows, nesting unrelated Codex/Claude turns under one
// TASK header (cross-session taskId contamination).

import Foundation

// Holds daemon state → runs on the daemon's executor. See DaemonActor.
@DaemonActor
final class ApmeCollector {
    private let store: ApmeStore

    /// Optional APME runner — the collector fires turn-level evals through it
    /// after response capture. Set by DaemonServer during init. Left nil when
    /// Phase 1 wiring isn't complete (e.g. during tests), in which case
    /// `setTurnResponse` still records the response text but doesn't trigger
    /// a judge.
    var runner: ApmeRunner?

    /// Bridge to the daemon's timeline store + WS broadcast. DaemonServer
    /// wires this up during startServices so task_start / task_end rows the
    /// collector mints land on disk and reach the dashboard. Without this
    /// the dashboard only sees chat_start / chat_end rows and the leading
    /// task icon spins forever after `/clear` (no task_end ever arrives to
    /// pair with task_start). Mirrors the `emitTimeline` callback the Node
    /// bridge wires in bridge/src/apme/index.ts:72-103.
    var emitTimelineEntry: ((DaemonTimelineEntry) -> Void)?

    /// Phase 6 cutover: emit a projected (chat/tool) timeline row from a sample
    /// event, bypassing suppression. Set only when projection mode is enabled.
    /// Mirrors `emitProjectedTimeline` in bridge/src/apme/index.ts.
    var emitProjectedTimelineEntry: ((DaemonTimelineEntry) -> Void)?

    /// Maps a session key → runId. The key is the hook payload's `session_id`
    /// when present (real Claude session UUID), or a generated
    /// `hook-N-epoch` fallback for payloads without one. Using the real id
    /// makes the run — and therefore every task_start/task_end row derived
    /// from `run.sessionId` — filterable by the dashboard's per-session view.
    private var sessionToRun: [String: String] = [:]

    /// The most recently opened session key. Fallback attribution target for
    /// events that carry no `session_id` (gateway tool events, legacy tests)
    /// and for `updateModel`/`updateUsage`, which arrive without session
    /// context.
    private var activeHookSession: String?

    /// Counter for generating fallback session keys.
    private var hookSessionCounter = 0

    /// Active turn tracking per session.
    private struct ActiveTurn {
        let id: String
        let runId: String
        var index: Int
        let startedAt: Int
        var toolCalls: Int = 0
        var filesModified: Int = 0
        var filesCreated: Int = 0
        /// Prompt that opened this turn — used by the duplicate-open guard.
        var prompt: String? = nil
        /// True once setTurnResponse landed on this turn (a same-prompt
        /// re-send after a response is a genuine new turn, not an echo).
        var hasResponse: Bool = false
    }
    /// session key → current open turn. Mirrors sessionToTurn in
    /// bridge/src/apme/collector.ts.
    private var sessionToTurn: [String: ActiveTurn] = [:]

    /// A user_prompt_submit with the same prompt landing on a fresh,
    /// still-empty turn within this window is a transport echo — OpenClaw's
    /// chat `prompt` field and the gateway's `session.message` role=user both
    /// map to `model_call` → user_prompt_submit for one logical prompt.
    /// Mirrors bridge/src/apme/collector.ts DUPLICATE_TURN_OPEN_WINDOW_MS.
    private static let duplicateTurnOpenWindowMs = 15_000
    /// Most recently closed turn (one per run) — survives `closeTurn()`
    /// so late-arriving response text can still land on the right turn.
    /// Maps runId → turnId.
    private var lastClosedTurnByRun: [String: String] = [:]

    /// Active task tracking. Tasks group consecutive turns between hard
    /// boundaries (/task close / /clear / session_end / idle_gap). Mirrors
    /// bridge/src/apme/collector.ts ActiveTask.
    private struct ActiveTask {
        let id: String
        let runId: String
        let index: Int
        let startedAt: Int
        var firstTurnIndex: Int?
        var lastTurnIndex: Int?
        /// First user prompt attached to this task — `deriveTaskTitle` turns
        /// it into the task_start display title at promotion time. Mirrors
        /// ActiveTask.firstPrompt in bridge/src/apme/collector.ts.
        var firstPrompt: String? = nil
        /// True once a `task_start` row has been broadcast to the dashboard
        /// timeline. Stays false for short single-turn conversations that
        /// never trip TodoWrite or a second prompt — keeping the noisy
        /// "TASK" header off the dashboard until a real multi-turn task or
        /// explicit TodoWrite plan signals one is actually in flight.
        var timelineEmitted: Bool = false
    }
    /// session key → current open task. Mirrors sessionToTask in
    /// bridge/src/apme/collector.ts.
    private var sessionToTask: [String: ActiveTask] = [:]
    /// Last milestone key (`taskId:turnIndex`) per session — a turn can carry
    /// several all-completed TodoWrite calls; surface only the first as a
    /// `task_milestone` row. Mirrors sessionToLastMilestone in
    /// bridge/src/apme/collector.ts.
    private var sessionToLastMilestone: [String: String] = [:]
    /// runId → next task_index. Lives across task close/open within a run.
    private var runTaskCount: [String: Int] = [:]
    /// Last cumulative usage per session — ModelEvents are emitted from the
    /// delta (snapshots carry session totals).
    private var sessionToUsage: [String: (inp: Int, out: Int, cost: Double?)] = [:]

    /// Pending idle-gap timer per session. After every `setTurnResponse` we
    /// arm an `idleGapSec` timer; if no new `user_prompt_submit` arrives for
    /// that session, the timer fires `closeTask(boundarySignal: "idle_gap")`
    /// so a genuinely-abandoned task eventually closes (and gets evaluated)
    /// instead of lingering open forever.
    private var idleGapTasks: [String: Task<Void, Never>] = [:]

    /// Idle-gap threshold for auto-closing tasks after the last turn. Exposed
    /// as a var so tests can compress the wait.
    ///
    /// Default 30 min: this is a BACKSTOP for abandoned sessions, NOT a task
    /// boundary. Interactive Claude Code sessions routinely pause far longer
    /// than a machine-paced OpenClaw turn (reading diffs, thinking, running a
    /// build) — the old 90 s default closed the task on every such pause, so a
    /// follow-up prompt started a fresh task and the work fragmented into
    /// disconnected single-turn units. Cohesive grouping is what the user
    /// expects: consecutive prompts stay one task until an EXPLICIT boundary
    /// (`session_end` / `/clear`). The Node daemon has no idle-gap on its
    /// Claude hook path at all; this generous backstop keeps the two daemons
    /// behaving the same for every normal session while still bounding the
    /// truly-idle ones. Tests inject a small value to exercise the timer.
    /// 900 s = the shared SSOT `AGENT_IDLE_GAP_MS` in seconds
    /// (shared/src/eval-schema.ts — change the two together). Measured
    /// 2026-08-28 on the real store: 96% of claude-code inter-turn gaps
    /// (87% codex) are under 15 min, and nearly everything above it is also
    /// above the 30-minute orphan reaper — i.e. already split today, just
    /// mislabeled `orphaned` and judged hours late (codex tasks averaged
    /// 2.4 h open; only 10% were ever judged).
    var idleGapSec: TimeInterval = 900

    /// Minimum age of the session's active turn (in seconds) for
    /// `setTurnResponse` to be allowed to arm the idle-gap timer. Defends
    /// against the late-arriving Stop-hook response race documented in
    /// `DaemonServer.swift:2792`: `setTurnResponse` is dispatched via
    /// `Task { await … }`, so a fast follow-up `user_prompt_submit` can
    /// `closeTurn` + open a fresh new turn before the response callback
    /// actually runs. Without this guard the late callback sees the
    /// brand-new (still generating) turn and arms idle-gap on it — exactly
    /// the "fresh active turn" Codex stop-time review flagged 2026-05-15.
    ///
    /// Production default 0.5 s — plausible agent responses take at least
    /// that long, so a turn younger than 0.5 s receiving a response
    /// callback is almost certainly the race. Tests inject smaller values.
    var idleGapMinTurnAgeSec: TimeInterval = 0.5

    init(store: ApmeStore) {
        self.store = store
    }

    // MARK: - Hook ingestion (called from DaemonServer.handleHookEvent)

    /// Session key for a hook payload: the payload's own `session_id` when
    /// present, else the most recently opened session. Attribution by
    /// payload id is what keeps concurrent sessions' turns/tasks isolated.
    private func payloadSessionKey(_ data: [String: Any]) -> String? {
        if let sid = data["session_id"] as? String, !sid.isEmpty { return sid }
        return activeHookSession
    }

    private func makeFallbackSessionKey() -> String {
        hookSessionCounter += 1
        return "hook-\(hookSessionCounter)-\(Int(Date().timeIntervalSince1970))"
    }

    /// Insert a fresh run for `sessionKey` and register it in the maps.
    @discardableResult
    private func openRunForSession(sessionKey: String, data: [String: Any]) -> String {
        let runId = UUID().uuidString
        let run = ApmeRun(
            id: runId,
            sessionId: sessionKey,
            agentType: data["agent_type"] as? String ?? "claude-code",
            modelId: data["model_name"] as? String,
            projectName: data["project_name"] as? String,
            projectPath: nil,
            startedAt: nowMs(),
            gitBefore: nil
        )
        store.insertRun(run)
        sessionToRun[sessionKey] = runId
        sessionToUsage[sessionKey] = (0, 0, nil) // reset the cumulative-usage delta baseline per session
        return runId
    }

    /// Close the bookkeeping for a run: endedAt + signal classification.
    private func finalizeRun(runId: String) {
        store.updateRun(id: runId, fields: ["endedAt": nowMs()])
        let result = ApmeClassifier.classifyRun(store: store, runId: runId)
        if let signals = try? JSONEncoder().encode(result.signals),
           let json = String(data: signals, encoding: .utf8) {
            store.updateRun(id: runId, fields: [
                "taskSignals": json,
                "taskCategory": result.category.rawValue,
                "taskCategorySource": "auto",
            ])
        }
    }

    /// Main entry point — routes every hook event to the right session's run.
    func handleHook(event: String, data: [String: Any]) {
        guard store.isOpen else { return }
        let isPrompt = event.lowercased() == "user_prompt_submit" || event == "UserPromptSubmit"

        switch event.lowercased() {
        case "session_start":
            let sessionKey = (data["session_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? makeFallbackSessionKey()
            // Restarted/resumed session: finalize the previous run first so
            // its open turn/task don't linger under the new run.
            if let priorRunId = sessionToRun[sessionKey] {
                closeTurn(sessionKey: sessionKey, source: "session_end")
                emitDeferredTaskStartIfNeeded(sessionKey: sessionKey)
                closeTask(sessionKey: sessionKey, boundarySignal: "session_end")
                runTaskCount.removeValue(forKey: priorRunId)
                finalizeRun(runId: priorRunId)
            }
            activeHookSession = sessionKey
            let runId = openRunForSession(sessionKey: sessionKey, data: data)
            DaemonLogger.shared.debug("APME", "openRun \(runId.prefix(8)) session=\(sessionKey) agent=\(data["agent_type"] as? String ?? "claude-code")")

        case "session_end":
            guard let sessionKey = payloadSessionKey(data),
                  let runId = sessionToRun.removeValue(forKey: sessionKey) else { return }
            if activeHookSession == sessionKey { activeHookSession = nil }
            closeTurn(sessionKey: sessionKey, source: "session_end") // close last turn
            // Ensure task_start is emitted before closing, so task_end is also emitted.
            // Without this, a session that never triggered emitDeferredTaskStartIfNeeded
            // (e.g., single-turn session with no TodoWrite) would have task_start
            // omitted, leaving closeTask's timelineEmitted=false → no task_end emitted
            // → Timeline UI showing "in progress" forever.
            emitDeferredTaskStartIfNeeded(sessionKey: sessionKey)
            // Close the active task with session_end boundary. Fires the
            // task_judge listener wired by the runner.
            closeTask(sessionKey: sessionKey, boundarySignal: "session_end")
            runTaskCount.removeValue(forKey: runId)
            sessionToUsage.removeValue(forKey: sessionKey)
            idleGapTasks.removeValue(forKey: sessionKey)?.cancel()

            finalizeRun(runId: runId)
            DaemonLogger.shared.debug("APME", "closeRun \(runId.prefix(8)) session=\(sessionKey)")

            // Record the session_end step too
            recordStep(hookSession: sessionKey, runId: runId, event: event, data: data)
            return // skip the generic recordStep below since we already handled it

        default:
            break
        }

        // Resolve the session this event belongs to. Lazy openRun: the first
        // `user_prompt_submit` arriving for an untracked session — a missed or
        // late `session_start` — must still open a run, or the turn-management
        // block below no-ops and the whole session produces no tasks (every
        // prompt then reads as a bare top-level chat). Mirrors the Node
        // daemon's lazy openRun. Gated to `user_prompt_submit` so a stray
        // post-`session_end` tool/stop hook can't spawn a phantom run
        // (`session_end` already returned above).
        var sessionKey = payloadSessionKey(data)
        if isPrompt {
            if sessionKey == nil { sessionKey = makeFallbackSessionKey() }
            if let key = sessionKey {
                if sessionToRun[key] == nil {
                    let runId = openRunForSession(sessionKey: key, data: data)
                    DaemonLogger.shared.debug("APME", "openRun(lazy) \(runId.prefix(8)) session=\(key) event=\(event)")
                }
                activeHookSession = key
            }
        }

        // Record every event as a step on its session.
        if let key = sessionKey, let runId = sessionToRun[key] {
            recordStep(hookSession: key, runId: runId, event: event, data: data)

            // ── Turn management ──
            if isPrompt {
                // User is active again — cancel any pending idle-gap close
                // we armed after this session's previous turn.
                idleGapTasks.removeValue(forKey: key)?.cancel()

                // Claude Code sends { message: { content: "..." } }, legacy sends { prompt: "..." }
                let prompt = data["prompt"] as? String
                    ?? (data["message"] as? [String: Any])?["content"] as? String

                // /clear: Claude Code's slash command to wipe the conversation.
                // Treat it as a task boundary, not a real turn — close the
                // active task with signal "clear" and skip the open-new-turn
                // path. The next non-/clear prompt will reopen a fresh task
                // via openTaskIfNone. Mirrors bridge/src/apme/adapters/
                // claude-hook.ts:47-49 (which routes /clear to a task_boundary
                // span) + bridge/src/apme/collector.ts splitRun. Without this,
                // closeTask is only ever called on TodoWrite-complete /
                // session_end, so /clear leaves the open task — and its
                // task_start timeline row — spinning forever.
                if let p = prompt, Self.isClearCommand(p) {
                    closeTurn(sessionKey: key, source: "clear")
                    closeTask(sessionKey: key, boundarySignal: "clear")
                    return
                }

                // Duplicate-open guard: closing and reopening on an echoed
                // prompt would strand an empty phantom turn and shift every
                // later turn_index. Mirrors bridge/src/apme/collector.ts.
                if let turn = sessionToTurn[key], let p = prompt, !p.isEmpty,
                   turn.prompt == p, turn.toolCalls == 0, !turn.hasResponse,
                   nowMs() - turn.startedAt < Self.duplicateTurnOpenWindowMs {
                    return
                }

                // Resolve prevIndex before closing: the active turn may
                // already have been closed explicitly, in which case fall
                // back to the last closed turn's stored row so turn_index
                // stays monotonically increasing per run instead of
                // resetting. Mirrors bridge/src/apme/collector.ts.
                var prevIndex = sessionToTurn[key]?.index ?? -1
                if prevIndex == -1, let lastId = lastClosedTurnByRun[runId],
                   let lastIdx = store.getTurn(id: lastId)?["turn_index"] as? Int {
                    prevIndex = lastIdx
                }
                // Close previous turn
                closeTurn(sessionKey: key)
                // Open new turn
                let turnIndex = prevIndex + 1
                let turnId = UUID().uuidString
                sessionToTurn[key] = ActiveTurn(id: turnId, runId: runId, index: turnIndex, startedAt: nowMs(), prompt: prompt)
                // The displaced-close above re-armed the idle-gap timer; a new
                // turn is the "still working" signal, so disarm it again
                // (mirrors the Node collector's clear at sessionToTurn.set).
                idleGapTasks.removeValue(forKey: key)?.cancel()
                // Ensure an active task exists so the new turn can attach to it.
                // openTaskIfNone is idempotent — back-to-back turns within a task
                // all share the same task_id until a boundary signal closes it.
                let task = openTaskIfNone(sessionKey: key, runId: runId)
                let priorFirstTurn = sessionToTask[key]?.firstTurnIndex
                if var t = sessionToTask[key] {
                    if t.firstTurnIndex == nil {
                        t.firstTurnIndex = turnIndex
                        t.firstPrompt = prompt
                    }
                    t.lastTurnIndex = turnIndex
                    sessionToTask[key] = t
                }
                store.insertTurn(id: turnId, runId: runId, turnIndex: turnIndex, prompt: prompt, startedAt: nowMs(), taskId: task?.id)

                // Sample trajectory: the user message opens the turn's typed event log.
                if let task {
                    appendSampleEvent(taskId: task.id, runId: runId, turnIndex: turnIndex,
                                      kind: "user_message", core: prompt ?? "turn\(turnIndex)",
                                      payload: ["text": prompt ?? ""])
                }

                // Multi-turn task signal: if the active task already had a
                // turn before this one (priorFirstTurn != nil), the user is
                // continuing a conversation rather than starting a single
                // Q/A — promote the task to a visible row so the dashboard
                // can show the hierarchy. Idempotent for tasks already
                // promoted by TodoWrite.
                if priorFirstTurn != nil {
                    emitDeferredTaskStartIfNeeded(sessionKey: key)
                }

                // Set run's task_prompt from first prompt
                let run = store.getRun(id: runId)
                if run?.taskPrompt == nil, let p = prompt {
                    store.updateRun(id: runId, fields: ["taskPrompt": String(p.prefix(8000))])
                }
                // Backfill projectName for runs opened without one (the
                // session_start payload lacked project_name and the daemon's
                // enrichment had no session entry yet). Task/milestone/
                // projected rows read run.projectName fresh from the store at
                // emit time, so a backfill before the deferred task_start
                // emit fixes the TASK header's project prefix — without it
                // the header degrades to the agentType fallback label.
                if (run?.projectName ?? "").isEmpty,
                   let proj = data["project_name"] as? String, !proj.isEmpty {
                    store.updateRun(id: runId, fields: ["projectName": proj])
                }
            }

            // Track tool calls on the session's active turn
            if (event.lowercased() == "tool_start" || event == "PreToolUse"), var turn = sessionToTurn[key] {
                turn.toolCalls += 1
                let toolName = data["tool_name"] as? String
                if toolName == "Edit" { turn.filesModified += 1 }
                if toolName == "Write" { turn.filesCreated += 1 }
                sessionToTurn[key] = turn

                // Sample trajectory: a tool call starts as a pending ToolEvent;
                // its PostToolUse result resolves the SAME row (one row, not two).
                if let task = sessionToTask[key], let toolName {
                    appendSampleEvent(taskId: task.id, runId: turn.runId, turnIndex: turn.index,
                                      kind: "tool", core: "\(toolName):\(turn.toolCalls)",
                                      toolName: toolName, toolStatus: "pending",
                                      payload: extractToolInput(data).map { ["input": $0] })
                }

                // Explicit task signal: the agent is using TodoWrite to plan
                // multi-step work. Promote the active task to a visible
                // timeline row on the first TodoWrite call so the user sees
                // the TASK header alongside the planned todos. Subsequent
                // TodoWrite calls are no-ops via the idempotent helper.
                if toolName == "TodoWrite" {
                    emitDeferredTaskStartIfNeeded(sessionKey: key)
                }
            }

            // Sample trajectory: resolve the pending ToolEvent on PostToolUse.
            if (event.lowercased() == "tool_end" || event == "PostToolUse"),
               let toolName = data["tool_name"] as? String,
               let task = sessionToTask[key], let turnIndex = sessionToTurn[key]?.index {
                let isError = (data["is_error"] as? Bool ?? false) || (data["error"] != nil)
                let output = extractToolOutput(data)
                if let pending = store.findPendingToolEvent(taskId: task.id, turnIndex: turnIndex, toolName: toolName),
                   let pid = pending["id"] as? Int {
                    var payloadObj: [String: Any] = [:]
                    if let s = pending["payload"] as? String, let d = s.data(using: .utf8),
                       let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { payloadObj = o }
                    if let output { payloadObj["output"] = output }
                    let payloadStr = (try? JSONSerialization.data(withJSONObject: payloadObj)).flatMap { String(data: $0, encoding: .utf8) }
                    store.updateSampleEvent(id: pid, fields: [
                        "toolStatus": isError ? "error" : "success",
                        "toolError": isError ? "error" : nil,
                        "payload": payloadStr as Any?,
                    ])
                } else {
                    appendSampleEvent(taskId: task.id, runId: task.runId, turnIndex: turnIndex,
                                      kind: "tool", core: "\(toolName):resolved:\(turnIndex):\(store.nextSampleSeq(task.id))",
                                      toolName: toolName, toolStatus: isError ? "error" : "success",
                                      toolError: isError ? "error" : nil,
                                      payload: output.map { ["output": $0] })
                }
            }

            // ── Task boundary HINT: TodoWrite all-completed ──
            // Demoted from a hard boundary to a non-segmenting hint (2026-06,
            // mirrors bridge/src/apme/collector.ts). TodoWrite-all-complete
            // fired unreliably (~18% on Claude Code v2.1) and fragmented a
            // single logical task. Tasks now segment only on EXPLICIT
            // boundaries (`/task close`, `/clear`) or session_end. We still
            // record the milestone in the trajectory as a non-segmenting state
            // event so the rollup can see the agent declared its todos done.
            if (event.lowercased() == "tool_end" || event == "PostToolUse"),
               (data["tool_name"] as? String) == "TodoWrite",
               Self.allTodosCompleted(data: data),
               let task = sessionToTask[key], let turnIndex = sessionToTurn[key]?.index {
                _ = appendSampleEvent(taskId: task.id, runId: task.runId, turnIndex: turnIndex,
                                      kind: "state", core: "todos_complete:\(turnIndex)",
                                      payload: ["state": "todos_completed"])
                emitTaskMilestoneIfNeeded(sessionKey: key, task: task, turnIndex: turnIndex)
            }

            // A real Stop is the authoritative end of agent work for this
            // turn. Leaving it open until the next prompt includes the user's
            // think/typing time in duration and makes an overnight pause look
            // like a multi-hour model call. Codex/OpenCode reach this branch
            // through DaemonServer's agent-neutral normalization; duplicate
            // stop + turn_complete signals are harmless because close is
            // idempotent once sessionToTurn has been removed.
            if event.lowercased() == "stop" {
                let source = (data["interrupted"] as? Bool) == true ? "interrupted"
                    : (data["aborted"] as? Bool) == true ? "aborted"
                    : ((data["synthetic"] as? Bool) == true || (data["synthetic_stop"] as? Bool) == true)
                        ? "synthetic_stop"
                        : "stop"
                closeTurn(sessionKey: key, source: source)
            }
        }
    }

    /// Update model name from state machine (called by DaemonServer when
    /// modelName changes via state_update/timeline relay, not from hooks).
    /// No session context on this path — attributed to the most recent session.
    func updateModel(_ modelId: String?) {
        guard let hookSession = activeHookSession,
              let runId = sessionToRun[hookSession],
              let model = modelId else { return }
        store.updateRun(id: runId, fields: [
            "modelId": model,
            "provider": Self.normalizedProvider(nil, model: model) as Any?,
        ])
    }

    /// Attribute gateway model/provider metadata to the assistant message's
    /// own turn. The run remains a latest-value compatibility fallback.
    func updateTurnIdentity(modelId: String?, provider: String?, sessionId: String) {
        guard let runId = sessionToRun[sessionId] else { return }
        let turnId = sessionToTurn[sessionId]?.id ?? lastClosedTurnByRun[runId]
        let turn = turnId.flatMap { store.getTurn(id: $0) }
        let run = store.getRun(id: runId)
        let model = modelId ?? turn?["model_id"] as? String ?? run?.modelId
        let normalized = Self.normalizedProvider(provider, model: model)
        if let turnId {
            store.updateTurn(id: turnId, fields: [
                "modelId": model as Any?, "provider": normalized as Any?,
            ])
        }
        store.updateRun(id: runId, fields: [
            "modelId": model as Any?, "provider": normalized as Any?,
        ])
        guard let task = sessionToTask[sessionId], let model,
              let taskRow = store.getTask(id: task.id) else { return }
        let taskModel = taskRow.modelId == nil || taskRow.modelId == model ? model : "mixed"
        let taskProvider: String? = normalized == nil ? taskRow.provider
            : (taskRow.provider == nil || taskRow.provider == normalized ? normalized : "mixed")
        store.updateTask(id: task.id, fields: [
            "modelId": taskModel, "provider": taskProvider as Any?,
            "modelConfig": mergedTaskModelConfig(
                task: taskRow, modelId: taskModel, provider: taskProvider) as Any?,
        ])
    }

    /// Update token/cost usage (called when usage_update is received).
    /// No session context on this path — attributed to the most recent session.
    func updateUsage(inputTokens: Int, outputTokens: Int, costUsd: Double?) {
        updateUsage(inputTokens: inputTokens, outputTokens: outputTokens,
                    costUsd: costUsd, sessionId: activeHookSession)
    }

    func updateUsage(inputTokens: Int, outputTokens: Int, costUsd: Double?, sessionId: String?) {
        guard let hookSession = sessionId,
              let runId = sessionToRun[hookSession] else { return }

        // ── Per-task ModelEvent from the cumulative delta ──
        let lastUsage = sessionToUsage[hookSession] ?? (0, 0, nil)
        let dIn = max(0, inputTokens - lastUsage.inp)
        let dOut = max(0, outputTokens - lastUsage.out)
        let dCost = costUsd.map { max(0, $0 - (lastUsage.cost ?? 0)) }
        let turnId = sessionToTurn[hookSession]?.id ?? lastClosedTurnByRun[runId]
        let turn = turnId.flatMap { store.getTurn(id: $0) }
        let run = store.getRun(id: runId)
        let model = turn?["model_id"] as? String ?? run?.modelId
        let priced = ApmePricing.isPriced(model)
        let eventCostKnown = priced || (dCost ?? 0) > 0
        let eventCost = dCost ?? ApmePricing.usd(model: model, inputTokens: dIn, outputTokens: dOut)
        let hadPrevious = lastUsage.inp > 0 || lastUsage.out > 0 || lastUsage.cost != nil
        let hasUsageDelta = dIn > 0 || dOut > 0
        let hasAccountingDelta = hasUsageDelta || (dCost ?? 0) > 0
        let runKnown = !hasAccountingDelta ? (run?.costKnown == true)
            : (hadPrevious ? (run?.costKnown == true && eventCostKnown) : eventCostKnown)
        let runCost = costUsd ?? (priced ? ApmePricing.usd(model: model, inputTokens: inputTokens, outputTokens: outputTokens) : nil)
        sessionToUsage[hookSession] = (inputTokens, outputTokens, costUsd)
        store.updateRun(id: runId, fields: [
            "inputTokens": inputTokens, "outputTokens": outputTokens,
            "costUsd": runCost as Any?, "costKnown": runKnown,
        ])
        if (dIn > 0 || dOut > 0), let task = sessionToTask[hookSession] {
            let turnIndex = sessionToTurn[hookSession]?.index ?? task.lastTurnIndex ?? 0
            appendSampleEvent(taskId: task.id, runId: runId, turnIndex: turnIndex,
                              kind: "model", core: "\(inputTokens):\(outputTokens)",
                              model: model, inputTokens: dIn, outputTokens: dOut,
                              costUsd: eventCost, costKnown: eventCostKnown, latencyMs: 0)
            let provider = turn?["provider"] as? String ?? run?.provider ?? Self.normalizedProvider(nil, model: model)
            let taskRow = store.getTask(id: task.id)
            let taskModel = model == nil ? taskRow?.modelId
                : (taskRow?.modelId == nil || taskRow?.modelId == model ? model : "mixed")
            let taskProvider = provider == nil ? taskRow?.provider
                : (taskRow?.provider == nil || taskRow?.provider == provider ? provider : "mixed")
            if let taskRow {
                store.updateTask(id: task.id, fields: [
                    "modelId": taskModel as Any?, "provider": taskProvider as Any?,
                    "modelConfig": mergedTaskModelConfig(
                        task: taskRow, modelId: taskModel, provider: taskProvider) as Any?,
                ])
            }
            store.recomputeSampleCost(task.id)
        }
    }

    /// Convert one message's usage into the cumulative series updateUsage owns.
    func addUsageIncrement(inputTokens: Int, outputTokens: Int, costUsd: Double?, sessionId: String) {
        let previous = sessionToUsage[sessionId] ?? (0, 0, nil)
        // A later message may omit cost. Preserve the numeric total for
        // provenance, while updateUsage marks the new event unknown and turns
        // the run's aggregate costKnown false.
        let totalCost = costUsd.map { (previous.cost ?? 0) + $0 } ?? previous.cost
        updateUsage(inputTokens: previous.inp + max(0, inputTokens),
                    outputTokens: previous.out + max(0, outputTokens),
                    costUsd: totalCost, sessionId: sessionId)
    }

    private static func normalizedProvider(_ provider: String?, model: String?) -> String? {
        let raw = provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let normalized = raw.isEmpty ? ModelProviderRules.provider(model: model)
            : (ModelProviderRules.vendorPrefixes[raw] ?? ModelProviderRules.provider(model: model))
        return normalized == .unknown ? nil : normalized.rawValue
    }

    /// Merge instead of replacing the SessionSample identity header. Model
    /// hooks and child lifecycle hooks can arrive in either order; preserving
    /// the prior JSON prevents `subagents` (and future header fields) from
    /// disappearing on the next usage update.
    private func mergedTaskModelConfig(
        task: ApmeTask,
        modelId: String? = nil,
        provider: String? = nil,
        subagent: String? = nil
    ) -> String? {
        var config: [String: Any] = [:]
        if let raw = task.modelConfig,
           let data = raw.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            config = parsed
        }

        let priorModel = config["modelId"] as? String
        let priorProvider = config["provider"] as? String
        config["modelId"] = modelId ?? task.modelId ?? priorModel ?? "unknown"
        config["provider"] = provider ?? task.provider ?? priorProvider ?? NSNull()

        var subagents = Set((config["subagents"] as? [Any] ?? []).compactMap { value -> String? in
            guard let name = value as? String else { return nil }
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        })
        if let subagent {
            let trimmed = subagent.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { subagents.insert(trimmed) }
        }
        if !subagents.isEmpty { config["subagents"] = subagents.sorted() }

        guard JSONSerialization.isValidJSONObject(config),
              let data = try? JSONSerialization.data(withJSONObject: config),
              let string = String(data: data, encoding: .utf8) else { return nil }
        return string
    }

    /// Observation-safe handoff from the daemon's subagent census into the
    /// active parent task. A child remains non-steerable and never enters the
    /// ordinary hook state machine; only lifecycle evidence reaches APME.
    /// Returns false when there is no active parent task rather than guessing
    /// an edge from the most-recent session.
    @discardableResult
    func noteSubagentLifecycle(
        sessionId: String,
        id: String,
        name: String,
        phase: String,
        ts: Int,
        startedAt: Int? = nil,
        summary: String? = nil
    ) -> Bool {
        guard phase == "started" || phase == "completed",
              let task = sessionToTask[sessionId],
              let taskRow = store.getTask(id: task.id) else { return false }
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty else { return false }

        if let modelConfig = mergedTaskModelConfig(task: taskRow, subagent: cleanName) {
            store.updateTask(id: task.id, fields: ["modelConfig": modelConfig])
        }

        var payload: [String: Any] = [
            "id": id,
            "name": cleanName,
            "phase": phase,
        ]
        if let summary, !summary.isEmpty { payload["summary"] = summary }
        if let startedAt { payload["durationMs"] = max(0, ts - startedAt) }
        let turnIndex = task.lastTurnIndex ?? task.firstTurnIndex ?? 0
        appendSampleEvent(
            taskId: task.id,
            runId: task.runId,
            turnIndex: turnIndex,
            kind: "subagent",
            core: "\(phase):\(id)",
            ts: ts,
            payload: payload
        )
        return true
    }

    /// Persist a free-form annotation on the session's active task (a task-list
    /// item checked off, a team event without a child identity). Mirrors the
    /// Node collector's `noteInfo`: a `TaskCompleted` hook is NOT a child agent.
    @discardableResult
    func noteInfo(sessionId: String, label: String, detail: String?, ts: Int) -> Bool {
        let cleanLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanLabel.isEmpty, let task = sessionToTask[sessionId] else { return false }
        var payload: [String: Any] = ["label": cleanLabel]
        if let detail, !detail.isEmpty { payload["detail"] = detail }
        let turnIndex = task.lastTurnIndex ?? task.firstTurnIndex ?? 0
        return appendSampleEvent(
            taskId: task.id, runId: task.runId, turnIndex: turnIndex,
            kind: "info", core: "\(cleanLabel):\(ts):\(detail ?? "")", ts: ts, payload: payload)
    }

    /// Persist a cross-session coordination observation (`RelationEvent`) on
    /// the session's active task. Mirrors the Node collector's `noteRelation`:
    /// evidence for the collaboration lens, never a steerable session or a
    /// parent link guessed from project membership.
    @discardableResult
    func noteRelation(
        sessionId: String, relation: String, direction: String, phase: String,
        peerSessionId: String?, peerName: String?, evidence: String, detail: String?,
        ts: Int, key: String
    ) -> Bool {
        guard let task = sessionToTask[sessionId] else { return false }
        var payload: [String: Any] = [
            "relation": relation, "direction": direction, "phase": phase, "evidence": evidence,
        ]
        if let peerSessionId, !peerSessionId.isEmpty { payload["peerSessionId"] = peerSessionId }
        if let peerName, !peerName.isEmpty { payload["peerName"] = peerName }
        if let detail, !detail.isEmpty { payload["detail"] = detail }
        let turnIndex = task.lastTurnIndex ?? task.firstTurnIndex ?? 0
        return appendSampleEvent(
            taskId: task.id, runId: task.runId, turnIndex: turnIndex,
            kind: "relation", core: "\(relation):\(direction):\(phase):\(key)", ts: ts, payload: payload)
    }

    /// The receiver's side of a Claude Code cross-session message. Captured
    /// live from 2.1.261: `<cross-session-message from="uds:/…/<pid>.sock"
    /// from-name="…" from-mode="…">` — the socket basename is the SENDER's pid.
    /// Mirrors bridge/src/coordination-evidence.ts `parseCrossSessionEnvelope`.
    nonisolated static func parseCrossSessionEnvelope(_ prompt: String) -> (fromPid: Int?, fromName: String?, body: String)? {
        guard let open = prompt.range(of: "<cross-session-message"),
              let close = prompt[open.upperBound...].firstIndex(of: ">") else { return nil }
        let attrs = String(prompt[open.upperBound..<close])
        func attr(_ name: String) -> String? {
            guard let r = attrs.range(of: "\(name)=\"") else { return nil }
            let rest = attrs[r.upperBound...]
            guard let end = rest.firstIndex(of: "\"") else { return nil }
            let v = String(rest[..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
            return v.isEmpty ? nil : v
        }
        var pid: Int? = nil
        if let from = attr("from"), let sock = from.split(separator: "/").last,
           sock.hasSuffix(".sock"), let n = Int(sock.dropLast(5)), n > 0 { pid = n }
        var body = String(prompt[prompt.index(after: close)...])
        if let blank = body.range(of: "\n\\s*\n", options: .regularExpression) {
            body = String(body[blank.upperBound...])
        }
        if let closing = body.range(of: "</cross-session-message>") { body = String(body[..<closing.lowerBound]) }
        let flat = body.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return (pid, attr("from-name"), String(flat.prefix(140)))
    }

    /// The `to` of a SendMessage tool call: a session name or a `uds:` path.
    nonisolated static func parseSendMessageTarget(_ input: [String: Any]?) -> (peerName: String?, peerPid: Int?, summary: String?)? {
        guard let to = (input?["to"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !to.isEmpty else { return nil }
        var pid: Int? = nil
        if to.hasPrefix("uds:"), let sock = to.split(separator: "/").last,
           sock.hasSuffix(".sock"), let n = Int(sock.dropLast(5)), n > 0 { pid = n }
        let summaryRaw = (input?["summary"] as? String) ?? (input?["message"] as? String)
        let summary = summaryRaw.map { String($0.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").prefix(140)) }
        return (pid == nil ? to : nil, pid, (summary?.isEmpty ?? true) ? nil : summary)
    }

    // MARK: - Sibling session tracking

    /// Called when a sibling session bridge registers in sessions.json.
    /// Creates a run for it so the daemon has a record even if that session
    /// doesn't POST hooks directly (e.g., it posts to its own bridge port).
    @discardableResult
    func openSiblingRun(sessionId: String, agentType: String, projectName: String?, modelId: String?) -> String {
        guard store.isOpen else { return "" }
        // Don't duplicate if a hook session already covers this
        if sessionToRun[sessionId] != nil { return sessionToRun[sessionId]! }

        let runId = UUID().uuidString
        let run = ApmeRun(
            id: runId, sessionId: sessionId, agentType: agentType,
            modelId: modelId, projectName: projectName, projectPath: nil,
            startedAt: nowMs()
        )
        store.insertRun(run)
        sessionToRun[sessionId] = runId
        return runId
    }

    func closeSiblingRun(sessionId: String) {
        guard let runId = sessionToRun.removeValue(forKey: sessionId) else { return }
        finalizeRun(runId: runId)
    }

    // MARK: - SessionSample trajectory (the normalizer's typed event log)

    /// Composite dedup key. The Node/Swift daemons are alternative (not
    /// concurrent) writers, so a raw composite key is sufficient for
    /// storage-time dedup within a writer; SQLite's UNIQUE(task_id, dedup_key)
    /// makes it atomic via INSERT OR IGNORE.
    private func makeDedupKey(kind: String, turnIndex: Int, core: String) -> String {
        let c = core.count > 160 ? "\(core.prefix(160)):\(core.count)" : core
        return "\(kind)|\(turnIndex)|\(c)"
    }

    @discardableResult
    private func appendSampleEvent(taskId: String, runId: String, turnIndex: Int, kind: String,
                                   core: String, ts: Int? = nil, model: String? = nil,
                                   inputTokens: Int? = nil, outputTokens: Int? = nil,
                                   costUsd: Double? = nil, costKnown: Bool? = nil, latencyMs: Int? = nil,
                                   toolName: String? = nil, toolStatus: String? = nil,
                                   toolError: String? = nil, payload: [String: Any]? = nil) -> Bool {
        var payloadStr: String? = nil
        if let payload,
           let data = try? JSONSerialization.data(withJSONObject: payload),
           let s = String(data: data, encoding: .utf8) { payloadStr = s }
        let inserted = store.insertSampleEvent(
            taskId: taskId, runId: runId, turnIndex: turnIndex,
            turnId: store.turnId(runId: runId, turnIndex: turnIndex), seq: store.nextSampleSeq(taskId),
            ts: ts ?? nowMs(), kind: kind, model: model, inputTokens: inputTokens,
            outputTokens: outputTokens, costUsd: costUsd, costKnown: costKnown, latencyMs: latencyMs,
            toolName: toolName, toolStatus: toolStatus, toolError: toolError,
            payload: payloadStr, dedupKey: makeDedupKey(kind: kind, turnIndex: turnIndex, core: core))
        // Phase 6: project the event to a timeline row (bypasses suppression).
        if inserted, let emit = emitProjectedTimelineEntry,
           let projected = projectSampleEvent(taskId: taskId, runId: runId, ts: ts ?? nowMs(),
                                               kind: kind, toolName: toolName, toolStatus: toolStatus,
                                               toolError: toolError, payload: payload) {
            emit(projected)
        }
        return inserted
    }

    /// Build a projected timeline entry from a sample event. Mirrors
    /// bridge/src/apme/sample-to-timeline.ts. Returns nil for kinds that don't
    /// surface as a standalone row (model/state).
    private func projectSampleEvent(taskId: String, runId: String, ts: Int, kind: String,
                                    toolName: String?, toolStatus: String?, toolError: String?,
                                    payload: [String: Any]?) -> DaemonTimelineEntry? {
        let run = store.getRun(id: runId)
        func base(type: String, raw: String, detail: String?, status: String?) -> DaemonTimelineEntry {
            DaemonTimelineEntry(
                ts: Double(ts), type: type, raw: raw, detail: detail,
                status: status, agentType: run?.agentType, projectName: run?.projectName,
                sessionId: run?.sessionId, runId: runId, taskId: taskId)
        }
        switch kind {
        case "user_message":
            let text = (payload?["text"] as? String) ?? ""
            guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            return base(type: "chat_start", raw: String(text.prefix(120)), detail: String(text.prefix(4000)), status: nil)
        case "assistant_message":
            let text = (payload?["text"] as? String) ?? ""
            let rk = (payload?["responseKind"] as? String) ?? "text"
            guard rk == "text", !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            return base(type: "chat_response", raw: String(text.prefix(120)), detail: String(text.prefix(8000)), status: nil)
        case "tool":
            let name = toolName ?? "tool"
            var inputSummary = ""
            if let inp = payload?["input"] {
                if let s = inp as? String { inputSummary = String(s.prefix(80)) }
                else if let d = inp as? [String: Any] {
                    for key in ["command", "file_path", "path", "pattern", "query", "cmd"] {
                        if let v = d[key] as? String { inputSummary = String(v.prefix(80)); break }
                    }
                }
            }
            let raw = inputSummary.isEmpty ? name : "\(name) · \(inputSummary)"
            let status = toolStatus == "error" ? "denied" : (toolStatus == "success" ? "approved" : "pending")
            return base(type: "tool_resolved", raw: raw, detail: toolError.map { String($0.prefix(1000)) }, status: status)
        case "info":
            let label = (payload?["label"] as? String) ?? "info"
            return base(type: "error", raw: String(label.prefix(120)), detail: payload?["detail"] as? String, status: nil)
        default:
            return nil // model / state — no standalone row
        }
    }

    private func extractToolInput(_ data: [String: Any]) -> Any? {
        return data["tool_input"] ?? data["input"]
    }

    private func extractToolOutput(_ data: [String: Any]) -> Any? {
        return data["tool_response"] ?? data["output"] ?? data["result"]
    }

    // MARK: - Private

    private func closeTurn(sessionKey: String, source: String = "next_prompt") {
        guard let turn = sessionToTurn.removeValue(forKey: sessionKey) else { return }
        lastClosedTurnByRun[turn.runId] = turn.id
        store.updateTurn(id: turn.id, fields: [
            "endedAt": nowMs(),
            "toolCalls": turn.toolCalls,
            "filesModified": turn.filesModified,
            "filesCreated": turn.filesCreated,
            "endSource": source,
        ])
        // Idle-gap arming returns here (2026-08-28), but with the OPPOSITE
        // fire guard from the setTurnResponse arm: this one fires only when
        // NO turn is open. The race that evicted the first attempt — closeTurn
        // runs at the start of every user_prompt_submit, just before a new
        // turn opens, so the timer covered a freshly-started turn — is closed
        // twice over: the prompt branch cancels the timer again AFTER the new
        // turn opens, and `handleIdleGapFire` with a nil turn snapshot
        // refuses to close while any turn is open. Without this arm,
        // stop-emitting agents (Claude/Codex/OpenCode — whose Stop removes
        // the turn) could NEVER hit the setTurnResponse guard, so idle_gap
        // never fired for exactly the sessions the measurement was about.
        scheduleIdleGapClose(sessionKey: sessionKey, afterTurnClose: true)
    }

    // MARK: - Task lifecycle

    /// Open a new task if none is active for this session. Idempotent —
    /// repeat calls while a task is already active return the existing one.
    /// Mirrors bridge/src/apme/collector.ts openTaskIfNone.
    ///
    /// The `task_start` timeline row is NOT emitted here — it is deferred to
    /// `emitDeferredTaskStartIfNeeded()`, which the caller invokes when one
    /// of the "real task" signals fires (TodoWrite plan, second turn on the
    /// same task). Short single-turn conversations therefore never produce a
    /// TASK header on the dashboard — keeping the timeline focused on the
    /// turn rows the user actually wants to evaluate.
    @discardableResult
    private func openTaskIfNone(sessionKey: String, runId: String) -> ActiveTask? {
        if let existing = sessionToTask[sessionKey] { return existing }
        let nextIndex = runTaskCount[runId] ?? 0
        runTaskCount[runId] = nextIndex + 1
        let task = ActiveTask(
            id: UUID().uuidString,
            runId: runId,
            index: nextIndex,
            startedAt: nowMs(),
            firstTurnIndex: nil,
            lastTurnIndex: nil,
            timelineEmitted: false
        )
        sessionToTask[sessionKey] = task
        store.insertTask(ApmeTask(
            id: task.id,
            runId: runId,
            taskIndex: task.index,
            boundarySignal: "open",
            startedAt: task.startedAt
        ))
        return task
    }

    /// Surface the TodoWrite-all-completed soft hint as a `task_milestone`
    /// timeline row — non-segmenting (the task stays open), at most once per
    /// (task, turn). Mirrors `onTaskMilestone` wiring in
    /// bridge/src/apme/index.ts.
    private func emitTaskMilestoneIfNeeded(sessionKey: String, task: ActiveTask, turnIndex: Int) {
        let key = "\(task.id):\(turnIndex)"
        if sessionToLastMilestone[sessionKey] == key { return }
        sessionToLastMilestone[sessionKey] = key
        // The milestone implies a task worth showing — promote the deferred
        // task_start first so the milestone never renders orphaned.
        emitDeferredTaskStartIfNeeded(sessionKey: sessionKey)
        let run = store.getRun(id: task.runId)
        emitTimelineEntry?(DaemonTimelineEntry(
            ts: Double(Date().timeIntervalSince1970 * 1000),
            type: "task_milestone",
            raw: "Todos done",
            agentType: run?.agentType,
            projectName: run?.projectName,
            sessionId: run?.sessionId,
            runId: task.runId,
            taskId: task.id
        ))
    }

    /// Broadcast the deferred `task_start` row for the session's active task,
    /// if one exists and hasn't yet been emitted. Idempotent — repeat calls
    /// are no-ops once the emit happens. Uses the task's original `startedAt`
    /// as the timeline timestamp so the TASK header anchors above the
    /// first turn it groups instead of jumping in mid-conversation.
    private func emitDeferredTaskStartIfNeeded(sessionKey: String) {
        guard var task = sessionToTask[sessionKey], !task.timelineEmitted else { return }
        let run = store.getRun(id: task.runId)
        emitTimelineEntry?(DaemonTimelineEntry(
            ts: Double(task.startedAt),
            type: "task_start",
            // Intent-derived title (first user prompt); the `Task N` fallback
            // is deliberately the display SSOT's "non-meaningful" shape, so an
            // unnamed header keeps the judge-summary-as-title behavior.
            raw: TaskTitleRules.deriveTaskTitle(task.firstPrompt) ?? "Task \(task.index + 1)",
            agentType: run?.agentType,
            projectName: run?.projectName,
            sessionId: run?.sessionId,
            startedAt: Double(task.startedAt),
            runId: task.runId,
            taskId: task.id
        ))
        task.timelineEmitted = true
        sessionToTask[sessionKey] = task
    }

    /// Task display titles are derived by the generated `TaskTitleRules`
    /// (pnpm generate-apme-display-rules, SSOT shared/src/task-title.ts) —
    /// the former hand mirror here was folded into that generator 2026-08-29.

    /// Arm the idle-gap timer for one session. After `idleGapSec` of no new
    /// `user_prompt_submit` on that session, fires
    /// `closeTask(boundarySignal: "idle_gap")` — mirroring the Node bridge
    /// OpenClaw adapter. Cancels any previously armed timer for the same
    /// session so back-to-back turns don't pile up timers.
    ///
    /// Both the active task **and** the active turn are snapshotted at arm
    /// time so `handleIdleGapFire` can refuse to close when a new turn
    /// (continuation prompt) has opened in the interim. Without the turnId
    /// guard, a continuation that wins the race against the timer cancel
    /// can still see the task closed under it.
    ///
    /// In addition, arming is skipped when the session's active turn is
    /// younger than `idleGapMinTurnAgeSec`. That blocks the late-Stop-hook
    /// race where the response callback for the *previous* turn arrives
    /// after the next `user_prompt_submit` has already rotated the active
    /// turn to a brand-new (still generating) turn — without that guard the
    /// fresh turn would get an idle-gap timer pointed at it.
    private func scheduleIdleGapClose(sessionKey: String, afterTurnClose: Bool = false) {
        idleGapTasks.removeValue(forKey: sessionKey)?.cancel()
        guard let snapshotTaskId = sessionToTask[sessionKey]?.id else { return }
        var snapshotTurnId: String? = nil
        if afterTurnClose {
            // Arm from closeTurn: idle begins when the turn ENDS. The fire
            // guard for this arm is "no turn open" (nil snapshot), so a turn
            // that opens later — even if the cancel loses a race — makes the
            // fire a no-op. Mirrors the Node collector's armIdleGapTimer.
            guard sessionToTurn[sessionKey] == nil else { return }
        } else {
            guard let turn = sessionToTurn[sessionKey] else {
                // No active turn → the closeTurn arm owns this shape.
                return
            }
            let now = nowMs()
            let turnAgeMs = max(0, now - turn.startedAt)
            let minAgeMs = Int(idleGapMinTurnAgeSec * 1000)
            if turnAgeMs < minAgeMs {
                // Race-tainted: the active turn was opened so recently that the
                // response we're claiming to have just captured almost certainly
                // belongs to the previous (now closed) turn. Skip arming — a
                // genuine setTurnResponse for the current turn will arrive
                // later (after the agent finishes) and arm correctly then.
                DaemonLogger.shared.debug(
                    "APME",
                    "scheduleIdleGapClose skipped — activeTurn age \(turnAgeMs)ms < min \(minAgeMs)ms (race guard)"
                )
                return
            }
            snapshotTurnId = turn.id
        }
        let delaySec = idleGapSec
        idleGapTasks[sessionKey] = Task { [weak self] in
            let nanos = UInt64(max(0, delaySec) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled else { return }
            self?.handleIdleGapFire(sessionKey: sessionKey, snapshotTaskId: snapshotTaskId, snapshotTurnId: snapshotTurnId)
        }
    }

    /// Called by the idle-gap Task when the timer matures. Two arm shapes,
    /// two guards: a `setTurnResponse` arm (snapshotTurnId set — the
    /// lost-Stop shape where the turn stays open with its reply captured)
    /// closes only the originally-snapshotted (task, turn) pair; a
    /// `closeTurn` arm (snapshotTurnId nil — stop-emitting agents) closes
    /// only while NO turn is open. Either way a continuation prompt that
    /// beat the cancel keeps the task alive.
    private func handleIdleGapFire(sessionKey: String, snapshotTaskId: String, snapshotTurnId: String?) {
        guard let active = sessionToTask[sessionKey], active.id == snapshotTaskId else { return }
        if let snapshotTurnId {
            guard let turn = sessionToTurn[sessionKey], turn.id == snapshotTurnId else { return }
        } else {
            guard sessionToTurn[sessionKey] == nil else { return }
        }
        closeTask(sessionKey: sessionKey, boundarySignal: "idle_gap")
    }

    /// Public wrapper for `closeTask` — used by the daemon HTTP route the
    /// CLI / macOS detail-pane button hits. Mirrors
    /// `bridge/src/apme/collector.ts::closeTaskExternal`. Returns true when
    /// a task was closed, false when no task was active. When `sessionId`
    /// is nil, falls back to the most recent session, then to the most
    /// recently started active task (single-task callers predate the
    /// per-session maps).
    @discardableResult
    func closeTaskExternal(sessionId: String? = nil, boundarySignal: String = "manual", outcome: String? = nil) -> Bool {
        let key: String? = {
            if let sid = sessionId, !sid.isEmpty {
                return sessionToTask[sid] != nil ? sid : nil
            }
            if let ahs = activeHookSession, sessionToTask[ahs] != nil { return ahs }
            return sessionToTask.max(by: { $0.value.startedAt < $1.value.startedAt })?.key
        }()
        guard let key, let task = sessionToTask[key] else { return false }
        closeTask(sessionKey: key, boundarySignal: boundarySignal)
        if let outcome = outcome {
            store.updateTask(id: task.id, fields: ["outcome": outcome as Any?])
        }
        return true
    }

    /// Close the session's active task with the given boundary signal,
    /// persisting metadata and firing the runner's task judge. Tasks that
    /// never saw a turn (firstTurnIndex == nil) are dropped rather than left
    /// as phantoms.
    private func closeTask(sessionKey: String, boundarySignal: String) {
        guard let task = sessionToTask.removeValue(forKey: sessionKey) else { return }
        sessionToLastMilestone.removeValue(forKey: sessionKey)
        // Always cancel any armed idle-gap timer when a task closes, so a
        // late-firing timer can't reopen a closed-task race.
        idleGapTasks.removeValue(forKey: sessionKey)?.cancel()

        // Empty task: no turns ever attached. Drop the row.
        guard task.firstTurnIndex != nil else {
            store.deleteTask(id: task.id)
            DaemonLogger.shared.debug("APME", "closeTask \(task.id.prefix(8)) — empty, dropped")
            return
        }

        // Category, present-at-close. Prefer the run's already-resolved
        // category; otherwise classify synchronously from the run's signals so
        // the task row (and its rollup judge rubric) always carries a stable
        // category. The async run-level classifier (classifyRun at closeRun)
        // frequently resolves AFTER the task has closed → nil category → the
        // judge falls back to the wrong generic rubric. Mirrors
        // bridge/src/apme/collector.ts closeTask.
        let run = store.getRun(id: task.runId)
        var taskCategory = run?.taskCategory
        if taskCategory == nil || taskCategory == "unknown" {
            var signals = ApmeClassifier.computeSignals(store: store, runId: task.runId)
            // run.endedAt is still nil at session_end close, so duration would
            // be 0 and skew the duration rules — derive it from the task span.
            if signals.sessionDurationSec == 0 {
                signals.sessionDurationSec = max(0, Int((nowMs() - task.startedAt) / 1000))
            }
            let category = ApmeClassifier.classify(signals)
            if category != .unknown { taskCategory = category.rawValue }
        }
        let endedAt = nowMs()

        store.updateTask(id: task.id, fields: [
            "endedAt": endedAt,
            "lastTurnIndex": task.lastTurnIndex ?? task.firstTurnIndex ?? 0,
            "boundarySignal": boundarySignal,
            "taskCategory": taskCategory as Any?,
        ])
        DaemonLogger.shared.debug("APME", "closeTask \(task.id.prefix(8)) signal=\(boundarySignal) emitted=\(task.timelineEmitted)")

        // Emit task_end ONLY when the matching task_start reached the
        // timeline. Single-turn tasks that never tripped TodoWrite or a
        // second prompt left the dashboard quiet on open; emitting a
        // stand-alone task_end would surface a "TASK END" row out of
        // nowhere. The DB side still records the boundary so judge runs
        // and analytics aren't affected.
        if task.timelineEmitted {
            let signalLabel: String
            switch boundarySignal {
            case "todo_complete": signalLabel = "TODO done"
            case "clear":         signalLabel = "/clear"
            case "session_end":   signalLabel = "Session end"
            case "manual":        signalLabel = "Manual"
            case "idle_gap":      signalLabel = "Idle gap"
            default:              signalLabel = "Task end"
            }
            let durationSec = max(0, (endedAt - task.startedAt) / 1000)
            // "<signal> · <N> turns · <duration>" — the turn count says what
            // the boundary covered, the human duration replaces raw second
            // counts. Mirrors `taskEndRowText` in bridge/src/apme/index.ts.
            let turns = (task.lastTurnIndex ?? task.firstTurnIndex ?? 0) - (task.firstTurnIndex ?? 0) + 1
            let turnsLabel = turns == 1 ? "1 turn" : "\(turns) turns"
            emitTimelineEntry?(DaemonTimelineEntry(
                ts: Double(endedAt),
                type: "task_end",
                raw: "\(signalLabel) · \(turnsLabel) · \(DaemonTimelineStore.formatDurationSec(durationSec))",
                agentType: run?.agentType,
                projectName: run?.projectName,
                sessionId: run?.sessionId,
                startedAt: Double(task.startedAt),
                endedAt: Double(endedAt),
                runId: task.runId,
                taskId: task.id,
                boundarySignal: boundarySignal
            ))
        }

        // Wire to runner regardless of UI emission — evaluation is a
        // DB-side concern and should fire for every closed task so APME
        // metrics stay representative of real conversations.
        runner?.enqueueTask(
            runId: task.runId,
            taskId: task.id,
            category: taskCategory,
            boundarySignal: boundarySignal
        )
    }

    /// True when the prompt is just `/clear` (Claude Code's conversation
    /// reset slash command). Mirrors the regex in
    /// bridge/src/apme/adapters/claude-hook.ts:47-49 — `^\s*/clear\s*$` with
    /// case-insensitive match. Surrounding whitespace tolerated so a stray
    /// trailing newline from the hook payload doesn't slip through.
    static func isClearCommand(_ prompt: String) -> Bool {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.lowercased() == "/clear"
    }

    /// Extract todos from a PostToolUse TodoWrite payload and check if every
    /// item's status is "completed". Accepts both `tool_input.todos` (hook
    /// standard) and flat `todos`. Matches bridge/src/apme/collector.ts
    /// extractTodos semantics.
    static func allTodosCompleted(data: [String: Any]) -> Bool {
        let raw = (data["tool_input"] as? [String: Any])?["todos"]
            ?? data["todos"]
        guard let todos = raw as? [[String: Any]], !todos.isEmpty else { return false }
        for t in todos {
            let status = t["status"] as? String ?? ""
            if status != "completed" { return false }
        }
        return true
    }

    // MARK: - Task id lookup

    /// Active task id for the most recent session (nil when no task open).
    /// Legacy accessor kept for single-session callers and tests.
    var activeTaskId: String? { activeHookSession.flatMap { sessionToTask[$0]?.id } }

    /// Active task id for one session. This is the ONLY correct lookup for
    /// timeline-row stamping — the legacy `activeTaskId` var reflects
    /// whichever session most recently opened, which under concurrent
    /// sessions stamps another session's taskId onto this session's rows
    /// (the cross-session subtree bug). Mirrors
    /// bridge/src/apme/collector.ts getActiveTaskId(sessionId).
    func activeTaskId(sessionId: String?) -> String? {
        guard let sid = sessionId, !sid.isEmpty else { return activeTaskId }
        return sessionToTask[sid]?.id
    }

    /// True while this collector still owns `runId` — some session maps to it
    /// and will close it normally. The abandoned-run reaper consults this before
    /// finalizing anything: an inactivity window alone would reap a live session
    /// whose user simply stepped away mid-turn, and the row would then be closed
    /// underneath the collector still writing to it.
    /// Mirrors bridge/src/apme/collector.ts isLiveRun.
    func isLiveRun(_ runId: String) -> Bool {
        sessionToRun.values.contains(runId)
    }

    /// (runId, taskId) for a session's currently-open task — used to record a
    /// manual_review eval (REVIEW deck button) into the same store as the
    /// automatic pipeline. Returns nil when no run/task is open for the id.
    func activeRunAndTask(sessionId: String) -> (runId: String, taskId: String)? {
        guard let task = sessionToTask[sessionId] else { return nil }
        return (task.runId, task.id)
    }

    // MARK: - Turn response capture (mid-session eval entry point)

    /// Categories where the LLM judge is triggered per-turn (non-code).
    /// Mirrors the NON_CODE set in bridge/src/apme/index.ts.
    private static let nonCodeCategories: Set<String> = [
        "conversation", "planning", "research", "review",
    ]

    /// Record the agent's response on the session's active turn (or the most
    /// recently closed turn if close already fired) and — if this is the
    /// first response for the run — classify the run inline so a turn_judge
    /// eval can fire immediately. Mirrors the TS `index.ts` fix from commit
    /// e76325f7 and is the Swift side of the category-aware pipeline.
    ///
    /// `sessionId` scopes the lookup to one session's turn state; callers
    /// that know which session produced the response (chat_end rows carry
    /// it) MUST pass it — the nil fallback attributes to the most recent
    /// session, which is only correct when a single session is running.
    ///
    /// `chatEndTs` is the millisecond timestamp of the originating `chat_end`
    /// entry. The Claude Code stop-hook path in `DaemonServer.swift:2792`
    /// dispatches via `Task { await … }`, so a fast follow-up
    /// `user_prompt_submit` can rotate the active turn to a *fresh new turn*
    /// before this callback runs. Without disambiguation the response would
    /// be written onto the wrong turn (Codex stop-time review flagged this
    /// as "stale response still mutates fresh turns"). When `chatEndTs` is
    /// supplied and predates the active turn's start, the response is
    /// attributed to `lastClosedTurnByRun` instead — the turn that was
    /// actually open when chat_end happened. Callers that have no
    /// trustworthy timestamp (e.g. OpenClaw Gateway's `chat.final`, which
    /// is delivered synchronously from the same MainActor) may omit the
    /// parameter; the disambiguator is then a no-op and the original
    /// "prefer the active turn" policy applies.
    ///
    /// Returns the turnId that was updated, or nil if no turn is in scope.
    @discardableResult
    func setTurnResponse(_ response: String, sessionId: String? = nil, runId overrideRunId: String? = nil,
                         chatEndTs: Double? = nil, source: String = "direct") -> String? {
        guard store.isOpen else { return nil }
        guard !response.isEmpty else { return nil }

        let sessionKey = sessionId.flatMap { $0.isEmpty ? nil : $0 } ?? activeHookSession
        let candidateTurn = sessionKey.flatMap { sessionToTurn[$0] }

        // Detect the late-stop-hook race: if `chatEndTs` predates the
        // session's active turn's open time, the response was generated for
        // a different (earlier, now closed) turn. Without this branch the
        // response would clobber a freshly opened turn that's still mid
        // generation — the fresh turn's eventual real response would
        // overwrite it, but in the window the mid-session classifier and
        // turn_judge could pick up the stale text and mis-evaluate.
        let activeTurnIsStaleForResponse: Bool = {
            guard let chatEndTs, let turn = candidateTurn else { return false }
            return Double(turn.startedAt) > chatEndTs
        }()

        // Resolve target turn. `attributedToActiveTurn` gates idle-gap
        // arming at the bottom of this method — when the response lands on
        // a closed turn via the stale-race fallback, the fresh active turn
        // is still generating and must not get an idle-gap timer pointed
        // at it. Codex stop-time review #4 (2026-05-15).
        let runId: String?
        let turnId: String?
        let attributedToActiveTurn: Bool
        if let turn = candidateTurn, !activeTurnIsStaleForResponse {
            runId = turn.runId
            turnId = turn.id
            attributedToActiveTurn = true
        } else if let rid = overrideRunId, let tid = lastClosedTurnByRun[rid] {
            runId = rid
            turnId = tid
            attributedToActiveTurn = false
        } else if let key = sessionKey, let rid = sessionToRun[key], let tid = lastClosedTurnByRun[rid] {
            runId = rid
            turnId = tid
            attributedToActiveTurn = false
        } else {
            // Stale response with no closed-turn fallback to land on — drop
            // it rather than corrupt a fresh active turn. Logged so an
            // unexpected drop is debuggable from the daemon log.
            if activeTurnIsStaleForResponse {
                DaemonLogger.shared.debug("APME", "setTurnResponse dropped — stale (chat_end pre-dates active turn) and no closed-turn fallback")
            }
            return nil
        }
        guard let runId, let turnId else { return nil }

        // Persist response (capped to 10k chars to match TS runner.ts).
        // Tag response_kind='text' in efficiency_json so ApmeRunner.runTurnEval
        // skips tool_only / empty turns (judging silence generates noise scores).
        // Parity with bridge/src/apme/collector.ts mergeEfficiencyJson.
        let clamped = String(response.prefix(10_000))
        let existingTurn = store.getTurn(id: turnId)
        let existingSource = Self.efficiencyDict(existingTurn)["response_source"] as? String
            ?? ((existingTurn?["response"] as? String)?.isEmpty == false ? "direct" : nil)
        guard Self.responseSourcePriority(source) >= Self.responseSourcePriority(existingSource) else {
            return turnId
        }
        let efficiencyJson = Self.mergeEfficiencyJson(existing: existingTurn, patch: [
            "response_kind": "text", "response_source": source,
        ])
        store.updateTurn(id: turnId, fields: [
            "response": clamped,
            "efficiencyJson": efficiencyJson,
        ])
        if attributedToActiveTurn, let key = sessionKey {
            sessionToTurn[key]?.hasResponse = true
        }
        // Sample trajectory: the assistant response closes the turn's event arc.
        if let taskId = existingTurn?["task_id"] as? String {
            let tIdx = (existingTurn?["turn_index"] as? Int) ?? candidateTurn?.index ?? 0
            let payload = jsonString(["text": clamped, "responseKind": "text"])
            if let event = store.findAssistantMessageEvent(taskId: taskId, turnId: turnId),
               let eventId = event["id"] as? Int {
                store.updateSampleEvent(id: eventId, fields: ["payload": payload, "ts": nowMs()])
            } else {
                appendSampleEvent(taskId: taskId, runId: runId, turnIndex: tIdx,
                                  kind: "assistant_message", core: "turn:\(turnId)",
                                  payload: ["text": clamped, "responseKind": "text"])
            }
        }
        DaemonLogger.shared.debug("APME", "setTurnResponse turn=\(turnId.prefix(8)) respLen=\(clamped.count) kind=text")

        // Mid-session classification: the TS bug this fixes was that the
        // classifier only ran on closeRun(), so run.taskCategory was nil at
        // turn-eval time and the turn_judge layer never fired. Inline
        // rule-based classification closes that race.
        guard var run = store.getRun(id: runId) else { return turnId }
        var category = run.taskCategory
        if category == nil {
            let result = ApmeClassifier.classifyRun(store: store, runId: runId)
            let cat = result.category.rawValue
            if cat != "unknown" {
                category = cat
                if let data = try? JSONEncoder().encode(result.signals),
                   let json = String(data: data, encoding: .utf8) {
                    store.updateRun(id: runId, fields: [
                        "taskCategory": cat,
                        "taskSignals": json,
                        "taskCategorySource": "rule",
                    ])
                } else {
                    store.updateRun(id: runId, fields: [
                        "taskCategory": cat,
                        "taskCategorySource": "rule",
                    ])
                }
                run.taskCategory = cat
                DaemonLogger.shared.debug("APME", "mid-session classify runId=\(runId.prefix(8)) → \(cat)")
            }
        }

        // Stamp turn with category — turn-level analytics aggregation depends on this.
        if let category {
            store.updateTurn(id: turnId, fields: ["taskCategory": category])
        }

        // Fire a category-aware turn_judge for non-code categories.
        if let category, Self.nonCodeCategories.contains(category) {
            runner?.enqueueTurn(runId: runId, turnId: turnId, category: category)
        }

        // Arm the idle-gap auto-close ONLY when the response was actually
        // attributed to the session's active turn. If we routed to a closed
        // turn via the stale-race fallback (`chatEndTs` < turn.startedAt),
        // the fresh active turn is still mid-generation; arming an
        // idle-gap timer against it would race a closeTask onto a turn
        // whose real response hasn't even been captured yet. Codex
        // stop-time review #4 (2026-05-15). The age guard inside
        // `scheduleIdleGapClose` is a defensive fallback for callers
        // that don't pass `chatEndTs` (e.g. OpenClaw Gateway); this
        // earlier gate is the precise fix for the late-callback path.
        if attributedToActiveTurn, let key = sessionKey {
            scheduleIdleGapClose(sessionKey: key)
        }

        return turnId
    }

    private func recordStep(hookSession: String, runId: String, event: String, data: [String: Any]) {
        let toolName = data["tool_name"] as? String
        store.insertStep(
            runId: runId,
            ts: nowMs(),
            kind: event,
            toolName: toolName,
            payload: jsonString(data)
        )
    }

    /// Merge `patch` into an existing turns.efficiency_json string without
    /// losing sibling keys. Returns a JSON string suitable for the column.
    /// Parity with bridge/src/apme/collector.ts mergeEfficiencyJson.
    static func mergeEfficiencyJson(
        existing turn: [String: Any]?,
        patch: [String: Any]
    ) -> String {
        var base = efficiencyDict(turn)
        for (k, v) in patch { base[k] = v }
        if let data = try? JSONSerialization.data(withJSONObject: base),
           let str = String(data: data, encoding: .utf8) {
            return str
        }
        return "{}"
    }

    private static func efficiencyDict(_ turn: [String: Any]?) -> [String: Any] {
        guard let raw = turn?["efficiency_json"] as? String, !raw.isEmpty,
              let data = raw.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return parsed
    }

    private static func responseSourcePriority(_ source: String?) -> Int {
        switch source {
        case "session_message_projection": return 1
        case "chat_final": return 3
        case .some: return 2
        case .none: return 0
        }
    }

    private func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

    private func jsonString(_ dict: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return "{}" }
        return str
    }
}
#endif
