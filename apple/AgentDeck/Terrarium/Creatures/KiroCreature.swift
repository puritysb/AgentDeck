// KiroCreature.swift — Ghost creature for Kiro sessions
//
// The creature IS the logo, the same contract AntigravityCreature established:
// this fills the canonical Kiro ghost silhouette (viewBox 0 0 24 24) rather
// than drawing a ghost of our own. Two consequences that are easy to get wrong:
//
//  - The eyes are HOLES, not shapes. They live in the same path as the body as
//    reversed subpaths, so the fill must be even-odd. A non-zero fill produces
//    a blind ghost — recognisably wrong against the mark everyone knows.
//  - The path data is an SSOT mirror of `design/brand/kiro.svg`
//    (@lobehub/icons-static-svg@1.94.0, MIT). Do not redraw it, and do not
//    "clean it up" — `design/RESOURCES.md` records how to verify it byte-wise
//    against upstream, and the geometry must survive that check.
//
// Behaviour: a ghost hovers, so unlike the octopus it never rests on the sand.
// WORKING rises and gains a sheen, FLOATING breathes and drifts, SLEEPING sinks
// and fades (a ghost dimming out, not lying down), ASKING shows the shared "?"
// bubble. Lifecycle/draw structure mirrors AntigravityCreature so it plugs into
// TerrariumRenderer the same way.

import SwiftUI

// MARK: - Kiro Visual State

enum KiroVisualState {
    case sleeping   // Disconnected — sinks and fades out
    case floating   // Idle — hover, gentle breath + drift
    case working    // Processing — rises, sheen pulse
    case asking     // Awaiting — "?" bubble
}

final class KiroCreature: Creature {
    // MARK: - Properties

    let sessionId: String
    var displayName: String?
    var visualState: KiroVisualState = .floating
    var homeX: Float
    var homeY: Float
    var scale: Float

    private var time: Float = 0
    private(set) var currentX: Float
    private(set) var currentY: Float
    private var phaseOffset: Float
    private var driftPhase: Float

    private var previousState: KiroVisualState?
    private var transitionProgress: Float = 1.0

    var onAskingExit: (() -> Void)?

    // MARK: - Geometry (canonical 24×24 ghost)

    /// Canonical Kiro ghost — SSOT mirror of `design/brand/kiro.svg`
    /// (@lobehub/icons-static-svg@1.94.0, MIT; Kiro is a mark of Amazon.com,
    /// Inc. or its affiliates). Same string as
    /// `CreatureGeometry.kiroPathData` and `SessionBrand.kiroPath`.
    private static let pathData =
        "M4.594 6.677C6.67-2.226 18.746-2.211 21.16 6.632c.353 1.297 1.725 7.582-1.673 13.747-1.545 2.797-5.841 5.49-6.99 1.883C8.6 25.477 3.315 24.1 5.789 18.609l-.318.143c-3.57 1.305-3.863-1.208-3.173-2.513.45-.84.727-1.335.937-1.897.353-.975.458-1.568.593-2.498.27-1.837.277-3.607.765-5.167zm8.37.01a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.214-.705 1.214-1.89 0-.622-.127-1.125-.367-1.455a1.014 1.014 0 00-.855-.435zm4.08 0a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.215-.705 1.215-1.89 0-.622-.128-1.125-.368-1.455a1.014 1.014 0 00-.855-.435z"
    private static let viewBox: CGFloat = 24
    private static let ghostPath: SwiftUI.Path = CrayfishCreature.parseSvgPath(pathData)

    private static let wispCount = 5

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

        if let creature = state.kiroCreatures.first(where: { $0.id == sessionId }) {
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
        // homeY anchors the upper-left band (~0.18..0.30). A ghost hovers, so
        // even SLEEPING stops well above the sand — the floor belongs to the
        // octopuses and the crayfish, and a ghost lying on it reads as a bug.
        let idleY = min(0.28, max(0.18, homeY + 0.08))
        let askingY = min(0.26, max(0.16, homeY + 0.06))
        let workingY = min(0.16, max(0.08, homeY - 0.03))
        let sleepingY = min(0.40, max(0.30, homeY + 0.18))
        let targetY: Float = switch visualState {
        case .sleeping: sleepingY
        case .floating: idleY
        case .working: workingY
        case .asking: askingY
        }

        let lerpRate: Float = visualState == .working ? 2.0 : 1.4
        // Slower and wider than the Antigravity bob: a ghost drifts rather than
        // bobs, and the difference is what tells the two apart at a glance.
        let pulseSpeed: Float = visualState == .working ? 1.4 : 0.42
        let pulseAmp: Float = visualState == .working ? 0.013 : 0.008
        let pulseBob = sin((time + phaseOffset) * pulseSpeed) * pulseAmp
        currentY += (targetY + pulseBob - currentY) * dt * lerpRate

        let driftAmp: Float = visualState == .working ? min(0.045, 0.018 + scale * 0.025) : 0.009
        let driftSpeed: Float = visualState == .working ? 0.18 : 0.22
        let driftX = sin((time + driftPhase) * driftSpeed) * driftAmp
        currentX += (homeX + driftX - currentX) * dt * lerpRate

        // Stays clear of the session-list HUD on the left and the Codex cloud
        // band on the right; the vertical cap keeps it out of the octopus band.
        let minX = max(0.19, homeX - 0.05)
        let maxX = min(0.36, homeX + 0.05)
        currentX = min(maxX, max(minX, currentX))
        currentY = min(0.42, max(0.05, currentY))
    }

    func currentPosition() -> (x: Float, y: Float) { (currentX, currentY) }
    func isWorking() -> Bool { visualState == .working }

    // MARK: - Colors

    private static let bodyColor = TerrariumColors.kiroBody
    private static let lightColor = TerrariumColors.kiroLight
    private static let dimColor = TerrariumColors.kiroDim
    static let nameBg = TerrariumColors.kiroNameBg

    // MARK: - Draw

    func draw(context: inout GraphicsContext, size: CGSize) {
        let w = Float(size.width)
        let h = Float(size.height)
        let bodyRadius = w * 0.040 * scale

        let cx = CGFloat(currentX * w)
        let bobOffset = visualState == .working ? CGFloat(sin(time * 1.8) * h * 0.005) : 0
        let cy = CGFloat(currentY * h) + bobOffset

        let alpha: CGFloat = visualState == .sleeping ? 0.38 : 1.0

        if visualState == .working {
            drawWisps(context: &context, cx: cx, cy: cy, radius: CGFloat(bodyRadius), alpha: alpha)
        }

        drawGhostBody(context: &context, cx: cx, cy: cy, radius: CGFloat(bodyRadius), alpha: alpha)

        if visualState == .asking {
            drawSpeechBubble(context: &context, cx: cx, cy: cy, bodyW: CGFloat(bodyRadius))
        }

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

    // MARK: - Ghost Body (canonical silhouette)

    private func drawGhostBody(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat,
                               radius: CGFloat, alpha: CGFloat) {
        let breathScale: CGFloat = switch visualState {
        case .sleeping: 1.0
        case .working: 1.0 + CGFloat(sin(time * 1.8) * 0.022)
        default: 1.0 + CGFloat(sin(time * 0.5) * 0.012)
        }

        let effScale = (radius * 2.0) / Self.viewBox * breathScale
        var transform = CGAffineTransform(translationX: cx, y: cy)
        transform = transform.scaledBy(x: effScale, y: effScale)
        transform = transform.translatedBy(x: -Self.viewBox / 2, y: -Self.viewBox / 2)
        let body = Self.ghostPath.applying(transform)

        // Even-odd is load-bearing: the eyes are reversed subpaths inside the
        // body, so a non-zero fill fills them in and blinds the ghost.
        let fillStyle = FillStyle(eoFill: true)

        if visualState == .sleeping {
            context.fill(body, with: .color(Self.dimColor.opacity(alpha * 0.8)), style: fillStyle)
            return
        }

        // Soft halo — reads as the ghost's glow, and keeps the violet silhouette
        // legible against the dark tank without outlining (an outline would
        // trace the eye holes too and turn them into rings).
        context.fill(
            body,
            with: .color(Self.lightColor.opacity(0.18 * Double(alpha))),
            style: fillStyle
        )

        context.fill(
            body,
            with: Self.bodyShading(in: body.boundingRect, alpha: bodyAlpha(alpha)),
            style: fillStyle
        )
    }

    private func bodyAlpha(_ baseAlpha: CGFloat) -> Double {
        guard visualState == .working else { return Double(baseAlpha) }
        let pulse = max(0, sin(time * TerrariumTiming.thinkingPulseSpeed))
        return min(1.0, Double(baseAlpha) * 0.9 + Double(pulse) * 0.12)
    }

    private static func bodyShading(in bounds: CGRect, alpha: Double) -> GraphicsContext.Shading {
        .linearGradient(
            Gradient(colors: [
                lightColor.opacity(alpha),
                bodyColor.opacity(alpha),
            ]),
            startPoint: CGPoint(x: bounds.midX, y: bounds.minY),
            endPoint: CGPoint(x: bounds.midX, y: bounds.maxY)
        )
    }

    // MARK: - Wisps (WORKING trail)

    private func drawWisps(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat,
                           radius: CGFloat, alpha: CGFloat) {
        for i in 0..<Self.wispCount {
            let phase = Float(i) * (2 * Float.pi / Float(Self.wispCount))
            let fall = (time * 0.35 + Float(i) * 0.31).truncatingRemainder(dividingBy: 1)
            let sx = cx + CGFloat(sin(phase + time * 0.6)) * radius * 0.5
            // Wisps trail DOWNWARD off the ghost's fringe — the opposite of
            // Antigravity's rising sparks, so the two working states never read
            // as the same effect in a shared tank.
            let sy = cy + radius * CGFloat(0.5 + fall * 0.9)
            let wispAlpha = Double((1 - fall) * 0.42) * Double(alpha)
            let r = radius * 0.10 * CGFloat(1 - fall * 0.5)

            context.fill(
                SwiftUI.Path(ellipseIn: CGRect(x: sx - r, y: sy - r, width: r * 2, height: r * 2)),
                with: .color(Self.lightColor.opacity(max(0, min(1, wispAlpha))))
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
            backgroundColor: Self.nameBg
        )
    }
}
