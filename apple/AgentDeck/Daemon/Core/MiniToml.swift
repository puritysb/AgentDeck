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
// strips it. Everything outside the fence is preserved byte-for-byte.
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
        if text.contains(String(repeating: "\"", count: 3)) || text.contains(String(repeating: "'", count: 3)) {
            return "multiline TOML requires manual configuration"
        }
        let lines = splitLines(text)
        let opens = lines.filter { $0 == openFence }.count
        let closes = lines.filter { $0 == closeFence }.count
        if opens != closes || opens > 1 || (opens == 1 && lines.firstIndex(of: openFence)! > lines.firstIndex(of: closeFence)!) {
            return "incomplete or duplicate AgentDeck fence"
        }
        var inTable = false
        for line in splitLines(removeManagedBlock(in: text)) {
            let code = withoutComment(line).trimmingCharacters(in: .whitespaces)
            if !code.hasPrefix("["), let equals = code.firstIndex(of: "=") {
                var quote: Character?
                var escaped = false
                var balance = 0
                for c in code[code.index(after: equals)...] {
                    if escaped { escaped = false; continue }
                    if quote == "\"", c == "\\" { escaped = true; continue }
                    if let q = quote { if c == q { quote = nil } }
                    else if c == "\"" || c == "'" { quote = c }
                    else if c == "[" || c == "{" { balance += 1 }
                    else if c == "]" || c == "}" { balance -= 1 }
                }
                if balance != 0 || quote != nil { return "multiline or incomplete TOML value requires manual configuration" }
            }
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
        for line in splitLines(removeManagedBlock(in: text)) {
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
        var lines = splitLines(text)
        let replacement = [openFence] + (body.isEmpty ? [] : splitLines(body)) + [closeFence]
        if let range = locateFence(in: lines) {
            let trust = range.count > 1 ? extractCodexHookState(from: Array(lines[(range.lowerBound + 1)..<(range.upperBound - 1)])) : []
            lines.replaceSubrange(range, with: trust)
        }
        // Root notify must precede every table, after the user's root keys.
        let firstTable = lines.firstIndex(where: isTableHeader) ?? lines.count
        lines.insert(contentsOf: replacement, at: firstTable)
        return lines.joined(separator: text.contains("\r\n") ? "\r\n" : "\n")
    }

    /// Strip the AgentDeck-managed block entirely. Idempotent — no-op when
    /// the fence is absent.
    static func removeManagedBlock(in text: String) -> String {
        var lines = splitLines(text)
        guard let range = locateFence(in: lines) else { return text }
        let trust = range.count > 1 ? extractCodexHookState(from: Array(lines[(range.lowerBound + 1)..<(range.upperBound - 1)])) : []
        lines.replaceSubrange(range, with: trust)
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
        for line in splitLines(text) {
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
        for line in splitLines(text) {
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
        for line in splitLines(text) {
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

    private static func splitLines(_ text: String) -> [String] {
        // `String.components(separatedBy: "\n")` keeps trailing-empty so an
        // input ending in "\n" round-trips cleanly when we re-join with "\n".
        return text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    }

    private static func locateFence(in lines: [String]) -> Range<Int>? {
        guard let start = lines.firstIndex(of: openFence) else { return nil }
        // Find first close fence at-or-after start. Defensive against
        // truncated files: if no close fence is found, treat everything
        // from the open fence to the end as managed.
        let end = lines[start...].firstIndex(of: closeFence) ?? (lines.count - 1)
        return start..<(end + 1)
    }

    private static func extractCodexHookState(from lines: [String]) -> [String] {
        var out: [String] = []
        var capturing = false
        for line in lines {
            let tableHeader = isTableHeader(line)
            if isCodexHookStateHeader(line) {
                capturing = true
                out.append(line)
                continue
            }
            if capturing, tableHeader {
                break
            }
            if capturing {
                out.append(line)
            }
        }
        while let last = out.last, isTrailingNonDataLine(last) {
            out.removeLast()
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

    private static func isTrailingNonDataLine(_ line: String) -> Bool {
        let trimmed = withoutComment(line).trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty || trimmed.hasPrefix("#")
    }
}
#endif
