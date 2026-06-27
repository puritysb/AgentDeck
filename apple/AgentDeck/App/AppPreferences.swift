import Foundation
import SwiftUI
import UniformTypeIdentifiers

#if os(macOS)
import AppKit
#endif

final class AppPreferences: ObservableObject, @unchecked Sendable {
    static let shared = AppPreferences()

    /// Tri-state consent for Claude Code hook auto-install. App Store review
    /// guideline 2.5.2 forbids silently modifying user files outside the
    /// sandbox — we gate `HookInstaller` on `.accepted` and surface the
    /// choice in Settings. `.unknown` is the default so first-launch does
    /// nothing until the user explicitly opts in.
    enum HookInstallConsent: String, Codable, CaseIterable {
        case unknown
        case accepted
        case declined
    }

    enum MenuBarIconStyle: String, CaseIterable, Identifiable {
        case status
        case app
        case minimal

        var id: String { rawValue }

        var title: String {
            switch self {
            case .status: return "Status"
            case .app: return "App"
            case .minimal: return "Minimal"
            }
        }
    }

    /// Default daemon hub port. 9120 is the documented well-known port; users
    /// can override when it's already held by something outside this app's
    /// control (e.g. a lingering `agentdeck daemon` Node CLI process).
    static let defaultDaemonPort: Int = 9120

    @Published var daemonPort: Int {
        didSet {
            let clamped = Self.clampPort(daemonPort)
            if clamped != daemonPort {
                daemonPort = clamped  // triggers didSet again with valid value
                return
            }
            defaults.set(daemonPort, forKey: Keys.daemonPort)
        }
    }

    @Published var openDashboardOnLaunch: Bool {
        didSet { defaults.set(openDashboardOnLaunch, forKey: Keys.openDashboardOnLaunch) }
    }
    @Published var d200hBakeSessionText: Bool {
        didSet { defaults.set(d200hBakeSessionText, forKey: Keys.d200hBakeSessionText) }
    }
    @Published var d200hHideNativeSessionLabels: Bool {
        didSet { defaults.set(d200hHideNativeSessionLabels, forKey: Keys.d200hHideNativeSessionLabels) }
    }
    @Published var menuBarIconStyle: MenuBarIconStyle {
        didSet { defaults.set(menuBarIconStyle.rawValue, forKey: Keys.menuBarIconStyle) }
    }
    @Published var showSessionList: Bool {
        didSet { defaults.set(showSessionList, forKey: Keys.showSessionList) }
    }
    @Published var showTankStatus: Bool {
        didSet { defaults.set(showTankStatus, forKey: Keys.showTankStatus) }
    }
    @Published var showDeviceDiagnostic: Bool {
        didSet { defaults.set(showDeviceDiagnostic, forKey: Keys.showDeviceDiagnostic) }
    }
    @Published var showTimeline: Bool {
        didSet { defaults.set(showTimeline, forKey: Keys.showTimeline) }
    }
    @Published var showSettingsButton: Bool {
        didSet { defaults.set(showSettingsButton, forKey: Keys.showSettingsButton) }
    }
    @Published var showOpenClawSection: Bool {
        didSet { defaults.set(showOpenClawSection, forKey: Keys.showOpenClawSection) }
    }
    @Published var showMLXSection: Bool {
        didSet { defaults.set(showMLXSection, forKey: Keys.showMLXSection) }
    }
    @Published var showOllamaSection: Bool {
        didSet { defaults.set(showOllamaSection, forKey: Keys.showOllamaSection) }
    }
    @Published var showAntigravitySection: Bool {
        didSet { defaults.set(showAntigravitySection, forKey: Keys.showAntigravitySection) }
    }
    @Published var showSubscriptionsSection: Bool {
        didSet { defaults.set(showSubscriptionsSection, forKey: Keys.showSubscriptionsSection) }
    }

    /// APME judge backend selected by the user in Settings. Default is
    /// `foundationModels` (on-device, zero cost, macOS 26+). The didSet
    /// mirrors the choice into `~/.agentdeck/settings.json` so the Node
    /// bridge + Swift daemon share a single source of truth. Per
    /// feedback_cost_sensitive_defaults memory, switching to `.api` is a
    /// paid opt-in — the Settings UI surfaces that before accepting.
    @Published var apmeJudgeBackend: String {
        didSet {
            defaults.set(apmeJudgeBackend, forKey: Keys.apmeJudgeBackend)
            writeApmeJudgeBackendToSettingsJson(apmeJudgeBackend)
        }
    }

    /// Backend selector for the timeline `chat_end` LLM summary path.
    /// Values: `auto` (Apple Intelligence → MLX → Ollama → heuristic),
    /// `appleIntelligence` (FoundationModels only → heuristic),
    /// `mlx` (local MLX server only → heuristic),
    /// `heuristic` (no LLM call). Default is `auto` so cost-free backends are
    /// tried first; an explicit pick short-circuits to that backend's tier.
    @Published var timelineSummaryProvider: String {
        didSet {
            defaults.set(timelineSummaryProvider, forKey: Keys.timelineSummaryProvider)
            writeTimelineSummaryProviderToSettingsJson(timelineSummaryProvider)
        }
    }

    /// Master toggle for dimming downstream dashboard devices (Pixoo, D200H,
    /// ESP32) when the host Mac display sleeps/locks. Mirrored into
    /// settings.json `displaySleepDim` so the in-process daemon resolves the
    /// instruction it broadcasts. Defaults reproduce legacy behavior
    /// (enabled + full-off). The three properties share one writer.
    @Published var displaySleepDimEnabled: Bool {
        didSet {
            defaults.set(displaySleepDimEnabled, forKey: Keys.displaySleepDimEnabled)
            writeDisplaySleepDimToSettingsJson()
        }
    }

    /// `off` ⇒ devices go dark (brightness 0); `min` ⇒ devices dim to
    /// `displaySleepDimLevel`. Only meaningful when `displaySleepDimEnabled`.
    @Published var displaySleepDimMode: String {
        didSet {
            defaults.set(displaySleepDimMode, forKey: Keys.displaySleepDimMode)
            writeDisplaySleepDimToSettingsJson()
        }
    }

    /// Minimum-brightness percent (1-100) applied when mode is `min`.
    @Published var displaySleepDimLevel: Int {
        didSet {
            defaults.set(displaySleepDimLevel, forKey: Keys.displaySleepDimLevel)
            writeDisplaySleepDimToSettingsJson()
        }
    }

    @Published private(set) var antigravityAccessEnabled: Bool
    @Published private(set) var antigravitySelectedPath: String?

    /// User's current consent state for writing to `~/.claude/settings.local.json`.
    /// `.unknown` on fresh install → HookInstaller no-ops until user opts in.
    @Published var hookInstallConsent: HookInstallConsent {
        didSet { defaults.set(hookInstallConsent.rawValue, forKey: Keys.hookInstallConsent) }
    }

    /// Whether the hook JSON has actually been written to disk. Distinct from
    /// `hookInstallConsent` so the app can remember install state even if the
    /// user later revokes the bookmark or switches to `.declined`.
    @Published var hooksInstalled: Bool {
        didSet { defaults.set(hooksInstalled, forKey: Keys.hooksInstalled) }
    }

    /// Tri-state consent for editing `~/.codex/config.toml`. Mirrors the
    /// Claude `hookInstallConsent` pattern — `.unknown` on fresh install →
    /// `CodexConfigInstaller` no-ops until the user opts in via Settings.
    @Published var codexConfigConsent: HookInstallConsent {
        didSet { defaults.set(codexConfigConsent.rawValue, forKey: Keys.codexConfigConsent) }
    }

    /// Whether AgentDeck's fenced block has actually been written into
    /// `~/.codex/config.toml`. Distinct from `codexConfigConsent` so the
    /// app can remember install state even after revocation.
    @Published var codexConfigInstalled: Bool {
        didSet { defaults.set(codexConfigInstalled, forKey: Keys.codexConfigInstalled) }
    }

    /// First-launch tracking for the Device Preview window. Flips to `true`
    /// the first time the user opens the window so the empty-state banner
    /// can stop nudging them. Pure local flag — not mirrored to
    /// settings.json, no bridge coupling.
    @Published var hasSeenDevicePreview: Bool {
        didSet { defaults.set(hasSeenDevicePreview, forKey: Keys.hasSeenDevicePreview) }
    }

    /// First-launch tracking for the Monitor empty-state onboarding card.
    /// Flips to `true` the first time the user dismisses the overlay so
    /// returning users aren't re-nudged once they know how to launch a
    /// session or preview devices. Pure local flag.
    @Published var hasSeenMonitorEmptyGuide: Bool {
        didSet { defaults.set(hasSeenMonitorEmptyGuide, forKey: Keys.hasSeenMonitorEmptyGuide) }
    }

    /// One-shot guard for the first-launch notification permission prompt.
    /// Flips to `true` as soon as we either show the system authorization
    /// dialog or record a "Not Now" decline, so the explanatory NSAlert
    /// never fires twice. Settings exposes a "Request Again" affordance
    /// that clears it for users who want to revisit the choice.
    @Published var hasRequestedNotifications: Bool {
        didSet { defaults.set(hasRequestedNotifications, forKey: Keys.hasRequestedNotifications) }
    }

    /// First-run onboarding tracking. Flips to `true` when the user
    /// completes or skips the 3-pane onboarding sheet (macOS) /
    /// full-screen flow (iOS). Pure local flag; not mirrored to
    /// settings.json. Apple's App Store review guidelines expect a
    /// clear first-run orientation pass for non-developer consumers,
    /// so this gates the educational flow before the dashboard.
    @Published var hasSeenOnboarding: Bool {
        didSet { defaults.set(hasSeenOnboarding, forKey: Keys.hasSeenOnboarding) }
    }

    private let defaults: UserDefaults

    private init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let storedPort = defaults.object(forKey: Keys.daemonPort) as? Int
        self.daemonPort = Self.clampPort(storedPort ?? Self.defaultDaemonPort)
        self.openDashboardOnLaunch = defaults.object(forKey: Keys.openDashboardOnLaunch) as? Bool ?? true
        self.d200hBakeSessionText = defaults.object(forKey: Keys.d200hBakeSessionText) as? Bool ?? true
        self.d200hHideNativeSessionLabels = defaults.object(forKey: Keys.d200hHideNativeSessionLabels) as? Bool ?? true
        self.menuBarIconStyle = MenuBarIconStyle(rawValue: defaults.string(forKey: Keys.menuBarIconStyle) ?? "") ?? .status
        self.showSessionList = defaults.object(forKey: Keys.showSessionList) as? Bool ?? true
        self.showTankStatus = defaults.object(forKey: Keys.showTankStatus) as? Bool ?? true
        self.showDeviceDiagnostic = defaults.object(forKey: Keys.showDeviceDiagnostic) as? Bool ?? true
        self.showTimeline = defaults.object(forKey: Keys.showTimeline) as? Bool ?? true
        self.showSettingsButton = defaults.object(forKey: Keys.showSettingsButton) as? Bool ?? true
        self.showOpenClawSection = defaults.object(forKey: Keys.showOpenClawSection) as? Bool ?? true
        self.showMLXSection = defaults.object(forKey: Keys.showMLXSection) as? Bool ?? true
        self.showOllamaSection = defaults.object(forKey: Keys.showOllamaSection) as? Bool ?? true
        self.showAntigravitySection = defaults.object(forKey: Keys.showAntigravitySection) as? Bool ?? false
        self.showSubscriptionsSection = defaults.object(forKey: Keys.showSubscriptionsSection) as? Bool ?? true
        self.antigravitySelectedPath = defaults.string(forKey: Keys.antigravitySelectedPath)
        self.antigravityAccessEnabled = defaults.data(forKey: Keys.antigravityBookmark) != nil
        self.apmeJudgeBackend = defaults.string(forKey: Keys.apmeJudgeBackend) ?? "foundationModels"
        self.timelineSummaryProvider = defaults.string(forKey: Keys.timelineSummaryProvider) ?? "auto"
        self.displaySleepDimEnabled = defaults.object(forKey: Keys.displaySleepDimEnabled) as? Bool ?? true
        self.displaySleepDimMode = defaults.string(forKey: Keys.displaySleepDimMode) ?? "off"
        self.displaySleepDimLevel = defaults.object(forKey: Keys.displaySleepDimLevel) as? Int ?? 10
        self.hookInstallConsent = HookInstallConsent(rawValue: defaults.string(forKey: Keys.hookInstallConsent) ?? "") ?? .unknown
        self.hooksInstalled = defaults.object(forKey: Keys.hooksInstalled) as? Bool ?? false
        self.codexConfigConsent = HookInstallConsent(rawValue: defaults.string(forKey: Keys.codexConfigConsent) ?? "") ?? .unknown
        self.codexConfigInstalled = defaults.object(forKey: Keys.codexConfigInstalled) as? Bool ?? false
        self.hasSeenDevicePreview = defaults.object(forKey: Keys.hasSeenDevicePreview) as? Bool ?? false
        self.hasSeenMonitorEmptyGuide = defaults.object(forKey: Keys.hasSeenMonitorEmptyGuide) as? Bool ?? false
        self.hasRequestedNotifications = defaults.object(forKey: Keys.hasRequestedNotifications) as? Bool ?? false
        self.hasSeenOnboarding = defaults.object(forKey: Keys.hasSeenOnboarding) as? Bool ?? false
    }

    /// Merge the new backend choice into settings.json without clobbering
    /// other keys. Writes atomically so a crashed write doesn't leave the
    /// file half-parsed. The path resolves via AgentDeckPaths so signed
    /// builds land in the App Store sandbox container.
    private func writeApmeJudgeBackendToSettingsJson(_ backend: String) {
        #if os(macOS)
        let url = AgentDeckPaths.settingsJson

        // Load existing JSON (or start blank). Silently ignore parse errors —
        // a malformed file will be rewritten fresh with just our key.
        var root: [String: Any] = [:]
        if let data = try? Data(contentsOf: url),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            root = parsed
        }

        var apme = (root["apme"] as? [String: Any]) ?? [:]
        var judge = (apme["judge"] as? [String: Any]) ?? [:]
        judge["backend"] = backend
        apme["judge"] = judge
        root["apme"] = apme

        guard let out = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]) else { return }
        // AgentDeckPaths.baseDirectory eagerly creates the parent on first use,
        // so we only need to write the file here.
        try? out.write(to: url, options: [.atomic])
        #endif
    }

    /// Mirror the timeline-summary backend selection into settings.json.
    /// Lives under `timeline.summary.provider` so it doesn't collide with
    /// the APME judge backend (under `apme.judge.backend`). Same atomic-write
    /// + clobber-resistant merge as `writeApmeJudgeBackendToSettingsJson`.
    private func writeTimelineSummaryProviderToSettingsJson(_ provider: String) {
        #if os(macOS)
        let url = AgentDeckPaths.settingsJson

        var root: [String: Any] = [:]
        if let data = try? Data(contentsOf: url),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            root = parsed
        }

        var timeline = (root["timeline"] as? [String: Any]) ?? [:]
        var summary = (timeline["summary"] as? [String: Any]) ?? [:]
        summary["provider"] = provider
        timeline["summary"] = summary
        root["timeline"] = timeline

        guard let out = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? out.write(to: url, options: [.atomic])
        #endif
    }

    /// Mirror the display-sleep dim setting into settings.json under
    /// `displaySleepDim`. Writes all three sub-fields together (they share one
    /// JSON object) using the same clobber-resistant atomic merge as the other
    /// writers, then posts `.displaySettingsChanged` so the in-process daemon
    /// refreshes its cache and re-broadcasts live if the display is asleep.
    private func writeDisplaySleepDimToSettingsJson() {
        #if os(macOS)
        let url = AgentDeckPaths.settingsJson

        var root: [String: Any] = [:]
        if let data = try? Data(contentsOf: url),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            root = parsed
        }

        root["displaySleepDim"] = [
            "enabled": displaySleepDimEnabled,
            "mode": displaySleepDimMode == "min" ? "min" : "off",
            "level": max(1, min(100, displaySleepDimLevel)),
        ]

        guard let out = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? out.write(to: url, options: [.atomic])
        NotificationCenter.default.post(name: .displaySettingsChanged, object: nil)
        #endif
    }

    func clearAntigravityAccess() {
        defaults.removeObject(forKey: Keys.antigravityBookmark)
        defaults.removeObject(forKey: Keys.antigravitySelectedPath)
        antigravitySelectedPath = nil
        antigravityAccessEnabled = false
        if showAntigravitySection {
            showAntigravitySection = false
        }
    }

    #if os(macOS)
    private static func defaultAntigravityDirectoryURL() -> URL? {
        guard let pw = getpwuid(getuid()), let ptr = pw.pointee.pw_dir else { return nil }
        let home = URL(fileURLWithPath: String(cString: ptr))
        let candidates = [
            "Library/Application Support/Antigravity/User/globalStorage",
            "Library/Application Support/Antigravity",
            "Library/Application Support",
            "Library"
        ]
        let fm = FileManager.default
        for sub in candidates {
            let url = home.appendingPathComponent(sub, isDirectory: true)
            if fm.fileExists(atPath: url.path) { return url }
        }
        return nil
    }

    @discardableResult
    @MainActor
    func chooseAntigravityDatabase() -> Bool {
        let panel = NSOpenPanel()
        panel.title = "Select Antigravity state.vscdb"
        panel.message = "Choose Antigravity's local state database to enable optional plan display."
        // No `allowedContentTypes` filter: `.vscdb` has no registered UTType,
        // so any non-empty filter (the `db`/`sqlite` UTTypes do resolve) would
        // grey out `state.vscdb` and make it unselectable. Same reasoning as
        // `CodexConfigInstaller`'s `.toml` picker — leave the panel unfiltered
        // and rely on `directoryURL` + `nameFieldStringValue` as the hints.
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.nameFieldStringValue = "state.vscdb"
        panel.showsHiddenFiles = true
        if let defaultDir = Self.defaultAntigravityDirectoryURL() {
            panel.directoryURL = defaultDir
        }
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        return storeAntigravityBookmark(for: url)
    }
    #endif

    @discardableResult
    func storeAntigravityBookmark(for url: URL) -> Bool {
        do {
            #if os(macOS)
            let options: URL.BookmarkCreationOptions = [.withSecurityScope]
            #else
            let options: URL.BookmarkCreationOptions = []
            #endif
            let bookmark = try url.bookmarkData(
                options: options,
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            defaults.set(bookmark, forKey: Keys.antigravityBookmark)
            defaults.set(url.path, forKey: Keys.antigravitySelectedPath)
            antigravitySelectedPath = url.path
            antigravityAccessEnabled = true
            if !showAntigravitySection {
                showAntigravitySection = true
            }
            return true
        } catch {
            return false
        }
    }

    func withAntigravityDatabaseAccess<T>(_ body: (URL) throws -> T?) rethrows -> T? {
        guard let bookmark = defaults.data(forKey: Keys.antigravityBookmark) else { return nil }
        var stale = false
        let url: URL
        do {
            #if os(macOS)
            let resolveOptions: URL.BookmarkResolutionOptions = [.withSecurityScope]
            #else
            let resolveOptions: URL.BookmarkResolutionOptions = []
            #endif
            url = try URL(
                resolvingBookmarkData: bookmark,
                options: resolveOptions,
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            )
        } catch {
            return nil
        }

        if stale {
            _ = storeAntigravityBookmark(for: url)
        }

        guard url.startAccessingSecurityScopedResource() else { return nil }
        defer { url.stopAccessingSecurityScopedResource() }
        return try body(url)
    }

    // MARK: - Claude settings.local.json security-scoped bookmark

    /// Persist a security-scoped bookmark to `~/.claude/settings.local.json`.
    /// The user selects the file via NSOpenPanel in HookInstaller; this
    /// keeps the opaque bookmark + the display path. Mirrors the
    /// Antigravity pattern so behaviour is consistent across the two
    /// outside-sandbox file integrations.
    @discardableResult
    func storeClaudeSettingsBookmark(for url: URL) -> Bool {
        do {
            #if os(macOS)
            let options: URL.BookmarkCreationOptions = [.withSecurityScope]
            #else
            let options: URL.BookmarkCreationOptions = []
            #endif
            let bookmark = try url.bookmarkData(
                options: options,
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            defaults.set(bookmark, forKey: Keys.claudeSettingsBookmark)
            defaults.set(url.path, forKey: Keys.claudeSettingsPath)
            return true
        } catch {
            return false
        }
    }

    /// Resolve the stored bookmark back into a URL. Returns `nil` when the
    /// user has not granted access yet. `stale == true` signals the caller
    /// should re-persist the bookmark — HookInstaller does that after any
    /// successful read/write.
    func resolveClaudeSettingsURL() -> (url: URL, stale: Bool)? {
        guard let bookmark = defaults.data(forKey: Keys.claudeSettingsBookmark) else { return nil }
        var stale = false
        do {
            #if os(macOS)
            let resolveOptions: URL.BookmarkResolutionOptions = [.withSecurityScope]
            #else
            let resolveOptions: URL.BookmarkResolutionOptions = []
            #endif
            let url = try URL(
                resolvingBookmarkData: bookmark,
                options: resolveOptions,
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            )
            return (url, stale)
        } catch {
            return nil
        }
    }

    /// Revoke stored Claude settings bookmark + path. Leaves
    /// `hookInstallConsent` / `hooksInstalled` to the caller so
    /// `HookInstaller.uninstallAndRevoke()` can update them in the
    /// right order.
    func clearClaudeSettingsAccess() {
        defaults.removeObject(forKey: Keys.claudeSettingsBookmark)
        defaults.removeObject(forKey: Keys.claudeSettingsPath)
    }

    // MARK: - Codex config.toml security-scoped bookmark

    /// Persist a security-scoped bookmark to `~/.codex/config.toml`.
    /// Mirrors `storeClaudeSettingsBookmark` — only the storage keys differ.
    @discardableResult
    func storeCodexConfigBookmark(for url: URL) -> Bool {
        do {
            #if os(macOS)
            let options: URL.BookmarkCreationOptions = [.withSecurityScope]
            #else
            let options: URL.BookmarkCreationOptions = []
            #endif
            let bookmark = try url.bookmarkData(
                options: options,
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            defaults.set(bookmark, forKey: Keys.codexConfigBookmark)
            defaults.set(url.path, forKey: Keys.codexConfigPath)
            return true
        } catch {
            return false
        }
    }

    /// Resolve the stored Codex bookmark back into a URL.
    func resolveCodexConfigURL() -> (url: URL, stale: Bool)? {
        guard let bookmark = defaults.data(forKey: Keys.codexConfigBookmark) else { return nil }
        var stale = false
        do {
            #if os(macOS)
            let resolveOptions: URL.BookmarkResolutionOptions = [.withSecurityScope]
            #else
            let resolveOptions: URL.BookmarkResolutionOptions = []
            #endif
            let url = try URL(
                resolvingBookmarkData: bookmark,
                options: resolveOptions,
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            )
            return (url, stale)
        } catch {
            return nil
        }
    }

    /// Revoke stored Codex config bookmark + path. Leaves consent /
    /// installed flags to the caller (`CodexConfigInstaller.uninstallAndRevoke`).
    func clearCodexConfigAccess() {
        defaults.removeObject(forKey: Keys.codexConfigBookmark)
        defaults.removeObject(forKey: Keys.codexConfigPath)
    }

    // MARK: - OpenClaw openclaw.json security-scoped bookmark

    /// Persist a security-scoped bookmark to the OpenClaw config file the user
    /// picked during "Import token" (typically `~/.openclaw/openclaw.json`).
    /// Mirrors the Antigravity / Claude / Codex bookmark stores — only the
    /// storage keys differ. Keeping a bookmark lets the gateway adapter
    /// re-read a rotated `gateway.auth.token` automatically on reconnect
    /// (`OpenClawGatewayTokenStore.refreshFromConfigBookmark`) without the
    /// user re-running the import.
    @discardableResult
    func storeOpenClawConfigBookmark(for url: URL) -> Bool {
        do {
            #if os(macOS)
            let options: URL.BookmarkCreationOptions = [.withSecurityScope]
            #else
            let options: URL.BookmarkCreationOptions = []
            #endif
            let bookmark = try url.bookmarkData(
                options: options,
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            defaults.set(bookmark, forKey: Keys.openclawConfigBookmark)
            defaults.set(url.path, forKey: Keys.openclawConfigSelectedPath)
            return true
        } catch {
            return false
        }
    }

    /// Resolve the stored OpenClaw config bookmark, run `body` inside a
    /// security-scoped access window, and release it (even on throw). Returns
    /// `nil` when no bookmark is stored or it can't be resolved. Re-persists
    /// the bookmark when the OS reports it stale. Mirrors
    /// `withAntigravityDatabaseAccess`.
    func withOpenClawConfigAccess<T>(_ body: (URL) throws -> T?) rethrows -> T? {
        guard let bookmark = defaults.data(forKey: Keys.openclawConfigBookmark) else { return nil }
        var stale = false
        let url: URL
        do {
            #if os(macOS)
            let resolveOptions: URL.BookmarkResolutionOptions = [.withSecurityScope]
            #else
            let resolveOptions: URL.BookmarkResolutionOptions = []
            #endif
            url = try URL(
                resolvingBookmarkData: bookmark,
                options: resolveOptions,
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            )
        } catch {
            return nil
        }

        if stale {
            _ = storeOpenClawConfigBookmark(for: url)
        }

        guard url.startAccessingSecurityScopedResource() else { return nil }
        defer { url.stopAccessingSecurityScopedResource() }
        return try body(url)
    }

    /// Revoke the stored OpenClaw config bookmark + display path. The Keychain
    /// token itself is cleared separately by `OpenClawGatewayTokenStore`.
    func clearOpenClawConfigAccess() {
        defaults.removeObject(forKey: Keys.openclawConfigBookmark)
        defaults.removeObject(forKey: Keys.openclawConfigSelectedPath)
    }

    /// Clamp user-supplied port to the safe range (avoid privileged <1024 and
     /// out-of-range values that would crash NWEndpoint.Port).
    static func clampPort(_ value: Int) -> Int {
        min(65535, max(1024, value))
    }

    private enum Keys {
        static let daemonPort = "prefs.daemonPort"
        static let openDashboardOnLaunch = "prefs.openDashboardOnLaunch"
        static let d200hBakeSessionText = "prefs.d200hBakeSessionText"
        static let d200hHideNativeSessionLabels = "prefs.d200hHideNativeSessionLabels"
        static let menuBarIconStyle = "prefs.menuBarIconStyle"
        static let showSessionList = "prefs.showSessionList"
        static let showTankStatus = "prefs.showTankStatus"
        static let showDeviceDiagnostic = "prefs.showDeviceDiagnostic"
        static let showTimeline = "prefs.showTimeline"
        static let showSettingsButton = "prefs.showSettingsButton"
        static let showOpenClawSection = "prefs.showOpenClawSection"
        static let showMLXSection = "prefs.showMLXSection"
        static let showOllamaSection = "prefs.showOllamaSection"
        static let showAntigravitySection = "prefs.showAntigravitySection"
        static let showSubscriptionsSection = "prefs.showSubscriptionsSection"
        static let antigravityBookmark = "prefs.antigravityBookmark"
        static let antigravitySelectedPath = "prefs.antigravitySelectedPath"
        static let apmeJudgeBackend = "prefs.apmeJudgeBackend"
        static let timelineSummaryProvider = "prefs.timelineSummaryProvider"
        static let displaySleepDimEnabled = "prefs.displaySleepDimEnabled"
        static let displaySleepDimMode = "prefs.displaySleepDimMode"
        static let displaySleepDimLevel = "prefs.displaySleepDimLevel"
        static let hookInstallConsent = "prefs.hookInstallConsent"
        static let hooksInstalled = "prefs.hooksInstalled"
        static let claudeSettingsBookmark = "prefs.claudeSettingsBookmark"
        static let claudeSettingsPath = "prefs.claudeSettingsPath"
        static let codexConfigConsent = "prefs.codexConfigConsent"
        static let codexConfigInstalled = "prefs.codexConfigInstalled"
        static let codexConfigBookmark = "prefs.codexConfigBookmark"
        static let codexConfigPath = "prefs.codexConfigPath"
        static let openclawConfigBookmark = "prefs.openclawConfigBookmark"
        static let openclawConfigSelectedPath = "prefs.openclawConfigSelectedPath"
        static let hasSeenDevicePreview = "prefs.hasSeenDevicePreview"
        static let hasSeenMonitorEmptyGuide = "prefs.hasSeenMonitorEmptyGuide"
        static let hasRequestedNotifications = "prefs.hasRequestedNotifications"
        static let hasSeenOnboarding = "prefs.hasSeenOnboarding"
    }
}
