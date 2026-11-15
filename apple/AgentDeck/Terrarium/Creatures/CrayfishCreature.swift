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

    /// Kept for existing call sites and the generated brand features; the parser
    /// lives in `SvgPathParser` so surfaces without the terrarium can share it.
    static func parseSvgPath(_ data: String) -> SwiftUI.Path { SvgPathParser.parseSvgPath(data) }
}
