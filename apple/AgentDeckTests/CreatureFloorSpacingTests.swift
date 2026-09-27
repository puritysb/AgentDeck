// CreatureFloorSpacingTests.swift — replays shared/floor-spacing-vectors.json,
// the same file the TS and Kotlin suites replay (DESIGN.md §6.4).

import XCTest
@testable import AgentDeck

final class CreatureFloorSpacingTests: XCTestCase {
    func testEveryVectorMatchesTheTypeScriptSource() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/floor-spacing-vectors.json")
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let vectors = try XCTUnwrap(root["vectors"] as? [[String: Any]])
        XCTAssertGreaterThan(vectors.count, 0)
        for v in vectors {
            let name = v["name"] as? String ?? ""
            let items = try XCTUnwrap(v["items"] as? [[String: Double]]).map { (x: Float($0["x"]!), width: Float($0["width"]!)) }
            let expected = try XCTUnwrap(v["expected"] as? [Double]).map(Float.init)
            let out = CreatureLayout.spreadFloorResidents(items,
                minX: Float(try XCTUnwrap(v["minX"] as? Double)),
                maxX: Float(try XCTUnwrap(v["maxX"] as? Double)),
                minGapRatio: Float(try XCTUnwrap(v["minGapRatio"] as? Double)))
            XCTAssertEqual(out.count, expected.count, name)
            for (a, b) in zip(out, expected) { XCTAssertEqual(a, b, accuracy: 1e-4, name) }
        }
    }
}
