import XCTest
@testable import AgentDeck

final class AgentDeckPathsTests: XCTestCase {
    func testExplicitDataDirectoryNeverImportsLegacyRegistryOrCredentials() throws {
        try withDirectories { legacy, destination in
            try Data("legacy credential".utf8).write(to: legacy.appendingPathComponent("auth-token"))
            try Data("{\"port\":9120}".utf8).write(to: legacy.appendingPathComponent("daemon.json"))
            XCTAssertEqual(AgentDeckPaths.migrateLegacyData(from: legacy, to: destination,
                isSandboxed: false, hasExplicitDataDirectory: true), 0)
            XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: destination.path).isEmpty)
        }
    }

    func testOrdinaryMigrationPreservesExistingDestinationAndCopiesMissingFiles() throws {
        try withDirectories { legacy, destination in
            try Data("old".utf8).write(to: legacy.appendingPathComponent("settings.json"))
            try Data("current".utf8).write(to: destination.appendingPathComponent("settings.json"))
            try Data("history".utf8).write(to: legacy.appendingPathComponent("timeline.json"))
            XCTAssertEqual(AgentDeckPaths.migrateLegacyData(from: legacy, to: destination,
                isSandboxed: false, hasExplicitDataDirectory: false), 1)
            XCTAssertEqual(try String(contentsOf: destination.appendingPathComponent("settings.json"), encoding: .utf8), "current")
            XCTAssertEqual(try String(contentsOf: destination.appendingPathComponent("timeline.json"), encoding: .utf8), "history")
            XCTAssertEqual(AgentDeckPaths.migrateLegacyData(from: legacy, to: destination,
                isSandboxed: false, hasExplicitDataDirectory: false), 0)
        }
    }

    func testSandboxDoesNotReadLegacyFiles() throws {
        try withDirectories { legacy, destination in
            try Data("old".utf8).write(to: legacy.appendingPathComponent("settings.json"))
            XCTAssertEqual(AgentDeckPaths.migrateLegacyData(from: legacy, to: destination,
                isSandboxed: true, hasExplicitDataDirectory: false), 0)
            XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: destination.path).isEmpty)
        }
    }

    private func withDirectories(_ body: (URL, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("agentdeck-paths-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let legacy = root.appendingPathComponent("legacy"), destination = root.appendingPathComponent("isolated")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        try body(legacy, destination)
    }
}
