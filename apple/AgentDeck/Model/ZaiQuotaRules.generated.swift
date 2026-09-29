// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/zai-quota.ts (ZAI_*_WINDOW_MINUTES, ZAI_PLAN_DISPLAY_NAMES,
// classifyZaiLimitItem, zaiQuotaFromLimits, zaiKeyLooksPayAsYouGo)
// Regenerate: pnpm generate-zai-quota-rules (drift gated by shared/src/__tests__/zai-quota.test.ts)

import Foundation

/// Z.ai GLM Coding Plan quota rules — the Swift mirror of the SSOT.
///
/// The monitor endpoint (`GET /api/monitor/usage/quota/limit`) is undocumented;
/// these rules read its `limits[]` items into the wire's primary/secondary slot
/// grammar. Absent fields are unknown, never fabricated: a missing
/// `nextResetTime` produces no reset instant, and an item with no derivable
/// percent is skipped entirely rather than guessed.
enum ZaiQuotaRules {
    /// 5-hour rolling credits window (`TOKENS_LIMIT`, or `CREDIT_LIMIT unit=3`).
    static let sessionWindowMinutes: Int = 300
    /// 7-day credits window, credit schema only (`CREDIT_LIMIT unit=6`).
    static let weeklyWindowMinutes: Int = 10080
    /// Monthly MCP/tools window, standard schema (`TIME_LIMIT` ≈ 30d).
    static let mcpWindowMinutes: Int = 43200

    static let planDisplayNames: [String: String] = [
        "lite": "Lite",
        "pro": "Pro",
        "max": "Max",
    ]

    /// Display name for a raw plan `level`. An unrecognised tier is
    /// capitalised, never dropped — same polarity as the Codex plan names.
    static func formatPlanName(_ planType: String?) -> String? {
        guard let raw = planType?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        if let known = planDisplayNames[raw.lowercased()] { return known }
        return raw.prefix(1).uppercased() + raw.dropFirst()
    }

    /// A pay-as-you-go key is not a coding plan: the monitor endpoint answers,
    /// but there are no subscription windows to show. Detected by key shape,
    /// the marker community parsers use.
    static func keyLooksPayAsYouGo(_ apiKey: String?) -> Bool {
        guard let raw = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !raw.isEmpty else { return false }
        return raw.hasPrefix("sk-pay") || raw.contains("payg")
    }

    /// Which kind of quota window a monitor `limits[]` item describes.
    enum LimitKind {
        case session, weekly, mcp
    }

    /// One classified monitor item — kind + the numbers a window can carry.
    struct WindowReading {
        let kind: LimitKind
        /// Percent already CONSUMED, 0–100, clamped.
        let usedPercent: Double
        /// Reset instant, epoch-ms, when the item carries one. nil is unknown.
        let resetsAtMs: Double?
    }

    /// A wire window (pre-ISO): minutes + percent + the raw epoch-ms reset.
    struct Window {
        let usedPercent: Int
        let windowMinutes: Int
        let resetsAtMs: Double?
        /// Which quantity this window meters — "mcp" (tool calls) vs "tokens"
        /// (credits). A surface must never present one as the other; the label
        /// follows the quantity ("MCP" vs "5h").
        let quantity: String

        /// ISO-8601 with milliseconds, byte-identical to the TS SSOT's
        /// `new Date(ms).toISOString()` — both suites replay the same vectors
        /// against this string.
        var resetsAtIso: String? {
            guard let resetsAtMs, resetsAtMs > 0 else { return nil }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.string(from: Date(timeIntervalSince1970: resetsAtMs / 1000))
        }
    }

    /// Wire windows + plan axes (the payload layer adds `capturedAt`).
    struct QuotaWindows {
        var primary: Window?
        var secondary: Window?
        var planType: String?
        var limitId: String?
    }

    /// Classify one monitor `limits[]` item, or nil when it carries no usable
    /// window. `type` is authoritative; `unit` corroborates on the credit
    /// schema (3 = hours×5 → session, 6 = weeks×1 → weekly).
    static func classifyLimitItem(_ item: Any?) -> WindowReading? {
        guard let o = item as? [String: Any] else { return nil }
        let type = (o["type"] as? String ?? "").trimmingCharacters(in: .whitespaces).uppercased()
        let unit = (o["unit"] as? NSNumber)?.doubleValue

        let kind: LimitKind?
        switch type {
        case "TOKENS_LIMIT": kind = .session
        case "TIME_LIMIT": kind = .mcp
        case "CREDIT_LIMIT":
            if unit == 3 { kind = .session }
            else if unit == 6 { kind = .weekly }
            else { kind = nil }
        default: kind = nil
        }
        guard let kind else { return nil }

        let number = { (key: String) -> Double? in
            if let n = o[key] as? NSNumber { return n.doubleValue }
            if let s = o[key] as? String, let v = Double(s) { return v }
            return nil
        }
        var usedPercent = number("percentage")
        if usedPercent == nil {
            // CREDIT_LIMIT items report capacity as `usage` when `total` is
            // absent — `currentValue` stays the consumed amount either way.
            guard let currentValue = number("currentValue"),
                  let capacity = number("total") ?? number("usage"), capacity > 0 else { return nil }
            usedPercent = (currentValue / capacity) * 100
        }
        guard var percent = usedPercent, percent >= 0 else { return nil }

        percent = min(100, percent)
        let resetsAtMs = number("nextResetTime")
        return WindowReading(
            kind: kind,
            usedPercent: percent,
            resetsAtMs: (resetsAtMs != nil && resetsAtMs! > 0) ? resetsAtMs : nil
        )
    }

    /// Map a monitor response body onto wire windows. Slot assignment is BY
    /// LENGTH (session → primary; the long window → secondary, weekly credits
    /// preferred over the monthly MCP quota when both are reported).
    static func quotaFromLimits(_ limits: Any?, level: String?) -> QuotaWindows {
        var out = QuotaWindows()
        let trimmedLevel = level?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedLevel.isEmpty { out.planType = trimmedLevel.lowercased() }

        guard let items = limits as? [Any], !items.isEmpty else { return out }

        var session: WindowReading?
        var weekly: WindowReading?
        var mcp: WindowReading?
        var sawCreditItem = false
        for item in items {
            if let o = item as? [String: Any], (o["type"] as? String) == "CREDIT_LIMIT" {
                sawCreditItem = true
            }
            guard let reading = classifyLimitItem(item) else { continue }
            switch reading.kind {
            case .session: session = session ?? reading
            case .weekly: weekly = weekly ?? reading
            case .mcp: mcp = mcp ?? reading
            }
        }
        // The family describes the windows this response was read from; an
        // empty item list read nothing, so it claims no family either.
        out.limitId = sawCreditItem ? "credit" : "standard"

        func toWindow(_ r: WindowReading, minutes: Int) -> Window {
            Window(
                usedPercent: Int(r.usedPercent.rounded()),
                windowMinutes: minutes,
                resetsAtMs: r.resetsAtMs,
                quantity: r.kind == .mcp ? "mcp" : "tokens"
            )
        }
        if let session { out.primary = toWindow(session, minutes: sessionWindowMinutes) }
        if let long = weekly ?? mcp {
            out.secondary = toWindow(long, minutes: long.kind == .weekly ? weeklyWindowMinutes : mcpWindowMinutes)
        }
        return out
    }
}
