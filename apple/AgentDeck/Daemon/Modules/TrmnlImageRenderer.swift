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

        func fillEllipseTD(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ c: CGColor) {
            ctx.setFillColor(c)
            ctx.fillEllipse(in: CGRect(x: x, y: H - y - h, width: w, height: h))
        }
        // Compact monochrome agent glyph (the creature language at 1-bit), 24-unit
        // box centered on (gcx,gcy). Mirrors agentGlyph() in trmnl-layout.ts.
        func agentGlyph(_ agent: String, _ gcx: CGFloat, _ gcy: CGFloat, _ gsize: CGFloat) {
            let s = gsize / 24
            func ux(_ u: CGFloat) -> CGFloat { gcx + (u - 12) * s }
            func uy(_ u: CGFloat) -> CGFloat { gcy + (u - 12) * s }
            func circ(_ cu: CGFloat, _ cv: CGFloat, _ ru: CGFloat, _ col: CGColor) {
                let r = ru * s; fillEllipseTD(ux(cu) - r, uy(cv) - r, 2 * r, 2 * r, col)
            }
            func ell(_ cu: CGFloat, _ cv: CGFloat, _ rxu: CGFloat, _ ryu: CGFloat, _ col: CGColor) {
                let rx = rxu * s, ry = ryu * s; fillEllipseTD(ux(cu) - rx, uy(cv) - ry, 2 * rx, 2 * ry, col)
            }
            func rct(_ x0: CGFloat, _ y0: CGFloat, _ wu: CGFloat, _ hu: CGFloat, _ col: CGColor) {
                fill(ux(x0), uy(y0), wu * s, hu * s, col)
            }
            let a = agent.lowercased()
            if a == "opencode" {
                let outer = CGRect(x: ux(4), y: H - uy(2) - 20 * s, width: 16 * s, height: 20 * s)
                let inner = CGRect(x: ux(8), y: H - uy(6) - 12 * s, width: 8 * s, height: 12 * s)
                let p = CGMutablePath(); p.addRect(outer); p.addRect(inner)
                ctx.setFillColor(black); ctx.addPath(p); ctx.fillPath(using: .evenOdd)
            } else if a.hasPrefix("codex") {
                circ(8, 12.5, 5, black); circ(16, 12.5, 5, black); circ(12, 8.5, 6, black); rct(3, 12, 18, 6, black)
                ctx.setStrokeColor(white); ctx.setLineWidth(1.8 * s); ctx.setLineCap(.round); ctx.setLineJoin(.round)
                ctx.beginPath()
                ctx.move(to: CGPoint(x: ux(9), y: H - uy(8.5)))
                ctx.addLine(to: CGPoint(x: ux(12.5), y: H - uy(11.5)))
                ctx.addLine(to: CGPoint(x: ux(9), y: H - uy(14.5)))
                ctx.strokePath()
                ctx.beginPath()
                ctx.move(to: CGPoint(x: ux(13.5), y: H - uy(14.5)))
                ctx.addLine(to: CGPoint(x: ux(16.5), y: H - uy(14.5)))
                ctx.strokePath()
                ctx.setLineCap(.butt); ctx.setLineJoin(.miter)
            } else if a == "claude-code" || a == "claude" {
                ell(12, 9.5, 8, 7, black)
                rct(4.6, 14, 2, 6.5, black); rct(8.4, 15, 2, 6, black)
                rct(11.6, 15, 2, 6, black); rct(15.4, 14, 2, 6.5, black)
                circ(9, 9, 1.7, white); circ(15, 9, 1.7, white)
            } else {
                circ(5.5, 7.5, 2.6, black); circ(18.5, 7.5, 2.6, black); ell(12, 13, 6, 7, black)
                circ(10, 11, 1.3, white); circ(14, 11, 1.3, white)
            }
        }

        let pad: CGFloat = 24
        let headerH: CGFloat = 56
        let footerTop = H - 52         // single-line footer
        let rowH: CGFloat = 58

        let n = state.sessions.count
        let working = state.sessions.filter { statusLabel($0.state) == "WORKING" }.count
        let awaitingSessions = state.sessions.filter { statusLabel($0.state) == "AWAITING" }
        let awaiting = awaitingSessions.count
        let summary = "\(n) session\(n == 1 ? "" : "s") · \(working) working · \(awaiting) awaiting"
        let subSummary = Self.subscriptionSummary(state.subscriptions)

        let bannerH: CGFloat = awaiting > 0 ? 44 : 0
        let bodyTop = headerH + 12 + bannerH
        let maxRows = Int(((footerTop - bodyTop) / rowH).rounded(.down))

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

        // Row geometry.
        let iconSize: CGFloat = 36
        let badgeW = clampF((W * 0.17).rounded(), 108, 168)
        let badgeX = W - pad - badgeW
        let textX = pad + iconSize + 14
        let textW = badgeX - textX - 16

        if n == 0 {
            let cy = (bodyTop + footerTop) / 2
            text("No active sessions", x: W / 2, top: cy - 26, size: 28, bold: true, align: .center)
            text("Start Claude Code, Codex, or OpenCode to see them here",
                 x: W / 2, top: cy + 8, size: 18, align: .center)
        } else {
            let overflow = max(0, n - maxRows)
            let showRows = overflow > 0 ? maxRows - 1 : maxRows
            let visible = Array(state.sessions.prefix(showRows))
            for (i, s) in visible.enumerated() {
                let y = bodyTop + CGFloat(i) * rowH
                if i > 0 { fill(pad, y, W - 2 * pad, 1, black) }
                let status = statusLabel(s.state)
                let isAwaiting = status == "AWAITING"

                // Agent icon + project + description.
                agentGlyph(s.agentType, pad + iconSize / 2, y + rowH / 2, iconSize)
                let proj = truncate(s.projectName.isEmpty ? "(no project)" : s.projectName, textW, 24, true, false)
                text(proj, x: textX, top: y + rowH / 2 - 25, size: 24, bold: true, align: .left)
                let desc = truncate(Self.sessionDescription(s), textW, 15, false, true)
                if !desc.isEmpty { text(desc, x: textX, top: y + rowH / 2 + 3, size: 15, align: .left, mono: true) }

                // Status badge.
                let badgeY = y + 11
                let badgeH = rowH - 22
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
                text("+\(hidden.count)", x: pad + iconSize / 2, top: y + rowH / 2 - 11, size: 20, bold: true, align: .center)
                let label = "\(hidden.count) more" + (bits.isEmpty ? "" : " · " + bits.joined(separator: " · "))
                text(label, x: textX, top: y + rowH / 2 - 10, size: 18, bold: true, align: .left)
            }
        }

        // Footer: 5H + 7D quota on one line (gauge + % + short reset).
        fill(pad, footerTop, W - 2 * pad, 2, black)
        let usageKnown = state.usageKnown
        let fTop = footerTop + 18
        let gh: CGFloat = 16
        let gaugeW = clampF((W * 0.14).rounded(), 80, 150)

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
            let px = gx + gaugeW + 8
            text(label, x: x0, top: fTop, size: 16, bold: true)
            if usageKnown { gauge(gx, fTop, pct) } else { gaugeUnknown(gx, fTop) }
            text(usageKnown ? "\(Int(pct.rounded()))%" : "—", x: px, top: fTop, size: 16, mono: true)
            if usageKnown, let r = Self.fmtRemainingShort(resetsAt), !r.isEmpty {
                text(r, x: px + 52, top: fTop, size: 14, bold: true)
            }
        }
        quotaInline(pad, "5H", state.fiveHourPercent, state.fiveHourResetsAt)
        quotaInline((W * 0.52).rounded(), "7D", state.sevenDayPercent, state.sevenDayResetsAt)
    }

    /// Very compact reset countdown for the one-line footer: "3h", "2d", "45m".
    /// Mirrors trmnl-layout.ts fmtRemainingShort.
    private static func fmtRemainingShort(_ resetsAt: String?) -> String? {
        guard let s = resetsAt, let date = parseISO(s) else { return nil }
        let secs = Int(date.timeIntervalSinceNow.rounded())
        if secs <= 0 { return "now" }
        if secs >= 86400 { return "\(secs / 86400)d" }
        if secs >= 3600 { return "\(secs / 3600)h" }
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

    /// One-line "what is this session doing": action · model · elapsed.
    private static func sessionDescription(_ s: TrmnlSession) -> String {
        var parts: [String] = []
        let raw = s.currentTask.isEmpty ? s.currentTool : s.currentTask
        let action = cleanAction(raw)
        if !action.isEmpty { parts.append(action) }
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
#endif
