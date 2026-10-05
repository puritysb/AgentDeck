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
}
#endif
