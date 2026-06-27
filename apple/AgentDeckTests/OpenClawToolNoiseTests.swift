// OpenClawToolNoiseTests.swift — regression guard for two related bugs:
//
// 1) OpenClaw Gateway tool rows arriving on `session.tool` events with no
//    upstream tool name and no input/output were emitted as placeholder
//    rows ("tool · running" / "tool · complete") that pushed real timeline
//    rows off the visible window. The producer guard
//    (`OpenClawAdapter.isPlaceholderOnlySessionTool`) drops those at source.
//    The display-side filter (`DaemonTimelineStore.shouldDropLowSignalEntry`,
//    `timelineIsLowSignalEntry`) catches legacy placeholders that were
//    persisted to disk before the producer fix.
//
// 2) A `task_start` whose matching `task_end` was lost (daemon force-quit,
//    closeTask early-return, hook delivery race) left the dashboard
//    spinning its leading task icon forever. The UI staleness guard
//    (`timelineIsInFlightTask`) treats > 10 min orphans as resolved, and the
//    daemon-side orphan reaper (`DaemonServer.computeOrphanTaskEnds`)
//    upserts a synthetic `Interrupted` task_end on startup.
//
// Tests run on macOS only — the daemon code path is macOS-only.

#if os(macOS)
import XCTest
@testable import AgentDeck

@MainActor
final class OpenClawToolNoiseTests: XCTestCase {

    // MARK: - Producer placeholder drop (OpenClawAdapter.isPlaceholderOnlySessionTool)

    /// Empty payload (no name, no input, no output) — the worst-case
    /// placeholder that would render as the literal "tool" raw text with
    /// nothing in the detail pane. Source-of-truth drop point.
    func testPlaceholderEmptyPayloadDropped() {
        let payload: [String: Any] = ["status": "running"]
        XCTAssertTrue(OpenClawAdapter.isPlaceholderOnlySessionTool(payload),
            "payload with no name/input/output must be dropped")
        XCTAssertNil(OpenClawAdapter.resolveToolName(payload))
    }

    /// Real tool with name only (no input/output yet — start of a tool that
    /// emits ack before arguments resolve) must NOT be dropped. The name
    /// alone carries enough signal for the user to see what's happening.
    func testRealToolNameWithoutIOIsKept() {
        let payload: [String: Any] = ["name": "shell", "status": "running"]
        XCTAssertFalse(OpenClawAdapter.isPlaceholderOnlySessionTool(payload))
        XCTAssertEqual(OpenClawAdapter.resolveToolName(payload), "shell")
    }

    /// No name but input present (e.g. arguments before adapter resolved
    /// the tool kind) — still carries signal, must be kept. Detail pane
    /// renders the input JSON which is informative even without a name.
    func testMissingNameWithInputIsKept() {
        let payload: [String: Any] = ["input": ["command": "ls"], "status": "running"]
        XCTAssertFalse(OpenClawAdapter.isPlaceholderOnlySessionTool(payload))
    }

    /// Defensive — JSON `null` arrives as `NSNull` in `[String: Any]`. The
    /// `??` chain alone treats `Optional.some(NSNull())` as set; the helper
    /// must unwrap NSNull as absent so an explicit-null name doesn't
    /// satisfy the "real tool" branch. Mirrors the Codex review #6 fix on
    /// the tool routing path (already covered there for output/input, this
    /// test extends the contract to the name field).
    func testExplicitNullNameAndIOIsDropped() {
        let payload: [String: Any] = [
            "name": NSNull(),
            "input": NSNull(),
            "output": NSNull(),
            "status": "running",
        ]
        XCTAssertTrue(OpenClawAdapter.isPlaceholderOnlySessionTool(payload),
            "all-NSNull payload counts as placeholder, not as 'has real name'")
        XCTAssertNil(OpenClawAdapter.resolveToolName(payload),
            "NSNull name must unwrap to nil, not Optional.some(NSNull())")
    }

    /// Nested fallback (some Gateway shapes wrap the tool descriptor under
    /// `message`/`item`/`call`). The resolver must reach into those before
    /// declaring placeholder.
    func testNestedNameIsResolved() {
        let payload: [String: Any] = [
            "message": ["name": "edit"],
        ]
        XCTAssertEqual(OpenClawAdapter.resolveToolName(payload), "edit")
        XCTAssertFalse(OpenClawAdapter.isPlaceholderOnlySessionTool(payload))
    }

    // MARK: - DaemonTimelineStore low-signal filter (legacy on-disk catch)

    /// OpenClaw placeholder rows persisted to timeline.json before the
    /// producer guard existed must be dropped on `add()` (and on load
    /// via the same predicate). raw="tool · running" with agentType
    /// "openclaw" hits the new branch.
    func testStoreFilterDropsOpenClawPlaceholderRaw() {
        let entry = DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: "tool_exec",
            raw: "tool · running",
            agentType: "openclaw"
        )
        XCTAssertTrue(DaemonTimelineStore.shouldDropLowSignalEntry(entry))
    }

    /// Negative case: real OpenClaw tool row (raw="shell · complete") must
    /// pass through. Catches overly-aggressive filter regressions.
    func testStoreFilterKeepsRealOpenClawTool() {
        let entry = DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: "tool_exec",
            raw: "shell · complete",
            agentType: "openclaw"
        )
        XCTAssertFalse(DaemonTimelineStore.shouldDropLowSignalEntry(entry))
    }

    /// Negative case: existing Codex OTel filter still works (regression
    /// guard against the refactor that split codex/openclaw branches).
    func testStoreFilterStillDropsCodexOtelPlaceholder() {
        let entry = DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: "tool_exec",
            raw: "tool",
            agentType: "codex-cli",
            sessionId: "codex:otel-active"
        )
        XCTAssertTrue(DaemonTimelineStore.shouldDropLowSignalEntry(entry))
    }

    func testStoreNormalizesOpenClawCronPromptDump() {
        let prompt = "[cron:abc self-improvement-daily-review-2350] 입력 수집:\n1. ls -lt 사용\n2. tail -50 사용"
        let entry = DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: "model_call",
            raw: prompt,
            detail: prompt,
            agentType: "openclaw",
            automated: true
        )

        let normalized = DaemonTimelineStore.normalizeForStorage(entry)
        XCTAssertEqual(normalized?.raw, "자동 작업 · self improvement daily review 2350")
        XCTAssertNil(normalized?.detail)
        XCTAssertEqual(normalized?.automated, true)
        XCTAssertEqual(normalized?.summaryKind, "heuristic")
    }

    /// Producer guard keeps unnamed-tool rows when input/output is present
    /// — `toolName` falls back to `"tool"` placeholder, but the JSON
    /// gets compacted into `detail`. The filter must NOT drop these
    /// because the detail pane is exactly what makes the row useful.
    /// Codex stop-time review 2026-05-18 caught the original filter
    /// stripping these out alongside the truly-empty placeholders.
    func testStoreFilterKeepsOpenClawPlaceholderRawWithDetail() {
        let entry = DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: "tool_exec",
            raw: "tool · running",
            detail: "status: running\ninput: {\"command\":\"ls -la\"}",
            agentType: "openclaw"
        )
        XCTAssertFalse(DaemonTimelineStore.shouldDropLowSignalEntry(entry),
            "unnamed-tool rows with input/output in detail must survive — they carry signal even with a placeholder raw")
    }

    /// Codex tool_exec rows stay out of the user-facing daemon timeline even
    /// when detail carries signal. APME ingests the tool trajectory separately;
    /// the dashboard timeline keeps Codex chat/task lifecycle rows only.
    func testStoreFilterDropsCodexPlaceholderRawEvenWithDetail() {
        let entry = DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: "tool_exec",
            raw: "tool",
            detail: "trace span id: abc123\nargs: {\"foo\":1}",
            agentType: "codex-cli",
            sessionId: "codex:otel-active"
        )
        XCTAssertTrue(DaemonTimelineStore.shouldDropLowSignalEntry(entry),
            "Codex tool_exec rows are hidden from the daemon timeline even when detail carries signal")
    }

    /// Codex stop-time review 2026-05-18 (second round): detail="status: running"
    /// alone (no input/output line) is still placeholder noise — just an
    /// ack of state with no tool/payload to show. Earlier looser
    /// detail-gate accepted any non-empty detail and let these bypass.
    /// Producer no longer emits this case (drop guard fires on
    /// name+input+output all absent), but legacy on-disk entries can have
    /// it.
    func testStoreFilterDropsOpenClawPlaceholderRawWithStatusOnlyDetail() {
        let entry = DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: "tool_exec",
            raw: "tool · running",
            detail: "status: running",
            agentType: "openclaw"
        )
        XCTAssertTrue(DaemonTimelineStore.shouldDropLowSignalEntry(entry),
            "status-only detail (no input/output) is still placeholder noise — bypass must be closed")
    }

    /// Multiple status lines, still no `input:` / `output:` → still drop.
    /// Guards the line-by-line predicate against the trivial "any
    /// newline counts as signal" shortcut.
    func testStoreFilterDropsOpenClawPlaceholderRawWithMultilineStatusOnly() {
        let entry = DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: "tool_exec",
            raw: "tool · complete",
            detail: "status: running\nstatus: complete",  // status transitions only
            agentType: "openclaw"
        )
        XCTAssertTrue(DaemonTimelineStore.shouldDropLowSignalEntry(entry),
            "multiline detail consisting only of status lines is still placeholder noise")
    }

    /// Codex stop-time review 2026-05-18 (third round): the original
    /// enumerated set ["tool · running", "tool · complete", "tool ·
    /// pending", "tool · error"] missed `failed` (and would miss any
    /// future status Gateway upstream adds, since `SessionToolPayload.
    /// status` is free-form string). Structural matcher catches all of
    /// them.
    func testIsOpenClawPlaceholderRawCoversArbitraryStatus() {
        XCTAssertTrue(DaemonTimelineStore.isOpenClawPlaceholderRaw("tool"))
        XCTAssertTrue(DaemonTimelineStore.isOpenClawPlaceholderRaw("tool · running"))
        XCTAssertTrue(DaemonTimelineStore.isOpenClawPlaceholderRaw("tool · complete"))
        XCTAssertTrue(DaemonTimelineStore.isOpenClawPlaceholderRaw("tool · pending"))
        XCTAssertTrue(DaemonTimelineStore.isOpenClawPlaceholderRaw("tool · error"))
        XCTAssertTrue(DaemonTimelineStore.isOpenClawPlaceholderRaw("tool · failed"),
            "Codex stop-time #3: `failed` must drop — enumerated set used to miss it")
        XCTAssertTrue(DaemonTimelineStore.isOpenClawPlaceholderRaw("tool · aborted"))
        XCTAssertTrue(DaemonTimelineStore.isOpenClawPlaceholderRaw("tool · canceled"))
        XCTAssertTrue(DaemonTimelineStore.isOpenClawPlaceholderRaw("tool · whatever_new_status"),
            "future status values must drop without code change")

        // Negative cases — real tool names with the same `· status`
        // suffix template must NOT match the placeholder predicate.
        XCTAssertFalse(DaemonTimelineStore.isOpenClawPlaceholderRaw("shell · running"))
        XCTAssertFalse(DaemonTimelineStore.isOpenClawPlaceholderRaw("edit · complete"))
        XCTAssertFalse(DaemonTimelineStore.isOpenClawPlaceholderRaw("toolbox · running"),
            "prefix collision guard — must match the full word 'tool' + ' · ', not 'tool*'")
        XCTAssertFalse(DaemonTimelineStore.isOpenClawPlaceholderRaw(""))
        XCTAssertFalse(DaemonTimelineStore.isOpenClawPlaceholderRaw("tool ·"),
            "must require the space after `·` — placeholder is the consistent producer format")
    }

    /// End-to-end via the filter: `tool · failed` must drop (status-only
    /// detail), and a real-named tool with status="failed" must not.
    func testStoreFilterDropsOpenClawPlaceholderFailedStatus() {
        let entry = DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: "tool_exec",
            raw: "tool · failed",
            detail: "status: failed",
            agentType: "openclaw"
        )
        XCTAssertTrue(DaemonTimelineStore.shouldDropLowSignalEntry(entry),
            "Codex stop-time #3: status=failed placeholder must drop")
    }

    /// Direct test of the detail-gate predicate — pinning the
    /// status-only contract so future filter refactors don't loosen
    /// it back to "any non-empty detail counts as signal".
    func testDetailHasRealSignalPredicate() {
        XCTAssertFalse(DaemonTimelineStore.detailHasRealSignal(nil))
        XCTAssertFalse(DaemonTimelineStore.detailHasRealSignal(""))
        XCTAssertFalse(DaemonTimelineStore.detailHasRealSignal("   \n  "))
        XCTAssertFalse(DaemonTimelineStore.detailHasRealSignal("status: running"))
        XCTAssertFalse(DaemonTimelineStore.detailHasRealSignal("STATUS: complete"),
            "case-insensitive — Status:/STATUS: also count as ack-only")
        XCTAssertFalse(DaemonTimelineStore.detailHasRealSignal("status: running\nstatus: complete"))
        XCTAssertTrue(DaemonTimelineStore.detailHasRealSignal("input: {\"x\":1}"))
        XCTAssertTrue(DaemonTimelineStore.detailHasRealSignal("status: running\ninput: {\"x\":1}"))
        XCTAssertTrue(DaemonTimelineStore.detailHasRealSignal("output: done"))
        XCTAssertTrue(DaemonTimelineStore.detailHasRealSignal("freeform text without status prefix"),
            "any non-status line counts as signal — predicate is a no-status-only check, not an input/output whitelist")
    }

    // MARK: - timelineIsInFlightTask staleness guard

    /// Recent (< 10 min) task_start with no matching task_end → rotating.
    /// Baseline that the staleness guard must NOT break.
    func testInFlightTaskFreshIsRotating() {
        let nowMs = Date().timeIntervalSince1970 * 1000
        let start = TimelineEntry(
            ts: nowMs - 30_000,  // 30 s ago
            type: .taskStart,
            raw: "Task 1",
            taskId: "task-A"
        )
        XCTAssertTrue(timelineIsInFlightTask(start, siblings: [start]))
    }

    /// task_start older than 10 min with no matching task_end → NOT
    /// rotating. The daemon's orphan reaper would normally synthesize a
    /// pair on the next startup, but this UI guard kicks in before the
    /// reaper has run (or on dashboards detached from the live daemon).
    func testInFlightTaskStaleStopsRotating() {
        let nowMs = Date().timeIntervalSince1970 * 1000
        let start = TimelineEntry(
            ts: nowMs - (15 * 60 * 1000),  // 15 min ago — past the 10 min threshold
            type: .taskStart,
            raw: "Task 1",
            taskId: "task-stale"
        )
        XCTAssertFalse(timelineIsInFlightTask(start, siblings: [start]),
            "task_start older than 10 min with no pair must stop rotating")
    }

    /// Matching task_end in siblings → never rotating regardless of age.
    /// (Belt-and-suspenders with the existing pair check.)
    func testInFlightTaskWithPairIsNotRotating() {
        let nowMs = Date().timeIntervalSince1970 * 1000
        let start = TimelineEntry(
            ts: nowMs - 30_000,
            type: .taskStart,
            raw: "Task 1",
            taskId: "task-B"
        )
        let end = TimelineEntry(
            ts: nowMs - 5_000,
            type: .taskEnd,
            raw: "Session end · 30s",
            taskId: "task-B"
        )
        XCTAssertFalse(timelineIsInFlightTask(start, siblings: [start, end]))
    }

    // MARK: - Orphan reaper (DaemonServer.computeOrphanTaskEnds)

    /// task_start with no matching task_end → reaper produces one synthetic
    /// task_end carrying boundarySignal="interrupted", taskId preserved,
    /// startedAt inherited.
    func testReaperSynthesizesEndForOrphan() {
        let startedAt: Double = 1_000_000_000_000
        let start = DaemonTimelineEntry(
            ts: startedAt,
            type: "task_start",
            raw: "Task 1",
            agentType: "openclaw",
            projectName: "Demo",
            sessionId: "session-X",
            startedAt: startedAt,
            runId: "run-1",
            taskId: "task-orphan"
        )
        let synthetics = DaemonServer.computeOrphanTaskEnds(from: [start])
        XCTAssertEqual(synthetics.count, 1)
        let end = synthetics[0]
        XCTAssertEqual(end.type, "task_end")
        XCTAssertEqual(end.taskId, "task-orphan")
        XCTAssertEqual(end.boundarySignal, "interrupted")
        XCTAssertEqual(end.startedAt, startedAt)
        XCTAssertNil(end.endedAt, "unknown duration leaves endedAt nil — UI renders '–'")
        XCTAssertEqual(end.sessionId, "session-X")
        XCTAssertEqual(end.agentType, "openclaw")
        XCTAssertEqual(end.runId, "run-1")
        XCTAssertEqual(end.ts, startedAt + 1, "synthetic end sorts immediately after the orphan start")
    }

    /// task_start + matching task_end → reaper produces nothing.
    /// Idempotence: re-running the reaper on the next startup sees the
    /// synthetic task_end already there and is a no-op.
    func testReaperSkipsPairedTask() {
        let start = DaemonTimelineEntry(
            ts: 1000, type: "task_start", raw: "Task 1",
            startedAt: 1000, taskId: "task-paired"
        )
        let end = DaemonTimelineEntry(
            ts: 2000, type: "task_end", raw: "TODO done · 1s",
            startedAt: 1000, endedAt: 2000, taskId: "task-paired",
            boundarySignal: "todo_complete"
        )
        XCTAssertTrue(DaemonServer.computeOrphanTaskEnds(from: [start, end]).isEmpty)
    }

    /// Mixed snapshot — one orphan, one paired, plus unrelated rows.
    /// Only the orphan should produce a synthetic; ordering of the
    /// snapshot must not matter.
    func testReaperHandlesMixedSnapshot() {
        let orphan = DaemonTimelineEntry(
            ts: 1000, type: "task_start", raw: "Task 1",
            startedAt: 1000, taskId: "task-A"
        )
        let pairedStart = DaemonTimelineEntry(
            ts: 2000, type: "task_start", raw: "Task 2",
            startedAt: 2000, taskId: "task-B"
        )
        let pairedEnd = DaemonTimelineEntry(
            ts: 3000, type: "task_end", raw: "Session end · 1s",
            startedAt: 2000, endedAt: 3000, taskId: "task-B",
            boundarySignal: "session_end"
        )
        let unrelated = DaemonTimelineEntry(
            ts: 1500, type: "chat_response", raw: "hello"
        )
        let synthetics = DaemonServer.computeOrphanTaskEnds(
            from: [pairedEnd, unrelated, orphan, pairedStart]
        )
        XCTAssertEqual(synthetics.count, 1)
        XCTAssertEqual(synthetics.first?.taskId, "task-A")
    }

    /// task_start without taskId (legacy / malformed) → reaper skips.
    /// Without the empty-id guard the synthetic task_end would carry a
    /// nil taskId and the UI pair lookup would also fail.
    func testReaperSkipsTaskStartWithoutTaskId() {
        let start = DaemonTimelineEntry(
            ts: 1000, type: "task_start", raw: "Task ?",
            startedAt: 1000, taskId: nil
        )
        XCTAssertTrue(DaemonServer.computeOrphanTaskEnds(from: [start]).isEmpty)
    }
}
#endif
