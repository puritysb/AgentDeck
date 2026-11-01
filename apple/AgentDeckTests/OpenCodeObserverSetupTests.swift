#if os(macOS)
import XCTest
@testable import AgentDeck

final class OpenCodeObserverSetupTests: XCTestCase {
    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func files(_ text: String = "// native v1", cli: String = "// canonical CLI") -> OpenCodeObserverFiles {
        .init(payload: .init(source: text, cliSHA256: OpenCodeObserverFiles.hash(Data(cli.utf8)),
                            pluginFilename: "agentdeck.js", receiverFilename: "agentdeck-connection.json", owner: "agentdeck-swift-opencode"))
    }
    func testInstallUpdateRemovePreservesUserConfigurationAndOtherPlugins() throws {
        let folder = try folder(), plugin = folder.appendingPathComponent("agentdeck.js")
        let config = folder.appendingPathComponent("opencode.jsonc"), other = folder.appendingPathComponent("my-plugin.js")
        let user = Data("// user's JSONC with comments\n{not parsed by AgentDeck}".utf8)
        try user.write(to: config); try user.write(to: other)
        try files().install(port: 49150, in: folder)
        XCTAssertEqual(try Data(contentsOf: plugin), Data("// native v1".utf8))
        try files("// native v2").install(port: 49151, in: folder)
        XCTAssertEqual(try Data(contentsOf: plugin), Data("// native v2".utf8))
        try files("// native v2").remove(in: folder)
        XCTAssertFalse(FileManager.default.fileExists(atPath: plugin.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("agentdeck-connection.json").path))
        XCTAssertEqual(try Data(contentsOf: config), user)
        XCTAssertEqual(try Data(contentsOf: other), user)
        try files().remove(in: folder) // idempotent
    }
    func testEditedPluginIsNeverOverwrittenOrRemovedEvenWithOurHeader() throws {
        let folder = try folder(), plugin = folder.appendingPathComponent("agentdeck.js")
        try files().install(port: 49150, in: folder)
        let edited = Data("// native v1\n// user customization".utf8)
        try edited.write(to: plugin)
        let receiver = folder.appendingPathComponent("agentdeck-connection.json")
        let before = try Data(contentsOf: receiver)
        XCTAssertThrowsError(try files().install(port: 49151, in: folder))
        XCTAssertThrowsError(try files().remove(in: folder))
        XCTAssertThrowsError(try files().updateReceiver(port: 49151, in: folder))
        XCTAssertEqual(try Data(contentsOf: plugin), edited)
        XCTAssertEqual(try Data(contentsOf: receiver), before)
    }
    func testForeignFilesAndSymlinksAreRefusedBeforeAnyWrite() throws {
        let folder = try folder(), plugin = folder.appendingPathComponent("agentdeck.js")
        let foreign = Data("export const UserPlugin = () => ({})".utf8)
        try foreign.write(to: plugin)
        XCTAssertThrowsError(try files().install(port: 49150, in: folder))
        XCTAssertThrowsError(try files().remove(in: folder))
        XCTAssertEqual(try Data(contentsOf: plugin), foreign)
        try FileManager.default.removeItem(at: plugin)
        let outside = try self.folder().appendingPathComponent("outside")
        try foreign.write(to: outside)
        try FileManager.default.createSymbolicLink(at: plugin, withDestinationURL: outside)
        XCTAssertThrowsError(try files().install(port: 49150, in: folder))
        XCTAssertEqual(try Data(contentsOf: outside), foreign)
        try FileManager.default.removeItem(at: plugin)
        try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent("agentdeck-connection.json"), withDestinationURL: outside)
        XCTAssertThrowsError(try files().install(port: 49150, in: folder))
        XCTAssertFalse(FileManager.default.fileExists(atPath: plugin.path))
    }
    func testOnlyExactCanonicalCliCanBeMigratedAndUnknownReceiverDataIsPreserved() throws {
        let folder = try folder(), receiver = folder.appendingPathComponent("agentdeck-connection.json")
        try Data("// canonical CLI".utf8).write(to: folder.appendingPathComponent("agentdeck.js"))
        try files().install(port: 49150, in: folder)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: receiver)) as? [String: Any])
        object["future"] = ["retain": true]
        try JSONSerialization.data(withJSONObject: object).write(to: receiver)
        try files().updateReceiver(port: 49151, in: folder)
        object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: receiver)) as? [String: Any])
        XCTAssertEqual(object["port"] as? Int, 49151)
        XCTAssertEqual((object["future"] as? [String: Bool])?["retain"], true)
        try Data("{".utf8).write(to: receiver)
        XCTAssertThrowsError(try files().remove(in: folder))
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent("agentdeck.js").path))
    }
    @MainActor
    func testBookmarkRestorationPortSyncAndRemovalRevokesAccess() throws {
        let folder = try folder(), suite = "OpenCodeSetup.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        var granted = true
        let access = HermesReceiverSettings.FolderAccess(makeBookmark: { Data($0.path.utf8) }, resolve: {
            (URL(fileURLWithPath: String(decoding: $0, as: UTF8.self)), false)
        }, start: { _ in granted }, stop: { _ in })
        let first = OpenCodeObserverSetup(defaults: defaults, access: access)
        XCTAssertTrue(first.selectFolder(folder))
        first.localReceiverChanged(port: 49150)
        first.install()
        XCTAssertFalse(first.hasError)
        let second = OpenCodeObserverSetup(defaults: defaults, access: access)
        second.localReceiverChanged(port: 49151)
        let receiver = folder.appendingPathComponent("agentdeck-connection.json")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: receiver)) as? [String: Any])
        XCTAssertEqual(object["port"] as? Int, 49151)
        granted = false
        second.remove()
        XCTAssertTrue(second.hasError)
        XCTAssertTrue(second.hasSelection)
        granted = true
        second.remove()
        XCTAssertFalse(second.hasError)
        XCTAssertFalse(second.hasSelection)
        second.localReceiverChanged(port: 49152)
        XCTAssertFalse(FileManager.default.fileExists(atPath: receiver.path))
    }
}
#endif
