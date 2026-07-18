// ApmeTaskBoundaryTests.swift — Swift mirror of
// bridge/src/__tests__/apme-task-boundary.test.ts.
//
// Exercises the task-unit evaluation pipeline that runs on-device via Apple
// Intelligence (Foundation Models) for App Store builds. Tests focus on the
// deterministic parts — boundary detection, task lifecycle, task_id wiring —
// and skip the judge network path (the E2E with FM is a manual verification
// step, same as ApmeCategoryE2ETests).

#if os(macOS)
import XCTest
@testable import AgentDeck

// Exercises daemon-actor types (ApmeCollector, DaemonServer statics).
@DaemonActor
final class ApmeTaskBoundaryTests: XCTestCase {

    // MARK: - Helpers

    private func makeTempStore() throws -> (store: ApmeStore, dir: URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apme-task-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        setenv("AGENTDECK_DATA_DIR", dir.path, 1)
        let store = ApmeStore()
        XCTAssertTrue(store.open(), "store should open")
        return (store, dir)
    }

    private func cleanup(_ tmp: (store: ApmeStore, dir: URL)) {
        tmp.store.close()
        try? FileManager.default.removeItem(at: tmp.dir)
        unsetenv("AGENTDECK_DATA_DIR")
    }

    /// Bring up a collector with an active hook session so UserPromptSubmit /
    /// PostToolUse events are attributed to a real run. Returns the runId.
    @discardableResult
    private func openSessionAndRun(_ collector: ApmeCollector) -> String {
        collector.handleHook(event: "session_start", data: [
            "agent_type": "claude-code",
            "project_name": "demo",
        ])
        // The generated runId is internal — fetch it by scanning the newest
        // run. Tests only run one at a time against a fresh DB.
        return ""
    }

    // MARK: - allTodosCompleted (helper unit)

    func testAllTodosCompleted_trueWhenEveryStatusIsCompleted() async {
        let data: [String: Any] = [
            "tool_name": "TodoWrite",
            "tool_input": [
                "todos": [
                    ["content": "a", "status": "completed"],
                    ["content": "b", "status": "completed"],
                ]
            ],
        ]
        XCTAssertTrue(ApmeCollector.allTodosCompleted(data: data))
    }

    func testAllTodosCompleted_falseWhenAnyTodoIsInProgress() async {
        let data: [String: Any] = [
            "tool_name": "TodoWrite",
            "tool_input": [
                "todos": [
                    ["content": "a", "status": "completed"],
                    ["content": "b", "status": "in_progress"],
                ]
            ],
        ]
        XCTAssertFalse(ApmeCollector.allTodosCompleted(data: data))
    }

    func testAllTodosCompleted_falseWhenTodosMissingOrEmpty() async {
        XCTAssertFalse(ApmeCollector.allTodosCompleted(data: [:]))
        XCTAssertFalse(ApmeCollector.allTodosCompleted(data: [
            "tool_input": ["todos": []],
        ]))
    }

    // MARK: - Task lifecycle through handleHook

    func testFirstUserPromptOpensTaskAndAttachesTurn() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let store = tmp.store
        let collector = ApmeCollector(store: store)
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "hello"])

        // Find the run (there is exactly one).
        guard let run = store.listRuns().first else { return XCTFail("no run") }
        let tasks = store.listTasksForRun(run.id)
        XCTAssertEqual(tasks.count, 1, "exactly one task opened on first prompt")
        XCTAssertEqual(tasks[0].taskIndex, 0)
        XCTAssertNil(tasks[0].endedAt, "task still open until boundary")
        XCTAssertEqual(tasks[0].boundarySignal, "open")

        // Turn is attached to the task.
        let turns = store.listTurns(runId: run.id)
        XCTAssertEqual(turns.count, 1)
        XCTAssertEqual(turns[0]["task_id"] as? String, tasks[0].id)

        XCTAssertEqual(collector.activeTaskId, tasks[0].id)
    }

    /// A hook `session_start` without `project_name` (direct `claude`
    /// install payload shape) opened the run with a nil projectName, and
    /// the TASK header — which reads run.projectName fresh from the store
    /// at emit time — degraded to the agentType fallback prefix. The
    /// prompt path backfills the run from the first payload carrying the
    /// field (the daemon enriches payloads from the session entry / cwd),
    /// and never overwrites a projectName that is already set.
    func testRunProjectNameBackfilledFromLaterPromptButNeverOverwritten() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let store = tmp.store
        let collector = ApmeCollector(store: store)
        collector.handleHook(event: "session_start", data: [
            "agent_type": "claude-code",
            // no project_name
        ])
        collector.handleHook(event: "UserPromptSubmit", data: [
            "prompt": "hello",
            "project_name": "agentdeck",
        ])
        guard let run = store.listRuns().first else { return XCTFail("no run") }
        XCTAssertEqual(run.projectName, "agentdeck", "empty run projectName backfilled from prompt payload")

        collector.handleHook(event: "UserPromptSubmit", data: [
            "prompt": "follow-up",
            "project_name": "some-other-project",
        ])
        XCTAssertEqual(store.listRuns().first?.projectName, "agentdeck",
                       "backfill fills only empty projectName — never overwrites")
    }

    func testTodoWriteAllCompletedRecordsSoftHintWithoutClosingTask() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let store = tmp.store
        let collector = ApmeCollector(store: store)
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "build plan"])
        collector.handleHook(event: "PostToolUse", data: [
            "tool_name": "TodoWrite",
            "tool_input": [
                "todos": [
                    ["content": "a", "status": "completed"],
                    ["content": "b", "status": "completed"],
                ]
            ],
        ])

        guard let run = store.listRuns().first else { return XCTFail("no run") }
        let tasks = store.listTasksForRun(run.id)
        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(tasks[0].boundarySignal, "open")
        XCTAssertNil(tasks[0].endedAt, "TodoWrite completion is a non-segmenting hint")
        XCTAssertEqual(collector.activeTaskId, tasks[0].id)

        let events = store.listSampleEventRows(tasks[0].id)
        XCTAssertTrue(
            events.contains { row in
                (row["kind"] as? String) == "state" &&
                ((row["payload"] as? String)?.contains("todos_completed") ?? false)
            },
            "TodoWrite all-completed should remain visible in the sample trajectory"
        )
    }

    func testTodoWritePartialDoesNotCloseTask() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let store = tmp.store
        let collector = ApmeCollector(store: store)
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "p"])
        collector.handleHook(event: "PostToolUse", data: [
            "tool_name": "TodoWrite",
            "tool_input": [
                "todos": [
                    ["content": "a", "status": "completed"],
                    ["content": "b", "status": "in_progress"],
                ]
            ],
        ])

        guard let run = store.listRuns().first else { return XCTFail("no run") }
        let tasks = store.listTasksForRun(run.id)
        XCTAssertEqual(tasks.count, 1)
        XCTAssertNil(tasks[0].endedAt)
        XCTAssertEqual(tasks[0].boundarySignal, "open")
    }

    func testSecondUserPromptAfterTodoCompleteStaysInSameTask() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let store = tmp.store
        let collector = ApmeCollector(store: store)
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "first"])
        collector.handleHook(event: "PostToolUse", data: [
            "tool_name": "TodoWrite",
            "tool_input": ["todos": [["content": "a", "status": "completed"]]],
        ])
        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "second"])

        guard let run = store.listRuns().first else { return XCTFail("no run") }
        let tasks = store.listTasksForRun(run.id)
        XCTAssertEqual(tasks.count, 1, "TodoWrite completion is not a boundary")
        XCTAssertEqual(tasks[0].taskIndex, 0)
        XCTAssertNil(tasks[0].endedAt)

        let turns = store.listTurns(runId: run.id)
        XCTAssertEqual(turns.count, 2)
        XCTAssertEqual(turns[0]["task_id"] as? String, tasks[0].id)
        XCTAssertEqual(turns[1]["task_id"] as? String, tasks[0].id)
    }

    func testSessionEndClosesActiveTaskWithSessionEndBoundary() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let store = tmp.store
        let collector = ApmeCollector(store: store)
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "x"])
        // Must grab runId BEFORE session_end — sessionToRun clears it there.
        guard let run = store.listRuns().first else { return XCTFail("no run") }

        collector.handleHook(event: "session_end", data: [:])

        let tasks = store.listTasksForRun(run.id)
        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(tasks[0].boundarySignal, "session_end")
        XCTAssertNotNil(tasks[0].endedAt)
    }

    // MARK: - parseJudgeJson summary extraction

    func testParseJudgeJsonExtractsSummaryAndScores() async {
        let raw = #"""
        {
          "summary": "Added task boundary detection.",
          "completion": 0.9,
          "coherence": 0.8,
          "efficiency": 0.7,
          "overall": 0.85,
          "reasoning": "agent delivered end-to-end",
          "done": ["boundary detection"],
          "missed": []
        }
        """#
        guard let parsed = ApmeRunner.parseJudgeJson(raw) else {
            return XCTFail("parseJudgeJson returned nil")
        }
        XCTAssertEqual(parsed.summary, "Added task boundary detection.")
        XCTAssertEqual(parsed.scores["overall"] ?? -1, 0.85, accuracy: 0.001)
        XCTAssertEqual(parsed.scores["completion"] ?? -1, 0.9, accuracy: 0.001)
        XCTAssertEqual(parsed.scores["coherence"] ?? -1, 0.8, accuracy: 0.001)
        XCTAssertEqual(parsed.scores["efficiency"] ?? -1, 0.7, accuracy: 0.001)
        XCTAssertEqual(parsed.done ?? [], ["boundary detection"])
    }

    func testParseJudgeJsonSummaryIsOptional() async {
        // No summary field — the existing turn/run eval path must still parse.
        let raw = #"{"overall": 0.5, "reasoning": ""}"#
        guard let parsed = ApmeRunner.parseJudgeJson(raw) else {
            return XCTFail("parseJudgeJson returned nil")
        }
        XCTAssertNil(parsed.summary)
        XCTAssertEqual(parsed.scores["overall"] ?? -1, 0.5, accuracy: 0.001)
    }

    func testParseJudgeJsonSummaryClippedTo280() async {
        let longStr = String(repeating: "x", count: 400)
        let raw = "{\"summary\":\"\(longStr)\",\"overall\":0.5}"
        guard let parsed = ApmeRunner.parseJudgeJson(raw) else {
            return XCTFail("parseJudgeJson returned nil")
        }
        XCTAssertEqual(parsed.summary?.count, 280, "summary defensively clipped")
    }

    // MARK: - Deferred task_start emit + idle_gap timer (timeline UX)

    /// A single-turn conversation that never uses TodoWrite must not produce
    /// a `task_start` or `task_end` row on the dashboard timeline — the row
    /// would render as a TASK header with a spinner that never resolves
    /// (because there's no closing signal until session_end). The DB record
    /// is still written so APME evaluations stay accurate.
    func testSingleTurnDoesNotEmitTaskStartToTimeline() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        var emitted: [DaemonTimelineEntry] = []
        collector.emitTimelineEntry = { emitted.append($0) }
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "hello"])

        XCTAssertTrue(
            emitted.allSatisfy { $0.type != "task_start" && $0.type != "task_end" },
            "single-turn task must not surface a TASK row"
        )
        // But the DB row still exists for evaluation.
        guard let run = tmp.store.listRuns().first else { return XCTFail("no run") }
        XCTAssertEqual(tmp.store.listTasksForRun(run.id).count, 1)
    }

    /// As soon as a second user prompt arrives on the same task, the
    /// collector promotes the deferred `task_start` so the dashboard shows
    /// the conversation hierarchy.
    func testLazyOpenRunCreatesTaskWhenSessionStartMissed() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        var emitted: [DaemonTimelineEntry] = []
        collector.emitTimelineEntry = { emitted.append($0) }

        // NO session_start — simulate a daemon that started mid-session (or a
        // dropped session_start hook). The first prompt must still open a run
        // + task, then a follow-up prompt must group under the SAME task and
        // promote the deferred header.
        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "first"])
        XCTAssertNotNil(collector.activeTaskId, "lazy openRun must create a task without session_start")
        let firstTaskId = collector.activeTaskId

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "second"])
        XCTAssertEqual(collector.activeTaskId, firstTaskId, "follow-up prompt stays in the same task")
        let starts = emitted.filter { $0.type == "task_start" }
        XCTAssertEqual(starts.count, 1, "grouped follow-up promotes exactly one header")
    }

    func testSecondTurnEmitsDeferredTaskStart() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        var emitted: [DaemonTimelineEntry] = []
        collector.emitTimelineEntry = { emitted.append($0) }
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "first"])
        XCTAssertEqual(emitted.filter { $0.type == "task_start" }.count, 0)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "second"])
        let starts = emitted.filter { $0.type == "task_start" }
        XCTAssertEqual(starts.count, 1, "second turn promotes the TASK header")
        XCTAssertEqual(starts.first?.taskId, collector.activeTaskId)
    }

    /// TodoWrite is the explicit "this is a planned task" signal — emit the
    /// TASK header on first invocation regardless of turn count.
    func testTodoWriteTriggersImmediateTaskStartEmit() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        var emitted: [DaemonTimelineEntry] = []
        collector.emitTimelineEntry = { emitted.append($0) }
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "build it"])
        XCTAssertEqual(emitted.filter { $0.type == "task_start" }.count, 0)

        collector.handleHook(event: "PreToolUse", data: ["tool_name": "TodoWrite"])
        XCTAssertEqual(emitted.filter { $0.type == "task_start" }.count, 1)
    }

    /// When a task that was promoted to the timeline closes, a matching
    /// `task_end` row must reach the dashboard so the spinner can stop.
    /// (The opposite — a never-emitted task — is covered above.)
    func testPromotedTaskEmitsTaskEndOnClose() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        var emitted: [DaemonTimelineEntry] = []
        collector.emitTimelineEntry = { emitted.append($0) }
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "plan"])
        collector.handleHook(event: "PreToolUse", data: ["tool_name": "TodoWrite"])
        collector.handleHook(event: "PostToolUse", data: [
            "tool_name": "TodoWrite",
            "tool_input": ["todos": [["content": "a", "status": "completed"]]],
        ])
        collector.closeTaskExternal(boundarySignal: "manual")

        let kinds = emitted.map(\.type)
        XCTAssertEqual(kinds.filter { $0 == "task_start" }.count, 1)
        XCTAssertEqual(kinds.filter { $0 == "task_end" }.count, 1)
    }

    /// idle_gap timer: armed at the end of `setTurnResponse` (agent has
    /// delivered its reply). After `idleGapSec` of no new user prompt the
    /// task auto-closes with boundary `idle_gap`. Tests use a 50 ms
    /// threshold — production default is 90 s, mirroring the Node bridge
    /// OpenClaw adapter. `idleGapMinTurnAgeSec` is set to 0 here so the
    /// race-guard introduced for the Codex stop-time review doesn't make
    /// the test fight against itself (real production turns are easily
    /// older than the default 0.5 s by the time the agent responds).
    func testIdleGapTimerClosesTaskAfterInactivity() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        collector.idleGapSec = 0.05
        collector.idleGapMinTurnAgeSec = 0
        openSessionAndRun(collector)

        // Open a task and let it cross the multi-turn threshold so the
        // task closure has something visible to emit.
        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "first"])
        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "second"])

        // Agent finishes responding — this is when the idle-gap timer arms.
        _ = collector.setTurnResponse("answer to second")

        XCTAssertNotNil(collector.activeTaskId, "task is open while waiting for next prompt")

        // Wait past the idle-gap window (idleGapSec * 4 to absorb jitter).
        try? await Task.sleep(nanoseconds: UInt64(0.25 * 1_000_000_000))

        XCTAssertNil(collector.activeTaskId, "idle_gap should auto-close the task")

        // Verify the boundary signal recorded matches.
        guard let run = tmp.store.listRuns().first else { return XCTFail("no run") }
        let tasks = tmp.store.listTasksForRun(run.id)
        XCTAssertEqual(tasks.first?.boundarySignal, "idle_gap")
    }

    /// A new user prompt arriving inside the idle-gap window must cancel
    /// the pending close — otherwise multi-turn debugging sessions would
    /// be split into separate tasks every 90 s.
    func testNewPromptCancelsIdleGapTimer() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        collector.idleGapSec = 0.1
        collector.idleGapMinTurnAgeSec = 0
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "first"])
        _ = collector.setTurnResponse("response one")  // arms idle-gap

        // Half-way through the window — keep talking.
        try? await Task.sleep(nanoseconds: UInt64(0.05 * 1_000_000_000))
        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "still talking"])

        // Wait past the original window — task must still be open.
        try? await Task.sleep(nanoseconds: UInt64(0.07 * 1_000_000_000))
        XCTAssertNotNil(collector.activeTaskId, "new prompt resets the idle timer")
    }

    /// Regression for the Codex stop-time review finding: the idle-gap
    /// timer must NOT fire while the assistant is still generating its
    /// reply. Previously `closeTurn` (called at the start of every new
    /// `user_prompt_submit`) armed the timer for 90 s, so a long agent
    /// generation that ran past the threshold would close its own task.
    /// The fix moves arming to `setTurnResponse`.
    func testIdleGapDoesNotFireDuringActiveGeneration() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        collector.idleGapSec = 0.05
        openSessionAndRun(collector)

        // User submits a prompt. The agent is still generating — no
        // setTurnResponse yet. The timer must remain dormant.
        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "long running task"])

        try? await Task.sleep(nanoseconds: UInt64(0.2 * 1_000_000_000))

        XCTAssertNotNil(
            collector.activeTaskId,
            "idle-gap must not close the task while the agent is still generating"
        )
    }

    /// Defensive guard: if the idle-gap Task somehow runs after a new turn
    /// has opened (e.g. a continuation prompt won the race against the
    /// timer cancel), the `handleIdleGapFire` snapshot check on
    /// (taskId, turnId) must refuse to close. This drives that guard
    /// directly: arm with the active turn's id, swap the active turn
    /// out from under it, and confirm closeTask doesn't fire.
    func testIdleGapSnapshotTurnIdGuardPreventsStaleClose() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        // Threshold short enough to fire quickly; we'll race a follow-up
        // prompt past the cancel via the actor scheduler.
        collector.idleGapSec = 0.05
        collector.idleGapMinTurnAgeSec = 0
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "first"])
        _ = collector.setTurnResponse("done")

        // Continuation prompt — cancels the prior timer and opens a new
        // turn. In the race the cancel handles in-progress sleeps; the
        // turnId snapshot guards the post-sleep path.
        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "second"])

        // Even waiting well past the original window, the second turn is
        // active and the timer for the first turn must not fire on it.
        try? await Task.sleep(nanoseconds: UInt64(0.25 * 1_000_000_000))
        XCTAssertNotNil(
            collector.activeTaskId,
            "stale idle-gap timer must not close a task hosting a fresh turn"
        )
    }

    /// Codex stop-time review (2026-05-15, follow-up #3): the late
    /// stop-hook callback in `DaemonServer.swift:2792` carries the
    /// response text but is dispatched through `Task { await … }`. When
    /// a fast follow-up `user_prompt_submit` rotates `activeTurn` to a
    /// fresh new turn before the callback runs, the response was
    /// generated for the *previous* (now closed) turn — it must not
    /// mutate the fresh turn's record (the mid-session classifier and
    /// turn_judge would then read the wrong text). `setTurnResponse`
    /// disambiguates by comparing `chatEndTs` against
    /// `activeTurn.startedAt`: an earlier `chatEndTs` routes the
    /// response to `lastClosedTurnByRun` instead.
    func testStaleResponseRoutesToClosedTurnNotFreshTurn() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        collector.idleGapMinTurnAgeSec = 0
        openSessionAndRun(collector)

        // Turn 1
        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "Q1"])

        // Capture a ts the Stop-hook's chat_end *would* carry — between
        // turn1 open and the follow-up prompt. Sleeping briefly ensures
        // turn2's `startedAt` lands strictly after `chatEndQ1`.
        let chatEndQ1 = Double(Int(Date().timeIntervalSince1970 * 1000))
        try? await Task.sleep(nanoseconds: UInt64(0.03 * 1_000_000_000))

        // Turn 2 (fast follow-up — `closeTurn` puts turn1 into
        // lastClosedTurnByRun, then turn2 opens fresh).
        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "Q2"])

        // Now the late callback arrives carrying Q1's chat_end ts.
        // `chatEndQ1 < turn2.startedAt` → response must route to turn1.
        _ = collector.setTurnResponse("Q1's stale answer", chatEndTs: chatEndQ1)

        guard let run = tmp.store.listRuns().first else { return XCTFail("no run") }
        let turns = tmp.store.listTurns(runId: run.id)
        XCTAssertEqual(turns.count, 2)
        let turn1 = turns.first(where: { ($0["turn_index"] as? Int) == 0 })
        let turn2 = turns.first(where: { ($0["turn_index"] as? Int) == 1 })
        XCTAssertEqual(
            turn1?["response"] as? String,
            "Q1's stale answer",
            "stale response should land on closed turn1"
        )
        let turn2Response = turn2?["response"] as? String
        XCTAssertNotEqual(
            turn2Response,
            "Q1's stale answer",
            "fresh turn2 must NOT be polluted by the stale Q1 response"
        )
    }

    /// Sanity check the disambiguator's non-race path: a `chatEndTs`
    /// that's *not* before `activeTurn.startedAt` (normal flow) attributes
    /// to activeTurn as before.
    func testSetTurnResponseAttributesToActiveTurnWhenChatEndIsCurrent() async {
        let tmp: (store: ApmeStore, dir: URL)
        do { tmp = try makeTempStore() } catch { return XCTFail("store") }
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        collector.idleGapMinTurnAgeSec = 0
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "Q"])
        // chatEndTs slightly *after* turn start — normal in-turn callback.
        let chatEndNow = Double(Int(Date().timeIntervalSince1970 * 1000) + 50)
        let turnId = collector.setTurnResponse("answer", chatEndTs: chatEndNow)

        guard let run = tmp.store.listRuns().first else { return XCTFail("no run") }
        let turns = tmp.store.listTurns(runId: run.id)
        XCTAssertEqual(turns.count, 1)
        XCTAssertEqual(turns[0]["response"] as? String, "answer")
        XCTAssertEqual(turnId, turns[0]["id"] as? String)
    }

    /// Codex stop-time review (2026-05-15, follow-up #4): stale-routed
    /// responses must NOT arm the idle-gap timer either. Previously
    /// `setTurnResponse` always armed at the end — when the response
    /// landed on `lastClosedTurnByRun` via the stale fallback, the
    /// arming still targeted `activeTurn` (the fresh, still-generating
    /// turn) and only the age guard inside `scheduleIdleGapClose`
    /// blocked it. With `idleGapMinTurnAgeSec = 0` the age guard is
    /// disabled, exposing the bug. The fix gates arming on
    /// `attributedToActiveTurn`.
    func testStaleRoutedResponseDoesNotArmIdleGapOnFreshTurn() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        collector.idleGapSec = 0.05
        collector.idleGapMinTurnAgeSec = 0  // disable the secondary guard
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "Q1"])
        let chatEndQ1 = Double(Int(Date().timeIntervalSince1970 * 1000))
        try? await Task.sleep(nanoseconds: UInt64(0.03 * 1_000_000_000))

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "Q2"])
        // Stale response → routes to closed turn1. With the fix this
        // call must NOT arm an idle-gap timer against the fresh turn2.
        _ = collector.setTurnResponse("Q1 stale", chatEndTs: chatEndQ1)

        // Wait past idleGapSec. If arming wrongly happened on turn2, the
        // timer's snapshot turnId would match the still-active turn2 and
        // closeTask would fire.
        try? await Task.sleep(nanoseconds: UInt64(0.2 * 1_000_000_000))
        XCTAssertNotNil(
            collector.activeTaskId,
            "stale-routed response must not arm idle-gap on the fresh active turn"
        )
    }

    /// As above (idle-gap regression), kept after the response-routing
    /// fix to confirm both guards co-exist.
    func testIdleGapDoesNotArmOnFreshActiveTurn() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        collector.idleGapSec = 0.05
        // Any activeTurn younger than 500 ms is treated as race-tainted.
        // The brand-new turn we open below is 0 ms old.
        collector.idleGapMinTurnAgeSec = 0.5
        openSessionAndRun(collector)

        // Brand-new turn (age 0). Simulate a late stop-hook callback by
        // calling setTurnResponse immediately — like the racing async
        // path in DaemonServer.swift:2792.
        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "Q from race"])
        _ = collector.setTurnResponse("stale response from prior turn")

        // Wait past idleGapSec (50 ms) — if the guard worked, no timer is
        // armed and the task remains open. If the guard regressed, the
        // timer would fire and close the task here.
        try? await Task.sleep(nanoseconds: UInt64(0.2 * 1_000_000_000))
        XCTAssertNotNil(
            collector.activeTaskId,
            "fresh active turn must not be armed by a late/stale setTurnResponse"
        )
    }

    // MARK: - Gateway tool hook routing (Codex review #5 — start vs end discrimination)

    /// OpenClaw emits a `tool_exec` entry with `status="running"` and an
    /// `input` payload when a tool starts. OpenClawAdapter builds those
    /// into a non-empty `detail` blob ("status: running\ninput: {...}"),
    /// which the previous handler's `entry["detail"] != nil` fallback
    /// treated as "has output" and routed to `tool_end`. The strict
    /// discriminator now lives in `DaemonServer.gatewayToolHookFromEntry`:
    /// only `status in {complete,error,failed}` or a non-nil
    /// `toolOutput` qualifies as end. Running-with-input → start.
    func testGatewayToolRunningWithInputRoutesAsStart() async {
        let entry: [String: Any] = [
            "raw": "shell · running",
            "type": "tool_exec",
            "toolName": "shell",
            "toolInput": ["command": "ls -la"],
            "status": "running",
            "detail": "status: running\ninput: {\"command\":\"ls -la\"}",
        ]
        let routed = DaemonServer.gatewayToolHookFromEntry(entry)
        XCTAssertEqual(routed.event, "tool_start", "status=running must route as tool_start even when detail is non-nil")
        XCTAssertEqual(routed.data["tool_name"] as? String, "shell")
        XCTAssertNotNil(routed.data["tool_input"])
        XCTAssertNil(routed.data["tool_response"])
    }

    /// Complete with output → tool_end.
    func testGatewayToolCompleteWithOutputRoutesAsEnd() async {
        let entry: [String: Any] = [
            "raw": "shell · complete",
            "type": "tool_exec",
            "toolName": "shell",
            "toolInput": ["command": "ls"],
            "toolOutput": "total 0",
            "status": "complete",
        ]
        let routed = DaemonServer.gatewayToolHookFromEntry(entry)
        XCTAssertEqual(routed.event, "tool_end")
        XCTAssertEqual(routed.data["tool_name"] as? String, "shell")
        XCTAssertEqual(routed.data["tool_response"] as? String, "total 0")
    }

    /// Error status → tool_end (output may be absent — the agent failed
    /// before producing one).
    func testGatewayToolErrorStatusRoutesAsEnd() async {
        let entry: [String: Any] = [
            "raw": "shell · error",
            "type": "tool_exec",
            "toolName": "shell",
            "status": "error",
        ]
        let routed = DaemonServer.gatewayToolHookFromEntry(entry)
        XCTAssertEqual(routed.event, "tool_end")
    }

    /// Output present without explicit status → tool_end (agent produced
    /// a result even if it didn't tag it).
    func testGatewayToolOutputWithoutStatusRoutesAsEnd() async {
        let entry: [String: Any] = [
            "raw": "shell",
            "type": "tool_exec",
            "toolName": "shell",
            "toolOutput": "done",
        ]
        let routed = DaemonServer.gatewayToolHookFromEntry(entry)
        XCTAssertEqual(routed.event, "tool_end")
    }

    /// Legacy entry (no structured `toolName`/`toolOutput`, only `raw` of
    /// the form "{name} · {status}") must still split on " · " to recover
    /// the tool name and route by status.
    func testGatewayToolLegacyRawSplitsAndRoutesAsStart() async {
        let entry: [String: Any] = [
            "raw": "shell · running",
            "type": "tool_exec",
        ]
        let routed = DaemonServer.gatewayToolHookFromEntry(entry)
        XCTAssertEqual(routed.data["tool_name"] as? String, "shell", "split on ' · ' to recover legacy name")
        XCTAssertEqual(routed.event, "tool_start")
    }

    /// No status, no toolOutput → start (default — tool is still in flight).
    func testGatewayToolNoStatusRoutesAsStart() async {
        let entry: [String: Any] = [
            "raw": "shell",
            "type": "tool_exec",
            "toolName": "shell",
        ]
        let routed = DaemonServer.gatewayToolHookFromEntry(entry)
        XCTAssertEqual(routed.event, "tool_start")
    }

    /// Codex stop-time review #6 (2026-05-16): JSON `null` values arrive
    /// in `[String: Any]` dicts as `NSNull`, which `Optional` treats as
    /// "set" (`Optional.some(NSNull())`). A naive `toolOutput != nil`
    /// check then misclassified a running tool whose payload carried an
    /// explicit `"toolOutput": null` as having real output, routing it
    /// to `tool_end`. The fix unwraps NSNull as absent in the router
    /// (`unwrapJSONValue`) AND filters it on the producer side
    /// (`OpenClawAdapter.firstJSONValue`).
    func testGatewayToolExplicitNullToolOutputRoutesAsStart() async {
        let entry: [String: Any] = [
            "raw": "shell · running",
            "type": "tool_exec",
            "toolName": "shell",
            "toolInput": ["command": "sleep 30"],
            "toolOutput": NSNull(),  // explicit JSON null
            "status": "running",
        ]
        let routed = DaemonServer.gatewayToolHookFromEntry(entry)
        XCTAssertEqual(routed.event, "tool_start",
            "NSNull toolOutput must be treated as absent, not as real output")
        XCTAssertNil(routed.data["tool_response"],
            "NSNull must not leak into the APME payload as `tool_response: null`")
    }

    /// Defensive: explicit-null `toolInput` should also be dropped (not
    /// stored as NSNull in the payload). Cleaner downstream payload
    /// inspection + matches the firstJSONValue contract end-to-end.
    func testGatewayToolExplicitNullToolInputDroppedFromPayload() async {
        let entry: [String: Any] = [
            "raw": "shell · running",
            "type": "tool_exec",
            "toolName": "shell",
            "toolInput": NSNull(),
            "status": "running",
        ]
        let routed = DaemonServer.gatewayToolHookFromEntry(entry)
        XCTAssertEqual(routed.event, "tool_start")
        XCTAssertNil(routed.data["tool_input"],
            "NSNull tool_input must not be serialized into the hook data")
    }

    // MARK: - Gateway tool hook: real tool name + input/output (Codex review #5)

    /// Gateway (OpenClaw) tool events arrive via DaemonServer's
    /// `gateway_timeline_entry` handler, which used to wire only the
    /// placeholder `entry["raw"]` (e.g. "tool · running") into the APME
    /// hook — leaving sqlite `steps.tool_name = "tool"` and an empty
    /// `payload` for every Gateway tool call. The new contract is:
    /// OpenClawAdapter emits `toolName`/`toolInput`/`toolOutput` as
    /// out-of-band keys, the handler maps them to a Claude-Code-shaped
    /// hook payload (`tool_name`/`tool_input`/`tool_response`), and
    /// ApmeCollector.recordStep persists them through the `payload`
    /// JSON blob.
    ///
    /// This test drives the collector directly with the new payload
    /// shape — covering the contract the DaemonServer hand-off has to
    /// produce, without needing the full Gateway/WS infrastructure.
    func testGatewayToolHookStoresRealNameAndStructuredInput() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        collector.idleGapMinTurnAgeSec = 0
        // Mirror the production hand-off exactly: DaemonServer opens the
        // gateway run with session_id "openclaw-gateway" on connect and
        // stamps the same id on every synthesized prompt/tool payload
        // (connectGatewayAdapter / handleGatewayEvent). The per-session
        // collector drops events for sessions it never opened — attributing
        // them to "whichever session is active" was the cross-session
        // contamination this refactor removes.
        collector.handleHook(event: "session_start", data: [
            "session_id": "openclaw-gateway",
            "agent_type": "openclaw",
            "project_name": "OpenClaw",
        ])

        collector.handleHook(event: "UserPromptSubmit", data: [
            "session_id": "openclaw-gateway",
            "prompt": "summarize repo",
        ])

        // Realistic OpenClaw tool_start payload after the fix: real
        // tool name + structured input dict (mirrors Claude Code's
        // PreToolUse hook shape).
        collector.handleHook(event: "tool_start", data: [
            "session_id": "openclaw-gateway",
            "tool_name": "shell",
            "tool_input": ["command": "ls -la"],
            "status": "running",
        ])

        // tool_end follow-up with output payload.
        collector.handleHook(event: "tool_end", data: [
            "session_id": "openclaw-gateway",
            "tool_name": "shell",
            "tool_input": ["command": "ls -la"],
            "tool_response": "total 0\ndrwxr-xr-x...",
            "status": "complete",
        ])

        guard let run = tmp.store.listRuns().first else { return XCTFail("no run") }
        let steps = tmp.store.listSteps(runId: run.id)

        // The tool_start + tool_end rows must carry the real tool name.
        let toolSteps = steps.filter { ($0.kind == "tool_start" || $0.kind == "tool_end") }
        XCTAssertGreaterThanOrEqual(toolSteps.count, 2, "both tool_start and tool_end should be persisted")
        XCTAssertTrue(toolSteps.allSatisfy { $0.toolName == "shell" }, "real tool name (not 'tool' placeholder) must reach steps.tool_name")

        // Payload column should carry the structured input/output so
        // downstream rubric / replay can reconstruct what the agent did.
        let payloads = toolSteps.map(\.payload)
        XCTAssertTrue(
            payloads.contains(where: { $0.contains("\"command\":\"ls -la\"") }),
            "tool_input dict must be serialized into the steps.payload JSON"
        )
        XCTAssertTrue(
            payloads.contains(where: { $0.contains("\"tool_response\"") }),
            "tool_response should be persisted on the tool_end step"
        )
    }

    /// The handler must also tolerate the legacy `raw` placeholder shape
    /// (entries pre-dating the structured-extras change). The DaemonServer
    /// branch splits on " · " — this test exercises ApmeCollector with the
    /// pre-split name so the contract on its side is documented even
    /// though the splitting itself lives in DaemonServer.
    func testToolNameNotTreatedAsTodoWriteUnlessExact() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        collector.idleGapMinTurnAgeSec = 0
        openSessionAndRun(collector)

        var emitted: [DaemonTimelineEntry] = []
        collector.emitTimelineEntry = { emitted.append($0) }

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "tool race"])
        // A tool_start whose name happens to be the substring "tool · …"
        // must NOT be mis-detected as TodoWrite (which would promote the
        // task to the visible timeline). Guards regression: previously
        // tool_name="tool" never matched "TodoWrite", but the substring
        // could have ambiguous future fall-through.
        collector.handleHook(event: "PreToolUse", data: [
            "session_id": "openclaw-gateway",
            "tool_name": "tool · running",
        ])

        XCTAssertEqual(
            emitted.filter { $0.type == "task_start" }.count,
            0,
            "non-TodoWrite tool must not promote task to timeline"
        )
    }

    // MARK: - Per-session chat turn anchor tracker (lost-Stop resync / 2026-07-11)

    /// Normal turn: chat_start opens the turn, the Stop hook claims its
    /// anchor exactly once, and a duplicate/late Stop claims nothing —
    /// so it can't re-emit the previous turn's completion pair.
    func testTurnAnchorClaimOnceAndDuplicateStopSuppressed() async {
        var t = ChatTurnAnchorTracker()
        t.noteChatStart(sid: "s1", ts: 1000)
        XCTAssertEqual(t.claimOpenTurn(sid: "s1"), 1000)
        XCTAssertNil(t.claimOpenTurn(sid: "s1"), "duplicate Stop finds the turn closed")
    }

    /// THE regression the tracker replaces the FIFO queue for: turn 1's
    /// Stop hook is lost. Under FIFO, turn 2's Stop popped turn 1's
    /// orphaned head — a permanent off-by-one that mis-anchored every
    /// later chat_response (responses rendered standalone / merged into
    /// the wrong turn). The tracker re-syncs on every chat_start: the
    /// newest prompt supersedes the orphaned anchor, so turn 2's Stop
    /// claims turn 2's own ts.
    func testTurnAnchorLostStopResyncsOnNextChatStart() async {
        var t = ChatTurnAnchorTracker()
        t.noteChatStart(sid: "s1", ts: 1000) // turn 1 — its Stop never arrives
        t.noteChatStart(sid: "s1", ts: 5000) // turn 2 supersedes the orphan
        XCTAssertEqual(t.claimOpenTurn(sid: "s1"), 5000, "turn 2's Stop claims turn 2's anchor")
        XCTAssertNil(t.claimOpenTurn(sid: "s1"), "orphaned turn 1 anchor is gone, not queued")
    }

    /// Node daemon parity trade-off, documented on purpose: when a
    /// follow-up chat_start genuinely lands before the previous turn's
    /// Stop, that Stop claims the NEWER turn's anchor (the Node
    /// backscan does the same — most recent chat_start newer than the
    /// last completion IS the open turn) and the second Stop finds the
    /// turn closed. Accepted because hook-observed turns are serial per
    /// session and lost Stops vastly outnumber true interleaves.
    func testTurnAnchorFollowupSupersedesPendingAnchor() async {
        var t = ChatTurnAnchorTracker()
        t.noteChatStart(sid: "s1", ts: 1000) // turn 1
        t.noteChatStart(sid: "s1", ts: 5000) // turn 2 before turn 1's Stop
        XCTAssertEqual(t.claimOpenTurn(sid: "s1"), 5000)
        XCTAssertNil(t.claimOpenTurn(sid: "s1"))
    }

    /// Anchors are independent per sessionId — a multi-agent dashboard
    /// (Claude + Codex running in parallel) must not cross-stamp.
    func testTurnAnchorIsolatedAcrossSessions() async {
        var t = ChatTurnAnchorTracker()
        t.noteChatStart(sid: "claude", ts: 10)
        t.noteChatStart(sid: "codex", ts: 99)
        XCTAssertEqual(t.claimOpenTurn(sid: "codex"), 99)
        XCTAssertEqual(t.claimOpenTurn(sid: "claude"), 10)
    }

    // MARK: - chat_response startedAt anchor fallback (2026-07-13)
    //
    // The timeline data audit found 42% of Swift chat_response rows shipped
    // `startedAt = nil` — a duplicate/late Stop claimed nil even though the
    // turn's chat_start was still on the timeline, so the answer rendered
    // orphaned ("답변만 튀어나옴"). `lastChatStart` survives the claim and backs
    // the emit-path fallback `claimOpenTurn(sid) ?? lastChatStart(sid)`.

    /// `lastChatStart` retains the anchor across a claim, so a second (late/
    /// duplicate) Stop can still anchor its response to the turn's chat_start.
    func testTurnAnchorLastChatStartSurvivesClaim() async {
        var t = ChatTurnAnchorTracker()
        t.noteChatStart(sid: "s1", ts: 1000)
        XCTAssertEqual(t.claimOpenTurn(sid: "s1"), 1000)
        XCTAssertNil(t.claimOpenTurn(sid: "s1"), "open turn consumed")
        XCTAssertEqual(t.lastChatStart(sid: "s1"), 1000,
                       "anchor fallback survives the claim so a late response isn't orphaned")
    }

    /// The fallback tracks the MOST RECENT chat_start — a fresh prompt updates
    /// it, so a claimed-nil response anchors to the current turn, not a stale one.
    func testTurnAnchorLastChatStartTracksNewestPrompt() async {
        var t = ChatTurnAnchorTracker()
        t.noteChatStart(sid: "s1", ts: 1000)
        _ = t.claimOpenTurn(sid: "s1")
        t.noteChatStart(sid: "s1", ts: 5000)
        XCTAssertEqual(t.lastChatStart(sid: "s1"), 5000)
    }

    /// No chat_start seen yet → nil (a genuinely anchorless observed response
    /// stays null; there is no turn to pair with).
    func testTurnAnchorLastChatStartNilBeforeAnyPrompt() async {
        let t = ChatTurnAnchorTracker()
        XCTAssertNil(t.lastChatStart(sid: "s1"))
    }

    /// `clear` (session_end / eviction) drops the fallback too — a post-close
    /// response must not anchor to a pre-session_end prompt.
    func testTurnAnchorLastChatStartClearedOnSessionEnd() async {
        var t = ChatTurnAnchorTracker()
        t.noteChatStart(sid: "s1", ts: 1000)
        t.clear(sid: "s1")
        XCTAssertNil(t.lastChatStart(sid: "s1"))
        XCTAssertNil(t.claimOpenTurn(sid: "s1"))
    }

    /// `peekOpenTurn` is for mid-turn rows (tool_exec) that stamp the
    /// turn currently generating without consuming the anchor the Stop
    /// hook owns — and it goes nil once the Stop claims the turn, so a
    /// straggler tool event can't anchor to a closed turn.
    func testTurnAnchorPeekNonConsumingAndClosedAfterClaim() async {
        var t = ChatTurnAnchorTracker()
        t.noteChatStart(sid: "s1", ts: 1000)
        XCTAssertEqual(t.peekOpenTurn(sid: "s1"), 1000)
        XCTAssertEqual(t.peekOpenTurn(sid: "s1"), 1000, "peek is idempotent")
        XCTAssertTrue(t.hasOpenTurn(sid: "s1"))
        XCTAssertEqual(t.claimOpenTurn(sid: "s1"), 1000)
        XCTAssertNil(t.peekOpenTurn(sid: "s1"))
        XCTAssertFalse(t.hasOpenTurn(sid: "s1"))
    }

    /// No TTL: the old queue expired entries after 10 minutes, so a
    /// legitimately long agentic turn (>10 min of tools/thinking) lost
    /// its anchor and the response rendered standalone. The tracker is
    /// clock-free — an anchor stays claimable until its Stop arrives or
    /// a newer prompt supersedes it.
    func testTurnAnchorHasNoTTL() async {
        var t = ChatTurnAnchorTracker()
        t.noteChatStart(sid: "s1", ts: 1) // arbitrarily old wall-ms value
        XCTAssertEqual(t.claimOpenTurn(sid: "s1"), 1)
    }

    /// Empty/unknown-session access must not crash, and `clear` drops
    /// the open turn (session_end / stale-eviction path).
    func testTurnAnchorEmptyAccessSafeAndClear() async {
        var t = ChatTurnAnchorTracker()
        XCTAssertNil(t.claimOpenTurn(sid: "unknown"))
        XCTAssertNil(t.peekOpenTurn(sid: "unknown"))
        XCTAssertFalse(t.hasOpenTurn(sid: "unknown"))
        t.clear(sid: "unknown") // no-op

        t.noteChatStart(sid: "s1", ts: 1000)
        t.clear(sid: "s1")
        XCTAssertNil(t.claimOpenTurn(sid: "s1"))

        // Re-note after a claim/clear reopens cleanly.
        t.noteChatStart(sid: "s1", ts: 2000)
        XCTAssertEqual(t.claimOpenTurn(sid: "s1"), 2000)
    }

    // MARK: - updateRun outcome round-trip (Codex review #6 / 2026-05-16)

    /// Regression for the silent-drop bug in `ApmeStore.updateRun`'s
    /// column map. The map gates which Swift keys are bound to UPDATE
    /// SET clauses; any key missing from the map is `continue`d past
    /// without an error, so `evaluateOutcome → updateRun(... outcome ...)`
    /// previously turned into an empty UPDATE and the same 6 closed runs
    /// got re-evaluated every `apmeEvalTick` (30 s) forever — surfaced
    /// in production as "outcome 2B5A8489: abandoned(medium)" repeating
    /// 217× in the daemon log across a single 5000-line window.
    ///
    /// This test writes the four outcome fields directly through
    /// `updateRun` and verifies that `getRun` reads them back. If a
    /// future column is added to `runs` and someone forgets to extend
    /// the colMap, this assertion fails immediately instead of silently
    /// shipping a re-eval cycle into production.
    func testUpdateRunPersistsOutcomeFields() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let store = tmp.store

        let runId = UUID().uuidString
        store.insertRun(ApmeRun(
            id: runId, sessionId: "s1", agentType: "claude-code",
            modelId: nil, projectName: nil, projectPath: nil,
            taskPrompt: nil, startedAt: 1, endedAt: 100
        ))

        // Mirror the exact field set that ApmeOutcomeEngine.evaluateOutcome
        // hands to updateRun.
        store.updateRun(id: runId, fields: [
            "outcome": "committed",
            "outcomeConfidence": "high",
            "efficiencyJson": #"{"response_kind":"text","duration_ms":4200}"#,
            "compositeScore": 0.72,
        ])

        guard let run = store.getRun(id: runId) else { return XCTFail("run missing") }
        XCTAssertEqual(run.outcome, "committed", "outcome must round-trip through updateRun")
        XCTAssertEqual(run.outcomeConfidence, "high", "outcomeConfidence must round-trip")
        XCTAssertEqual(run.compositeScore ?? .nan, 0.72, accuracy: 0.0001)
        XCTAssertTrue(
            run.efficiencyJson?.contains("\"duration_ms\":4200") ?? false,
            "efficiencyJson body must survive UPDATE/SELECT"
        )
    }

    // MARK: - Concurrent sessions (per-session task isolation)

    /// Regression for cross-session taskId contamination: the collector used
    /// to hold ONE activeTask scalar for the whole daemon, so with two
    /// concurrent sessions every timeline stamp copied whichever session
    /// most recently opened a task — nesting unrelated Codex/Claude turns
    /// under one TASK header. Per-session maps must keep runs, tasks, and
    /// turn counts fully isolated.
    func testConcurrentSessionsKeepIsolatedTasks() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        var emitted: [DaemonTimelineEntry] = []
        collector.emitTimelineEntry = { emitted.append($0) }

        collector.handleHook(event: "session_start", data: [
            "session_id": "sess-A", "agent_type": "claude-code", "project_name": "projA",
        ])
        collector.handleHook(event: "session_start", data: [
            "session_id": "sess-B", "agent_type": "claude-code", "project_name": "projB",
        ])

        // Interleaved prompts: A, B, A — B's prompt must not rotate A's task.
        collector.handleHook(event: "UserPromptSubmit", data: ["session_id": "sess-A", "prompt": "A first"])
        collector.handleHook(event: "UserPromptSubmit", data: ["session_id": "sess-B", "prompt": "B first"])
        collector.handleHook(event: "UserPromptSubmit", data: ["session_id": "sess-A", "prompt": "A second"])

        let taskA = collector.activeTaskId(sessionId: "sess-A")
        let taskB = collector.activeTaskId(sessionId: "sess-B")
        XCTAssertNotNil(taskA)
        XCTAssertNotNil(taskB)
        XCTAssertNotEqual(taskA, taskB, "concurrent sessions must own distinct tasks")

        // Each session got its own run, keyed by the REAL session id — this
        // is what lets task_start/task_end rows survive the dashboard's
        // per-session filter.
        let runs = tmp.store.listRuns()
        let runA = runs.first { $0.sessionId == "sess-A" }
        let runB = runs.first { $0.sessionId == "sess-B" }
        XCTAssertNotNil(runA)
        XCTAssertNotNil(runB)

        // A reached its second turn → exactly one promoted header, carrying
        // A's session id and A's taskId (not B's).
        let starts = emitted.filter { $0.type == "task_start" }
        XCTAssertEqual(starts.count, 1, "only session A reached its second turn")
        XCTAssertEqual(starts.first?.sessionId, "sess-A")
        XCTAssertEqual(starts.first?.taskId, taskA)

        // Turn counts stay per-session: A=2, B=1.
        XCTAssertEqual(tmp.store.listTurns(runId: runA!.id).count, 2)
        XCTAssertEqual(tmp.store.listTurns(runId: runB!.id).count, 1)
    }

    /// `setTurnResponse(sessionId:)` must land the response on THAT
    /// session's open turn even when another session prompted afterwards
    /// (i.e. the response target is not the most recently active session).
    func testSetTurnResponseRoutesBySessionId() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)

        collector.handleHook(event: "session_start", data: [
            "session_id": "sess-A", "agent_type": "claude-code",
        ])
        collector.handleHook(event: "session_start", data: [
            "session_id": "sess-B", "agent_type": "claude-code",
        ])
        collector.handleHook(event: "UserPromptSubmit", data: ["session_id": "sess-A", "prompt": "A question"])
        collector.handleHook(event: "UserPromptSubmit", data: ["session_id": "sess-B", "prompt": "B question"])

        // A's response arrives AFTER B prompted — the sessionless legacy
        // fallback would have written it onto B's turn.
        _ = collector.setTurnResponse("A answer", sessionId: "sess-A")

        let runs = tmp.store.listRuns()
        guard let runA = runs.first(where: { $0.sessionId == "sess-A" }),
              let runB = runs.first(where: { $0.sessionId == "sess-B" }) else {
            return XCTFail("runs missing")
        }
        let turnA = tmp.store.listTurns(runId: runA.id).first
        let turnB = tmp.store.listTurns(runId: runB.id).first
        XCTAssertEqual(turnA?["response"] as? String, "A answer")
        XCTAssertNil(turnB?["response"] as? String, "B's turn must stay untouched")
    }

    /// session_end for one session must not tear down the other session's
    /// task (the single-activeHookSession design attributed a session_end
    /// to whichever session started most recently).
    func testSessionEndClosesOnlyItsOwnTask() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)

        collector.handleHook(event: "session_start", data: [
            "session_id": "sess-A", "agent_type": "claude-code",
        ])
        collector.handleHook(event: "session_start", data: [
            "session_id": "sess-B", "agent_type": "claude-code",
        ])
        collector.handleHook(event: "UserPromptSubmit", data: ["session_id": "sess-A", "prompt": "A work"])
        collector.handleHook(event: "UserPromptSubmit", data: ["session_id": "sess-B", "prompt": "B work"])

        collector.handleHook(event: "session_end", data: ["session_id": "sess-A"])

        XCTAssertNil(collector.activeTaskId(sessionId: "sess-A"), "A's task closed with its session")
        XCTAssertNotNil(collector.activeTaskId(sessionId: "sess-B"), "B's task survives A's session_end")
    }

    // MARK: - task_rollup rubric seeded

    func testTaskRollupRubricSeededOnOpen() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let store = tmp.store
        let rubric = store.getCurrentRubric(purpose: "task_rollup")
        XCTAssertNotNil(rubric, "task_rollup rubric should be seeded")
        if let prompt = rubric?["prompt"] as? String {
            XCTAssertTrue(prompt.contains("completion"), "rubric covers completion axis")
            XCTAssertTrue(prompt.contains("summary"), "rubric asks for summary")
        }
    }
}
#endif
