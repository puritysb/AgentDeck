import XCTest
@testable import AgentDeck

/// Replays shared/openclaw-session-key-vectors.json — the same file the Node
/// suite replays — so a cron tick cannot capture the deck on one daemon and
/// leave it alone on the other.
final class OpenClawSessionKeyRulesTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/openclaw-session-key-vectors.json")
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testEveryVectorMatchesTheNodeSSOT() throws {
        let root = try vectors()
        let keys = try XCTUnwrap(root["keys"] as? [[String: Any]])
        XCTAssertGreaterThan(keys.count, 0)
        for c in keys {
            let key = try XCTUnwrap(c["key"] as? String)
            XCTAssertEqual(OpenClawSessionKeyRules.isConversationKey(key, mainSessionKey: c["main"] as? String),
                           try XCTUnwrap(c["conversation"] as? Bool), key)
        }
        for c in try XCTUnwrap(root["pick"] as? [[String: Any]]) {
            let name = c["name"] as? String ?? ""
            let list = try XCTUnwrap(c["keys"] as? [String])
            XCTAssertEqual(OpenClawSessionKeyRules.pickSteeringKey(list, mainSessionKey: c["main"] as? String),
                           c["expected"] as? String, name)
        }
        for c in try XCTUnwrap(root["next"] as? [[String: Any]]) {
            let name = c["name"] as? String ?? ""
            XCTAssertEqual(
                OpenClawSessionKeyRules.nextSteeringKey(current: c["current"] as? String, eventKey: c["event"] as? String,
                                                        mainSessionKey: c["main"] as? String),
                c["expected"] as? String, name
            )
        }
    }

    func testMainSessionKeyFromHello() {
        XCTAssertEqual(OpenClawSessionKeyRules.mainSessionKey(fromHello: [
            "snapshot": ["sessionDefaults": ["mainSessionKey": "agent:main:main", "scope": "per-sender"]],
        ]), "agent:main:main")
        XCTAssertNil(OpenClawSessionKeyRules.mainSessionKey(fromHello: nil))
        XCTAssertNil(OpenClawSessionKeyRules.mainSessionKey(fromHello: ["snapshot": ["sessionDefaults": ["mainSessionKey": 7]]]))
    }
}
