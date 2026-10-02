#if os(macOS)
import XCTest
@testable import AgentDeck

/// Swift mirror of bridge/src/__tests__/hermes-sessions.test.ts: the same
/// admission rules and process-lifetime close for the native daemon.
final class HermesObserverGateTests: XCTestCase {
    private let sid = "hermes-" + String(repeating: "a", count: 32)
    private let other = "hermes-" + String(repeating: "b", count: 32)
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    func testOnlyObserverIdsAndKnownBoundariesAreAdmitted() {
        var gate = HermesObserverGate()
        XCTAssertEqual(gate.admit(event: "hermes_session_start", payload: ["session_id": "not-a-hermes-id"], now: t0), .reject)
        XCTAssertEqual(gate.admit(event: "hermes_permission_request", payload: ["session_id": sid], now: t0), .reject)
        XCTAssertEqual(gate.admit(event: "codex_session_start", payload: ["session_id": sid], now: t0), .reject)
        XCTAssertEqual(gate.admit(event: "hermes_session_start", payload: ["session_id": sid], now: t0),
                       .accept(boundary: "session_start", sessionKey: HermesObserverGate.sessionPrefix + sid))
    }

    func testAStrayStopNeverCreatesARowButToolProgressRecovers() {
        var gate = HermesObserverGate()
        XCTAssertEqual(gate.admit(event: "hermes_stop", payload: ["session_id": sid], now: t0), .reject)
        XCTAssertEqual(gate.admit(event: "hermes_tool_end", payload: ["session_id": sid], now: t0), .reject)
        XCTAssertEqual(gate.admit(event: "hermes_tool_start", payload: ["session_id": sid], now: t0),
                       .accept(boundary: "tool_start", sessionKey: HermesObserverGate.sessionPrefix + sid))
        XCTAssertEqual(gate.admit(event: "hermes_stop", payload: ["session_id": sid], now: at(1)),
                       .accept(boundary: "stop", sessionKey: HermesObserverGate.sessionPrefix + sid))
    }

    func testFinalizeIsFinalUntilANewOpeningEvent() {
        var gate = HermesObserverGate()
        _ = gate.admit(event: "hermes_user_prompt_submit", payload: ["session_id": sid], now: t0)
        XCTAssertEqual(gate.admit(event: "hermes_session_end", payload: ["session_id": sid], now: at(1)),
                       .accept(boundary: "session_end", sessionKey: HermesObserverGate.sessionPrefix + sid))
        XCTAssertEqual(gate.admit(event: "hermes_stop", payload: ["session_id": sid], now: at(2)), .reject)
        XCTAssertEqual(gate.admit(event: "hermes_tool_start", payload: ["session_id": sid], now: at(2)), .reject)
        XCTAssertEqual(gate.admit(event: "hermes_user_prompt_submit", payload: ["session_id": sid], now: at(3)),
                       .accept(boundary: "user_prompt_submit", sessionKey: HermesObserverGate.sessionPrefix + sid))
    }

    // `hermes -z` hard-exits without on_session_finalize (Hermes main
    // 0a374d167, 2026-10-02): the process going away is the only end.
    func testADeadProcessClosesTheConversationAndBlocksLateCallbacks() {
        var gate = HermesObserverGate()
        _ = gate.admit(event: "hermes_user_prompt_submit", payload: ["session_id": sid, "pid": 4242], now: t0)
        XCTAssertEqual(gate.sweepDeparted(now: at(5)) { $0 == 4242 ? .dead : .alive }.closed, [HermesObserverGate.sessionPrefix + sid])
        XCTAssertEqual(gate.admit(event: "hermes_stop", payload: ["session_id": sid, "pid": 4242], now: at(6)), .reject)
    }

    func testAliveUnknownAndPidlessRowsAreKept() {
        var gate = HermesObserverGate()
        _ = gate.admit(event: "hermes_user_prompt_submit", payload: ["session_id": sid, "pid": 4242], now: t0)
        _ = gate.admit(event: "hermes_user_prompt_submit", payload: ["session_id": other], now: t0)
        var probed: [Int32] = []
        XCTAssertEqual(gate.sweepDeparted(now: at(5)) { probed.append($0); return .alive }.closed, [])
        XCTAssertEqual(gate.sweepDeparted(now: at(6)) { probed.append($0); return .unknown }.closed, [])
        XCTAssertEqual(probed, [4242, 4242], "a row without a pid is never probed")
    }

    func testAGatewayPidIsProbedOnceForAllItsConversations() {
        var gate = HermesObserverGate()
        _ = gate.admit(event: "hermes_user_prompt_submit", payload: ["session_id": sid, "pid": 7], now: t0)
        _ = gate.admit(event: "hermes_user_prompt_submit", payload: ["session_id": other, "pid": 7], now: t0)
        var probes = 0
        let closed = gate.sweepDeparted(now: at(5)) { _ in probes += 1; return .dead }.closed
        XCTAssertEqual(Set(closed), [HermesObserverGate.sessionPrefix + sid, HermesObserverGate.sessionPrefix + other])
        XCTAssertEqual(probes, 1)
    }

    func testALiveCliConversationStaysButAGatewayOneKeepsTheTTL() {
        var gate = HermesObserverGate()
        _ = gate.admit(event: "hermes_user_prompt_submit", payload: ["session_id": sid, "pid": 7, "platform": "cli"], now: t0)
        _ = gate.admit(event: "hermes_user_prompt_submit", payload: ["session_id": other, "pid": 8, "platform": "telegram"], now: t0)
        let sweep = gate.sweepDeparted(now: at(5)) { _ in .alive }
        XCTAssertEqual(sweep.refreshed, [HermesObserverGate.sessionPrefix + sid])
        XCTAssertEqual(sweep.closed, [])
    }

    func testMalformedPidNeverProbesAnUnrelatedProcess() {
        for invalid in [7.5, 4_294_967_303.0, -4_294_967_289.0, Double.infinity, Double.nan] {
            var gate = HermesObserverGate()
            _ = gate.admit(event: "hermes_session_start", payload: ["session_id": sid, "pid": invalid], now: t0)
            let sweep = gate.sweepDeparted(now: at(5)) { _ in
                XCTFail("Malformed PID must not reach a process probe")
                return .dead
            }
            XCTAssertEqual(sweep.closed, [])
        }
    }

    func testMalformedPidUpdateRetainsTheLastValidIdentity() {
        var gate = HermesObserverGate()
        _ = gate.admit(event: "hermes_session_start", payload: ["session_id": sid, "pid": 7], now: t0)
        _ = gate.admit(event: "hermes_tool_start", payload: ["session_id": sid, "pid": 8.5], now: at(1))
        var probed: [Int32] = []
        _ = gate.sweepDeparted(now: at(5)) { probed.append($0); return .alive }
        XCTAssertEqual(probed, [7])
    }

    func testOnlyNoSuchProcessReadsAsDead() {
        XCTAssertEqual(HermesObserverGate.probe(ProcessInfo.processInfo.processIdentifier), .alive)
        XCTAssertEqual(HermesObserverGate.probe(Int32.max), .dead)
    }

    func testHermesHooksCrossTheAgentNeutralApmeBoundary() {
        let hook = DaemonServer.normalizeApmeObservedHook(
            event: "hermes_stop",
            json: ["session_id": sid, "interrupted": true],
            sessionId: HermesObserverGate.sessionPrefix + sid
        )
        XCTAssertEqual(hook?.event, "stop")
        XCTAssertEqual(hook?.payload["agent_type"] as? String, "hermes")
        XCTAssertEqual(hook?.payload["session_id"] as? String, HermesObserverGate.sessionPrefix + sid)
    }
}
#endif
