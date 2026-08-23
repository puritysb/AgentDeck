// TimelineTests.swift — Timeline store and grouping tests

import XCTest
@testable import AgentDeck

final class TimelineTests: XCTestCase {

    func testObservedSessionFilterMatchesRawTimelineSessionId() {
        let entry = TimelineEntry(
            ts: 1,
            type: .chatStart,
            raw: "hi",
            agentType: "codex-cli",
            projectName: "AgentDeck",
            sessionId: "session-uuid"
        )

        XCTAssertTrue(entry.matchesTimelineFilter(TimelineSessionFilter(
            sessionId: "observed:codex:session-uuid",
            projectName: "AgentDeck",
            agentType: "codex-cli"
        )))
        XCTAssertFalse(entry.matchesTimelineFilter(TimelineSessionFilter(
            sessionId: "observed:codex:other-uuid",
            projectName: "AgentDeck",
            agentType: "codex-cli"
        )))
    }

    func testObservedSessionFilterCanonicalizesEveryObservedProvider() {
        let providers = ["claude", "codex", "codex-app", "opencode", "antigravity"]
        for provider in providers {
            XCTAssertEqual(
                canonicalTimelineSessionId("observed:\(provider):session-uuid"),
                "session-uuid"
            )
        }
    }

    // MARK: - Timeline Entry Decoding

    func testDecodeTimelineEvent() throws {
        let json = """
        {
            "type": "timeline_event",
            "entry": {
                "ts": 1710200000000,
                "type": "tool_request",
                "raw": "Read src/main.ts",
                "detail": "Reading file contents",
                "status": "pending"
            }
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .timelineEvent(let e) = event else {
            XCTFail("Expected timelineEvent")
            return
        }

        XCTAssertEqual(e.entry.type, .toolRequest)
        XCTAssertEqual(e.entry.raw, "Read src/main.ts")
        XCTAssertEqual(e.entry.detail, "Reading file contents")
        XCTAssertEqual(e.entry.status, "pending")
    }

    func testDecodeTimelineHistory() throws {
        let json = """
        {
            "type": "timeline_history",
            "entries": [
                {"ts": 1710200000000, "type": "chat_start", "raw": "Starting chat"},
                {"ts": 1710200010000, "type": "tool_request", "raw": "Read file"},
                {"ts": 1710200020000, "type": "chat_end", "raw": "Done"}
            ]
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .timelineHistory(let e) = event else {
            XCTFail("Expected timelineHistory")
            return
        }

        XCTAssertEqual(e.entries.count, 3)
        XCTAssertEqual(e.entries[0].type, .chatStart)
        XCTAssertEqual(e.entries[2].type, .chatEnd)
    }

    #if os(macOS)
    @MainActor
    func testDaemonBuildsTimelineHistoryPayloadForDashboardReconnect() throws {
        let entries = [
            DaemonTimelineEntry(
                ts: 1710200000000,
                type: "tool_exec",
                raw: "Bash: pnpm test",
                detail: "running tests",
                status: "running",
                agentType: "codex-cli",
                projectName: "AgentDeck",
                sessionId: "codex:abc"
            ),
            DaemonTimelineEntry(
                ts: 1710200010000,
                type: "task_end",
                raw: "Manual · 10s",
                agentType: "codex-cli",
                projectName: "AgentDeck",
                sessionId: "codex:abc",
                taskId: "task-1",
                boundarySignal: "manual",
                taskScore: 0.9,
                taskOutcome: "success",
                taskCategory: "debugging",
                taskSummary: "verified timeline reconnect"
            ),
        ]

        let payload = DaemonServer.buildTimelineHistoryEventForTest(from: entries)
        let data = try JSONSerialization.data(withJSONObject: payload)
        let json = String(data: data, encoding: .utf8)!

        let event = BridgeEventParser.parse(json)
        guard case .timelineHistory(let history) = event else {
            XCTFail("Expected timelineHistory")
            return
        }

        XCTAssertEqual(history.entries.count, 2)
        XCTAssertEqual(history.entries[0].type, .toolExec)
        XCTAssertEqual(history.entries[0].agentType, "codex-cli")
        XCTAssertEqual(history.entries[0].sessionId, "codex:abc")
        XCTAssertEqual(history.entries[1].type, .taskEnd)
        XCTAssertEqual(history.entries[1].taskId, "task-1")
        XCTAssertEqual(history.entries[1].boundarySignal, .manual)
        XCTAssertEqual(history.entries[1].taskScore ?? .nan, 0.9, accuracy: 0.0001)
        XCTAssertEqual(history.entries[1].taskSummary, "verified timeline reconnect")
    }
    #endif

    // MARK: - Task hierarchy + lenient unknown-type decode (Phase 1)

    func testDecodeTaskStartEntry() throws {
        let json = """
        {
          "ts": 1710200000000,
          "type": "task_start",
          "raw": "Task 1",
          "taskId": "task-abc",
          "sessionId": "sess-1",
          "runId": "run-1",
          "startedAt": 1710200000000
        }
        """.data(using: .utf8)!
        let entry = try JSONDecoder().decode(TimelineEntry.self, from: json)
        XCTAssertEqual(entry.type, .taskStart)
        XCTAssertEqual(entry.taskId, "task-abc")
        XCTAssertEqual(entry.sessionId, "sess-1")
    }

    func testDecodeTaskEndWithBoundarySignal() throws {
        let json = """
        {
          "ts": 1710200060000,
          "type": "task_end",
          "raw": "TODO done · 60s",
          "taskId": "task-abc",
          "boundarySignal": "todo_complete",
          "startedAt": 1710200000000,
          "endedAt": 1710200060000
        }
        """.data(using: .utf8)!
        let entry = try JSONDecoder().decode(TimelineEntry.self, from: json)
        XCTAssertEqual(entry.type, .taskEnd)
        XCTAssertEqual(entry.boundarySignal, .todoComplete)
    }

    func testUnknownTimelineEntryTypeDecodesToUnknown() throws {
        // A future protocol could add a new entry type. The lenient enum must
        // decode it into `.unknown(raw)` so old clients don't crash on the
        // first entry of the new type.
        let json = """
        { "ts": 1, "type": "future_thing", "raw": "x" }
        """.data(using: .utf8)!
        let entry = try JSONDecoder().decode(TimelineEntry.self, from: json)
        switch entry.type {
        case .unknown(let raw):
            XCTAssertEqual(raw, "future_thing")
        default:
            XCTFail("expected .unknown, got \(entry.type)")
        }
    }

    func testTimelineEntryRoundTripsTaskId() throws {
        let original = TimelineEntry(
            ts: 1, type: .toolRequest, raw: "edit",
            taskId: "task-123"
        )
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(TimelineEntry.self, from: data)
        XCTAssertEqual(decoded.taskId, "task-123")
    }

    func testTimelineEntryRoundTripsSummaryKind() throws {
        let original = TimelineEntry(
            ts: 1, type: .chatEnd, raw: "Refactor · 4s",
            summaryKind: "heuristic"
        )
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(TimelineEntry.self, from: data)
        XCTAssertEqual(decoded.summaryKind, "heuristic")
    }

    // Task-judge rollup fields must survive both directions of the WS
    // round-trip — the custom `init(from:)` enumerates every property
    // explicitly, so adding new fields to the struct without also
    // adding `decodeIfPresent` calls there silently drops them on the
    // wire. Regression: Codex stop-time review caught the first miss.
    func testTimelineEntryRoundTripsTaskEvalFields() throws {
        let original = TimelineEntry(
            ts: 1, type: .taskEnd, raw: "TODO done · 12s",
            taskId: "task-456",
            boundarySignal: .todoComplete,
            taskScore: 0.83,
            taskOutcome: "success",
            taskCategory: "refactoring",
            taskSummary: "added auth-middleware tests"
        )
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(TimelineEntry.self, from: data)
        XCTAssertEqual(decoded.taskScore ?? .nan, 0.83, accuracy: 0.0001)
        XCTAssertEqual(decoded.taskOutcome, "success")
        XCTAssertEqual(decoded.taskCategory, "refactoring")
        XCTAssertEqual(decoded.taskSummary, "added auth-middleware tests")
    }

    // The custom Codable init also has to round-trip raw JSON keys
    // matching the bridge daemon's `claudeCodeEntryDict` payload — not
    // just our own encoded form. This is closer to the actual WS flow.
    func testTimelineEntryDecodesTaskEvalFieldsFromBridgePayload() throws {
        let payload = """
        {
          "ts": 1,
          "type": "task_end",
          "raw": "Manual · 30s",
          "taskId": "task-789",
          "boundarySignal": "manual",
          "taskScore": 0.55,
          "taskOutcome": "abandoned",
          "taskCategory": "general",
          "taskSummary": "stopped halfway"
        }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(TimelineEntry.self, from: payload)
        XCTAssertEqual(decoded.taskScore ?? .nan, 0.55, accuracy: 0.0001)
        XCTAssertEqual(decoded.taskOutcome, "abandoned")
        XCTAssertEqual(decoded.taskCategory, "general")
        XCTAssertEqual(decoded.taskSummary, "stopped halfway")
        XCTAssertEqual(decoded.boundarySignal, .manual)
    }

    // MARK: - groupConsecutive — task entries never group

    func testTaskEntriesNeverGroup() {
        let entries = [
            TimelineEntry(ts: 1000, type: .taskStart, raw: "Task 1", taskId: "a"),
            TimelineEntry(ts: 2000, type: .taskStart, raw: "Task 1", taskId: "b"),
            TimelineEntry(ts: 3000, type: .taskEnd,   raw: "Task 1", taskId: "a"),
            TimelineEntry(ts: 4000, type: .taskEnd,   raw: "Task 1", taskId: "b"),
        ]
        let grouped = groupConsecutive(entries)
        // Each task entry must remain its own group (never collapsed by
        // identical raw within window).
        XCTAssertEqual(grouped.count, 4)
        XCTAssertTrue(grouped.allSatisfy { $0.count == 1 })
    }

    // MARK: - Turn merge (chat_start + chat_response + chat_end → one group)

    func testTurnMergeCombinesChatStartResponseEnd() {
        let entries = [
            TimelineEntry(ts: 1000, type: .chatStart,    raw: "hello",      sessionId: "s1"),
            TimelineEntry(ts: 2000, type: .chatResponse, raw: "Hi there",   sessionId: "s1"),
            TimelineEntry(ts: 3000, type: .chatEnd,      raw: "Completed · 2s", sessionId: "s1"),
        ]
        let grouped = groupConsecutive(entries, windowSeconds: 60)
        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped[0].entry.type, .chatStart)
        XCTAssertEqual(grouped[0].entry.raw, "hello")
        XCTAssertEqual(grouped[0].mergedResponse?.raw, "Hi there")
        XCTAssertEqual(grouped[0].mergedCompletion?.raw, "Completed · 2s")
    }

    func testTurnMergeWorksWithoutResponseRow() {
        // The bridge sometimes emits chat_start + chat_end only (assistant
        // text was empty or filtered). The merge should still pull the
        // chat_end into the chat_start group so the row collapses to one.
        let entries = [
            TimelineEntry(ts: 1000, type: .chatStart, raw: "ping", sessionId: "s1"),
            TimelineEntry(ts: 1500, type: .chatEnd,   raw: "Completed · 1s", sessionId: "s1"),
        ]
        let grouped = groupConsecutive(entries)
        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped[0].entry.type, .chatStart)
        XCTAssertNil(grouped[0].mergedResponse)
        XCTAssertEqual(grouped[0].mergedCompletion?.raw, "Completed · 1s")
    }

    func testTurnMergeAttachesCompletionToResponseWhenPromptIsMissing() {
        let entries = [
            TimelineEntry(
                ts: 2000,
                type: .chatResponse,
                raw: "Implemented timeline cleanup",
                sessionId: "s1",
                startedAt: 1000,
                endedAt: 2000
            ),
            TimelineEntry(
                ts: 2001,
                type: .chatEnd,
                raw: "Completed · 1s · timeline cleanup",
                sessionId: "s1",
                startedAt: 1000,
                endedAt: 2001,
                summaryKind: "heuristic"
            ),
        ]

        let grouped = groupConsecutive(entries)
        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped[0].entry.type, .chatResponse)
        XCTAssertEqual(grouped[0].mergedCompletion?.raw, "Completed · 1s · timeline cleanup")
    }

    func testTurnMergeKeepsSyntheticChatStartSeparate() {
        // Synthetic placeholder chat_starts (e.g. "Prompt sent") are not
        // worth showing as a row in their own right; the dashboard filter
        // promotes the trailing chat_end instead. The merge must NOT absorb
        // the completion or the trailing row would vanish entirely.
        let entries = [
            TimelineEntry(ts: 1000, type: .chatStart, raw: "Prompt sent", sessionId: "s1"),
            TimelineEntry(ts: 2000, type: .chatEnd,   raw: "Completed · 1s", sessionId: "s1"),
        ]
        let grouped = groupConsecutive(entries)
        XCTAssertEqual(grouped.count, 2)
        XCTAssertEqual(grouped[0].entry.type, .chatStart)
        XCTAssertNil(grouped[0].mergedCompletion)
        XCTAssertEqual(grouped[1].entry.type, .chatEnd)
    }

    func testTurnMergeKeepsSyntheticPromptSeparateButResponseAbsorbsCompletion() {
        let entries = [
            TimelineEntry(ts: 1000, type: .chatStart, raw: "Prompt sent", sessionId: "s1", startedAt: 1000),
            TimelineEntry(ts: 2000, type: .chatResponse, raw: "Done.", sessionId: "s1", startedAt: 1000, endedAt: 2000),
            TimelineEntry(ts: 2001, type: .chatEnd, raw: "Completed · 1s", sessionId: "s1", startedAt: 1000, endedAt: 2001),
        ]

        let grouped = groupConsecutive(entries)
        XCTAssertEqual(grouped.count, 2)
        XCTAssertEqual(grouped[0].entry.type, .chatStart)
        XCTAssertNil(grouped[0].mergedResponse)
        XCTAssertEqual(grouped[1].entry.type, .chatResponse)
        XCTAssertEqual(grouped[1].mergedCompletion?.raw, "Completed · 1s")
    }

    func testTurnMergeDoesNotCrossSessions() {
        let entries = [
            TimelineEntry(ts: 1000, type: .chatStart, raw: "ask A", sessionId: "session-a"),
            TimelineEntry(ts: 1500, type: .chatEnd,   raw: "B done", sessionId: "session-b"),
        ]
        let grouped = groupConsecutive(entries)
        XCTAssertEqual(grouped.count, 2)
        XCTAssertNil(grouped[0].mergedCompletion)
    }

    /// sameTimelineContext upgrade (2026-07-13): grouping now keys on runId, not
    /// just sessionId. Two turns sharing a session but belonging to different
    /// OpenClaw generations (distinct runId) must NOT cross-merge — mirrors
    /// Android `sameTimelineContext`, and matches the full-context display
    /// filter the strip already uses.
    func testTurnMergeRespectsRunIdWithinSession() {
        let start = TimelineEntry(ts: 1000, type: .chatStart, raw: "gen A", sessionId: "s1", runId: "A")
        let resp = TimelineEntry(ts: 1500, type: .chatResponse, raw: "reply B",
                                 sessionId: "s1", runId: "B", startedAt: 1000)
        let grouped = groupConsecutive([start, resp])
        XCTAssertEqual(grouped.count, 2, "different runId = different context, no merge")
        XCTAssertNil(grouped[0].mergedResponse)
    }

    func testTurnMergeSameRunIdMerges() {
        let start = TimelineEntry(ts: 1000, type: .chatStart, raw: "gen A", sessionId: "s1", runId: "A")
        let resp = TimelineEntry(ts: 1500, type: .chatResponse, raw: "reply A",
                                 sessionId: "s1", runId: "A", startedAt: 1000)
        let grouped = groupConsecutive([start, resp])
        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped[0].mergedResponse?.raw, "reply A")
    }

    /// Long assistant responses (xcodebuild + multi-fix sessions easily
    /// run 20 min+) must NOT break the chat-turn merge. The 60 s window
    /// applies only to dedup grouping; chat merge is bounded by the
    /// next `user_prompt_submit`, not wall-clock. Regression: previously
    /// the merge shared `windowSeconds`, so a 20-minute response left
    /// the chat_start spinner rotating forever and produced three
    /// separate dashboard rows for one turn (Codex stop-time review
    /// surfaced via direct app screenshot 2026-05-17).
    func testTurnMergeAllowsLongAssistantResponse() {
        let entries = [
            TimelineEntry(ts: 0,           type: .chatStart, raw: "do a lot of work", sessionId: "s1"),
            TimelineEntry(ts: 1_200_000,   type: .chatResponse, raw: "Done.",         sessionId: "s1"), // +20 min
            TimelineEntry(ts: 1_200_001,   type: .chatEnd,   raw: "Completed · 1200s · fix", sessionId: "s1"),
        ]
        // windowSeconds=60 (the default) used to break this; the chat
        // branch now ignores the window entirely.
        let grouped = groupConsecutive(entries, windowSeconds: 60)
        XCTAssertEqual(grouped.count, 1, "long response must still collapse to one turn row")
        XCTAssertEqual(grouped[0].mergedResponse?.raw, "Done.")
        XCTAssertEqual(grouped[0].mergedCompletion?.raw, "Completed · 1200s · fix")
    }

    /// Codex stop-time review #7 (2026-05-17): without wall-clock
    /// bounding, an out-of-order chat_end from a previous turn could
    /// attach to the next fresh chat_start by sessionId alone, putting
    /// Q1's completion onto Q2's row. The anchor predicate
    /// (`chat_end.startedAt == chat_start.ts`) blocks that.
    func testTurnMergeRejectsDelayedCompletionOnNextPrompt() {
        let q1 = TimelineEntry(
            ts: 1000, type: .chatStart, raw: "Q1",
            sessionId: "s1", startedAt: 1000
        )
        let q2 = TimelineEntry(
            ts: 2000, type: .chatStart, raw: "Q2",
            sessionId: "s1", startedAt: 2000
        )
        // chat_end for Q1 arrives AFTER Q2 has opened — startedAt anchors
        // back to Q1 (ts=1000), not Q2.
        let q1End = TimelineEntry(
            ts: 3000, type: .chatEnd, raw: "Completed · Q1",
            sessionId: "s1", startedAt: 1000, endedAt: 3000
        )
        let grouped = groupConsecutive([q1, q2, q1End])
        // Q2 must NOT absorb Q1's completion. The completion lands as
        // its own standalone group rather than poisoning Q2's row.
        let q2Group = grouped.first(where: { $0.entry.raw == "Q2" })
        XCTAssertNotNil(q2Group)
        XCTAssertNil(q2Group?.mergedCompletion, "delayed Q1 completion must not attach to Q2")
        XCTAssertEqual(
            grouped.contains(where: { $0.entry.type == .chatEnd && $0.entry.raw == "Completed · Q1" }),
            true,
            "orphaned Q1 chat_end falls through as its own group rather than cross-talking"
        )
    }

    /// Anchor mismatch must be detected even when startedAt is present
    /// on the child but doesn't equal the head's ts (e.g. a malformed
    /// emitter or replayed history).
    func testTurnMergeRejectsMismatchedStartedAt() {
        let head = TimelineEntry(ts: 100, type: .chatStart, raw: "real Q", sessionId: "s1", startedAt: 100)
        let child = TimelineEntry(
            ts: 200, type: .chatEnd, raw: "Completed",
            sessionId: "s1", startedAt: 50, endedAt: 200
        )
        let grouped = groupConsecutive([head, child])
        XCTAssertEqual(grouped.count, 2)
        XCTAssertNil(grouped[0].mergedCompletion)
    }

    /// Codex stop-time review #11 (2026-05-17): chat_end is emitted
    /// from an async Task that awaits a summarizer, and Claude Code's
    /// Stop hook is only ~18% reliable. Both paths can drop chat_end
    /// even though the user already saw the assistant's reply via
    /// chat_response. The turn must read as "completed" (spinner off,
    /// icon = success) the moment EITHER child arrives.
    func testTurnHasResponseTrueWhenOnlyResponseMerged() {
        let entries = [
            TimelineEntry(ts: 1000, type: .chatStart, raw: "Q", sessionId: "s1", startedAt: 1000),
            TimelineEntry(ts: 2000, type: .chatResponse, raw: "A", sessionId: "s1", startedAt: 1000, endedAt: 2000),
            // No chat_end — summarizer hung / Stop hook dropped.
        ]
        let grouped = groupConsecutive(entries)
        XCTAssertEqual(grouped.count, 1)
        XCTAssertNotNil(grouped[0].mergedResponse)
        XCTAssertNil(grouped[0].mergedCompletion)
        XCTAssertTrue(grouped[0].hasResponse, "response without completion still counts as 'turn delivered'")
    }

    func testTurnHasResponseTrueWhenOnlyCompletionMerged() {
        let entries = [
            TimelineEntry(ts: 1000, type: .chatStart, raw: "Q", sessionId: "s1", startedAt: 1000),
            TimelineEntry(ts: 2000, type: .chatEnd, raw: "Completed · 1s", sessionId: "s1", startedAt: 1000, endedAt: 2000),
        ]
        let grouped = groupConsecutive(entries)
        XCTAssertEqual(grouped.count, 1)
        XCTAssertNil(grouped[0].mergedResponse)
        XCTAssertNotNil(grouped[0].mergedCompletion)
        XCTAssertTrue(grouped[0].hasResponse)
    }

    func testTurnHasResponseFalseWhenStartAlone() {
        let entry = TimelineEntry(ts: 1000, type: .chatStart, raw: "still going…", sessionId: "s1", startedAt: 1000)
        let grouped = groupConsecutive([entry])
        XCTAssertEqual(grouped.count, 1)
        XCTAssertFalse(grouped[0].hasResponse, "lone chat_start = response not yet in")
    }

    /// Legacy children with nil `startedAt` still merge — preserves
    /// behaviour for pre-anchor adapters.
    func testTurnMergeAllowsLegacyChildWithoutStartedAt() {
        let head = TimelineEntry(ts: 100, type: .chatStart, raw: "ask", sessionId: "s1", startedAt: 100)
        let legacyEnd = TimelineEntry(
            ts: 200, type: .chatEnd, raw: "Completed",
            sessionId: "s1", startedAt: nil, endedAt: 200
        )
        let grouped = groupConsecutive([head, legacyEnd])
        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped[0].mergedCompletion?.raw, "Completed")
    }

    /// The dedup-grouping branch (identical-raw rows close in time)
    /// keeps its 60 s window. A repeated `tool_request` two minutes
    /// apart must NOT collapse — the chat-merge window loosening must
    /// not bleed into other types.
    func testDedupGroupingStillRespectsWindow() {
        let entries = [
            TimelineEntry(ts: 0,       type: .toolRequest, raw: "Read"),
            TimelineEntry(ts: 120_000, type: .toolRequest, raw: "Read"), // 2 min later
        ]
        let grouped = groupConsecutive(entries, windowSeconds: 60)
        XCTAssertEqual(grouped.count, 2, "dedup grouping still bounded by windowSeconds")
    }

    // MARK: - Grouping

    func testGroupConsecutiveSameType() {
        let entries = [
            TimelineEntry(ts: 1000, type: .toolRequest, raw: "Read file"),
            TimelineEntry(ts: 2000, type: .toolRequest, raw: "Read file"),
            TimelineEntry(ts: 3000, type: .toolRequest, raw: "Read file"),
        ]

        let grouped = groupConsecutive(entries, windowSeconds: 60)
        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped[0].count, 3)
    }

    func testGroupConsecutiveDifferentTypes() {
        let entries = [
            TimelineEntry(ts: 1000, type: .toolRequest, raw: "Read file"),
            TimelineEntry(ts: 2000, type: .chatStart, raw: "Starting"),
            TimelineEntry(ts: 3000, type: .toolRequest, raw: "Read file"),
        ]

        let grouped = groupConsecutive(entries, windowSeconds: 60)
        XCTAssertEqual(grouped.count, 3)
    }

    func testGroupConsecutiveWindowBreak() {
        let entries = [
            TimelineEntry(ts: 0, type: .toolRequest, raw: "Read file"),
            TimelineEntry(ts: 120_000, type: .toolRequest, raw: "Read file"), // 2 min later
        ]

        let grouped = groupConsecutive(entries, windowSeconds: 60)
        XCTAssertEqual(grouped.count, 2)
    }

    func testGroupConsecutiveEmpty() {
        let grouped = groupConsecutive([], windowSeconds: 60)
        XCTAssertEqual(grouped.count, 0)
    }

    // MARK: - Timeline Store

    func testTimelineStoreAdd() {
        let store = TimelineStore()
        store.addEntry(TimelineEntry(ts: 1000, type: .chatStart, raw: "Start"))
        store.addEntry(TimelineEntry(ts: 2000, type: .toolRequest, raw: "Read"))

        XCTAssertEqual(store.entries.count, 2)
        // `grouped` is no longer stored on TimelineStore — the view layer runs
        // groupConsecutive() per render against the (session-filtered) entries.
        // Mirror that here instead of reading a removed property.
        let grouped = groupConsecutive(store.entries, windowSeconds: 60)
        XCTAssertEqual(grouped.count, 2)
    }

    /// The CLIENT store must carve OpenClaw out of the `tool_exec`-first
    /// eviction rule exactly as `DaemonTimelineStore` does.
    ///
    /// `TimelineStore.evictOne` names itself a port of that function, and it
    /// had drifted: the daemon kept OpenClaw tool rows under buffer pressure
    /// while the app's own view shed them, so the rows the daemon had just
    /// decided to protect disappeared one layer later. `tool_exec` is the ONLY
    /// row type OpenClaw's producers emit, so evicting it first does not thin
    /// those rows — it deletes them.
    func testTimelineStoreKeepsOpenClawToolRowsUnderPressure() {
        let store = TimelineStore()
        // A busy machine: the buffer is already at capacity with OTHER turns.
        // The filler must not be `tool_exec` — the bug only bites when the
        // OpenClaw row is the only plain `tool_exec` present, so it is the
        // first (and only) match and evicts itself on insertion. Filling with
        // tool rows instead makes an older row the match and the test passes
        // with or without the carve-out, proving nothing.
        for i in 0..<520 {
            store.addEntry(TimelineEntry(
                ts: Double(i), type: .chatResponse, raw: "reply \(i)",
                agentType: "claude-code", sessionId: "s\(i)"
            ))
        }
        store.addEntry(TimelineEntry(
            ts: 9000, type: .toolExec, raw: "read · heartbeat-state.json",
            detail: "session: main\nok · exit 0",
            agentType: "openclaw", sessionId: "openclaw-gateway"
        ))

        XCTAssertLessThanOrEqual(store.entries.count, 500)
        XCTAssertTrue(
            store.entries.contains { $0.agentType == "openclaw" && $0.type == .toolExec },
            "OpenClaw row evicted itself on insertion into a full client buffer"
        )
    }

    func testTimelineStoreUpsert() {
        let store = TimelineStore()
        store.addEntry(TimelineEntry(ts: 1000, type: .toolRequest, raw: "Read", status: "pending"))
        store.addEntry(TimelineEntry(ts: 1000, type: .toolRequest, raw: "Read", status: "approved"), upsert: true)

        XCTAssertEqual(store.entries.count, 1)
        XCTAssertEqual(store.entries[0].status, "approved")
    }

    /// The upsert path field-merges instead of full-replacing. The task-judge
    /// rollup arrives on a *second* `task_end` emit (matched by taskId, not ts),
    /// and a later nil-bearing re-emit must not clobber the score. Mirrors Node
    /// `BridgeTimelineStore` merge-path and Android `TimelineStore.upsertEntry`.
    func testTimelineStoreUpsertMergesTaskRollupWithoutClobbering() {
        let store = TimelineStore()
        // Initial boundary emit: carries boundarySignal + startedAt, no score.
        store.addEntry(TimelineEntry(
            ts: 1000, type: .taskEnd, raw: "Manual · 12s",
            agentType: "claude-code", projectName: "AgentDeck",
            startedAt: 500, endedAt: 1000,
            taskId: "task-1", boundarySignal: .manual
        ), upsert: true)

        // Second emit (5–30 s later, different ts): the judge rollup lands, but
        // it does NOT re-send boundarySignal / startedAt — those must survive.
        store.addEntry(TimelineEntry(
            ts: 30000, type: .taskEnd, raw: "Manual · 12s · added tests",
            taskId: "task-1",
            taskScore: 0.9, taskOutcome: "success",
            taskCategory: "testing", taskSummary: "added tests"
        ), upsert: true)

        XCTAssertEqual(store.entries.count, 1, "matched by taskId, merged in place")
        let merged = store.entries[0]
        XCTAssertEqual(merged.taskScore ?? .nan, 0.9, accuracy: 0.0001)
        XCTAssertEqual(merged.taskOutcome, "success")
        XCTAssertEqual(merged.taskCategory, "testing")
        XCTAssertEqual(merged.boundarySignal, .manual, "boundarySignal preserved from first emit")
        XCTAssertEqual(merged.startedAt, 500, "startedAt preserved from first emit")
        XCTAssertEqual(merged.raw, "Manual · 12s · added tests", "raw takes the freshest summary")
        XCTAssertEqual(merged.ts, 1000, "identity ts stays at the boundary's sorted position")

        // A later duplicate/re-emit carrying nil rollup must NOT wipe the score.
        store.addEntry(TimelineEntry(
            ts: 30001, type: .taskEnd, raw: "Manual · 12s",
            taskId: "task-1", boundarySignal: .manual
        ), upsert: true)
        XCTAssertEqual(store.entries.count, 1)
        XCTAssertEqual(store.entries[0].taskScore ?? .nan, 0.9, accuracy: 0.0001,
                       "nil-score re-emit must not clobber the merged rollup")
        XCTAssertEqual(store.entries[0].taskOutcome, "success")
        XCTAssertEqual(store.entries[0].taskSummary, "added tests")
    }

    func testTimelineStoreReplaceSnapshotIsAuthoritative() {
        let store = TimelineStore()
        // A live row present before the snapshot arrives.
        store.addEntry(TimelineEntry(ts: 2000, type: .chatStart, raw: "Current"))

        // The daemon's timeline_history snapshot REPLACES the buffer (no merge)
        // so re-stamped rows can't stack across reconnects.
        store.replaceSnapshot([
            TimelineEntry(ts: 1000, type: .chatStart, raw: "Old"),
            TimelineEntry(ts: 2000, type: .chatStart, raw: "Dupe"),
            TimelineEntry(ts: 2000, type: .chatStart, raw: "Dupe"),  // exact dup dropped
            TimelineEntry(ts: 3000, type: .chatEnd, raw: "New"),
        ])

        XCTAssertEqual(store.entries.count, 3, "exact (ts,type,raw) duplicate deduped")
        // Sorted by ts.
        XCTAssertEqual(store.entries[0].ts, 1000)
        XCTAssertEqual(store.entries[1].ts, 2000)
        XCTAssertEqual(store.entries[2].ts, 3000)
        // The pre-snapshot "Current" row is gone — replace, not merge.
        XCTAssertEqual(store.entries[1].raw, "Dupe")
        XCTAssertFalse(store.entries.contains { $0.raw == "Current" })
    }

    func testTimelineStoreReplaceSnapshotDropsLowSignalNoise() {
        let store = TimelineStore()
        store.replaceSnapshot([
            TimelineEntry(ts: 1000, type: .chatStart, raw: "Prompt"),
            // Codex tool_exec noise must not occupy a buffer slot.
            TimelineEntry(ts: 1500, type: .toolExec, raw: "Bash", agentType: "codex-cli"),
            TimelineEntry(ts: 2000, type: .chatResponse, raw: "Answer"),
        ])
        XCTAssertEqual(store.entries.count, 2)
        XCTAssertFalse(store.entries.contains { $0.type == .toolExec })
    }

    func testTimelineStoreMaxEntries() {
        let store = TimelineStore()
        // Cap is 500 (Android parity), up from 200.
        for i in 0..<600 {
            store.addEntry(TimelineEntry(ts: Double(i), type: .chatStart, raw: "Entry \(i)"))
        }

        XCTAssertEqual(store.entries.count, 500)
        // Oldest 100 trimmed.
        XCTAssertEqual(store.entries[0].ts, 100)
    }

    func testDashboardDisplayKeepsMeaningfulPromptAfterCompletion() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .chatStart,
                raw: "hello",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: 1000
            ),
            TimelineEntry(
                ts: 2000,
                type: .chatResponse,
                raw: "Hello. What do you want to work on?",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: 1000,
                endedAt: 2000
            ),
            TimelineEntry(
                ts: 2001,
                type: .chatEnd,
                raw: "Completed · 1s",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: 1000,
                endedAt: 2001
            ),
        ]

        // After the turn-merge rewrite the three entries collapse to a single
        // chat_start group carrying the response + completion as merged
        // fields. The dashboard renders one row per user prompt; the body
        // and the "Completed · 1s · …" suffix appear as sub-lines on that
        // same row instead of two follow-up rows.
        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.count, 1)
        XCTAssertEqual(displayed.first?.entry.type, .chatStart)
        XCTAssertEqual(displayed.first?.entry.raw, "hello")
        XCTAssertEqual(displayed.first?.mergedResponse?.type, .chatResponse)
        XCTAssertEqual(displayed.first?.mergedResponse?.raw, "Hello. What do you want to work on?")
        XCTAssertEqual(displayed.first?.mergedCompletion?.type, .chatEnd)
        XCTAssertEqual(displayed.first?.mergedCompletion?.raw, "Completed · 1s")
    }

    func testDashboardDisplayStillHidesSyntheticCompletedStart() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .chatStart,
                raw: "Prompt sent",
                agentType: "claude-code",
                sessionId: "s1",
                startedAt: 1000
            ),
            TimelineEntry(
                ts: 2000,
                type: .chatEnd,
                raw: "Completed · 1s",
                agentType: "claude-code",
                sessionId: "s1",
                startedAt: 1000,
                endedAt: 2000
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertTrue(displayed.isEmpty)
    }

    func testDashboardDisplayAttachesCompletedMetadataUnderResponse() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .chatStart,
                raw: "Prompt sent",
                agentType: "codex-cli",
                sessionId: "s1",
                startedAt: 1000
            ),
            TimelineEntry(
                ts: 2000,
                type: .chatResponse,
                raw: "Fixed the timeline.",
                agentType: "codex-cli",
                sessionId: "s1",
                startedAt: 1000,
                endedAt: 2000
            ),
            TimelineEntry(
                ts: 2001,
                type: .chatEnd,
                raw: "Completed · 1s · Timeline cleanup",
                agentType: "codex-cli",
                sessionId: "s1",
                startedAt: 1000,
                endedAt: 2001,
                summaryKind: "heuristic"
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.count, 1)
        XCTAssertEqual(displayed[0].entry.type, .chatResponse)
        XCTAssertEqual(displayed[0].mergedCompletion?.raw, "Completed · 1s · Timeline cleanup")
    }

    func testDashboardDisplayHidesStandaloneCompletedWhenPairedResponseExists() {
        let response = TimelineEntry(
            ts: 2000,
            type: .chatResponse,
            raw: "Fixed the timeline.",
            agentType: "codex-cli",
            sessionId: "s1",
            startedAt: 1000,
            endedAt: 2000
        )
        let completed = TimelineEntry(
            ts: 2001,
            type: .chatEnd,
            raw: "Completed · 1s · Timeline cleanup",
            agentType: "codex-cli",
            sessionId: "s1",
            startedAt: 1000,
            endedAt: 2001,
            summaryKind: "llm"
        )

        let displayed = timelineDisplayGroupsForDashboard([
            GroupedEntry(entry: response, lastTs: response.ts),
            GroupedEntry(entry: completed, lastTs: completed.ts),
        ])
        XCTAssertEqual(displayed.map(\.entry.type), [.chatResponse])
    }

    func testDashboardDisplayHidesStandaloneCompletedWhenPairedStartExists() {
        let start = TimelineEntry(
            ts: 1000,
            type: .chatStart,
            raw: "Review timeline exposure",
            agentType: "claude-code",
            sessionId: "s1",
            startedAt: 1000
        )
        let completed = TimelineEntry(
            ts: 4000,
            type: .chatEnd,
            raw: "Completed · Review timeline exposure",
            agentType: "claude-code",
            sessionId: "s1",
            startedAt: 1000,
            endedAt: 4000,
            summaryKind: "heuristic"
        )

        let displayed = timelineDisplayGroupsForDashboard([
            GroupedEntry(entry: start, lastTs: start.ts),
            GroupedEntry(entry: completed, lastTs: completed.ts),
        ])

        XCTAssertEqual(displayed.map(\.entry.type), [.chatStart])
        XCTAssertEqual(displayed[0].entry.raw, "Review timeline exposure")
    }

    func testDashboardDisplayHidesSyntheticResponselessTurn() {
        let start = TimelineEntry(
            ts: 1000,
            type: .chatStart,
            raw: "Prompt sent",
            agentType: "claude-code",
            sessionId: "s1",
            startedAt: 1000
        )
        let completed = TimelineEntry(
            ts: 4000,
            type: .chatEnd,
            raw: "Completed · 3s",
            agentType: "claude-code",
            sessionId: "s1",
            startedAt: 1000,
            endedAt: 4000,
            summaryKind: "none"
        )

        let displayed = timelineDisplayGroupsForDashboard([
            GroupedEntry(entry: start, lastTs: start.ts),
            GroupedEntry(entry: completed, lastTs: completed.ts),
        ])

        XCTAssertTrue(displayed.isEmpty)
    }

    func testAssistantProgressUpdateClassifier() {
        #if os(macOS)
        XCTAssertTrue(TimelineSummarizer.isAssistantProgressUpdate("""
        Android build is still running (its | tail buffers output until completion, so no interim lines). I'll continue once the completion event arrives.
        """))
        #endif
        XCTAssertTrue(timelineLooksLikeAssistantProgressUpdate("""
        Android build is still running (its | tail buffers output until completion, so no interim lines). I'll continue once the completion event arrives.
        """))
        #if os(macOS)
        XCTAssertFalse(TimelineSummarizer.isAssistantProgressUpdate("""
        Completed. Android build passed, node build is green, and macOS Swift build succeeded.
        """))
        #endif
        XCTAssertFalse(timelineLooksLikeAssistantProgressUpdate("""
        Completed. Android build passed, node build is green, and macOS Swift build succeeded.
        """))
    }

    func testDashboardDisplaySuppressesProgressAssistantResponse() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .chatStart,
                raw: "빌드하고 테스트하라",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: 1000
            ),
            TimelineEntry(
                ts: 2000,
                type: .chatResponse,
                raw: "Android build is still running (its | tail buffers output until completion, so no interim lines). I'll continue once the completion event arrives.",
                detail: "Android build is still running (its | tail buffers output until completion, so no interim lines). I'll continue once the completion event arrives.",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: 1000,
                endedAt: 2000
            ),
            TimelineEntry(
                ts: 2001,
                type: .chatEnd,
                raw: "Completed · 1s · In progress",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: 1000,
                endedAt: 2001,
                summaryKind: "progress"
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.count, 1)
        XCTAssertEqual(displayed[0].entry.type, .chatStart)
        XCTAssertEqual(displayed[0].entry.raw, "빌드하고 테스트하라")
        XCTAssertEqual(timelineDetailEntryForDashboard(displayed[0]).type, .chatStart)
        XCTAssertFalse(timelineShouldShowDetailForDashboard(
            entry: entries[1],
            detail: entries[1].detail!
        ))
    }

    func testDashboardDisplayDropsAnonymousCodexToolNoise() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .toolExec,
                raw: "tool completed",
                agentType: "codex-cli",
                sessionId: "codex:otel-active"
            ),
            TimelineEntry(
                ts: 2000,
                type: .chatStart,
                raw: "Fix timeline grouping",
                agentType: "codex-cli",
                sessionId: "codex:thread-123456"
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.count, 1)
        XCTAssertEqual(displayed[0].entry.raw, "Fix timeline grouping")
    }

    func testDashboardDisplayDropsCodexCommandToolNoise() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .toolExec,
                raw: "Bash: rg -n \"Timeline\" apple/AgentDeck",
                detail: "status: running\n{\"cmd\":\"rg -n Timeline\"}",
                agentType: "codex-cli",
                projectName: "AgentDeck",
                sessionId: "codex:thread-1"
            ),
            TimelineEntry(
                ts: 2000,
                type: .chatStart,
                raw: "Fix timeline noise",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "claude-1"
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.count, 1)
        XCTAssertEqual(displayed[0].entry.agentType, "claude-code")
        XCTAssertEqual(displayed[0].entry.raw, "Fix timeline noise")
    }

    func testDashboardPromotesInformativeParagraphForGenericChatResponseLead() {
        let response = TimelineEntry(
            ts: 1000,
            type: .chatResponse,
            raw: """
            반영했고 실제 Desktop 데몬에서 검증했습니다.

            원인은 Codex hook의 codex_tool_start/end가 Bash/MCP 한 번마다 tool_exec로 Timeline에 저장/방송되던 구조였습니다.
            """,
            detail: """
            반영했고 실제 Desktop 데몬에서 검증했습니다.

            원인은 Codex hook의 `codex_tool_start/end`가 Bash/MCP 한 번마다 `tool_exec`로 Timeline에 저장/방송되던 구조였습니다.

            검증:
            - `pnpm vitest run shared/src/__tests__/timeline.test.ts`: 58 passed
            - `xcodebuild ... TimelineTests`: 42 passed
            """,
            agentType: "codex-cli",
            projectName: "AgentDeck",
            sessionId: "codex:thread-1"
        )

        let group = GroupedEntry(entry: response, lastTs: response.ts)
        XCTAssertTrue(timelineSummaryTextForDashboard(group).hasPrefix("원인은 Codex hook"))
        XCTAssertTrue(timelineShouldShowDetailForDashboard(entry: response, detail: response.detail!))
        // Promoted lead is a mid-body paragraph, NOT the detail opening —
        // the detail pane must keep showing it above the body.
        XCTAssertFalse(timelineSummaryIsRedundantWithDetail(
            summary: timelineSummaryTextForDashboard(group),
            detail: response.detail!
        ))
    }

    func testSummaryRedundantWithDetailForStandaloneChatResponsePrefix() {
        // Producers stamp raw = prefix(200) / detail = prefix(1000) of the
        // same response text (DaemonServer codex path, ApmeCollector,
        // OpenClawAdapter) — the summary is always the body's opening and
        // must be suppressed, including when the 200-char boundary cuts the
        // last word in half.
        let full = "타임라인 중복 렌더 원인을 확인했습니다. Summary 라인이 detail 본문의 접두어라서 같은 텍스트가 두 번 보였고, 게이트가 chatResponse 분기에서 redundancy 검사를 건너뛰었습니다. 수정은 detail 표시 시 Summary를 억제하는 방식입니다."
        let raw = String(full.prefix(80))
        XCTAssertTrue(timelineSummaryIsRedundantWithDetail(summary: raw, detail: full))

        // Exact duplicate (short response: raw == detail).
        XCTAssertTrue(timelineSummaryIsRedundantWithDetail(
            summary: "빌드 완료. 테스트 42개 통과.",
            detail: "빌드 완료. 테스트 42개 통과."
        ))

        // Markdown-formatted detail vs plain raw opening.
        XCTAssertTrue(timelineSummaryIsRedundantWithDetail(
            summary: "정리 focusSession 의 시각 효과 추가됨",
            detail: "## 정리\n\n**focusSession 의 시각 효과 추가됨**\n\n| 변경 | 위치 |\n|---|---|\n| a | b |"
        ))
    }

    func testSummaryNotRedundantForMergedPromptResponseTurn() {
        // Merged chat_start turn: summary = the user PROMPT, detail = the
        // assistant response. Different text — the summary must stay.
        XCTAssertFalse(timelineSummaryIsRedundantWithDetail(
            summary: "Timeline 메세지 출력이 정확한지 검증하라",
            detail: "반영했고 실제 Desktop 데몬에서 검증했습니다.\n\n검증:\n- pnpm vitest\n- xcodebuild"
        ))
        // Very short summaries never suppress unless exactly equal.
        XCTAssertFalse(timelineSummaryIsRedundantWithDetail(
            summary: "완료",
            detail: "완료 처리했습니다. 추가로 문서도 갱신했습니다."
        ))
    }

    func testDashboardDetailUsesMergedAssistantResponseForCompletedTurn() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .chatStart,
                raw: "Timeline 메세지 출력이 정확한지 검증하라",
                agentType: "codex-cli",
                projectName: "AgentDeck",
                sessionId: "codex:thread-1",
                startedAt: 1000
            ),
            TimelineEntry(
                ts: 2000,
                type: .chatResponse,
                raw: "반영했고 실제 Desktop 데몬에서 검증했습니다.",
                detail: "반영했고 실제 Desktop 데몬에서 검증했습니다.\n\n검증:\n- pnpm vitest\n- xcodebuild",
                agentType: "codex-cli",
                projectName: "AgentDeck",
                sessionId: "codex:thread-1",
                startedAt: 1000,
                endedAt: 2000
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.count, 1)
        XCTAssertEqual(timelineDetailEntryForDashboard(displayed[0]).type, .chatResponse)
        XCTAssertEqual(timelineDetailEntryForDashboard(displayed[0]).detail, entries[1].detail)
    }

    func testDashboardDisplayDropsClaudeTaskNotificationChatStart() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .chatStart,
                raw: "<task-notification>\n<summary>Background command completed</summary>",
                detail: "<task-notification>\n<summary>Background command completed</summary>",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: 1000
            ),
            TimelineEntry(
                ts: 2000,
                type: .chatResponse,
                raw: "Flash completed successfully",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: 1000,
                endedAt: 2000
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.count, 1)
        XCTAssertEqual(displayed[0].entry.type, .chatResponse)
        XCTAssertEqual(displayed[0].entry.raw, "Flash completed successfully")
    }

    func testDashboardDisplayDropsGenericTaskStartPlaceholder() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .taskStart,
                raw: "Task 1",
                agentType: "claude-code",
                projectName: "AgentDeck",
                taskId: "task-1"
            ),
            TimelineEntry(
                ts: 1500,
                type: .chatStart,
                raw: "머지하고 반영하라",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: 1500,
                taskId: "task-1"
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.map { $0.entry.type }, [TimelineEntryType.chatStart])
    }

    func testDashboardDisplayKeepsMeaningfulTaskStartTitle() {
        let entry = TimelineEntry(
            ts: 1000,
            type: .taskStart,
            raw: "Timeline noise cleanup",
            agentType: "claude-code",
            projectName: "AgentDeck",
            taskId: "task-1"
        )

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive([entry]))
        XCTAssertEqual(displayed.count, 1)
        XCTAssertEqual(displayed[0].entry.raw, "Timeline noise cleanup")
    }

    func testDashboardDisplayNeverShowsStandaloneTaskEnd() {
        // One-row-per-task contract (shared/src/timeline-task-display.ts):
        // task_end is a data-only closure record — even a fully judged one
        // renders nothing on its own.
        let entry = TimelineEntry(
            ts: 2000,
            type: .taskEnd,
            raw: "Timeline cleanup · 12s",
            agentType: "claude-code",
            projectName: "AgentDeck",
            taskId: "task-1",
            boundarySignal: .manual,
            taskScore: 0.92,
            taskOutcome: "success",
            taskCategory: "debugging",
            taskSummary: "reduced low-signal timeline rows"
        )

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive([entry]))
        XCTAssertTrue(displayed.isEmpty)
    }

    func testDashboardDisplayShowsJudgedTaskAsSingleHeaderRow() {
        // A bare "Task N" header becomes visible once its closure carries the
        // judge verdict — and the pair renders as exactly one row (the header).
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .taskStart,
                raw: "Task 1",
                agentType: "claude-code",
                projectName: "AgentDeck",
                taskId: "task-1"
            ),
            TimelineEntry(
                ts: 2000,
                type: .taskEnd,
                raw: "Session end · 2 turns · 6m 5s",
                agentType: "claude-code",
                projectName: "AgentDeck",
                taskId: "task-1",
                boundarySignal: .sessionEnd,
                taskScore: 0.2,
                taskOutcome: "abandoned",
                taskCategory: "general",
                taskSummary: "10min session with no commit"
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.map { $0.entry.type }, [TimelineEntryType.taskStart])

        let header = timelineTaskHeaderDisplay(for: entries[0], in: entries)
        XCTAssertTrue(header.closed)
        XCTAssertEqual(header.title, "10min session with no commit")
        XCTAssertEqual(header.closureText, "Session end · 2 turns · 6m 5s")
        XCTAssertEqual(header.taskScore, 0.2)
        XCTAssertEqual(header.taskOutcome, "abandoned")
    }

    func testDashboardDisplayHidesInterruptedReaperClosurePair() {
        // Reaper-synthesized interrupted closures carry no judge payload —
        // the whole pair stays invisible instead of surfacing lifecycle noise.
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .taskStart,
                raw: "Task 1",
                agentType: "claude-code",
                projectName: "AgentDeck",
                taskId: "task-1"
            ),
            TimelineEntry(
                ts: 2000,
                type: .taskEnd,
                raw: "Interrupted · ~6h 33m",
                agentType: "claude-code",
                projectName: "AgentDeck",
                taskId: "task-1",
                boundarySignal: TaskBoundarySignal(rawValue: "interrupted")
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertTrue(displayed.isEmpty)
    }

    func testDashboardDisplayHidesSessionEndTaskBoundary() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .taskStart,
                raw: "Task 1",
                agentType: "claude-code",
                projectName: "AgentDeck",
                taskId: "task-1"
            ),
            TimelineEntry(
                ts: 2000,
                type: .chatResponse,
                raw: "Session handoff summary",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: 1500,
                endedAt: 2000,
                taskId: "task-1"
            ),
            TimelineEntry(
                ts: 2500,
                type: .taskEnd,
                raw: "Session end · 1s",
                agentType: "claude-code",
                projectName: "AgentDeck",
                taskId: "task-1",
                boundarySignal: .sessionEnd
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.map { $0.entry.type }, [TimelineEntryType.chatResponse])
    }

    func testDashboardDisplayHidesIdleGapTaskBoundary() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .taskStart,
                raw: "Task 1",
                agentType: "claude-code",
                projectName: "AgentDeck",
                taskId: "task-1"
            ),
            TimelineEntry(
                ts: 2000,
                type: .chatResponse,
                raw: "Attention implementation summary",
                agentType: "claude-code",
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: 1500,
                endedAt: 2000,
                taskId: "task-1"
            ),
            TimelineEntry(
                ts: 2500,
                type: .taskEnd,
                raw: "Idle gap · 928s",
                agentType: "claude-code",
                projectName: "AgentDeck",
                taskId: "task-1",
                boundarySignal: .idleGap
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.map { $0.entry.type }, [TimelineEntryType.chatResponse])
    }

    func testDashboardDisplayHidesModelCallAfterModelResponse() {
        let entries = [
            TimelineEntry(
                ts: 1000,
                type: .modelCall,
                raw: "자동 작업 · self improvement daily review 2350",
                agentType: "openclaw",
                automated: true,
                runId: "run-a"
            ),
            TimelineEntry(
                ts: 5000,
                type: .modelResponse,
                raw: "일일 리뷰 완료",
                agentType: "openclaw",
                runId: "run-a"
            ),
        ]

        let displayed = timelineDisplayGroupsForDashboard(groupConsecutive(entries))
        XCTAssertEqual(displayed.map(\.entry.type), [.modelResponse])
    }

    func testEvalResultsGroupByLastTimestampWithinTenMinutes() {
        let entries = [
            TimelineEntry(ts: 1000, type: .evalResult, raw: "★ run 60% [unknown] abandoned Added a new function", agentType: "openclaw", sessionId: "s1"),
            TimelineEntry(ts: 61_000, type: .evalResult, raw: "★ run 60% [unknown] abandoned Added a new function", agentType: "openclaw", sessionId: "s1"),
            TimelineEntry(ts: 121_000, type: .evalResult, raw: "★ run 60% [unknown] abandoned Added a new function", agentType: "openclaw", sessionId: "s1"),
        ]

        let grouped = groupConsecutive(entries)
        XCTAssertEqual(grouped.count, 1)
        XCTAssertEqual(grouped[0].count, 3)
    }

    #if os(macOS)
    func testDaemonTimelineStorePersistsAfterStart() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdeck-timeline-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("timeline.json")
        let store = DaemonTimelineStore(persistFile: file)
        await store.start()
        await store.add(DaemonTimelineEntry(
            ts: 1000,
            type: "chat_start",
            raw: "Persist this turn",
            detail: nil,
            approvalId: nil,
            status: nil,
            agentType: "claude-code",
            repeatCount: nil,
            automated: nil,
            projectName: "AgentDeck",
            sessionId: "s1",
            startedAt: 1000,
            endedAt: nil,
            runId: nil
        ))

        try await Task.sleep(for: .milliseconds(200))
        let data = try Data(contentsOf: file)
        let entries = try JSONDecoder().decode([DaemonTimelineEntry].self, from: data)
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].raw, "Persist this turn")
    }

    func testDaemonTimelineStoreDropsAnonymousCodexToolNoise() async {
        let store = DaemonTimelineStore()
        await store.add(DaemonTimelineEntry(
            ts: 1000,
            type: "tool_exec",
            raw: "exec completed",
            detail: nil,
            approvalId: nil,
            status: nil,
            agentType: "codex-cli",
            repeatCount: nil,
            automated: nil,
            projectName: nil,
            sessionId: "codex:otel-active",
            startedAt: nil,
            endedAt: nil,
            runId: nil
        ))
        await store.add(DaemonTimelineEntry(
            ts: 2000,
            type: "chat_start",
            raw: "Fix timeline grouping",
            detail: nil,
            approvalId: nil,
            status: nil,
            agentType: "codex-cli",
            repeatCount: nil,
            automated: nil,
            projectName: "AgentDeck",
            sessionId: "codex:thread-123456",
            startedAt: 2000,
            endedAt: nil,
            runId: nil
        ))

        let entries = await store.getAll()
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].raw, "Fix timeline grouping")
    }

    func testDaemonTimelineStoreDropsCodexCommandToolNoise() async {
        let store = DaemonTimelineStore()
        await store.add(DaemonTimelineEntry(
            ts: 1000,
            type: "tool_exec",
            raw: "Bash: git status --short",
            detail: "status: running\n{\"cmd\":\"git status --short\"}",
            approvalId: nil,
            status: "running",
            agentType: "codex-cli",
            repeatCount: nil,
            automated: nil,
            projectName: "AgentDeck",
            sessionId: "codex:thread-1",
            startedAt: nil,
            endedAt: nil,
            runId: nil
        ))
        await store.add(DaemonTimelineEntry(
            ts: 2000,
            type: "chat_start",
            raw: "Fix timeline noise",
            detail: nil,
            approvalId: nil,
            status: nil,
            agentType: "codex-cli",
            repeatCount: nil,
            automated: nil,
            projectName: "AgentDeck",
            sessionId: "codex:thread-1",
            startedAt: 2000,
            endedAt: nil,
            runId: nil
        ))

        let entries = await store.getAll()
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].type, "chat_start")
        XCTAssertEqual(entries[0].raw, "Fix timeline noise")
    }

    /// OpenClaw's transcript rows must survive the tool_exec-first rule.
    ///
    /// OpenClaw reaches the daemon over the Gateway WebSocket, which carries no
    /// tool calls at all — so its tool rows come from OpenClaw's own transcript
    /// and are the only account of what it did. Shedding them first did not thin
    /// them but deleted them: `add` appends then evicts, so on a full buffer the
    /// row just added was typically the only plain `tool_exec` present and
    /// evicted itself. Measured on the Node side 2026-08-23 and mirrored here
    /// because both daemons take turns owning `timeline.json`.
    func testDaemonTimelineStoreKeepsOpenClawToolRowsUnderPressure() async {
        let store = DaemonTimelineStore()
        // A busy machine: the buffer is already at capacity with other turns.
        for i in 0..<200 {
            await store.add(DaemonTimelineEntry(
                ts: Double(100 + i),
                type: "chat_response",
                raw: "reply \(i)",
                detail: nil,
                approvalId: nil,
                status: nil,
                agentType: "claude-code",
                repeatCount: nil,
                automated: nil,
                projectName: "AgentDeck",
                sessionId: "s\(i)",
                startedAt: nil,
                endedAt: nil,
                runId: nil
            ))
        }
        await store.add(DaemonTimelineEntry(
            ts: 9_000,
            type: "tool_exec",
            raw: "read · heartbeat-state.json",
            detail: "session: main\nok · exit 0",
            approvalId: nil,
            status: nil,
            agentType: "openclaw",
            repeatCount: nil,
            automated: nil,
            projectName: "OpenClaw",
            sessionId: "openclaw-gateway",
            startedAt: nil,
            endedAt: nil,
            runId: nil
        ))

        let entries = await store.getAll()
        XCTAssertLessThanOrEqual(entries.count, 200)
        XCTAssertTrue(
            entries.contains { $0.agentType == "openclaw" && $0.type == "tool_exec" },
            "OpenClaw transcript row evicted itself on insertion into a full buffer"
        )
    }

    /// Under buffer pressure the store sheds `tool_exec` before chat/turn rows —
    /// mirrors Node `BridgeTimelineStore.evictOne`. PTY `agentdeck claude`
    /// sessions emit claude-code tool_exec per tool action; only codex tool_exec
    /// is dropped at storage, so undifferentiated FIFO would otherwise evict a
    /// turn's chat_start before its own tool rows and orphan the response on
    /// `timeline_history` replay.
    func testDaemonTimelineStoreShedsToolExecBeforeChatStart() async {
        let store = DaemonTimelineStore()
        // The turn skeleton to preserve — chat_start is the oldest ts in its turn.
        await store.add(DaemonTimelineEntry(
            ts: 1,
            type: "chat_start",
            raw: "do a lot of work",
            detail: nil,
            approvalId: nil,
            status: nil,
            agentType: "claude-code",
            repeatCount: nil,
            automated: nil,
            projectName: "AgentDeck",
            sessionId: "s1",
            startedAt: 1,
            endedAt: nil,
            runId: nil
        ))
        // 250 claude-code tool_exec (PTY hook-lag fallback rows) overflow the
        // 200-entry cap. They pass the storage filter (only codex is dropped).
        for i in 0..<250 {
            await store.add(DaemonTimelineEntry(
                ts: Double(100 + i),
                type: "tool_exec",
                raw: "Edit file-\(i).ts",
                detail: nil,
                approvalId: nil,
                status: nil,
                agentType: "claude-code",
                repeatCount: nil,
                automated: nil,
                projectName: "AgentDeck",
                sessionId: "s1",
                startedAt: nil,
                endedAt: nil,
                runId: nil
            ))
        }

        let entries = await store.getAll()
        XCTAssertLessThanOrEqual(entries.count, 200)
        XCTAssertTrue(
            entries.contains { $0.type == "chat_start" && $0.raw == "do a lot of work" },
            "chat_start survives — tool_exec were shed first"
        )
    }
    #endif

    // MARK: - Type Icons (semantic key + ASCII fallback)

    func testTimelineIconKeys() {
        XCTAssertEqual(timelineIconKey(for: .chatStart), .running)
        XCTAssertEqual(timelineIconKey(for: .chatEnd), .success)
        XCTAssertEqual(timelineIconKey(for: .error), .error)
        XCTAssertEqual(timelineIconKey(for: .toolRequest), .awaiting)
        XCTAssertEqual(timelineIconKey(for: .toolRequest, status: "approved"), .success)
        XCTAssertEqual(timelineIconKey(for: .toolRequest, status: "denied"), .error)
        XCTAssertEqual(timelineIconKey(for: .taskStart), .task)
        XCTAssertEqual(timelineIconKey(for: .taskEnd), .task)
    }

    func testTypeIconsAsciiFallback() {
        // ASCII fallback used by preview snapshots / monospaced contexts.
        // SwiftUI renders the SF Symbol via `sfSymbol(for:)`; this glyph
        // is the secondary surface.
        XCTAssertEqual(timelineTypeIcon(for: .chatStart), "▶")
        XCTAssertEqual(timelineTypeIcon(for: .chatEnd), "✓")
        XCTAssertEqual(timelineTypeIcon(for: .error), "✗")
        XCTAssertEqual(timelineTypeIcon(for: .toolRequest), "⏳")
    }

    // MARK: - Queued / superseded (folded) prompt detection

    /// Real scenario: two prompts submitted ~26 s apart to one observed Codex
    /// session. Codex coalesces them into one turn and emits a single Stop,
    /// stamped to the *second* prompt's anchor. The response therefore merges
    /// into the later turn, leaving the first as a queued/folded prompt. The
    /// first must be detected as superseded (→ fold glyph), and the second as
    /// the turn that absorbed it (→ "shared" tag) — not a spinning orphan.
    func testQueuedPromptFoldsIntoNextTurn() {
        let entries = [
            TimelineEntry(ts: 1000, type: .chatStart, raw: "commit the rest", sessionId: "codex:x", startedAt: 1000),
            TimelineEntry(ts: 2000, type: .chatStart, raw: "push too", sessionId: "codex:x", startedAt: 2000),
            TimelineEntry(ts: 3000, type: .chatResponse, raw: "committed + pushed", sessionId: "codex:x", startedAt: 2000, endedAt: 3000),
            TimelineEntry(ts: 3001, type: .chatEnd, raw: "Completed · 57s", sessionId: "codex:x", startedAt: 2000, endedAt: 3001),
        ]
        let grouped = groupConsecutive(entries)
        // The response/end anchor (startedAt 2000) folds into the 2nd start.
        XCTAssertEqual(grouped.count, 2)
        XCTAssertNil(grouped[0].mergedResponse, "first prompt keeps no response of its own")
        XCTAssertFalse(grouped[0].hasResponse)
        XCTAssertEqual(grouped[1].mergedResponse?.raw, "committed + pushed")

        // First prompt is superseded by the second (folded), not orphaned.
        let superseding = timelineSupersedingGroup(for: grouped[0], at: 0, in: grouped)
        XCTAssertNotNil(superseding, "first prompt should fold into the answered turn")
        XCTAssertEqual(superseding?.mergedResponse?.raw, "committed + pushed")
        // The second prompt absorbed a queued predecessor.
        XCTAssertTrue(timelineAbsorbsQueuedPrompt(for: grouped[1], at: 1, in: grouped))
        // The second prompt itself is not folded.
        XCTAssertNil(timelineSupersedingGroup(for: grouped[1], at: 1, in: grouped))
    }

    /// A normally-answered turn is never treated as folded.
    func testAnsweredTurnIsNotFolded() {
        let entries = [
            TimelineEntry(ts: 1000, type: .chatStart, raw: "hi", sessionId: "s1", startedAt: 1000),
            TimelineEntry(ts: 2000, type: .chatResponse, raw: "hello", sessionId: "s1", startedAt: 1000, endedAt: 2000),
        ]
        let grouped = groupConsecutive(entries)
        XCTAssertEqual(grouped.count, 1)
        XCTAssertNil(timelineSupersedingGroup(for: grouped[0], at: 0, in: grouped))
        XCTAssertFalse(timelineAbsorbsQueuedPrompt(for: grouped[0], at: 0, in: grouped))
    }

    /// A genuinely-open live turn (nothing has answered the batch yet) must NOT
    /// be marked folded — there is no shared reply to point at.
    func testStillOpenQueuedPromptsAreNotFolded() {
        let entries = [
            TimelineEntry(ts: 1000, type: .chatStart, raw: "first", sessionId: "s1", startedAt: 1000),
            TimelineEntry(ts: 2000, type: .chatStart, raw: "second", sessionId: "s1", startedAt: 2000),
        ]
        let grouped = groupConsecutive(entries)
        XCTAssertEqual(grouped.count, 2)
        XCTAssertNil(timelineSupersedingGroup(for: grouped[0], at: 0, in: grouped),
                     "no answer yet → not folded, still live")
        XCTAssertNil(timelineSupersedingGroup(for: grouped[1], at: 1, in: grouped))
    }

    /// A same-session session boundary between the two prompts means the first
    /// closed on its own boundary — it is orphaned by session end, not folded.
    func testTaskEndBoundaryBlocksFold() {
        let entries = [
            TimelineEntry(ts: 1000, type: .chatStart, raw: "orphaned", sessionId: "s1", startedAt: 1000),
            TimelineEntry(ts: 1500, type: .taskEnd, raw: "Session end", sessionId: "s1", taskId: "t1"),
            TimelineEntry(ts: 2000, type: .chatStart, raw: "next session prompt", sessionId: "s1", startedAt: 2000),
            TimelineEntry(ts: 3000, type: .chatResponse, raw: "reply", sessionId: "s1", startedAt: 2000, endedAt: 3000),
        ]
        let grouped = groupConsecutive(entries)
        let firstStart = grouped.first { $0.entry.raw == "orphaned" }!
        let idx = grouped.firstIndex { $0.id == firstStart.id }!
        XCTAssertNil(timelineSupersedingGroup(for: firstStart, at: idx, in: grouped),
                     "task_end boundary blocks folding across sessions")
    }
}

// MARK: - Day Break

/// Day-break policy. Mirrors Kotlin `TimelineDayBreakTest` in
/// android/app/src/test/kotlin/dev/agentdeck/ui/monitor/ — the two suites
/// assert the same cases so the platforms can't drift.
final class TimelineDayBreakTests: XCTestCase {

    private let seoul: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Seoul")!
        return cal
    }()

    private let utc: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }()

    /// Fri 2026-07-17 14:30 KST.
    private var now: Date { at(2026, 7, 17, 14, 30) }

    private func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int, in cal: Calendar? = nil) -> Date {
        (cal ?? seoul).date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
    }

    private func groups(_ dates: Date...) -> [GroupedEntry] {
        dates.map { date in
            let entry = TimelineEntry(ts: date.timeIntervalSince1970 * 1000, type: .chatStart, raw: "turn")
            return GroupedEntry(entry: entry, lastTs: entry.ts)
        }
    }

    func testAllTodayBufferGetsNoSeparatorAtAll() {
        let grouped = groups(at(2026, 7, 17, 9, 0), at(2026, 7, 17, 10, 0))
        XCTAssertNil(timelineDayBreakLabel(at: 0, in: grouped, now: now, calendar: seoul))
        XCTAssertNil(timelineDayBreakLabel(at: 1, in: grouped, now: now, calendar: seoul))
    }

    func testSeparatorLandsOnFirstRowOfNewDay() {
        let grouped = groups(at(2026, 7, 16, 23, 50), at(2026, 7, 17, 0, 10))
        XCTAssertEqual(timelineDayBreakLabel(at: 0, in: grouped, now: now, calendar: seoul), "YESTERDAY")
        XCTAssertEqual(timelineDayBreakLabel(at: 1, in: grouped, now: now, calendar: seoul), "TODAY")
    }

    func testIndexZeroAnchorsOlderBufferButStaysSilentOnToday() {
        XCTAssertEqual(
            timelineDayBreakLabel(at: 0, in: groups(at(2026, 7, 15, 9, 0)), now: now, calendar: seoul),
            "WED, JUL 15"
        )
        XCTAssertNil(
            timelineDayBreakLabel(at: 0, in: groups(at(2026, 7, 17, 9, 0)), now: now, calendar: seoul)
        )
    }

    func testDayOlderThanThisYearCarriesTheYear() {
        let grouped = groups(at(2025, 12, 31, 9, 0), at(2026, 7, 17, 9, 0))
        XCTAssertEqual(timelineDayBreakLabel(at: 0, in: grouped, now: now, calendar: seoul), "DEC 31, 2025")
        XCTAssertEqual(timelineDayBreakLabel(at: 1, in: grouped, now: now, calendar: seoul), "TODAY")
    }

    func testSameInstantReadsAsDifferentDayAcrossZones() {
        // 2026-07-17 08:30 KST == 2026-07-16 23:30 UTC. The separator must
        // follow the viewer's zone, not the stored epoch.
        let grouped = groups(at(2026, 7, 16, 23, 50), at(2026, 7, 17, 8, 30))
        XCTAssertEqual(timelineDayBreakLabel(at: 1, in: grouped, now: now, calendar: seoul), "TODAY")
        XCTAssertNil(timelineDayBreakLabel(at: 1, in: grouped, now: now, calendar: utc))
    }

    func testOutOfRangeIndexYieldsNoSeparator() {
        let grouped = groups(at(2026, 7, 17, 9, 0))
        XCTAssertNil(timelineDayBreakLabel(at: -1, in: grouped, now: now, calendar: seoul))
        XCTAssertNil(timelineDayBreakLabel(at: 1, in: grouped, now: now, calendar: seoul))
    }
}
