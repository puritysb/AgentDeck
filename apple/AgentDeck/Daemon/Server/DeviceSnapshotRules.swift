import Foundation
import CoreFoundation

/// Policy and projection mirror shared/src/device-snapshot.ts; native replay gates both.
enum DeviceSnapshotRules {
    static let version = 1
    static let maxBytes = 32768
    static let headerBytes = 8192
    static let maxRows = 64
    static let maxString = 256
    static let timeoutMs = 5000
    static let maxConnections = 16
    static let sessionFields = ["id", "agentType", "projectName", "displayName", "state", "alive"]
    static let usageFields = ["fiveHourPercent", "sevenDayPercent", "usageStale"]
    static let windowFields = ["usedPercent", "windowMinutes", "resetsAt", "stale", "regularResetsAt", "available"]
    static let creditFields = ["hasCredits", "unlimited", "balance"]
    static func pick(_ input: Any?, _ fields: [String]) -> [String: Any] {
        guard let input = input as? [String: Any] else { return [:] }
        var result: [String: Any] = [:]
        for key in fields {
            if let string = input[key] as? String, string.utf8.count <= maxString { result[key] = string }
            else if let number = input[key] as? NSNumber, number.doubleValue.isFinite { result[key] = number }
        }
        return result
    }
    static func build(scopes: [String], sessions: Any, usage: Any) -> [String: Any] {
        var events: [[String: Any]] = [["type": "surface_welcome", "protocol": 1, "profile": "display-only/v1", "capabilities": scopes]]
        if scopes.contains("sessions.read") {
            let rows = ((sessions as? [Any]) ?? []).prefix(maxRows).map { pick($0, sessionFields) }.filter {
                guard $0["id"] is String, $0["state"] is String, let alive = $0["alive"] as? NSNumber else { return false }
                return CFGetTypeID(alive) == CFBooleanGetTypeID()
            }
            events.append(["type": "sessions_list", "sessions": rows])
        }
        if scopes.contains("usage.read") {
            var event = pick(usage, usageFields)
            event["type"] = "usage_update"; event["claudeUsageSnapshot"] = true
            if let usage = usage as? [String: Any] {
                event["scopedLimits"] = ((usage["scopedLimits"] as? [Any]) ?? []).prefix(maxRows).map { pick($0, ["label", "percent"]) }
                if let input = usage["codexRateLimits"] as? [String: Any] {
                    var codex = pick(input, ["capturedAt"])
                    for name in ["primary", "secondary", "lunaReserve"] where input[name] is [String: Any] { codex[name] = pick(input[name], windowFields) }
                    if input["credits"] is [String: Any] { codex["credits"] = pick(input["credits"], creditFields) }
                    event["codexRateLimits"] = codex
                } else { event["codexRateLimits"] = NSNull() }
            }
            events.append(event)
        }
        return ["version": version, "events": events]
    }
}
