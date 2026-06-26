#if os(macOS)
// CodexConfigInstaller.swift — Install AgentDeck's Codex observation
// entries into ~/.codex/config.toml with explicit user consent.
//
// Mirrors HookInstaller.swift's NSAlert + NSOpenPanel + security-scoped
// bookmark flow. The channels we register:
//
//   1. `[features] hooks = true` + inline `[hooks]` tables
//      Official Codex lifecycle hooks send one JSON object on stdin. We
//      register UserPromptSubmit / PreToolUse / PostToolUse / Stop and POST
//      the exact stdin body to daemon `/hooks/codex_*` endpoints.
//
//   2. `notify = ["sh", "-c", "<snippet>", "agentdeck-notify"]`
//      Optional turn-complete fallback when the user does not already own a
//      top-level notify command.
//
//   3. `[otel.trace_exporter.otlp-http] endpoint = …/otel/v1/traces`,
//      `protocol = "json"`
//      Codex emits per-turn span telemetry over OTLP/HTTP. Forced to JSON
//      because the daemon intentionally rejects protobuf at this route.
//
// Edits live inside a fenced block (see MiniToml) so user keys / comments /
// profile tables / MCP server tables are preserved verbatim. If the user
// already wrote their own `[features]` or `[hooks]` table we abort cleanly
// rather than producing duplicate-table TOML.

import AppKit
import Foundation
import UniformTypeIdentifiers

enum CodexConfigInstaller {

    private static let codexConfigFilename = "config.toml"

    /// Build the OTel exporter endpoint. The daemon port is dynamic
    /// (9120 → fallback within 9120-9139 when occupied), so we prefer
    /// the actual `httpPort` recorded in `daemon.json` at install time;
    /// fall back to the user's preferred port only when the daemon
    /// hasn't written its info file yet. `installIfNeeded` is called on
    /// every daemon startup so this re-resolves whenever the daemon
    /// rebinds.
    private static func buildOtelEndpoint(daemonHttpPort: Int? = nil) -> String {
        let port = daemonHttpPort ?? currentDaemonHttpPort() ?? AppPreferences.shared.daemonPort
        return "http://127.0.0.1:\(port)/otel/v1/traces"
    }

    /// Read `daemon.json` (sandbox container path on App Store builds, or
    /// `~/.agentdeck/` on Node builds) and return whichever port the
    /// daemon is actually listening on. Prefers `httpPort` over `port`
    /// because the Swift daemon splits HTTP/WS across ports.
    private static func currentDaemonHttpPort() -> Int? {
        let url = AgentDeckPaths.baseDirectory.appendingPathComponent("daemon.json")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let p = obj["httpPort"] as? Int, p > 0 { return p }
        if let p = obj["port"] as? Int, p > 0 { return p }
        return nil
    }

    // MARK: - Public entry points

    @MainActor
    static func installIfNeeded(daemonHttpPort: Int? = nil) {
        switch AppPreferences.shared.codexConfigConsent {
        case .unknown:
            DaemonLogger.shared.info("Codex config awaiting user consent from Settings")
            return
        case .declined:
            return
        case .accepted:
            break
        }

        guard let resolved = AppPreferences.shared.resolveCodexConfigURL() else {
            DaemonLogger.shared.info("Codex config skipped: no user-authorized config.toml bookmark")
            AppPreferences.shared.codexConfigInstalled = false
            return
        }

        let url = resolved.url
        if resolved.stale {
            _ = AppPreferences.shared.storeCodexConfigBookmark(for: url)
        }

        guard url.startAccessingSecurityScopedResource() else {
            DaemonLogger.shared.info("Codex config skipped: security-scoped resource unavailable at \(url.path)")
            AppPreferences.shared.codexConfigInstalled = false
            return
        }
        defer { url.stopAccessingSecurityScopedResource() }

        let original = readText(at: url)

        // Refuse to clobber user-authored lifecycle hook config. This
        // line-mode editor cannot safely merge existing `[features]` or
        // `[hooks]` tables without a real TOML parser, and duplicate tables
        // would make Codex reject config.toml.
        if MiniToml.hasTableOutsideFence(in: original, table: "features") {
            DaemonLogger.shared.info("Codex config: user-authored `[features]` present — observation not installed")
            AppPreferences.shared.codexConfigInstalled = false
            return
        }
        if MiniToml.hasTableOutsideFence(in: original, table: "hooks") {
            DaemonLogger.shared.info("Codex config: user-authored `[hooks]` present — observation not installed")
            AppPreferences.shared.codexConfigInstalled = false
            return
        }

        let includeNotify = !MiniToml.hasTopLevelKeyOutsideFence(in: original, key: "notify")
        let includeOtel = !MiniToml.hasTableOutsideFence(in: original, table: "otel")
        if !includeNotify {
            DaemonLogger.shared.info("Codex config: user-authored `notify` present — installing lifecycle hooks without notify fallback")
        }
        if !includeOtel {
            DaemonLogger.shared.info("Codex config: user-authored `[otel]` present — installing lifecycle hooks without OTel exporter")
        }

        let otelEndpoint = includeOtel ? buildOtelEndpoint(daemonHttpPort: daemonHttpPort) : nil
        let body = managedBlockBody(
            includeNotify: includeNotify,
            includeOtel: includeOtel,
            otelEndpoint: otelEndpoint
        )
        let updated = MiniToml.applyManagedBlock(in: original, body: body)
        if updated == original {
            AppPreferences.shared.codexConfigInstalled = true
            return
        }

        if writeText(updated, to: url) {
            AppPreferences.shared.codexConfigInstalled = true
            DaemonLogger.shared.info("Codex observation installed → \(url.path)")
        } else {
            AppPreferences.shared.codexConfigInstalled = false
            DaemonLogger.shared.info("Codex config write failed at \(url.path)")
        }
    }

    @MainActor
    static func uninstall() {
        guard let resolved = AppPreferences.shared.resolveCodexConfigURL() else {
            DaemonLogger.shared.info("Codex config uninstall skipped: no authorized config.toml bookmark")
            return
        }

        let url = resolved.url
        if resolved.stale {
            _ = AppPreferences.shared.storeCodexConfigBookmark(for: url)
        }

        guard url.startAccessingSecurityScopedResource() else {
            DaemonLogger.shared.info("Codex config uninstall skipped: security-scoped resource unavailable at \(url.path)")
            return
        }
        defer { url.stopAccessingSecurityScopedResource() }

        let original = readText(at: url)
        let stripped = MiniToml.removeManagedBlock(in: original)
        if stripped != original {
            _ = writeText(stripped, to: url)
        }
        AppPreferences.shared.codexConfigInstalled = false
        DaemonLogger.shared.info("Codex observation removed")
    }

    @MainActor
    static func uninstallAndRevoke() {
        uninstall()
        AppPreferences.shared.clearCodexConfigAccess()
        AppPreferences.shared.codexConfigConsent = .declined
        AppPreferences.shared.codexConfigInstalled = false
    }

    @discardableResult
    @MainActor
    static func promptAndInstall() -> Bool {
        if AppPreferences.shared.codexConfigConsent == .accepted,
           AppPreferences.shared.resolveCodexConfigURL() != nil {
            installIfNeeded()
            return AppPreferences.shared.codexConfigInstalled
        }

        let alert = NSAlert()
        alert.messageText = "Enable Codex Observation?"
        alert.informativeText = """
            AgentDeck can register Codex lifecycle hooks in ~/.codex/config.toml so Codex turns and tool calls report state to the dashboard.

            You'll be asked to grant access to that file. AgentDeck only edits its own fenced block — your model, profiles, MCP server keys, and existing user-owned integrations are preserved.

            Skip this if you don't use Codex.
            """
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Not Now")
        alert.alertStyle = .informational

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            AppPreferences.shared.codexConfigConsent = .declined
            DaemonLogger.shared.info("Codex config consent declined by user")
            return false
        }

        let home = String(cString: getpwuid(getuid()).pointee.pw_dir)
        let codexDir = URL(fileURLWithPath: home).appendingPathComponent(".codex", isDirectory: true)

        let panel = NSOpenPanel()
        panel.title = "Authorize Codex Config"
        panel.message = "Select (or create) ~/.codex/config.toml so AgentDeck can install observation entries."
        panel.prompt = "Authorize"
        panel.directoryURL = codexDir
        panel.nameFieldStringValue = codexConfigFilename
        // Intentionally no `allowedContentTypes`: `.toml` has no canonical
        // UTI on macOS, so previously setting `[.plainText, .data]` made
        // `~/.codex/config.toml` appear greyed-out (its dynamic UTI didn't
        // conform to either). Apple's guidance for non-well-known formats
        // is to leave the filter open and rely on `directoryURL` +
        // `nameFieldStringValue` to land users on the right file.
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.treatsFilePackagesAsDirectories = false

        guard panel.runModal() == .OK, let url = panel.url else {
            AppPreferences.shared.codexConfigConsent = .declined
            DaemonLogger.shared.info("Codex config consent declined — file picker cancelled")
            return false
        }

        guard AppPreferences.shared.storeCodexConfigBookmark(for: url) else {
            DaemonLogger.shared.info("Codex config consent: failed to persist security-scoped bookmark for \(url.path)")
            return false
        }

        AppPreferences.shared.codexConfigConsent = .accepted
        installIfNeeded()
        return AppPreferences.shared.codexConfigInstalled
    }

    // MARK: - Body assembly

    /// Assemble the body of the AgentDeck-managed fence. Tests call this
    /// through `@testable` so schema regressions are caught without driving
    /// NSAlert / NSOpenPanel.
    static func managedBlockBody(
        includeNotify: Bool = true,
        includeOtel: Bool = true,
        otelEndpoint: String? = nil
    ) -> String {
        var lines: [String] = [
            "# Codex lifecycle hooks. Command hooks receive JSON on stdin;",
            "# each snippet forwards that stdin body unchanged to AgentDeck.",
            "[features]",
            "hooks = true",
        ]

        lines.append("")
        lines.append(contentsOf: buildLifecycleHookTables())

        if includeNotify {
            lines.append("")
            lines.append("# Optional turn-complete notification fallback.")
            lines.append("# Codex appends the JSON payload as the last argv entry,")
            lines.append("# so the 4th array element acts as $0 and payload lands at $1.")
            lines.append(buildNotifyAssignment(event: "codex_turn_complete"))
        }

        if includeOtel {
            lines.append("")
            lines.append("# OTel trace exporter — best-effort live progress signal.")
            lines.append("# Schema: [otel.trace_exporter.otlp-http].")
            lines.append("[otel.trace_exporter.otlp-http]")
            lines.append("endpoint = \(MiniToml.quoted(otelEndpoint ?? buildOtelEndpoint()))")
            lines.append("protocol = \"json\"")
        }
        return lines.joined(separator: "\n")
    }

    /// Build the `notify = ["sh", "-c", "<snippet>", "agentdeck-notify"]`
    /// line. Two design choices stacked here:
    ///   1. `"sh"` uses PATH lookup so no absolute shell path lands in the
    ///      shipped Mach-O.
    ///   2. The trailing `"agentdeck-notify"` is a dummy `$0`. Codex
    ///      invokes `notify` by appending the JSON payload as the last
    ///      argv entry. Without our 4th element, `sh -c "<snippet>"
    ///      <json>` would assign `<json>` to `$0` and leave `$1`
    ///      empty — every notify POST would carry no body. With the
    ///      dummy in place, `<json>` lands at `$1` as the snippet
    ///      expects.
    private static func buildNotifyAssignment(event: String) -> String {
        let snippet = buildNotifySnippet(event: event)
        return "notify = [\"sh\", \"-c\", \(MiniToml.quoted(snippet)), \"agentdeck-notify\"]"
    }

    /// Codex notify snippet. PORT-resolution lines are byte-identical with
    /// HookInstaller.swift `buildHookCommand` so the two integrations
    /// share one canonical port-discovery contract. Only the trailing
    /// curl line differs: Claude hooks pipe stdin (`-d @-`), Codex notify
    /// hands the JSON payload as `$1`.
    private static func buildNotifySnippet(event: String) -> String {
        let lines = [
            #"PORT="${AGENTDECK_PORT:-}""#,
            #"if [ -z "$PORT" ]; then"#,
            #"  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do"#,
            #"    [ -f "$F" ] || continue"#,
            #"    P=$(python3 -c "import json;d=json.load(open('$F'));print(d.get('httpPort') or d.get('port',''))" 2>/dev/null)"#,
            #"    [ -n "$P" ] && curl -sf --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }"#,
            #"  done"#,
            #"fi"#,
            #"PORT="${PORT:-9120}""#,
            "curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST \"http://127.0.0.1:$PORT/hooks/\(event)\" -H 'Content-Type: application/json' --data-raw \"$1\" 2>/dev/null || true",
        ]
        return lines.joined(separator: "\n")
    }

    private static func buildLifecycleHookTables() -> [String] {
        let hooks: [(codexEvent: String, agentDeckEvent: String, matcher: String?)] = [
            ("SessionStart", "codex_session_start", "startup|resume|clear"),
            ("UserPromptSubmit", "codex_user_prompt_submit", nil),
            ("PreToolUse", "codex_tool_start", "*"),
            ("PostToolUse", "codex_tool_end", "*"),
            ("Stop", "codex_stop", nil),
        ]

        var lines: [String] = []
        for (idx, hook) in hooks.enumerated() {
            if idx > 0 { lines.append("") }
            lines.append("[[hooks.\(hook.codexEvent)]]")
            if let matcher = hook.matcher {
                lines.append("matcher = \(MiniToml.quoted(matcher))")
            }
            lines.append("[[hooks.\(hook.codexEvent).hooks]]")
            lines.append("type = \"command\"")
            lines.append("command = \(MiniToml.quoted(buildLifecycleHookCommand(event: hook.agentDeckEvent)))")
            lines.append("timeout = 5")
        }
        return lines
    }

    /// Official Codex lifecycle hooks pass their JSON payload on stdin.
    /// Keep stdout quiet so Stop/UserPromptSubmit hooks do not accidentally
    /// feed AgentDeck's acknowledgement back into Codex as hook output.
    private static func buildLifecycleHookCommand(event: String) -> String {
        return "sh -c \(shellSingleQuoted(buildStdinPostSnippet(event: event)))"
    }

    private static func buildStdinPostSnippet(event: String) -> String {
        let lines = [
            #"PORT="${AGENTDECK_PORT:-}""#,
            #"if [ -z "$PORT" ]; then"#,
            #"  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do"#,
            #"    [ -f "$F" ] || continue"#,
            #"    P=$(python3 -c "import json;d=json.load(open('$F'));print(d.get('httpPort') or d.get('port',''))" 2>/dev/null)"#,
            #"    [ -n "$P" ] && curl -sf --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }"#,
            #"  done"#,
            #"fi"#,
            #"PORT="${PORT:-9120}""#,
            "curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST \"http://127.0.0.1:$PORT/hooks/\(event)\" -H 'Content-Type: application/json' -d @- >/dev/null 2>&1 || true",
        ]
        return lines.joined(separator: "\n")
    }

    private static func shellSingleQuoted(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    // MARK: - File I/O

    private static func readText(at url: URL) -> String {
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else {
            return ""
        }
        return text
    }

    @discardableResult
    private static func writeText(_ text: String, to url: URL) -> Bool {
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard let data = text.data(using: .utf8) else { return false }
        do {
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }
}
#endif
