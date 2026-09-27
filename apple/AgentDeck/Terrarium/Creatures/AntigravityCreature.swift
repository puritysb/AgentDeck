// AntigravityCreature.swift — Peak/arc logo creature for Antigravity
// Geometric brand mark, NOT biomorphic. Renders the canonical Antigravity
// "double-peak / mountain arc" silhouette (ANTIGRAVITY_PATH, viewBox 0 0 24 24)
// filled with the brand rainbow gradient. The creature IS the logo.
//
// WORKING shows a rising-spark shimmer above the peaks (anti-gravity nod);
// SLEEPING dims the body; FLOATING breathes a gentle bob; ASKING shows a
// "?" bubble. Mirrors OpenCodeCreature's lifecycle/draw structure so it
// plugs into TerrariumRenderer the same way.

import SwiftUI

// MARK: - Antigravity Visual State

enum AntigravityVisualState {
    case sleeping   // Disconnected — settled low, dimmed
    case floating   // Idle — gentle breath-bob
    case working    // Processing — rises high, rising sparks shimmer
    case asking     // Awaiting — "?" bubble
}

final class AntigravityCreature: Creature {
    // MARK: - Properties

    let sessionId: String
    var displayName: String?
    var visualState: AntigravityVisualState = .floating
    var homeX: Float
    var homeY: Float
    var scale: Float

    private var time: Float = 0
    private(set) var currentX: Float
    private(set) var currentY: Float
    private var phaseOffset: Float
    private var driftPhase: Float

    private var previousState: AntigravityVisualState?
    private var transitionProgress: Float = 1.0

    var onAskingExit: (() -> Void)?

    // MARK: - Geometry (canonical 24×24 peak/arc mark)

    /// Canonical Antigravity mark — SSOT mirror of
    /// `shared/src/svg-renderers/agent-logos.ts ANTIGRAVITY_PATH` (viewBox 0 0 24 24).
    private static let pathData =
        "M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"
    private static let viewBox: CGFloat = 24
    private static let peakPath: SwiftUI.Path = CrayfishCreature.parseSvgPath(pathData)

    private static let sparkCount = 6

    // MARK: - Init

    init(sessionId: String, homeX: Float, homeY: Float, scale: Float) {
        self.sessionId = sessionId
        self.homeX = homeX
        self.homeY = homeY
        self.scale = scale
        self.currentX = homeX
        self.currentY = homeY
        self.phaseOffset = Float.random(in: 0...Float.pi * 2)
        self.driftPhase = Float.random(in: 0...Float.pi * 2)
    }

    // MARK: - Update

    func update(dt: Float, state: TerrariumState) {
        time += dt

        if let creature = state.antigravityCreatures.first(where: { $0.id == sessionId }) {
            let newState = creature.state
            if newState != visualState {
                if visualState == .asking { onAskingExit?() }
                previousState = visualState
                transitionProgress = 0
                visualState = newState
            }
        }

        if transitionProgress < 1.0 {
            transitionProgress = min(1.0, transitionProgress + dt * 2.5)
        }

        updatePosition(dt: dt)
    }

    private func updatePosition(dt: Float) {
        // homeY anchors the upper-right band (~0.22..0.34). Working rises high
        // toward the surface (anti-gravity). Idle HOVERS above the floor strip
        // instead of landing: the band reaches x 0.82, so a floor rest would
        // sit directly on the OpenClaw crayfish home (0.78, 0.64).
        let idleY = min(0.54, max(0.48, homeY + 0.26))
        let askingY = min(0.52, max(0.46, homeY + 0.22))
        let workingY = min(0.30, max(0.10, homeY - 0.04))
        let sleepingY = min(0.72, max(0.64, homeY + 0.44))
        let targetY: Float = switch visualState {
        case .sleeping: sleepingY
        case .floating: idleY
        case .working: workingY
        case .asking: askingY
        }

        let lerpRate: Float = visualState == .working ? 2.0 : 1.5
        let pulseSpeed: Float = visualState == .working ? 1.5 : 0.5
        let pulseAmp: Float = visualState == .working ? 0.012 : 0.006
        let pulseBob = sin((time + phaseOffset) * pulseSpeed) * pulseAmp
        currentY += (targetY + pulseBob - currentY) * dt * lerpRate

        let driftAmp: Float = visualState == .working ? min(0.04, 0.015 + scale * 0.025) : 0.005
        let driftSpeed: Float = visualState == .working ? 0.15 : 0.25
        let driftX = sin((time + driftPhase) * driftSpeed) * driftAmp
        // Sleeping sinks to the floor — drift left of the crayfish territory
        // so a right-band sleeper doesn't settle onto the OpenClaw crayfish.
        let anchorX = visualState == .sleeping
            ? min(homeX, TerrariumLayout.crayfishClearMaxX)
            : homeX
        currentX += (anchorX + driftX - currentX) * dt * lerpRate

        let minX = max(0.50, anchorX - 0.07)
        let maxX = min(0.88, anchorX + 0.07)
        currentX = min(maxX, max(minX, currentX))
        currentY = min(0.72, max(0.08, currentY))
    }

    func currentPosition() -> (x: Float, y: Float) { (currentX, currentY) }
    func isWorking() -> Bool { visualState == .working }

    // MARK: - Colors

    private static let lightColor = TerrariumColors.antigravityLight
    private static let dimColor = TerrariumColors.antigravityDim
    static let nameBg = TerrariumColors.antigravityNameBg

    // MARK: - Draw

    func draw(context: inout GraphicsContext, size: CGSize) {
        let w = Float(size.width)
        let h = Float(size.height)
        let bodyRadius = w * 0.044 * scale

        let cx = CGFloat(currentX * w)
        let bobOffset = visualState == .working ? CGFloat(sin(time * 2.0) * h * 0.006) : 0
        let cy = CGFloat(currentY * h) + bobOffset

        let alpha: CGFloat = visualState == .sleeping ? 0.4 : 1.0

        // WORKING: rising sparks shimmer above the peaks (behind body)
        if visualState == .working {
            drawRisingSparks(context: &context, cx: cx, cy: cy, radius: CGFloat(bodyRadius), alpha: alpha)
        }

        // Peak/arc SVG body
        drawSvgBody(context: &context, cx: cx, cy: cy, radius: CGFloat(bodyRadius), alpha: alpha)

        // "?" bubble
        if visualState == .asking {
            drawSpeechBubble(context: &context, cx: cx, cy: cy, bodyW: CGFloat(bodyRadius))
        }

        // Name tag
        if let name = displayName {
            drawNameTag(
                context: &context,
                name: name,
                cx: cx,
                cy: cy,
                bodyW: CGFloat(bodyRadius),
                canvasWidth: size.width
            )
        }
    }

    // MARK: - SVG Peak/Arc Body

    private func drawSvgBody(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat,
                             radius: CGFloat, alpha: CGFloat) {
        // Subtle breath scale (none when sleeping).
        let breathScale: CGFloat = switch visualState {
        case .sleeping: 1.0
        case .working: 1.0 + CGFloat(sin(time * 2.0) * 0.02)
        default: 1.0 + CGFloat(sin(time * 0.6) * 0.01)
        }

        // The SVG viewBox is 24×24. Scale so the mark width = radius * 2.
        let effScale = (radius * 2.0) / Self.viewBox * breathScale

        // Center the mark at (cx, cy): origin → (-12,-12), scale, translate to center.
        var transform = CGAffineTransform(translationX: cx, y: cy)
        transform = transform.scaledBy(x: effScale, y: effScale)
        transform = transform.translatedBy(x: -Self.viewBox / 2, y: -Self.viewBox / 2)
        let body = Self.peakPath.applying(transform)
        let fillStyle = FillStyle(eoFill: true)

        if visualState == .sleeping {
            context.fill(body, with: .color(Self.dimColor.opacity(alpha * 0.72)), style: fillStyle)
        } else {
            context.stroke(
                body,
                with: .color(Self.lightColor.opacity(0.34 * Double(alpha))),
                lineWidth: max(0.8, radius * 0.08)
            )
            context.fill(
                body,
                with: Self.rainbowShading(in: body.boundingRect, alpha: bodyAlpha(alpha)),
                style: fillStyle
            )
        }
    }

    private func bodyAlpha(_ baseAlpha: CGFloat) -> Double {
        guard visualState == .working else { return Double(baseAlpha) }
        let pulse = max(0, sin(time * TerrariumTiming.thinkingPulseSpeed))
        return min(1.0, Double(baseAlpha) + Double(pulse) * 0.10)
    }

    private static func rainbowShading(in bounds: CGRect, alpha: Double) -> GraphicsContext.Shading {
        .linearGradient(
            Gradient(colors: [
                TerrariumColors.antigravityLime.opacity(alpha),
                TerrariumColors.antigravityTeal.opacity(alpha),
                TerrariumColors.antigravityCyan.opacity(alpha),
                TerrariumColors.antigravityBlue.opacity(alpha),
                TerrariumColors.antigravityViolet.opacity(alpha),
                TerrariumColors.antigravityPink.opacity(alpha),
                TerrariumColors.antigravityRed.opacity(alpha),
                TerrariumColors.antigravityOrange.opacity(alpha),
                TerrariumColors.antigravityYellow.opacity(alpha),
            ]),
            startPoint: CGPoint(x: bounds.minX + bounds.width * 0.12, y: bounds.maxY),
            endPoint: CGPoint(x: bounds.maxX, y: bounds.minY)
        )
    }

    // MARK: - Rising Sparks (WORKING anti-gravity shimmer)

    private func drawRisingSparks(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat,
                                  radius: CGFloat, alpha: CGFloat) {
        for i in 0..<Self.sparkCount {
            let phase = Float(i) * (2 * Float.pi / Float(Self.sparkCount))
            let rise = (time * 0.4 + Float(i) * 0.27).truncatingRemainder(dividingBy: 1)
            let sx = cx + CGFloat(cos(phase + time * 0.5)) * radius * 0.55
            let sy = cy - radius * CGFloat(0.4 + rise * 1.0)
            let sparkAlpha = Double((1 - rise) * 0.5 + sin(time * 3 + phase) * 0.1) * Double(alpha)

            var spark = SwiftUI.Path()
            spark.move(to: CGPoint(x: sx, y: sy + radius * 0.08))
            spark.addLine(to: CGPoint(x: sx, y: sy - radius * 0.08))
            context.stroke(
                spark,
                with: .color(Self.lightColor.opacity(max(0, min(1, sparkAlpha)))),
                style: StrokeStyle(lineWidth: radius * 0.06, lineCap: .round)
            )
        }
    }

    // MARK: - Speech Bubble

    private func drawSpeechBubble(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyW: CGFloat) {
        let bx = cx + bodyW * 0.9
        let by = cy - bodyW * 0.1
        let br = bodyW * 0.35
        let pulse = CGFloat(sin(time * 2.5)) * 0.08 + 1
        let r = br * pulse

        let rect = CGRect(x: bx - r, y: by - r, width: r * 2, height: r * 2)
        context.fill(Path(ellipseIn: rect), with: .color(.white.opacity(0.25)))
        context.stroke(Path(ellipseIn: rect),
                       with: .color(TerrariumColors.hudText.opacity(0.5)),
                       lineWidth: bodyW * 0.02)

        var tail = SwiftUI.Path()
        tail.move(to: CGPoint(x: bx - r * 0.3, y: by + r * 0.3))
        tail.addLine(to: CGPoint(x: cx + bodyW * 0.45, y: cy))
        tail.addLine(to: CGPoint(x: bx - r * 0.05, y: by + r * 0.5))
        tail.closeSubpath()
        context.fill(tail, with: .color(.white.opacity(0.25)))

        context.draw(
            Text("?").font(.system(size: r * 1.2, weight: .bold)).foregroundColor(TerrariumColors.hudText.opacity(0.7)),
            at: CGPoint(x: bx, y: by)
        )
    }

    // MARK: - Name Tag

    private func drawNameTag(context: inout GraphicsContext, name: String,
                             cx: CGFloat, cy: CGFloat, bodyW: CGFloat, canvasWidth: CGFloat) {
        drawTerrariumNameTag(
            context: &context,
            name: name,
            cx: cx,
            bodyTopY: cy - bodyW * 0.8,
            bodyMetric: terrariumNameTagMetric(canvasWidth: canvasWidth, scale: scale),
            backgroundColor: Self.nameBg,
            rank: visualState == .asking ? .awaiting : visualState == .working ? .working : .idle
        )
    }
}
