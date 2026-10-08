// OctopusCreature.swift — SVG path octopus mascot (Antigravity robot)
// Ported from android OctopusCreature.kt

import SwiftUI

final class OctopusCreature: Creature {
    // MARK: - SVG Path (claudecode.svg Antigravity, viewBox 0 0 24 24)

    private static let svgViewBox: CGFloat = 24.0

    /// Antigravity robot CGPath — fill-rule EvenOdd makes eyes transparent cutouts.
    private nonisolated(unsafe) static let robotPath: CGPath = {
        let p = CGMutablePath()
        // Outer body
        p.move(to: CGPoint(x: 20.998, y: 10.949))
        p.addLine(to: CGPoint(x: 24, y: 10.949))
        p.addLine(to: CGPoint(x: 24, y: 14.051))
        p.addLine(to: CGPoint(x: 21, y: 14.051))
        p.addLine(to: CGPoint(x: 21, y: 17.079))
        p.addLine(to: CGPoint(x: 19.513, y: 17.079))
        p.addLine(to: CGPoint(x: 19.513, y: 20))
        p.addLine(to: CGPoint(x: 18, y: 20))
        p.addLine(to: CGPoint(x: 18, y: 17.079))
        p.addLine(to: CGPoint(x: 16.513, y: 17.079))
        p.addLine(to: CGPoint(x: 16.513, y: 20))
        p.addLine(to: CGPoint(x: 15, y: 20))
        p.addLine(to: CGPoint(x: 15, y: 17.079))
        p.addLine(to: CGPoint(x: 9, y: 17.079))
        p.addLine(to: CGPoint(x: 9, y: 20))
        p.addLine(to: CGPoint(x: 7.488, y: 20))
        p.addLine(to: CGPoint(x: 7.488, y: 17.079))
        p.addLine(to: CGPoint(x: 6, y: 17.079))
        p.addLine(to: CGPoint(x: 6, y: 20))
        p.addLine(to: CGPoint(x: 4.487, y: 20))
        p.addLine(to: CGPoint(x: 4.487, y: 17.079))
        p.addLine(to: CGPoint(x: 3, y: 17.079))
        p.addLine(to: CGPoint(x: 3, y: 14.05))
        p.addLine(to: CGPoint(x: 0, y: 14.05))
        p.addLine(to: CGPoint(x: 0, y: 10.95))
        p.addLine(to: CGPoint(x: 3, y: 10.95))
        p.addLine(to: CGPoint(x: 3, y: 5))
        p.addLine(to: CGPoint(x: 20.998, y: 5))
        p.closeSubpath()
        // Left eye cutout
        p.move(to: CGPoint(x: 6, y: 10.949))
        p.addLine(to: CGPoint(x: 7.488, y: 10.949))
        p.addLine(to: CGPoint(x: 7.488, y: 8.102))
        p.addLine(to: CGPoint(x: 6, y: 8.102))
        p.closeSubpath()
        // Right eye cutout
        p.move(to: CGPoint(x: 16.51, y: 10.949))
        p.addLine(to: CGPoint(x: 18, y: 10.949))
        p.addLine(to: CGPoint(x: 18, y: 8.102))
        p.addLine(to: CGPoint(x: 16.51, y: 8.102))
        p.closeSubpath()
        return p
    }()

    // Starburst arm lengths
    private static let starburstArmLengths: [Float] = [1.0, 0.75, 0.95, 0.70, 1.0, 0.80, 0.90, 0.72, 0.98, 0.78]

    // MARK: - Properties

    let sessionId: String
    var displayName: String?
    var visualState: OctopusVisualState = .floating
    var homeX: Float
    /// Floor position after the shared spacing pass; nil while swimming.
    var restX: Float?
    /// Band width the layout reserves for one octopus (creature-layout.ts).
    static let layoutWidth: Float = 0.11
    var homeY: Float
    var scale: Float

    // Animation state
    private var time: Float = 0
    var currentX: Float { simulationX }
    var currentY: Float { simulationY }
    var simulationPosition: SIMD2<Float> { [simulationX, simulationY] }
    private(set) var simulationX: Float
    private(set) var simulationY: Float
    private var targetX: Float
    private var targetY: Float
    private var phaseOffset: Float
    private var standingJitter: Float
    private var waypointTimer: Float = 0
    private var waypointInterval: Float

    // Transition
    private var previousState: OctopusVisualState?
    private var transitionProgress: Float = 1.0

    // ASKING exit callback
    var onAskingExit: (() -> Void)?

    // MARK: - Init

    init(sessionId: String, homeX: Float, homeY: Float, scale: Float) {
        self.sessionId = sessionId
        self.homeX = homeX
        self.homeY = homeY
        self.scale = scale
        self.simulationX = homeX
        self.simulationY = homeY
        self.targetX = homeX
        self.targetY = homeY
        self.phaseOffset = Float.random(in: 0...Float.pi * 2)
        self.standingJitter = Float.random(in: -TerrariumLayout.jitterRange...TerrariumLayout.jitterRange)
        self.waypointInterval = Float.random(in: TerrariumTiming.waypointMinInterval...TerrariumTiming.waypointMaxInterval)
    }

    // MARK: - Update

    func update(dt: Float, state: TerrariumState) {
        time += dt

        // Find matching creature state
        if let creature = state.creatures.first(where: { $0.id == sessionId }) {
            let newState = creature.state
            if newState != visualState {
                if visualState == .asking {
                    onAskingExit?()
                }
                previousState = visualState
                transitionProgress = 0
                visualState = newState
            }
        }

        // Advance transition
        if transitionProgress < 1.0 {
            transitionProgress = min(1.0, transitionProgress + dt * 3.0)
        }

        // Position
        updatePosition(dt: dt)
    }

    private func updatePosition(dt: Float) {
        let homeX = restX ?? self.homeX
        let depthOffset = (homeX - 0.4) * 0.15
        let lane = swimLane()

        switch visualState {
        case .sleeping:
            let myDeepY = TerrariumLayout.standingYDeep + standingJitter * 0.5
            simulationX += (homeX - simulationX) * dt * 4
            simulationY += (myDeepY - simulationY) * dt * 4

        case .floating:
            let myStandingY = TerrariumLayout.standingY + standingJitter + depthOffset
            let breathBob = sin(time * 0.8) * 0.002
            let idleSway = sin(time * 0.3) * 0.005
            simulationX += (homeX + idleSway - simulationX) * dt * 4
            simulationY += (myStandingY + breathBob - simulationY) * dt * 4

        case .working:
            // Free swimming with waypoints
            waypointTimer += dt
            if waypointTimer >= waypointInterval {
                waypointTimer = 0
                waypointInterval = Float.random(in: TerrariumTiming.waypointMinInterval...TerrariumTiming.waypointMaxInterval)
                pickNewWaypoint()
            }
            let rate = TerrariumTiming.swimLerpRate * dt
            simulationX += (targetX - simulationX) * rate
            simulationY += (targetY - simulationY) * rate
            simulationX = min(lane.maxX, max(lane.minX, simulationX))
            simulationY = min(lane.maxY, max(lane.minY, simulationY))

        case .asking:
            let myStandingY = TerrariumLayout.standingY + standingJitter + depthOffset
            let fidgetX = sin(time * 1.2) * 0.008
            simulationX += (homeX + fidgetX - simulationX) * dt * 4
            simulationY += (myStandingY - simulationY) * dt * 4
        }
    }

    private func pickNewWaypoint() {
        let lane = swimLane()
        let angle = Float.random(in: 0...Float.pi * 2)
        let radiusX = max(0.06, (lane.maxX - lane.minX) * 0.46)
        let radiusY = max(0.04, (lane.maxY - lane.minY) * 0.42)
        targetX = min(lane.maxX, max(lane.minX, lane.centerX + cos(angle) * radiusX))
        targetY = min(lane.maxY, max(lane.minY, lane.centerY + sin(angle) * radiusY))
    }

    private func swimLane() -> (minX: Float, maxX: Float, minY: Float, maxY: Float, centerX: Float, centerY: Float) {
        let halfWidth = min(0.15, max(0.08, 0.08 + scale * 0.05))
        let verticalSlack = min(0.09, max(0.05, 0.05 + scale * 0.03))
        let centerX = min(TerrariumLayout.swimMaxX - 0.06, max(TerrariumLayout.swimMinX + 0.06, homeX))
        let centerY = min(TerrariumLayout.swimMaxY - 0.08, max(TerrariumLayout.swimMinY + 0.08, homeY))
        return (
            max(TerrariumLayout.swimMinX, centerX - halfWidth),
            min(TerrariumLayout.swimMaxX, centerX + halfWidth),
            max(TerrariumLayout.swimMinY, centerY - verticalSlack),
            min(TerrariumLayout.swimMaxY, centerY + verticalSlack),
            centerX,
            centerY
        )
    }

    /// Current live position for tetra attractor tracking
    func currentPosition() -> (x: Float, y: Float) {
        (simulationX, simulationY)
    }

    /// Whether this octopus is currently working
    func isWorking() -> Bool {
        visualState == .working
    }

    // MARK: - Draw

    func draw(context: inout GraphicsContext, size: CGSize) {
        let w = Float(size.width)
        let h = Float(size.height)
        let bodyRadius = w * TerrariumLayout.octopusBodyRadius * scale

        let centerX = currentX * w

        // Bob only when swimming (WORKING)
        let bobOffset: Float = visualState == .working ?
            sin(time * 2 * Float.pi / TerrariumTiming.bobPeriod) * h * TerrariumTiming.bobAmplitude : 0
        let centerY = currentY * h + bobOffset

        let bodyAlpha: Float = visualState == .sleeping ? 0.4 : 1.0

        // Draw SVG robot body
        drawSvgBody(context: &context, cx: centerX, cy: centerY, bodyRadius: bodyRadius, alpha: bodyAlpha)

        // WORKING: starburst sparkle
        if visualState == .working {
            drawStarburst(context: &context, cx: centerX, cy: centerY,
                          radius: bodyRadius * 0.55, alpha: bodyAlpha * 0.7)
        }

        // ASKING: speech bubble with "?"
        if visualState == .asking {
            drawSpeechBubble(context: &context, cx: CGFloat(centerX), cy: CGFloat(centerY),
                             bodyRadius: CGFloat(bodyRadius))
        }

        // Name tag
        if let name = displayName {
            drawNameTag(
                context: &context,
                name: name,
                cx: CGFloat(centerX),
                cy: CGFloat(centerY),
                bodyRadius: CGFloat(bodyRadius),
                canvasWidth: size.width
            )
        }
    }

    // MARK: - SVG Body Drawing

    private func drawSvgBody(context: inout GraphicsContext, cx: Float, cy: Float,
                              bodyRadius: Float, alpha: Float) {
        let bodyColor = bodyColorForState()
        // Scale SVG 24×24 viewbox so robot width = bodyRadius * 2
        let totalScale = CGFloat(bodyRadius * 2) / Self.svgViewBox

        // Subtle breath scale when not sleeping
        let breathScale: CGFloat = switch visualState {
        case .sleeping: 1.0
        case .working: CGFloat(1.0 + sin(time * 2) * 0.015)
        default: CGFloat(1.0 + sin(time * 0.6) * 0.008)
        }

        let s = totalScale * breathScale
        // Center the 24×24 viewbox at (cx, cy)
        let offsetX = CGFloat(cx) - Self.svgViewBox / 2 * s
        let offsetY = CGFloat(cy) - Self.svgViewBox / 2 * s

        // Transform: scale then translate
        var t = CGAffineTransform(scaleX: s, y: s)
            .concatenating(CGAffineTransform(translationX: offsetX, y: offsetY))

        if let transformed = Self.robotPath.copy(using: &t) {
            context.fill(Path(transformed),
                         with: .linearGradient(
                            Gradient(colors: [
                                TerrariumColors.lerpColor(bodyColor, TerrariumColors.hudText, 0.18).opacity(Double(alpha)),
                                bodyColor.opacity(Double(alpha)),
                                TerrariumColors.lerpColor(bodyColor, TerrariumColors.deepSea, 0.30).opacity(Double(alpha)),
                            ]),
                            startPoint: CGPoint(x: offsetX, y: offsetY),
                            endPoint: CGPoint(x: offsetX + 24 * s, y: offsetY + 24 * s)),
                         style: FillStyle(eoFill: true))
        }

        CreatureBrandFeatures.draw("claudecode", context: context, transform: t)
    }

    private func bodyColorForState() -> Color {
        if visualState == .working {
            // Pulse between body and bodyLight during WORKING
            let t = (sin(time * TerrariumTiming.thinkingPulseSpeed) * 0.5 + 0.5)
            return lerpColor(TerrariumColors.claudeBody, TerrariumColors.claudeBodyLight, t)
        }
        return TerrariumColors.claudeBody
    }

    // MARK: - Starburst

    private func drawStarburst(context: inout GraphicsContext, cx: Float, cy: Float,
                                radius: Float, alpha: Float) {
        let rotation = time * 0.5
        let pulse = sin(time * TerrariumTiming.thinkingPulseSpeed) * 0.15 + 0.85

        for i in 0..<TerrariumTiming.starburstArmCount {
            let baseAngle = (Float(i) / Float(TerrariumTiming.starburstArmCount)) * 2 * Float.pi + rotation
            let armLen = radius * pulse * Self.starburstArmLengths[i % Self.starburstArmLengths.count]
            let endX = cx + cos(baseAngle) * armLen
            let endY = cy + sin(baseAngle) * armLen

            var path = Path()
            path.move(to: CGPoint(x: CGFloat(cx), y: CGFloat(cy)))
            path.addLine(to: CGPoint(x: CGFloat(endX), y: CGFloat(endY)))
            context.stroke(path,
                           with: .color(TerrariumColors.claudeBody.opacity(Double(alpha) * 0.35)),
                           lineWidth: CGFloat(radius * 0.10))
        }
    }

    // MARK: - Speech Bubble

    private func drawSpeechBubble(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyRadius: CGFloat) {
        // Position: right side at body center — avoids overlapping name tag above
        let bubbleX = cx + bodyRadius * 1.2
        let bubbleY = cy
        let bubbleR = bodyRadius * 0.7

        let pulse = CGFloat(sin(time * 2.5)) * 0.08 + 1
        let r = bubbleR * pulse

        // Bubble fill
        let bubbleRect = CGRect(x: bubbleX - r, y: bubbleY - r, width: r * 2, height: r * 2)
        context.fill(Path(ellipseIn: bubbleRect), with: .color(.white.opacity(0.25)))

        // Bubble border
        context.stroke(Path(ellipseIn: bubbleRect),
                       with: .color(TerrariumColors.hudText.opacity(0.5)),
                       lineWidth: bodyRadius * 0.04)

        // Tail triangle
        var tail = Path()
        tail.move(to: CGPoint(x: bubbleX - r * 0.3, y: bubbleY + r * 0.3))
        tail.addLine(to: CGPoint(x: cx + bodyRadius * 0.5, y: cy))
        tail.addLine(to: CGPoint(x: bubbleX - r * 0.05, y: bubbleY + r * 0.5))
        tail.closeSubpath()
        context.fill(tail, with: .color(.white.opacity(0.25)))

        // "?" text
        context.draw(
            Text("?").font(.system(size: r * 1.2, weight: .bold)).foregroundColor(TerrariumColors.hudText.opacity(0.7)),
            at: CGPoint(x: bubbleX, y: bubbleY)
        )
    }

    // MARK: - Name Tag

    private func drawNameTag(context: inout GraphicsContext, name: String,
                             cx: CGFloat, cy: CGFloat, bodyRadius: CGFloat, canvasWidth: CGFloat) {
        drawTerrariumNameTag(
            context: &context,
            name: name,
            cx: cx,
            bodyTopY: cy - bodyRadius * 0.583,
            bodyMetric: terrariumNameTagMetric(canvasWidth: canvasWidth, scale: scale),
            backgroundColor: TerrariumColors.claudeNameBg,
            rank: visualState == .asking ? .awaiting : visualState == .working ? .working : .idle
        )
    }
}

// MARK: - Helpers

private func lerpColor(_ a: Color, _ b: Color, _ t: Float) -> Color {
    TerrariumColors.lerpColor(a, b, t)
}
