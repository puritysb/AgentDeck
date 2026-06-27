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

@MainActor
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

    func testAllTodosCompleted_trueWhenEveryStatusIsCompleted() {
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

    func testAllTodosCompleted_falseWhenAnyTodoIsInProgress() {
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

    func testAllTodosCompleted_falseWhenTodosMissingOrEmpty() {
        XCTAssertFalse(ApmeCollector.allTodosCompleted(data: [:]))
        XCTAssertFalse(ApmeCollector.allTodosCompleted(data: [
            "tool_input": ["todos": []],
        ]))
    }

    // MARK: - Task lifecycle through handleHook

    func testFirstUserPromptOpensTaskAndAttachesTurn() throws {
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

    func testTodoWriteAllCompletedRecordsSoftHintWithoutClosingTask() throws {
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

    func testTodoWritePartialDoesNotCloseTask() throws {
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

    func testSecondUserPromptAfterTodoCompleteStaysInSameTask() throws {
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

    func testSessionEndClosesActiveTaskWithSessionEndBoundary() throws {
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

    func testParseJudgeJsonExtractsSummaryAndScores() {
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

    func testParseJudgeJsonSummaryIsOptional() {
        // No summary field — the existing turn/run eval path must still parse.
        let raw = #"{"overall": 0.5, "reasoning": ""}"#
        guard let parsed = ApmeRunner.parseJudgeJson(raw) else {
            return XCTFail("parseJudgeJson returned nil")
        }
        XCTAssertNil(parsed.summary)
        XCTAssertEqual(parsed.scores["overall"] ?? -1, 0.5, accuracy: 0.001)
    }

    func testParseJudgeJsonSummaryClippedTo280() {
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
    func testSingleTurnDoesNotEmitTaskStartToTimeline() throws {
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
    func testSecondTurnEmitsDeferredTaskStart() throws {
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
    func testTodoWriteTriggersImmediateTaskStartEmit() throws {
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
    func testPromotedTaskEmitsTaskEndOnClose() throws {
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
    func testSetTurnResponseAttributesToActiveTurnWhenChatEndIsCurrent() {
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
    func testGatewayToolRunningWithInputRoutesAsStart() {
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
    func testGatewayToolCompleteWithOutputRoutesAsEnd() {
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
    func testGatewayToolErrorStatusRoutesAsEnd() {
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
    func testGatewayToolOutputWithoutStatusRoutesAsEnd() {
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
    func testGatewayToolLegacyRawSplitsAndRoutesAsStart() {
        let entry: [String: Any] = [
            "raw": "shell · running",
            "type": "tool_exec",
        ]
        let routed = DaemonServer.gatewayToolHookFromEntry(entry)
        XCTAssertEqual(routed.data["tool_name"] as? String, "shell", "split on ' · ' to recover legacy name")
        XCTAssertEqual(routed.event, "tool_start")
    }

    /// No status, no toolOutput → start (default — tool is still in flight).
    func testGatewayToolNoStatusRoutesAsStart() {
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
    func testGatewayToolExplicitNullToolOutputRoutesAsStart() {
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
    func testGatewayToolExplicitNullToolInputDroppedFromPayload() {
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
    func testGatewayToolHookStoresRealNameAndStructuredInput() throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let collector = ApmeCollector(store: tmp.store)
        collector.idleGapMinTurnAgeSec = 0
        openSessionAndRun(collector)

        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "summarize repo"])

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
    func testToolNameNotTreatedAsTodoWriteUnlessExact() throws {
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

    // MARK: - Per-session chat_start ts FIFO queue (Codex review #8 / 2026-05-17)

    /// The race shape Codex #8 surfaced: a fast follow-up chat_start
    /// overwrote the single per-session ts slot before the (delayed)
    /// Stop hook for the previous turn could stamp its anchor. The
    /// FIFO queue replaces the single slot — append on chat_start,
    /// pop-first on chat_end — so a delayed Stop reads the right ts.
    func testChatStartTsQueueFIFO() {
        var q = ChatStartTsQueue()
        q.enqueue(sid: "s1", ts: 10)
        q.enqueue(sid: "s1", ts: 20)
        q.enqueue(sid: "s1", ts: 30)
        XCTAssertEqual(q.dequeue(sid: "s1"), 10)
        XCTAssertEqual(q.dequeue(sid: "s1"), 20)
        XCTAssertEqual(q.dequeue(sid: "s1"), 30)
        XCTAssertNil(q.dequeue(sid: "s1"))
    }

    /// Core Codex #8 regression: follow-up chat_start must NOT shadow
    /// the pending first turn's anchor.
    func testChatStartTsQueueFollowupDoesNotShadowFirstPending() {
        var q = ChatStartTsQueue()
        q.enqueue(sid: "s1", ts: 100) // Q1
        q.enqueue(sid: "s1", ts: 200) // Q2 follow-up before Q1's Stop hook
        XCTAssertEqual(q.dequeue(sid: "s1"), 100, "Q1's delayed Stop reads Q1's anchor")
        XCTAssertEqual(q.dequeue(sid: "s1"), 200, "Q2's Stop reads Q2's anchor")
    }

    /// Queues are independent per sessionId — a multi-agent dashboard
    /// (Claude + OpenClaw running in parallel) must not cross-stamp.
    func testChatStartTsQueueIsolatedAcrossSessions() {
        var q = ChatStartTsQueue()
        q.enqueue(sid: "claude", ts: 10)
        q.enqueue(sid: "codex", ts: 99)
        XCTAssertEqual(q.dequeue(sid: "codex"), 99)
        XCTAssertEqual(q.dequeue(sid: "claude"), 10)
    }

    /// `peek` is for mid-turn rows (tool_exec, Codex chat_start upsert)
    /// that need to stamp the active turn's anchor without consuming
    /// the queue slot that the Stop hook owns.
    func testChatStartTsQueuePeekIsNonConsuming() {
        var q = ChatStartTsQueue()
        q.enqueue(sid: "s1", ts: 10)
        q.enqueue(sid: "s1", ts: 20)
        XCTAssertEqual(q.peek(sid: "s1"), 10)
        XCTAssertEqual(q.peek(sid: "s1"), 10, "peek is idempotent")
        XCTAssertEqual(q.depth(sid: "s1"), 2)
        _ = q.dequeue(sid: "s1")
        XCTAssertEqual(q.peek(sid: "s1"), 20)
    }

    /// Empty queue mutators / accessors must not crash.
    func testChatStartTsQueueEmptyAccessSafe() {
        var q = ChatStartTsQueue()
        XCTAssertNil(q.dequeue(sid: "unknown"))
        XCTAssertNil(q.peek(sid: "unknown"))
        XCTAssertEqual(q.depth(sid: "unknown"), 0)
        q.clear(sid: "unknown") // no-op
    }

    /// Drained queues must release their dict slot so a long-lived
    /// session doesn't bloat the backing storage indefinitely.
    func testChatStartTsQueueDrainedSlotRecoverable() {
        var q = ChatStartTsQueue()
        q.enqueue(sid: "s1", ts: 10)
        _ = q.dequeue(sid: "s1")
        XCTAssertEqual(q.depth(sid: "s1"), 0)
        q.enqueue(sid: "s1", ts: 30)
        XCTAssertEqual(q.peek(sid: "s1"), 30, "re-enqueue after drain works")
    }

    /// Codex stop-time review #10 (2026-05-17): mid-turn rows (tool_exec
    /// etc.) must anchor to the **currently active** turn, not the
    /// oldest pending one. `peek` returns the FIFO head (oldest), which
    /// is correct for "which Stop hook is up next" but wrong for "which
    /// turn is the agent generating against right now". `peekTail`
    /// returns the most recently enqueued ts — that's the active turn.
    /// Without this distinction, a Q2 tool_exec stamped Q1's ts and
    /// attached to the previous turn's row.
    func testChatStartTsQueuePeekTailReturnsLatestEnqueued() {
        var q = ChatStartTsQueue()
        q.enqueue(sid: "s1", ts: 1000)  // Q1
        q.enqueue(sid: "s1", ts: 5000)  // Q2 follow-up
        XCTAssertEqual(q.peek(sid: "s1"), 1000, "head = oldest (FIFO for Stop hooks)")
        XCTAssertEqual(q.peekTail(sid: "s1"), 5000, "tail = currently active turn (for mid-turn stamps)")

        // After Q1's Stop hook drains the head, the tail should now
        // also point to Q2 (single remaining slot).
        _ = q.dequeue(sid: "s1")
        XCTAssertEqual(q.peek(sid: "s1"), 5000)
        XCTAssertEqual(q.peekTail(sid: "s1"), 5000)
    }

    /// peekTail on an empty queue is nil — same as peek.
    func testChatStartTsQueuePeekTailEmptySafe() {
        let q = ChatStartTsQueue()
        XCTAssertNil(q.peekTail(sid: "anything"))
    }

    /// Codex stop-time review #9 (2026-05-17): when a follow-up
    /// chat_start arrives before the previous turn's Stop hook drains
    /// the queue, the new enqueue must NOT mutate the existing head —
    /// it appends, leaving Q1's anchor intact for Q1's Stop hook to
    /// claim and stamping the fresh row with Q2's own ts. Previously
    /// `appendCodexChatStart`'s upsert branch peeked the head and
    /// overwrote that row's text with the new prompt; the queue itself
    /// is what guarantees that even with the upsert removed, the head
    /// remains addressable as Q1.
    func testChatStartTsQueueFollowupEnqueueLeavesHeadUntouched() {
        var q = ChatStartTsQueue()
        q.enqueue(sid: "s1", ts: 1000) // Q1 — emits chat_start row at ts=1000
        XCTAssertEqual(q.peek(sid: "s1"), 1000)

        // Q2's prompt arrives before Q1's Stop hook. The new enqueue
        // appends; the head MUST still be Q1's ts. A regression where
        // a fresh prompt overwrote the head (the bug Codex flagged in
        // `appendCodexChatStart`) would fail this assertion.
        q.enqueue(sid: "s1", ts: 5000) // Q2
        XCTAssertEqual(q.peek(sid: "s1"), 1000, "Q2 enqueue must not shift the head")
        XCTAssertEqual(q.depth(sid: "s1"), 2, "both pending turns coexist")

        // FIFO order on drain: Q1's Stop hook claims 1000, then Q2's.
        XCTAssertEqual(q.dequeue(sid: "s1"), 1000)
        XCTAssertEqual(q.dequeue(sid: "s1"), 5000)
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
    func testUpdateRunPersistsOutcomeFields() throws {
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

    // MARK: - task_rollup rubric seeded

    func testTaskRollupRubricSeededOnOpen() throws {
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
