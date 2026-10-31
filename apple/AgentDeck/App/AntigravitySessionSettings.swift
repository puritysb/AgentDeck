#if os(macOS)
import AppKit
import Combine
import Foundation

/// Shared synchronous authorization epoch: revocation invalidates cached rows
/// even while an earlier file read is resuming on the daemon actor.
final class AntigravityAccessGate: @unchecked Sendable {
    private let lock = NSLock()
    private var revision = 0
    private var enabled = false
    func advance(enabled: Bool) -> Int {
        lock.withLock { revision += 1; self.enabled = enabled; return revision }
    }
    func accepts(_ revision: Int?) -> Bool {
        lock.withLock { enabled && revision == self.revision }
    }
}
struct AntigravityFolderAccess: Sendable {
    var makeBookmark: @Sendable (URL) throws -> Data = {
        try $0.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess], includingResourceValuesForKeys: nil, relativeTo: nil)
    }
    var resolve: @Sendable (Data) throws -> (URL, Bool) = {
        var stale = false
        let url = try URL(resolvingBookmarkData: $0, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
        return (url, stale)
    }
    var start: @Sendable (URL) -> Bool = { $0.startAccessingSecurityScopedResource() }
    var stop: @Sendable (URL) -> Void = { $0.stopAccessingSecurityScopedResource() }
}

@MainActor
final class AntigravitySessionSettings: ObservableObject {
    static let shared = AntigravitySessionSettings()
    nonisolated static let accessGate = AntigravityAccessGate()
    static let bookmarkKey = "prefs.antigravitySessionsBookmark"
    static let pathKey = "prefs.antigravitySessionsPath"
    @Published private(set) var selectedPath: String?
    @Published private(set) var snapshot = AntigravityScan(reason: "not_configured")
    @Published private(set) var errorMessage: String?
    private let defaults: UserDefaults
    private let access: AntigravityFolderAccess
    private let gate: AntigravityAccessGate
    private var revision: Int
    private var scanSerial = 0
    private var inFlight: (Int, Int, Task<ReadResult, Never>)?
    private struct ReadResult: Sendable {
        var snapshot: AntigravityScan
        var renewed: Data?
        var path: String?
    }
    var isEnabled: Bool { defaults.data(forKey: Self.bookmarkKey) != nil }
    var detail: String {
        if let errorMessage { return errorMessage }
        guard isEnabled else { return "Choose an Antigravity transcript folder to observe recent conversations on this Mac." }
        guard snapshot.status == "known" else { return "Folder selected. Session evidence has not been confirmed yet." }
        let stale = snapshot.observations.filter { $0.status == "stale" }.count
        let unknown = snapshot.observations.filter { $0.status == "unknown" }.count
        return "Last scan: \(snapshot.known.count) recent conversations · \(stale) stale · \(unknown) unreadable or unknown (bounded scan)."
    }
    init(defaults: UserDefaults = .standard, access: AntigravityFolderAccess = .init(), gate: AntigravityAccessGate = AntigravitySessionSettings.accessGate) {
        self.defaults = defaults; self.access = access; self.gate = gate
        selectedPath = defaults.string(forKey: Self.pathKey)
        revision = gate.advance(enabled: defaults.data(forKey: Self.bookmarkKey) != nil)
    }
    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.title = "Choose Antigravity transcript folder"
        panel.message = "Choose antigravity-cli or antigravity inside your .gemini folder. AgentDeck reads supported JSONL identity and SQLite activity without changing them. This does not grant account or plan access."
        panel.prompt = "Observe Sessions"
        panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.canCreateDirectories = false; panel.allowsMultipleSelection = false; panel.showsHiddenFiles = true
        if let pw = getpwuid(getuid()), let home = pw.pointee.pw_dir {
            panel.directoryURL = URL(fileURLWithPath: String(cString: home)).appendingPathComponent(".gemini")
        }
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        if selectFolder(folder) { Task { _ = await read() } }
    }
    @discardableResult
    func selectFolder(_ folder: URL) -> Bool {
        guard access.start(folder) else { errorMessage = "Folder access was denied. Choose the folder again."; return false }
        defer { access.stop(folder) }
        do {
            try AntigravitySourceReader.validateFolder(folder)
            let bookmark = try access.makeBookmark(folder)
            defaults.set(bookmark, forKey: Self.bookmarkKey); defaults.set(folder.path, forKey: Self.pathKey)
            defaults.synchronize()
            revision = gate.advance(enabled: true)
            inFlight?.2.cancel(); inFlight = nil
            selectedPath = folder.path; errorMessage = nil; snapshot = AntigravityScan(reason: "not_read")
            return true
        } catch { errorMessage = "Choose a folder containing a readable brain directory. Existing access was preserved."; return false }
    }
    func read(nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) async -> AntigravityScan {
        guard let bookmark = defaults.data(forKey: Self.bookmarkKey) else { return AntigravityScan(reason: "not_configured") }
        let epoch = revision
        let task: Task<ReadResult, Never>
        let serial: Int
        if let existing = inFlight, existing.0 == epoch { task = existing.2; serial = existing.1 }
        else {
            scanSerial += 1; serial = scanSerial
            let access = self.access, gate = self.gate
            task = Task.detached(priority: .utility) {
                do {
                    let (url, stale) = try access.resolve(bookmark)
                    guard gate.accepts(epoch), access.start(url) else { return ReadResult(snapshot: AntigravityScan(reason: "access_denied")) }
                    defer { access.stop(url) }
                    guard gate.accepts(epoch) else { return ReadResult(snapshot: AntigravityScan(reason: "access_revoked")) }
                    var scan = AntigravitySourceReader.scan(root: url, nowMs: nowMs, permitted: { gate.accepts(epoch) })
                    scan.grantRevision = epoch
                    let renewed = stale ? try access.makeBookmark(url) : nil
                    return ReadResult(snapshot: scan, renewed: renewed, path: url.path)
                } catch { return ReadResult(snapshot: AntigravityScan(reason: "bookmark_unavailable")) }
            }
            inFlight = (epoch, serial, task)
        }
        let result = await task.value
        let currentBookmark = defaults.data(forKey: Self.bookmarkKey)
        let sameBookmark = currentBookmark == bookmark || (result.renewed != nil && currentBookmark == result.renewed)
        guard gate.accepts(epoch), revision == epoch, scanSerial == serial, sameBookmark else {
            return AntigravityScan(reason: "superseded")
        }
        inFlight = nil
        if let renewed = result.renewed {
            defaults.set(renewed, forKey: Self.bookmarkKey); defaults.synchronize()
        }
        if let path = result.path { selectedPath = path; defaults.set(path, forKey: Self.pathKey) }
        var verified = result.snapshot
        verified.grantRevision = epoch
        snapshot = verified
        errorMessage = snapshot.status == "unknown" ? "Session source is unknown (\(snapshot.reason)). Retry or choose the folder again." : nil
        return snapshot
    }
    func stopObserving() {
        revision = gate.advance(enabled: false)
        inFlight?.2.cancel(); inFlight = nil
        defaults.removeObject(forKey: Self.bookmarkKey); defaults.removeObject(forKey: Self.pathKey); defaults.synchronize()
        selectedPath = nil; errorMessage = nil; snapshot = AntigravityScan(reason: "not_configured")
    }
}
#endif
