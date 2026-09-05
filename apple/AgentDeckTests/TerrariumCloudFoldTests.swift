#if os(macOS)
import XCTest
@testable import AgentDeck

/// Verify the render-time Codex creature fold introduced to suppress phantom
/// Cloud creatures when Claude Code's rescue/stop-gate workflow spawns a fresh
/// codex thread per turn. Without folding the same workspace lights up 4-5
/// simultaneous Cloud sprites; the fold collapses them to one creature per
/// `(agentType=codex-cli, projectName)` group.
final class TerrariumCloudFoldTests: XCTestCase {

    private func session(
        id: String,
        project: String?,
        state: String = "processing",
        startedAt: String? = nil,
        agentType: String = "codex-cli"
    ) -> SessionInfo {
        SessionInfo(
            id: id,
            port: 9120,
            projectName: project,
            agentType: agentType,
            alive: true,
            state: state,
            modelName: nil,
            effortLevel: nil,
            startedAt: startedAt
        )
    }

    /// Five back-to-back Codex Companion Tasks in the same workspace must
    /// collapse to a single Cloud sprite, with `groupSize == 5` so the
    /// renderer can optionally surface the count.
    func testFiveCompanionTasksInOneProjectFoldToOneSprite() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = (1...5).map { i in
            session(
                id: "codex:thread-\(i)",
                project: "AgentDeck",
                state: i == 5 ? "processing" : "idle",
                startedAt: "2026-04-30T00:00:0\(i)Z"
            )
        }

        let terrarium = state.toTerrariumState()

        XCTAssertEqual(terrarium.cloudCreatures.count, 1, "Five threads sharing project=AgentDeck must fold to a single sprite")
        let creature = terrarium.cloudCreatures[0]
        XCTAssertEqual(creature.groupSize, 5, "groupSize should reflect the underlying thread count")
        // The most-recent thread is the focus-relay representative.
        XCTAssertEqual(creature.id, "codex:thread-5")
        XCTAssertEqual(creature.projectName, "AgentDeck")
        // Aggregate state = highest-priority member.
        XCTAssertEqual(creature.state, .pulsing, "Any group member processing → group is processing")
    }

    /// Codex sessions in distinct projects must NOT collapse — fold is
    /// scoped to projectName (mental model: "one Codex working in this
    /// workspace").
    func testDistinctProjectsRenderSeparateSprites() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = [
            session(id: "codex:a", project: "AgentDeck", state: "processing"),
            session(id: "codex:b", project: "ViewTrans", state: "idle"),
            session(id: "codex:c", project: "OpenClaw", state: "awaiting_permission"),
        ]

        let terrarium = state.toTerrariumState()

        XCTAssertEqual(terrarium.cloudCreatures.count, 3)
        XCTAssertEqual(Set(terrarium.cloudCreatures.compactMap { $0.projectName }), ["AgentDeck", "ViewTrans", "OpenClaw"])
        for c in terrarium.cloudCreatures {
            XCTAssertEqual(c.groupSize, 1, "Singleton groups have groupSize 1")
        }
    }

    /// Codex App OTel and Codex CLI hooks may report the same workspace at
    /// the same time. They must remain two visible Codex creatures instead
    /// of folding solely by projectName.
    func testCodexAppAndCliInSameProjectRenderSeparateSprites() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = [
            session(id: "codex:cli", project: "AgentDeck", state: "processing", agentType: "codex-cli"),
            session(id: "codex:app-1", project: "AgentDeck", state: "processing", startedAt: "2026-04-30T00:00:01Z", agentType: "codex-app"),
            session(id: "codex:app-2", project: "AgentDeck", state: "idle", startedAt: "2026-04-30T00:00:02Z", agentType: "codex-app"),
        ]

        let terrarium = state.toTerrariumState()

        XCTAssertEqual(terrarium.cloudCreatures.count, 2)
        XCTAssertEqual(Set(terrarium.cloudCreatures.map(\.groupSize)), [1, 2])
        XCTAssertEqual(Set(terrarium.cloudCreatures.compactMap { $0.projectName }), ["AgentDeck"])
    }

    /// Empty / missing projectName MUST fold across distinct ids — when a
    /// Companion Task arrives without a project tag (low-quality hook
    /// payload, OTel span lacking `cwd`) the dashboard would otherwise
    /// stack up multiple anonymous codex sprites, contradicting the
    /// user's "one codex per dashboard" mental model. The fallback key
    /// is shared so every empty-project codex collapses into one creature.
    func testEmptyProjectsFoldIntoSingleSprite() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = [
            session(id: "codex:1", project: nil, startedAt: "2026-04-30T00:00:01Z"),
            session(id: "codex:2", project: "", startedAt: "2026-04-30T00:00:02Z"),
            session(id: "codex:3", project: "", startedAt: "2026-04-30T00:00:03Z"),
        ]

        let terrarium = state.toTerrariumState()
        XCTAssertEqual(terrarium.cloudCreatures.count, 1, "Empty/nil project rows must collapse into one shared anonymous group")
        XCTAssertEqual(terrarium.cloudCreatures[0].groupSize, 3)
        // Most-recent thread is the representative.
        XCTAssertEqual(terrarium.cloudCreatures[0].id, "codex:3")
    }

    /// Distinct named projects must still render as distinct sprites even
    /// when an anonymous codex is also present — only the empty-project
    /// rows share a fold key.
    func testNamedProjectsStaySeparateFromAnonymousFold() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = [
            session(id: "codex:a", project: "AgentDeck"),
            session(id: "codex:b", project: nil),
            session(id: "codex:c", project: ""),
            session(id: "codex:d", project: "ViewTrans"),
        ]

        let terrarium = state.toTerrariumState()
        XCTAssertEqual(terrarium.cloudCreatures.count, 3, "AgentDeck + ViewTrans + (anonymous fold of b,c)")
        let groupSizes = terrarium.cloudCreatures.map { $0.groupSize }.sorted()
        XCTAssertEqual(groupSizes, [1, 1, 2])
    }

    /// Aggregate state precedence: processing > awaiting > idle > dormant.
    func testAggregateStatePrecedence() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = [
            session(id: "codex:a", project: "P", state: "idle"),
            session(id: "codex:b", project: "P", state: "awaiting_permission"),
            session(id: "codex:c", project: "P", state: "processing"),
        ]

        let terrarium = state.toTerrariumState()

        XCTAssertEqual(terrarium.cloudCreatures.count, 1)
        XCTAssertEqual(terrarium.cloudCreatures[0].state, .pulsing)
        XCTAssertEqual(terrarium.cloudCreatures[0].groupSize, 3)
    }

    /// Primary Codex session (focused) folds with siblings sharing its
    /// projectName. The representative's id is the most-recent thread, but
    /// the primary's project tag is the source of truth for the group key.
    func testPrimaryCodexFoldsWithSiblings() {
        var state = DashboardState()
        state.state = .processing
        state.bridgeConnected = true
        state.agentType = "codex-cli"
        state.sessionId = "codex:primary"
        state.projectName = "AgentDeck"
        state.siblingSessions = [
            session(id: "codex:primary", project: "AgentDeck", state: "processing", startedAt: "2026-04-30T00:00:00Z"),
            session(id: "codex:s1", project: "AgentDeck", state: "idle", startedAt: "2026-04-30T00:00:30Z"),
            session(id: "codex:s2", project: "AgentDeck", state: "idle", startedAt: "2026-04-30T00:01:00Z"),
        ]

        let terrarium = state.toTerrariumState()
        XCTAssertEqual(terrarium.cloudCreatures.count, 1)
        XCTAssertEqual(terrarium.cloudCreatures[0].groupSize, 3)
        XCTAssertEqual(terrarium.cloudCreatures[0].state, .pulsing)
    }

    /// `sessionId` is hook/activity attribution, not user selection. The
    /// terrarium halo must stay off until `focusedSessionId` is set by an
    /// explicit focus action.
    func testActivitySessionIdDoesNotCreateFocusHalo() {
        var state = DashboardState()
        state.state = .processing
        state.bridgeConnected = true
        state.agentType = "codex-cli"
        state.sessionId = "codex:active"
        state.projectName = "AgentDeck"
        state.siblingSessions = [
            session(id: "codex:active", project: "AgentDeck", state: "processing")
        ]

        let terrarium = state.toTerrariumState()

        XCTAssertNil(terrarium.focusedSessionId)
    }

    /// When the user focuses one member of a folded Codex group, the halo
    /// should resolve to the visible representative sprite instead of the
    /// hidden thread id.
    func testExplicitFocusedCodexThreadMapsToFoldedRepresentative() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.focusedSessionId = "codex:thread-1"
        state.siblingSessions = [
            session(id: "codex:thread-1", project: "AgentDeck", state: "idle", startedAt: "2026-04-30T00:00:01Z"),
            session(id: "codex:thread-2", project: "AgentDeck", state: "processing", startedAt: "2026-04-30T00:00:02Z"),
        ]

        let terrarium = state.toTerrariumState()

        XCTAssertEqual(terrarium.cloudCreatures.first?.id, "codex:thread-2")
        XCTAssertEqual(terrarium.focusedSessionId, "codex:thread-2")
    }

    /// Resurrection predicate trade-off: `codex_session_start` and
    /// `codex_user_prompt_submit` MUST resurrect (the latter handles
    /// interactive multi-turn sessions whose entry was reaped by the
    /// post-terminal TTL during a "user thinking" pause). `codex_tool_start`
    /// MUST NOT resurrect — by the time it arrives for an unknown sessionId
    /// without a preceding prompt event, it is almost certainly a leftover
    /// hook from a thread that already finished. Other end-of-turn or
    /// progress-only events are also non-resurrecting.
    func testResurrectionPredicateAllowsPromptButNotMidTurn() {
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_session_start"))
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_user_prompt_submit"))
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_tool_start"))
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_tool_end"))
        // Permission requests share the tombstone-gated mid-turn resurrection
        // path: after a daemon restart, the first hook may be a live approval.
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_permission_request"))
        XCTAssertTrue(DaemonServer.shouldIgnorePostTerminalCodexProgressForTest(event: "codex_permission_request"))
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_stop"))
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_turn_complete"))
    }

    /// OpenCode resurrection is broader than Codex: the observer plugin
    /// announces `opencode_session_start` once per plugin process, so after a
    /// daemon restart the next signal for a live session is a prompt/tool/
    /// stop hook — all of those must recreate the row (there is no
    /// companion-task noise on the OpenCode side). `session_start` creates
    /// its entry in its own switch case; `session_end` must stay dead.
    func testOpenCodeResurrectionPredicateAllowsMidTurn() {
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_session_start"))
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_user_prompt_submit"))
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_tool_start"))
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_tool_end"))
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_stop"))
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_session_end"))
    }

    /// `CodexHookIdentity.sessionKey` must reject low-quality ids from
    /// EITHER the thread-key path or the `session_id` fallback. Both paths
    /// previously routed through `isDurableSessionId` for `session_id` only,
    /// letting `thread_id: "11"` slip through and synthesize a phantom
    /// `codex:11` row that survived as an unnamed cloud creature.
    func testHookIdentityRejectsShortNumericThreadIds() {
        // Short numeric thread_id — must be rejected.
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["thread_id": "11"]))
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["thread-id": "8"]))
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["codex.thread_id": "12345"]))
        // Pure-digit string of any length is non-durable (real ids are
        // hex/UUID and contain non-decimal characters).
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["thread_id": "12345678901234"]))
        // Same on the session_id fallback.
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["session_id": "11"]))
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["session_id": ""]))
        XCTAssertNil(CodexHookIdentity.sessionKey(from: [:]))
    }

    func testHookIdentityAcceptsUuidThreadIds() {
        // Real codex thread id (UUIDv7-style) — must be accepted as-is.
        let uuid = "019dee40-c853-74e0-b46d-dae33eb1d02b"
        XCTAssertEqual(CodexHookIdentity.sessionKey(from: ["thread_id": uuid]), "codex:\(uuid)")
        XCTAssertEqual(CodexHookIdentity.sessionKey(from: ["thread-id": uuid]), "codex:\(uuid)")
        // Already-prefixed values are normalized — no double prefix.
        XCTAssertEqual(CodexHookIdentity.sessionKey(from: ["thread_id": "codex:\(uuid)"]), "codex:\(uuid)")
        // session_id fallback path also accepts uuid.
        XCTAssertEqual(CodexHookIdentity.sessionKey(from: ["session_id": uuid]), "codex:\(uuid)")
    }

    /// Regression guard for Codex session classification. The anonymous OTel
    /// placeholder is not real; CLI and App thread-id rows both are.
    func testHasRealCodexSessionIgnoresAnonymousPlaceholder() {
        let anonymous = DaemonSessionEntry(
            id: "codex:otel-active",
            port: 9120,
            pid: 0,
            projectName: "",
            agentType: "codex-cli"
        )
        let realCodex = DaemonSessionEntry(
            id: "codex:019dee40-c853-74e0-b46d-dae33eb1d02b",
            port: 9120,
            pid: 0,
            projectName: "AgentDeck",
            agentType: "codex-cli"
        )
        let realCodexApp = DaemonSessionEntry(
            id: "codex:019dee40-c853-74e0-b46d-dae33eb1d02c",
            port: 9120,
            pid: 0,
            projectName: "Codex App",
            agentType: "codex-app"
        )
        let claude = DaemonSessionEntry(
            id: "claude:1",
            port: 9121,
            pid: 0,
            projectName: "OtherRepo",
            agentType: "claude-code"
        )

        // Empty registry — no real codex session.
        XCTAssertFalse(DaemonServer.hasRealCodexSession(in: [:]))

        // Only the anonymous placeholder — still "no real codex". The OTel
        // placeholder must never count as real, else we'd skip the eviction
        // and the duplicate row would stay.
        XCTAssertFalse(DaemonServer.hasRealCodexSession(in: [anonymous.id: anonymous]))

        // Claude-only — agent type guard rejects non-codex sessions.
        XCTAssertFalse(DaemonServer.hasRealCodexSession(in: [claude.id: claude]))

        // Real codex thread-id sessions.
        XCTAssertTrue(DaemonServer.hasRealCodexSession(in: [realCodex.id: realCodex]))
        XCTAssertTrue(DaemonServer.hasRealCodexSession(in: [realCodexApp.id: realCodexApp]))

        // Real codex + anonymous coexisting (the actual regression
        // scenario): predicate still returns true so anonymous would be
        // suppressed/evicted on the next codex insert.
        XCTAssertTrue(DaemonServer.hasRealCodexSession(in: [
            anonymous.id: anonymous,
            realCodex.id: realCodex,
        ]))

        // Claude + anonymous coexisting: anonymous alone does not count as
        // a real codex session, so the predicate stays false. This guards
        // the invariant that anonymous never gets promoted by the mere
        // presence of an unrelated agent type.
        XCTAssertFalse(DaemonServer.hasRealCodexSession(in: [
            anonymous.id: anonymous,
            claude.id: claude,
        ]))
    }

    /// Octopus (Claude Code) is intentionally NOT folded — multi-instance
    /// in the same workspace is a deliberate user pattern.
    func testClaudeOctopusIsNotFolded() {
        var state = DashboardState()
        state.state = .idle
        state.agentType = "openclaw"
        state.bridgeConnected = true
        state.siblingSessions = [
            SessionInfo(id: "claude:1", port: 9121, projectName: "AgentDeck", agentType: "claude-code", alive: true, state: "processing"),
            SessionInfo(id: "claude:2", port: 9122, projectName: "AgentDeck", agentType: "claude-code", alive: true, state: "idle"),
            SessionInfo(id: "claude:3", port: 9123, projectName: "AgentDeck", agentType: "claude-code", alive: true, state: "idle"),
        ]

        let terrarium = state.toTerrariumState()
        XCTAssertEqual(terrarium.creatures.count, 3, "Claude Code sessions must remain unfolded")
    }
}
#endif
