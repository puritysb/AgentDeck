// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/claude-permission-rules.ts
// Regenerate: pnpm generate-claude-permission-rules (drift gated by shared/src/__tests__/claude-permission-rules-sync.test.ts)

import Foundation

/// Claude Code permission prediction — the Swift half of the SSOT that decides
/// whether an observed session's PreToolUse would genuinely prompt the user.
/// See shared/src/claude-permission-rules.ts for the rule rationale; parity
/// is pinned by shared/claude-permission-vectors.json, replayed by BOTH suites
/// (vitest claude-permission-rules.test.ts / ClaudePermissionRulesTests).
///
/// Every text comparison here is over UNICODE SCALARS, matching the TS side's
/// `Array.from(text)` — never grapheme clusters, whose canonical equivalence
/// would accept a rule the TS side refuses.
enum ClaudePermissionRules {

    /// Values Claude Code writes into a hook payload's `permission_mode`.
    static let permissionModes: [String] = [
        "default",
        "acceptEdits",
        "plan",
        "auto",
        "dontAsk",
        "bypassPermissions",
    ]

    /// Tools that never trigger a permission prompt.
    static let neverPromptTools: Set<String> = [
        "BashOutput",
        "Glob",
        "Grep",
        "LS",
        "NotebookRead",
        "Read",
        "Task",
        "TaskOutput",
        "TodoRead",
        "TodoWrite",
    ]

    /// Tools that DO prompt in default/acceptEdits mode unless allowlisted.
    static let promptProneTools: Set<String> = [
        "Bash",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "WebFetch",
        "WebSearch",
        "Write",
    ]

    /// Edit-family tools that `acceptEdits` auto-approves.
    static let editFamilyTools: Set<String> = [
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "Write",
    ]

    /// Bash programs Claude runs without a prompt in every mode.
    static let readOnlyBashCommands: Set<String> = [
        "basename",
        "cat",
        "cd",
        "cut",
        "date",
        "diff",
        "dirname",
        "du",
        "echo",
        "false",
        "file",
        "find",
        "grep",
        "head",
        "ls",
        "printenv",
        "pwd",
        "realpath",
        "sort",
        "stat",
        "tail",
        "tr",
        "tree",
        "true",
        "type",
        "uname",
        "uniq",
        "wc",
        "which",
        "whoami",
    ]

    /// `git <subcommand>` forms that are read-only regardless of arguments.
    static let readOnlyGitSubcommands: Set<String> = [
        "blame",
        "cat-file",
        "check-ignore",
        "count-objects",
        "describe",
        "diff",
        "log",
        "ls-files",
        "ls-tree",
        "merge-base",
        "name-rev",
        "rev-list",
        "rev-parse",
        "shortlog",
        "show",
        "status",
    ]

    /// `git <subcommand>` forms that are read-only only with these flags.
    static let readOnlyGitListingSubcommands: [String: Set<String>] = [
        "branch": ["--all", "--list", "--remotes", "--show-current", "-a", "-r", "-v", "-vv"],
        "config": ["--get", "--get-all", "--global", "--list", "--local", "--system", "-l"],
        "reflog": ["show"],
        "remote": ["--verbose", "-v", "get-url", "show"],
        "stash": ["list", "show"],
        "tag": ["--list", "-l", "-n"],
        "worktree": ["list"],
    ]

    /// Filesystem commands `acceptEdits` auto-approves (in-scope paths).
    static let acceptEditsFsCommands: Set<String> = [
        "cp",
        "mkdir",
        "mv",
        "rm",
        "rmdir",
        "sed",
        "touch",
    ]

    /// How long after an undecided gate release a PostToolUse still teaches
    /// "auto-approved" (bounds only how slow the TOOL may be).
    static let gateLearnWindowMs: Int = 900000

    private static let wrappersWithValue: Set<String> = ["timeout", "stdbuf"]
    private static let wrappersBare: Set<String> = [
        "time", "nice", "nohup", "command", "builtin", "noglob", "xargs",
    ]
    private static let globSensitive: Set<String> = ["find", "sort", "sed", "git"]

    // MARK: - Mode gate

    static func shouldGatePreToolUse(permissionMode: String?, tool: String) -> Bool {
        let mode = (permissionMode?.isEmpty == false ? permissionMode! : "default")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        switch mode {
        case "bypassPermissions", "dontAsk", "auto", "plan":
            return false
        case "acceptEdits":
            return !editFamilyTools.contains(tool)
        default:
            return true
        }
    }

    // MARK: - Tokenising

    private static func tokens(_ segment: String) -> [String] {
        segment.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).map(String.init)
    }

    private static func isAsciiLetter(_ s: Unicode.Scalar) -> Bool {
        (s.value >= 65 && s.value <= 90) || (s.value >= 97 && s.value <= 122)
    }

    private static func isAsciiDigit(_ s: Unicode.Scalar) -> Bool {
        s.value >= 48 && s.value <= 57
    }

    /// Mirrors the TS `^[A-Za-z_][A-Za-z0-9_]*=` — ASCII only, so a
    /// non-Latin first token is never mistaken for an assignment.
    private static func isEnvAssignment(_ token: String) -> Bool {
        let scalars = Array(token.unicodeScalars)
        guard let first = scalars.first else { return false }
        guard isAsciiLetter(first) || first == "_" else { return false }
        var i = 1
        while i < scalars.count {
            let s = scalars[i]
            if s == "=" { return true }
            guard isAsciiLetter(s) || isAsciiDigit(s) || s == "_" else { return false }
            i += 1
        }
        return false
    }

    /// Strip leading `VAR=value` assignments and process wrappers.
    static func stripCommandWrappers(_ segment: String) -> String {
        var toks = tokens(segment)
        var changed = true
        while changed, !toks.isEmpty {
            changed = false
            let head = toks[0]
            if isEnvAssignment(head) {
                toks.removeFirst()
                changed = true
                continue
            }
            if wrappersWithValue.contains(head) {
                var i = 1
                while i < toks.count, toks[i].hasPrefix("-") { i += 1 }
                if head == "timeout" { i += 1 }
                toks = Array(toks.dropFirst(min(i, toks.count)))
                changed = true
                continue
            }
            if wrappersBare.contains(head) {
                var i = 1
                while i < toks.count, toks[i].hasPrefix("-") {
                    i += 1
                    if head == "nice", toks[i - 1] == "-n" { i += 1 }
                }
                if head == "xargs", i > 1 { break }
                toks = Array(toks.dropFirst(min(i, toks.count)))
                changed = true
            }
        }
        return toks.joined(separator: " ")
    }

    /// Split a compound command on shell operators, quote-aware. Returns nil
    /// when the split is not trustworthy (heredoc, substitution, unbalanced
    /// quote, operator with nothing after it).
    static func splitCompoundCommand(_ command: String) -> [String]? {
        if command.contains("<<") || command.contains("$(") || command.contains("`") { return nil }
        let chars = Array(command.unicodeScalars)
        var segments: [String] = []
        var current = String.UnicodeScalarView()
        var quote: Unicode.Scalar? = nil
        var i = 0
        func push() {
            segments.append(String(current))
            current = String.UnicodeScalarView()
        }
        while i < chars.count {
            let ch = chars[i]
            if let q = quote {
                current.append(ch)
                if ch == "\\", q == "\"", i + 1 < chars.count {
                    current.append(chars[i + 1])
                    i += 2
                    continue
                }
                if ch == q { quote = nil }
                i += 1
                continue
            }
            if ch == "\\", i + 1 < chars.count {
                current.append(ch)
                current.append(chars[i + 1])
                i += 2
                continue
            }
            if ch == "\"" || ch == "'" {
                quote = ch
                current.append(ch)
                i += 1
                continue
            }
            if i + 1 < chars.count {
                let next = chars[i + 1]
                if (ch == "&" && next == "&") || (ch == "|" && next == "|") || (ch == "|" && next == "&") {
                    push()
                    i += 2
                    continue
                }
            }
            if ch == ";" || ch == "|" || ch == "&" || ch == "\n" {
                push()
                i += 1
                continue
            }
            current.append(ch)
            i += 1
        }
        if quote != nil { return nil }
        push()
        let trimmed = segments.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        if trimmed.count > 1, trimmed[trimmed.count - 1].isEmpty { return nil }
        return trimmed.filter { !$0.isEmpty }
    }

    // MARK: - Rule matching

    /// `*` matches any text including spaces; a trailing " *" that is the only
    /// wildcard also matches the bare command; ":*" is an alias of " *".
    static func bashRuleMatches(spec: String, command: String) -> Bool {
        let cmd = command.trimmingCharacters(in: .whitespacesAndNewlines)
        if spec == "*" { return true }
        var pattern = spec
        if pattern.hasSuffix(":*") { pattern = String(pattern.dropLast(2)) + " *" }
        let stars = pattern.unicodeScalars.filter { $0 == "*" }.count
        if stars == 0 { return cmd == pattern }
        if stars == 1, pattern.hasSuffix(" *"), cmd == String(pattern.dropLast(2)) { return true }
        return globMatch(pattern: pattern, text: cmd)
    }

    /// `*`-only glob over unicode scalars, iterative (no backtracking blow-up).
    static func globMatch(pattern: String, text: String) -> Bool {
        let p = Array(pattern.unicodeScalars)
        let t = Array(text.unicodeScalars)
        var pi = 0
        var ti = 0
        var starPi = -1
        var starTi = -1
        while ti < t.count {
            if pi < p.count, p[pi] == "*" {
                starPi = pi
                starTi = ti
                pi += 1
            } else if pi < p.count, p[pi] == t[ti] {
                pi += 1
                ti += 1
            } else if starPi >= 0 {
                pi = starPi + 1
                starTi += 1
                ti = starTi
            } else {
                return false
            }
        }
        while pi < p.count, p[pi] == "*" { pi += 1 }
        return pi == p.count
    }

    struct ParsedRule: Equatable {
        let tool: String
        let spec: String?
    }

    /// `Tool` or `Tool(spec)` → parts; anything else → nil.
    static func parsePermissionRule(_ rule: String) -> ParsedRule? {
        let trimmed = rule.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let regex = try? NSRegularExpression(pattern: "^([A-Za-z][A-Za-z0-9_]*)(?:\\((.*)\\))?$") else { return nil }
        let ns = trimmed as NSString
        guard let m = regex.firstMatch(in: trimmed, range: NSRange(location: 0, length: ns.length)) else { return nil }
        let tool = ns.substring(with: m.range(at: 1))
        let specRange = m.range(at: 2)
        let spec = specRange.location == NSNotFound ? nil : ns.substring(with: specRange)
        return ParsedRule(tool: tool, spec: spec)
    }

    struct MergedRules {
        var allow: [String]
        var deny: [String]
        var ask: [String]
    }

    /// Loose match (allow/deny direction).
    static func ruleMatchesLoose(_ rule: ParsedRule, tool: String, segment: String?) -> Bool {
        guard rule.tool == tool else { return false }
        guard let spec = rule.spec else { return true }
        if tool == "Bash" {
            guard let segment else { return true }
            return bashRuleMatches(spec: spec, command: segment)
                || bashRuleMatches(spec: spec, command: stripCommandWrappers(segment))
        }
        return true
    }

    /// Strict match (ask direction).
    static func ruleMatchesStrict(_ rule: ParsedRule, tool: String, segment: String?) -> Bool {
        guard rule.tool == tool else { return false }
        guard let spec = rule.spec else { return true }
        if tool == "Bash", let segment { return bashRuleMatches(spec: spec, command: segment) }
        return false
    }

    // MARK: - Built-in auto-approvals

    private static func hasUnquotedGlob(_ segment: String) -> Bool {
        var quote: Unicode.Scalar? = nil
        for ch in segment.unicodeScalars {
            if let q = quote {
                if ch == q { quote = nil }
                continue
            }
            if ch == "\"" || ch == "'" { quote = ch }
            else if ch == "*" || ch == "?" || ch == "[" { return true }
        }
        return false
    }

    private static func hasWriteRedirect(_ segment: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: "(?:\\d|&)?>>?\\s*/dev/null") else {
            return segment.contains(">")
        }
        let ns = segment as NSString
        let stripped = regex.stringByReplacingMatches(
            in: segment, range: NSRange(location: 0, length: ns.length), withTemplate: "")
        return stripped.contains(">")
    }

    /// Is this one segment in Claude Code's built-in read-only set?
    static func isBuiltinReadOnlyCommand(_ segment: String) -> Bool {
        let stripped = stripCommandWrappers(segment)
        let toks = tokens(stripped)
        guard let program = toks.first else { return false }
        if hasWriteRedirect(stripped) { return false }
        if program == "git" {
            guard toks.count >= 2 else { return false }
            let sub = toks[1]
            if hasUnquotedGlob(stripped) { return false }
            if readOnlyGitSubcommands.contains(sub) { return true }
            guard let listingFlags = readOnlyGitListingSubcommands[sub] else { return false }
            return toks.dropFirst(2).allSatisfy { listingFlags.contains($0) }
        }
        guard readOnlyBashCommands.contains(program) else { return false }
        if globSensitive.contains(program), hasUnquotedGlob(stripped) { return false }
        return true
    }

    /// Is this segment one of the filesystem commands `acceptEdits` auto-approves?
    static func isAcceptEditsFsCommand(_ segment: String) -> Bool {
        guard let program = tokens(stripCommandWrappers(segment)).first else { return false }
        return acceptEditsFsCommands.contains(program)
    }

    // MARK: - Verdicts

    enum Verdict: String { case allow, deny, ask, none, unknown }

    static func evaluatePermissionRules(
        tool: String,
        command: String?,
        rules: MergedRules?,
        permissionMode: String? = nil
    ) -> Verdict {
        guard let rules else { return .unknown }
        let parsedDeny = rules.deny.compactMap(parsePermissionRule)
        let parsedAllow = rules.allow.compactMap(parsePermissionRule)
        let parsedAsk = rules.ask.compactMap(parsePermissionRule)

        for r in parsedDeny where ruleMatchesLoose(r, tool: tool, segment: command) { return .deny }

        guard tool == "Bash", let command else {
            for r in parsedAllow where ruleMatchesLoose(r, tool: tool, segment: command) { return .allow }
            for r in parsedAsk where ruleMatchesStrict(r, tool: tool, segment: command) { return .ask }
            return .none
        }

        let segments = splitCompoundCommand(command) ?? [command]
        let acceptEdits = (permissionMode ?? "").trimmingCharacters(in: .whitespacesAndNewlines) == "acceptEdits"
        var anyAsk = false
        var allCovered = !segments.isEmpty
        for segment in segments {
            if parsedDeny.contains(where: { ruleMatchesLoose($0, tool: tool, segment: segment) }) { return .deny }
            if parsedAsk.contains(where: { ruleMatchesStrict($0, tool: tool, segment: segment) }) {
                anyAsk = true
                allCovered = false
                continue
            }
            let covered = parsedAllow.contains(where: { ruleMatchesLoose($0, tool: tool, segment: segment) })
                || isBuiltinReadOnlyCommand(segment)
                || (acceptEdits && isAcceptEditsFsCommand(segment))
            if !covered { allCovered = false }
        }
        if allCovered { return .allow }
        if anyAsk { return .ask }
        return .none
    }

    struct HoldPrediction: Equatable {
        let hold: Bool
        let reason: String
    }

    /// The stateless half of the device-approval gate.
    static func predictPreToolUseHold(
        tool: String,
        command: String?,
        permissionMode: String?,
        rules: MergedRules?
    ) -> HoldPrediction {
        if tool.isEmpty { return HoldPrediction(hold: false, reason: "no tool name") }
        if tool.hasPrefix("mcp__") { return HoldPrediction(hold: false, reason: "mcp tool (trust state unknown)") }
        if neverPromptTools.contains(tool) { return HoldPrediction(hold: false, reason: "never-prompt tool") }
        if !promptProneTools.contains(tool) { return HoldPrediction(hold: false, reason: "not prompt-prone") }
        if !shouldGatePreToolUse(permissionMode: permissionMode, tool: tool) {
            let mode = permissionMode?.isEmpty == false ? permissionMode! : "default"
            return HoldPrediction(hold: false, reason: "permission_mode=\(mode) auto-approves")
        }
        switch evaluatePermissionRules(tool: tool, command: command, rules: rules, permissionMode: permissionMode) {
        case .unknown: return HoldPrediction(hold: false, reason: "settings unreadable")
        case .deny: return HoldPrediction(hold: false, reason: "deny rule may match")
        case .allow: return HoldPrediction(hold: false, reason: "allow rule or built-in auto-approval covers the call")
        case .ask: return HoldPrediction(hold: true, reason: "ask rule matches")
        case .none: return HoldPrediction(hold: true, reason: "prompt-prone, no rule match")
        }
    }

    // MARK: - Learner

    /// Bash signature = first two command tokens; other tools = tool name.
    static func gateSignature(tool: String, commandText: String?) -> String {
        if tool == "Bash", let commandText {
            let head = tokens(commandText).prefix(2).joined(separator: " ")
            return "Bash|\(head)"
        }
        return tool
    }
}
