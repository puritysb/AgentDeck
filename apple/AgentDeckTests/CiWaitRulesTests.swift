#if os(macOS)
import Foundation
import XCTest
@testable import AgentDeck

final class CiWaitRulesTests: XCTestCase {
    func testSharedCommandVectors() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/ci-wait-vectors.json"))
        let vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        for (index, vector) in vectors.enumerated() {
            let result = CiWaitRules.classify(command: vector["command"], runInBackground: vector["background"])
            if let expected = vector["expected"] as? [String: Any] {
                let intent = try XCTUnwrap(result, "Missing intent at vector \(index)")
                let actual = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(intent)) as? [String: Any])
                XCTAssertTrue(NSDictionary(dictionary: actual).isEqual(to: expected), "Wrong intent at vector \(index)")
            } else { XCTAssertNil(result, "Invented intent at vector \(index)") }
        }
    }
    func testSharedAccountingVectors() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/ci-wait-accounting-vectors.json"))
        let vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        for vector in vectors {
            let actual = CiWaitAccounting.foregroundMs(try XCTUnwrap(vector["events"] as? [[String: Any]]),
                turnIndex: try XCTUnwrap(vector["turnIndex"] as? Int), start: try XCTUnwrap(vector["start"] as? Int),
                end: try XCTUnwrap(vector["end"] as? Int))
            XCTAssertEqual(actual, vector["expected"] as? Int, vector["name"] as? String ?? "")
        }
    }

    @DaemonActor
    func testSharedLifecycleVectors() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/ci-wait-lifecycle-vectors.json"))
        let scenarios = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        for scenario in scenarios {
            let tracker = CiWaitTracker()
            for step in try XCTUnwrap(scenario["steps"] as? [[String: Any]]) {
                let now = try XCTUnwrap(step["at"] as? Int)
                tracker.note("session", event: try XCTUnwrap(step["event"] as? String),
                             json: try XCTUnwrap(step["payload"] as? [String: Any]), now: now)
                let actual = tracker.snapshot("session", now: now)
                if let expected = step["expected"] as? [String: Any] {
                    XCTAssertTrue(NSDictionary(dictionary: actual ?? [:]).isEqual(to: expected))
                } else { XCTAssertNil(actual) }
            }
        }
    }

}
#endif
