// SessionPushRegisterMergeTests.swift — locks the Node-session → Swift-daemon
// discovery shape for the `--weight` deck/tab pin.
//
// `session_push_register` is the SOLE path a CLI session's identity reaches
// the sandboxed Swift daemon (it cannot read the Node world's sessions.json).
// The merge rule under test (`DaemonServer.mergedPushRegisterEntry`, called by
// both `handleSessionPushRegister` and shared with the re-register recreate):
// explicit weight > absent > retain, clamped to SessionWeightRules on
// ingestion. Both entry-reconstruction sites used to rebuild the struct
// field-by-field, which silently nil'd any field not carried through — the
// exact bug class that previously wiped state/modelName/effortLevel on
// projectName recreates.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class SessionPushRegisterMergeTests: XCTestCase {

    func testFreshRegisterStoresClampedWeight() {
        let entry = DaemonServer.mergedPushRegisterEntry(
            existing: nil, sessionId: "s1", port: 9121,
            agentType: "claude-code", projectName: "AgentDeck", weight: 2)
        XCTAssertEqual(entry.weight, 2)

        let clamped = DaemonServer.mergedPushRegisterEntry(
            existing: nil, sessionId: "s2", port: 9122,
            agentType: "claude-code", projectName: "AgentDeck", weight: Int.max)
        XCTAssertEqual(clamped.weight, SessionWeightRules.max)
    }

    func testReRegisterWithoutWeightPreservesExisting() {
        // Legacy sender (no weight key) re-registers: the stored pin survives.
        let first = DaemonServer.mergedPushRegisterEntry(
            existing: nil, sessionId: "s1", port: 9121,
            agentType: "claude-code", projectName: "AgentDeck", weight: 3)
        let second = DaemonServer.mergedPushRegisterEntry(
            existing: first, sessionId: "s1", port: 9121,
            agentType: "claude-code", projectName: "AgentDeck", weight: nil)
        XCTAssertEqual(second.weight, 3)
    }

    func testReRegisterRecreateCarriesWeightThroughFieldChanges() {
        // Port drift / projectName change triggers the struct recreate — the
        // path that silently dropped non-carried fields. Weight must survive.
        let first = DaemonServer.mergedPushRegisterEntry(
            existing: nil, sessionId: "s1", port: 9121,
            agentType: "claude-code", projectName: "AgentDeck", weight: 5)
        let moved = DaemonServer.mergedPushRegisterEntry(
            existing: first, sessionId: "s1", port: 9125,
            agentType: "claude-code", projectName: "Renamed", weight: nil)
        XCTAssertEqual(moved.port, 9125)
        XCTAssertEqual(moved.projectName, "Renamed")
        XCTAssertEqual(moved.weight, 5)
    }

    func testExplicitZeroResetsAPin() {
        // Weight is always sent by current bridges (explicit 0, never omitted)
        // precisely so a pin can be reset — absent must not be the only way to
        // express "unweighted" or the field latches one-way.
        let pinned = DaemonServer.mergedPushRegisterEntry(
            existing: nil, sessionId: "s1", port: 9121,
            agentType: "claude-code", projectName: "AgentDeck", weight: 4)
        let reset = DaemonServer.mergedPushRegisterEntry(
            existing: pinned, sessionId: "s1", port: 9121,
            agentType: "claude-code", projectName: "AgentDeck", weight: 0)
        XCTAssertEqual(reset.weight, 0)
    }
}
#endif
