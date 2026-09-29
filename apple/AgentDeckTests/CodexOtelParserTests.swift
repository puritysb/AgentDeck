#if os(macOS)
import XCTest
@testable import AgentDeck

final class CodexOtelParserTests: XCTestCase {

    // Real Codex thread ids are UUIDv7-shaped (≥12 chars, contain non-digits).
    // The test sentinels below mirror that shape so the parser's
    // `isDurableSessionId` guard accepts them — `t1`/`t2`/`t-tool`-style
    // shortcuts would now be rejected as phantom-prone, and rightly so.
    private let tid1 = "thread-test-01"
    private let tid2 = "thread-test-02"
    private let tid3 = "thread-test-03"
    private let tid4 = "thread-test-04"
    private let tid5 = "thread-test-05"
    private let tidLog = "thread-test-log"
    private let tidCurrent = "thread-test-current"
    private let tidStream = "thread-test-stream"
    private let tidTool = "thread-test-tool"

    func testTurnStartFromTopLevelTurn() {
        let json = otlp(spans: [
            ["name": "codex.turn", "attributes": attr(["codex.thread_id": tid1, "codex.turn_id": "u1", "cwd": "/repo"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: tid1, turnId: "u1", cwd: "/repo")]
        )
    }

    func testFullTurnSequence() {
        let json = otlp(spans: [
            ["name": "codex.turn.start", "attributes": attr(["codex.thread_id": tid2, "codex.turn_id": "u2"])],
            ["name": "codex.tool.call", "attributes": attr(["codex.thread_id": tid2, "codex.turn_id": "u2", "tool.name": "Read"])],
            ["name": "codex.tool.result", "attributes": attr(["codex.thread_id": tid2, "codex.turn_id": "u2"])],
            ["name": "codex.turn.end", "attributes": attr(["codex.thread_id": tid2, "codex.turn_id": "u2"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [
                .turnStart(threadId: tid2, turnId: "u2", cwd: nil),
                .toolCall(threadId: tid2, turnId: "u2", tool: "Read", cwd: nil),
                .toolResult(threadId: tid2, turnId: "u2"),
                .turnEnd(threadId: tid2, turnId: "u2"),
            ]
        )
    }

    func testObservedCodexNamesFromTuiLog() {
        let json = otlp(spans: [
            ["name": "op.dispatch.user_input_with_turn_context", "attributes": attr(["thread.id": tidLog, "turn.id": "u-log", "cwd": "/repo"])],
            ["name": "session_task.turn", "attributes": attr(["thread.id": tidLog, "turn.id": "u-log"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [
                .turnStart(threadId: tidLog, turnId: "u-log", cwd: "/repo"),
                .turnEnd(threadId: tidLog, turnId: "u-log"),
            ]
        )
    }

    func testSlashDelimitedTurnStartFromCurrentCodexOtel() {
        let json = otlp(spans: [
            ["name": "turn/start", "attributes": attr(["thread.id": tidCurrent, "turn.id": "u-current", "cwd": "/repo"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: tidCurrent, turnId: "u-current", cwd: "/repo")]
        )
    }

    func testTraceBackedTurnStartWithoutThreadIdUsesAnonymousFallback() {
        let traceId = "8b0e3fb4a3f24585b17c4d85f38c0b41"
        let json = otlp(spans: [
            ["traceId": traceId, "name": "turn/start", "attributes": attr([:])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: "otel-active", turnId: traceId, cwd: nil)]
        )
    }

    func testTraceFallbackDoesNotOverrideDurableThreadId() {
        let traceId = "8b0e3fb4a3f24585b17c4d85f38c0b41"
        let json = otlp(spans: [
            ["traceId": traceId, "name": "turn/start", "attributes": attr([
                "thread.id": tidCurrent,
                "turn.id": "u-current",
                "cwd": "/repo",
            ])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: tidCurrent, turnId: "u-current", cwd: "/repo")]
        )
    }

    func testCurrentCwdAliasesAreAccepted() {
        for key in ["process.cwd", "terminal.cwd", "workspace.root", "workspace.path", "project.root", "project.path"] {
            let json = otlp(spans: [
                ["name": "turn/start", "attributes": attr([
                    "thread.id": tidCurrent,
                    "turn.id": "u-current",
                    key: "/Users/puritysb/github/AgentDeck",
                ])]
            ])
            XCTAssertEqual(
                CodexTelemetryModule.parse(json),
                [.turnStart(threadId: tidCurrent, turnId: "u-current", cwd: "/Users/puritysb/github/AgentDeck")],
                "cwd alias \(key) should be accepted"
            )
        }
    }

    func testResourceLevelCwdAliasFallsThrough() {
        let json: [String: Any] = [
            "resourceSpans": [[
                "resource": ["attributes": attr(["workspace.root": "/repo"])],
                "scopeSpans": [["spans": [
                    ["name": "turn/start", "attributes": attr(["thread.id": tidCurrent, "turn.id": "u-resource"])]
                ]]]
            ]]
        ]
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: tidCurrent, turnId: "u-resource", cwd: "/repo")]
        )
    }

    /// Codex Desktop only puts cwd on the turn-boundary span, so a same-batch
    /// `tool.call` lands without its own cwd attribute. Trace-level cwd
    /// (from resource attrs OR a sibling span — here a sibling) must be
    /// propagated to the toolCall event, otherwise the daemon inserts a
    /// blank-projectName placeholder that the empty→non-empty upgrade
    /// guard in `ensureCodexSession` can never refill.
    func testToolCallInheritsTraceLevelCwd() {
        let json = otlp(spans: [
            ["name": "codex.turn.start", "attributes": attr(["thread.id": tidCurrent, "turn.id": "u-batch", "cwd": "/Users/me/proj"])],
            ["name": "codex.tool.call", "attributes": attr(["thread.id": tidCurrent, "turn.id": "u-batch", "tool.name": "Read"])],
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [
                .turnStart(threadId: tidCurrent, turnId: "u-batch", cwd: "/Users/me/proj"),
                .toolCall(threadId: tidCurrent, turnId: "u-batch", tool: "Read", cwd: "/Users/me/proj"),
            ]
        )
    }

    /// Same as above but for `activity` spans (the other event type that
    /// the daemon uses to insert/upgrade a session row).
    func testActivityInheritsTraceLevelCwd() {
        let json: [String: Any] = [
            "resourceSpans": [[
                "resource": ["attributes": attr(["workspace.root": "/Users/me/proj"])],
                "scopeSpans": [["spans": [
                    ["name": "receiving", "attributes": attr(["thread.id": tidStream, "turn.id": "u-act"])]
                ]]]
            ]]
        ]
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.activity(threadId: tidStream, turnId: "u-act", name: "receiving", cwd: "/Users/me/proj")]
        )
    }

    /// Standalone toolCall (no turnStart sibling, no resource cwd) without
    /// its own cwd attribute must surface `cwd: nil`. Guards against
    /// over-eager fallback that could borrow cwd from a previous unrelated
    /// batch.
    func testToolCallWithoutAnyCwdRemainsNil() {
        let json = otlp(spans: [
            ["name": "codex.tool.call", "attributes": attr(["thread.id": tidTool, "turn.id": "u-lone", "tool.name": "Bash"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.toolCall(threadId: tidTool, turnId: "u-lone", tool: "Bash", cwd: nil)]
        )
    }

    /// Critical: cwd fallback must NOT leak across threads. When two Codex
    /// sessions are active under a single OTel exporter, the same batch can
    /// hold session A's turnStart (with cwd) and session B's toolCall
    /// (without cwd). Session B's toolCall must NOT borrow session A's cwd
    /// or the dashboard would label the wrong project for B (Codex
    /// stop-time review caught this on 2026-05-15).
    func testCwdFallbackIsScopedToThreadId() {
        let tidA = "thread-test-A-uuid-01"
        let tidB = "thread-test-B-uuid-02"
        let json = otlp(spans: [
            ["name": "codex.turn.start", "attributes": attr(["thread.id": tidA, "turn.id": "u-A", "cwd": "/Users/me/proj-a"])],
            ["name": "codex.tool.call", "attributes": attr(["thread.id": tidB, "turn.id": "u-B", "tool.name": "Read"])],
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [
                .turnStart(threadId: tidA, turnId: "u-A", cwd: "/Users/me/proj-a"),
                .toolCall(threadId: tidB, turnId: "u-B", tool: "Read", cwd: nil),
            ],
            "Thread B's toolCall must not inherit thread A's cwd"
        )
    }

    /// CRITICAL: a tool/activity span's OWN cwd attribute is ignored — it
    /// typically carries a per-call subprocess cwd (e.g. `process.cwd` on
    /// `exec_command` pointing at /tmp or a sub-directory). If that span-
    /// local cwd surfaced through the event, the daemon's
    /// `ensureCodexSession` upgrade guard (fires once, empty→non-empty)
    /// would permanently lock the dashboard's projectName at the wrong
    /// path. Codex stop-time review caught this 2026-05-17. The toolCall
    /// event must reflect the session-level cwd from turnStart/resource
    /// fallback, not its own attribute.
    func testToolCallOwnCwdAttrIgnoredAsSubprocessCwd() {
        let json = otlp(spans: [
            ["name": "codex.turn.start", "attributes": attr(["thread.id": tidCurrent, "turn.id": "u-mix", "cwd": "/Users/me/proj-a"])],
            ["name": "codex.tool.call", "attributes": attr(["thread.id": tidCurrent, "turn.id": "u-mix", "tool.name": "Read", "process.cwd": "/tmp/subprocess"])],
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [
                .turnStart(threadId: tidCurrent, turnId: "u-mix", cwd: "/Users/me/proj-a"),
                .toolCall(threadId: tidCurrent, turnId: "u-mix", tool: "Read", cwd: "/Users/me/proj-a"),
            ],
            "toolCall's process.cwd must NOT override the session-level cwd from turnStart fallback"
        )
    }

    /// Lone tool span (no turnStart, no resource cwd) carrying its own
    /// cwd attribute must NOT surface that cwd on the event. Otherwise it
    /// becomes the first non-empty projectName in cachedSessions and the
    /// daemon's one-shot upgrade guard locks the wrong label forever.
    func testLoneToolSpanProcessCwdDoesNotProduceSessionCwd() {
        let json = otlp(spans: [
            ["name": "exec_command", "attributes": attr(["thread.id": tidTool, "turn.id": "u-lone", "process.cwd": "/tmp/exec"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.toolCall(threadId: tidTool, turnId: "u-lone", tool: "exec", cwd: nil)],
            "Lone tool span's process.cwd must NOT become the session cwd"
        )
    }

    /// Same lock-prevention rule for `activity` spans. An anomalous cwd
    /// attribute on a non-turnStart span must not be promoted to the event.
    func testLoneActivityOwnCwdAttrIsIgnored() {
        let json = otlp(spans: [
            ["name": "receiving", "attributes": attr(["thread.id": tidStream, "turn.id": "u-act", "cwd": "/tmp/wrong"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.activity(threadId: tidStream, turnId: "u-act", name: "receiving", cwd: nil)],
            "activity span's own cwd attribute is ignored — only turnStart / resource cwd is trusted"
        )
    }

    func testCurrentCodexActivitySpansAreRecognized() {
        let json = otlp(spans: [
            ["name": "responses_websocket.stream_request", "attributes": attr(["thread.id": tidStream, "turn.id": "u-stream"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.activity(threadId: tidStream, turnId: "u-stream", name: "responses_websocket.stream_request", cwd: nil)]
        )
    }

    func testTraceBackedActivityWithoutThreadIdUsesAnonymousFallback() {
        let traceId = "b9ab795c48bd4e128317e68e7fb7b861"
        let json = otlp(spans: [
            ["traceId": traceId, "name": "receiving", "attributes": attr([:])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.activity(threadId: "otel-active", turnId: traceId, name: "receiving", cwd: nil)]
        )
    }

    func testExecCommandRecognizedAsToolCall() {
        let json = otlp(spans: [
            ["name": "exec_command", "attributes": attr(["thread.id": tidTool, "turn.id": "u-tool"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.toolCall(threadId: tidTool, turnId: "u-tool", tool: "exec", cwd: nil)]
        )
    }

    func testNumericSessionIdDoesNotBecomeThreadId() {
        let json = otlp(spans: [
            ["name": "turn/start", "attributes": attr(["session_id": "8", "turn.id": "u-short"])]
        ])
        XCTAssertEqual(CodexTelemetryModule.parse(json), [])
    }

    /// Short / numeric thread-id attrs must be filtered before they reach
    /// the dispatch table — otherwise `handleCodexTrace.turnStart` would
    /// synthesize phantom `codex:11` rows from companion-task spans, the
    /// same pattern the hook path was hardened against on 2026-05-03.
    /// Covers every key alias `threadIdAttr` reads.
    func testShortNumericThreadIdAttrsAreFiltered() {
        for key in ["codex.thread_id", "codex.thread.id", "thread.id", "thread_id", "threadId"] {
            for badValue in ["11", "8", "12345", "12345678901234"] {
                let json = otlp(spans: [
                    ["name": "turn/start", "attributes": attr([key: badValue, "turn.id": "u-x", "cwd": "/repo"])]
                ])
                XCTAssertEqual(
                    CodexTelemetryModule.parse(json),
                    [],
                    "key=\(key) value=\(badValue) must not synthesize a thread"
                )
            }
        }
    }

    /// UUID-shaped thread-id attrs are the real-world case and must pass.
    func testUuidThreadIdAttrIsAccepted() {
        let uuid = "019dee40-c853-74e0-b46d-dae33eb1d02b"
        let json = otlp(spans: [
            ["name": "turn/start", "attributes": attr(["thread_id": uuid, "turn.id": "u-x", "cwd": "/repo"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: uuid, turnId: "u-x", cwd: "/repo")]
        )
    }

    /// Mixed-alias spans: when both a short companion-task id and the real
    /// thread UUID are emitted on the same span, the earlier alias must
    /// not short-circuit alias scanning. A naïve "first non-empty +
    /// isDurable guard" reads the short value, fails the guard, drops the
    /// span entirely — wasting the good UUID waiting in the next alias.
    /// Iterating every alias for the first durable match keeps these
    /// spans intact.
    func testAliasScanPicksDurableOverShortInSameSpan() {
        let uuid = "019dee40-c853-74e0-b46d-dae33eb1d02b"
        // codex.thread_id is scanned first (short, non-durable).
        // thread.id is scanned later (durable UUID — must win).
        let json = otlp(spans: [
            ["name": "turn/start", "attributes": attr([
                "codex.thread_id": "11",
                "thread.id": uuid,
                "turn.id": "u-mix",
                "cwd": "/repo",
            ])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: uuid, turnId: "u-mix", cwd: "/repo")],
            "Short thread_id alias must not poison scanning when a durable alias is present on the same span"
        )
    }

    /// `session_id` fallback also scans aliases; same trap applies if
    /// `session_id` is short but `session.id` is durable.
    func testAliasScanPicksDurableSessionIdFallback() {
        let uuid = "019dda49-2ce1-7a62-8fdc-4b7753b6bd0b"
        let json = otlp(spans: [
            ["name": "turn/start", "attributes": attr([
                "session_id": "8",
                "session.id": uuid,
                "turn.id": "u-sx",
                "cwd": "/repo",
            ])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: uuid, turnId: "u-sx", cwd: "/repo")],
            "Short session_id alias must not poison the fallback path either"
        )
    }

    func testIgnoresUnknownSpan() {
        let json = otlp(spans: [
            ["name": "codex.heartbeat", "attributes": attr(["codex.thread_id": tid3])]
        ])
        XCTAssertEqual(CodexTelemetryModule.parse(json), [])
    }

    func testMissingThreadIdSkips() {
        let json = otlp(spans: [
            ["name": "codex.turn", "attributes": attr(["cwd": "/repo"])]
        ])
        XCTAssertEqual(CodexTelemetryModule.parse(json), [])
    }

    func testUnderscoreVariantNormalizedToDot() {
        // `codex.tool_call` (underscored) and `tool` (vs `tool.name`) are
        // both legal — schema is not nailed down in Codex 1.x yet.
        let json = otlp(spans: [
            ["name": "codex.tool_call", "attributes": attr(["thread_id": tid4, "tool": "Bash"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.toolCall(threadId: tid4, turnId: "", tool: "Bash", cwd: nil)]
        )
    }

    func testAttributeFromResourceFallsThrough() {
        // Resource-level attribute should populate threadId when the span
        // itself doesn't carry one (some exporters emit thread_id only on
        // the resource because it's batch-stable).
        let json: [String: Any] = [
            "resourceSpans": [[
                "resource": ["attributes": attr(["codex.thread_id": "from-resource"])],
                "scopeSpans": [["spans": [
                    ["name": "codex.turn.end", "attributes": attr([:])]
                ]]]
            ]]
        ]
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnEnd(threadId: "from-resource", turnId: "")]
        )
    }

    func testIntValueAttributeAccepted() {
        // OTLP ints arrive as either Int or stringified — we just need the
        // span name to dispatch correctly even when other attrs are int.
        let json = otlp(spans: [
            ["name": "codex.turn.start", "attributes": [
                ["key": "codex.thread_id", "value": ["stringValue": tid5]],
                ["key": "codex.turn_id", "value": ["intValue": "42"]],  // stringified int
            ]]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: tid5, turnId: "42", cwd: nil)]
        )
    }

    func testSpanNameSummaryForDiagnostics() {
        let json = otlp(spans: [
            ["name": "unknown.one", "attributes": attr([:])],
            ["name": "unknown.two", "attributes": attr([:])]
        ])
        XCTAssertEqual(CodexTelemetryModule.spanNameSummary(json), "unknown.one,unknown.two")
    }

    func testEmptyResourceSpansReturnsEmpty() {
        XCTAssertEqual(CodexTelemetryModule.parse(["resourceSpans": []]), [])
        XCTAssertEqual(CodexTelemetryModule.parse([:]), [])
    }

    func testCodexHookIdentityPrefersThreadId() {
        let key = CodexHookIdentity.sessionKey(from: [
            "thread_id": "019dda47-b912-7ec3-b97b-2fefad9d4699",
            "session_id": "8",
        ])
        XCTAssertEqual(key, "codex:019dda47-b912-7ec3-b97b-2fefad9d4699")
    }

    func testCodexHookIdentityRejectsNumericSessionFallback() {
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["session_id": "8"]))
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["session_id": "1234567890"]))
    }

    func testCodexHookIdentityAcceptsDurableSessionFallback() {
        let key = CodexHookIdentity.sessionKey(from: [
            "session_id": "019dda49-2ce1-7a62-8fdc-4b7753b6bd0b",
        ])
        XCTAssertEqual(key, "codex:019dda49-2ce1-7a62-8fdc-4b7753b6bd0b")
    }

    func testPostTerminalCodexProgressPredicate() {
        XCTAssertTrue(DaemonServer.shouldIgnorePostTerminalCodexProgressForTest(event: "codex_tool_start"))
        XCTAssertTrue(DaemonServer.shouldIgnorePostTerminalCodexProgressForTest(event: "codex_tool_end"))
        XCTAssertFalse(DaemonServer.shouldIgnorePostTerminalCodexProgressForTest(event: "codex_user_prompt_submit"))
    }

    func testCodexOtelActivityOnlyKeepsAlreadyProcessingSessionsFresh() {
        XCTAssertTrue(DaemonServer.shouldUseCodexOtelActivityForState(existingState: "processing"))
        XCTAssertFalse(DaemonServer.shouldUseCodexOtelActivityForState(existingState: nil))
        XCTAssertFalse(DaemonServer.shouldUseCodexOtelActivityForState(existingState: "idle"))
        XCTAssertFalse(DaemonServer.shouldUseCodexOtelActivityForState(existingState: "awaiting_permission"))
    }

    func testAnonymousCodexOtelThreadDoesNotDriveSessionState() {
        XCTAssertFalse(DaemonServer.shouldUseCodexOtelThreadForSessionState(threadId: "otel-active"))
        XCTAssertTrue(DaemonServer.shouldUseCodexOtelThreadForSessionState(threadId: "019f364e-d68c-7c33-9215-069c76458d62"))
    }

    func testCodexRolloutReaderPrefersTaskCompleteLastAgentMessage() throws {
        let root = try makeTempSessionsRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let sid = "019f364e-d68c-7c33-9215-069c76458d62"
        try writeRollout(root: root, sessionId: sid, lines: [
            ["type": "event_msg", "payload": ["type": "agent_message", "message": "intermediate reply"]],
            ["type": "event_msg", "payload": ["type": "task_complete", "last_agent_message": "authoritative reply"]],
        ])

        XCTAssertEqual(
            CodexRolloutResponseReader.lastAgentMessage(sessionId: "codex:\(sid)", sessionsRoot: root),
            "authoritative reply"
        )
    }

    func testCodexRolloutReaderFallsBackToNewestAgentMessage() throws {
        let root = try makeTempSessionsRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let sid = "019f364e-d68c-7c33-9215-069c76458d63"
        try writeRollout(root: root, sessionId: sid, lines: [
            ["type": "event_msg", "payload": ["type": "agent_message", "message": "older reply"]],
            ["type": "event_msg", "payload": ["type": "agent_message", "message": "newest reply"]],
        ])

        XCTAssertEqual(
            CodexRolloutResponseReader.lastAgentMessage(sessionId: sid, sessionsRoot: root),
            "newest reply"
        )
    }

    // MARK: - Hook/OTel ownership (issue #411)

    private func ownershipBatch(_ thread: String, turn: String = "turn-1") -> [CodexSpanEvent] {
        CodexTelemetryModule.parse(otlp(spans: [
            ["name": "turn/start", "attributes": attr(["thread.id": thread, "turn.id": turn])],
            ["name": "codex.tool.call", "attributes": attr(["thread.id": thread, "turn.id": turn, "tool.name": "Read"])],
            ["name": "codex.tool.result", "attributes": attr(["thread.id": thread, "turn.id": turn])],
            ["name": "receiving", "attributes": attr(["thread.id": thread, "turn.id": turn])],
            ["name": "session_task.turn", "attributes": attr(["thread.id": thread, "turn.id": turn])],
        ]))
    }

    func testHookStopRejectsExitTimeOtelBatchBeforeAndAfterRowEviction() {
        var owner = CodexObservationOwnership()
        let start = Date(timeIntervalSince1970: 100)
        let sid = "codex:" + tidCurrent
        for event in ["codex_session_start", "codex_user_prompt_submit", "codex_stop"] {
            owner.receiveHook(event: event, sessionId: sid, now: start)
        }
        let batch = ownershipBatch(tidCurrent)
        XCTAssertEqual(batch.count, 5)
        XCTAssertTrue(owner.admittingOtel(batch).isEmpty)
        // The roster's short post-terminal window expires before the
        // ownership/tombstone window. A late batch must still stay dead.
        owner.prune(before: start.addingTimeInterval(-1), retaining: [])
        XCTAssertTrue(owner.admittingOtel(batch).isEmpty)
        // Even past the ownership cutoff, a retained terminal record wins.
        owner.prune(before: start.addingTimeInterval(1), retaining: [sid])
        XCTAssertTrue(owner.admittingOtel(batch).isEmpty)
    }

    func testOtelCannotOverrideHookPermissionOrCloseNextHookTurn() {
        var owner = CodexObservationOwnership()
        let now = Date(timeIntervalSince1970: 100)
        let sid = "codex:" + tidCurrent
        owner.receiveHook(event: "codex_permission_request", sessionId: sid, now: now)
        XCTAssertTrue(owner.admittingOtel(ownershipBatch(tidCurrent)).isEmpty)
        owner.receiveHook(event: "codex_stop", sessionId: sid, now: now)
        owner.receiveHook(event: "codex_user_prompt_submit", sessionId: sid, now: now)
        XCTAssertTrue(owner.admittingOtel(ownershipBatch(tidCurrent, turn: "prior-turn")).isEmpty)
    }

    func testOtelOnlyAndNotifyOnlyThreadsRetainAllEvents() {
        var owner = CodexObservationOwnership()
        let batch = ownershipBatch(tidCurrent)
        XCTAssertEqual(owner.admittingOtel(batch), batch)
        // Notify has no start signal; claiming ownership here would make
        // every subsequent OTel-only turn invisible.
        owner.receiveHook(event: "codex_turn_complete", sessionId: "codex:" + tidCurrent,
                          now: Date(timeIntervalSince1970: 100))
        XCTAssertEqual(owner.admittingOtel(batch), batch)
    }

    func testHookTakeoverIsPerThreadAndPreservesOtherBatchOrder() {
        var owner = CodexObservationOwnership()
        let first = ownershipBatch(tid1)
        let second = ownershipBatch(tid2)
        XCTAssertEqual(owner.admittingOtel(first), first)
        owner.receiveHook(event: "codex_tool_start", sessionId: "codex:" + tid1,
                          now: Date(timeIntervalSince1970: 100))
        XCTAssertEqual(owner.admittingOtel(first + second), second)
    }

    func testOwnershipExpiresWithoutRowOrTombstoneAndOtelDoesNotRenewIt() {
        var owner = CodexObservationOwnership()
        let now = Date(timeIntervalSince1970: 100)
        let sid = "codex:" + tidCurrent
        owner.receiveHook(event: "codex_stop", sessionId: sid, now: now)
        let batch = ownershipBatch(tidCurrent)
        XCTAssertTrue(owner.admittingOtel(batch).isEmpty)
        owner.prune(before: now, retaining: [])
        XCTAssertTrue(owner.admittingOtel(batch).isEmpty)
        owner.prune(before: now.addingTimeInterval(1), retaining: [])
        XCTAssertEqual(owner.admittingOtel(batch), batch)
    }

    func testLiveHookOwnershipSurvivesCutoffAndNewHookRenewsIt() {
        var owner = CodexObservationOwnership()
        let now = Date(timeIntervalSince1970: 100)
        let sid = "codex:" + tidCurrent
        let batch = ownershipBatch(tidCurrent)
        owner.receiveHook(event: "codex_session_start", sessionId: sid, now: now)
        owner.prune(before: now.addingTimeInterval(1), retaining: [sid])
        XCTAssertTrue(owner.admittingOtel(batch).isEmpty)
        owner.receiveHook(event: "codex_user_prompt_submit", sessionId: sid,
                          now: now.addingTimeInterval(2))
        owner.prune(before: now.addingTimeInterval(1), retaining: [])
        XCTAssertTrue(owner.admittingOtel(batch).isEmpty)
    }

    // MARK: - Helpers

    private func makeTempSessionsRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdeck-codex-rollout-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func writeRollout(root: URL, sessionId: String, lines: [[String: Any]]) throws {
        let dir = root
            .appendingPathComponent("2026", isDirectory: true)
            .appendingPathComponent("07", isDirectory: true)
            .appendingPathComponent("06", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("rollout-2026-07-06T00-00-00-\(sessionId).jsonl")
        let body = try lines.map { record -> String in
            let data = try JSONSerialization.data(withJSONObject: record)
            return String(data: data, encoding: .utf8) ?? ""
        }.joined(separator: "\n")
        try body.write(to: file, atomically: true, encoding: .utf8)
    }

    private func otlp(spans: [[String: Any]]) -> [String: Any] {
        return [
            "resourceSpans": [[
                "scopeSpans": [["spans": spans]]
            ]]
        ]
    }

    /// Wrap a flat dict into OTLP's `{key, value: {stringValue}}` array.
    /// String / int / bool dispatch automatically by Swift type.
    private func attr(_ dict: [String: Any]) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for (key, value) in dict {
            let wrap: [String: Any]
            if let s = value as? String { wrap = ["stringValue": s] }
            else if let i = value as? Int { wrap = ["intValue": i] }
            else if let b = value as? Bool { wrap = ["boolValue": b] }
            else { wrap = ["stringValue": String(describing: value)] }
            out.append(["key": key, "value": wrap])
        }
        return out
    }

    // MARK: - Stop-drift guard (shouldCloseOnCodexOtelTurnEnd)

    /// A `turnEnd` matching the turn OTel is servicing closes it (identity set).
    func testOtelTurnEndClosesMatchingServicedTurn() {
        XCTAssertTrue(DaemonServer.shouldCloseOnCodexOtelTurnEnd(
            servicedOtelTurn: "u2", endTurnId: "u2", hookTurnOpen: true))
        XCTAssertTrue(DaemonServer.shouldCloseOnCodexOtelTurnEnd(
            servicedOtelTurn: "u2", endTurnId: "u2", hookTurnOpen: false))
    }

    /// A late `turnEnd` for a PRIOR turn (different turnId than the one OTel is
    /// now servicing) must not drift-close the newer turn.
    func testOtelTurnEndFromSupersededTurnIsIgnored() {
        XCTAssertFalse(DaemonServer.shouldCloseOnCodexOtelTurnEnd(
            servicedOtelTurn: "u2", endTurnId: "u1", hookTurnOpen: true))
        XCTAssertFalse(DaemonServer.shouldCloseOnCodexOtelTurnEnd(
            servicedOtelTurn: "u2", endTurnId: "u1", hookTurnOpen: false))
    }

    /// Exact field repro: OTel never established the new turn's identity (its
    /// `turnStart` was anonymous → serviced == nil) while a hook opened and
    /// still anchors the turn. A stray `turnEnd` (from the previous turn) must
    /// be ignored so the hook stop / eviction backstop attaches the real
    /// response instead of an empty heuristic chat_end.
    func testOtelTurnEndIgnoredWhenHookOwnsUnidentifiedTurn() {
        XCTAssertFalse(DaemonServer.shouldCloseOnCodexOtelTurnEnd(
            servicedOtelTurn: nil, endTurnId: "u1", hookTurnOpen: true))
    }

    /// Pure-OTel backstop: no hook anchor and no established identity → the
    /// `turnEnd` is the only terminal signal, so it may still close the turn.
    func testOtelTurnEndClosesPureOtelSessionWithoutHookAnchor() {
        XCTAssertTrue(DaemonServer.shouldCloseOnCodexOtelTurnEnd(
            servicedOtelTurn: nil, endTurnId: "u1", hookTurnOpen: false))
    }
}
#endif
