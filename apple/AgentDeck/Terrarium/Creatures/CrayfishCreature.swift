// CrayfishCreature.swift — exact design/brand/openclaw.svg silhouette.

import SwiftUI

final class CrayfishCreature {
    private static let svgViewBox: Float = 24
    private static let eyePathData = [
        "M9.046 7.104a.527.527 0 110 1.055.527.527 0 010-1.055z",
        "M15.376 7.104a.528.528 0 110 1.056.528.528 0 010-1.056z",
    ]
    private static let bodyPathData = [
        "M16.877 1.912c.58-.27 1.14-.323 1.616-.037a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.068-.352.165-.765.45-1.234.866 2.683 1.17 4.4 3.5 5.148 5.921a6.421 6.421 0 00-.704.184c-.578.016-1.174.204-1.502.735-.338.55-.268 1.276.072 2.069l.005.012.007.014c.523 1.045 1.318 1.91 2.2 2.284-.912 3.274-3.44 6.144-5.972 6.988v2.109h-2.11v-2.11c-1.043.417-2.086.01-2.11 0v2.11h-2.11v-2.11c-2.531-.843-5.061-3.713-5.973-6.987.882-.373 1.678-1.238 2.2-2.284l.007-.014.006-.012c.34-.793.41-1.518.071-2.069-.327-.531-.923-.719-1.503-.735a6.409 6.409 0 00-.704-.183c.749-2.421 2.466-4.751 5.149-5.922-.47-.416-.88-.701-1.234-.866-.474-.221-.794-.204-1.021-.068a.318.318 0 01-.435-.109.317.317 0 01.109-.433c.476-.286 1.036-.233 1.615.037.49.229 1.031.628 1.621 1.182A9.924 9.924 0 0112 2.568c1.199 0 2.284.19 3.256.526.59-.554 1.13-.953 1.62-1.182zM8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532zm6.33 0a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z",
        "M.395 13.118c-.966-1.932-.163-3.863 2.41-3.365v-.001l.05.01c.084.018.17.038.26.06.033.009.067.017.1.027.084.022.168.048.255.076l.09.027c.528 0 .95.158 1.16.501.212.343.212.87-.105 1.61-.085.17-.178.333-.276.489l-.01.017a4.967 4.967 0 01-.62.791l-.019.02c-1.092 1.117-2.496 1.336-3.295-.262z",
        "M21.193 9.753c2.574-.5 3.378 1.433 2.411 3.365-.58 1.159-1.476 1.361-2.342.96l-.011-.005a2.419 2.419 0 01-.114-.056l-.019-.01a2.751 2.751 0 01-.115-.067l-.023-.014c-.035-.022-.071-.044-.106-.068l-.05-.035c-.55-.388-1.062-1.007-1.44-1.76-.276-.647-.311-1.132-.174-1.472.176-.439.636-.639 1.23-.639.032-.011.066-.02.099-.03.08-.026.16-.05.238-.072l.117-.03a5.502 5.502 0 01.3-.067z",
    ]
    private lazy var bodyPaths = Self.bodyPathData.map(Self.parseSvgPath)

    // MARK: - State

    var visualState: CrayfishVisualState = .dormant
    var visible = false

    private var time: Float = 0
    private var heartbeatPhase: Float = 0
    private var currentXFraction: Float
    private var currentYFraction: Float
    private let centerXFraction: Float
    private let centerYFraction: Float

    init(centerX: Float = TerrariumLayout.crayfishDefaultX,
         centerY: Float = TerrariumLayout.crayfishSittingY) {
        self.centerXFraction = centerX
        self.centerYFraction = centerY
        self.currentXFraction = centerX
        self.currentYFraction = centerY
    }

    // MARK: - Public API

    func currentPosition() -> (x: Float, y: Float) {
        (currentXFraction, currentYFraction)
    }

    func isRouting() -> Bool {
        visualState == .routing
    }

    // MARK: - Update

    func update(dt: Float, state: TerrariumState) {
        time += dt
        heartbeatPhase += dt
        visible = state.crayfishVisible

        guard visible else { return }
        visualState = state.crayfishState
    }

    // MARK: - Draw

    func draw(context: inout GraphicsContext, size: CGSize) {
        guard visible else { return }

        let w = Float(size.width)
        let h = Float(size.height)
        let cx = w * centerXFraction
        let cy = h * centerYFraction
        let bodyWidth = w * TerrariumLayout.crayfishWidthFraction

        // Effective position (state-dependent)
        let effectiveCX: Float
        let effectiveCY: Float
        switch visualState {
        case .dormant:
            effectiveCX = cx
            effectiveCY = cy + bodyWidth * 0.3
        case .routing:
            effectiveCX = cx
            effectiveCY = cy + sin(time * 3) * bodyWidth * 0.05
        case .sitting:
            effectiveCX = cx
            effectiveCY = cy + sin(time * 0.5) * bodyWidth * 0.008
        case .sick:
            effectiveCX = cx
            effectiveCY = cy + bodyWidth * 0.08 + sin(time * 0.7) * bodyWidth * 0.02
        default:
            effectiveCX = cx
            effectiveCY = cy
        }

        currentXFraction = effectiveCX / w
        currentYFraction = effectiveCY / h

        let alpha: Float = switch visualState {
        case .dormant: 0.4
        case .sick: 0.7
        default: 1.0
        }

        // Signal waves BEHIND creature
        if visualState == .routing {
            drawSignalWaves(context: &context, cx: CGFloat(effectiveCX), cy: CGFloat(effectiveCY),
                            bodyW: CGFloat(bodyWidth), canvasW: CGFloat(w))
        }

        // Shell glow pulse (ROUTING)
        if visualState == .routing {
            let glowPulse = (sin(time * 4) * 0.5 + 0.5)
            let glowRadius = CGFloat(bodyWidth) * CGFloat(0.4 + glowPulse * 0.15)
            let glowRect = CGRect(x: CGFloat(effectiveCX) - glowRadius,
                                  y: CGFloat(effectiveCY) - glowRadius,
                                  width: glowRadius * 2, height: glowRadius * 2)
            context.fill(Path(ellipseIn: glowRect),
                         with: .color(TerrariumColors.crayfishEye.opacity(Double(0.15 * glowPulse))))
        }

        // Heartbeat glow (SITTING)
        if visualState == .sitting {
            let cycle = heartbeatPhase.truncatingRemainder(dividingBy: 4.0)
            var pulse: Float = 0
            if cycle < 0.15 {
                pulse = sin(cycle / 0.15 * .pi)
            } else if cycle >= 0.25 && cycle < 0.40 {
                pulse = sin((cycle - 0.25) / 0.15 * .pi) * 0.6
            }
            if pulse > 0.01 {
                let glowRadius = CGFloat(bodyWidth) * CGFloat(0.25 + pulse * 0.08)
                let glowRect = CGRect(x: CGFloat(effectiveCX) - glowRadius,
                                      y: CGFloat(effectiveCY) - glowRadius,
                                      width: glowRadius * 2, height: glowRadius * 2)
                context.fill(Path(ellipseIn: glowRect),
                             with: .color(TerrariumColors.crayfishEye.opacity(Double(0.08 * pulse))))
            }
        }

        // Draw SVG creature
        drawSvgCreature(context: &context,
                        cx: CGFloat(effectiveCX), cy: CGFloat(effectiveCY),
                        bodyWidth: CGFloat(bodyWidth), alpha: Double(alpha))
    }

    // MARK: - SVG Creature Drawing

    private func drawSvgCreature(context: inout GraphicsContext,
                                 cx: CGFloat, cy: CGFloat,
                                 bodyWidth: CGFloat, alpha: Double) {
        let scale = bodyWidth / CGFloat(Self.svgViewBox)
        let offsetX = cx - CGFloat(Self.svgViewBox) / 2 * scale
        let offsetY = cy - CGFloat(Self.svgViewBox) / 2 * scale
        let sickTilt: Angle = visualState == .sick ? .degrees(-12) : .zero

        context.drawLayer { ctx in
            ctx.translateBy(x: offsetX, y: offsetY)
            ctx.scaleBy(x: scale, y: scale)

            if sickTilt != .zero {
                let pivot = CGFloat(Self.svgViewBox) / 2
                ctx.translateBy(x: pivot, y: pivot)
                ctx.rotate(by: sickTilt)
                ctx.translateBy(x: -pivot, y: -pivot)
            }

            let fillColor = shellColorForState()

            for path in bodyPaths {
                ctx.fill(path, with: .color(fillColor.opacity(alpha)), style: FillStyle(eoFill: true))
            }
            CreatureBrandFeatures.draw("openclaw", context: ctx)
        }
    }

    // MARK: - State-dependent appearance

    private func shellColorForState() -> Color {
        switch visualState {
        case .routing:
            let pulse = (sin(time * 4) * 0.5 + 0.5) * 0.3
            return lerpColor(TerrariumColors.crayfishShell, TerrariumColors.crayfishBodyLight, Float(pulse))
        case .sick:
            return lerpColor(TerrariumColors.crayfishShell, Color(red: 0.545, green: 0.482, blue: 0.482), 0.55)
        default:
            return TerrariumColors.crayfishShell
        }
    }

    private func clawAngle(side: Float) -> Float {
        switch visualState {
        case .routing:
            let period = TerrariumTiming.clawClapPeriod
            let phase = time * 2 * Float.pi / period
            return side * sin(phase + side * 0.3) * 28
        case .sitting:
            return side * sin(time * 0.4) * 1.5
        case .waiting:
            return side * 15
        case .observing:
            return side * (3 + sin(time * 2) * 5)
        case .sick:
            return side * (-8 + sin(time * 0.5) * 2)
        case .dormant:
            return 0
        }
    }

    // MARK: - Signal Waves + Orbiting Dots

    private func drawSignalWaves(context: inout GraphicsContext,
                                 cx: CGFloat, cy: CGFloat,
                                 bodyW: CGFloat, canvasW: CGFloat) {
        let waveSpeed = time * 2
        let maxRadius = canvasW * 0.15

        // 4 expanding arcs
        for i in 0..<4 {
            let progress = (waveSpeed + Float(i) * 0.25).truncatingRemainder(dividingBy: 1.0)
            let radius = bodyW * 0.3 + CGFloat(progress) * maxRadius
            let waveAlpha = Double(1 - progress) * 0.35
            let lineWidth = 3 + CGFloat(1 - progress) * 2

            let arcPath = Path { p in
                p.addArc(center: CGPoint(x: cx, y: cy),
                         radius: radius,
                         startAngle: .degrees(120),
                         endAngle: .degrees(240),
                         clockwise: false)
            }
            context.stroke(arcPath,
                           with: .color(TerrariumColors.crayfishEye.opacity(waveAlpha)),
                           lineWidth: lineWidth)
        }

        // 6 orbiting neon dots
        for i in 0..<6 {
            let dotProgress = (time * 3 + Float(i) * 0.16).truncatingRemainder(dividingBy: 1.0)
            let dotRadius = bodyW * 0.3 + CGFloat(dotProgress) * maxRadius
            let dotAngle = (150 + dotProgress * 40) * Float.pi / 180
            let dotX = cx + CGFloat(cos(dotAngle)) * dotRadius
            let dotY = cy + CGFloat(sin(dotAngle)) * dotRadius
            let dotAlpha = Double(1 - dotProgress) * 0.6
            let dotSize = bodyW * 0.015

            let dotRect = CGRect(x: dotX - dotSize, y: dotY - dotSize,
                                 width: dotSize * 2, height: dotSize * 2)
            context.fill(Path(ellipseIn: dotRect),
                         with: .color(TerrariumColors.tetraNeon.opacity(dotAlpha)))
        }
    }

    // MARK: - Helpers

    private func lerpColor(_ a: Color, _ b: Color, _ t: Float) -> Color {
        TerrariumColors.lerpColor(a, b, t)
    }

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
