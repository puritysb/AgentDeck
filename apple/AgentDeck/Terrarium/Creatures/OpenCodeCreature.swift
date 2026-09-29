// OpenCodeCreature.swift — exact design/brand/opencode.svg ring geometry.

import SwiftUI

// MARK: - OpenCode Visual State

enum OpenCodeVisualState {
    case dormant    // Hidden, not drawn
    case drifting   // Idle — gentle bob, subtle breathing
    case pulsing    // Processing — glow pulse, wider drift
    case waiting    // Awaiting — "?" bubble
}

final class OpenCodeCreature: Creature {
    private static let pathData = "M16 6H8v12h8V6zm4 16H4V2h16v20z"
    private static let markPath = CrayfishCreature.parseSvgPath(pathData)
    // MARK: - Properties

    let sessionId: String
    var displayName: String?
    var visualState: OpenCodeVisualState = .drifting
    var homeX: Float
    var homeY: Float
    var scale: Float

    private var time: Float = 0
    private(set) var currentX: Float
    private(set) var currentY: Float
    private var phaseOffset: Float
    private var driftPhase: Float

    private var previousState: OpenCodeVisualState?
    private var transitionProgress: Float = 1.0

    var onWaitingExit: (() -> Void)?

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

        if let creature = state.opencodeCreatures.first(where: { $0.id == sessionId }) {
            let newState = creature.state
            if newState != visualState {
                if visualState == .waiting { onWaitingExit?() }
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
        let idleY = min(0.63, max(0.59, homeY + 0.18))
        let waitingY = min(0.52, max(0.46, homeY + 0.10))
        let pulseY = min(0.50, max(0.25, homeY - 0.02))
        let targetY: Float = switch visualState {
        case .dormant: 0.70
        case .drifting: idleY
        case .pulsing: pulseY
        case .waiting: waitingY
        }

        let lerpRate: Float = visualState == .pulsing ? 2.0 : 1.5
        let pulseSpeed: Float = visualState == .pulsing ? 1.5 : 0.5
        let pulseAmp: Float = visualState == .pulsing ? 0.012 : 0.006
        let pulseBob = sin((time + phaseOffset) * pulseSpeed) * pulseAmp
        currentY += (targetY + pulseBob - currentY) * dt * lerpRate

        let driftAmp: Float = visualState == .pulsing ? min(0.04, 0.015 + scale * 0.025) : 0.005
        let driftSpeed: Float = visualState == .pulsing ? 0.15 : 0.25
        let driftX = sin((time + driftPhase) * driftSpeed) * driftAmp
        // Floor rest stays clear of the crayfish territory: the band's right
        // edge (0.68) otherwise drops idle OpenCode onto the OpenClaw crayfish.
        let anchorX = visualState == .drifting
            ? min(homeX, TerrariumLayout.crayfishClearMaxX)
            : homeX
        currentX += (anchorX + driftX - currentX) * dt * lerpRate

        let minX = max(0.20, anchorX - 0.07)
        let maxX = min(0.70, anchorX + 0.07)
        currentX = min(maxX, max(minX, currentX))
        currentY = min(0.60, max(0.10, currentY))
    }

    func currentPosition() -> (x: Float, y: Float) { (currentX, currentY) }
    func isPulsing() -> Bool { visualState == .pulsing }

    // MARK: - Colors

    private static let outerColor = Color(red: 0.945, green: 0.925, blue: 0.925) // #F1ECEC
    private static let glowColor = Color(red: 0.945, green: 0.925, blue: 0.925)  // #F1ECEC for glow
    static let nameBg = Color(red: 0.294, green: 0.275, blue: 0.275).opacity(0.6)

    // MARK: - Draw

    func draw(context: inout GraphicsContext, size: CGSize) {
        guard visualState != .dormant else { return }

        let w = Float(size.width)
        let h = Float(size.height)
        let bodyWidth = w * 0.044 * scale

        let cx = CGFloat(currentX * w)
        let bobOffset = visualState == .pulsing ? CGFloat(sin(time * 2.0) * h * 0.006) : 0
        let cy = CGFloat(currentY * h) + bobOffset

        let alpha: CGFloat = visualState == .dormant ? 0.3 : 1.0

        // Glow behind body (processing)
        if visualState == .pulsing {
            drawGlow(context: &context, cx: cx, cy: cy, bodyW: CGFloat(bodyWidth))
        }

        // Canonical OpenCode ring
        drawNestedSquares(context: &context, cx: cx, cy: cy, bodyW: CGFloat(bodyWidth), alpha: alpha)

        // "?" bubble
        if visualState == .waiting {
            drawSpeechBubble(context: &context, cx: cx, cy: cy, bodyW: CGFloat(bodyWidth))
        }

        // Name tag
        if let name = displayName {
            drawNameTag(
                context: &context,
                name: name,
                cx: cx,
                cy: cy,
                bodyW: CGFloat(bodyWidth),
                canvasWidth: size.width
            )
        }
    }

    // MARK: - Canonical ring

    private func drawNestedSquares(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat,
                                    bodyW: CGFloat, alpha: CGFloat) {
        let breathScale: CGFloat = 1.0 + CGFloat(sin(time * (visualState == .pulsing ? 2.0 : 0.6)) * 0.02)

        let markSize = bodyW * 1.6 * breathScale

        var outerAlpha = alpha
        if visualState == .pulsing {
            let pulse = CGFloat(sin(time * 3.0) * 0.1 + 0.9)
            outerAlpha *= pulse
        }

        context.drawLayer { layer in
            layer.translateBy(x: cx - markSize / 2, y: cy - markSize / 2)
            layer.scaleBy(x: markSize / 24, y: markSize / 24)
            layer.fill(Self.markPath,
                       with: .color(Self.outerColor.opacity(outerAlpha * 0.92)),
                       style: FillStyle(eoFill: true))
        }
    }

    // MARK: - Glow

    private func drawGlow(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyW: CGFloat) {
        let glowPulse = CGFloat(sin(time * 2.5) * 0.3 + 0.7)
        let glowR = bodyW * 1.2 * glowPulse

        let rect = CGRect(x: cx - glowR, y: cy - glowR, width: glowR * 2, height: glowR * 2)
        context.fill(Path(ellipseIn: rect),
                     with: .color(Self.glowColor.opacity(0.08 * Double(glowPulse))))
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

        var tail = Path()
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
            rank: visualState == .waiting ? .awaiting : visualState == .pulsing ? .working : .idle
        )
    }
}
