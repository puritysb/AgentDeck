#if os(macOS)
import Foundation
import CoreFoundation

/// Native adaptive producer. Only aggregate counts and opaque content IDs cross
/// the persistence boundary. No feed text, session IDs or personal context does.
@DaemonActor
final class PocketAutonomy {
    private typealias P = PocketPolicy
    struct Arm: Codable, Sendable {
        var shown = 0.0, positive = 0.0, negative = 0.0, ignored = 0.0
        var lastShownAt: Double?
        var hourPositive = Array(repeating: 0.0, count: Int(P.hourBuckets))
    }
    struct Exposure: Codable, Sendable {
        var cardId: String, kind: String
        var shownAt: Double
        var hourBucket: Int
        var board: String?
    }
    struct Answer: Codable, Sendable { var choice: String; var at: Double }
    struct State: Codable, Sendable {
        var rev = Int(P.stateRev)
        var feedbackCount = 0.0
        var lastSurveyAt: Double?
        var arms: [String: Arm] = [:]
        var pending: [Exposure] = []
        var seen: [String: Double] = [:]
        var answered: [String: Answer] = [:]
    }
    private struct Candidate {
        var module: String, kind: String, key: String, actionClass: String
        var priority: Double
        var title: String, question: String, context: [String]
        var choices: [[String: String]] = []
        var cardId: String { "module:\(module):\(key)" }
    }
    private(set) var state = State()
    private let stateURL: URL?
    private let timeZone: TimeZone
    private let onError: ((String) -> Void)?
    private var persistTask: Task<Void, Never>?
    private var enabled = true
    private var maxCards = Int(P.defaultMaxCards)
    private var exploration = P.defaultExploration
    private static let kinds = Set(P.kinds)
    private static let feedback = [
        ["id": "useful", "label": "Useful", "intent": "affirm"],
        ["id": "more", "label": "More", "intent": "affirm"],
        ["id": "less", "label": "Less", "intent": "deny"],
    ]

    init(stateURL: URL? = nil, config: [String: Any] = [:], timeZone: TimeZone = .current,
         onError: ((String) -> Void)? = nil) {
        self.stateURL = stateURL; self.timeZone = timeZone; self.onError = onError
        if let stateURL, let data = try? Data(contentsOf: stateURL),
           let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            state = Self.normalize(raw)
        }
        configure(config)
    }

    func configure(_ config: [String: Any]) {
        // NSNumber(0) bridges to Bool(false), but JS `0 !== false` remains
        // enabled. Only an actual JSON boolean false is the opt-out.
        if let flag = config["enabled"] as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() {
            enabled = flag.boolValue
        } else { enabled = true }
        maxCards = Int(Self.number(config["maxCards"]).map { min(P.maxCards, max(P.minCards, floor($0 + 0.5))) } ?? P.defaultMaxCards)
        exploration = Self.number(config["exploration"]).map { min(P.maxExploration, max(0, $0)) } ?? P.defaultExploration
    }
    private static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
        return n.doubleValue
    }
    private static func count(_ value: Any?) -> Double { max(0, floor(number(value) ?? 0)) }
    private static func kind(_ cardId: String) -> String? {
        let parts = cardId.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 6, cardId.range(of: P.cardIDPattern, options: .regularExpression) != nil else { return nil }
        return parts[3]
    }
    private static func normalize(_ raw: [String: Any]) -> State {
        guard number(raw["rev"]) == P.stateRev else { return State() }
        var out = State()
        out.feedbackCount = count(raw["feedbackCount"])
        out.lastSurveyAt = number(raw["lastSurveyAt"])
        for (kind, rawArm) in raw["arms"] as? [String: Any] ?? [:] where kinds.contains(kind) {
            let value = rawArm as? [String: Any] ?? [:]
            var arm = Arm()
            arm.shown = count(value["shown"]); arm.positive = count(value["positive"])
            arm.negative = count(value["negative"]); arm.ignored = count(value["ignored"])
            arm.lastShownAt = number(value["lastShownAt"])
            let hours = value["hourPositive"] as? [Any] ?? []
            arm.hourPositive = (0..<Int(P.hourBuckets)).map { count($0 < hours.count ? hours[$0] : nil) }
            out.arms[kind] = arm
        }
        for rawExposure in raw["pending"] as? [Any] ?? [] {
            guard let value = rawExposure as? [String: Any] else { continue }
            guard let id = value["cardId"] as? String, let kind = kind(id), kind == value["kind"] as? String,
                  let at = number(value["shownAt"]) else { continue }
            let hour = min(P.hourBuckets - 1, max(0, floor(number(value["hourBucket"]) ?? 0)))
            let board = value["board"] as? String
            out.pending.append(Exposure(cardId: id, kind: kind, shownAt: at, hourBucket: Int(hour), board: board?.isEmpty == false ? board : nil))
        }
        out.pending = Array(out.pending.suffix(Int(P.pendingLimit)))
        for (id, value) in raw["seen"] as? [String: Any] ?? [:] {
            if kind(id) != nil, let at = number(value) { out.seen[id] = at }
        }
        let choices: Set<String> = ["useful", "more", "less", "work", "day", "surprise", "later"]
        for (id, rawAnswer) in raw["answered"] as? [String: Any] ?? [:] {
            guard let value = rawAnswer as? [String: Any] else { continue }
            if kind(id) != nil, let choice = value["choice"] as? String, choices.contains(choice), let at = number(value["at"]) {
                out.answered[id] = Answer(choice: choice, at: at)
            }
        }
        return out
    }
    func snapshot() -> [String: Any] {
        guard let data = try? JSONEncoder().encode(state),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return value
    }

    static func validatedState(_ raw: [String: Any]) -> State? {
        let normalized = normalize(raw)
        guard JSONSerialization.isValidJSONObject(raw),
              let encoded = try? JSONEncoder().encode(normalized),
              let object = try? JSONSerialization.jsonObject(with: encoded),
              let actual = try? JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys, .withoutEscapingSlashes]),
              let expected = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]),
              actual == expected else { return nil }
        return normalized
    }

    func adopt(_ snapshot: State) { state = snapshot; flush() }
    func diagnostics() -> [String: Any] {
        ["enabled": enabled, "maxCards": maxCards, "exploration": exploration,
         "feedbackCount": state.feedbackCount, "pendingExposures": state.pending.count,
         "arms": state.arms.mapValues { ["shown": $0.shown, "positive": $0.positive, "negative": $0.negative, "ignored": $0.ignored] }] as [String: Any]
    }
    func flush() {
        persistTask?.cancel(); persistTask = nil
        guard let stateURL else { return }
        do {
            try FileManager.default.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
            try encoder.encode(state).write(to: stateURL, options: .atomic)
        } catch { onError?("Pocket autonomy persist failed: \(error.localizedDescription)") }
    }
    private func schedulePersist() {
        guard stateURL != nil, persistTask == nil else { return }
        persistTask = Task { @DaemonActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(P.persistDelayMs)) } catch { return }
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }
    private func updateArm(_ kind: String, _ update: (inout Arm) -> Void) {
        var arm = state.arms[kind] ?? Arm(); update(&arm); state.arms[kind] = arm
    }
    private func calendar() -> Calendar {
        var c = Calendar(identifier: .gregorian); c.timeZone = timeZone; return c
    }
    private func hourBucket(_ now: Double) -> Int { calendar().component(.hour, from: Date(timeIntervalSince1970: now / 1000)) / Int(P.bucketHours) }
    private func key(_ kind: String, _ now: Double, _ identity: [Any]) -> String {
        let c = calendar().dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: now / 1000))
        let day = String(format: "%04d%02d%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
        // JS JSON.stringify(array): absent values are null; slash escaping is
        // disabled and FNV walks UTF-16 code units, not Swift Characters/UTF-8.
        let bytes: Data
        if JSONSerialization.isValidJSONObject(identity) {
            bytes = (try? JSONSerialization.data(withJSONObject: identity, options: [.withoutEscapingSlashes])) ?? Data()
        } else {
            bytes = Data()
        }
        let text = String(decoding: bytes, as: UTF8.self)
        var hash: UInt32 = 0x811c9dc5
        for unit in text.utf16 { hash = (hash ^ UInt32(unit)) &* 0x01000193 }
        return "auto:\(kind):\(day):\(String(format: "%08x", hash))"
    }
    private func label(_ s: [String: Any]) -> String { nonempty(s["projectName"]) ?? nonempty(s["agentType"]) ?? "session" }
    private func nonempty(_ value: Any?) -> String? { guard let s = value as? String, !s.isEmpty else { return nil }; return s }
    private func waiting(_ s: [String: Any]) -> Bool { nonempty(s["requestId"]) != nil || (s["state"] as? String)?.hasPrefix("awaiting") == true }
    private func nudge(_ kind: String, _ now: Double, _ identity: [Any], _ priority: Double,
                       _ title: String, _ question: String, _ context: [String]) -> Candidate {
        Candidate(module: "nudge", kind: kind, key: key(kind, now, identity), actionClass: "day", priority: priority,
                  title: title, question: question, context: context, choices: Self.feedback)
    }
    private func candidates(_ sessions: [[String: Any]], _ glance: [String: Any], _ now: Double) -> [Candidate] {
        var out: [Candidate] = []
        if let event = (glance["events"] as? [[String: Any]])?.first {
            let start = nonempty(event["startHm"]), end = nonempty(event["endHm"])
            let time = start.map { $0 + (end.map { "-" + $0 } ?? "") } ?? "All day"
            out.append(nudge("agenda", now, [event["startHm"] ?? NSNull(), event["endHm"] ?? NSNull(), event["title"] ?? NSNull()], P.agendaPriority,
                             "NEXT", event["title"] as? String ?? "", [time, "From today's cached schedule"]))
        }
        if let weather = glance["weather"] as? [String: Any], let rain = weather["rain"] as? [String: Any] {
            let place = nonempty(weather["place"]) ?? "Today", start = rain["startHm"] as? String ?? ""
            let window = start + (nonempty(rain["endHm"]).map { "-" + $0 } ?? " onward")
            let probability = Self.number(rain["probability"])
            let question = probability.map { "\(Self.decimal($0))% rain from \(start)" } ?? "Rain from \(start)"
            out.append(nudge("weather", now, [place, window, rain["probability"] ?? NSNull()], P.weatherPriority,
                             "RAIN", question, [place, "Window \(window)"]))
        }
        let usage = (glance["usage"] as? [[String: Any]] ?? []).filter { $0["primaryPercent"] != nil || $0["secondaryPercent"] != nil }
        let rankedUsage = usage.enumerated().sorted {
            let a = max(Self.number($0.element["primaryPercent"]) ?? 0, Self.number($0.element["secondaryPercent"]) ?? 0)
            let b = max(Self.number($1.element["primaryPercent"]) ?? 0, Self.number($1.element["secondaryPercent"]) ?? 0)
            return a == b ? $0.offset < $1.offset : a > b
        }
        if let u = rankedUsage.first?.element {
            let percent = max(Self.number(u["primaryPercent"]) ?? 0, Self.number(u["secondaryPercent"]) ?? 0)
            var context = [u["stale"] as? Bool == true ? "Last known value" : "Current provider budget"]
            if let reset = nonempty(u["primaryResetHm"]) { context.append("Resets \(reset)") }
            out.append(nudge("usage", now, [u["provider"] ?? NSNull(), percent, u["primaryResetHm"] ?? NSNull(), u["stale"] ?? NSNull()],
                             percent >= P.usageThreshold ? P.usagePriority : P.lowUsagePriority,
                             "BUDGET", "\(u["label"] as? String ?? "") usage is \(Self.decimal(percent))%", context))
        }
        let alive = sessions.filter { $0["alive"] as? Bool != false }
        let waits = alive.filter(waiting)
        if !waits.isEmpty {
            out.append(nudge("attention", now, waits.map { $0["id"] ?? NSNull() }, P.attentionPriority,
                             "NEEDS YOU", "\(waits.count) session\(waits.count == 1 ? "" : "s") waiting", waits.prefix(Int(P.attentionLines)).map(label)))
        }
        let works = alive.filter { $0["state"] as? String == "processing" }
        if !works.isEmpty {
            out.append(nudge("progress", now, works.map { [$0["id"] ?? NSNull(), $0["currentTool"] ?? NSNull(), $0["currentTask"] ?? NSNull()] }, P.progressPriority,
                             "IN MOTION", "\(works.count) agent\(works.count == 1 ? " is" : "s are") still working",
                             works.prefix(Int(P.attentionLines)).map { label($0) + (nonempty($0["currentTool"]).map { " - " + $0 } ?? "") }))
        }
        let resumes = alive.enumerated().filter { $0.element["state"] as? String == "idle" && (nonempty($0.element["currentTask"]) != nil || nonempty($0.element["activity"]) != nil) }.sorted {
            let a = Self.number($0.element["elapsedSec"]) ?? 0, b = Self.number($1.element["elapsedSec"]) ?? 0
            return a == b ? $0.offset < $1.offset : a > b
        }
        if let s = resumes.first?.element {
            let checkpoint = nonempty(s["currentTask"]) ?? nonempty(s["activity"]) ?? "Last checkpoint"
            out.append(nudge("resume", now, [s["id"] ?? NSNull(), checkpoint], P.resumePriority,
                             "PICK UP", "Return to \(label(s))?", [checkpoint]))
        }
        if !alive.isEmpty {
            var projects: [String] = []
            for s in alive where !projects.contains(label(s)) { projects.append(label(s)) }
            out.append(Candidate(module: "pulse", kind: "overview", key: key("overview", now, alive.map { [$0["id"] ?? NSNull(), $0["state"] ?? NSNull(), $0["currentTask"] ?? NSNull()] }),
                                 actionClass: "info", priority: P.overviewPriority, title: "PULSE",
                                 question: "\(projects.count) project\(projects.count == 1 ? "" : "s") across \(alive.count) open thread\(alive.count == 1 ? "" : "s")",
                                 context: Array(projects.prefix(Int(P.overviewLines)))))
        }
        out.append(Candidate(module: "quest", kind: "preference", key: key("preference", now, ["preference-v1"]), actionClass: "day",
                             priority: P.preferencePriority, title: "POCKET LAB", question: "What should Pocket learn first?",
                             context: ["It keeps exploring as your pattern changes."], choices: [
                                ["id": "work", "label": "Work flow", "intent": "affirm"],
                                ["id": "day", "label": "My day", "intent": "affirm"],
                                ["id": "surprise", "label": "Surprise me", "intent": "neutral"],
                             ]))
        return out
    }
    private static func decimal(_ n: Double) -> String { String(n).hasSuffix(".0") ? String(String(n).dropLast(2)) : String(n) }
    private func score(_ candidate: Candidate, _ now: Double, _ totalShown: Double) -> Double {
        if state.arms[candidate.kind] == nil { state.arms[candidate.kind] = Arm() }
        let arm = state.arms[candidate.kind]!
        let effectiveNegative = arm.negative + arm.ignored * P.ignoredWeight
        let mean = (arm.positive + P.positivePrior) / (arm.positive + effectiveNegative + P.totalPrior)
        let explore = exploration * sqrt(log(totalShown + P.explorationTotalPrior) / (arm.shown + P.explorationShownPrior))
        let affinity = arm.positive > 0 ? arm.hourPositive[hourBucket(now)] / arm.positive : 0
        let cooldown = arm.lastShownAt.map { $0 != 0 && now - $0 < P.cooldownMs ? P.cooldownPenalty : 0 } ?? 0
        return candidate.priority + mean + explore + affinity * P.affinityWeight + (arm.shown == 0 ? P.unseenBonus : 0) - cooldown
    }
    func cards(sessions: [[String: Any]], glance: [String: Any] = [:], now: Double) -> [[String: Any]] {
        guard enabled else { return [] }
        let all = candidates(sessions, glance, now)
        var selected: [Candidate] = []
        let survey = all.first { $0.kind == "preference" }
        let shouldSurvey = state.feedbackCount < P.initialSurveyFeedback ||
            (state.feedbackCount.truncatingRemainder(dividingBy: P.surveyFeedbackInterval) == 0 &&
             (state.lastSurveyAt == nil || state.lastSurveyAt == 0 || now - state.lastSurveyAt! >= P.surveyIntervalMs))
        if let survey, shouldSurvey, state.answered[survey.cardId] == nil { selected.append(survey) }
        let total = state.arms.values.reduce(0) { $0 + $1.shown }
        let eligible: [Candidate] = all.filter { $0.kind != "preference" && state.answered[$0.cardId] == nil }
        // JS sort never invokes its comparator for a single candidate.
        let scored: [(Candidate, Double)] = eligible.map { ($0, eligible.count > 1 ? score($0, now, total) : 0) }
        let ranked = scored.sorted {
            $0.1 == $1.1 ? $0.0.cardId < $1.0.cardId : $0.1 > $1.1
        }
        for (candidate, _) in ranked where selected.count < maxCards { selected.append(candidate) }
        selected = Array(selected.prefix(maxCards))
        // buildModuleCards traverses pulse, nudge, quest after selection.
        return ["pulse", "nudge", "quest"].flatMap { module in selected.filter { $0.module == module }.map(seal) }
    }
    private func seal(_ c: Candidate) -> [String: Any] {
        var body: [String: Any] = ["module": c.module, "title": Self.trim(c.title, Int(P.titleBytes)), "question": Self.trim(c.question, Int(P.questionBytes))]
        let context = c.context.filter { !$0.isEmpty }.prefix(Int(P.contextLines)).map { Self.trim($0, Int(P.contextBytes)) }
        if !context.isEmpty { body["context"] = context }
        let choices = c.choices.prefix(Int(P.maxChoices)).map { choice -> [String: String] in
            var out = choice; out["id"] = Self.trim(choice["id"] ?? "", Int(P.choiceIdBytes)); out["label"] = Self.trim(choice["label"] ?? "", Int(P.choiceLabelBytes)); return out
        }
        if !choices.isEmpty { body["choices"] = choices }
        return ["cardId": c.cardId, "actionClass": c.actionClass, "module": body]
    }
    /// Same Unicode-scalar boundary as truncateUtf8Bytes, with no added copy.
    private static func trim(_ value: String, _ limit: Int) -> String {
        guard value.utf8.count > limit else { return value }
        var out = "", used = 0
        for scalar in value.unicodeScalars {
            let count = String(scalar).utf8.count
            if used + count > limit { break }; out.unicodeScalars.append(scalar); used += count
        }
        return out
    }
    func observeDelivery(_ cards: [[String: Any]], now: Double, board: String? = nil) {
        guard enabled else { return }
        var changed = false
        state.pending = state.pending.filter { pending in
            if now - pending.shownAt >= P.noResponseMs {
                updateArm(pending.kind) { $0.ignored += 1 }; changed = true; return false
            }; return true
        }
        for card in cards {
            guard let id = card["cardId"] as? String, let kind = Self.kind(id), state.seen[id] == nil,
                  let module = (card["module"] as? [String: Any])?["module"] as? String,
                  id.hasPrefix("module:\(module):") else { continue }
            updateArm(kind) { $0.shown += 1; $0.lastShownAt = now }
            state.seen[id] = now
            state.pending.append(Exposure(cardId: id, kind: kind, shownAt: now, hourBucket: hourBucket(now), board: board))
            changed = true
        }
        state.pending = Array(state.pending.suffix(Int(P.pendingLimit))).filter { now - $0.shownAt <= P.keepPendingMs }
        state.seen = state.seen.filter { now - $0.value <= P.keepSeenMs }
        state.answered = state.answered.filter { now - $0.value.at <= P.keepSeenMs }
        if changed { schedulePersist() }
    }
    func apply(_ decision: [String: Any], now: Double) -> [String: Any] {
        let id = decision["cardId"] as? String ?? ""
        let parts = id.split(separator: ":", omittingEmptySubsequences: false)
        guard let kind = Self.kind(id), parts.count == 6 else { return ["status": "unknown_card", "reason": "unknown Pocket card key"] }
        guard let choice = decision["choiceId"] as? String, !choice.isEmpty else { return ["status": "rejected", "reason": "choiceId required"] }
        if state.answered[id] != nil { return ["status": "applied"] }
        let module = String(parts[1])
        if choice == "later" {
            state.answered[id] = Answer(choice: choice, at: now); state.pending.removeAll { $0.cardId == id }
            schedulePersist(); return ["status": "applied"]
        }
        if module == "pulse" { return ["status": "rejected", "reason": "read-only Pocket card only supports Later"] }
        if module == "quest" {
            guard ["work", "day", "surprise"].contains(choice) else { return ["status": "rejected", "reason": "unknown Pocket preference"] }
            let kinds = choice == "work" ? ["attention", "progress", "resume", "overview"] : choice == "day" ? ["agenda", "weather", "usage"] : ["agenda", "weather", "usage", "attention", "progress", "resume", "overview"]
            for k in kinds { updateArm(k) { $0.positive += choice == "surprise" ? P.surpriseReward : P.preferenceReward } }
            state.lastSurveyAt = now
        } else {
            guard ["useful", "more", "less"].contains(choice) else { return ["status": "rejected", "reason": "unknown Pocket feedback"] }
            let pending = state.pending.first { $0.cardId == id }
            updateArm(kind) { arm in
                if choice == "less" { arm.negative += P.lessPenalty }
                else {
                    let reward = choice == "more" ? P.moreReward : P.usefulReward
                    arm.positive += reward
                    if let pending { arm.hourPositive[pending.hourBucket] += reward }
                }
            }
        }
        state.feedbackCount += 1; state.answered[id] = Answer(choice: choice, at: now)
        state.pending.removeAll { $0.cardId == id }; schedulePersist()
        return ["status": "applied"]
    }
}
#endif
