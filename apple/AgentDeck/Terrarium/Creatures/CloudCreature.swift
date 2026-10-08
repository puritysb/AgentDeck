// CloudCreature.swift — Cloud creature for Codex CLI
// Exact design/brand/codex.svg geometry with a lavender → blue gradient.

import SwiftUI

// MARK: - Cloud Visual State

enum CloudVisualState {
    case dormant
    case drifting   // Idle — gentle pulse, slow drift
    case pulsing    // Processing — vivid gradient, glow, faster morph
    case waiting    // Awaiting — "?" bubble
}

final class CloudCreature: Creature {
    private static let codexPathData = "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
    private static let codexPath = CrayfishCreature.parseSvgPath(codexPathData)

    // MARK: - Properties

    let sessionId: String
    var displayName: String?
    var visualState: CloudVisualState = .drifting
    var homeX: Float
    var homeY: Float
    var scale: Float

    private var time: Float = 0
    var currentX: Float { simulationX }
    var currentY: Float { simulationY }
    var simulationPosition: SIMD2<Float> { [simulationX, simulationY] }
    private(set) var simulationX: Float
    private(set) var simulationY: Float
    private var phaseOffset: Float
    private var driftPhase: Float
    private var stateNeighborGap: Float = 1

    private var previousState: CloudVisualState?
    private var transitionProgress: Float = 1.0

    var onWaitingExit: (() -> Void)?

    // MARK: - Init

    init(sessionId: String, homeX: Float, homeY: Float, scale: Float) {
        self.sessionId = sessionId
        self.homeX = homeX
        self.homeY = homeY
        self.scale = scale
        self.simulationX = homeX
        self.simulationY = homeY
        self.phaseOffset = Float.random(in: 0...Float.pi * 2)
        self.driftPhase = Float.random(in: 0...Float.pi * 2)
    }

    // MARK: - Update

    func update(dt: Float, state: TerrariumState) {
        time += dt

        if let creature = state.cloudCreatures.first(where: { $0.id == sessionId }) {
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

        stateNeighborGap = state.cloudCreatures
            .filter { $0.id != sessionId && abs($0.homeY - homeY) < 0.08 }
            .map { abs($0.homeX - homeX) }.min() ?? 1
        updatePosition(dt: dt)
    }

    private func updatePosition(dt: Float) {
        let idleY = min(0.62, max(0.58, homeY + 0.30))
        let waitingY = min(0.54, max(0.48, homeY + 0.18))
        let pulseY = min(0.25, max(0.05, homeY))
        let targetY: Float = switch visualState {
        case .dormant: 0.70
        case .drifting: idleY
        case .pulsing: pulseY
        case .waiting: waitingY
        }

        let lerpRate: Float = visualState == .pulsing ? 2.0 : 1.5
        let pulseSpeed: Float = visualState == .pulsing ? 1.5 : 0.5
        let pulseAmp: Float = visualState == .pulsing ? 0.015 : 0.008
        let pulseBob = sin((time + phaseOffset) * pulseSpeed) * pulseAmp
        simulationY += (targetY + pulseBob - simulationY) * dt * lerpRate

        // Processing: wider horizontal drift (floating near surface, drifting side to side)
        let neighborGap = stateNeighborGap
        let driftLimit = max(0, (neighborGap - 0.085 * scale) / 2)
        let driftAmp: Float = min(visualState == .pulsing ? 0.025 : 0.006, driftLimit)
        let driftSpeed: Float = visualState == .pulsing ? 0.15 : 0.3
        let driftX = sin((time + driftPhase) * driftSpeed) * driftAmp
        simulationX += (homeX + driftX - simulationX) * dt * lerpRate

        let minX = max(0.18, homeX - 0.08)
        let maxX = min(0.72, homeX + 0.08)
        simulationX = min(maxX, max(minX, simulationX))
        simulationY = min(0.62, max(0.08, simulationY))
    }

    func currentPosition() -> (x: Float, y: Float) { (currentX, currentY) }
    func isPulsing() -> Bool { visualState == .pulsing }

    // MARK: - Draw

    func draw(context: inout GraphicsContext, size: CGSize) {
        guard visualState != .dormant else { return }

        let w = Float(size.width)
        let h = Float(size.height)
        let bodyWidth = w * 0.060 * scale

        let cx = CGFloat(currentX * w)
        let bobOffset = visualState == .pulsing ? CGFloat(sin(time * 2.0) * h * 0.008) : 0
        let cy = CGFloat(currentY * h) + bobOffset

        // Glow behind cloud (processing)
        if visualState == .pulsing {
            drawGlow(context: &context, cx: cx, cy: cy, bodyW: CGFloat(bodyWidth))
        }

        // Canonical Codex mark
        drawCloudBody(context: &context, cx: cx, cy: cy, bodyW: CGFloat(bodyWidth))

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

    // MARK: - Canonical Codex mark

    private func drawCloudBody(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyW: CGFloat) {
        let alpha = visualState == .dormant ? 0.3 : 0.9
        let breathScale: CGFloat = 1.0 + CGFloat(sin(time * (visualState == .pulsing ? 2.0 : 0.6)) * 0.03)

        // Gradient colors
        let topColor: Color
        let bottomColor: Color
        if visualState == .pulsing {
            let pulse = sin(time * 2.5) * 0.3 + 0.7
            topColor = TerrariumColors.lerpColor(
                TerrariumColors.cloudHighlight, Color.white, Float(pulse) * 0.2)
            bottomColor = TerrariumColors.lerpColor(
                TerrariumColors.cloudDeep, TerrariumColors.cloudBell, Float(pulse) * 0.3)
        } else {
            topColor = TerrariumColors.cloudHighlight
            bottomColor = TerrariumColors.cloudDeep
        }

        let markSize = bodyW * 1.28 * breathScale
        let markScale = markSize / 24
        context.drawLayer { bodyCtx in
            bodyCtx.opacity = alpha
            bodyCtx.translateBy(x: cx - markSize / 2, y: cy - markSize / 2)
            bodyCtx.scaleBy(x: markScale, y: markScale)
            bodyCtx.fill(Self.codexPath, with: .linearGradient(
                Gradient(colors: [topColor, bottomColor]),
                startPoint: .zero,
                endPoint: CGPoint(x: 24, y: 24)
            ), style: FillStyle(eoFill: true))
            bodyCtx.opacity = 1
            CreatureBrandFeatures.draw("codex", context: bodyCtx)
        }
    }



    // MARK: - Glow

    private func drawGlow(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyW: CGFloat) {
        let glowPulse = CGFloat(sin(time * 2.5) * 0.3 + 0.7)
        let glowR = bodyW * 1.0 * glowPulse

        let rect = CGRect(x: cx - glowR, y: cy - glowR, width: glowR * 2, height: glowR * 2)
        context.fill(Path(ellipseIn: rect),
                     with: .color(TerrariumColors.cloudGlow.opacity(0.1 * Double(glowPulse))))

        for i in 0..<4 {
            let angle = CGFloat(Float(i) / 4 * Float.pi * 2 + time * 0.5)
            let orbitR = bodyW * 0.65
            let px = cx + cos(angle) * orbitR
            let py = cy + sin(angle) * orbitR * 0.6
            let pSize = bodyW * 0.03
            let pRect = CGRect(x: px - pSize, y: py - pSize, width: pSize * 2, height: pSize * 2)
            context.fill(Path(ellipseIn: pRect),
                         with: .color(TerrariumColors.cloudGlow.opacity(0.3 * Double(glowPulse))))
        }
    }

    // MARK: - Speech Bubble

    private func drawSpeechBubble(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyW: CGFloat) {
        let bx = cx + bodyW * 0.55
        let by = cy - bodyW * 0.1
        let br = bodyW * 0.22
        let pulse = CGFloat(sin(time * 2.5)) * 0.08 + 1
        let r = br * pulse

        let rect = CGRect(x: bx - r, y: by - r, width: r * 2, height: r * 2)
        context.fill(Path(ellipseIn: rect), with: .color(.white.opacity(0.25)))
        context.stroke(Path(ellipseIn: rect),
                       with: .color(TerrariumColors.hudText.opacity(0.5)),
                       lineWidth: bodyW * 0.02)

        var tail = SwiftUI.Path()
        tail.move(to: CGPoint(x: bx - r * 0.3, y: by + r * 0.3))
        tail.addLine(to: CGPoint(x: cx + bodyW * 0.28, y: cy))
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
            bodyTopY: cy - bodyW * 0.6,
            bodyMetric: terrariumNameTagMetric(canvasWidth: canvasWidth, scale: scale),
            backgroundColor: TerrariumColors.cloudNameBg,
            rank: visualState == .waiting ? .awaiting : visualState == .pulsing ? .working : .idle
        )
    }
}
