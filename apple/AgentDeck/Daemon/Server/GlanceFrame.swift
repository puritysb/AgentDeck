#if os(macOS)
import Foundation
import ImageIO
import UniformTypeIdentifiers

import CGlanceRaster

enum GlanceFrame {
    struct Geometry: Sendable {
        var width: Int
        var height: Int
        var landscape: Bool
        var rotate = false
    }
    struct Rendered {
        let packed: Data
        let sig: String
        let width: Int
        let height: Int
        func png() throws -> Data {
            let stride = (width + 7) / 8
            var pixels = [UInt8](repeating: 0, count: width * height)
            let bits = [UInt8](packed)
            for y in 0..<height { for x in 0..<width {
                pixels[y * width + x] = bits[y * stride + x / 8] & (0x80 >> (x & 7)) != 0 ? 255 : 0
            } }
            let data = Data(pixels)
            guard let provider = CGDataProvider(data: data as CFData),
                  let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8,
                    bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: [],
                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
            else { throw Failure.raster }
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil)
            else { throw Failure.raster }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { throw Failure.raster }
            return output as Data
        }
    }
    enum Failure: Error { case fonts, raster, geometry }
    typealias L = GlancePolicy.Layout
    private static let sans = GlancePolicy.sans
    private static let mono = GlancePolicy.mono
    private static let gray = GlancePolicy.gray
    private static func number(_ value: Double) -> String {
        if value == value.rounded(), value >= Double(Int.min), value < Double(Int.max) { return String(Int(value)) }
        return String(value)
    }
    private static func value(_ object: [String: Any], _ key: String) -> Double? {
        guard let v = object[key] as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(), v.doubleValue.isFinite else { return nil }
        return v.doubleValue
    }
    private static func string(_ o: [String: Any], _ k: String) -> String { o[k] as? String ?? "" }
    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
    static func iconKey(_ code: Double?) -> String {
        guard let code, code.isFinite else { return "cloud" }
        return GlancePolicy.iconKey(code)
    }
    // ECMAScript whitespace, rather than Foundation's larger Unicode set.
    private static func whitespace(_ cp: UInt32) -> Bool {
        (9...13).contains(cp) || [0x20,0xA0,0x1680,0x2028,0x2029,0x202F,0x205F,0x3000,0xFEFF].contains(cp) || (0x2000...0x200A).contains(cp)
    }
    static func trimWhitespace(_ text: String, leading: Bool = true) -> String {
        let scalars = Array(text.unicodeScalars)
        let tail = scalars.reversed().drop(while: { whitespace($0.value) }).reversed()
        return String(String.UnicodeScalarView(leading ? Array(tail.drop(while: { whitespace($0.value) })) : Array(tail)))
    }
    private static func fit(_ s: String, _ maxWidth: Double, _ size: Double) -> String {
        func em(_ c: Unicode.Scalar) -> Double {
            if Double(c.value) >= L.cjkThreshold { return 1 }
            if whitespace(c.value) { return L.spaceEm }
            if "ilI1.,'`|!:;".unicodeScalars.contains(c) { return L.narrowEm }
            if "mwMW@#%&".unicodeScalars.contains(c) { return L.wideEm }
            return L.normalEm
        }
        if s.unicodeScalars.reduce(0, { $0 + em($1) * size }) <= maxWidth { return s }
        var out: [Unicode.Scalar] = []; var used = 0.0
        let suffixWidth = em("…") * size
        for c in s.unicodeScalars {
            let next = em(c) * size
            if used + next + suffixWidth > maxWidth { break }
            out.append(c); used += next
        }
        while let last = out.last, whitespace(last.value) { out.removeLast() }
        return String(String.UnicodeScalarView(out)) + "…"
    }
    private struct Context {
        var parts: [String] = []
        var width: Double
        mutating func text(_ x: Double, _ y: Double, _ size: Double, _ text: String,
                           weight: Int? = nil, mono: Bool = false, anchor: String? = nil,
                           fill: String = "black", spacing: Double? = nil) {
            guard !text.isEmpty else { return }
            var s = "<text x=\"\(number(x))\" y=\"\(number(y))\" font-family=\"\(mono ? GlanceFrame.mono : sans)\" font-size=\"\(number(size))\""
            if let weight { s += " font-weight=\"\(weight)\"" }
            if let anchor { s += " text-anchor=\"\(anchor)\"" }
            if let spacing { s += " letter-spacing=\"\(number(spacing))\"" }
            parts.append(s + " fill=\"\(fill)\">\(escape(text))</text>")
        }
        mutating func rule(_ x: Double, _ y: Double, _ end: Double, _ thick: Double = L.ruleWidth) {
            parts.append("<line x1=\"\(number(x))\" y1=\"\(number(y))\" x2=\"\(number(end))\" y2=\"\(number(y))\" stroke=\"black\" stroke-width=\"\(number(thick))\"/>")
        }
        mutating func section(_ x: Double, _ y: Double, _ title: String) {
            text(x, y, L.sectionSize, title, weight: 700, spacing: L.sectionSpacing)
            rule(x, y + L.sectionRuleOffset, width - L.margin)
        }
        mutating func quota(_ x: Double, _ y: Double, _ width: Double, _ row: [String: Any]) -> Double {
            text(x, y + L.quotaNameOffset, L.quotaNameSize, string(row,"label") + (row["stale"] as? Bool == true ? " *" : ""), weight: 600)
            let bx = x + L.barOffset, bw = width - L.barOffset
            for (offset, tag, key, extra) in [(L.primaryBarOffset,"5H","primaryPercent",string(row,"primaryResetHm")), (L.secondaryBarOffset,"7D","secondaryPercent","")] {
                guard let pct = value(row, key) else { continue }
                let by = y + offset, h = L.barHeight
                text(bx - L.barTagGap, by + h - L.barTagBaseline, L.barTagSize, tag, weight: 700, mono: true, anchor: "end")
                parts.append("<rect x=\"\(number(bx))\" y=\"\(number(by))\" width=\"\(number(bw))\" height=\"\(number(h))\" fill=\"white\" stroke=\"black\" stroke-width=\"\(number(L.ruleWidth))\"/>")
                let fw = floor(((bw - 2 * L.barInset) * min(100, max(0, pct))) / 100 + 0.5)
                if fw > 0 { parts.append("<rect x=\"\(number(bx + L.barInset))\" y=\"\(number(by + L.barInset))\" width=\"\(number(fw))\" height=\"\(number(h - 2 * L.barInset))\" fill=\"black\"/>") }
                let label = number(floor(pct + 0.5)) + "%" + (extra.isEmpty ? "" : " →" + extra)
                text(bx + bw - L.barLabelInset, by + h - L.barLabelBaseline, L.barLabelSize, label, mono: true, anchor: "end", fill: fw > bw - L.barLabelRoom ? "white" : "black")
            }
            return L.quotaHeight
        }
        mutating func weather(_ x: Double, _ start: Double, _ width: Double, _ w: [String: Any]) -> Double {
            var y = start
            parts.append("<g transform=\"translate(\(number(x)),\(number(y))) scale(\(number(L.iconSize / 100)))\">\(GlancePolicy.icons[iconKey(value(w,"code"))]!)</g>")
            if let temp = value(w,"tempC") { text(x + L.iconSize + L.iconTextGap, y + L.temperatureOffset, L.temperatureSize, number(temp) + "°", weight: 700) }
            let summary = string(w,"summary")
            if !summary.isEmpty { text(x + width, y + L.summaryOffset, L.summarySize, summary, weight: 600, anchor: "end") }
            if let lo = value(w,"todayMinC"), let hi = value(w,"todayMaxC") { text(x + width, y + L.rangeOffset, L.rangeSize, "\(number(lo))–\(number(hi))°", anchor: "end") }
            y += L.weatherHeight
            if let rain = w["rain"] as? [String: Any] {
                let end = string(rain,"endHm"), start = string(rain,"startHm")
                let range = end.isEmpty ? "~" + start : start + "–" + end
                let amount = value(rain,"amountMm").map { " · \(number($0)) mm" } ?? ""
                let prob = value(rain,"probability").map { " · \(number($0))%" } ?? ""
                text(x, y + L.rainBaseline, L.rainSize, "☂ Rain " + range + prob + amount, weight: 600)
                y += L.weatherLineHeight
            }
            if let t = w["tomorrow"] as? [String: Any], !string(t,"summary").isEmpty || value(t,"minC") != nil {
                var bits = ["Tomorrow"]
                if !string(t,"summary").isEmpty { bits.append(string(t,"summary")) }
                if let lo = value(t,"minC"), let hi = value(t,"maxC") { bits.append("\(number(lo))–\(number(hi))°") }
                if let prob = value(t,"rainProbability"), prob > 0 { bits.append("rain \(number(prob))%") }
                text(x, y + L.tomorrowBaseline, L.tomorrowSize, bits.joined(separator: "  ·  "))
                parts.append("<rect x=\"\(number(x))\" y=\"\(number(y + L.tomorrowRuleOffset))\" width=\"\(number(width))\" height=\"\(number(L.tomorrowRuleHeight))\" fill=\"\(gray)\"/>")
                y += L.weatherLineHeight
            }
            return y - start
        }
    }
    static func svg(glance g: [String: Any], serverHm: String, geometry: Geometry) -> String {
        let w = Double(geometry.width), h = Double(geometry.height), m = L.margin
        var c = Context(width: w)
        c.parts.append("<rect width=\"\(number(w))\" height=\"\(number(h))\" fill=\"white\"/>")
        c.text(m, L.mastheadY, L.mastheadSize, "AgentDeck", weight: 700, spacing: L.mastheadSpacing)
        let weather = g["weather"] as? [String: Any] ?? [:]
        let right = [string(weather,"place"), serverHm.isEmpty ? "" : "Synced " + serverHm].filter { !$0.isEmpty }.joined(separator: "  ·  ")
        c.text(w - m, L.mastheadY, L.mastheadRightSize, right, anchor: "end")
        c.rule(m, L.mastheadRuleY, w - m, L.mastheadRuleWidth)
        let colW = geometry.landscape ? floor((w - m * 2 - L.columnGap) / 2) : w - m * 2
        let rightX = m + colW + L.columnGap
        var yl = L.startY, yr = L.startY
        if value(weather,"tempC") != nil || !string(weather,"summary").isEmpty {
            yl += c.weather(m, yl, colW, weather) + L.weatherGap
        }
        let events = g["events"] as? [[String: Any]] ?? []
        if !events.isEmpty {
            c.section(m, yl, "TODAY"); yl += L.eventHeadingGap
            for event in events {
                let start = string(event,"startHm"), end = string(event,"endHm")
                let time = start.isEmpty ? "All day" : start + (end.isEmpty ? "" : "–" + end)
                c.text(m, yl, L.bodySize, fit(time + "  ·  " + string(event,"title"), colW, L.bodySize))
                yl += L.lineHeight
            }
            yl += L.sectionGap
        }
        let qx = geometry.landscape ? rightX : m, qw = geometry.landscape ? w - m - rightX : colW
        var qy = geometry.landscape ? yr : yl
        let usage = g["usage"] as? [[String: Any]] ?? []
        if !usage.isEmpty {
            c.section(qx, qy, "AI BUDGET"); qy += L.quotaHeadingGap
            for row in usage { qy += c.quota(qx, qy, qw, row) + L.quotaGap }
            qy += L.sectionGap
        }
        if geometry.landscape { yr = qy } else { yl = qy }
        let wx = geometry.landscape ? rightX : m, ww = geometry.landscape ? w - m - rightX : colW
        var wy = geometry.landscape ? yr : yl
        let wrapup = g["wrapup"] as? [String] ?? []
        c.section(wx, wy, "WORK"); wy += L.workHeadingGap
        if wrapup.isEmpty { c.text(wx, wy, L.bodySize, "No active sessions", fill: gray); wy += L.emptyWorkHeight }
        c.parts.append("<clipPath id=\"work\"><rect x=\"\(number(wx))\" y=\"\(number(wy - L.workClipTop))\" width=\"\(number(ww))\" height=\"\(number(h - wy - L.workClipBottom))\"/></clipPath>")
        c.parts.append("<g clip-path=\"url(#work)\">")
        for line in wrapup {
            if wy > h - L.workFooterRoom { break }
            c.parts.append("<circle cx=\"\(number(wx + L.bulletX))\" cy=\"\(number(wy - L.bulletY))\" r=\"\(number(L.bulletRadius))\" fill=\"black\"/>")
            c.text(wx + L.workTextInset, wy, L.bodySize, fit(line, ww - L.workTextInset, L.bodySize)); wy += L.lineHeight
        }
        c.parts.append("</g>")
        c.rule(m, h - L.footerRuleY, w - m)
        c.text(m, h - L.footerTextY, L.footerSize, "AGENTDECK · GLANCE", weight: 700, fill: gray, spacing: L.footerSpacing)
        return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(number(w))\" height=\"\(number(h))\" viewBox=\"0 0 \(number(w)) \(number(h))\" data-renderer=\"\(GlancePolicy.revision)\" data-fonts=\"\(GlancePolicy.fontSig)\" data-policy=\"\(GlancePolicy.policySig)\" data-rotate=\"\(geometry.rotate ? 1 : 0)\">" + c.parts.joined() + "</svg>"
    }
    static func geometry(board: String, width: String?, height: String?) -> Geometry {
        // Match JavaScript Number(query), including radix-prefixed dimensions.
        func number(_ text: String?) -> Double? {
            guard let text else { return 0 }
            let trimmed = trimWhitespace(text)
            if trimmed.isEmpty { return 0 }
            let prefixes = [("0x",16),("0b",2),("0o",8)]
            for (prefix, radix) in prefixes where trimmed.lowercased().hasPrefix(prefix) {
                return UInt64(trimmed.dropFirst(2), radix: radix).map { Double($0) }
            }
            return Double(trimmed)
        }
        if let w = number(width), let h = number(height), w.isFinite, h.isFinite,
           (128...1600).contains(w), (128...1600).contains(h) {
            return .init(width: Int(floor(w + 0.5)), height: Int(floor(h + 0.5)), landscape: w > h)
        }
        return GlancePolicy.boards[GlancePolicy.aliases[board] ?? board] ?? GlancePolicy.boards["xteink_x3"]!
    }
    static func signature(_ bytes: Data) -> String {
        var hash: UInt32 = 0x811c9dc5
        for byte in bytes { hash = (hash ^ UInt32(byte)) &* 0x01000193 }
        return String(format: "%08x", hash)
    }
    static func fontData(bundle: Bundle = .main) throws -> Data {
        var output = Data(), rawFonts = Data()
        for name in GlancePolicy.fonts {
            guard let url = bundle.url(forResource: (name as NSString).deletingPathExtension,
                withExtension: "ttf"), let data = try? Data(contentsOf: url) else { throw Failure.fonts }
            rawFonts.append(data)
            var length = UInt32(data.count).littleEndian
            withUnsafeBytes(of: &length) { output.append(contentsOf: $0) }
            output.append(data)
        }
        guard signature(rawFonts) == GlancePolicy.fontSig else { throw Failure.fonts }
        return output
    }
    static func pack(_ gray: [UInt8], width: Int, height: Int) -> Data {
        let stride = (width + 7) / 8
        var bytes = [UInt8](repeating: 0, count: stride * height)
        for y in 0..<height { for x in 0..<width {
            if gray[y * width + x] > GlancePolicy.bayer[y & 3][x & 3] {
                bytes[y * stride + x / 8] |= 0x80 >> (x & 7)
            }
        } }
        return Data(bytes)
    }
    static func render(glance: [String: Any], serverHm: String, geometry: Geometry, fonts: Data) throws -> Rendered {
        guard (128...1600).contains(geometry.width), (128...1600).contains(geometry.height) else { throw Failure.geometry }
        let svg = Data(svg(glance: glance, serverHm: serverHm, geometry: geometry).utf8)
        let count = geometry.width * geometry.height
        var rgba = [UInt8](repeating: 0, count: count * 4)
        let ok = svg.withUnsafeBytes { s in fonts.withUnsafeBytes { f in
            rgba.withUnsafeMutableBufferPointer { out in
                agentdeck_glance_rgba(s.bindMemory(to: UInt8.self).baseAddress!, svg.count,
                    f.bindMemory(to: UInt8.self).baseAddress!, fonts.count,
                    UInt32(geometry.width), UInt32(geometry.height), out.baseAddress!, out.count)
            }
        } }
        guard ok else { throw Failure.raster }
        var gray = [UInt8](repeating: 0, count: count)
        for i in 0..<count {
            let j = i * 4
            let luminance = (299 * Int(rgba[j]) + 587 * Int(rgba[j + 1]) + 114 * Int(rgba[j + 2]) + 500) / 1000
            let target = geometry.rotate ? (geometry.width - 1 - i % geometry.width) * geometry.height + i / geometry.width : i
            gray[target] = UInt8(luminance + 255 - Int(rgba[j + 3]))
        }
        let width = geometry.rotate ? geometry.height : geometry.width
        let height = geometry.rotate ? geometry.width : geometry.height
        return Rendered(packed: pack(gray, width: width, height: height),
            sig: signature(Data(self.svg(glance: glance, serverHm: "", geometry: geometry).utf8)), width: width, height: height)
    }
}
#endif
