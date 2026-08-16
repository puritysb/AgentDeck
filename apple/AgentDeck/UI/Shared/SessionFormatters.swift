// SessionFormatters.swift — central session text helpers
//
// Three near-identical implementations of these helpers had been copied
// into `ControlTowerPanel`, `SessionJumpRow`, and `AttentionTheaterView`.
// The bodies drifted slightly each time a new agent type was added; this
// file makes it a single source of truth.

import Foundation

/// Human-readable label for an agent type id.
///
/// Matches the branding copy used throughout the UI. Must not abbreviate
/// "OpenClaw" (see memory `brand-direction.md`).
func displayAgentLabel(_ type: String?) -> String {
    switch type {
    case "claude-code": return "Claude"
    case "openclaw":    return "OpenClaw"
    case "codex-cli":   return "Codex CLI"
    case "codex-app":   return "Codex App"
    case "opencode":    return "OpenCode"
    case "antigravity": return "Antigravity"
    case "kiro-cli":    return "Kiro CLI"
    case "kiro-ide":    return "Kiro IDE"
    case "daemon":      return "Daemon"
    case .some(let t):  return t.replacingOccurrences(of: "-", with: " ").capitalized
    case nil:           return "Agent"
    }
}

/// Shorten a model id to a compact user-facing name.
/// e.g., "openrouter/anthropic/claude-opus-4-6-20261001" -> "opus-4-6",
/// "openai/gpt-5.1-codex-max" -> "5.1-codex-max".
///
/// Compiled once: this runs per session row per render, and
/// `String.range(of: .regularExpression)` recompiles the pattern every call.
private let displayModelDateSuffixRegex = try! NSRegularExpression(pattern: #"-\d{8}$"#)

func displayShortModelName(_ name: String, maxLength: Int? = nil) -> String {
    var s = name.trimmingCharacters(in: .whitespacesAndNewlines)
    for prefix in ["openrouter:", "api:"] {
        if s.hasPrefix(prefix) { s = String(s.dropFirst(prefix.count)) }
    }
    if let last = s.split(separator: "/").last {
        s = String(last)
    }
    for prefix in ["claude-", "gpt-", "o1-", "o3-"] {
        if s.hasPrefix(prefix) { s = String(s.dropFirst(prefix.count)) }
    }
    if let match = displayModelDateSuffixRegex.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
       let range = Range(match.range, in: s) {
        s = String(s[s.startIndex..<range.lowerBound])
    }
    if let maxLength {
        s = displayTruncatedMiddle(s, maxLength: maxLength)
    }
    return s
}

private func displayTruncatedMiddle(_ text: String, maxLength: Int) -> String {
    guard maxLength > 1, text.count > maxLength else { return text }
    let marker = "…"
    let visible = maxLength - marker.count
    guard visible > 1 else { return String(text.prefix(maxLength)) }
    let headCount = max(1, Int((Double(visible) * 0.62).rounded()))
    let tailCount = visible - headCount
    return String(text.prefix(headCount)) + marker + String(text.suffix(tailCount))
}

/// Convert an ISO 8601 timestamp into a compact relative-time string
/// suitable for inline badges ("<1m", "12m", "3h", "2d").
func displayRelativeTime(_ iso: String?) -> String? {
    guard let iso, !iso.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = fractional.date(from: iso)
            ?? ISO8601DateFormatter().date(from: iso) else { return nil }
    let seconds = Int(Date().timeIntervalSince(date))
    if seconds < 60 { return "<1m" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    return "\(hours / 24)d"
}
