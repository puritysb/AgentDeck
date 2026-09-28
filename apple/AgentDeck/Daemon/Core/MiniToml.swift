#if os(macOS)
// MiniToml.swift — minimal lossless TOML editor for ~/.codex/config.toml.
//
// We deliberately do NOT parse TOML semantically. Codex configs contain
// user-authored keys, comments, profile tables, and MCP server tables that
// we have no business round-tripping through Foundation's JSON-style
// serializer. Instead, AgentDeck-managed entries live inside a fenced
// block bounded by sentinel comments:
//
//     # >>> AgentDeck managed (do not edit) <<<
//     <our keys>
//     # <<< AgentDeck managed (do not edit) >>>
//
// applyManagedBlock replaces (or appends) the fence; removeManagedBlock
// removes owned entries and retains later user additions. Outside text is preserved.
// hasTopLevel{Key,Table}OutsideFence detects user-authored conflicts so
// CodexConfigInstaller can abort cleanly instead of producing a TOML
// duplicate-key error.

import Foundation

enum MiniToml {
    static let openFence = "# >>> AgentDeck managed (do not edit) <<<"
    static let closeFence = "# <<< AgentDeck managed (do not edit) >>>"

    /// Matches the lossless editor policy in hooks/src/codex-mini-toml.ts.
    /// Shared config fixtures gate both runtimes; unsupported syntax is kept intact.
    static func configEditIssue(_ text: String) -> String? {
        guard scanStatements(text) != nil else { return "incomplete TOML string or collection; kept unchanged" }
        let lines = statements(text)
        let opens = lines.filter { $0 == openFence }.count
        let closes = lines.filter { $0 == closeFence }.count
        if opens != closes || opens > 1 || (opens == 1 && lines.firstIndex(of: openFence)! > lines.firstIndex(of: closeFence)!) {
            return "incomplete or duplicate AgentDeck fence"
        }
        if let fence = locateFence(in: lines),
           retainedFenceContent(from: Array(lines[(fence.lowerBound + 1)..<(fence.upperBound - 1)])).contains(where: isOwnedCommand) {
            return "modified AgentDeck hook table requires manual configuration; kept unchanged"
        }
        var inTable = false
        for line in statements(removeManagedBlock(in: text)) {
            let code = withoutComment(line).trimmingCharacters(in: .whitespaces)
            if code.range(of: #"^\[\[?\s*["'](?:features|hooks|otel)["']"#, options: .regularExpression) != nil
                || (!inTable && code.range(of: #"^(?:["'](?:features|hooks|otel|notify)["']\s*[.=]|(?:features|hooks|otel)\s*[.=])"#, options: .regularExpression) != nil) {
                return "quoted, inline or dotted integration keys require manual configuration"
            }
            if code.hasPrefix("[") { inTable = true }
        }
        return nil
    }

    static func existingFeaturesEnableHooks(_ text: String) -> Bool {
        var inFeatures = false
        var values = 0
        var enabled = false
        for line in statements(removeManagedBlock(in: text)) {
            let code = withoutComment(line).trimmingCharacters(in: .whitespaces)
            if code.hasPrefix("[") {
                inFeatures = code.range(of: #"^\[\s*features\s*\]$"#, options: .regularExpression) != nil
            } else if inFeatures, code.range(of: #"^hooks\s*="#, options: .regularExpression) != nil {
                values += 1
                enabled = code.range(of: #"^hooks\s*=\s*true$"#, options: .regularExpression) != nil
            }
        }
        return values == 1 && enabled
    }

    private static func withoutComment(_ line: String) -> String {
        var quote: Character?
        var escaped = false
        for i in line.indices {
            let c = line[i]
            if escaped { escaped = false; continue }
            if quote == "\"", c == "\\" { escaped = true; continue }
            if let q = quote { if c == q { quote = nil } }
            else if c == "\"" || c == "'" { quote = c }
            else if c == "#" { return String(line[..<i]) }
        }
        return line
    }

    /// Replace the AgentDeck-managed fenced block (or append one when none
    /// exists). The body is wrapped between `openFence` / `closeFence` so
    /// `removeManagedBlock` can strip it cleanly later. Returns the full
    /// updated TOML text.
    static func applyManagedBlock(in text: String, body: String) -> String {
        var lines = statements(removeManagedBlock(in: text))
        let replacement = [openFence] + (body.isEmpty ? [] : statements(body)) + [closeFence]
        // Root notify must precede every table, after the user's root keys.
        let firstTable = lines.firstIndex(where: isTableHeader) ?? lines.count
        lines.insert(contentsOf: replacement, at: firstTable)
        return lines.joined(separator: text.contains("\r\n") ? "\r\n" : "\n")
    }

    /// Remove generated entries and preserve foreign data inside the fence. Idempotent — no-op when
    /// the fence is absent.
    static func removeManagedBlock(in text: String) -> String {
        var lines = statements(text)
        guard let range = locateFence(in: lines), lines[range.upperBound - 1] == closeFence else { return text }
        let retained = range.count > 1 ? retainedFenceContent(from: Array(lines[(range.lowerBound + 1)..<(range.upperBound - 1)])) : []
        lines.replaceSubrange(range, with: retained)
        return lines.joined(separator: text.contains("\r\n") ? "\r\n" : "\n")
    }

    /// Detect a top-level `<key> = ...` definition outside the fence.
    /// Codex `notify` is a top-level key; if the user already wrote one
    /// our fenced `notify` would be a duplicate-key TOML error.
    static func hasTopLevelKeyOutsideFence(in text: String, key: String) -> Bool {
        let escaped = NSRegularExpression.escapedPattern(for: key)
        guard let regex = try? NSRegularExpression(pattern: "^\\s*\(escaped)\\s*=") else {
            return false
        }
        var insideFence = false
        var insideTable = false
        for line in statements(text) {
            if line == openFence { insideFence = true; continue }
            if line == closeFence { insideFence = false; continue }
            if insideFence { continue }
            let trimmed = withoutComment(line).trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") && trimmed.hasSuffix("]") {
                insideTable = true
                continue
            }
            if insideTable { continue }
            let code = withoutComment(line)
            let ns = code as NSString
            if regex.firstMatch(in: code, range: NSRange(location: 0, length: ns.length)) != nil {
                return true
            }
        }
        return false
    }

    /// Detect a `[<table>]`, `[<table>.subkey]`, or matching array-of-table
    /// header outside the fence. Codex `[otel]` / `[features]` tables collide
    /// with the fence we'd write. Hook arrays are handled separately because
    /// multiple `[[hooks.<Event>]]` entries are explicitly mergeable.
    static func hasTableOutsideFence(in text: String, table: String) -> Bool {
        let escaped = NSRegularExpression.escapedPattern(for: table)
        // Match exactly `[otel]`, `[otel.something]`, `[[otel.something]]`,
        // but not `[otelfoo]`. Whitespace inside brackets is permissive.
        let pattern = "^\\s*\\[\\[?\\s*\(escaped)(?=\\s*[.\\]])"
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return false
        }
        var insideFence = false
        for line in statements(text) {
            if line == openFence { insideFence = true; continue }
            if line == closeFence { insideFence = false; continue }
            if insideFence { continue }
            if table == "hooks", isCodexHookStateHeader(line) { continue }
            let code = withoutComment(line)
            let ns = code as NSString
            if regex.firstMatch(in: code, range: NSRange(location: 0, length: ns.length)) != nil {
                return true
            }
        }
        return false
    }

    /// Detect user-authored hook table shapes that cannot safely coexist
    /// with AgentDeck's lifecycle arrays. Official lifecycle arrays merge;
    /// regular hook tables conflict. Codex's trust-state tables are metadata.
    static func hasIncompatibleHookTableOutsideFence(in text: String) -> Bool {
        let anyHookPattern = #"^\s*\[\[?\s*hooks(?:\.[^\]]+)?\s*\]\]?\s*$"#
        let mergeablePattern = #"^\s*\[\[\s*hooks\.[A-Za-z0-9_-]+(?:\.hooks)?\s*\]\]\s*$"#
        guard let anyHookRegex = try? NSRegularExpression(pattern: anyHookPattern),
              let mergeableRegex = try? NSRegularExpression(pattern: mergeablePattern) else {
            return false
        }
        var insideFence = false
        for line in statements(text) {
            if line == openFence { insideFence = true; continue }
            if line == closeFence { insideFence = false; continue }
            if insideFence || isCodexHookStateHeader(line) { continue }
            let code = withoutComment(line)
            let ns = code as NSString
            let range = NSRange(location: 0, length: ns.length)
            guard anyHookRegex.firstMatch(in: code, range: range) != nil else { continue }
            if mergeableRegex.firstMatch(in: code, range: range) != nil { continue }
            return true
        }
        return false
    }

    /// Quote a string as a TOML basic string. We escape backslash, double
    /// quote, and control characters so the output is always single-line
    /// safe. Multi-line bodies should be assembled as raw lines and embed
    /// individual quoted strings via this helper.
    static func quoted(_ s: String) -> String {
        var out = "\""
        for ch in s.unicodeScalars {
            switch ch {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if ch.value < 0x20 {
                    out += String(format: "\\u%04x", ch.value)
                } else {
                    out.unicodeScalars.append(ch)
                }
            }
        }
        out += "\""
        return out
    }

    // MARK: - Internals

    /// Logical statements preserve multiline values without treating their
    /// contents as headers or fence comments. Mirrored by the Node editor.
    private static func scanStatements(_ text: String) -> [String]? {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var out: [String] = [], pending: [String] = []
        var quote: Character?
        var multiline = false
        var depth = 0
        for line in lines {
            pending.append(line)
            let chars = Array(line)
            var i = 0
            while i < chars.count {
                let c = chars[i]
                if let q = quote {
                    if q == "\"", c == "\\" { i += 2; continue }
                    if c == q {
                        if !multiline { quote = nil }
                        else if i + 2 < chars.count, chars[i + 1] == q, chars[i + 2] == q {
                            while i + 1 < chars.count, chars[i + 1] == q { i += 1 }
                            quote = nil; multiline = false
                        }
                    }
                } else if c == "#" { break }
                else if c == "\"" || c == "'" {
                    quote = c
                    multiline = i + 2 < chars.count && chars[i + 1] == c && chars[i + 2] == c
                    if multiline { i += 2 }
                } else if c == "[" || c == "{" { depth += 1 }
                else if c == "]" || c == "}" { depth -= 1; if depth < 0 { return nil } }
                i += 1
            }
            if quote != nil && !multiline { return nil }
            if quote == nil && depth == 0 { out.append(pending.joined(separator: text.contains("\r\n") ? "\r\n" : "\n")); pending = [] }
        }
        return pending.isEmpty ? out : nil
    }

    private static func statements(_ text: String) -> [String] {
        scanStatements(text) ?? [text]
    }

    private static func locateFence(in lines: [String]) -> Range<Int>? {
        guard let start = lines.firstIndex(of: openFence) else { return nil }
        // Find first close fence at-or-after start. Defensive against
        // truncated files: if no close fence is found, treat everything
        // from the open fence to the end as managed.
        let end = lines[start...].firstIndex(of: closeFence) ?? (lines.count - 1)
        return start..<(end + 1)
    }

    private static func isOwnedCommand(_ line: String) -> Bool {
        guard line.trimmingCharacters(in: .whitespaces).range(of: #"^command\s*="#, options: .regularExpression) != nil else { return false }
        if line.contains("/hooks/codex_") { return true }
        guard let range = line.range(of: #"-EncodedCommand\s+[A-Za-z0-9+/=]+"#, options: .regularExpression),
              let encoded = line[range].split(whereSeparator: { $0.isWhitespace }).last,
              let bytes = Data(base64Encoded: String(encoded)),
              let command = String(data: bytes, encoding: .utf16LittleEndian) else { return false }
        return command.contains("/hooks/codex_")
    }

    private static func generatedComment(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).range(of: #"^# (?:Codex lifecycle hooks\.|each snippet forwards|Optional turn-complete notification|Codex appends the JSON payload|so the 4th array element|powershell -File binds|it concatenates trailing argv|OTel trace exporter|Schema: \[otel\.)"#, options: .regularExpression) != nil
    }

    /// toml_edit can add user keys inside our fence. Preserve foreign data
    /// with its table context; an extended features table becomes user-owned.
    private static func retainedFenceContent(from lines: [String]) -> [String] {
        func matches(_ text: String, _ pattern: String) -> Bool {
            text.range(of: pattern, options: .regularExpression) != nil
        }
        func code(_ line: String) -> String { withoutComment(line).trimmingCharacters(in: .whitespacesAndNewlines) }
        var groups: [[String]] = [[]]
        for line in lines {
            if isTableHeader(line) && !matches(code(line), #"^\[\[hooks\.[^.]+\.hooks\]\]$"#) { groups.append([]) }
            groups[groups.count - 1].append(line)
        }
        var out: [String] = []
        for group in groups {
            let kept = group.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !generatedComment($0) }
            let data = kept.filter { !code($0).isEmpty }
            guard let first = data.first else { out += kept; continue }
            let header = code(first)
            if !isTableHeader(first) {
                out += kept.filter { !(matches(code($0), #"^notify\s*="#) && ($0.contains("agentdeck-notify") || $0.contains("codex-notify.ps1"))) }
            } else if matches(header, #"^\[\s*features\s*\]$"#) {
                if data.dropFirst().contains(where: { !matches(code($0), #"^hooks\s*=\s*true$"#) }) { out += kept }
                else { out += kept.filter { code($0).isEmpty } }
            } else if matches(header, #"^\[\[hooks\.[^.]+\]\]$"#) {
                let commands = data.filter { matches(code($0), #"^command\s*="#) }
                let owned = !commands.isEmpty && commands.allSatisfy(isOwnedCommand)
                if !owned || data.dropFirst().contains(where: { !matches(code($0), #"^(?:\[\[hooks\.|(?:matcher|type|command|timeout|notify)\s*=)"#) }) { out += kept }
            } else if header == "[otel.trace_exporter.otlp-http]" {
                let owned = data.contains { matches(code($0), #"^endpoint\s*=\s*"http://127\.0\.0\.1:\d+/otel/v1/traces"$"#) }
                if !owned || data.dropFirst().contains(where: { !matches(code($0), #"^(?:endpoint|protocol)\s*="#) }) { out += kept }
            } else { out += kept }
        }
        return out
    }

    private static func isCodexHookStateHeader(_ line: String) -> Bool {
        let trimmed = withoutComment(line).trimmingCharacters(in: .whitespaces)
        return trimmed == "[hooks.state]"
            || (trimmed.hasPrefix("[hooks.state.") && trimmed.hasSuffix("]"))
    }

    private static func isTableHeader(_ line: String) -> Bool {
        let trimmed = withoutComment(line).trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("[") && trimmed.hasSuffix("]")
    }

}
#endif
