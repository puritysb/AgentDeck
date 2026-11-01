#if os(macOS)
import Foundation

struct CalendarEvent: Codable, Sendable, Equatable {
    var title: String
    var startHm: String?
    var endHm: String?
    var wire: [String: Any] {
        var out: [String: Any] = ["title": title]
        if let startHm { out["startHm"] = startHm }; if let endHm { out["endHm"] = endHm }
        return out
    }
}
/// Swift mirror of calendar-ics.ts. Only parsed memory data; never a disk cache.
enum CalendarICS {
    typealias P = CalendarPolicy
    enum Failure: Error { case invalid, limit }
    struct Instant: Sendable { var civil: [Int]; var zone: String?; var dateOnly: Bool }
    struct Event: Sendable {
        var uid: String; var summary: String; var start: Instant; var end: Instant?
        var rule: [String: String]?; var exclusions: [Instant]; var recurrence: Instant?; var cancelled: Bool
    }
    private struct Property { var name: String; var value: String; var zone: String? }
    private static func calendar(_ zone: String = "UTC") throws -> Calendar {
        guard let tz = TimeZone(identifier: zone) else { throw Failure.invalid }
        var c = Calendar(identifier: .gregorian); c.timeZone = tz; return c
    }
    private static func utc(_ c: [Int]) -> Double {
        let date = try! calendar().date(from: DateComponents(year: c[0], month: c[1], day: c[2], hour: c[3], minute: c[4], second: c[5]))!
        return date.timeIntervalSince1970 * 1000
    }
    private static func parts(_ ms: Double, _ zone: String = "UTC") throws -> [Int] {
        let p = try calendar(zone).dateComponents([.year,.month,.day,.hour,.minute,.second], from: Date(timeIntervalSince1970: ms / 1000))
        guard let y = p.year, let m = p.month, let d = p.day, let h = p.hour, let min = p.minute, let s = p.second else { throw Failure.invalid }
        return [y,m,d,h,min,s]
    }
    private static func day(_ c: [Int]) -> Double { utc(Array(c.prefix(3)) + [0,0,0]) }
    private static func date(_ c: [Int]) -> String { String(format: "%04d%02d%02d", c[0],c[1],c[2]) }
    private static func hm(_ c: [Int]) -> String { String(format: "%02d:%02d", c[3],c[4]) }
    private static func groups(_ value: String, _ pattern: String) -> [String?]? {
        guard let re = try? NSRegularExpression(pattern: pattern), let m = re.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) else { return nil }
        return (1..<m.numberOfRanges).map { Range(m.range(at: $0), in: value).map { String(value[$0]) } }
    }
    private static func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression)?.upperBound == value.endIndex }
    private static func instant(_ value: String, _ zone: String? = nil) -> Instant? {
        guard let m = groups(value, #"^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$"#), !(zone != nil && (m[6] != nil || m[3] == nil || !matches(zone!, #"^(UTC|GMT|[A-Za-z_+-]+(?:/[A-Za-z0-9_+-]+)+)$"#))) else { return nil }
        let c = m.prefix(6).map { Int($0 ?? "0") ?? -1 }
        guard c[0] >= P.minYear, c[0] <= P.maxYear, c[1] >= 1, c[1] <= 12, c[2] >= 1, c[2] <= 31,
              c[3] >= 0, c[3] < 24, c[4] >= 0, c[4] < 60, c[5] >= 0, c[5] < 60,
              (try? parts(utc(c))) == c, zone == nil || TimeZone(identifier: zone!) != nil else { return nil }
        return .init(civil: c, zone: m[6] != nil ? "UTC" : zone, dateOnly: m[3] == nil)
    }
    private static func resolve(_ t: Instant, _ display: String, recurrence: Bool = false) throws -> Double? {
        guard let zone = TimeZone(identifier: t.zone ?? display) else { throw Failure.invalid }
        let wall = utc(t.civil)
        let offsets = Set(P.offsetSamplesHours.map { Double(zone.secondsFromGMT(for: Date(timeIntervalSince1970: wall / 1000 + Double($0 * 3600))) * 1000) })
        var candidates: [Double] = []
        for offset in offsets where try parts(wall - offset, zone.identifier) == t.civil { candidates.append(wall - offset) }
        return candidates.min() ?? (recurrence ? nil : wall - offsets.min()!)
    }
    private static func key(_ t: Instant, _ zone: String) throws -> String { t.dateOnly ? "D" + date(t.civil) : "T" + String(format: "%.0f", try resolve(t, zone)!) }
    private static func decodeText(_ value: String) -> String {
        var out = "", escaped = false
        for scalar in value.unicodeScalars {
            let c = Character(scalar)
            if escaped { out += c == "n" || c == "N" ? " " : (c == "," || c == ";" || c == "\\" ? String(c) : "\\" + String(c)); escaped = false }
            else if c == "\\" { escaped = true } else { out.append(c) }
        }
        if escaped { out += "\\" }; return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func parse(_ text: String, namespace: String = "") throws -> [Event] {
        guard text.utf8.count <= P.maxBodyBytes else { throw Failure.limit }
        var lines: [String] = []
        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: CharacterSet(charactersIn: "\u{FEFF}")).components(separatedBy: "\n") {
            if (raw.hasPrefix(" ") || raw.hasPrefix("\t")), !lines.isEmpty { lines[lines.count - 1] += raw.dropFirst() }
            else if !raw.isEmpty { lines.append(raw) }
            if let last = lines.last, last.utf8.count > P.maxLineBytes { throw Failure.limit }
        }
        guard lines.first == "BEGIN:VCALENDAR", lines.last == "END:VCALENDAR" else { throw Failure.invalid }
        var out: [Event] = [], props: [Property]?, depth = 0
        for line in lines {
            if line == "BEGIN:VEVENT" { guard props == nil else { throw Failure.invalid }; props = []; depth = 1; continue }
            guard props != nil else { continue }
            if line.hasPrefix("BEGIN:") { depth += 1; continue }
            if line.hasPrefix("END:"), line != "END:VEVENT" { depth -= 1; continue }
            if line == "END:VEVENT" {
                if depth == 1, let event = event(props!, namespace: namespace) { out.append(event); if out.count > P.maxEvents { throw Failure.limit } }
                props = nil; continue
            }
            guard depth == 1, let colon = line.firstIndex(of: ":") else { continue }
            let lhs = line[..<colon].components(separatedBy: ";")
            let zone = lhs.dropFirst().first { $0.hasPrefix("TZID=") }.map { String($0.dropFirst(5)).trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
            if lhs.contains(where: { $0.hasPrefix("RANGE=") }) { props?.append(.init(name: "UNSUPPORTED", value: "", zone: nil)) }
            props?.append(.init(name: lhs[0].uppercased(), value: String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespacesAndNewlines), zone: zone))
        }
        guard props == nil else { throw Failure.invalid }; return out
    }
    private static func event(_ props: [Property], namespace: String) -> Event? {
        func get(_ name: String) -> [Property] { props.filter { $0.name == name } }
        func one(_ name: String) -> Property? { let rows = get(name); return rows.count == 1 ? rows[0] : nil }
        func stamp(_ name: String) -> Instant? { one(name).flatMap { instant($0.value, $0.zone) } }
        let recurrence = stamp("RECURRENCE-ID")
        guard let start = stamp("DTSTART") ?? recurrence else { return nil }
        let summary = decodeText(one("SUMMARY")?.value ?? ""), cancelled = one("STATUS")?.value == "CANCELLED"
        var rule: [String: String]?
        if let raw = one("RRULE")?.value {
            var r: [String: String] = [:]
            for pair in raw.components(separatedBy: ";") { let kv = pair.components(separatedBy: "="); guard kv.count == 2, !kv[1].isEmpty, r[kv[0]] == nil else { return nil }; r[kv[0]] = kv[1] }
            guard !(r["FREQ"] == "WEEKLY" && r["BYMONTHDAY"] != nil), !(r["FREQ"] == "YEARLY" && (r["BYDAY"] != nil || r["BYMONTHDAY"] != nil)), r.keys.allSatisfy({ P.ruleKeys.contains($0) }), P.frequencies.contains(r["FREQ"] ?? ""), r["WKST"] == nil || r["WKST"] == "MO",
                  ["INTERVAL", "COUNT"].allSatisfy({ r[$0] == nil || matches(r[$0]!, #"^[1-9]\d{0,5}$"#) }),
                  r["COUNT"] == nil || r["UNTIL"] == nil, r["UNTIL"] == nil || instant(r["UNTIL"]!) != nil,
                  r["BYDAY"] == nil || r["BYDAY"]!.components(separatedBy: ",").allSatisfy({ matches($0, #"^([+-]?[1-5])?(SU|MO|TU|WE|TH|FR|SA)$"#) }),
                  !["DAILY","WEEKLY"].contains(r["FREQ"] ?? "") || r["BYDAY"] == nil || r["BYDAY"]!.components(separatedBy: ",").allSatisfy({ matches($0, #"^[A-Z]{2}$"#) }),
                  r["BYMONTHDAY"] == nil || r["BYMONTHDAY"]!.components(separatedBy: ",").allSatisfy({ matches($0, #"^-?([1-9]|[12]\d|3[01])$"#) }) else { return nil }
            rule = r
        }
        let end = stamp("DTEND"); var exclusions: [Instant] = []
        for p in get("EXDATE") { for raw in p.value.components(separatedBy: ",") { guard let t = instant(raw, p.zone) else { return nil }; exclusions.append(t) } }
        guard ["UID","SUMMARY","DTSTART","DTEND","RRULE","RECURRENCE-ID","STATUS"].allSatisfy({ get($0).count <= 1 }),
              get("DTSTART").isEmpty || stamp("DTSTART") != nil, recurrence == nil || !(one("UID")?.value.isEmpty ?? true), (!summary.isEmpty || cancelled), get("RDATE").isEmpty, get("DURATION").isEmpty, get("EXRULE").isEmpty,
              get("UNSUPPORTED").isEmpty, get("DTEND").isEmpty || end != nil, get("RECURRENCE-ID").isEmpty || recurrence != nil else { return nil }
        return .init(uid: namespace + "\0" + (one("UID")?.value ?? ""), summary: summary, start: start, end: end, rule: rule, exclusions: exclusions, recurrence: recurrence, cancelled: cancelled)
    }
    private static func weekday(_ c: [Int]) -> Int { (try! calendar()).component(.weekday, from: Date(timeIntervalSince1970: day(c) / 1000)) - 1 }
    private static func ruleMatches(_ e: Event, _ c: [Int], _ offset: Int) -> Bool {
        let r = e.rule!, start = e.start.civil, interval = Int(r["INTERVAL"] ?? "1")!, wd = weekday(c)
        var next = Array(c.prefix(3)) + [0,0,0]; next[1] += 1; next[2] = 0
        let monthDays = (try! parts(utc(next)))[2]
        if let byday = r["BYDAY"], !byday.components(separatedBy: ",").contains(where: { v in
            guard P.weekdays[wd] == String(v.suffix(2)) else { return false }
            let ord = Int(v.dropLast(2)) ?? 0
            return ord == 0 || (ord > 0 ? (c[2] - 1) / 7 + 1 == ord : -((monthDays - c[2]) / 7 + 1) == ord)
        }) { return false }
        if let bymonthday = r["BYMONTHDAY"], !bymonthday.components(separatedBy: ",").contains(where: { v in let n = Int(v)!; return c[2] == (n > 0 ? n : monthDays + n + 1) }) { return false }
        switch r["FREQ"] {
        case "DAILY": return offset % interval == 0
        case "WEEKLY": return ((offset + (weekday(start) + 6) % 7) / 7) % interval == 0 && (r["BYDAY"] != nil || wd == weekday(start))
        case "MONTHLY": return ((c[0] - start[0]) * 12 + c[1] - start[1]) % interval == 0 && (r["BYDAY"] != nil || r["BYMONTHDAY"] != nil || c[2] == start[2])
        case "YEARLY": return (c[0] - start[0]) % interval == 0 && c[1] == start[1] && (r["BYDAY"] != nil || r["BYMONTHDAY"] != nil || c[2] == start[2])
        default: return false
        }
    }
    private struct Budget { var walks = 0; var occurrences = 0 }
    private static func occurrences(_ e: Event, _ lastDay: Double, _ zone: String, _ budget: inout Budget) throws -> [Instant] {
        guard let rule = e.rule else { return [e.start] }
        let startDay = day(e.start.civil), span = Int(floor((lastDay - startDay) / Double(P.dayMs)))
        guard span >= 0, span <= P.maxWalkDays else { return [] }
        let count = Int(rule["COUNT"] ?? "") ?? Int.max
        let until = rule["UNTIL"].flatMap { instant($0, e.start.zone != nil && !$0.hasSuffix("Z") ? e.start.zone : nil) }
        var seen = 0, out: [Instant] = []
        for i in 0...span {
            budget.walks += 1; guard budget.walks <= P.maxWalkSteps else { throw Failure.limit }
            let civil = Array(try parts(startDay + Double(i * P.dayMs)).prefix(3)) + Array(e.start.civil.suffix(3))
            guard ruleMatches(e, civil, i) else { continue }
            let t = Instant(civil: civil, zone: e.start.zone, dateOnly: e.start.dateOnly)
            guard let at = try resolve(t, zone, recurrence: i != 0) else { continue }
            if let until {
                if until.dateOnly ? date(civil) > date(until.civil) : at > (try resolve(until, zone)!) { break }
            }
            seen += 1; if seen > count { break }
            budget.occurrences += 1; guard budget.occurrences <= P.maxOccurrences else { throw Failure.limit }
            out.append(t)
        }
        return out
    }
    static func build(_ events: [Event], nowMs: Double, zone: String = TimeZone.current.identifier) throws -> [CalendarEvent] {
        let c = try parts(nowMs, zone), today = Instant(civil: Array(c.prefix(3)) + [0,0,0], zone: zone, dateOnly: false)
        let tomorrow = Instant(civil: try parts(day(c) + Double(P.dayMs)), zone: zone, dateOnly: false)
        let lo = try resolve(today, zone)!, hi = try resolve(tomorrow, zone)!, clock = floor(nowMs / Double(P.minuteMs)) * Double(P.minuteMs)
        let overrides = try Set(events.compactMap { e in try e.recurrence.map { e.uid + "@" + (try key($0, zone)) } })
        var picked: [(Double, Int, CalendarEvent)] = [], budget = Budget()
        for e in events where !e.cancelled {
            let first = try resolve(e.start, zone)!, end = try e.end.flatMap { try resolve($0, zone) }
            if let last = e.end, last.dateOnly != e.start.dateOnly || end! <= first { continue }
            let days = e.start.dateOnly ? max(1, e.end.map { (day($0.civil) - day(e.start.civil)) / Double(P.dayMs) } ?? 1) : 0
            let duration = end.map { $0 - first } ?? 0
            let targetDay = day(try parts(hi - 1, e.start.zone ?? zone)) + Double(P.dayMs)
            for t in try occurrences(e, targetDay, zone, &budget) {
                if e.recurrence == nil {
                    if overrides.contains(e.uid + "@" + (try key(t, zone))) { continue }
                    if try e.exclusions.contains(where: { try key($0, zone) == key(t, zone) }) { continue }
                }
                guard let start = try resolve(t, zone, recurrence: e.rule != nil && t.civil != e.start.civil) else { continue }
                let finish = try e.start.dateOnly ? resolve(Instant(civil: parts(day(t.civil) + days * Double(P.dayMs)), zone: t.zone, dateOnly: true), zone)! : start + duration
                if start >= hi || (e.start.dateOnly ? finish <= lo : e.end != nil ? finish <= max(lo, clock) : finish < max(lo, clock)) { continue }
                let startC = try parts(start, zone), endC = try parts(finish, zone)
                let allDay = e.start.dateOnly || date(startC) != date(endC)
                var title = ""
                for scalar in e.summary.unicodeScalars { if title.utf8.count + scalar.utf8.count > P.titleBytes { break }; title.unicodeScalars.append(scalar) }
                picked.append((allDay ? -.infinity : start, picked.count, .init(title: title, startHm: allDay ? nil : hm(startC), endHm: !allDay && e.end != nil ? hm(endC) : nil)))
            }
        }
        picked.sort { $0.0 == $1.0 ? $0.1 < $1.1 : $0.0 < $1.0 }
        var seen = Set<String>()
        var out: [CalendarEvent] = []
        for (_, _, event) in picked {
            if seen.insert((event.startHm ?? "") + "|" + event.title).inserted { out.append(event) }
            if out.count >= P.wireMaxEvents { break }
        }
        return out
    }
}
#endif
