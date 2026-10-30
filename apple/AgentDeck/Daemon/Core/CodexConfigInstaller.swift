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
//      the exact stdin body to daemon `/hooks/codex_*` endpoints. Opt-in:
//      a second PermissionRequest handler that holds the request for a
//      device's Allow/Deny (`ApprovalsPolicy`, CodexApprovalHoldRules).
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
// profile tables / MCP server tables are preserved verbatim. Official user
// lifecycle arrays and an explicit user-owned hooks = true can coexist
// with ours; conflicting feature settings or non-array hook tables stop
// with an actionable message.

import AppKit
import Foundation
import UniformTypeIdentifiers

enum CodexConfigInstaller {

    private static let codexConfigFilename = "config.toml"

    /// Whether AgentDeck's `PermissionRequest` group also carries the
    /// device-approval hold — a second handler that waits for a device's
    /// Allow/Deny before Codex draws its own prompt. Off unless the user turns
    /// it on, because both costs land on the person at the terminal: Codex
    /// shows its startup "Review hooks" screen for any new handler, and while
    /// a hold waits the terminal prompt does not appear. `auto` keeps whatever
    /// the managed block already carries, so the install pass that runs at
    /// every daemon start never adds or drops it. The config file is the only
    /// record of the choice. Mirror of `CodexApprovalsPolicy` in
    /// hooks/src/codex-install.ts.
    enum ApprovalsPolicy {
        case auto, on, off
    }

    /// Marks the hold request (`CodexApprovalHoldRules.header`, which a server
    /// reads lower-cased). Same endpoint as the notification on purpose: a
    /// daemon or installer that predates the hold falls back to the default.
    static let approvalHoldHeader = "X-AgentDeck-Hold"
    /// curl's budget for the held POST; the daemon holds for less.
    private static let approvalHoldWaitSeconds = 55
    /// Codex kills a hook after `timeout` seconds; it must exceed curl's budget.
    private static let approvalHoldTimeoutSeconds = 60

    enum InstallError: LocalizedError {
        case access, features, hooks, unreadable, write, changed, wrongFile
        case unsupported(String)

        var errorDescription: String? {
            switch self {
            case .unsupported(let reason): return "Config kept unchanged: \(reason)."
            case .access: return "File access is unavailable. Choose config.toml again to renew access."
            case .features: return "Existing [features] settings do not explicitly enable hooks. Add hooks = true in that section, then retry. Your settings have not been changed."
            case .hooks: return "An existing [hooks] table conflicts with observation. AgentDeck has kept it unchanged. Use Codex lifecycle hook arrays before retrying."
            case .unreadable: return "Could not read config.toml as UTF-8. Choose the file again and check its access permissions. No settings were written."
            case .write: return "Could not save config.toml. Check that the file is writable, then choose it again and retry."
            case .changed: return "config.toml changed during setup. Retry to use the latest settings."
            case .wrongFile: return "Choose the Codex file named config.toml. No settings were written."
            }
        }
    }

    @MainActor
    private static func reportFailure(_ error: Error) {
        AppPreferences.shared.codexConfigInstalled = false
        AppPreferences.shared.codexConfigError = error.localizedDescription
        DaemonLogger.shared.info("Codex observation setup: \(error.localizedDescription)")
    }

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
        if let p = obj["httpPort"] as? Int, (1...65535).contains(p) { return p }
        if let p = obj["port"] as? Int, (1...65535).contains(p) { return p }
        return nil
    }

    // MARK: - Public entry points

    @MainActor
    static func installIfNeeded(daemonHttpPort: Int? = nil, approvals: ApprovalsPolicy = .auto) {
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
            reportFailure(InstallError.access)
            return
        }

        let url = resolved.url
        if resolved.stale {
            _ = AppPreferences.shared.storeCodexConfigBookmark(for: url)
        }

        guard url.startAccessingSecurityScopedResource() else {
            DaemonLogger.shared.info("Codex config skipped: security-scoped resource unavailable at \(url.path)")
            reportFailure(InstallError.access)
            return
        }
        defer { url.stopAccessingSecurityScopedResource() }

        do {
            var withApprovals = false
            try updateConfig(at: url) {
                let updated = try preparedConfig($0, daemonHttpPort: daemonHttpPort, approvals: approvals)
                withApprovals = hasApprovalHold(updated)
                return updated
            }
            AppPreferences.shared.codexConfigInstalled = true
            AppPreferences.shared.codexApprovalsInstalled = withApprovals
            AppPreferences.shared.codexConfigError = nil
            DaemonLogger.shared.info("Codex observation installed\(withApprovals ? " with device approvals" : "")")
        } catch {
            reportFailure(error)
        }
    }

    /// Settings toggle: add or remove the hold handler under the consent the
    /// user already gave.
    @MainActor
    static func setApprovals(_ enabled: Bool) {
        installIfNeeded(approvals: enabled ? .on : .off)
    }

    /// Refuse conflicting user-owned settings instead of silently aborting.
    static func preparedConfig(
        _ original: String, daemonHttpPort: Int? = nil, approvals: ApprovalsPolicy = .auto
    ) throws -> String {
        if let issue = MiniToml.configEditIssue(original) { throw InstallError.unsupported(issue) }
        let outside = MiniToml.removeManagedBlock(in: original)
        let hasFeatures = MiniToml.hasTableOutsideFence(in: outside, table: "features")

        if hasFeatures && !existingFeaturesEnableHooks(original) { throw InstallError.features }
        if MiniToml.hasIncompatibleHookTableOutsideFence(in: outside) { throw InstallError.hooks }
        let includeNotify = !MiniToml.hasTopLevelKeyOutsideFence(in: outside, key: "notify")
        let includeOtel = !MiniToml.hasTableOutsideFence(in: outside, table: "otel")
        let includeApprovalHold = approvals == .on || (approvals == .auto && hasApprovalHold(original))
        let body = managedBlockBody(
            includeNotify: includeNotify, includeOtel: includeOtel,
            otelEndpoint: includeOtel ? buildOtelEndpoint(daemonHttpPort: daemonHttpPort) : nil,
            includeFeatures: !hasFeatures,
            includeApprovalHold: includeApprovalHold
        )
        return MiniToml.applyManagedBlock(in: original, body: body)
    }

    /// Whether the managed block already carries the hold handler.
    static func hasApprovalHold(_ text: String) -> Bool {
        guard let open = text.range(of: MiniToml.openFence),
              let close = text.range(of: MiniToml.closeFence, range: open.upperBound..<text.endIndex) else {
            return false
        }
        return text[open.upperBound..<close.lowerBound]
            .split(whereSeparator: \.isNewline)
            .contains { line in
                let key = line.drop(while: { $0 == " " || $0 == "\t" })
                guard key.hasPrefix("command") else { return false }
                return key.dropFirst("command".count).drop(while: { $0 == " " || $0 == "\t" }).hasPrefix("=")
                    && line.contains(approvalHoldHeader)
            }
    }

    /// Accept only an unambiguous existing opt-in. Never change a user-owned
    /// false value or rewrite the table with a lossy TOML serializer.
    static func existingFeaturesEnableHooks(_ text: String) -> Bool {
        MiniToml.existingFeaturesEnableHooks(text)
    }

    @MainActor
    static func uninstall() {
        guard let resolved = AppPreferences.shared.resolveCodexConfigURL() else {
            AppPreferences.shared.codexConfigError = InstallError.access.localizedDescription
            return
        }

        let url = resolved.url
        if resolved.stale {
            _ = AppPreferences.shared.storeCodexConfigBookmark(for: url)
        }

        guard url.startAccessingSecurityScopedResource() else {
            AppPreferences.shared.codexConfigError = InstallError.access.localizedDescription
            return
        }
        defer { url.stopAccessingSecurityScopedResource() }

        do {
            try updateConfig(at: url) {
                if let issue = MiniToml.configEditIssue($0) { throw InstallError.unsupported(issue) }
                return MiniToml.removeManagedBlock(in: $0)
            }
            AppPreferences.shared.codexConfigInstalled = false
            AppPreferences.shared.codexApprovalsInstalled = false
            AppPreferences.shared.codexConfigError = nil
            DaemonLogger.shared.info("Codex observation removed")
        } catch {
            // Retain the bookmark and installed flag so removal can be retried.
            AppPreferences.shared.codexConfigError = error.localizedDescription
        }
    }

    @MainActor
    static func uninstallAndRevoke() {
        AppPreferences.shared.codexConfigError = nil
        uninstall()
        guard AppPreferences.shared.codexConfigError == nil else { return }
        AppPreferences.shared.clearCodexConfigAccess()
        AppPreferences.shared.codexConfigConsent = .declined
        AppPreferences.shared.codexConfigInstalled = false
    }

    @discardableResult
    @MainActor
    static func promptAndInstall(chooseFile: Bool = false) -> Bool {
        if !chooseFile, AppPreferences.shared.codexConfigConsent == .accepted,
           AppPreferences.shared.resolveCodexConfigURL() != nil {
            installIfNeeded()
            return AppPreferences.shared.codexConfigInstalled
        }

        if AppPreferences.shared.codexConfigConsent != .accepted {
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
                DaemonLogger.shared.info("Codex config consent declined by user")
                return false
            }
        }

        let home = String(cString: getpwuid(getuid()).pointee.pw_dir)
        let codexDir = URL(fileURLWithPath: home).appendingPathComponent(".codex", isDirectory: true)

        let panel = NSOpenPanel()
        panel.title = "Authorize Codex Config"
        panel.message = "Select ~/.codex/config.toml so AgentDeck can install observation entries."
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
            DaemonLogger.shared.info("Codex config consent declined — file picker cancelled")
            return false
        }

        guard url.lastPathComponent == codexConfigFilename else {
            reportFailure(InstallError.wrongFile)
            return false
        }
        guard AppPreferences.shared.storeCodexConfigBookmark(for: url) else {
            reportFailure(InstallError.access)
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
        otelEndpoint: String? = nil,
        includeFeatures: Bool = true,
        includeApprovalHold: Bool = false
    ) -> String {
        var lines: [String] = [
            "# Codex lifecycle hooks. Command hooks receive JSON on stdin;",
            "# each snippet forwards that stdin body unchanged to AgentDeck.",
        ]

        if includeNotify {
            lines.append("")
            lines.append("# Optional turn-complete notification fallback.")
            lines.append("# Codex appends the JSON payload as the last argv entry,")
            lines.append("# so the 4th array element acts as $0 and payload lands at $1.")
            lines.append(buildNotifyAssignment(event: "codex_turn_complete"))
        }

        if includeFeatures { lines.append(contentsOf: ["[features]", "hooks = true"]) }
        lines.append("")
        lines.append(contentsOf: buildLifecycleHookTables(includeApprovalHold: includeApprovalHold))

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
        (posixPortPreamble + [
            "curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST \"http://127.0.0.1:$PORT/hooks/\(event)\" -H 'Content-Type: application/json' --data-raw \"$1\" 2>/dev/null || true",
        ]).joined(separator: "\n")
    }

    /// PORT resolution shared by every POSIX snippet below.
    private static let posixPortPreamble: [String] = [
        #"PORT="${AGENTDECK_PORT:-}""#,
        #"case "$PORT" in ''|*[!0-9]*) PORT="" ;; *) [ "$PORT" -ge 1 ] 2>/dev/null && [ "$PORT" -le 65535 ] 2>/dev/null || PORT="" ;; esac"#,
        #"if [ -z "$PORT" ]; then"#,
        #"  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do"#,
        #"    [ -f "$F" ] || continue"#,
        #"    P=$(python3 -I -c "import json,sys,signal;signal.signal(signal.SIGALRM,lambda *_:sys.exit(0));signal.setitimer(signal.ITIMER_REAL,0.2);d=json.load(open(sys.argv[1]));p=d.get('httpPort') or d.get('port');print(p if type(p) is int and 1 <= p <= 65535 else '')" "$F" 2>/dev/null)"#,
        #"    [ -n "$P" ] && curl -sf --connect-timeout 0.2 --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }"#,
        #"  done"#,
        #"fi"#,
        #"[ -n "$PORT" ] || exit 0"#,
    ]

    private static func buildLifecycleHookTables(includeApprovalHold: Bool = false) -> [String] {
        let hooks: [(codexEvent: String, agentDeckEvent: String, matcher: String?)] = [
            ("SessionStart", "codex_session_start", "startup|resume|clear"),
            ("UserPromptSubmit", "codex_user_prompt_submit", nil),
            ("PreToolUse", "codex_tool_start", "*"),
            ("PostToolUse", "codex_tool_end", "*"),
            ("Stop", "codex_stop", nil),
            ("SubagentStart", "codex_subagent_start", "*"),
            ("SubagentStop", "codex_subagent_stop", "*"),
            ("PermissionRequest", "codex_permission_request", "*"),
            ("Interrupt", "codex_interrupt", nil),
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
            // Codex 0.151+ caps Interrupt at three seconds.
            lines.append("timeout = \(hook.codexEvent == "Interrupt" ? 3 : 5)")
            // The hold is a second handler in AgentDeck's own group, never a
            // group of its own. Codex keys trust by group and handler index and
            // hashes each handler alone, so this leaves the notification
            // handler trusted and re-keys nobody; a new group ahead of a
            // user's would re-key theirs.
            if includeApprovalHold && hook.codexEvent == "PermissionRequest" {
                lines.append("[[hooks.\(hook.codexEvent).hooks]]")
                lines.append("type = \"command\"")
                lines.append("command = \(MiniToml.quoted(buildApprovalHoldCommand()))")
                lines.append("timeout = \(approvalHoldTimeoutSeconds)")
            }
        }
        return lines
    }

    /// Official Codex lifecycle hooks pass their JSON payload on stdin.
    /// Keep stdout quiet so Stop/UserPromptSubmit hooks do not accidentally
    /// feed AgentDeck's acknowledgement back into Codex as hook output.
    private static func buildLifecycleHookCommand(event: String) -> String {
        return "exec sh -c \(shellSingleQuoted(buildStdinPostSnippet(event: event)))"
    }

    private static func buildStdinPostSnippet(event: String) -> String {
        (posixPortPreamble + [
            "curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST \"http://127.0.0.1:$PORT/hooks/\(event)\" -H 'Content-Type: application/json' -H \"X-AgentDeck-Pid: $PPID\" -d @- >/dev/null 2>&1 || true",
        ]).joined(separator: "\n")
    }

    /// The hold handler: post the `PermissionRequest` payload with the hold
    /// header, wait for the daemon's answer, and print it only when it is a
    /// decision. Every other outcome (no daemon, a daemon without the hold, a
    /// timeout, an empty pass) prints nothing and exits 0, which Codex reads
    /// as no decision: its own prompt appears as if the handler were absent.
    /// Byte-identical with `buildCodexApprovalHoldCommand` in
    /// hooks/src/codex-install.ts — Codex hashes the command for trust, so a
    /// one-byte drift re-prompts (shared/codex-approval-hold-vectors.json).
    static func buildApprovalHoldCommand() -> String {
        "exec sh -c \(shellSingleQuoted(buildApprovalHoldSnippet()))"
    }

    private static func buildApprovalHoldSnippet() -> String {
        (posixPortPreamble + [
            "R=$(curl -sf --connect-timeout 0.2 --max-time \(approvalHoldWaitSeconds) -X POST \"http://127.0.0.1:$PORT/hooks/codex_permission_request\" -H 'Content-Type: application/json' -H \"X-AgentDeck-Pid: $PPID\" -H \"\(approvalHoldHeader): \(approvalHoldWaitSeconds)\" -d @- 2>/dev/null) || R=\"\"",
            #"case "$R" in *'"hookSpecificOutput"'*) printf '%s' "$R" ;; esac"#,
        ]).joined(separator: "\n")
    }

    private static func shellSingleQuoted(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    // MARK: - File I/O

    /// Failed reads must never become empty configurations and overwrite data.
    static func updateConfig(at url: URL, transform: (String) throws -> String) throws {
        guard (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]))?.isSymbolicLink != true else {
            throw InstallError.unsupported("symbolic links are managed by their owner")
        }
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw InstallError.unreadable }
        guard let original = String(data: data, encoding: .utf8) else { throw InstallError.unreadable }
        let updated = try transform(original)
        guard updated != original else { return }
        guard (try? Data(contentsOf: url)) == data else { throw InstallError.changed }
        do { try Data(updated.utf8).write(to: url, options: .atomic) }
        catch { throw InstallError.write }
    }
}
#endif
