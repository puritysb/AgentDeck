#if os(macOS)
// TrmnlImageRenderer.swift — renders the AgentDeck dashboard to a 1-bit (B/W)
// grayscale PNG for a TRMNL/BYOS e-ink panel, at an arbitrary device resolution.
//
// App Store safe: uses only first-party frameworks (CoreGraphics for drawing,
// CoreText for text, Foundation's zlib for PNG IDAT). No resvg, no Node, no
// subprocess. This is the Swift counterpart of bridge/src/trmnl/image-renderer.ts
// + shared/src/trmnl-layout.ts — it does NOT reuse the TypeScript SVG; it draws
// the equivalent monochrome layout directly with CoreGraphics (same approach the
// D200H button renderer uses).

import Foundation
import AppKit
import CoreGraphics
import CoreText

enum TrmnlImageRenderer {

    private enum Align { case left, center, right }

    /// Render the dashboard to a 1-bit grayscale PNG at `width`×`height`.
    static func renderPng(_ state: TrmnlDashState, width: Int, height: Int) -> Data {
        let w = max(1, width)
        let h = max(1, height)
        let bytesPerRow = w // DeviceGray, 1 byte/pixel
        var gray = [UInt8](repeating: 0xFF, count: bytesPerRow * h)

        gray.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress,
                  let ctx = CGContext(
                      data: base, width: w, height: h,
                      bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                      space: CGColorSpaceCreateDeviceGray(),
                      bitmapInfo: CGImageAlphaInfo.none.rawValue
                  )
            else { return }
            draw(state, ctx: ctx, width: w, height: h)
        }

        return encode1BitPng(fromGray: gray, width: w, height: h, grayRowBytes: bytesPerRow)
    }

    // MARK: - Drawing (top-down coordinates; flipped into CG's bottom-left origin)

    private static func draw(_ state: TrmnlDashState, ctx: CGContext, width: Int, height: Int) {
        let W = CGFloat(width)
        let H = CGFloat(height)
        let black = CGColor(gray: 0, alpha: 1)
        let white = CGColor(gray: 1, alpha: 1)

        func fill(_ x: CGFloat, _ y: CGFloat, _ ww: CGFloat, _ hh: CGFloat, _ c: CGColor) {
            ctx.setFillColor(c)
            ctx.fill(CGRect(x: x, y: H - y - hh, width: ww, height: hh))
        }
        func stroke(_ x: CGFloat, _ y: CGFloat, _ ww: CGFloat, _ hh: CGFloat, _ lw: CGFloat) {
            ctx.setStrokeColor(black)
            ctx.setLineWidth(lw)
            ctx.stroke(CGRect(x: x, y: H - y - hh, width: ww, height: hh).insetBy(dx: lw / 2, dy: lw / 2))
        }
        func textWidth(_ s: String, _ size: CGFloat, _ bold: Bool, _ mono: Bool) -> CGFloat {
            let line = CTLineCreateWithAttributedString(NSAttributedString(
                string: s, attributes: [.font: font(size, bold, mono)]))
            return CTLineGetBoundsWithOptions(line, []).width
        }
        func truncate(_ s: String, _ maxW: CGFloat, _ size: CGFloat, _ bold: Bool, _ mono: Bool) -> String {
            if textWidth(s, size, bold, mono) <= maxW { return s }
            var t = s
            while !t.isEmpty && textWidth(t + "…", size, bold, mono) > maxW { t.removeLast() }
            return t + "…"
        }
        func text(_ s: String, x: CGFloat, top: CGFloat, size: CGFloat, bold: Bool = false,
                  align: Align = .left, color: CGColor = black, mono: Bool = false) {
            guard !s.isEmpty else { return }
            let line = CTLineCreateWithAttributedString(NSAttributedString(
                string: s, attributes: [.font: font(size, bold, mono), .foregroundColor: color]))
            let b = CTLineGetBoundsWithOptions(line, [])
            let tx: CGFloat
            switch align {
            case .left: tx = x
            case .center: tx = x - b.width / 2
            case .right: tx = x - b.width
            }
            ctx.textPosition = CGPoint(x: tx, y: H - top - b.height)
            CTLineDraw(line, ctx)
        }

        // White paper background.
        fill(0, 0, W, H, white)

        // Canonical agent brand mark as a 1-bit glyph (robot / cloud-prompt / ring /
        // lobster) — the same paths the Node SVG layout uses, faithful to the
        // assets/logos creatures. 24-unit viewBox mapped to (gcx,gcy)+size with the
        // CG y-flip baked into one affine transform.
        func agentGlyph(_ agent: String, _ gcx: CGFloat, _ gcy: CGFloat, _ gsize: CGFloat) {
            let s = gsize / 24
            let t = CGAffineTransform(a: s, b: 0, c: 0, d: -s, tx: gcx - 12 * s, ty: H - gcy + 12 * s)
            let glyph = Self.agentMonoGlyph(agent)
            ctx.saveGState()
            ctx.concatenate(t)
            let p = CGMutablePath()
            for d in glyph.paths { SVGPath.append(d, to: p) }
            ctx.setFillColor(black); ctx.addPath(p); ctx.fillPath(using: .evenOdd)
            for eye in glyph.eyes {
                ctx.setFillColor(white)
                ctx.fillEllipse(in: CGRect(x: eye.0 - eye.2, y: eye.1 - eye.2, width: 2 * eye.2, height: 2 * eye.2))
            }
            ctx.restoreGState()
        }

        let pad: CGFloat = 24
        let headerH: CGFloat = 56
        let footerTop = H - 52         // single-line footer

        let n = state.sessions.count
        let working = state.sessions.filter { statusLabel($0.state) == "WORKING" }.count
        let awaitingSessions = state.sessions.filter { statusLabel($0.state) == "AWAITING" }
        let awaiting = awaitingSessions.count
        let summary = "\(n) session\(n == 1 ? "" : "s") · \(working) working · \(awaiting) awaiting"
        let subSummary = Self.subscriptionSummary(state.subscriptions)

        let bannerH: CGFloat = awaiting > 0 ? 44 : 0
        let bodyTop = headerH + 12 + bannerH
        // Adaptive row height: tall when few sessions, shrinking toward a floor as
        // the count grows so 6–9 sessions pack in before an overflow summary.
        let availH = footerTop - bodyTop
        let maxRowH: CGFloat = 58, minRowH: CGFloat = 42
        let capacityAtMin = max(1, Int((availH / minRowH).rounded(.down)))
        let desiredRows = min(max(1, n), capacityAtMin)
        let rowH = max(minRowH, min(maxRowH, (availH / CGFloat(desiredRows)).rounded(.down)))
        let maxRows = max(1, Int((availH / rowH).rounded(.down)))

        // Extreme-aspect / tiny-panel guard.
        if maxRows < 1 || W < 320 {
            text("AgentDeck", x: W / 2, top: H / 2 - 24, size: min(34, W * 0.09), bold: true, align: .center)
            text(summary, x: W / 2, top: H / 2 + 6, size: 14, bold: true, align: .center)
            return
        }

        // Header: wordmark + subscription/plan summary (with expiry) on the right.
        text("AgentDeck", x: pad, top: 12, size: 28, bold: true, align: .left)
        text(truncate(subSummary.isEmpty ? summary : subSummary, W * 0.62, 16, false, false),
             x: W - pad, top: 16, size: 16, bold: true, align: .right)
        fill(pad, headerH, W - 2 * pad, 2.5, black)

        // AWAITING banner (highest-priority glance signal).
        if bannerH > 0 {
            let by = headerH + 12
            let bh = bannerH - 8
            let label = "\(awaiting) agent\(awaiting == 1 ? "" : "s") need\(awaiting == 1 ? "s" : "") you"
            let projects = awaitingSessions
                .map { $0.projectName.isEmpty ? agentLabel($0.agentType) : $0.projectName }
                .joined(separator: ", ")
            fill(pad, by, W - 2 * pad, bh, black)
            text(label, x: pad + 16, top: by + bh / 2 - 14, size: 22, bold: true, align: .left, color: white)
            text(truncate(projects, W * 0.5, 16, false, false), x: W - pad - 16, top: by + bh / 2 - 10,
                 size: 16, bold: true, align: .right, color: white)
        }

        // Row geometry (icon/text scale per-row with the adaptive height).
        let badgeW = clampF((W * 0.17).rounded(), 108, 168)
        let badgeX = W - pad - badgeW
        // Per-row metrics: icon, text x, text width, project/desc font sizes, desc baseline.
        func metrics(_ rh: CGFloat) -> (icon: CGFloat, tx: CGFloat, tw: CGFloat, ps: CGFloat, ds: CGFloat, ddy: CGFloat) {
            let icon = clampF(rh - 16, 24, 36)
            let tx = pad + icon + 14
            return (icon, tx, badgeX - tx - 14, rh >= 54 ? 24 : rh >= 48 ? 21 : 19, rh >= 48 ? 15 : 13, rh >= 50 ? 19 : 16)
        }

        if n == 0 {
            let cy = (bodyTop + footerTop) / 2
            text("No active sessions", x: W / 2, top: cy - 26, size: 28, bold: true, align: .center)
            text("Start Claude Code, Codex, or OpenCode to see them here",
                 x: W / 2, top: cy + 8, size: 18, align: .center)
        } else {
            let overflow = max(0, n - maxRows)
            let showRows = overflow > 0 ? maxRows - 1 : maxRows
            let m = metrics(rowH)
            let visible = Array(state.sessions.prefix(showRows))
            for (i, s) in visible.enumerated() {
                let y = bodyTop + CGFloat(i) * rowH
                if i > 0 { fill(pad, y, W - 2 * pad, 1, black) }
                let status = statusLabel(s.state)
                let isAwaiting = status == "AWAITING"

                // Agent icon + project + description.
                agentGlyph(s.agentType, pad + m.icon / 2, y + rowH / 2, m.icon)
                let proj = truncate(s.projectName.isEmpty ? "(no project)" : s.projectName, m.tw, m.ps, true, false)
                text(proj, x: m.tx, top: y + rowH / 2 - m.ps - 1, size: m.ps, bold: true, align: .left)
                let desc = truncate(Self.sessionDescription(s), m.tw, m.ds, false, true)
                if !desc.isEmpty { text(desc, x: m.tx, top: y + rowH / 2 + m.ddy - 14, size: m.ds, align: .left, mono: true) }

                // Status badge.
                let badgeH = min(rowH - 16, 40)
                let badgeY = y + (rowH - badgeH) / 2
                if isAwaiting {
                    fill(badgeX, badgeY, badgeW, badgeH, black)
                    text(status, x: badgeX + badgeW / 2, top: badgeY + badgeH / 2 - 12,
                         size: 20, bold: true, align: .center, color: white)
                } else {
                    stroke(badgeX, badgeY, badgeW, badgeH, 1.5)
                    if status == "WORKING" {
                        let tx = badgeX + 18
                        let cyc = badgeY + badgeH / 2
                        ctx.setFillColor(black)
                        ctx.beginPath()
                        ctx.move(to: CGPoint(x: tx, y: H - (cyc - 7)))
                        ctx.addLine(to: CGPoint(x: tx + 12, y: H - cyc))
                        ctx.addLine(to: CGPoint(x: tx, y: H - (cyc + 7)))
                        ctx.closePath()
                        ctx.fillPath()
                        text(status, x: badgeX + badgeW / 2 + 10, top: badgeY + badgeH / 2 - 11,
                             size: 18, bold: true, align: .center)
                    } else {
                        text(status, x: badgeX + badgeW / 2, top: badgeY + badgeH / 2 - 11,
                             size: 18, align: .center)
                    }
                }
            }
            if overflow > 0 {
                let hidden = Array(state.sessions.suffix(n - showRows))
                let w = hidden.filter { statusLabel($0.state) == "WORKING" }.count
                let a = hidden.filter { statusLabel($0.state) == "AWAITING" }.count
                let idle = hidden.count - w - a
                var bits: [String] = []
                if w > 0 { bits.append("\(w) working") }
                if a > 0 { bits.append("\(a) awaiting") }
                if idle > 0 { bits.append("\(idle) idle") }
                let y = bodyTop + CGFloat(showRows) * rowH
                fill(pad, y, W - 2 * pad, 1, black)
                text("+\(hidden.count)", x: pad + m.icon / 2, top: y + rowH / 2 - 11, size: 20, bold: true, align: .center)
                let label = "\(hidden.count) more" + (bits.isEmpty ? "" : " · " + bits.joined(separator: " · "))
                text(label, x: m.tx, top: y + rowH / 2 - 10, size: 18, bold: true, align: .left)
            }
        }

        // Footer: 5H + 7D quota on one line, filling the width — label, a wide
        // gauge, the %, and a detailed "resets Hh Mm" right-aligned per half.
        fill(pad, footerTop, W - 2 * pad, 2, black)
        let usageKnown = state.usageKnown
        let fTop = footerTop + 18
        let gh: CGFloat = 18
        let colW = (W - 2 * pad) / 2
        let gaugeW = clampF((colW * 0.42).rounded(), 120, 240)

        func gauge(_ gx: CGFloat, _ gy: CGFloat, _ pct: Double) {
            stroke(gx, gy, gaugeW, gh, 1.5)
            let fw = (gaugeW * CGFloat(clampD(pct, 0, 100) / 100)).rounded()
            if fw > 0 { fill(gx, gy, fw, gh, black) }
        }
        func gaugeUnknown(_ gx: CGFloat, _ gy: CGFloat) {
            stroke(gx, gy, gaugeW, gh, 1.5)
            ctx.saveGState()
            ctx.clip(to: CGRect(x: gx, y: H - gy - gh, width: gaugeW, height: gh))
            ctx.setStrokeColor(black); ctx.setLineWidth(1)
            var hx = gx - gh
            while hx < gx + gaugeW {
                ctx.beginPath()
                ctx.move(to: CGPoint(x: hx, y: H - (gy + gh)))
                ctx.addLine(to: CGPoint(x: hx + gh, y: H - gy))
                ctx.strokePath()
                hx += 8
            }
            ctx.restoreGState()
        }
        func quotaInline(_ x0: CGFloat, _ label: String, _ pct: Double, _ resetsAt: String?) {
            let gx = x0 + 34
            let px = gx + gaugeW + 10
            text(label, x: x0, top: fTop, size: 18, bold: true)
            if usageKnown { gauge(gx, fTop, pct) } else { gaugeUnknown(gx, fTop) }
            text(usageKnown ? "\(Int(pct.rounded()))%" : "—", x: px, top: fTop, size: 18, mono: true)
            if usageKnown, let r = Self.fmtRemaining(resetsAt), !r.isEmpty {
                text("resets \(r)", x: x0 + colW - 12, top: fTop, size: 15, bold: true, align: .right)
            }
        }
        quotaInline(pad, "5H", state.fiveHourPercent, state.fiveHourResetsAt)
        quotaInline(pad + colW, "7D", state.sevenDayPercent, state.sevenDayResetsAt)
    }

    /// Reset countdown with two-unit detail: "3h 34m", "2d 20h", "45m". Mirrors
    /// trmnl-layout.ts fmtRemaining.
    private static func fmtRemaining(_ resetsAt: String?) -> String? {
        guard let s = resetsAt, let date = parseISO(s) else { return nil }
        let secs = Int(date.timeIntervalSinceNow.rounded())
        if secs <= 0 { return "now" }
        if secs >= 86400 {
            let d = secs / 86400, h = (secs % 86400) / 3600
            return h > 0 ? "\(d)d \(h)h" : "\(d)d"
        }
        if secs >= 3600 {
            let h = secs / 3600, m = (secs % 3600) / 60
            return m > 0 ? "\(h)h \(m)m" : "\(h)h"
        }
        return "\(max(1, secs / 60))m"
    }

    /// "Verb /long/path" → "Verb basename" so the description is signal, not a
    /// full path. Mirrors cleanAction() in trmnl-layout.ts.
    private static func cleanAction(_ raw: String) -> String {
        let s = raw.trimmingCharacters(in: .whitespaces)
        guard let sp = s.firstIndex(of: " ") else { return s }
        let verb = String(s[s.startIndex..<sp])
        let rest = String(s[s.index(after: sp)...]).trimmingCharacters(in: .whitespaces)
        let firstTok = rest.split(separator: " ").first.map(String.init) ?? ""
        if firstTok.contains("/") {
            let base = firstTok.split(separator: "/").last.map(String.init) ?? firstTok
            return "\(verb) \(base)"
        }
        return rest.count > 20 ? "\(verb) \(String(rest.prefix(19)))…" : "\(verb) \(rest)"
    }

    /// One-line "what is this session about": prefer the goal (first user prompt)
    /// over the live tool action; then model · elapsed.
    private static func sessionDescription(_ s: TrmnlSession) -> String {
        var parts: [String] = []
        let goal = s.goal.trimmingCharacters(in: .whitespaces)
        let headline = goal.isEmpty ? cleanAction(s.currentTask.isEmpty ? s.currentTool : s.currentTask) : goal
        if !headline.isEmpty { parts.append(headline) }
        if !s.modelName.isEmpty { parts.append(shortModel(s.modelName)) }
        if s.elapsedSec > 0 { parts.append(fmtElapsed(s.elapsedSec)) }
        return parts.joined(separator: " · ")
    }

    /// "claude-opus-4-8" → "opus-4-8". Mirrors shortModel in trmnl-layout.ts.
    private static func shortModel(_ m: String) -> String {
        var r = m
        if r.hasPrefix("claude-") { r = String(r.dropFirst(7)) }
        if r.hasPrefix("anthropic/") { r = String(r.dropFirst(10)) }
        if let range = r.range(of: "-[0-9]{8}$", options: .regularExpression) { r.removeSubrange(range) }
        return r
    }

    private static func fmtElapsed(_ secs: Int) -> String {
        if secs >= 3600 { return "\(secs / 3600)h" + String(format: "%02dm", (secs % 3600) / 60) }
        if secs >= 60 { return "\(secs / 60)m" }
        return "\(max(0, secs))s"
    }

    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    private static func fmtShortDate(_ iso: String?) -> String {
        guard let iso, let d = parseISO(iso) else { return "" }
        let c = Calendar.current.dateComponents([.month, .day], from: d)
        guard let m = c.month, let day = c.day, m >= 1, m <= 12 else { return "" }
        return "\(months[m - 1]) \(day)"
    }

    /// Header-right subscription summary: "Claude · ChatGPT Plus → Jun 30".
    private static func subscriptionSummary(_ subs: [TrmnlSubscription]) -> String {
        subs.map { s in
            let until = fmtShortDate(s.until)
            return until.isEmpty ? s.name : "\(s.name) → \(until)"
        }.joined(separator: "   ·   ")
    }

    // MARK: - Agent glyph (canonical brand marks, byte-mirrored from agent-logos.ts)

    // viewBox 0 0 24 24. Keep these in lockstep with shared/src/svg-renderers/
    // agent-logos.ts (ROBOT_CREATURE_PATH / CODEX_LOGO_PATH / OPENCODE_RING_PATH /
    // OPENCLAW_BODY_PATHS) so the e-ink panel renders the same creature on both daemons.
    private static let robotPath =
        "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0v-3.1h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
    private static let openCodePath = "M16 6H8v12h8V6zm4 16H4V2h16v20z"
    private static let codexPath =
        "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
    private static let openClawBody = [
        "M16.877 1.912c.58-.27 1.14-.323 1.616-.037a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.068-.352.165-.765.45-1.234.866 2.683 1.17 4.4 3.5 5.148 5.921a6.421 6.421 0 00-.704.184c-.578.016-1.174.204-1.502.735-.338.55-.268 1.276.072 2.069l.005.012.007.014c.523 1.045 1.318 1.91 2.2 2.284-.912 3.274-3.44 6.144-5.972 6.988v2.109h-2.11v-2.11c-1.043.417-2.086.01-2.11 0v2.11h-2.11v-2.11c-2.531-.843-5.061-3.713-5.973-6.987.882-.373 1.678-1.238 2.2-2.284l.007-.014.006-.012c.34-.793.41-1.518.071-2.069-.327-.531-.923-.719-1.503-.735a6.409 6.409 0 00-.704-.183c.749-2.421 2.466-4.751 5.149-5.922-.47-.416-.88-.701-1.234-.866-.474-.221-.794-.204-1.021-.068a.318.318 0 01-.435-.109.317.317 0 01.109-.433c.476-.286 1.036-.233 1.615.037.49.229 1.031.628 1.621 1.182A9.924 9.924 0 0112 2.568c1.199 0 2.284.19 3.256.526.59-.554 1.13-.953 1.62-1.182zM8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532zm6.33 0a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z",
        "M.395 13.118c-.966-1.932-.163-3.863 2.41-3.365v-.001l.05.01c.084.018.17.038.26.06.033.009.067.017.1.027.084.022.168.048.255.076l.09.027c.528 0 .95.158 1.16.501.212.343.212.87-.105 1.61-.085.17-.178.333-.276.489l-.01.017a4.967 4.967 0 01-.62.791l-.019.02c-1.092 1.117-2.496 1.336-3.295-.262z",
        "M21.193 9.753c2.574-.5 3.378 1.433 2.411 3.365-.58 1.159-1.476 1.361-2.342.96l-.011-.005a2.419 2.419 0 01-.114-.056l-.019-.01a2.751 2.751 0 01-.115-.067l-.023-.014c-.035-.022-.071-.044-.106-.068l-.05-.035c-.55-.388-1.062-1.007-1.44-1.76-.276-.647-.311-1.132-.174-1.472.176-.439.636-.639 1.23-.639.032-.011.066-.02.099-.03.08-.026.16-.05.238-.072l.117-.03a5.502 5.502 0 01.3-.067z",
    ]

    /// Canonical brand paths + optional white eye cutouts (mirrors AGENT_MONO_GLYPH).
    private static func agentMonoGlyph(_ agent: String) -> (paths: [String], eyes: [(CGFloat, CGFloat, CGFloat)]) {
        switch agent.lowercased() {
        case "claude-code", "claude": return ([robotPath], [])
        case "codex-cli", "codex-app", "codex": return ([codexPath], [])
        case "opencode": return ([openCodePath], [])
        default: return (openClawBody, [(8.835, 7.843, 1.05), (15.165, 7.843, 1.05)])
        }
    }

    // Reset timestamps vary: fractional seconds (sometimes microseconds, which
    // ISO8601DateFormatter rejects) and a `+00:00` offset. Try fractional, then
    // plain, then a fractional-stripped retry. Renders are infrequent (state change
    // / 10-min bucket) so local formatters avoid a non-Sendable static.
    private static func parseISO(_ s: String) -> Date? {
        let frac = ISO8601DateFormatter()
        frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = frac.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        if let d = plain.date(from: s) { return d }
        // Strip a ".NNN…" fractional-seconds run and retry the plain parser.
        if let dot = s.firstIndex(of: ".") {
            var end = s.index(after: dot)
            while end < s.endIndex, s[end].isNumber { end = s.index(after: end) }
            let stripped = s.replacingCharacters(in: dot..<end, with: "")
            return plain.date(from: stripped)
        }
        return nil
    }

    // MARK: - Layout helpers (ported from trmnl-layout.ts)

    private static let agentLabels: [String: String] = [
        "claude-code": "CLAUDE", "codex-cli": "CODEX", "codex-app": "CODEX",
        "codex": "CODEX", "opencode": "OPENCODE", "openclaw": "OPENCLAW", "daemon": "AGENT",
    ]

    private static func agentLabel(_ agentType: String) -> String {
        if let v = agentLabels[agentType] { return v }
        if agentType.isEmpty { return "AGENT" }
        return String(agentType.uppercased().prefix(8))
    }

    private static func statusLabel(_ state: String) -> String {
        let s = state.lowercased()
        if s.hasPrefix("awaiting") { return "AWAITING" }
        if s == "processing" { return "WORKING" }
        if s == "disconnected" { return "OFFLINE" }
        if s == "idle" || s.isEmpty { return "IDLE" }
        return String(s.uppercased().prefix(9))
    }

    private static func font(_ size: CGFloat, _ bold: Bool, _ mono: Bool) -> CTFont {
        let name: CFString = mono
            ? (bold ? "Menlo-Bold" : "Menlo") as CFString
            : (bold ? "HelveticaNeue-Bold" : "HelveticaNeue") as CFString
        return CTFontCreateWithName(name, size, nil)
    }

    private static func clampF(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { max(lo, min(hi, v)) }
    private static func clampD(_ v: Double, _ lo: Double, _ hi: Double) -> Double { max(lo, min(hi, v)) }

    // MARK: - 1-bit grayscale PNG encoding

    /// Threshold the 8-bit gray buffer (CG bottom-up) to a top-down 1-bit packed
    /// bitmap (1 = white, 0 = black) and encode as a grayscale PNG, bit depth 1.
    private static func encode1BitPng(fromGray gray: [UInt8], width: Int, height: Int, grayRowBytes: Int) -> Data {
        let rowBytes = (width + 7) / 8
        var packed = [UInt8](repeating: 0xFF, count: rowBytes * height)
        gray.withUnsafeBufferPointer { src in
            for y in 0..<height {
                let cgRow = (height - 1 - y) * grayRowBytes // CG buffer is bottom-up
                for x in 0..<width where src[cgRow + x] < 128 {
                    packed[y * rowBytes + (x >> 3)] &= ~(UInt8(0x80) >> UInt8(x & 7))
                }
            }
        }

        // Raw scanlines: filter byte (0 = None) + packed bits.
        var raw = Data(capacity: height * (1 + rowBytes))
        packed.withUnsafeBufferPointer { p in
            for y in 0..<height {
                raw.append(0)
                raw.append(UnsafeBufferPointer(start: p.baseAddress! + y * rowBytes, count: rowBytes))
            }
        }
        guard let compressed = try? (raw as NSData).compressed(using: .zlib) as Data else { return Data() }

        var png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        var ihdr = Data()
        ihdr.trmnlAppendBE32(UInt32(width))
        ihdr.trmnlAppendBE32(UInt32(height))
        ihdr.append(1) // bit depth
        ihdr.append(0) // color type: grayscale
        ihdr.append(0) // compression
        ihdr.append(0) // filter
        ihdr.append(0) // interlace
        png.trmnlAppendPNGChunk(type: [0x49, 0x48, 0x44, 0x52], data: ihdr)

        var idat = Data([0x78, 0x01]) // zlib CMF + FLG (NSData .zlib emits raw deflate)
        idat.append(compressed)
        idat.trmnlAppendBE32(adler32(raw))
        png.trmnlAppendPNGChunk(type: [0x49, 0x44, 0x41, 0x54], data: idat)

        png.trmnlAppendPNGChunk(type: [0x49, 0x45, 0x4E, 0x44], data: Data())
        return png
    }

    private static func adler32(_ data: Data) -> UInt32 {
        var a: UInt32 = 1
        var b: UInt32 = 0
        data.withUnsafeBytes { buf in
            guard let bytes = buf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for i in 0..<data.count {
                a = (a + UInt32(bytes[i])) % 65521
                b = (b + a) % 65521
            }
        }
        return (b << 16) | a
    }
}

// File-private PNG chunk helpers (DaemonServer has its own private equivalents).
private extension Data {
    mutating func trmnlAppendBE32(_ value: UInt32) {
        append(UInt8((value >> 24) & 0xff))
        append(UInt8((value >> 16) & 0xff))
        append(UInt8((value >> 8) & 0xff))
        append(UInt8(value & 0xff))
    }

    mutating func trmnlAppendPNGChunk(type: [UInt8], data: Data) {
        trmnlAppendBE32(UInt32(data.count))
        append(contentsOf: type)
        append(data)
        var crcData = Data(type)
        crcData.append(data)
        trmnlAppendBE32(crc32(crcData))
    }

    private func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xffffffff
        data.withUnsafeBytes { buf in
            guard let bytes = buf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for i in 0..<data.count {
                crc ^= UInt32(bytes[i])
                for _ in 0..<8 {
                    crc = (crc & 1) != 0 ? (0xEDB88320 ^ (crc >> 1)) : (crc >> 1)
                }
            }
        }
        return crc ^ 0xffffffff
    }
}

// Minimal SVG path-data → CGPath appender. Supports M m L l H h V v C c S s Q q
// T t A a Z z. Builds in the path's raw (y-down) coordinate space; the caller's
// CTM handles scale + the CG y-flip. Arcs are emitted as cubic-bézier segments
// (the AgentDeck brand marks only use circular arcs, rx≈ry), avoiding CGPath's
// orientation-dependent addArc semantics.
fileprivate enum SVGPath {
    static func append(_ d: String, to path: CGMutablePath) {
        var sc = Scanner2(Array(d.unicodeScalars))
        var cur = CGPoint.zero
        var startPt = CGPoint.zero
        var prevCubicCtrl: CGPoint?
        var prevQuadCtrl: CGPoint?
        while let c = sc.command() {
            let rel = c.isLowercase
            let u = Character(c.uppercased())
            func abs2(_ p: CGPoint) -> CGPoint { rel ? CGPoint(x: cur.x + p.x, y: cur.y + p.y) : p }
            switch u {
            case "M":
                cur = abs2(sc.point()); path.move(to: cur); startPt = cur
                while sc.hasNumber { cur = abs2(sc.point()); path.addLine(to: cur) }
                prevCubicCtrl = nil; prevQuadCtrl = nil
            case "L":
                while sc.hasNumber { cur = abs2(sc.point()); path.addLine(to: cur) }
                prevCubicCtrl = nil; prevQuadCtrl = nil
            case "H":
                while sc.hasNumber { let x = sc.num(); cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); path.addLine(to: cur) }
                prevCubicCtrl = nil; prevQuadCtrl = nil
            case "V":
                while sc.hasNumber { let y = sc.num(); cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); path.addLine(to: cur) }
                prevCubicCtrl = nil; prevQuadCtrl = nil
            case "C":
                while sc.hasNumber {
                    let c1 = abs2(sc.point()); let c2 = abs2(sc.point()); let e = abs2(sc.point())
                    path.addCurve(to: e, control1: c1, control2: c2); prevCubicCtrl = c2; cur = e
                }
                prevQuadCtrl = nil
            case "S":
                while sc.hasNumber {
                    let reflect = prevCubicCtrl.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                    let c2 = abs2(sc.point()); let e = abs2(sc.point())
                    path.addCurve(to: e, control1: reflect, control2: c2); prevCubicCtrl = c2; cur = e
                }
                prevQuadCtrl = nil
            case "Q":
                while sc.hasNumber {
                    let cc = abs2(sc.point()); let e = abs2(sc.point())
                    path.addQuadCurve(to: e, control: cc); prevQuadCtrl = cc; cur = e
                }
                prevCubicCtrl = nil
            case "T":
                while sc.hasNumber {
                    let cc = prevQuadCtrl.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                    let e = abs2(sc.point())
                    path.addQuadCurve(to: e, control: cc); prevQuadCtrl = cc; cur = e
                }
                prevCubicCtrl = nil
            case "A":
                while sc.hasNumber {
                    let rx = sc.num(); let ry = sc.num(); _ = sc.num() // x-axis-rotation (0 for our marks)
                    let large = sc.flag(); let sweep = sc.flag()
                    let e = abs2(sc.point())
                    arc(path, from: cur, to: e, radius: max(abs(rx), abs(ry)), large: large, sweep: sweep)
                    cur = e
                }
                prevCubicCtrl = nil; prevQuadCtrl = nil
            case "Z":
                path.closeSubpath(); cur = startPt
            default:
                break
            }
        }
    }

    /// Circular arc → cubic segments (≤90° each). Explicit point math so it doesn't
    /// depend on CGPath's coordinate-orientation-sensitive `clockwise` flag.
    private static func arc(_ path: CGMutablePath, from p0: CGPoint, to p1: CGPoint, radius r: CGFloat, large: Bool, sweep: Bool) {
        let dx = p1.x - p0.x, dy = p1.y - p0.y
        let dist = (dx * dx + dy * dy).squareRoot()
        if dist < 1e-9 { return }
        let rr = max(r, dist / 2)
        let mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2
        let hh = (rr * rr - dist * dist / 4).squareRoot()
        let ux = -dy / dist, uy = dx / dist
        let sgn: CGFloat = (large != sweep) ? 1 : -1
        let cx = mx + sgn * hh * ux, cy = my + sgn * hh * uy
        let a0 = atan2(p0.y - cy, p0.x - cx)
        let a1 = atan2(p1.y - cy, p1.x - cx)
        var span = a1 - a0
        if sweep { if span <= 0 { span += 2 * .pi } } else { if span >= 0 { span -= 2 * .pi } }
        let n = max(1, Int((abs(span) / (.pi / 2)).rounded(.up)))
        let seg = span / CGFloat(n)
        let k = (4.0 / 3.0) * tan(seg / 4)
        var ang = a0
        var pt = p0
        for _ in 0..<n {
            let a2 = ang + seg
            let e = CGPoint(x: cx + rr * cos(a2), y: cy + rr * sin(a2))
            let c1 = CGPoint(x: pt.x - k * rr * sin(ang), y: pt.y + k * rr * cos(ang))
            let c2 = CGPoint(x: e.x + k * rr * sin(a2), y: e.y - k * rr * cos(a2))
            path.addCurve(to: e, control1: c1, control2: c2)
            ang = a2; pt = e
        }
    }

    /// SVG-aware scanner: numbers (with compact "-1.5.5" / ".5.5" notation) and
    /// single-digit arc flags.
    private struct Scanner2 {
        let s: [Unicode.Scalar]
        var i = 0
        init(_ s: [Unicode.Scalar]) { self.s = s }
        private func isWsSep(_ c: Unicode.Scalar) -> Bool { c == " " || c == "," || c == "\n" || c == "\t" || c == "\r" }
        mutating func skipSep() { while i < s.count && isWsSep(s[i]) { i += 1 } }
        mutating func command() -> Character? {
            skipSep()
            while i < s.count {
                let c = s[i]
                if (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") { i += 1; return Character(c) }
                // implicit repeat: a number means repeat the previous command — but
                // append() loops on hasNumber per command, so a stray number here
                // shouldn't occur; bail to avoid an infinite loop.
                return nil
            }
            return nil
        }
        var hasNumber: Bool {
            var j = i
            while j < s.count && isWsSep(s[j]) { j += 1 }
            guard j < s.count else { return false }
            let c = s[j]
            return c == "-" || c == "+" || c == "." || (c >= "0" && c <= "9")
        }
        mutating func num() -> CGFloat {
            skipSep()
            var str = ""
            if i < s.count, s[i] == "-" || s[i] == "+" { str.unicodeScalars.append(s[i]); i += 1 }
            var seenDot = false
            while i < s.count {
                let c = s[i]
                if c >= "0" && c <= "9" { str.unicodeScalars.append(c); i += 1 }
                else if c == "." && !seenDot { seenDot = true; str.unicodeScalars.append(c); i += 1 }
                else if (c == "e" || c == "E") {
                    str.unicodeScalars.append(c); i += 1
                    if i < s.count, s[i] == "-" || s[i] == "+" { str.unicodeScalars.append(s[i]); i += 1 }
                } else { break }
            }
            return CGFloat(Double(str) ?? 0)
        }
        mutating func point() -> CGPoint { CGPoint(x: num(), y: num()) }
        mutating func flag() -> Bool {
            skipSep()
            guard i < s.count else { return false }
            let c = s[i]; i += 1
            return c == "1"
        }
    }
}
#endif
