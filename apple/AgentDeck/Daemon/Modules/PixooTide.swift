#if os(macOS)
// PixooTide.swift — Pixoo64 "Tide" scene: an animation drawn for a 64×64 LED matrix.
// Hand-ported twin of bridge/src/pixoo/pixoo-tide.ts — change both together; the
// frame digests pinned in PixooTideTests and pixoo-tide.test.ts fail if they drift.
//
// What the panel is bad at, and what that decided:
//   - Fine detail and dark gradients turn to mush on LEDs, so the water is a handful
//     of flat depth bands (dithered at the seams) and every moving thing is a bold,
//     high-contrast shape. The official 24×24 agent masks are drawn at native size.
//   - Every frame costs one HTTP request and the device shows its loading hourglass
//     while it ingests an upload, so the scene is ONE short closed loop the device
//     plays by itself (`PixooTide.frames`), uploaded when something visible changed
//     and otherwise left alone (see `PixooTide.decision`).
//
// The loop must close: every animated value is a function of `tick / frames` that
// returns to its start on frame `frames`, and nothing is random (a renderer's output
// is used as identity — the "baked animation loop must close" rule in
// .claude/rules/devices-and-wire.md). Beware JS parity: Node rounds with
// `Math.round` (half toward +∞), Swift's `round` is half away from zero, so every
// rounding that Node does goes through `jsRound`.

import Foundation

enum PixooTide {
    /// One closed loop: 6 frames × 500 ms = 3 s. Measured on the Pixoo64 (2026-10-08):
    /// an upload takes ~0.27 s per frame and the panel shows its loading hourglass
    /// for that ingest, so the loop is as short as the motion still reads as smooth.
    static let frames = 6
    static let picSpeedMs = 500

    static let size = 64
    static let waterTop = 5
    static let floorRows = 4
    static let maxMarks = 4

    enum State: String { case idle, processing, awaiting }

    struct Mark: Equatable {
        let id: String
        let glyph: OfficialDotGlyph
        let state: State
        /// Gateway error on the OpenClaw mark (desaturated, as the aquarium does).
        let sick: Bool
    }

    struct Marks: Equatable {
        var marks: [Mark] = []
        var overflow = 0
    }

    /// JavaScript's `Math.round`: half toward +∞ (Swift's `round` is half away from zero).
    @inline(__always) static func jsRound(_ value: Double) -> Int { Int((value + 0.5).rounded(.down)) }

    // MARK: - Which marks are on the panel

    static func mapState(_ raw: String?) -> State {
        switch raw {
        case "processing": return .processing
        case "awaiting_permission", "awaiting_option", "awaiting_diff": return .awaiting
        default: return .idle
        }
    }

    /// Sessions → the marks to draw, loudest first, with the count that did not fit.
    ///
    /// `sessions` is nil until the first `sessions_list` arrives; only then does the
    /// primary state stand in as one session (an empty list is an empty tank).
    /// `glyphFor` is an allow-list: an agent type the panel cannot show draws nothing.
    static func resolveMarks(
        sessions: [[String: Any]]?,
        primary: (agentType: String, state: String)?,
        gatewayHasError: Bool,
        glyphFor: (String) -> OfficialDotGlyph?
    ) -> Marks {
        var all: [Mark] = []
        if let sessions {
            // Codex rows fold by project first, exactly like the aquarium: one
            // workspace must not light up several cloud marks at once.
            let alive = sessions.filter { ($0["alive"] as? Bool) ?? true }
            for session in DashboardDataRules.foldCodexSessionPayloadsForDisplay(alive) {
                guard let id = session["id"] as? String,
                      let agentType = session["agentType"] as? String,
                      let glyph = glyphFor(agentType) else { continue }
                all.append(Mark(id: id, glyph: glyph, state: mapState(session["state"] as? String), sick: false))
            }
            if sessions.contains(where: { ($0["agentType"] as? String) == "openclaw" }) {
                let processing = sessions.contains {
                    ($0["agentType"] as? String) == "openclaw" && ($0["state"] as? String) == "processing"
                }
                all.append(Mark(id: "openclaw", glyph: .openClaw, state: processing ? .processing : .idle, sick: gatewayHasError))
            }
        } else if let primary, let glyph = glyphFor(primary.agentType) {
            all.append(Mark(id: "_primary", glyph: glyph, state: mapState(primary.state), sick: false))
        }
        let rank: [State: Int] = [.awaiting: 0, .processing: 1, .idle: 2]
        let ordered = all.enumerated().sorted {
            let a = rank[$0.element.state] ?? 2, b = rank[$1.element.state] ?? 2
            return a != b ? a < b : $0.offset < $1.offset
        }.map(\.element)
        return Marks(marks: Array(ordered.prefix(maxMarks)), overflow: max(0, ordered.count - maxMarks))
    }

    /// Mark edge length and centre columns by how many marks share the panel.
    static let layout: [(size: Int, xs: [Int])] = [
        (24, []), (24, [32]), (24, [18, 46]), (18, [12, 32, 52]), (14, [9, 25, 41, 57]),
    ]

    // MARK: - Upload policy
    //
    // The panel shows a loading hourglass while it ingests an upload, and on a busy
    // desk "something changed" is true every few seconds. So an upload is justified
    // only by what the panel would actually SHOW differently, and a flapping session
    // may not buy more than one per floor.

    enum Policy {
        /// A different set of marks or states re-bakes the loop at most this often.
        static let sceneFloor: TimeInterval = 15
        /// A usage-only change (percentages, the reset countdown ticking over a minute) at most this often.
        static let hudFloor: TimeInterval = 300
        /// With nothing to show, ask the device whether it still shows our loop this often.
        static let verify: TimeInterval = 30
        /// After a failed upload, no tide upload for this long. Never a single-frame fallback.
        static let retry: TimeInterval = 60
    }

    struct Signature: Equatable {
        let scene: String
        let hud: String
    }

    struct UploadRecord {
        let signature: Signature
        let at: Date
    }

    enum Decision: Equatable { case upload, verify, wait }

    /// What the panel would show: the marks (and CI state) vs. the usage strip.
    static func signature(marks: Marks, sessions: [[String: Any]]?, usage: DashboardState) -> Signature {
        let shown = Set(marks.marks.map(\.id))
        let ci = (sessions ?? []).compactMap { s -> String? in
            guard (s["alive"] as? Bool) ?? true,
                  let id = s["id"] as? String, shown.contains(id),
                  let wait = s["waitingOn"] as? [String: Any] else { return nil }
            return "\(id):\(wait["phase"] as? String ?? ""):\((wait["agentWaiting"] as? Bool) == true)"
        }
        let scene = (marks.marks.map { "\($0.glyph):\($0.state.rawValue):\($0.sick)" } + ["+\(marks.overflow)"] + ci)
            .joined(separator: "|")
        func pct(_ v: Double?) -> String { v.map { String(Int($0.rounded(.down))) } ?? "-" }
        let cx = usage.codexRateLimits
        let zai = usage.zaiRateLimits
        let hud = [
            pct(usage.fiveHourPercent), pct(usage.sevenDayPercent),
            usage.fiveHourResetsAt ?? "", usage.sevenDayResetsAt ?? "",
            pct(cx?.primary?.usedPercent), pct(cx?.secondary?.usedPercent),
            "\(usage.usageStale == true)", "\(cx?.primary?.stale == true)", "\(cx?.secondary?.stale == true)",
            pct(zai?.primary?.usedPercent), pct(zai?.secondary?.usedPercent),
            "\(zai?.primary?.stale == true)", "\(zai?.secondary?.stale == true)",
            usage.codexSubscriptionActiveUntil ?? "",
        ].joined(separator: "|")
        return Signature(scene: scene, hud: hud)
    }

    /// Pure: what the module does about one tide device this tick.
    static func decision(
        signature sig: Signature,
        uploaded: UploadRecord?,
        lastAttemptAt: Date?,
        retryAt: Date?,
        now: Date
    ) -> Decision {
        if let retryAt, now < retryAt { return .wait }
        guard let uploaded else { return .upload }
        let sinceUpload = now.timeIntervalSince(uploaded.at)
        let sceneChanged = sig.scene != uploaded.signature.scene
        let hudChanged = sig.hud != uploaded.signature.hud
        if sceneChanged && sinceUpload >= Policy.sceneFloor { return .upload }
        if !sceneChanged && hudChanged && sinceUpload >= Policy.hudFloor { return .upload }
        let sinceAttempt = lastAttemptAt.map { now.timeIntervalSince($0) } ?? .infinity
        return sinceAttempt >= Policy.verify ? .verify : .wait
    }
}

// MARK: - Rendering

extension PixooRenderer {
    private typealias Tide = PixooTide

    // Palette (flat, saturated, LED-readable)
    private static let tideAir: RGB = (6, 18, 32)
    private static let tideBands: [RGB] = [
        (30, 138, 178), (24, 116, 160), (18, 92, 140), (13, 70, 116), (9, 51, 94), (6, 36, 70),
    ]
    private static let tideCrest: RGB = (176, 242, 255)
    private static let tideCrestBody: RGB = (74, 184, 218)
    private static let tideSandTop: RGB = (214, 176, 110)
    private static let tideSand: RGB = (168, 132, 78)
    private static let tidePebble: RGB = (118, 92, 56)
    private static let tideWeed: RGB = (34, 168, 92)
    private static let tideWeedTip: RGB = (76, 208, 124)
    private static let tideBubble: RGB = (220, 245, 255)
    private static let tideFishBody: RGB = (96, 224, 238)
    private static let tideFishTail: RGB = (255, 112, 82)
    private static let tideAmber: RGB = (255, 176, 32)
    private static let tideWhite: RGB = (255, 255, 255)
    private static let tideText: RGB = (200, 230, 240)

    private static let tau = Double.pi * 2

    /// Waterline height at column x. One wavelength travels 1 cycle per loop.
    private func tideWaveY(_ x: Int, _ t: Int) -> Int {
        3 + Tide.jsRound(1.3 * sin(Self.tau * (Double(x) / 20 - Double(t) / Double(Tide.frames))))
    }

    private func drawTideWater(_ buf: inout [UInt8], t: Int, floorTop: Int) {
        let span = floorTop - Tide.waterTop
        let bands = Self.tideBands
        for x in 0..<Tide.size {
            let wy = tideWaveY(x, t)
            for y in 0..<max(0, floorTop) {
                if y < wy { setPixel(&buf, x, y, Self.tideAir); continue }
                let f = max(0, Double(y - Tide.waterTop) / Double(span)) * Double(bands.count)
                var band = min(bands.count - 1, Int(f.rounded(.down)))
                // Dither the seam so a flat band edge reads as a soft step, not a stripe.
                if f - f.rounded(.down) > 0.7 && band < bands.count - 1 && ((x + y) & 1) == 0 { band += 1 }
                setPixel(&buf, x, y, bands[band])
            }
            setPixel(&buf, x, wy, ((x * 3 + t * 2) % 12) < 2 ? Self.tideWhite : Self.tideCrest)
            setPixel(&buf, x, wy + 1, Self.tideCrestBody)
        }
    }

    private static let tidePebbles: [(x: Int, r: Int)] = [
        (3, 1), (11, 2), (18, 1), (27, 3), (33, 1), (41, 2), (49, 1), (56, 3), (61, 2),
    ]

    private func drawTideFloor(_ buf: inout [UInt8], floorTop: Int) {
        for x in 0..<Tide.size {
            setPixel(&buf, x, floorTop, Self.tideSandTop)
            for r in 1..<Tide.floorRows { setPixel(&buf, x, floorTop + r, Self.tideSand) }
        }
        for pebble in Self.tidePebbles { setPixel(&buf, pebble.x, floorTop + pebble.r, Self.tidePebble) }
    }

    private static let tideWeeds: [(x: Int, h: Int)] = [(5, 9), (21, 7), (43, 10), (58, 8)]

    private func drawTideSeaweed(_ buf: inout [UInt8], t: Int, floorTop: Int) {
        for (k, weed) in Self.tideWeeds.enumerated() {
            for i in 0..<weed.h {
                let sway = Tide.jsRound(1.5 * sin(Self.tau * Double(t) / Double(Tide.frames) + Double(i) * 0.5 + Double(k) * 1.3)
                    * (Double(i) / Double(weed.h)))
                setPixel(&buf, weed.x + sway, floorTop - 1 - i, i > weed.h - 3 ? Self.tideWeedTip : Self.tideWeed)
            }
        }
    }

    private static let tideBubbleX = [11, 24, 38, 50, 57, 5]

    private func drawTideBubbles(_ buf: inout [UInt8], t: Int, floorTop: Int, count: Int) {
        let span = floorTop - Tide.waterTop - 1
        guard span > 0 else { return }
        // t·span/frames is `span` on the last frame, i.e. 0 mod span: the rise closes.
        let rise = t * span / Tide.frames
        for k in 0..<count {
            let oy = (k * 13) % span
            let y = Tide.waterTop + span - 1 - ((oy + rise) % span)
            let x = Self.tideBubbleX[k] + Tide.jsRound(sin(Self.tau * Double(t) / Double(Tide.frames) + Double(k)))
            blendPixel(&buf, x, y, Self.tideBubble, 0.65)
        }
    }

    private func drawTideFish(_ buf: inout [UInt8], t: Int, floorTop: Int) {
        let span = Double(floorTop - Tide.waterTop - 10)
        // Two identical fish half a panel apart: after one loop each stands where the
        // other began, so the loop closes while each crosses 32 px per 3 s.
        for k in 0..<2 {
            let x = (Double(k * 32) + Double(t * 32) / Double(Tide.frames)).truncatingRemainder(dividingBy: Double(Tide.size))
            let y = Tide.jsRound(Double(Tide.waterTop + 5) + span * (0.5 + 0.5 * sin(Self.tau * x / Double(Tide.size) + 1)))
            let ix = Tide.jsRound(x)
            for ox in [ix, ix - Tide.size] {
                for b in 0..<4 { setPixel(&buf, ox - b, y, Self.tideFishBody) }
                setPixel(&buf, ox - 1, y - 1, Self.tideFishBody)
                setPixel(&buf, ox - 2, y - 1, Self.tideFishBody)
                setPixel(&buf, ox - 4, y - (t % 2), Self.tideFishTail)
            }
        }
    }

    private func drawTideMark(_ buf: inout [UInt8], mark: PixooTide.Mark, index: Int, cx: Int, cy: Int, size: Int, t: Int) {
        let frames = Double(Tide.frames)
        let phase = Self.tau * Double(t + index * 3) / frames
        let bob: Int
        switch mark.state {
        case .processing: bob = Tide.jsRound(2 * sin(phase))
        case .idle: bob = Tide.jsRound(sin(phase))
        case .awaiting: bob = 0
        }
        let y = cy + bob
        let x0 = Tide.jsRound(Double(cx) - Double(size) / 2)
        let y0 = Tide.jsRound(Double(y) - Double(size) / 2)

        if mark.state == .awaiting {
            // The only pulse on the panel (amber = needs you): a dotted ring.
            let pulse = 0.35 + 0.65 * (0.5 + 0.5 * cos(Self.tau * Double(t) / frames))
            let r = Double(size) / 2 + 3
            for a in 0..<16 {
                let ang = Self.tau * Double(a) / 16
                blendPixel(&buf, Tide.jsRound(Double(cx) + cos(ang) * r), Tide.jsRound(Double(y) + sin(ang) * r), Self.tideAmber, pulse)
            }
        }

        // animFrame 0 keeps the sprite's own (unclosed) bob and pulse at rest; the
        // motion above and below is the loop's.
        let sprite: CreatureState = mark.state == .processing ? .processing : mark.state == .awaiting ? .awaiting : .idle
        drawOfficialDotGlyph(
            &buf, glyph: mark.glyph, worldX: Double(cx) / Double(Tide.size), worldY: Double(y) / Double(Tide.size),
            state: sprite, animFrame: 0, camera: Camera(cx: 0.5, cy: 0.5, zoom: 1),
            sessionToneIndex: index, sizeScale: Double(size) / 12, sick: mark.sick
        )

        if mark.state == .processing, let mask = OfficialDotGlyphs.masks[mark.glyph] {
            // A light band sweeps the mark once per loop — working, not just floating.
            let source = OfficialDotGlyphs.size
            let reach = Double(2 * size + 10)
            let p = Double(t) / frames * reach - 5
            for dy in 0..<size {
                let sy = min(source - 1, dy * source / size)
                for dx in 0..<size {
                    let sx = min(source - 1, dx * source / size)
                    if mask[sy * source + sx] < 128 { continue }
                    let d = abs(Double(dx + dy) - p)
                    if d < 2 { glowPixel(&buf, x0 + dx, y0 + dy, Self.tideWhite, 0.38 * (1 - d / 2)) }
                }
            }
        }
    }

    /// One frame of the loop (tick 0 … frames-1; tick == frames repeats tick 0).
    func renderTideFrame(
        dashboardState: DashboardState, marks resolved: PixooTide.Marks, nowMs: Double, tick: Int
    ) -> Data {
        let t = ((tick % Tide.frames) + Tide.frames) % Tide.frames
        var buf = [UInt8](repeating: 0, count: Tide.size * Tide.size * 3)
        let hudRows = hudProviderCount(from: dashboardState) * TerrariumRules.pixooUsageRowHeight
        let sceneH = Tide.size - hudRows
        let floorTop = sceneH - Tide.floorRows

        drawTideWater(&buf, t: t, floorTop: floorTop)
        drawTideFloor(&buf, floorTop: floorTop)
        drawTideSeaweed(&buf, t: t, floorTop: floorTop)
        drawTideFish(&buf, t: t, floorTop: floorTop)
        let busy = resolved.marks.contains { $0.state == .processing }
        drawTideBubbles(&buf, t: t, floorTop: floorTop, count: busy ? 6 : 2)

        let layout = PixooTide.layout[resolved.marks.count]
        let cy = Tide.jsRound(Double(Tide.waterTop + floorTop) / 2)
        var anchors: [CiCueAnchor] = []
        for (i, mark) in resolved.marks.enumerated() {
            let cx = layout.xs[i]
            drawTideMark(&buf, mark: mark, index: i, cx: cx, cy: cy, size: layout.size, t: t)
            anchors.append(CiCueAnchor(sessionId: mark.id, x: Double(cx), y: Double(cy), bodySize: Double(layout.size)))
        }
        if resolved.overflow > 0 {
            drawText(&buf, text: "+\(resolved.overflow)", rightX: Tide.size - 2, y: 1, color: Self.tideText)
        }

        // The CI companion is time-driven; the loop shows it frozen at `nowMs`.
        drawCiCue(&buf, size: Tide.size, state: dashboardState, now: nowMs, anchors: anchors, tiny: false, bottom: sceneH)
        drawUsageHUD(&buf, dashboardState: dashboardState, animFrame: 0)
        return Data(buf)
    }

    /// The frames of one closed device loop, played at `PixooTide.picSpeedMs`.
    func renderTideLoop(dashboardState: DashboardState, marks: PixooTide.Marks, nowMs: Double) -> [Data] {
        (0..<Tide.frames).map { renderTideFrame(dashboardState: dashboardState, marks: marks, nowMs: nowMs, tick: $0) }
    }
}
#endif
