import Foundation

/// Native counterpart of MatrixExpression (shared/src/matrix-expression.ts).
/// Policy constants and every artwork frame are generated. Both engines are run
/// against the same event sequences and compared byte-for-byte in the parity test.
struct MatrixExpression {
    struct Resident {
        let id: String
        let alive: Bool
        let state: String
        let agentType: String
    }
    struct Result {
        let ts: Double
        let type: String
        let status: String
        let sessionId: String?
        let automated: Bool
    }
    struct Scene {
        let kind: String
        let count: Int
        let glyph: String
        let frame: Int
        let roster: [String]
        let counts: [Int]
    }
    private var sessions: [Resident]?
    private var timeline: [Result] = []
    private var seen: [String] = []
    private var arrival: (id: String, ts: Double)?

    mutating func reset() { sessions = nil; timeline = []; arrival = nil; seen = [] }
    static func state(_ state: String) -> String {
        state.hasPrefix(MatrixFrames.awaitingPrefix) ? "waiting" : MatrixFrames.stateKinds[state] ?? "idle"
    }
    private func results(_ now: Double) -> [Result] {
        timeline.filter {
            MatrixFrames.resultTypes.contains($0.type) &&
            !MatrixFrames.rejectedStatuses.contains($0.status) &&
            $0.ts.isFinite && now >= $0.ts && now - $0.ts < Double(MatrixFrames.resultMs)
        }
    }
    /// Called on broadcasts, not renders. A restored roster is a baseline, not
    /// a burst of new agents. Timeline history retains its original timestamps.
    mutating func ingest(_ event: [String: Any], now: Double) {
        switch event["type"] as? String {
        case "sessions_list":
            guard let raw = event["sessions"] as? [[String: Any]] else { return }
            let incoming = raw.compactMap { row -> Resident? in
                guard let id = row["id"] as? String else { return nil }
                return Resident(id: id, alive: row["alive"] as? Bool ?? false,
                    state: row["state"] as? String ?? "", agentType: row["agentType"] as? String ?? "")
            }
            if sessions != nil {
                let known = Set(seen)
                if let added = incoming.filter({ $0.alive && !known.contains($0.id) }).sorted(by: { $0.id < $1.id }).first {
                    arrival = (added.id, now)
                }
            }
            for resident in incoming where !seen.contains(resident.id) { seen.append(resident.id) }
            seen = Array(seen.suffix(MatrixFrames.seenLimit))
            sessions = incoming
        case "timeline_history":
            timeline = ((event["entries"] as? [[String: Any]]) ?? []).compactMap(Self.result)
                .sorted { $0.ts < $1.ts }
            timeline = Array(timeline.suffix(MatrixFrames.historyLimit))
        case "timeline_event":
            guard let raw = event["entry"] as? [String: Any], let entry = Self.result(raw) else { return }
            if event["upsert"] as? Bool == true,
               let i = timeline.firstIndex(where: { $0.ts == entry.ts && $0.type == entry.type && $0.sessionId == entry.sessionId }) {
                timeline[i] = entry
            } else { timeline.append(entry) }
            timeline.sort { $0.ts < $1.ts }
            timeline = Array(timeline.suffix(MatrixFrames.historyLimit))
        case "connection":
            if event["status"] as? String == "disconnected" { reset() }
        default: break
        }
    }
    private static func result(_ raw: [String: Any]) -> Result? {
        guard let ts = raw["ts"] as? Double, ts.isFinite, let type = raw["type"] as? String,
              MatrixFrames.closeTypes.contains(type) || MatrixFrames.askTypes.contains(type) else { return nil }
        return Result(ts: ts, type: type, status: raw["status"] as? String ?? "", sessionId: raw["sessionId"] as? String,
                      automated: raw["automated"] as? Bool ?? false)
    }
    /// matrixInteraction (shared/src/matrix-expression.ts): an agent's reply to
    /// a turn holds the stage for replyMs; else an open user question to a live
    /// session keeps its agent listening until the reply, at most askMs.
    private func interaction(_ live: [Resident], _ now: Double) -> (kind: String, sessionId: String?, ts: Double)? {
        let conversational = { (e: Result) in !e.automated && e.ts.isFinite && now >= e.ts }
        if let reply = timeline.filter({ e in conversational(e) && live.contains(where: { $0.id == e.sessionId }) &&
                !timeline.contains(where: { $0.sessionId == e.sessionId && $0.ts > e.ts && $0.ts <= now && MatrixFrames.askTypes.contains($0.type) }) &&
                MatrixFrames.replyTypes.contains(e.type) &&
                !MatrixFrames.rejectedStatuses.contains(e.status) && now - e.ts < Double(MatrixFrames.replyMs) })
            .max(by: { $0.ts < $1.ts }) {
            return ("reply", reply.sessionId, reply.ts)
        }
        guard let ask = timeline.filter({ conversational($0) && $0.sessionId != nil &&
                MatrixFrames.askTypes.contains($0.type) && now - $0.ts < Double(MatrixFrames.askMs) })
            .max(by: { $0.ts < $1.ts }),
              live.contains(where: { $0.id == ask.sessionId && Self.state($0.state) == "working" }) else { return nil }
        let answered = timeline.contains { $0.sessionId == ask.sessionId && $0.ts >= ask.ts && $0.ts <= now &&
            MatrixFrames.closeTypes.contains($0.type) }
        return answered ? nil : ("asked", ask.sessionId, ask.ts)
    }
    func scene(now: Double) -> Scene {
        let live = (sessions ?? []).filter(\.alive).sorted { $0.id < $1.id }
        let waiting = live.filter { Self.state($0.state) == "waiting" }.count
        let errors = live.filter { Self.state($0.state) == "error" }.count
        let working = live.filter { Self.state($0.state) == "working" }.count
        let done = results(now)
        let counts = ["waiting": waiting, "error": errors, "done": done.count, "working": working, "idle": live.count]
        var kind = sessions == nil ? "unknown" : MatrixFrames.priority.first { (counts[$0] ?? 0) > 0 } ?? "idle"
        var count = counts[kind] ?? 0
        var glyph = "summary"
        var frameTime = now
        if MatrixFrames.urgent.contains(kind) {
            let attention = live.filter { Self.state($0.state) == kind }
            let hero = attention[Int(max(0, now) / Double(MatrixFrames.attentionMs)) % attention.count]
            glyph = MatrixFrames.agents[hero.agentType] ?? "neutral"
        } else if sessions != nil {
            if let conversation = interaction(live, now) {
                kind = conversation.kind; count = live.count; frameTime = now - conversation.ts
                let resident = live.first { $0.id == conversation.sessionId }
                glyph = MatrixFrames.agents[resident?.agentType ?? ""] ?? "neutral"
            } else if let arrival, now >= arrival.ts, now - arrival.ts < Double(MatrixFrames.arrivalMs),
               let resident = live.first(where: { $0.id == arrival.id }) {
                kind = "arrival"; count = live.count; frameTime = now - arrival.ts
                glyph = MatrixFrames.agents[resident.agentType] ?? "neutral"
            } else if kind == "done", let latest = done.sorted(by: { $0.ts > $1.ts }).first,
                      now - latest.ts < Double(MatrixFrames.responseMs) {
                let resident = live.first { $0.id == latest.sessionId }
                glyph = MatrixFrames.agents[resident?.agentType ?? ""] ?? "neutral"
                frameTime = now - latest.ts
            }
        }
        return Scene(kind: kind, count: count, glyph: glyph,
            frame: Int(max(0, frameTime) / Double(MatrixFrames.frameMs)) % MatrixFrames.frames,
            roster: live.map { Self.state($0.state) },
            counts: [waiting, working, done.count, errors > 0 ? errors : live.count])
    }
    func render(size: Int, now: Double) -> Data {
        Self.render(size: size, scene: scene(now: now))
    }
    static func render(size: Int, scene: Scene) -> Data {
        precondition(size == 11 || size == 32)
        let summary = scene.glyph.hasPrefix("summary")
        let error = scene.roster.contains("error")
        let glyph = summary && error ? "summary-error" : scene.glyph
        var out = MatrixFrames.base(size: size, kind: scene.kind, glyph: glyph, frame: scene.frame)
        if size == 11 { return Data(out) }
        func put(_ x: Int, _ y: Int, _ color: [UInt8], _ intensity: Double = 1) {
            guard x >= 0, y >= 0, x < size, y < size else { return }
            for c in 0..<3 { out[(y * size + x) * 3 + c] = UInt8((Double(color[c]) * intensity).rounded()) }
        }
        func number(_ value: Int, _ y: Int, _ tone: String) {
            let text = scene.kind == "unknown" ? "-" : value > MatrixFrames.maxCount ? "99+" : String(value)
            for (d, character) in text.enumerated() {
                for (i, v) in (MatrixFrames.digits[String(character)] ?? []).enumerated() where v != 0 {
                    put(MatrixFrames.countX + (MatrixFrames.countColumns - text.count + d) * MatrixFrames.digitStep + i % 3, y + i / 3, MatrixFrames.colors[tone]!, value == 0 ? MatrixFrames.zeroCountIntensity : 1)
                }
            }
        }
        if summary {
            if scene.kind != "unknown" {
                for (row, value) in scene.counts.enumerated() where value == 0 {
                    let start = row * MatrixFrames.summaryStep * size * 3
                    let end = (row + 1) * MatrixFrames.summaryStep * size * 3
                    for i in start..<end { out[i] = UInt8((Double(out[i]) * MatrixFrames.zeroRowIntensity).rounded()) }
                }
            }
            if scene.kind == "unknown" { number(0, MatrixFrames.countY, "unknown") }
            else {
                var tones = MatrixFrames.summaryKinds
                if error { tones[3] = "error" }
                for (row, value) in scene.counts.enumerated() {
                    number(value, MatrixFrames.countY + row * MatrixFrames.summaryStep, tones[row])
                }
            }
        } else {
            if scene.kind != "asked" && scene.kind != "reply" { number(scene.count, MatrixFrames.countY, scene.kind) }
            for (i, tone) in scene.roster.prefix(MatrixFrames.rosterDots).enumerated() {
                let x = MatrixFrames.dotX + i * MatrixFrames.dotStep
                for dy in 0..<2 { for dx in 0..<2 { put(x + dx, MatrixFrames.dotY + dy, MatrixFrames.colors[tone]!, MatrixFrames.dotIntensity) } }
                if i == MatrixFrames.rosterDots - 1 && scene.roster.count > MatrixFrames.rosterDots {
                    put(x, MatrixFrames.dotY - 1, MatrixFrames.overflow)
                }
            }
        }
        return Data(out)
    }
}
