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
        /// Timebox CI face for this session's wait (`ciFaces`), nil when there is
        /// no wait, a terminal verdict, or no explicit agentWaiting.
        var ciFace: String? = nil
        /// Live children (`subagents.active`), non-negative.
        var children: Int = 0
        var backgroundCount: Int? = nil
    }
    struct Result {
        let ts: Double
        let type: String
        let status: String
        let sessionId: String?
        var agentType: String? = nil
        let automated: Bool
    }
    struct Companion {
        let kind: String
        let glyph: String
        let count: Int
        let lowerBound: Bool
        let hasError: Bool
    }
    struct Scene {
        var companion: Companion? = nil

        let kind: String
        let count: Int
        let glyph: String
        let frame: Int
        let roster: [String]
        let counts: [Int]
        var face: String = ""
        var pips: Int = 0
        var backgroundCount: Int = -1
    }
    #if AGENTDECK_DOT_PREVIEW
    private var dot: DotSurfaceSnapshot?
    #endif
    private var sessions: [Resident]?
    private var timeline: [Result] = []
    private var seen: [String] = []
    private var arrival: (id: String, ts: Double)?
    private var gatewayHasError = false

    mutating func reset() {
        sessions = nil; timeline = []; arrival = nil; seen = []; gatewayHasError = false
        #if AGENTDECK_DOT_PREVIEW
        dot = nil
        #endif
    }
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
            #if AGENTDECK_DOT_PREVIEW
            dot = nil
            if let raw = event["dot"] as? [String: Any], JSONSerialization.isValidJSONObject(raw),
               let data = try? JSONSerialization.data(withJSONObject: raw) { dot = try? JSONDecoder().decode(DotSurfaceSnapshot.self, from: data) }
            #endif
            guard let raw = event["sessions"] as? [[String: Any]] else { return }
            let incoming = raw.compactMap { row -> Resident? in
                guard let id = row["id"] as? String else { return nil }
                var resident = Resident(id: id, alive: row["alive"] as? Bool ?? false,
                    state: row["state"] as? String ?? "", agentType: row["agentType"] as? String ?? "")
                if let wait = row["waitingOn"] as? [String: Any], wait["agentWaiting"] as? Bool == true,
                   let phase = wait["phase"] as? String {
                    resident.ciFace = MatrixFrames.ciFaces[phase]
                }
                resident.children = Self.count((row["subagents"] as? [String: Any])?["active"])
                resident.backgroundCount = BackgroundDevicePolicy.decode(row["backgroundTaskCount"])
                    ?? sessions?.first(where: { $0.id == id })?.backgroundCount
                return resident
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
        case "state_update":
            // Retain-on-absent: only an explicit boolean changes the Gateway verdict.
            if let flag = event["gatewayHasError"] as? Bool { gatewayHasError = flag }
        default: break
        }
    }
    /// A finite positive count, floored; anything else is zero. Native rows
    /// carry Int, decoded JSON carries NSNumber — read both.
    private static func count(_ raw: Any?) -> Int {
        let value: Double
        if let int = raw as? Int { value = Double(int) } else if let double = raw as? Double { value = double } else { return 0 }
        return value.isFinite && value > 0 ? Int(value.rounded(.down)) : 0
    }
    private static func result(_ raw: [String: Any]) -> Result? {
        guard let ts = raw["ts"] as? Double, ts.isFinite, let type = raw["type"] as? String,
              MatrixFrames.closeTypes.contains(type) || MatrixFrames.askTypes.contains(type) else { return nil }
        return Result(ts: ts, type: type, status: raw["status"] as? String ?? "", sessionId: raw["sessionId"] as? String,
                      agentType: raw["agentType"] as? String, automated: raw["automated"] as? Bool ?? false)
    }
    /// matrixRowSession (shared/src/matrix-expression.ts): rows and roster use
    /// two id forms, and the one OpenClaw roster presence matches by agent.
    static func rowSession(_ s: Resident, _ e: Result) -> Bool {
        sameSession(s.id, e.sessionId) ||
            (e.agentType == MatrixFrames.gatewayAgent && s.agentType == MatrixFrames.gatewayAgent)
    }
    private static func sameSession(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b, !a.isEmpty, !b.isEmpty else { return false }
        return a == b || ObservedAgentRules.rawSessionId(a) == ObservedAgentRules.rawSessionId(b)
    }
    private static func sameRow(_ a: Result, _ b: Result) -> Bool {
        a.sessionId == b.sessionId || sameSession(a.sessionId, b.sessionId)
    }
    private func rowGlyph(_ e: Result, _ live: [Resident]) -> String {
        let owner = live.first { Self.rowSession($0, e) }
        return MatrixFrames.agents[owner.map(\.agentType) ?? e.agentType ?? ""] ?? "neutral"
    }
    /// matrixInteraction (shared/src/matrix-expression.ts): an agent's reply to
    /// a turn holds the stage for replyMs; else a user message just delivered to
    /// a live, working session keeps its agent listening until the reply, at most askMs.
    private func interaction(_ live: [Resident], _ now: Double) -> (kind: String, row: Result, ts: Double)? {
        let conversational = { (e: Result) in !e.automated && e.ts.isFinite && now >= e.ts }
        if let reply = timeline.filter({ e in conversational(e) && live.contains(where: { Self.rowSession($0, e) }) &&
                !timeline.contains(where: { Self.sameRow($0, e) && $0.ts > e.ts && $0.ts <= now && MatrixFrames.askTypes.contains($0.type) }) &&
                MatrixFrames.replyTypes.contains(e.type) &&
                !MatrixFrames.rejectedStatuses.contains(e.status) && now - e.ts < Double(MatrixFrames.replyMs) })
            .max(by: { $0.ts < $1.ts }) {
            return ("reply", reply, reply.ts)
        }
        guard let ask = timeline.filter({ conversational($0) && $0.sessionId != nil &&
                MatrixFrames.askTypes.contains($0.type) && now - $0.ts < Double(MatrixFrames.askMs) })
            .max(by: { $0.ts < $1.ts }),
              live.contains(where: { Self.rowSession($0, ask) && Self.state($0.state) == "working" }) else { return nil }
        let answered = timeline.contains { Self.sameRow($0, ask) && $0.ts >= ask.ts && $0.ts <= now &&
            MatrixFrames.closeTypes.contains($0.type) }
        return answered ? nil : ("asked", ask, ask.ts)
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
        var responseAt: Double?
        if MatrixFrames.urgent.contains(kind) {
            let attention = live.filter { Self.state($0.state) == kind }
            let hero = attention[Int(max(0, now) / Double(MatrixFrames.attentionMs)) % attention.count]
            glyph = MatrixFrames.agents[hero.agentType] ?? "neutral"
        } else if sessions != nil {
            if let conversation = interaction(live, now) {
                kind = conversation.kind; count = live.count; frameTime = now - conversation.ts; responseAt = conversation.ts
                glyph = rowGlyph(conversation.row, live)
            } else if let arrival, now >= arrival.ts, now - arrival.ts < Double(MatrixFrames.arrivalMs),
               let resident = live.first(where: { $0.id == arrival.id }) {
                kind = "arrival"; count = live.count; frameTime = now - arrival.ts
                glyph = MatrixFrames.agents[resident.agentType] ?? "neutral"
            } else if kind == "done", let latest = done.sorted(by: { $0.ts > $1.ts }).first,
                      now - latest.ts < Double(MatrixFrames.responseMs) {
                glyph = rowGlyph(latest, live)
                frameTime = now - latest.ts; responseAt = latest.ts
            }
        }
        let (face, pips) = self.face(live, kind: kind, results: done, now: now)
        return Scene(companion: companion(live, eventKind: kind, eventGlyph: glyph, responseAt: responseAt, now: now), kind: kind, count: count, glyph: glyph,
            frame: Int(max(0, frameTime) / Double(MatrixFrames.frameMs)) % MatrixFrames.frames,
            roster: live.map { Self.state($0.state) },
            counts: [waiting, working, done.count, errors > 0 ? errors : live.count],
            face: face, pips: pips, backgroundCount: live.contains(where: { $0.backgroundCount != nil }) ? live.reduce(0) { $0 + ($1.backgroundCount ?? 0) } : -1)
    }
    /// Mirrors the 32×32 companion policy; sequence parity gates owner/count
    /// selection, attention preemption and partial background counts.
    private func companion(_ live: [Resident], eventKind: String, eventGlyph: String,
                           responseAt: Double?, now: Double) -> Companion {
        let errors = live.filter { Self.state($0.state) == "error" || (gatewayHasError && $0.agentType == MatrixFrames.gatewayAgent) }
        let tick = Int(max(0, now) / Double(MatrixFrames.companionPageMs))
        func make(_ kind: String, _ owners: [Resident], count: Int? = nil, lowerBound: Bool = false, index: Int? = nil) -> Companion {
            let hero = owners.isEmpty ? nil : owners[(index ?? tick) % owners.count]
            return Companion(kind: kind, glyph: MatrixFrames.agents[hero?.agentType ?? ""] ?? "neutral",
                             count: count ?? owners.count, lowerBound: lowerBound, hasError: !errors.isEmpty)
        }
        if sessions == nil { return make("unknown", [], count: 0) }
        let waiting = live.filter { Self.state($0.state) == "waiting" }
        if !waiting.isEmpty {
            let hero = waiting[tick % waiting.count]
            let kind = MatrixFrames.awaitingFaces.first { $0[0] == hero.state }?[1] ?? "waiting"
            return make(kind, waiting)
        }
        if !errors.isEmpty { return make("error", errors) }
        let fresh = responseAt.map { now - $0 < Double(MatrixFrames.responseMs) } ?? false
        if eventKind == "arrival" || eventKind == "reply" || ((eventKind == "asked" || eventKind == "done") && fresh) {
            return Companion(kind: eventKind, glyph: eventGlyph, count: -1, lowerBound: false, hasError: false)
        }
        var pages: [(kind: String, owners: [Resident], count: Int?, lowerBound: Bool)] = []
        let working = live.filter { $0.ciFace == nil && Self.state($0.state) == "working" }
        if !working.isEmpty { pages.append(("working", working, nil, false)) }
        let background = live.filter { ($0.backgroundCount ?? 0) > 0 }
        if !background.isEmpty {
            pages.append(("background", background, background.reduce(0) { $0 + ($1.backgroundCount ?? 0) }, live.contains { $0.backgroundCount == nil }))
        }
        let children = live.filter { $0.children > 0 }
        if !children.isEmpty { pages.append(("delegating", children, children.reduce(0) { $0 + $1.children }, false)) }
        let ci = live.filter { $0.ciFace != nil }
        if !ci.isEmpty { pages.append(("ci", ci, nil, false)) }
        if !pages.isEmpty {
            let page = pages[tick % pages.count], index = tick / pages.count
            let kind = page.kind == "ci" && page.owners[index % page.owners.count].ciFace == "ci-unknown" ? "ci-unknown" : page.kind
            return make(kind, page.owners, count: page.count, lowerBound: page.lowerBound, index: index)
        }
        return make(live.isEmpty ? "empty" : "idle", live, count: live.isEmpty ? -1 : live.count)
    }
    /// matrix-expression.ts `face`: no roster → needs-you → failure →
    /// conversation / entrance / fresh result → working → children under an
    /// idle parent → CI wait → a result within its window → empty → idle.
    private func face(_ live: [Resident], kind: String, results: [Result], now: Double) -> (String, Int) {
        if sessions == nil { return ("unknown", 0) }
        let waiting = live.filter { Self.state($0.state) == "waiting" }
        if !waiting.isEmpty {
            let face = MatrixFrames.awaitingFaces.first { pair in waiting.contains { $0.state == pair[0] } }?[1] ?? "waiting"
            return (face, waiting.count)
        }
        let gatewayError = gatewayHasError && live.contains {
            $0.agentType == MatrixFrames.gatewayAgent && Self.state($0.state) != "error"
        }
        let errors = live.filter { Self.state($0.state) == "error" }.count + (gatewayError ? 1 : 0)
        if errors > 0 { return ("error", errors) }
        if kind == "asked" || kind == "reply" || kind == "arrival" { return (kind, 0) }
        if results.contains(where: { now - $0.ts < Double(MatrixFrames.responseMs) }) { return ("done", 0) }
        let working = live.filter { $0.ciFace == nil && Self.state($0.state) == "working" }.count
        if working > 0 { return ("working", working) }
        let children = live.reduce(0) { $0 + $1.children }
        if children > 0 { return ("delegating", children) }
        let ci = live.compactMap(\.ciFace)
        if !ci.isEmpty { return (ci.contains("ci") ? "ci" : "ci-unknown", ci.count) }
        if !results.isEmpty { return ("done", 0) }
        return live.isEmpty ? ("empty", 0) : ("idle", live.count)
    }
    func render(size: Int, now: Double) -> Data {
        #if AGENTDECK_DOT_PREVIEW
        DotPixelOverlay.paint(Self.render(size: size, scene: scene(now: now)), width: size, dot: dot, now: Int(now))
        #else
        Self.render(size: size, scene: scene(now: now))
        #endif
    }
    static func render(size: Int, scene: Scene) -> Data {
        precondition(size == 11 || size == 32)
        if size == 32, let c = scene.companion {
            var out = MatrixFrames.base(size: 32, kind: "companion-" + c.kind, glyph: c.glyph, frame: scene.frame)
            func put(_ x: Int, _ y: Int, _ color: [UInt8]) {
                guard x >= 0, x < 32, y >= 0, y < 32 else { return }
                for i in 0..<3 { out[(y * 32 + x) * 3 + i] = color[i] }
            }
            if c.count >= 0 && c.kind != "unknown" {
                let value = c.count > MatrixFrames.maxCount ? "99+" : "\(c.count)\(c.lowerBound ? "+" : "")"
                for (d, character) in value.enumerated() {
                    for (i,v) in (MatrixFrames.digits[String(character)] ?? []).enumerated() where v != 0 {
                        put(MatrixFrames.countX + (MatrixFrames.countColumns - value.count + d) * MatrixFrames.digitStep + i % 3,
                            MatrixFrames.companionCountY + i / 3, MatrixFrames.companionColors[c.kind]!)
                    }
                }
            }
            if c.hasError && c.kind != "error" {
                for (x,y) in [(0,0),(1,1),(2,0),(0,2),(2,2)] { put(x,y,MatrixFrames.colors["error"]!) }
            }
            return Data(out)
        }
        let summary = scene.glyph.hasPrefix("summary")
        let error = scene.roster.contains("error")
        let glyph = summary && error ? "summary-error" : scene.glyph
        let face = scene.face.isEmpty ? scene.kind : scene.face
        var out = MatrixFrames.base(size: size, kind: size == 11 ? face : scene.kind, glyph: glyph, frame: scene.frame)
        func put(_ x: Int, _ y: Int, _ color: [UInt8], _ intensity: Double = 1) {
            guard x >= 0, y >= 0, x < size, y < size else { return }
            for c in 0..<3 { out[(y * size + x) * 3 + c] = UInt8((Double(color[c]) * intensity).rounded()) }
        }
        if size == 11 {
            if scene.backgroundCount > 0 && !["waiting","choosing","reviewing","error","unknown"].contains(face) {
                for i in 0..<min(BackgroundDevicePolicy.maxDots,scene.backgroundCount) {
                    put((scene.frame * 11 / MatrixFrames.frames + i * MatrixFrames.backgroundDotStep) % 11, 10, MatrixFrames.colors["working"]!)
                }
            }
            return Data(out)
        }
        func number(_ value: Int, _ y: Int, _ tone: String) {
            let text = scene.kind == "unknown" || value < 0 ? "-" : value > MatrixFrames.maxCount ? "99+" : String(value)
            for (d, character) in text.enumerated() {
                for (i, v) in (MatrixFrames.digits[String(character)] ?? []).enumerated() where v != 0 {
                    put(MatrixFrames.countX + (MatrixFrames.countColumns - text.count + d) * MatrixFrames.digitStep + i % 3, y + i / 3, MatrixFrames.colors[tone]!, value == 0 ? MatrixFrames.zeroCountIntensity : 1)
                }
            }
        }
        if summary {
            let counts = scene.counts.enumerated().map { $0.offset == 2 ? scene.backgroundCount : $0.element }
            if scene.kind != "unknown" {
                for (row, value) in counts.enumerated() where value == 0 {
                    let start = row * MatrixFrames.summaryStep * size * 3
                    let end = (row + 1) * MatrixFrames.summaryStep * size * 3
                    for i in start..<end { out[i] = UInt8((Double(out[i]) * MatrixFrames.zeroRowIntensity).rounded()) }
                }
            }
            if scene.kind == "unknown" { number(0, MatrixFrames.countY, "unknown") }
            else {
                var tones = MatrixFrames.summaryKinds
                if error { tones[3] = "error" }
                for (row, value) in counts.enumerated() {
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
