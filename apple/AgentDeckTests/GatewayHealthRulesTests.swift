#if os(macOS)
import XCTest
@testable import AgentDeck

/// Replays shared/gateway-health-vectors.json — the same file the Node suite
/// replays — so one health payload cannot produce two verdicts. The flag these
/// decide turns the OpenClaw creature SICK and the topology LED red.
final class GatewayHealthRulesTests: XCTestCase {
    private func vectors() throws -> [[String: Any]] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/gateway-health-vectors.json")
        let data = try Data(contentsOf: url)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(root["cases"] as? [[String: Any]])
    }

    func testEveryMeasuredPayloadShapeMatchesTheNodeSSOT() throws {
        for c in try vectors() {
            let name = c["name"] as? String ?? ""
            let expect = try XCTUnwrap(c["expect"] as? [String: Any])
            // A JSON `null` payload arrives as NSNull, which is not a dictionary.
            let payload = c["payload"] as? [String: Any]
            let got = GatewayHealthRules.resolve(payload)
            XCTAssertEqual(got.known, expect["known"] as? Bool, name)
            XCTAssertEqual(got.hasError, expect["hasError"] as? Bool, name)
            XCTAssertEqual(got.reason, expect["reason"] as? String, name)
            if let detail = expect["detail"] as? String {
                XCTAssertEqual(got.detail, detail, name)
            }
        }
    }

    /// The regression: a frame without a usable `ok` used to read as a failure,
    /// so the creature went sick until the next good frame — up to five minutes
    /// on OpenClaw's 300 s health-monitor interval.
    func testAFrameThatDidNotSayNeverClaimsAnError() {
        let silent: [[String: Any]?] = [nil, [:], ["uptime": 1], ["ok": "yes"], ["checks": []], ["status": "   "]]
        for payload in silent {
            let v = GatewayHealthRules.resolve(payload)
            XCTAssertFalse(v.known, String(describing: payload))
            XCTAssertFalse(v.hasError, String(describing: payload))
            // How the daemon uses it: unknown must not move the flag either way.
            for previous in [true, false] {
                XCTAssertEqual(v.known ? v.hasError : previous, previous)
            }
        }
    }
}
#endif
