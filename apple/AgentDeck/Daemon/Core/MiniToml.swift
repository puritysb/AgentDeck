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
    static let featureOpenFence = "# >>> AgentDeck managed feature (do not edit) <<<"
    static let featureCloseFence = "# <<< AgentDeck managed feature (do not edit) >>>"

    enum ManagedBooleanStatus: Equatable {
        case inserted
        case present
        case conflict(String)
    }

    struct ManagedBooleanResult {
        let text: String
        let status: ManagedBooleanStatus
    }

    /// Replace the AgentDeck-managed fenced block (or append one when none
    /// exists). The body is wrapped between `openFence` / `closeFence` so
    /// `removeManagedBlock` can strip it cleanly later. Returns the full
    /// updated TOML text.
    static func applyManagedBlock(in text: String, body: String) -> String {
        var lines = text.isEmpty ? [] : splitLines(text)
        let fenceRange = locateFence(in: lines)

        let bodyLines = body.isEmpty ? [] : splitLines(body)
        var replacement = [openFence] + bodyLines + [closeFence]

        if let range = fenceRange {
            let innerStart = range.lowerBound + 1
            let innerEnd = max(innerStart, range.upperBound - 1)
            let innerLines = innerStart < innerEnd ? Array(lines[innerStart..<innerEnd]) : []
            let preservedHookState = extractCodexHookState(from: innerLines)
            if !preservedHookState.isEmpty {
                replacement.append("")
                replacement.append(contentsOf: preservedHookState)
            }
            lines.replaceSubrange(range, with: replacement)
        } else {
            // Always add one separator line. If the user's file already ends
            // in a newline, splitLines has its own trailing empty element;
            // retaining both lets removeManagedBlock restore that byte.
            if !text.isEmpty {
                lines.append("")
            }
            lines.append(contentsOf: replacement)
        }
        return lines.joined(separator: "\n")
    }

    /// Strip the AgentDeck-managed block entirely. Idempotent — no-op when
    /// the fence is absent.
    static func removeManagedBlock(in text: String) -> String {
        var lines = splitLines(text)
        guard let range = locateFence(in: lines) else { return text }
        let fenceWasAtEnd = range.upperBound == lines.count
        lines.removeSubrange(range)
        // Remove exactly the separator inserted by applyManagedBlock. Any
        // second trailing empty belongs to the user's original final newline.
        if fenceWasAtEnd, let last = lines.last, last.isEmpty {
            lines.removeLast()
        }
        return lines.joined(separator: "\n")
    }

    /// Add a boolean key to an existing user-owned table without reopening
    /// the table or taking ownership of its other keys. The dedicated feature
    /// fence lets uninstall remove only the value AgentDeck inserted.
    static func ensureManagedBoolean(
        in text: String,
        table: String,
        key: String,
        value: Bool
    ) -> ManagedBooleanResult {
        var lines = splitLines(text)
        let escapedTable = NSRegularExpression.escapedPattern(for: table)
        let escapedKey = NSRegularExpression.escapedPattern(for: key)
        guard let tableRegex = try? NSRegularExpression(
            pattern: "^\\s*\\[\\s*\(escapedTable)\\s*\\]\\s*$"
        ), let keyRegex = try? NSRegularExpression(
            pattern: "^\\s*\(escapedKey)\\s*=\\s*([^#]+?)(?:\\s+#.*)?$"
        ) else {
            return ManagedBooleanResult(text: text, status: .conflict("invalid table or key"))
        }

        var insideMainFence = false
        var tableStart: Int?
        for index in lines.indices {
            if lines[index] == openFence { insideMainFence = true; continue }
            if lines[index] == closeFence { insideMainFence = false; continue }
            let ns = lines[index] as NSString
            if !insideMainFence,
               tableRegex.firstMatch(
                in: lines[index],
                range: NSRange(location: 0, length: ns.length)
               ) != nil {
                tableStart = index
                break
            }
        }

        guard let tableStart else {
            return ManagedBooleanResult(
                text: text,
                status: .conflict("user-authored [\(table)] cannot be merged safely")
            )
        }

        var tableEnd = lines.count
        if tableStart + 1 < lines.count {
            for index in (tableStart + 1)..<lines.count {
                if lines[index] == openFence || isTableHeader(lines[index]) {
                    tableEnd = index
                    break
                }
            }
        }

        if tableStart + 1 < tableEnd {
            for index in (tableStart + 1)..<tableEnd {
                let ns = lines[index] as NSString
                guard let match = keyRegex.firstMatch(
                    in: lines[index],
                    range: NSRange(location: 0, length: ns.length)
                ), match.numberOfRanges > 1 else { continue }
                let actual = ns.substring(with: match.range(at: 1))
                    .trimmingCharacters(in: .whitespaces)
                let expected = value ? "true" : "false"
                if actual == expected {
                    return ManagedBooleanResult(text: text, status: .present)
                }
                return ManagedBooleanResult(
                    text: text,
                    status: .conflict("[\(table)].\(key) is already \(actual)")
                )
            }
        }

        var insertionIndex = tableEnd
        while insertionIndex > tableStart + 1,
              lines[insertionIndex - 1].trimmingCharacters(in: .whitespaces).isEmpty {
            insertionIndex -= 1
        }
        lines.insert(contentsOf: [
            featureOpenFence,
            "\(key) = \(value ? "true" : "false")",
            featureCloseFence,
        ], at: insertionIndex)
        return ManagedBooleanResult(text: lines.joined(separator: "\n"), status: .inserted)
    }

    /// Remove only the boolean key block inserted by
    /// `ensureManagedBoolean`. User-owned values are never touched.
    static func removeManagedBoolean(in text: String) -> String {
        var lines = splitLines(text)
        guard let start = lines.firstIndex(of: featureOpenFence),
              start + 1 < lines.count,
              let end = lines[(start + 1)..<lines.count].firstIndex(of: featureCloseFence) else {
            return text
        }
        lines.removeSubrange(start..<(end + 1))
        return lines.joined(separator: "\n")
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
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") && trimmed.hasSuffix("]") {
                insideTable = true
                continue
            }
            if insideTable { continue }
            let ns = line as NSString
            if regex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) != nil {
                return true
            }
        }
        return false
    }

    /// Detect a `[<table>]`, `[<table>.subkey]`, or matching array-of-table
    /// header outside the fence. Codex `[otel]` / `[features]` / `[hooks]`
    /// tables collide with the fence we'd write.
    static func hasTableOutsideFence(in text: String, table: String) -> Bool {
        let escaped = NSRegularExpression.escapedPattern(for: table)
        // Match exactly `[otel]`, `[otel.something]`, `[[otel.something]]`,
        // but not `[otelfoo]`. Whitespace inside brackets is permissive.
        let pattern = "^\\s*\\[\\[?\\s*\(escaped)(\\.[A-Za-z0-9_\\-]+)*\\s*\\]\\]?\\s*$"
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return false
        }
        var insideFence = false
        for line in splitLines(text) {
            if line == openFence { insideFence = true; continue }
            if line == closeFence { insideFence = false; continue }
            if insideFence { continue }
            if table == "hooks", isCodexHookStateHeader(line) { continue }
            let ns = line as NSString
            if regex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) != nil {
                return true
            }
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
        return text.components(separatedBy: "\n")
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
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed == "[hooks.state]"
            || (trimmed.hasPrefix("[hooks.state.") && trimmed.hasSuffix("]"))
    }

    private static func isTableHeader(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("[") && trimmed.hasSuffix("]")
    }

    private static func isTrailingNonDataLine(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty || trimmed.hasPrefix("#")
    }
}
#endif
