#if os(macOS)
import Foundation

struct AntigravityTurnIdentity: Codable, Sendable, Equatable {
    let id: String
    let stepIndex: Int
    let startedAtMs: Int64
}
struct AntigravityObservation: Codable, Sendable, Equatable {
    let conversationId: String
    var status = "unknown"
    var reason = "unreadable_records"
    var state: String?
    var goal: String?
    var model: String?
    var currentTask: String?
    var currentTurnId: String?
    var startedAtMs: Int64?
    var updatedAtMs: Int64?
    var modifiedAtMs: Int64?
    var latestStepIndex: Int?
    var turns: [AntigravityTurnIdentity] = []
    var startedAtISO: String? {
        guard let startedAtMs else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date(timeIntervalSince1970: Double(startedAtMs) / 1000))
    }
    func isAdmissible(nowMs: Int64) -> Bool {
        guard status == "known", let state, let updatedAtMs, let modifiedAtMs else { return false }
        let stamp = min(updatedAtMs, modifiedAtMs)
        let ttl = state == "processing" ? AntigravityPolicy.activeWindowMs : AntigravityPolicy.rosterWindowMs
        return stamp <= nowMs + Int64(AntigravityPolicy.futureSkewMs) && nowMs - stamp <= ttl
    }
}
struct AntigravityScan: Codable, Sendable, Equatable {
    var status = "unknown"
    var reason = "unreadable_source"
    var observations: [AntigravityObservation] = []
    var projects: [String: String] = [:]
    var grantRevision: Int?

    var known: [AntigravityObservation] { status == "known" ? observations.filter { $0.status == "known" } : [] }
}

enum AntigravityTranscript {
    private static func trim(_ text: String) -> String {
        text.replacingOccurrences(of: "^" + AntigravityPolicy.whitespacePattern + "+|" + AntigravityPolicy.whitespacePattern + "+$", with: "", options: .regularExpression)
    }
    private static func match(_ pattern: String, _ text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let result = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              result.numberOfRanges > 1, let range = Range(result.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }
    private static func index(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991,
              number.doubleValue.rounded(.towardZero) == number.doubleValue else { return nil }
        return number.intValue
    }
    private final class Timestamps {
        let whole = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        var calendar = Calendar(identifier: .gregorian)
        init() {
            whole.formatOptions = [.withInternetDateTime]
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        }
        func read(_ value: Any?) -> Int64? {
            guard let text = value as? String,
                  text.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$"#, options: .regularExpression) != nil,
                  let date = (text.contains(".") ? fractional : whole).date(from: text), date.timeIntervalSince1970 > 0 else { return nil }
            let digits = Array(text.utf8)
            func number(_ start: Int, _ end: Int) -> Int { Int(String(decoding: digits[start..<end], as: UTF8.self))! }
            let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
            guard c.year == number(0, 4), c.month == number(5, 7), c.day == number(8, 10), c.hour == number(11, 13), c.minute == number(14, 16), c.second == number(17, 19) else { return nil }
            return Int64((date.timeIntervalSince1970 * 1000).rounded())
        }
    }
    static func validID(_ id: String) -> Bool {
        id.range(of: AntigravityPolicy.conversationPattern, options: .regularExpression) != nil
    }
    static func observe(id: String, raw: String, modifiedAtMs: Int64, nowMs: Int64) -> AntigravityObservation {
        var out = AntigravityObservation(conversationId: id, modifiedAtMs: modifiedAtMs)
        guard validID(id) else { out.reason = "invalid_identity"; return out }
        guard modifiedAtMs > 0, nowMs > 0, modifiedAtMs <= nowMs + Int64(AntigravityPolicy.futureSkewMs) else { out.reason = "invalid_time"; return out }
        let lines = raw.components(separatedBy: "\n").map(trim).filter { !$0.isEmpty }
        var records: [[String: Any]] = []
        var gapAt: Int?
        for (position, line) in lines.enumerated() {
            if line == AntigravityPolicy.gapMarker { gapAt = records.count; continue }
            if let data = line.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                records.append(value)
            } else if position == lines.count - 1 { out.reason = "incomplete_tail"; return out }
        }
        let timestamps = Timestamps()
        guard let last = records.last, index(last["step_index"]) != nil else { return out }
        var byStep: [Int: [String: Any]] = [:]
        for record in records {
            if let step = index(record["step_index"]) { byStep[step] = record }
        }
        let ordered = byStep.keys.sorted()
        guard let lastIndex = ordered.last, let latest = byStep[lastIndex],
              let updated = timestamps.read(latest["created_at"]), updated <= nowMs + Int64(AntigravityPolicy.futureSkewMs) else {
            out.reason = "invalid_time"; return out
        }
        let allTurns = ordered.compactMap { step -> AntigravityTurnIdentity? in
            guard let record = byStep[step], record["type"] as? String == "USER_INPUT", record["source"] as? String == "USER_EXPLICIT",
                  let started = timestamps.read(record["created_at"]), started <= nowMs + Int64(AntigravityPolicy.futureSkewMs) else { return nil }
            return AntigravityTurnIdentity(id: "\(id):step:\(step):\(started)", stepIndex: step, startedAtMs: started)
        }
        out.turns = Array(allTurns.suffix(AntigravityPolicy.maxTurns))
        guard let firstTurn = allTurns.first, let lastTurn = allTurns.last else { out.reason = "missing_turn_identity"; return out }
        guard let lastUser = ordered.compactMap({ byStep[$0] }).last(where: { $0["type"] as? String == "USER_INPUT" }),
              lastUser["source"] as? String == "USER_EXPLICIT", timestamps.read(lastUser["created_at"]) != nil else { out.turns = []; out.reason = "missing_turn_identity"; return out }
        guard lastTurn.startedAtMs <= updated else { out.turns = []; out.reason = "inconsistent_time"; return out }
        if let gapAt, !records.dropFirst(gapAt).contains(where: { $0["type"] as? String == "USER_INPUT" && $0["source"] as? String == "USER_EXPLICIT" && timestamps.read($0["created_at"]) != nil }) {
            out.turns = []; out.reason = "missing_turn_identity"; return out
        }
        out.currentTurnId = lastTurn.id; out.startedAtMs = firstTurn.startedAtMs; out.updatedAtMs = updated; out.latestStepIndex = lastIndex
        guard nowMs - modifiedAtMs <= AntigravityPolicy.rosterWindowMs, nowMs - updated <= AntigravityPolicy.rosterWindowMs else {
            out.status = "stale"; out.reason = "history"; return out
        }
        let status = latest["status"] as? String
        guard status == "RUNNING" || status == "DONE" else { out.reason = "unknown_step_status"; return out }
        if status == "RUNNING", nowMs - updated > AntigravityPolicy.activeWindowMs || nowMs - modifiedAtMs > AntigravityPolicy.activeWindowMs {
            out.status = "stale"; out.reason = "unconfirmed_work"; return out
        }
        // Shared with Node's legacy summary: latest duplicate step wins, but
        // goal/model/tool metadata follow original append order.
        for (position, record) in records.enumerated() {
            if record["type"] as? String == "USER_INPUT", let content = record["content"] as? String {
                if out.goal == nil, let request = match("<USER_REQUEST>" + AntigravityPolicy.whitespacePattern + "*([\\s\\S]*?)" + AntigravityPolicy.whitespacePattern + "*</USER_REQUEST>", content) {
                    let compact = trim(request.replacingOccurrences(of: AntigravityPolicy.whitespacePattern + "+", with: " ", options: .regularExpression))
                    if !compact.isEmpty { out.goal = String(String.UnicodeScalarView(compact.unicodeScalars.prefix(AntigravityPolicy.labelCodePoints))) }
                }
                let modelPattern = "Model Selection`?" + AntigravityPolicy.whitespacePattern + "+from" + AntigravityPolicy.whitespacePattern + "+.*?" + AntigravityPolicy.whitespacePattern + "+to" + AntigravityPolicy.whitespacePattern + "+(.+?)\\.(?:" + AntigravityPolicy.whitespacePattern + "|$)"
                if (gapAt == nil || position >= gapAt!), let model = match(modelPattern, content).map(trim), !model.isEmpty { out.model = String(String.UnicodeScalarView(model.unicodeScalars.prefix(AntigravityPolicy.labelCodePoints))) }
            }
            if (gapAt == nil || position >= gapAt!), let type = record["type"] as? String, AntigravityPolicy.toolTypes.contains(type) {
                let tools = record["tool_calls"] as? [[String: Any]]
                let name = tools?.first?["name"] as? String
                out.currentTask = name?.isEmpty == false ? String(String.UnicodeScalarView(name!.unicodeScalars.prefix(AntigravityPolicy.labelCodePoints))) : type.lowercased()
            }
        }
        out.status = "known"; out.reason = "step_evidence"; out.state = status == "RUNNING" ? "processing" : "idle"
        return out
    }
}
#endif
