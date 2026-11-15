// SvgPathParser.swift — SVG path-data parser shared by the terrarium creatures,
// brand marks and the Watch. Moved verbatim out of CrayfishCreature.

import SwiftUI

enum SvgPathParser {
    // MARK: - SVG Path Parser

    static func parseSvgPath(_ data: String) -> SwiftUI.Path {
        var path = SwiftUI.Path()
        let chars = Array(data)
        var idx = 0
        var currentX: CGFloat = 0
        var currentY: CGFloat = 0
        var startX: CGFloat = 0
        var startY: CGFloat = 0
        var lastCmd: Character = " "
        var lastCPX: CGFloat = 0
        var lastCPY: CGFloat = 0

        func skipWhitespaceAndCommas() {
            while idx < chars.count && (chars[idx] == " " || chars[idx] == "," || chars[idx] == "\n" || chars[idx] == "\r" || chars[idx] == "\t") {
                idx += 1
            }
        }

        func parseNumber() -> CGFloat? {
            skipWhitespaceAndCommas()
            guard idx < chars.count else { return nil }
            var numStr = ""
            if idx < chars.count && (chars[idx] == "-" || chars[idx] == "+") {
                numStr.append(chars[idx])
                idx += 1
            }
            var hasDot = false
            while idx < chars.count && (chars[idx].isNumber || (chars[idx] == "." && !hasDot)) {
                if chars[idx] == "." { hasDot = true }
                numStr.append(chars[idx])
                idx += 1
            }
            // Handle exponential notation
            if idx < chars.count && (chars[idx] == "e" || chars[idx] == "E") {
                numStr.append(chars[idx])
                idx += 1
                if idx < chars.count && (chars[idx] == "-" || chars[idx] == "+") {
                    numStr.append(chars[idx])
                    idx += 1
                }
                while idx < chars.count && chars[idx].isNumber {
                    numStr.append(chars[idx])
                    idx += 1
                }
            }
            return numStr.isEmpty ? nil : CGFloat(Double(numStr) ?? 0)
        }

        // SVG permits the two arc flags to be concatenated with each other and
        // the following coordinate (for example `0 110`). Consume exactly one
        // flag character so compact canonical brand paths are parsed correctly.
        func parseArcFlag() -> Bool? {
            skipWhitespaceAndCommas()
            guard idx < chars.count, chars[idx] == "0" || chars[idx] == "1" else { return nil }
            let value = chars[idx] == "1"
            idx += 1
            return value
        }

        while idx < chars.count {
            skipWhitespaceAndCommas()
            guard idx < chars.count else { break }

            var cmd = chars[idx]
            if cmd.isLetter {
                idx += 1
                lastCmd = cmd
            } else {
                cmd = lastCmd
            }

            switch cmd {
            case "M":
                guard let x = parseNumber(), let y = parseNumber() else { break }
                currentX = x; currentY = y; startX = x; startY = y
                path.move(to: CGPoint(x: x, y: y))
                lastCmd = "L"
            case "m":
                guard let dx = parseNumber(), let dy = parseNumber() else { break }
                currentX += dx; currentY += dy; startX = currentX; startY = currentY
                path.move(to: CGPoint(x: currentX, y: currentY))
                lastCmd = "l"
            case "L":
                guard let x = parseNumber(), let y = parseNumber() else { break }
                currentX = x; currentY = y
                path.addLine(to: CGPoint(x: x, y: y))
            case "l":
                guard let dx = parseNumber(), let dy = parseNumber() else { break }
                currentX += dx; currentY += dy
                path.addLine(to: CGPoint(x: currentX, y: currentY))
            case "H":
                guard let x = parseNumber() else { break }
                currentX = x
                path.addLine(to: CGPoint(x: currentX, y: currentY))
            case "h":
                guard let dx = parseNumber() else { break }
                currentX += dx
                path.addLine(to: CGPoint(x: currentX, y: currentY))
            case "V":
                guard let y = parseNumber() else { break }
                currentY = y
                path.addLine(to: CGPoint(x: currentX, y: currentY))
            case "v":
                guard let dy = parseNumber() else { break }
                currentY += dy
                path.addLine(to: CGPoint(x: currentX, y: currentY))
            case "C":
                guard let x1 = parseNumber(), let y1 = parseNumber(),
                      let x2 = parseNumber(), let y2 = parseNumber(),
                      let x = parseNumber(), let y = parseNumber() else { break }
                path.addCurve(to: CGPoint(x: x, y: y),
                              control1: CGPoint(x: x1, y: y1),
                              control2: CGPoint(x: x2, y: y2))
                lastCPX = x2; lastCPY = y2
                currentX = x; currentY = y
            case "c":
                guard let dx1 = parseNumber(), let dy1 = parseNumber(),
                      let dx2 = parseNumber(), let dy2 = parseNumber(),
                      let dx = parseNumber(), let dy = parseNumber() else { break }
                let x1 = currentX + dx1, y1 = currentY + dy1
                let x2 = currentX + dx2, y2 = currentY + dy2
                let x = currentX + dx, y = currentY + dy
                path.addCurve(to: CGPoint(x: x, y: y),
                              control1: CGPoint(x: x1, y: y1),
                              control2: CGPoint(x: x2, y: y2))
                lastCPX = x2; lastCPY = y2
                currentX = x; currentY = y
            case "S":
                guard let x2 = parseNumber(), let y2 = parseNumber(),
                      let x = parseNumber(), let y = parseNumber() else { break }
                let x1 = 2 * currentX - lastCPX
                let y1 = 2 * currentY - lastCPY
                path.addCurve(to: CGPoint(x: x, y: y),
                              control1: CGPoint(x: x1, y: y1),
                              control2: CGPoint(x: x2, y: y2))
                lastCPX = x2; lastCPY = y2
                currentX = x; currentY = y
            case "s":
                guard let dx2 = parseNumber(), let dy2 = parseNumber(),
                      let dx = parseNumber(), let dy = parseNumber() else { break }
                let x1 = 2 * currentX - lastCPX
                let y1 = 2 * currentY - lastCPY
                let x2 = currentX + dx2, y2 = currentY + dy2
                let x = currentX + dx, y = currentY + dy
                path.addCurve(to: CGPoint(x: x, y: y),
                              control1: CGPoint(x: x1, y: y1),
                              control2: CGPoint(x: x2, y: y2))
                lastCPX = x2; lastCPY = y2
                currentX = x; currentY = y
            case "Q":
                guard let cx = parseNumber(), let cy = parseNumber(),
                      let x = parseNumber(), let y = parseNumber() else { break }
                path.addQuadCurve(to: CGPoint(x: x, y: y),
                                  control: CGPoint(x: cx, y: cy))
                lastCPX = cx; lastCPY = cy
                currentX = x; currentY = y
            case "q":
                guard let dcx = parseNumber(), let dcy = parseNumber(),
                      let dx = parseNumber(), let dy = parseNumber() else { break }
                let cx = currentX + dcx, cy = currentY + dcy
                let x = currentX + dx, y = currentY + dy
                path.addQuadCurve(to: CGPoint(x: x, y: y),
                                  control: CGPoint(x: cx, y: cy))
                lastCPX = cx; lastCPY = cy
                currentX = x; currentY = y
            case "A", "a":
                let isRelative = cmd == "a"
                while let rx = parseNumber(), let ry = parseNumber(),
                      let xRotation = parseNumber(), let largeArc = parseArcFlag(),
                      let sweep = parseArcFlag(), let rawX = parseNumber(), let rawY = parseNumber() {
                    let endX = isRelative ? currentX + rawX : rawX
                    let endY = isRelative ? currentY + rawY : rawY
                    Self.svgArcToBeziers(
                        &path, cx: currentX, cy: currentY,
                        rx: abs(rx), ry: abs(ry),
                        xRotationDeg: xRotation,
                        largeArc: largeArc, sweep: sweep,
                        ex: endX, ey: endY
                    )
                    currentX = endX; currentY = endY
                }
            case "Z", "z":
                path.closeSubpath()
                currentX = startX; currentY = startY
            default:
                idx += 1
            }
        }

        return path
    }

    // MARK: - SVG Arc → Cubic Bezier (W3C SVG spec F.6)

    private static func svgArcToBeziers(
        _ path: inout SwiftUI.Path,
        cx: CGFloat, cy: CGFloat,
        rx inputRx: CGFloat, ry inputRy: CGFloat,
        xRotationDeg: CGFloat,
        largeArc: Bool, sweep: Bool,
        ex: CGFloat, ey: CGFloat
    ) {
        var rx = inputRx, ry = inputRy
        guard rx > 0 && ry > 0 else {
            path.addLine(to: CGPoint(x: ex, y: ey))
            return
        }
        if cx == ex && cy == ey { return }

        let phi = xRotationDeg * .pi / 180
        let cosPhi = cos(phi), sinPhi = sin(phi)

        // F.6.5.1: compute (x1', y1')
        let dx2 = (cx - ex) / 2, dy2 = (cy - ey) / 2
        let x1p = cosPhi * dx2 + sinPhi * dy2
        let y1p = -sinPhi * dx2 + cosPhi * dy2

        // F.6.6: ensure radii large enough
        let x1pSq = x1p * x1p, y1pSq = y1p * y1p
        var rxSq = rx * rx, rySq = ry * ry
        let lambda = x1pSq / rxSq + y1pSq / rySq
        if lambda > 1 {
            let s = sqrt(lambda)
            rx *= s; ry *= s
            rxSq = rx * rx; rySq = ry * ry
        }

        // F.6.5.2: compute (cx', cy')
        var sq = (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq)
        if sq < 0 { sq = 0 }
        var root = sqrt(sq)
        if largeArc == sweep { root = -root }
        let cxp = root * rx * y1p / ry
        let cyp = -root * ry * x1p / rx

        // F.6.5.3: compute (cx, cy) center
        let centerX = cosPhi * cxp - sinPhi * cyp + (cx + ex) / 2
        let centerY = sinPhi * cxp + cosPhi * cyp + (cy + ey) / 2

        // F.6.5.5-6: compute theta1 and dtheta
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let len = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
            var a = acos(max(-1, min(1, dot / len)))
            if ux * vy - uy * vx < 0 { a = -a }
            return a
        }

        let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if !sweep && dtheta > 0 { dtheta -= 2 * .pi }
        if sweep && dtheta < 0 { dtheta += 2 * .pi }

        // Split into segments of at most pi/2
        let segments = max(1, Int(ceil(abs(dtheta) / (.pi / 2))))
        let segAngle = dtheta / CGFloat(segments)

        for i in 0..<segments {
            let t1 = theta1 + CGFloat(i) * segAngle
            let t2 = t1 + segAngle
            let alpha = sin(segAngle) * (sqrt(4 + 3 * pow(tan(segAngle / 2), 2)) - 1) / 3

            let cos1 = cos(t1), sin1 = sin(t1)
            let cos2 = cos(t2), sin2 = sin(t2)

            let ep1x = rx * cos1, ep1y = ry * sin1
            let ep2x = rx * cos2, ep2y = ry * sin2

            let cp1x = cosPhi * (ep1x - alpha * rx * sin1) - sinPhi * (ep1y + alpha * ry * cos1) + centerX
            let cp1y = sinPhi * (ep1x - alpha * rx * sin1) + cosPhi * (ep1y + alpha * ry * cos1) + centerY
            let cp2x = cosPhi * (ep2x + alpha * rx * sin2) - sinPhi * (ep2y - alpha * ry * cos2) + centerX
            let cp2y = sinPhi * (ep2x + alpha * rx * sin2) + cosPhi * (ep2y - alpha * ry * cos2) + centerY
            let endPx = cosPhi * ep2x - sinPhi * ep2y + centerX
            let endPy = sinPhi * ep2x + cosPhi * ep2y + centerY

            path.addCurve(
                to: CGPoint(x: endPx, y: endPy),
                control1: CGPoint(x: cp1x, y: cp1y),
                control2: CGPoint(x: cp2x, y: cp2y)
            )
        }
    }
}
