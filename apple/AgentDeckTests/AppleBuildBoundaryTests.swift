import XCTest
@testable import AgentDeck

final class AppleBuildBoundaryTests: XCTestCase {
    func testDotResourceMatchesCompiledFeature() {
        #if AGENTDECK_DOT_PREVIEW
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "AgentDeckDotSupport") as? String, "preview")
        XCTAssertNotNil(Bundle.main.url(forResource: "dot-mcp-contract", withExtension: "json"))
        #else
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "AgentDeckDotSupport") as? String, "excluded")
        XCTAssertNil(Bundle.main.url(forResource: "dot-mcp-contract", withExtension: "json"))
        #endif
    }

    func testIncomingDotDoesNotBreakOrdinarySessions() throws {
        // An external Node/preview daemon may still send Dot. Store clients
        // ignore even incompatible future Dot data instead of losing the roster.
        #if AGENTDECK_DOT_PREVIEW
        let incoming = #"{"type":"sessions_list","sessions":[],"dot":{"configured":true,"hosting":true}}"#
        let event = try JSONDecoder().decode(SessionsListEvent.self, from: Data(incoming.utf8))
        XCTAssertEqual(event.dot?.configured, true)
        #else
        let incoming = #"{"type":"sessions_list","sessions":[],"dot":{"configured":"future-format","appearance":"untrusted"}}"#
        let event = try JSONDecoder().decode(SessionsListEvent.self, from: Data(incoming.utf8))
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(event)) as? [String: Any]
        XCTAssertNil(encoded?["dot"])
        #endif
        XCTAssertEqual(event.type, "sessions_list")
        XCTAssertTrue(event.sessions.isEmpty)
    }

    #if !AGENTDECK_DOT_PREVIEW
    func testStoreMatrixIgnoresDotFromExternalDaemon() {
        let sessions: [String: Any] = ["type": "sessions_list", "sessions": [["id": "one", "alive": true, "state": "idle", "agentType": "codex-cli"]]]
        var withDot = sessions
        withDot["dot"] = ["configured": true, "hosting": true, "reportState": "working", "reportedAt": 1_000, "expiresAt": 20_000]
        var normal = MatrixExpression(), external = MatrixExpression()
        normal.ingest(sessions, now: 1_000)
        external.ingest(withDot, now: 1_000)
        XCTAssertEqual(normal.render(size: 32, now: 1_000), external.render(size: 32, now: 1_000))
    }
    #endif
}
