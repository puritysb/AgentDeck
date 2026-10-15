// HubSessionIsolationTests.swift — #545: one hook session ending, or the app
// restarting, must not take the deck away from another session still running.
//
// Two defects of one shape, both in the in-process daemon that multiplexes
// every observed session:
//   1. `session_end` drives the ONE shared state machine to DISCONNECTED (a
//      wildcard row written for a single-session bridge), so a background
//      `claude /usage` probe ending stranded the working session's hub state —
//      and DISCONNECTED had no exit for the prompt a running session sends
//      next. `hubDisconnectsOnSessionEnd` gates the drop; the transition table
//      gained DISCONNECTED → PROCESSING on `user_prompt_submit` (pinned by
//      `shared/src/__tests__/state-transitions.test.ts`).
//   2. `refreshSessions` snapshots the rows, awaits probes, then wrote the
//      snapshot back and pruned by the CURRENT keys — so a row a hook created
//      during the wait (a session resurrected by its first prompt after a
//      restart) was pruned as stale the moment it appeared.
// macOS-only (daemon path).

#if os(macOS)
import XCTest
@testable import AgentDeck

@DaemonActor
final class HubSessionIsolationTests: XCTestCase {

    private func row(_ id: String, state: String? = "idle", port: Int = 9120) -> DaemonSessionEntry {
        var e = DaemonSessionEntry(
            id: id, port: port, pid: 0, projectName: "AgentDeck", agentType: "claude-code",
            tmuxSession: nil, tty: nil, parentTty: nil, startedAt: "2026-10-15T00:00:00Z"
        )
        e.state = state
        e.controlMode = "observed"
        return e
    }

    // MARK: - session_end

    func testShortSessionEndingKeepsTheHubWhileAnotherSessionLives() async {
        // The reported shape: ClaudeBar's probe session ends while the user's
        // working session is still open. Rows are checked before removal.
        XCTAssertFalse(DaemonServer.hubDisconnectsOnSessionEnd(
            endedSessionId: "probe", liveSessionIds: ["working", "probe"]))
    }

    func testLastSessionEndingDisconnectsTheHub() async {
        XCTAssertTrue(DaemonServer.hubDisconnectsOnSessionEnd(
            endedSessionId: "working", liveSessionIds: ["working"]))
        // Its row may already be gone (evicted, or a duplicate end).
        XCTAssertTrue(DaemonServer.hubDisconnectsOnSessionEnd(
            endedSessionId: "working", liveSessionIds: [String]()))
        // An end with no session id still ends a hub that has no rows.
        XCTAssertTrue(DaemonServer.hubDisconnectsOnSessionEnd(
            endedSessionId: nil, liveSessionIds: [String]()))
        XCTAssertFalse(DaemonServer.hubDisconnectsOnSessionEnd(
            endedSessionId: nil, liveSessionIds: ["working"]))
    }

    // MARK: - review follow-ups

    func testOnlyObservedRowsHoldTheHubOpen() async {
        // A managed bridge's pushed row has its own machine and never drives
        // this one; counting it kept the hub IDLE after the last observed end.
        var managed = row("managed")
        managed.controlMode = nil
        let ids = DaemonServer.hubLiveSessionIds(["working": row("working"), "managed": managed])
        XCTAssertEqual(ids, ["working"])
        XCTAssertTrue(DaemonServer.hubDisconnectsOnSessionEnd(
            endedSessionId: "working",
            liveSessionIds: DaemonServer.hubLiveSessionIds(["working": row("working"), "managed": managed])))
    }

    func testHubSettlesWhenTheRosterEmptiesWithoutASessionEnd() async {
        // A crashed sibling held the hub open past a clean end; when the reaper
        // removes it, the hub must not sit IDLE over an empty roster.
        XCTAssertTrue(DaemonServer.hubSettlesOnRosterLoss(
            state: .idle, gatewayDriving: false, gatewayConnected: false, liveSessionCount: 0))
        XCTAssertFalse(DaemonServer.hubSettlesOnRosterLoss(
            state: .idle, gatewayDriving: false, gatewayConnected: false, liveSessionCount: 1))
        XCTAssertFalse(DaemonServer.hubSettlesOnRosterLoss(
            state: .idle, gatewayDriving: false, gatewayConnected: true, liveSessionCount: 0))
        XCTAssertFalse(DaemonServer.hubSettlesOnRosterLoss(
            state: .processing, gatewayDriving: true, gatewayConnected: false, liveSessionCount: 0))
        XCTAssertFalse(DaemonServer.hubSettlesOnRosterLoss(
            state: .disconnected, gatewayDriving: false, gatewayConnected: false, liveSessionCount: 0))
    }

    func testGatewayLossLeavesLiveHookSessionsTheirHub() async {
        // The Gateway link flaps; a working Claude session must not lose the
        // hub on each flap. Only a turn the Gateway itself drove is closed.
        XCTAssertEqual(DaemonServer.hubTriggerOnGatewayLoss(liveSessionCount: 0, gatewayDrove: true), "session_end")
        XCTAssertEqual(DaemonServer.hubTriggerOnGatewayLoss(liveSessionCount: 0, gatewayDrove: false), "session_end")
        XCTAssertEqual(DaemonServer.hubTriggerOnGatewayLoss(liveSessionCount: 2, gatewayDrove: true), "stop")
        XCTAssertNil(DaemonServer.hubTriggerOnGatewayLoss(liveSessionCount: 2, gatewayDrove: false))
    }

    func testDisconnectedHubReopensOnThePromptOfASessionAlreadyUnderway() async {
        // The generated table must carry the exit the driver relies on; a
        // session already running never sends session_start again.
        let machine = StateMachine()
        XCTAssertEqual(machine.state, .disconnected)
        XCTAssertTrue(machine.transition(trigger: "user_prompt_submit", source: .hook))
        XCTAssertEqual(machine.state, .processing)
        // A straggler Stop still cannot reopen an ended hub.
        let ended = StateMachine()
        XCTAssertFalse(ended.transition(trigger: "stop", source: .hook))
        XCTAssertEqual(ended.state, .disconnected)
    }

    // MARK: - refreshSessions reconciliation

    func testRowResurrectedDuringTheRefreshIsPublishedNotPruned() async {
        // App restart: the pass snapshotted no rows, then the working session's
        // first prompt resurrected its row while the probes were in flight.
        let resurrected = row("working", state: "processing")
        let result = DaemonServer.reconcileRefreshedSessions(
            refreshed: [], registryIds: [], snapshotPushedIds: [], probedIds: [],
            livePushed: ["working": resurrected])
        XCTAssertEqual(result.sessions.map(\.id), ["working"])
        XCTAssertEqual(result.sessions.first?.state, "processing")
        XCTAssertEqual(result.prune, [])
    }

    func testStateSetDuringTheRefreshIsNotRevertedToTheSnapshot() async {
        let snapshot = row("working", state: "idle")
        let live = row("working", state: "processing")
        let result = DaemonServer.reconcileRefreshedSessions(
            refreshed: [snapshot], registryIds: [], snapshotPushedIds: ["working"], probedIds: [],
            livePushed: ["working": live])
        XCTAssertEqual(result.sessions.map(\.state), ["processing"])
    }

    func testRowThatEndedDuringTheRefreshStaysEnded() async {
        let result = DaemonServer.reconcileRefreshedSessions(
            refreshed: [row("probe"), row("working")], registryIds: [],
            snapshotPushedIds: ["probe", "working"], probedIds: [],
            livePushed: ["working": row("working")])
        XCTAssertEqual(result.sessions.map(\.id), ["working"])
        XCTAssertEqual(result.prune, [])
    }

    func testProbedBridgeThatStoppedAnsweringIsStillPruned() async {
        // The prune's original job: a managed bridge on its own port whose
        // probe came back without a state.
        let gone = row("bridge", state: nil, port: 9123)
        let result = DaemonServer.reconcileRefreshedSessions(
            refreshed: [gone], registryIds: [], snapshotPushedIds: ["bridge"], probedIds: ["bridge"],
            livePushed: ["bridge": row("bridge", state: "idle", port: 9123)])
        XCTAssertEqual(result.sessions.map(\.id), [])
        XCTAssertEqual(result.prune, ["bridge"])
    }

    func testRegistryAndObservedRowsKeepTheirRefreshedEntries() async {
        let registry = row("registry", state: nil, port: 9124)
        var kiro = row("observed:kiro:k1", state: "idle")
        kiro.agentType = "kiro-cli"
        let result = DaemonServer.reconcileRefreshedSessions(
            refreshed: [registry, kiro, row("observed:kiro:k2", state: nil)],
            registryIds: ["registry"], snapshotPushedIds: [], probedIds: ["registry"], livePushed: [:])
        XCTAssertEqual(Set(result.sessions.map(\.id)), ["registry", "observed:kiro:k1"])
        XCTAssertEqual(result.prune, [])
    }
}
#endif
