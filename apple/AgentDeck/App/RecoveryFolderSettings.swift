#if os(macOS)
import AppKit
import Combine
import Foundation
import CoreFoundation

/// The only authority for native access is a user-selected, persistent bookmark.
@MainActor
final class RecoveryFolderSettings: ObservableObject {
    static let shared = RecoveryFolderSettings()
    static let bookmarkKey = "prefs.recoveryFolderBookmark"
    @Published private(set) var selectedPath: String?
    @Published var errorMessage: String?
    private let defaults: UserDefaults
    static var recommendedDirectory: URL {
        let home = getpwuid(getuid()).flatMap { $0.pointee.pw_dir }.map { String(cString: $0) } ?? NSHomeDirectory()
        return URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support").appendingPathComponent(DaemonParityRules.recoveryFolderName, isDirectory: true)
    }
    init(defaults: UserDefaults = .standard) { self.defaults = defaults; selectedPath = defaults.string(forKey: "prefs.recoveryFolderPath") }
    func directory(requireConsent: Bool = true) throws -> URL? {
        guard defaults.string(forKey: "prefs.recoveryDataDirectory") == AgentDeckPaths.baseDirectory.path else { return nil }
        if requireConsent && !defaults.bool(forKey: "prefs.recoveryConfirmed") { return nil }
        guard let data = defaults.data(forKey: Self.bookmarkKey) else { return nil }
        var stale = false
        let url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
        guard url.startAccessingSecurityScopedResource() else { throw CocoaError(.fileReadNoPermission) }
        defer { url.stopAccessingSecurityScopedResource() }
        if stale {
            defaults.set(try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil), forKey: Self.bookmarkKey)
        }
        if requireConsent {
            let marker = try JSONSerialization.jsonObject(with: Data(contentsOf: url.appendingPathComponent(DaemonParityRules.recoveryConsentFile))) as? [String: Any]
            guard let marker, DaemonConfigurationRules.integer(marker["version"]) == Int64(DaemonParityRules.recoveryVersion),
                  let enabled = marker["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(),
                  let store = marker["store"] as? String, UUID(uuidString: store) != nil else { throw CocoaError(.fileReadCorruptFile) }
            if !enabled.boolValue { return nil }
        }
        return url
    }
    func choose() throws -> URL? {
        let panel = NSOpenPanel()
        panel.title = "Choose a recovery folder"
        panel.message = "AgentDeck will create a dedicated folder for display settings, session pins and aggregate learning. Conversation text and account credentials are excluded."
        panel.prompt = "Use Folder"; panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.canCreateDirectories = true; panel.allowsMultipleSelection = false
        panel.directoryURL = Self.recommendedDirectory.deletingLastPathComponent()
        guard panel.runModal() == .OK, let parent = panel.url else { return nil }
        let scoped = parent.startAccessingSecurityScopedResource()
        defer { if scoped { parent.stopAccessingSecurityScopedResource() } }
        let values = try parent.resourceValues(forKeys: [.volumeIsLocalKey, .isUbiquitousItemKey])
        guard values.volumeIsLocal == true, values.isUbiquitousItem != true else { throw CocoaError(.fileWriteUnsupportedScheme) }
        let url = parent.lastPathComponent == DaemonParityRules.recoveryFolderName ? parent : parent.appendingPathComponent(DaemonParityRules.recoveryFolderName, isDirectory: true)
        guard url.standardizedFileURL == Self.recommendedDirectory.standardizedFileURL else {
            throw NSError(domain: "RecoveryFolder", code: 1, userInfo: [NSLocalizedDescriptionKey: "Choose the recommended Application Support folder, or its existing AgentDeck Recovery folder, so recovery can be found after a restart."])
        }
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let bookmark = try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
        defaults.set(bookmark, forKey: Self.bookmarkKey); defaults.set(url.path, forKey: "prefs.recoveryFolderPath")
        defaults.set(AgentDeckPaths.baseDirectory.path, forKey: "prefs.recoveryDataDirectory")
        defaults.set(false, forKey: "prefs.recoveryConfirmed")
        selectedPath = url.path; errorMessage = nil
        return url
    }
    func disconnect() {
        defaults.removeObject(forKey: Self.bookmarkKey); defaults.removeObject(forKey: "prefs.recoveryFolderPath")
        defaults.removeObject(forKey: "prefs.recoveryDataDirectory")
        defaults.removeObject(forKey: "prefs.recoveryConfirmed")
        selectedPath = nil; errorMessage = nil
    }
    func confirm() { defaults.set(true, forKey: "prefs.recoveryConfirmed") }
}
#endif
