#if os(macOS)
// HookInstaller.swift — Install Claude Code hooks with explicit user consent.
// Ported from hooks/src/install.ts but redesigned for App Store compliance:
// - No longer writes on launch without consent (guideline 2.5.2).
// - Reads/writes via a user-granted security-scoped URL bookmark persisted
//   in AppPreferences (resolveClaudeSettingsURL / storeClaudeSettingsBookmark).
// - `installIfNeeded()` silently no-ops when consent is `.unknown` or
//   `.declined`, or when no bookmark exists. `promptAndInstall()` walks the
//   user through the explicit NSAlert + NSOpenPanel flow.

import AppKit
import Foundation
import UniformTypeIdentifiers

enum HookInstaller {
    private static let hookEvents = [
        "SessionStart", "SessionEnd", "PreToolUse",
        "PostToolUse", "Stop", "Notification", "UserPromptSubmit",
    ]

    /// Canonical install target: Claude Code 2.1+ only reads hooks from files
    /// it actively watches. Empirically (via debug log "Watching for changes in
    /// setting files …"), those are `~/.claude/settings.json` (user-global),
    /// `<project>/.claude/settings.json`, and `<project>/.claude/settings.local.json`.
    /// `~/.claude/settings.local.json` — the file older AgentDeck builds targeted —
    /// is NOT watched, so hooks written there never fire. We now default to the
    /// user-global `settings.json` because AgentDeck wants telemetry across every
    /// Claude Code session, regardless of project.
    private static let claudeSettingsFilename = "settings.json"

    /// Install AgentDeck hooks into Claude Code settings only if the user has
    /// explicitly granted consent + a valid security-scoped bookmark. Safe to
    /// call on every launch — when preconditions aren't met it's a no-op.
    static func installIfNeeded() {
        switch AppPreferences.shared.hookInstallConsent {
        case .unknown:
            DaemonLogger.shared.info("Hooks awaiting user consent from Settings")
            return
        case .declined:
            return
        case .accepted:
            break
        }

        guard let resolved = AppPreferences.shared.resolveClaudeSettingsURL() else {
            DaemonLogger.shared.info("Hooks skipped: no user-authorized settings.json bookmark")
            AppPreferences.shared.hooksInstalled = false
            return
        }

        let url = resolved.url
        if resolved.stale {
            _ = AppPreferences.shared.storeClaudeSettingsBookmark(for: url)
        }

        // Migrate installs authorized against the legacy unwatched
        // `~/.claude/settings.local.json`: clean out our hook entries there so
        // they don't linger as orphans, then invalidate the bookmark and flip
        // consent back to `.unknown` so the Setup card re-prompts the user to
        // pick the watched `settings.json` on next interaction.
        if isLegacyUserLocalPath(url) {
            DaemonLogger.shared.info("Hooks: legacy bookmark points to unwatched ~/.claude/settings.local.json — migrating")
            if url.startAccessingSecurityScopedResource() {
                var settings = loadSettings(at: url)
                settings = removeHooks(settings)
                _ = saveSettings(settings, to: url)
                url.stopAccessingSecurityScopedResource()
            }
            AppPreferences.shared.clearClaudeSettingsAccess()
            AppPreferences.shared.hookInstallConsent = .unknown
            AppPreferences.shared.hooksInstalled = false
            return
        }

        guard url.startAccessingSecurityScopedResource() else {
            DaemonLogger.shared.info("Hooks skipped: security-scoped resource unavailable at \(url.path)")
            AppPreferences.shared.hooksInstalled = false
            return
        }
        defer { url.stopAccessingSecurityScopedResource() }

        var settings = loadSettings(at: url)
        let before = settingsJSON(settings)

        settings = applyHooks(settings)

        let after = settingsJSON(settings)
        guard before != after else {
            DaemonLogger.shared.debug("Hooks", "Already installed, no changes needed")
            AppPreferences.shared.hooksInstalled = true
            return
        }

        let wrote = saveSettings(settings, to: url)
        if wrote {
            AppPreferences.shared.hooksInstalled = true
            DaemonLogger.shared.info("Claude Code hooks installed → \(url.path)")
        } else {
            AppPreferences.shared.hooksInstalled = false
            DaemonLogger.shared.info("Hooks write failed at \(url.path)")
        }
    }

    /// Remove AgentDeck hooks from Claude Code settings. Requires an existing
    /// bookmark (we need to write back). Leaves consent state untouched;
    /// `uninstallAndRevoke()` is the full teardown.
    static func uninstall() {
        guard let resolved = AppPreferences.shared.resolveClaudeSettingsURL() else {
            DaemonLogger.shared.info("Hooks uninstall skipped: no authorized settings.json bookmark")
            return
        }

        let url = resolved.url
        if resolved.stale {
            _ = AppPreferences.shared.storeClaudeSettingsBookmark(for: url)
        }

        guard url.startAccessingSecurityScopedResource() else {
            DaemonLogger.shared.info("Hooks uninstall skipped: security-scoped resource unavailable at \(url.path)")
            return
        }
        defer { url.stopAccessingSecurityScopedResource() }

        var settings = loadSettings(at: url)
        settings = removeHooks(settings)
        _ = saveSettings(settings, to: url)
        AppPreferences.shared.hooksInstalled = false
        DaemonLogger.shared.info("Claude Code hooks removed")
    }

    /// Full teardown — remove hooks from the JSON, drop the bookmark, flip
    /// consent to `.declined` so subsequent launches stay quiet.
    static func uninstallAndRevoke() {
        uninstall()
        AppPreferences.shared.clearClaudeSettingsAccess()
        AppPreferences.shared.hookInstallConsent = .declined
        AppPreferences.shared.hooksInstalled = false
    }

    /// Explicit opt-in flow. Shows an NSAlert explaining the integration,
    /// then an NSOpenPanel defaulted to `~/.claude/settings.json` — the
    /// user-global settings file Claude Code 2.1+ actually watches.
    /// Returns `true` when the user confirmed and hooks were written (or
    /// were already installed with a valid bookmark).
    @discardableResult
    @MainActor
    static func promptAndInstall() -> Bool {
        // If we've already been authorized, just (re)install.
        if AppPreferences.shared.hookInstallConsent == .accepted,
           AppPreferences.shared.resolveClaudeSettingsURL() != nil {
            installIfNeeded()
            return true
        }

        let alert = NSAlert()
        alert.messageText = "Enable Claude Code Hooks?"
        alert.informativeText = """
            AgentDeck can register hooks in ~/.claude/settings.json so Claude Code sessions report state to the dashboard.

            You'll be asked to grant access to that file. AgentDeck only edits its own hook entries — other settings are preserved.
            """
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Not Now")
        alert.alertStyle = .informational

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            AppPreferences.shared.hookInstallConsent = .declined
            DaemonLogger.shared.info("Hooks consent declined by user")
            return false
        }

        // Default directoryURL to real $HOME/.claude via getpwuid so the
        // sandbox doesn't redirect us into the container home.
        let home = String(cString: getpwuid(getuid()).pointee.pw_dir)
        let claudeDir = URL(fileURLWithPath: home).appendingPathComponent(".claude", isDirectory: true)

        let panel = NSOpenPanel()
        panel.title = "Authorize Claude Code Settings"
        panel.message = "Select (or create) ~/.claude/settings.json so AgentDeck can install hooks."
        panel.prompt = "Authorize"
        panel.directoryURL = claudeDir
        panel.nameFieldStringValue = claudeSettingsFilename
        panel.allowedContentTypes = [.json]
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.treatsFilePackagesAsDirectories = false

        guard panel.runModal() == .OK, let url = panel.url else {
            AppPreferences.shared.hookInstallConsent = .declined
            DaemonLogger.shared.info("Hooks consent declined — file picker cancelled")
            return false
        }

        guard AppPreferences.shared.storeClaudeSettingsBookmark(for: url) else {
            DaemonLogger.shared.info("Hooks consent: failed to persist security-scoped bookmark for \(url.path)")
            return false
        }

        AppPreferences.shared.hookInstallConsent = .accepted
        installIfNeeded()
        return AppPreferences.shared.hooksInstalled
    }

    // MARK: - Migration helpers

    /// Detect bookmarks authorized against the pre-migration target
    /// `~/.claude/settings.local.json` — Claude Code 2.1+ does not watch that
    /// file for hook registration, so hooks written there never fire.
    /// Project-local `<project>/.claude/settings.local.json` is a different
    /// file (watched) and is intentionally NOT matched here.
    private static func isLegacyUserLocalPath(_ url: URL) -> Bool {
        let home = String(cString: getpwuid(getuid()).pointee.pw_dir)
        let legacy = URL(fileURLWithPath: home)
            .appendingPathComponent(".claude/settings.local.json")
            .standardizedFileURL
        return url.standardizedFileURL.path == legacy.path
    }

    // MARK: - Pure Logic

    private static func applyHooks(_ settings: [String: Any]) -> [String: Any] {
        var s = settings
        var hooks = s["hooks"] as? [String: Any] ?? [:]

        for event in hookEvents {
            var eventHooks = hooks[event] as? [[String: Any]] ?? []

            // Remove existing AgentDeck hooks (both old flat and new matcher format)
            eventHooks.removeAll { h in
                if let cmd = h["command"] as? String,
                   (cmd.contains("AGENTDECK_PORT") || cmd.contains("localhost:9120")) {
                    return true
                }
                if let inner = h["hooks"] as? [[String: Any]] {
                    return inner.contains { hh in
                        let cmd = hh["command"] as? String ?? ""
                        return cmd.contains("AGENTDECK_PORT") || cmd.contains("localhost:9120")
                    }
                }
                return false
            }

            // Add new hook (v2.1 matcher-group format)
            eventHooks.append(buildHookEntry(event))
            hooks[event] = eventHooks
        }

        s["hooks"] = hooks
        return s
    }

    private static func removeHooks(_ settings: [String: Any]) -> [String: Any] {
        var s = settings
        guard var hooks = s["hooks"] as? [String: Any] else { return s }

        for event in hookEvents {
            guard var eventHooks = hooks[event] as? [[String: Any]] else { continue }
            eventHooks.removeAll { h in
                if let cmd = h["command"] as? String,
                   (cmd.contains("AGENTDECK_PORT") || cmd.contains("localhost:9120")) {
                    return true
                }
                if let inner = h["hooks"] as? [[String: Any]] {
                    return inner.contains { hh in
                        let cmd = hh["command"] as? String ?? ""
                        return cmd.contains("AGENTDECK_PORT") || cmd.contains("localhost:9120")
                    }
                }
                return false
            }
            if eventHooks.isEmpty { hooks.removeValue(forKey: event) }
            else { hooks[event] = eventHooks }
        }

        if (hooks as NSDictionary).count == 0 { s.removeValue(forKey: "hooks") }
        else { s["hooks"] = hooks }
        return s
    }

    /// Canonical hook shell snippet. Byte-identical with `@agentdeck/hooks`
    /// `buildHookCommand` and `@agentdeck/setup`'s inlined copy — any change
    /// must be mirrored in both. Resolves the daemon's HTTP port at hook
    /// runtime by probing `$AGENTDECK_PORT` → `~/.agentdeck/daemon.json` →
    /// App Store sandbox container `daemon.json` → legacy App Group container
    /// `daemon.json`, verifies each candidate with a `/health` probe, and
    /// falls back to `9120`. Prefers `httpPort` over `port` because the Swift
    /// daemon splits WS and HTTP across ports.
    private static func buildHookCommand(_ event: String) -> String {
        let preamble = [
            #"PORT="${AGENTDECK_PORT:-}""#,
            #"if [ -z "$PORT" ]; then"#,
            #"  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agentdeck.dashboard/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agentdeck.dashboard/daemon.json"; do"#,
            #"    [ -f "$F" ] || continue"#,
            #"    P=$(python3 -c "import json;d=json.load(open('$F'));print(d.get('httpPort') or d.get('port',''))" 2>/dev/null)"#,
            #"    [ -n "$P" ] && curl -sf --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }"#,
            #"  done"#,
            #"fi"#,
            #"PORT="${PORT:-9120}""#,
        ]
        // PreToolUse long-poll (device approval) — capture the daemon's permission
        // decision and echo it to stdout. Empty output = Claude's normal flow.
        // See canonical commentary in hooks/src/install.ts.
        if event == "PreToolUse" {
            let lines = preamble + [
                #"RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/PreToolUse" -H 'Content-Type: application/json' --max-time 60 -d @- 2>/dev/null)"#,
                #"printf '%s' "${RESP:-}""#,
            ]
            return lines.joined(separator: "\n")
        }
        let lines = preamble + [
            "curl -sf -X POST \"http://127.0.0.1:$PORT/hooks/\(event)\" -H 'Content-Type: application/json' -d @- 2>/dev/null || true",
        ]
        return lines.joined(separator: "\n")
    }

    private static func buildHookEntry(_ event: String) -> [String: Any] {
        // Tool-specific hooks need glob matcher "*" to fire. Empty "" means
        // "match nothing" for PreToolUse/PostToolUse. Non-tool events ignore matcher.
        let needsToolMatcher = ["PreToolUse", "PostToolUse"].contains(event)
        return [
            "matcher": needsToolMatcher ? "*" : "",
            "hooks": [[
                "type": "command",
                "command": buildHookCommand(event),
            ] as [String: Any]] as [[String: Any]],
        ]
    }

    // MARK: - File I/O

    private static func loadSettings(at url: URL) -> [String: Any] {
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return json
    }

    @discardableResult
    private static func saveSettings(_ settings: [String: Any], to url: URL) -> Bool {
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard let data = try? JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys]) else {
            return false
        }
        do {
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    private static func settingsJSON(_ settings: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: settings, options: .sortedKeys) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
}
#endif
