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

        let pad: CGFloat = 24
        let headerH: CGFloat = 72
        let footerTop = H - 68
        let rowH: CGFloat = 64

        let n = state.sessions.count
        let working = state.sessions.filter { statusLabel($0.state) == "WORKING" }.count
        let awaitingSessions = state.sessions.filter { statusLabel($0.state) == "AWAITING" }
        let awaiting = awaitingSessions.count
        let summary = "\(n) session\(n == 1 ? "" : "s") · \(working) working · \(awaiting) awaiting"

        // An AWAITING agent is the top glance signal — give it a full-width inverted
        // banner above the rows (mirrors trmnl-layout.ts).
        let bannerH: CGFloat = awaiting > 0 ? 48 : 0
        let bodyTop = headerH + 14 + bannerH
        let maxRows = Int(((footerTop - bodyTop) / rowH).rounded(.down))

        // Extreme-aspect / tiny-panel guard.
        if maxRows < 1 || W < 320 {
            text("AgentDeck", x: W / 2, top: H / 2 - 24, size: min(34, W * 0.09), bold: true, align: .center)
            text(summary, x: W / 2, top: H / 2 + 6, size: 14, bold: true, align: .center)
            return
        }

        // Header.
        text("AgentDeck", x: pad, top: 14, size: 34, bold: true, align: .left)
        text(summary, x: W - pad, top: 26, size: 18, bold: true, align: .right)
        fill(pad, headerH, W - 2 * pad, 3, black)

        // AWAITING banner (highest-priority glance signal).
        if bannerH > 0 {
            let by = headerH + 14
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

        // Width-derived columns.
        let tagW = min(108, (W * 0.16).rounded())
        let badgeW = clampF((W * 0.19).rounded(), 120, 180)
        let badgeX = W - pad - badgeW
        let midX = pad + tagW + 18
        let midW = badgeX - midX - 18

        if n == 0 {
            // Idle hero (read-only — no action prompt).
            let cy = (bodyTop + footerTop) / 2
            text("No active sessions", x: W / 2, top: cy - 26, size: 28, bold: true, align: .center)
            text("Start Claude Code, Codex, or OpenCode to see them here",
                 x: W / 2, top: cy + 8, size: 18, align: .center)
        } else {
            let visible = Array(state.sessions.prefix(maxRows))
            for (i, s) in visible.enumerated() {
                let y = bodyTop + CGFloat(i) * rowH
                if i > 0 { fill(pad, y, W - 2 * pad, 1, black) }

                let status = statusLabel(s.state)
                let isAwaiting = status == "AWAITING"

                // Agent tag box.
                stroke(pad, y + 8, tagW, rowH - 16, 2)
                text(agentLabel(s.agentType), x: pad + tagW / 2, top: y + rowH / 2 - 11,
                     size: 18, bold: true, align: .center)

                // Project + model.
                let proj = truncate(s.projectName.isEmpty ? "(no project)" : s.projectName, midW, 24, true, false)
                text(proj, x: midX, top: y + rowH / 2 - 26, size: 24, bold: true, align: .left)
                if !s.modelName.isEmpty {
                    let model = truncate(s.modelName, midW, 16, false, true)
                    text(model, x: midX, top: y + rowH / 2 + 4, size: 16, align: .left, mono: true)
                }

                // Status badge.
                let badgeY = y + 12
                let badgeH = rowH - 24
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
            let overflow = n - visible.count
            if overflow > 0 {
                text("+\(overflow) more session\(overflow == 1 ? "" : "s")",
                     x: W / 2, top: bodyTop + CGFloat(maxRows) * rowH - 26, size: 16, bold: true, align: .center)
            }
        }

        // Footer: usage gauges + totals + timestamp, scaled to width.
        fill(pad, footerTop, W - 2 * pad, 2, black)
        let fTop = footerTop + 16
        let gaugeW = clampF((W * 0.18).rounded(), 110, 200)
        let g1Bar = pad + 34
        let g1Pct = g1Bar + gaugeW + 8
        let col2 = (W * 0.34).rounded()
        let g2Bar = col2 + 34
        let g2Pct = g2Bar + gaugeW + 8

        func gauge(_ x: CGFloat, _ pct: Double) {
            stroke(x, fTop, gaugeW, 16, 1.5)
            let fw = (gaugeW * CGFloat(clampD(pct, 0, 100) / 100)).rounded()
            if fw > 0 { fill(x, fTop, fw, 16, black) }
        }
        // "No data" gauge — outlined box with a sparse diagonal hatch so it reads as
        // "unavailable", not "0% filled".
        func gaugeUnknown(_ x: CGFloat) {
            stroke(x, fTop, gaugeW, 16, 1.5)
            ctx.saveGState()
            ctx.clip(to: CGRect(x: x, y: H - fTop - 16, width: gaugeW, height: 16))
            ctx.setStrokeColor(black)
            ctx.setLineWidth(1)
            var hx = x - 16
            while hx < x + gaugeW {
                ctx.beginPath()
                ctx.move(to: CGPoint(x: hx, y: H - (fTop + 16)))
                ctx.addLine(to: CGPoint(x: hx + 16, y: H - fTop))
                ctx.strokePath()
                hx += 8
            }
            ctx.restoreGState()
        }

        let usageKnown = state.usageKnown
        text("5H", x: pad, top: fTop, size: 16, bold: true)
        if usageKnown { gauge(g1Bar, state.fiveHourPercent) } else { gaugeUnknown(g1Bar) }
        text(usageKnown ? "\(Int(state.fiveHourPercent.rounded()))%" : "—", x: g1Pct, top: fTop, size: 16, mono: true)
        text("7D", x: col2, top: fTop, size: 16, bold: true)
        if usageKnown { gauge(g2Bar, state.sevenDayPercent) } else { gaugeUnknown(g2Bar) }
        text(usageKnown ? "\(Int(state.sevenDayPercent.rounded()))%" : "—", x: g2Pct, top: fTop, size: 16, mono: true)

        let cost = String(format: "%.2f", state.totalCost)
        var totals = "\(fmtTokens(state.totalTokens)) tok · $\(cost)"
        if !state.nowText.isEmpty { totals += "  ·  \(state.nowText)" }
        text(totals, x: W - pad, top: fTop, size: 16, align: .right, mono: true)
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

    private static func fmtTokens(_ n: Int) -> String {
        if n == 0 { return "0" }
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1000 {
            return n >= 10_000 ? "\(Int((Double(n) / 1000).rounded()))K"
                               : String(format: "%.1fK", Double(n) / 1000)
        }
        return String(n)
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
