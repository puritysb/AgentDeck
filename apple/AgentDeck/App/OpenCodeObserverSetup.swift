#if os(macOS)
import AppKit
import Combine
import CryptoKit
import Foundation

/// Installs data for OpenCode to load; never executes the plugin in the app.
@MainActor
final class OpenCodeObserverSetup: ObservableObject {
    static let shared = OpenCodeObserverSetup()
    private let defaults: UserDefaults
    private let access: HermesReceiverSettings.FolderAccess
    private static let bookmarkKey = "prefs.openCodeObserverBookmark"
    private static let pathKey = "prefs.openCodeObserverPath"
    @Published private(set) var selectedPath: String?
    @Published private(set) var message = "Select your existing OpenCode plugins folder to enable session observation."
    @Published private(set) var hasError = false
    @Published private(set) var port: UInt16?
    var hasSelection: Bool { defaults.data(forKey: Self.bookmarkKey) != nil }

    init(defaults: UserDefaults = .standard, access: HermesReceiverSettings.FolderAccess = .init()) {
        self.defaults = defaults
        self.access = access
        selectedPath = defaults.string(forKey: Self.pathKey)
    }

    func localReceiverChanged(port: UInt16?) {
        self.port = port.flatMap { $0 > 0 ? $0 : nil }
        guard let port = self.port, hasSelection else { return }
        perform { folder in
            let files = try OpenCodeObserverFiles.bundled()
            if try files.isInstalled(in: folder) {
                try files.updateReceiver(port: port, in: folder)
                return "Receiver saved on port \(port). OpenCode activity confirms event delivery."
            }
            return "Folder selected. Install the observer when ready."
        }
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.title = "Choose OpenCode plugins folder"
        panel.message = "Choose the existing plugins folder for your OpenCode configuration. AgentDeck can then install its observation-only plugin and keep the local receiver setting up to date. Other plugins and configuration files are preserved."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        selectFolder(url)
    }

    @discardableResult
    func selectFolder(_ url: URL) -> Bool {
        guard access.start(url) else { message = "Folder access was denied. Choose the folder again."; hasError = true; return false }
        defer { access.stop(url) }
        do {
            try OpenCodeObserverFiles.validateDirectory(url)
            let bookmark = try access.makeBookmark(url)
            defaults.set(bookmark, forKey: Self.bookmarkKey)
            defaults.set(url.path, forKey: Self.pathKey)
            defaults.synchronize()
            selectedPath = url.path
            message = "Folder selected. Install the observer when ready."
            hasError = false
            return true
        } catch { message = error.localizedDescription; hasError = true; return false }
    }

    func install() {
        guard let port else { message = "Waiting for this Mac’s local receiver."; return }
        perform { folder in
            try OpenCodeObserverFiles.bundled().install(port: port, in: folder)
            return "Observer saved on port \(port). New OpenCode processes load the updated plugin; received activity confirms it is active."
        }
    }

    func remove() {
        perform { folder in
            try OpenCodeObserverFiles.bundled().remove(in: folder)
            return "Observer files removed. Already-running OpenCode processes keep their loaded plugin until they exit."
        }
        if !hasError {
            forgetFolder()
            message = "Observer files removed. Already-running OpenCode processes keep their loaded plugin until they exit."
        }
    }

    func forgetFolder() {
        defaults.removeObject(forKey: Self.bookmarkKey)
        defaults.removeObject(forKey: Self.pathKey)
        defaults.synchronize()
        selectedPath = nil
        message = "Folder access removed. Installed observer files remain in place."
        hasError = false
    }

    private func perform(_ body: (URL) throws -> String) {
        guard let bookmark = defaults.data(forKey: Self.bookmarkKey) else { return }
        do {
            let resolved = try access.resolve(bookmark)
            guard access.start(resolved.url) else { throw OpenCodeObserverFiles.Failure("Folder access was denied. Choose the folder again.") }
            defer { access.stop(resolved.url) }
            if resolved.stale {
                defaults.set(try access.makeBookmark(resolved.url), forKey: Self.bookmarkKey)
                defaults.synchronize()
            }
            message = try body(resolved.url)
            hasError = false
        } catch { message = error.localizedDescription; hasError = true }
    }
}

struct OpenCodeObserverFiles {
    struct Payload: Decodable { let source: String; let cliSHA256: String; let pluginFilename: String; let receiverFilename: String; let owner: String }
    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }
    let payload: Payload
    static func bundled() throws -> Self {
        guard let url = Bundle.main.url(forResource: "OpenCodeObserver", withExtension: "json") else {
            throw Failure("The bundled observer is missing.")
        }
        return Self(payload: try JSONDecoder().decode(Payload.self, from: Data(contentsOf: url)))
    }
    static func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private var source: Data { Data(payload.source.utf8) }
    private var pluginName: String { payload.pluginFilename }
    private var receiverName: String { payload.receiverFilename }

    static func validateDirectory(_ folder: URL) throws {
        guard try FileManager.default.attributesOfItem(atPath: folder.path)[.type] as? FileAttributeType == .typeDirectory else {
            throw Failure("Select an existing OpenCode plugins directory, not a link.")
        }
    }
    private func read(_ name: String, in folder: URL) throws -> Data? {
        let url = folder.appendingPathComponent(name)
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  let size = attributes[.size] as? NSNumber, size.intValue <= 256 * 1024 else {
                throw Failure("\(name) must be a regular file within the supported size. No files were changed.")
            }
            return try Data(contentsOf: url)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }
    private func receiver(in folder: URL) throws -> [String: Any]? {
        guard let data = try read(receiverName, in: folder) else { return nil }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["owner"] as? String == payload.owner else {
            throw Failure("The receiver file belongs to another setup. No files were changed.")
        }
        return object
    }
    private func checked(in folder: URL) throws -> (Data?, [String: Any]?) {
        try Self.validateDirectory(folder)
        let plugin = try read(pluginName, in: folder)
        let config = try receiver(in: folder)
        if let plugin {
            let hash = Self.hash(plugin)
            let recorded = config?["installedSHA256"] as? String
            guard hash == Self.hash(source) || hash == payload.cliSHA256 || (recorded != nil && hash == recorded) else {
                throw Failure("agentdeck.js has unrecognized or edited contents. Preserve it or review it before choosing this folder. No files were changed.")
            }
        }
        return (plugin, config)
    }
    func isInstalled(in folder: URL) throws -> Bool {
        let (plugin, config) = try checked(in: folder)
        return plugin != nil && config != nil
    }
    private func writeReceiver(_ object: [String: Any], in folder: URL) throws {
        guard JSONSerialization.isValidJSONObject(object) else { throw Failure("Unsupported receiver settings.") }
        var data = try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
        data.append(0x0a)
        try data.write(to: folder.appendingPathComponent(receiverName), options: .atomic)
    }
    func install(port: UInt16, in folder: URL) throws {
        guard port > 0 else { throw Failure("The local receiver is not ready.") }
        let (old, config) = try checked(in: folder)
        var object = config ?? ["owner": payload.owner]
        object["port"] = Int(port)
        object["installedSHA256"] = Self.hash(source)
        // Establish a valid receiver before publishing a loadable plugin.
        try writeReceiver(object, in: folder)
        do { if old != source { try source.write(to: folder.appendingPathComponent(pluginName), options: .atomic) } }
        catch {
            if let config { try? writeReceiver(config, in: folder) }
            else { try? FileManager.default.removeItem(at: folder.appendingPathComponent(receiverName)) }
            throw error
        }
    }
    func updateReceiver(port: UInt16, in folder: URL) throws {
        guard port > 0 else { throw Failure("The local receiver is not ready.") }
        let (_, config) = try checked(in: folder)
        guard var object = config else { return }
        object["port"] = Int(port)
        try writeReceiver(object, in: folder)
    }
    func remove(in folder: URL) throws {
        let (plugin, config) = try checked(in: folder)
        if plugin != nil { try FileManager.default.removeItem(at: folder.appendingPathComponent(pluginName)) }
        if config != nil { try FileManager.default.removeItem(at: folder.appendingPathComponent(receiverName)) }
    }
}
#endif
