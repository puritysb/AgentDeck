#if os(macOS)
import AppKit
import Combine
import Foundation

/// User-owned access to an existing observer. This configures its data file;
/// it never installs, enables, loads or executes the observer's Python code.
@MainActor
final class HermesReceiverSettings: ObservableObject {
    static let shared = HermesReceiverSettings()
    static let bookmarkKey = "prefs.hermesObserverBookmark"
    private static let pathKey = "prefs.hermesObserverPath"

    struct FolderAccess {
        var makeBookmark: (URL) throws -> Data = {
            try $0.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
        }
        var resolve: (Data) throws -> (url: URL, stale: Bool) = {
            var stale = false
            let url = try URL(resolvingBookmarkData: $0, options: [.withSecurityScope, .withoutUI],
                              relativeTo: nil, bookmarkDataIsStale: &stale)
            return (url, stale)
        }
        var start: (URL) -> Bool = { $0.startAccessingSecurityScopedResource() }
        var stop: (URL) -> Void = { $0.stopAccessingSecurityScopedResource() }
    }

    @Published private(set) var selectedPath: String?
    @Published private(set) var errorMessage: String?
    @Published private(set) var savedPort: UInt16?
    @Published private(set) var localPort: UInt16?
    private let defaults: UserDefaults
    private let access: FolderAccess

    var isEnabled: Bool { defaults.data(forKey: Self.bookmarkKey) != nil }
    var detail: String {
        if let errorMessage { return errorMessage }
        guard isEnabled else { return "Choose an existing observer folder to keep Hermes connected to this Mac." }
        guard localPort != nil else { return "Waiting for this Mac’s receiver. The last saved port is unchanged." }
        if let savedPort { return "Receiver saved on port \(savedPort). Session activity appears when Hermes sends events." }
        return "Receiver settings have not been saved yet. Retry or choose the observer folder again."
    }

    init(defaults: UserDefaults = .standard, access: FolderAccess = .init()) {
        self.defaults = defaults
        self.access = access
        selectedPath = defaults.string(forKey: Self.pathKey)
    }

    /// Only DaemonService's ready endpoint enters here, including a local
    /// Node handover. Clearing readiness never deletes the explicit selection:
    /// a missing connection.json would silently opt the observer into registry discovery.
    func localReceiverChanged(port: UInt16?) {
        localPort = port.flatMap { $0 == 0 ? nil : $0 }
        savedPort = nil
        synchronize()
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.title = "Choose Hermes observer folder"
        panel.message = "Choose the existing agentdeck-observer folder for your Hermes profile. AgentDeck will keep its receiver setting up to date with this Mac’s local receiver."
        panel.prompt = "Keep Connected"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        // Navigation hint only; Powerbox supplies access after selection.
        if let pw = getpwuid(getuid()), let home = pw.pointee.pw_dir {
            panel.directoryURL = URL(fileURLWithPath: String(cString: home)).appendingPathComponent(".hermes")
        }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        selectFolder(url)
    }

    @discardableResult
    func selectFolder(_ url: URL) -> Bool {
        guard access.start(url) else {
            errorMessage = "Folder access was denied. Choose the observer folder again."
            return false
        }
        defer { access.stop(url) }
        do {
            try HermesReceiverFile.validateFolder(url)
            let bookmark = try access.makeBookmark(url)
            defaults.set(bookmark, forKey: Self.bookmarkKey)
            defaults.set(url.path, forKey: Self.pathKey)
            defaults.synchronize()
            selectedPath = url.path
            errorMessage = nil
            savedPort = nil
            // Use the currently ready port even if selection happens after launch.
            synchronize()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func synchronize() {
        guard let bookmark = defaults.data(forKey: Self.bookmarkKey), let localPort else { return }
        do {
            let resolved = try access.resolve(bookmark)
            guard access.start(resolved.url) else {
                throw HermesReceiverFile.Failure("Folder access was denied. Choose the observer folder again.")
            }
            defer { access.stop(resolved.url) }
            if resolved.stale {
                defaults.set(try access.makeBookmark(resolved.url), forKey: Self.bookmarkKey)
                defaults.synchronize()
            }
            try HermesReceiverFile.write(port: localPort, in: resolved.url)
            selectedPath = resolved.url.path
            defaults.set(resolved.url.path, forKey: Self.pathKey)
            savedPort = localPort
            errorMessage = nil
        } catch {
            savedPort = nil
            errorMessage = "Could not save the Hermes receiver. \(error.localizedDescription)"
        }
    }

    /// Revocation ends all future access, leaving the last explicit receiver.
    func stopSyncing() {
        defaults.removeObject(forKey: Self.bookmarkKey)
        defaults.removeObject(forKey: Self.pathKey)
        defaults.synchronize()
        selectedPath = nil
        savedPort = nil
        errorMessage = nil
    }
}

/// Existing contract owned by hooks/src/hermes-install.ts and read per delivery
/// by hooks/hermes-agentdeck/__init__.py. No new endpoint discovery protocol.
enum HermesReceiverFile {
    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    static func validateFolder(_ folder: URL) throws {
        let fm = FileManager.default
        guard try fm.attributesOfItem(atPath: folder.path)[.type] as? FileAttributeType == .typeDirectory else {
            throw Failure("Choose the existing agentdeck-observer folder.")
        }
        // Match the installer's ownership decision (marker presence), without
        // inventing a second version policy. Refuse links in the selected folder.
        _ = try readRegularFile(folder.appendingPathComponent(".agentdeck-owned"))
        for name in ["__init__.py", "plugin.yaml"] {
            guard try fm.attributesOfItem(atPath: folder.appendingPathComponent(name).path)[.type]
                    as? FileAttributeType == .typeRegular else {
                throw Failure("The observer folder is incomplete. Choose its existing installation folder.")
            }
        }
    }

    static func write(port: UInt16, in folder: URL) throws {
        guard port > 0 else { throw Failure("The local receiver is not ready.") }
        try validateFolder(folder)
        let target = folder.appendingPathComponent("connection.json")
        var object: [String: Any] = [:]
        do {
            let bytes = try readRegularFile(target)
            guard let existing = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                throw Failure("connection.json must contain a JSON object. Its contents were left unchanged.")
            }
            object = existing
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            // A new explicit selection is allowed; every other read error is fatal.
        }
        object["port"] = Int(port)
        guard JSONSerialization.isValidJSONObject(object) else {
            throw Failure("connection.json contains unsupported values. Its contents were left unchanged.")
        }
        var bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        bytes.append(0x0a)
        try bytes.write(to: target, options: .atomic)
    }

    private static func readRegularFile(_ url: URL) throws -> Data {
        guard try FileManager.default.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType == .typeRegular else {
            throw Failure("\(url.lastPathComponent) must be a regular file, not a link or directory.")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let limit = 64 * 1024
        let bytes = try handle.read(upToCount: limit + 1) ?? Data()
        guard bytes.count <= limit else { throw Failure("\(url.lastPathComponent) is too large to read safely.") }
        return bytes
    }
}
#endif
