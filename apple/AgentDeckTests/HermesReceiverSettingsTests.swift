#if os(macOS)
import XCTest
@testable import AgentDeck

final class HermesReceiverSettingsTests: XCTestCase {
    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        try Data("agentdeck-hermes-observer-v1\n".utf8).write(to: url.appendingPathComponent(".agentdeck-owned"))
        try Data("# existing user-owned plugin".utf8).write(to: url.appendingPathComponent("__init__.py"))
        try Data("name: agentdeck-observer".utf8).write(to: url.appendingPathComponent("plugin.yaml"))
        return url
    }

    private func defaults() -> UserDefaults {
        let suite = "HermesReceiverTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        return defaults
    }

    @MainActor
    private func access(start: @escaping (URL) -> Bool = { _ in true }) -> HermesReceiverSettings.FolderAccess {
        .init(makeBookmark: { Data($0.path.utf8) },
              resolve: { (URL(fileURLWithPath: String(decoding: $0, as: UTF8.self)), false) },
              start: start, stop: { _ in })
    }

    private func read(_ folder: URL) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("connection.json"))) as? [String: Any])
    }

    @MainActor
    func testOptInTracksReadyPortAcrossRestartAndRestoresBookmarkOnRelaunch() throws {
        let folder = try folder(), defaults = defaults()
        let settings = HermesReceiverSettings(defaults: defaults, access: access())
        settings.localReceiverChanged(port: 49150)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("connection.json").path))
        XCTAssertTrue(settings.selectFolder(folder)) // selection after ready saves immediately
        XCTAssertEqual(try read(folder)["port"] as? Int, 49150)
        settings.localReceiverChanged(port: nil)
        XCTAssertNil(settings.savedPort)
        XCTAssertEqual(try read(folder)["port"] as? Int, 49150, "teardown must not restore registry discovery")
        settings.localReceiverChanged(port: 49151)
        XCTAssertEqual(try read(folder)["port"] as? Int, 49151)

        let relaunched = HermesReceiverSettings(defaults: defaults, access: access())
        XCTAssertTrue(relaunched.isEnabled)
        XCTAssertNil(relaunched.savedPort, "persisted selection does not prove a receiver is ready")
        relaunched.localReceiverChanged(port: 49152)
        XCTAssertEqual(try read(folder)["port"] as? Int, 49152)
        relaunched.stopSyncing()
        relaunched.localReceiverChanged(port: 49153)
        XCTAssertFalse(relaunched.isEnabled)
        XCTAssertNil(relaunched.selectedPath)
        XCTAssertEqual(try read(folder)["port"] as? Int, 49152)
    }

    @MainActor
    func testSelectionBeforeReadinessWaitsAndPreservesOtherSettingsAndCode() throws {
        let folder = try folder()
        let target = folder.appendingPathComponent("connection.json")
        try Data(#"{"port":9120,"future":{"keep":true}}"#.utf8).write(to: target)
        let code = try Data(contentsOf: folder.appendingPathComponent("__init__.py"))
        let settings = HermesReceiverSettings(defaults: defaults(), access: access())
        XCTAssertTrue(settings.selectFolder(folder))
        XCTAssertEqual(try read(folder)["port"] as? Int, 9120)
        settings.localReceiverChanged(port: 0)
        XCTAssertNil(settings.savedPort)
        settings.localReceiverChanged(port: 49150)
        XCTAssertEqual(try read(folder)["port"] as? Int, 49150)
        XCTAssertEqual((try read(folder)["future"] as? [String: Bool])?["keep"], true)
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("__init__.py")), code)
    }

    @MainActor
    func testPermissionLossReportsFailureAndRetryRecoversWithoutLosingSelection() throws {
        let folder = try folder()
        var granted = true
        let settings = HermesReceiverSettings(defaults: defaults(), access: access { _ in granted })
        XCTAssertTrue(settings.selectFolder(folder))
        settings.localReceiverChanged(port: 49150)
        granted = false
        settings.localReceiverChanged(port: 49151)
        XCTAssertNotNil(settings.errorMessage)
        XCTAssertNil(settings.savedPort)
        XCTAssertTrue(settings.isEnabled)
        XCTAssertEqual(try read(folder)["port"] as? Int, 49150)
        granted = true
        settings.synchronize()
        XCTAssertNil(settings.errorMessage)
        XCTAssertEqual(settings.savedPort, 49151)
        XCTAssertEqual(try read(folder)["port"] as? Int, 49151)
    }

    @MainActor
    func testStaleBookmarkRefreshesWithinBalancedScopeAndStopNeverAccessesFolderAgain() throws {
        let folder = try folder(), defaults = defaults()
        var starts = 0, stops = 0, bookmarks = 0
        let access = HermesReceiverSettings.FolderAccess(
            makeBookmark: { _ in bookmarks += 1; return Data([UInt8(bookmarks)]) },
            resolve: { _ in (folder, true) },
            start: { _ in starts += 1; return true }, stop: { _ in stops += 1 })
        let settings = HermesReceiverSettings(defaults: defaults, access: access)
        XCTAssertTrue(settings.selectFolder(folder))
        settings.localReceiverChanged(port: 49150)
        XCTAssertEqual(bookmarks, 2)
        XCTAssertEqual(defaults.data(forKey: HermesReceiverSettings.bookmarkKey), Data([2]))
        XCTAssertEqual(starts, stops)
        settings.stopSyncing()
        let before = starts
        settings.synchronize()
        settings.localReceiverChanged(port: 49151)
        XCTAssertEqual(starts, before)
    }

    func testMalformedOrNonObjectSettingsAreNeverOverwritten() throws {
        let folder = try folder(), target = folder.appendingPathComponent("connection.json")
        for content in ["{", "[]", "null", String(repeating: " ", count: 65537)] {
            let bytes = Data(content.utf8)
            try bytes.write(to: target)
            XCTAssertThrowsError(try HermesReceiverFile.write(port: 49150, in: folder))
            XCTAssertEqual(try Data(contentsOf: target), bytes)
        }
    }

    func testSymlinkedSettingsAndMissingOwnershipAreRefused() throws {
        let folder = try folder(), other = try self.folder()
        let outside = other.appendingPathComponent("connection.json")
        let bytes = Data(#"{"port":9120}"#.utf8)
        try bytes.write(to: outside)
        let target = folder.appendingPathComponent("connection.json")
        try FileManager.default.createSymbolicLink(at: target, withDestinationURL: outside)
        XCTAssertThrowsError(try HermesReceiverFile.write(port: 49150, in: folder))
        XCTAssertEqual(try Data(contentsOf: outside), bytes)
        try FileManager.default.removeItem(at: target)
        try FileManager.default.removeItem(at: folder.appendingPathComponent(".agentdeck-owned"))
        XCTAssertThrowsError(try HermesReceiverFile.write(port: 49150, in: folder))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }

    @MainActor
    func testBadFolderSelectionDoesNotReplaceExistingGrant() throws {
        let good = try folder(), bad = try folder()
        let settings = HermesReceiverSettings(defaults: defaults(), access: access())
        XCTAssertTrue(settings.selectFolder(good))
        try FileManager.default.removeItem(at: bad.appendingPathComponent(".agentdeck-owned"))
        XCTAssertFalse(settings.selectFolder(bad))
        XCTAssertEqual(settings.selectedPath, good.path)
        settings.localReceiverChanged(port: 49150)
        XCTAssertEqual(try read(good)["port"] as? Int, 49150)
        XCTAssertFalse(FileManager.default.fileExists(atPath: bad.appendingPathComponent("connection.json").path))
    }
}
#endif
