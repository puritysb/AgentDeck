#if os(macOS)
//
// SetupStatusContractTests.swift — replays shared/setup-status-contract.json
// against the Swift daemon's `/setup-status` body (Node parity:
// bridge/src/__tests__/setup-status.test.ts), and pins the Ulanzi QA fixes the
// D200H Device Preview mirrors (BACK names the open session; a position listed
// twice lays out once).
//
// `/setup-status` answers with `Access-Control-Allow-Origin: *`, so its key set
// is a security contract: a browser page on this machine may read it.
//

import XCTest
@testable import AgentDeck

final class SetupStatusContractTests: XCTestCase {
    private struct Contract: Decodable {
        let keys: [String]
        let claudeHooksValues: [String]
        let forbiddenKeyPattern: String
        let forbiddenKeys: [String]
    }

    private func loadContract() throws -> Contract {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // AgentDeckTests/
            .deletingLastPathComponent()   // apple/
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("shared/setup-status-contract.json")
        return try JSONDecoder().decode(Contract.self, from: Data(contentsOf: url))
    }

    func testPayloadCarriesExactlyTheContractKeys() throws {
        let contract = try loadContract()
        let payload = DaemonServer.setupStatusPayload(port: 9120, state: "disconnected", sessions: 3, claudeHooks: "installed")
        XCTAssertEqual(Set(payload.keys), Set(contract.keys))
        let forbidden = try NSRegularExpression(pattern: contract.forbiddenKeyPattern, options: [.caseInsensitive])
        for key in payload.keys {
            XCTAssertNil(forbidden.firstMatch(in: key, range: NSRange(key.startIndex..., in: key)), "forbidden key \(key)")
        }
        for key in contract.forbiddenKeys { XCTAssertNil(payload[key], key) }
    }

    func testSessionCountRidesBesideADisconnectedStateWord() throws {
        // The state word says `disconnected` whenever no managed session is
        // focused; the count is what tells the panel the deck has sessions.
        let payload = DaemonServer.setupStatusPayload(port: 9120, state: "disconnected", sessions: 2, claudeHooks: "unknown")
        let json = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: payload)) as? [String: Any]
        XCTAssertEqual(json?["sessions"] as? Int, 2)
        XCTAssertEqual(json?["isSwift"] as? Bool, true)
        XCTAssertEqual(json?["state"] as? String, "disconnected")
    }

    func testUnknownCountSerializesAsNullNotZero() throws {
        let payload = DaemonServer.setupStatusPayload(port: 9120, state: "idle", sessions: nil, claudeHooks: "unknown")
        let data = try JSONSerialization.data(withJSONObject: payload)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(json["sessions"] is NSNull)
    }

    func testClaudeHooksNeverClaimsMissingFromInsideTheSandbox() throws {
        // The app cannot read ~/.claude without the user's bookmark, and the CLI
        // may have installed the hooks into the same file — so it answers
        // `installed` only for its own consented install, `unknown` otherwise.
        let contract = try loadContract()
        let cases: [(Bool, AppPreferences.HookInstallConsent, String)] = [
            (true, .accepted, "installed"),
            (true, .declined, "unknown"),
            (false, .accepted, "unknown"),
            (false, .unknown, "unknown"),
        ]
        for (installed, consent, expected) in cases {
            let value = DaemonServer.setupStatusClaudeHooks(hooksInstalled: installed, consent: consent)
            XCTAssertEqual(value, expected)
            XCTAssertTrue(contract.claudeHooksValues.contains(value))
        }
    }

    // MARK: - D200H Device Preview mirror (shared/src/__tests__/d200h-ulanzi-qa.test.ts)

    func testPreviewBackKeyNamesTheOpenSession() {
        let input = D200HDeckInput(state: "idle", sessions: [
            D200HSession(id: "a", agentType: "claude-code", state: "idle", projectName: "payments-api"),
        ])
        let slots = D200HLayoutModel.buildSessionDeck(
            input, view: D200HDeckView(mode: .detail, openSessionId: "a"),
            positions: ["0_0", "1_0", "2_0", "3_0", "4_0"]
        )
        let back = slots.first { $0.position == "0_0" }
        XCTAssertEqual(back?.label, "BACK")
        XCTAssertEqual(back?.subtitle, "payments-api")
    }

    func testPreviewLaysOutADuplicatedPositionOnce() {
        XCTAssertEqual(D200HLayoutModel.sortPositions(["1_0", "0_0", "1_0", "0_0"]), ["0_0", "1_0"])
    }
}
#endif
