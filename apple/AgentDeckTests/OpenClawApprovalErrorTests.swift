import XCTest
@testable import AgentDeck

/// Behavior gate for the generated "is this approval gone?" predicate
/// (`OpenClawApprovalRules.generated.swift`).
///
/// It replays shared/openclaw-approval-error-vectors.json — the same file
/// vitest replays against the TS SSOT — because the decision it encodes is one
/// both daemons must make identically: either may hold 9120, and a ghost PERM
/// that only one of them clears is a deck the user cannot answer on whichever
/// daemon won.
final class OpenClawApprovalErrorTests: XCTestCase {

    private struct Vector: Decodable {
        let name: String
        let error: [String: JSONValue]
        let gone: Bool
    }

    /// Minimal JSON value so the vector file can carry the real frame shapes
    /// (a nested `details.reason`, and a `details` that is deliberately a
    /// string) without a bespoke decoder per case.
    private enum JSONValue: Decodable {
        case string(String)
        case object([String: JSONValue])
        case other

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let s = try? container.decode(String.self) { self = .string(s); return }
            if let o = try? container.decode([String: JSONValue].self) { self = .object(o); return }
            self = .other
        }

        var anyValue: Any {
            switch self {
            case .string(let s): return s
            case .object(let o): return o.mapValues { $0.anyValue }
            case .other: return NSNull()
            }
        }
    }

    func testMatchesSharedVectors() throws {
        let vectorsURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // AgentDeckTests/
            .deletingLastPathComponent()   // apple/
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("shared/openclaw-approval-error-vectors.json")
        let data = try Data(contentsOf: vectorsURL)
        struct File: Decodable { let vectors: [Vector] }
        let vectors = try JSONDecoder().decode(File.self, from: data).vectors
        XCTAssertGreaterThanOrEqual(vectors.count, 10, "vector file too small to be a gate")
        XCTAssertTrue(vectors.contains { $0.gone }, "vectors must cover the gone direction")
        XCTAssertTrue(vectors.contains { !$0.gone }, "vectors must cover the not-gone direction")
        for v in vectors {
            let error = v.error.mapValues { $0.anyValue }
            XCTAssertEqual(
                OpenClawApprovalRules.isApprovalGoneError(error), v.gone, v.name)
        }
    }

    /// Absence of an error is not an answer — nothing to abandon.
    func testNilErrorClaimsNothing() {
        XCTAssertFalse(OpenClawApprovalRules.isApprovalGoneError(nil))
        XCTAssertFalse(OpenClawApprovalRules.isApprovalGoneError([:]))
    }
}
