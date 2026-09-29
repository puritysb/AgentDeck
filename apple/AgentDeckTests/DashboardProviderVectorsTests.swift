import XCTest
@testable import AgentDeck

/// Replays shared/dashboard-provider-vectors.json against the Swift mirror of
/// the dashboard display-preference resolver — the same file the vitest suite
/// (bridge/src/__tests__/dashboard-provider-vectors.test.ts) replays against
/// the TS canonical implementation, so a vector is a cross-daemon contract
/// (#351): the same settings.json must not render differently depending on
/// which daemon holds the port.
final class DashboardProviderVectorsTests: XCTestCase {
    private struct Prefs: Codable, Equatable {
        let providers: [String]?
        let seen: [String]?
    }
    private struct Update: Codable {
        let providers: [String]
        let initialize: Bool?
    }
    private struct Case: Codable {
        let note: String
        let state: Prefs
        let input: Input
        let expected: Prefs
    }
    private struct Input: Codable {
        let update: Update?
        let confirmed: [String]?
    }

    func testMatchesSharedVectors() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // AgentDeckTests/
            .deletingLastPathComponent()   // apple/
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("shared/dashboard-provider-vectors.json")
        struct File: Decodable { let cases: [Case] }
        let cases = try JSONDecoder().decode(File.self, from: Data(contentsOf: url)).cases
        XCTAssertGreaterThanOrEqual(cases.count, 10, "vector file too small to be a gate")
        for c in cases {
            let update = c.input.update.map {
                DashboardProviders.Update(providers: $0.providers, initialize: $0.initialize == true)
            }
            let result = try DashboardProviders.resolve(
                DashboardProviders.Prefs(providers: c.state.providers, seen: c.state.seen),
                update: update,
                confirmed: c.input.confirmed ?? []
            )
            XCTAssertEqual(result.providers, c.expected.providers, c.note)
            XCTAssertEqual(result.seen, c.expected.seen, c.note)
        }
    }

    /// The frozen pre-mechanism baseline is exactly the vocabulary minus z.ai —
    /// the ids that shipped WITH the mechanism are the first join-eligible, and
    /// a later vocabulary addition must not be added to the frozen list.
    func testFrozenBaselineIsVocabularyMinusZai() {
        XCTAssertEqual(
            DashboardProviders.providerIds.filter { !DashboardProviders.preSeenMechanismIds.contains($0) },
            ["zai"]
        )
    }

    /// An invalid POST body is rejected, never silently normalized.
    func testInvalidUpdateThrows() {
        XCTAssertThrowsError(try DashboardProviders.resolve(
            DashboardProviders.Prefs(providers: nil, seen: nil),
            update: DashboardProviders.Update(providers: ["unknown"], initialize: false),
            confirmed: []
        ))
        XCTAssertThrowsError(try DashboardProviders.resolve(
            DashboardProviders.Prefs(providers: nil, seen: nil),
            update: DashboardProviders.Update(providers: [3], initialize: false),
            confirmed: []
        ))
    }
}
