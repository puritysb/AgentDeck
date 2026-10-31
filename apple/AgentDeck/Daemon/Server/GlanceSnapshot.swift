#if os(macOS)
import Foundation

/// Projection of consented daemon contexts. Missing context is never synthesized.
enum GlanceSnapshot {
    static func build(sessions: [[String: Any]], usage: [String: Any]?, weather: [String: Any]?, events: [[String: Any]]? = nil) -> [String: Any] {
        var result: [String: Any] = [:]
        if let events, !events.isEmpty { result["events"] = events }
        if let weather { result["weather"] = weather }
        let rows = usageRows(usage ?? [:])
        if !rows.isEmpty { result["usage"] = rows }
        let lines = wrapup(sessions)
        if !lines.isEmpty { result["wrapup"] = lines }
        return result
    }
    private static func percent(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return min(100, max(0, floor(number.doubleValue + 0.5)))
    }
    private static func hm(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let iso = ISO8601DateFormatter()
        var date = iso.date(from: string)
        if date == nil { iso.formatOptions.insert(.withFractionalSeconds); date = iso.date(from: string) }
        guard let date else { return nil }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = .current; f.dateFormat = "HH:mm"
        return f.string(from: date)
    }
    static func usageRows(_ usage: [String: Any]) -> [[String: Any]] {
        var rows: [[String: Any]] = []
        func append(_ provider: String, _ label: String, _ primary: Any?, _ secondary: Any?, _ reset: Any?, _ primaryStale: Bool, _ secondaryStale: Bool) {
            let p = percent(primary), s = percent(secondary)
            guard p != nil || s != nil else { return }
            var row: [String: Any] = ["provider":provider, "label":label, "stale":primaryStale && (s == nil || secondaryStale)]
            if let p { row["primaryPercent"] = p }; if let s { row["secondaryPercent"] = s }
            if let reset = hm(reset) { row["primaryResetHm"] = reset }
            rows.append(row)
        }
        append("claude", "Claude", usage["fiveHourPercent"], usage["sevenDayPercent"], usage["fiveHourResetsAt"], usage["usageStale"] as? Bool == true, true)
        for (provider, label, key) in [("codex","Codex","codexRateLimits"),("zai","z.ai","zaiRateLimits")] {
            let limits = usage[key] as? [String: Any] ?? [:]
            let p = limits["primary"] as? [String: Any] ?? [:], s = limits["secondary"] as? [String: Any] ?? [:]
            append(provider, label, p["usedPercent"], s["usedPercent"], p["resetsAt"], p["stale"] as? Bool == true, s["stale"] as? Bool == true)
        }
        return Array(rows.prefix(GlancePolicy.GLANCE_MAX_USAGE_ROWS))
    }
    static func wrapup(_ sessions: [[String: Any]]) -> [String] {
        func rank(_ s: [String: Any]) -> Int {
            if s["requestId"] != nil { return 0 }
            if (s["state"] as? String)?.hasPrefix("awaiting") == true { return 1 }
            return s["state"] as? String == "processing" ? 2 : 3
        }
        let ordered = sessions.enumerated().sorted { a, b in
            let ar = rank(a.element), br = rank(b.element)
            return ar == br ? a.offset < b.offset : ar < br
        }.map(\.element)
        let limit = GlancePolicy.GLANCE_MAX_WRAPUP_LINES
        let overflow = ordered.count > limit
        let take = overflow ? limit - 1 : ordered.count
        var lines = ordered.prefix(take).map { s -> String in
            var fallback = "idle"
            if s["requestId"] != nil { fallback = "needs approval" }
            else if rank(s) == 1 { fallback = "needs you" }
            else if s["state"] as? String == "processing" { fallback = "working" }
            else if s["state"] as? String == "error" { fallback = "error" }
            let what = [s["activity"] as? String, s["currentTask"] as? String].compactMap { $0.map { GlanceFrame.trimWhitespace($0) } }.first { !$0.isEmpty } ?? fallback
            let text = "\(s["projectName"] as? String ?? "undefined") · \(what)"
            guard text.utf8.count > GlancePolicy.GLANCE_LINE_MAX_BYTES else { return text }
            var out = "", bytes = 0
            for scalar in text.unicodeScalars {
                let next = String(scalar)
                if bytes + next.utf8.count > GlancePolicy.GLANCE_LINE_MAX_BYTES - 1 { break }
                out += next; bytes += next.utf8.count
            }
            return GlanceFrame.trimWhitespace(out, leading: false) + "."
        }
        if overflow { lines.append("+\(ordered.count - take) more sessions") }
        return lines
    }
}
#endif
