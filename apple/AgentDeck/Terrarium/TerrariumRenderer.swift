// TerrariumRenderer.swift — Assembles all creature + environment subsystems
// 17-layer rendering order matching Android ColorRenderer.kt

import SwiftUI

final class TerrariumRenderer {
    // MARK: - Creatures

    private var octopuses: [String: OctopusCreature] = [:]
    private var clouds: [String: CloudCreature] = [:]
    private var opencodeCreatures: [String: OpenCodeCreature] = [:]
    private var antigravityCreatures: [String: AntigravityCreature] = [:]
    private var kiroCreatures: [String: KiroCreature] = [:]
    private let crayfish = CrayfishCreature()
    private let tetra = DataParticleSystem()
    private let bubbles = BubbleSystem()

    // MARK: - Environment

    private let waterEffect = WaterEffect()
    private let waterSurface = WaterSurface()
    private let lightRays = LightRaySystem()
    private let kelp = KelpField()
    private let rocks = RockFormation()
    private let plankton = PlanktonSystem()
    private let sand = SandDisturbance()

    // MARK: - State

    private var lastState: TerrariumState?
    private var envState: EnvironmentVisualState = .calm

    // Delta-time tracking (stored here instead of @State to avoid triggering SwiftUI re-renders)
    private var lastDate: Date?

    // Creature bubble exhale timers
    private var octoBubbleTimer: Float = 0
    private var crayfishBubbleTimer: Float = 0
    private var opencodeBubbleTimer: Float = 0
    private var antigravityBubbleTimer: Float = 0

    // Focus halo
    private var focusedSessionId: String?
    private var focusPulse: Float = 0
    private var subagentOrbitPhase: Float = 0
    private var currentTimeMs: Double = 0
    /// 0..1 envelope. Ramps up when a creature gains focus, fades down when
    /// the focused creature has no on-screen sprite (or focus cleared).
    /// Avoids halo "snapping" on/off when sessions reorganize.
    private var focusPresence: Float = 0

    // MARK: - Delta Time

    /// Compute dt from wall-clock, storing lastDate internally to avoid @State mutation.
    func deltaTime(now: Date) -> Float {
        let dt: Float
        if let last = lastDate {
            dt = min(Float(now.timeIntervalSince(last)), 0.05)
        } else {
            dt = 0.016
        }
        lastDate = now
        return dt
    }

    // MARK: - Update

    func update(dt: Float, state: TerrariumState) {
        // Environment state propagation
        envState = state.environment
        waterEffect.setState(envState)
        waterSurface.setState(envState)
        lightRays.setState(envState)
        plankton.setState(envState)
        sand.setState(envState)
        bubbles.setState(envState)

        // Sync creature lifecycles
        syncOctopuses(state: state)
        syncClouds(state: state)
        syncOpenCode(state: state)
        syncAntigravity(state: state)
        syncKiro(state: state)

        // Focus halo state
        focusedSessionId = state.focusedSessionId
        focusPulse += dt * 1.6
        subagentOrbitPhase += dt * 0.72
        currentTimeMs = Date().timeIntervalSince1970 * 1000
        let hasVisibleFocus: Bool = {
            guard let id = focusedSessionId else { return false }
            return octopuses[id] != nil ||
                clouds[id] != nil ||
                opencodeCreatures[id] != nil ||
                antigravityCreatures[id] != nil ||
                kiroCreatures[id] != nil ||
                (isCrayfishFocusId(id) && crayfish.visible)
        }()
        let presenceTarget: Float = hasVisibleFocus ? 1.0 : 0.0
        focusPresence += (presenceTarget - focusPresence) * min(1.0, dt * 6.0)

        // Update all subsystems
        waterEffect.update(dt: dt)
        waterSurface.update(dt: dt)
        lightRays.update(dt: dt)
        kelp.update(dt: dt)
        plankton.update(dt: dt)
        rocks.update(dt: dt)

        // Creature positions for environment coupling
        let octPositions = octopuses.values.map { oct -> (x: Float, y: Float) in
            (oct.currentX, oct.currentY)
        }

        // Sand disturbance
        sand.creaturePositions = octPositions
        for oc in opencodeCreatures.values where oc.visualState != .dormant {
            sand.creaturePositions.append(oc.currentPosition())
        }
        for ag in antigravityCreatures.values {
            sand.creaturePositions.append(ag.currentPosition())
        }
        for k in kiroCreatures.values {
            sand.creaturePositions.append(k.currentPosition())
        }
        if crayfish.visible {
            sand.creaturePositions.append(crayfish.currentPosition())
        }
        sand.update(dt: dt)

        // Bubbles
        bubbles.update(dt: dt)

        // Handle pop burst triggers
        for pos in state.popBurstPositions {
            bubbles.emitPopBurst(x: pos.x, y: pos.y)
        }

        // Creature bubble exhales
        octoBubbleTimer += dt
        crayfishBubbleTimer += dt
        if octoBubbleTimer >= TerrariumTiming.octoBubbleInterval {
            octoBubbleTimer = 0
            for oct in octopuses.values where oct.visualState != .sleeping {
                bubbles.emitCreatureBubbles(x: oct.currentX, y: oct.currentY - 0.02, count: 1)
            }
        }
        if crayfishBubbleTimer >= TerrariumTiming.crayfishBubbleInterval && crayfish.visible {
            crayfishBubbleTimer = 0
            let pos = crayfish.currentPosition()
            bubbles.emitCreatureBubbles(x: pos.x, y: pos.y - 0.02, count: 1)
        }
        opencodeBubbleTimer += dt
        if opencodeBubbleTimer >= TerrariumTiming.octoBubbleInterval {
            opencodeBubbleTimer = 0
            for oc in opencodeCreatures.values where oc.visualState != .dormant {
                let pos = oc.currentPosition()
                bubbles.emitCreatureBubbles(x: pos.x, y: pos.y - 0.02, count: 1)
            }
        }
        antigravityBubbleTimer += dt
        if antigravityBubbleTimer >= TerrariumTiming.octoBubbleInterval {
            antigravityBubbleTimer = 0
            for ag in antigravityCreatures.values where ag.visualState != .sleeping {
                let pos = ag.currentPosition()
                bubbles.emitCreatureBubbles(x: pos.x, y: pos.y - 0.02, count: 1)
            }
            for k in kiroCreatures.values where k.visualState != .sleeping {
                let pos = k.currentPosition()
                bubbles.emitCreatureBubbles(x: pos.x, y: pos.y - 0.02, count: 1)
            }
        }

        // Tetra coupling — working octopi + pulsing jellyfish attract fish
        var workingPositions = state.creatures
            .filter { $0.state == .working }
            .map { ($0.homeX, $0.homeY) }
        workingPositions += state.cloudCreatures
            .filter { $0.state == .pulsing }
            .map { ($0.homeX, $0.homeY) }
        workingPositions += state.opencodeCreatures
            .filter { $0.state == .pulsing }
            .map { ($0.homeX, $0.homeY) }
        workingPositions += state.antigravityCreatures
            .filter { $0.state == .working }
            .map { ($0.homeX, $0.homeY) }
        workingPositions += state.kiroCreatures
            .filter { $0.state == .working }
            .map { ($0.homeX, $0.homeY) }
        tetra.octopusPositions = workingPositions
        tetra.crayfishPosition = crayfish.visible ? crayfish.currentPosition() : nil
        tetra.crayfishRouting = crayfish.isRouting()
        tetra.update(dt: dt, state: state)

        // Creatures
        for oct in octopuses.values {
            oct.update(dt: dt, state: state)
        }
        for cl in clouds.values {
            cl.update(dt: dt, state: state)
        }
        for oc in opencodeCreatures.values {
            oc.update(dt: dt, state: state)
        }
        for ag in antigravityCreatures.values {
            ag.update(dt: dt, state: state)
        }
        for k in kiroCreatures.values {
            k.update(dt: dt, state: state)
        }
        crayfish.update(dt: dt, state: state)

        lastState = state
    }

    // MARK: - Draw (layer order matching Android ColorRenderer)

    func draw(context: inout GraphicsContext, size: CGSize) {
        // Layer 1: Deep-sea 3-color gradient background
        drawBackground(context: &context, size: size)

        // Layer 2: Caustics overlay
        waterEffect.draw(context: &context, size: size)

        // Layer 2.5: God rays (light shafts)
        lightRays.draw(context: &context, size: size)

        // Layer 2.7: Back-layer plankton
        plankton.drawBackLayer(context: &context, size: size)

        // Layer 4: Rocks + sand
        rocks.draw(context: &context, size: size)

        // Layer 4.5: Sand disturbance particles
        sand.draw(context: &context, size: size)

        // Layer 5: Kelp + grass
        kelp.draw(context: &context, size: size)

        // Layer 6: LED cables on rocks
        rocks.drawLEDs(context: &context, size: size, envState: envState)

        // Layer 6.5: Back-layer fish (behind creatures for 3D depth)
        tetra.drawBackLayer(context: &context, size: size)

        // Layer 6.7: Focus halo (drawn behind every creature so the sprite
        // sits cleanly inside the glow). Driven by stateHolder's focused
        // session id; dashboards send a `focus_session` command on session
        // row taps so this is the visible feedback for that gesture.
        drawFocusHalo(context: &context, size: size)

        // Layer 6.8: read-only parent/child topology. The dashed Saturn ring
        // and wired satellites belong to the parent creature and never enter
        // hit testing, session selection, approval, or steering paths.
        drawSubagentOrbits(context: &context, size: size)

        // Layer 7: Crayfish
        crayfish.draw(context: &context, size: size)

        // Layer 9: Octopuses
        for oct in octopuses.values {
            oct.draw(context: &context, size: size)
        }

        // Layer 9.2: Clouds (between octopuses and front fish)
        for cl in clouds.values {
            cl.draw(context: &context, size: size)
        }

        // Layer 9.3: OpenCode creatures
        for oc in opencodeCreatures.values {
            oc.draw(context: &context, size: size)
        }

        // Layer 9.4: Antigravity creatures
        for ag in antigravityCreatures.values {
            ag.draw(context: &context, size: size)
        }

        // Layer 9.45: Kiro ghosts
        for k in kiroCreatures.values {
            k.draw(context: &context, size: size)
        }

        // Layer 9.5: Front-layer fish
        tetra.drawFrontLayer(context: &context, size: size)

        // Layer 9.7: Front-layer plankton
        plankton.drawFrontLayer(context: &context, size: size)

        // Layer 10: Bubbles
        bubbles.draw(context: &context, size: size)

        // Layer 10.5: Water surface line
        waterSurface.draw(context: &context, size: size)

        // Layer 11: Error tint overlay
        if lastState?.hasError == true {
            let rect = CGRect(origin: .zero, size: size)
            context.fill(Path(rect), with: .color(TerrariumColors.errorTint))
        }
    }

    // MARK: - Focus Halo

    /// Soft cyan glow + ring drawn behind the creature whose session id is
    /// currently focused. Pulses gently so the user can spot the focus
    /// shift after tapping a row in `SessionListPanel` / menubar
    /// `ControlTowerPanel`. Falls through silently when the focused id has
    /// no on-screen sprite (e.g. focus on a non-cloud sibling that lives
    /// off-canvas, or no creatures yet).
    private func drawFocusHalo(context: inout GraphicsContext, size: CGSize) {
        guard let id = focusedSessionId, focusPresence > 0.01 else { return }

        let pos: (x: Float, y: Float, scale: Float)?
        if let oct = octopuses[id] {
            pos = (oct.currentX, oct.currentY, oct.scale)
        } else if let cl = clouds[id] {
            pos = (cl.currentX, cl.currentY, cl.scale)
        } else if let oc = opencodeCreatures[id] {
            pos = (oc.currentX, oc.currentY, oc.scale)
        } else if let ag = antigravityCreatures[id] {
            pos = (ag.currentX, ag.currentY, ag.scale)
        } else if let k = kiroCreatures[id] {
            pos = (k.currentX, k.currentY, k.scale)
        } else if isCrayfishFocusId(id), crayfish.visible {
            let cp = crayfish.currentPosition()
            pos = (cp.x, cp.y, 1.1)
        } else {
            pos = nil
        }
        guard let p = pos else { return }

        let cx = CGFloat(p.x) * size.width
        let cy = CGFloat(p.y) * size.height

        let pulse = 0.5 + 0.5 * sin(focusPulse)
        let presence = CGFloat(focusPresence)

        let minDim = min(size.width, size.height)
        let baseRadius = CGFloat(p.scale) * 0.085 * minDim
        let pulseRadius = baseRadius * (1.0 + 0.10 * CGFloat(pulse))

        // Soft inner disc — subtle glow filling the halo.
        let discRect = CGRect(
            x: cx - pulseRadius,
            y: cy - pulseRadius,
            width: pulseRadius * 2,
            height: pulseRadius * 2
        )
        let discAlpha = (0.18 + 0.18 * Double(pulse)) * Double(presence)
        context.fill(
            Path(ellipseIn: discRect),
            with: .color(TerrariumColors.tetraNeon.opacity(discAlpha))
        )

        // Crisp neon outline ring.
        let ringRadius = pulseRadius * 1.05
        let ringRect = CGRect(
            x: cx - ringRadius,
            y: cy - ringRadius,
            width: ringRadius * 2,
            height: ringRadius * 2
        )
        let ringAlpha = (0.55 + 0.25 * Double(pulse)) * Double(presence)
        context.stroke(
            Path(ellipseIn: ringRect),
            with: .color(TerrariumColors.tetraNeon.opacity(ringAlpha)),
            lineWidth: 1.5
        )
    }

    private func isCrayfishFocusId(_ id: String) -> Bool {
        id == "openclaw-gateway" || id == "crayfish"
    }

    // MARK: - Subagent Orbits

    private func drawSubagentOrbits(context: inout GraphicsContext, size: CGSize) {
        guard let state = lastState else { return }

        for creature in state.creatures {
            guard let live = octopuses[creature.id] else { continue }
            drawSubagentOrbit(
                context: &context,
                size: size,
                x: live.currentX,
                y: live.currentY,
                scale: live.scale,
                activity: creature.subagentActivity
            )
        }
        for creature in state.cloudCreatures {
            guard let live = clouds[creature.id] else { continue }
            drawSubagentOrbit(
                context: &context,
                size: size,
                x: live.currentX,
                y: live.currentY,
                scale: live.scale,
                activity: creature.subagentActivity
            )
        }
        for creature in state.opencodeCreatures {
            guard let live = opencodeCreatures[creature.id] else { continue }
            drawSubagentOrbit(
                context: &context,
                size: size,
                x: live.currentX,
                y: live.currentY,
                scale: live.scale,
                activity: creature.subagentActivity
            )
        }
        for creature in state.antigravityCreatures {
            guard let live = antigravityCreatures[creature.id] else { continue }
            drawSubagentOrbit(
                context: &context,
                size: size,
                x: live.currentX,
                y: live.currentY,
                scale: live.scale,
                activity: creature.subagentActivity
            )
        }
        for creature in state.kiroCreatures {
            guard let live = kiroCreatures[creature.id] else { continue }
            drawSubagentOrbit(
                context: &context,
                size: size,
                x: live.currentX,
                y: live.currentY,
                scale: live.scale,
                activity: creature.subagentActivity
            )
        }
    }

    private func drawSubagentOrbit(
        context: inout GraphicsContext,
        size: CGSize,
        x: Float,
        y: Float,
        scale: Float,
        activity: SubagentVisualActivity
    ) {
        let completionAge = currentTimeMs - (activity.lastCompletedAt ?? 0)
        let completionProgress = completionAge >= 0 && completionAge < 4_000
            ? CGFloat(completionAge / 4_000)
            : nil
        guard activity.activeCount > 0 || completionProgress != nil else { return }

        let center = CGPoint(x: CGFloat(x) * size.width, y: CGFloat(y) * size.height)
        let minDim = min(size.width, size.height)
        let radiusX = max(24, CGFloat(scale) * minDim * 0.115)
        let radiusY = radiusX * 0.38
        let tilt = CGFloat(-0.28)

        func point(angle: CGFloat, radiusMultiplier: CGFloat = 1) -> CGPoint {
            let localX = cos(angle) * radiusX * radiusMultiplier
            let localY = sin(angle) * radiusY * radiusMultiplier
            return CGPoint(
                x: center.x + localX * cos(tilt) - localY * sin(tilt),
                y: center.y + localX * sin(tilt) + localY * cos(tilt)
            )
        }

        if activity.activeCount > 0 {
            var ring = Path()
            for index in 0...48 {
                let angle = CGFloat(index) / 48 * .pi * 2
                let p = point(angle: angle)
                if index == 0 {
                    ring.move(to: p)
                } else {
                    ring.addLine(to: p)
                }
            }
            context.stroke(
                ring,
                with: .color(TerrariumColors.tetraNeon.opacity(0.48)),
                style: StrokeStyle(lineWidth: 1, dash: [3, 4])
            )

            let visibleCount = min(activity.activeCount, 3)
            for index in 0..<visibleCount {
                let angle = CGFloat(subagentOrbitPhase)
                    + CGFloat(index) * (.pi * 2 / CGFloat(visibleCount))
                let satellite = point(angle: angle)

                var wire = Path()
                wire.move(to: center)
                wire.addLine(to: satellite)
                context.stroke(
                    wire,
                    with: .color(TerrariumColors.tetraNeon.opacity(0.18)),
                    lineWidth: 0.75
                )

                let nodeRadius: CGFloat = index == 2 && activity.activeCount > 3 ? 4.2 : 3.2
                let nodeRect = CGRect(
                    x: satellite.x - nodeRadius,
                    y: satellite.y - nodeRadius,
                    width: nodeRadius * 2,
                    height: nodeRadius * 2
                )
                context.fill(
                    Path(ellipseIn: nodeRect),
                    with: .color(TerrariumColors.tetraNeon.opacity(0.94))
                )

                if index == 2 && activity.activeCount > 3 {
                    context.draw(
                        Text("+\(activity.activeCount - 3)")
                            .font(.system(size: max(8, minDim * 0.014), weight: .semibold))
                            .foregroundStyle(TerrariumColors.tetraNeon),
                        at: CGPoint(x: satellite.x + 10, y: satellite.y - 7)
                    )
                }
            }
        }

        if let progress = completionProgress {
            let pulseRadius = radiusX * (0.72 + progress * 0.58)
            let alpha = Double(1 - progress) * 0.72
            let pulseRect = CGRect(
                x: center.x - pulseRadius,
                y: center.y - pulseRadius,
                width: pulseRadius * 2,
                height: pulseRadius * 2
            )
            context.stroke(
                Path(ellipseIn: pulseRect),
                with: .color(TerrariumColors.tetraNeon.opacity(alpha)),
                lineWidth: 1.5
            )
        }
    }

    // MARK: - Background (3-color gradient, environment-adaptive)

    private func drawBackground(context: inout GraphicsContext, size: CGSize) {
        let topColor: Color
        switch envState {
        case .dark:
            topColor = TerrariumColors.deepSea.opacity(0.5)
        case .calm:
            topColor = TerrariumColors.shallowWater
        case .active:
            topColor = TerrariumColors.shallowWater.opacity(0.9)
        case .alert:
            topColor = Color(red: 0.102, green: 0.239, blue: 0.361) // #1A3D5C
        }

        let rect = CGRect(origin: .zero, size: size)
        context.fill(
            Path(rect),
            with: .linearGradient(
                Gradient(colors: [topColor, TerrariumColors.midWater, TerrariumColors.deepSea]),
                startPoint: .zero,
                endPoint: CGPoint(x: 0, y: size.height)
            )
        )
    }

    // MARK: - Octopus Lifecycle

    private func syncClouds(state: TerrariumState) {
        let currentIds = Set(state.cloudCreatures.map(\.id))
        let existingIds = Set(clouds.keys)

        // Remove departed
        for id in existingIds.subtracting(currentIds) {
            clouds.removeValue(forKey: id)
        }

        // Add new or update existing
        for creature in state.cloudCreatures {
            if clouds[creature.id] == nil {
                let cl = CloudCreature(
                    sessionId: creature.id,
                    homeX: creature.homeX,
                    homeY: creature.homeY,
                    scale: creature.scale
                )
                cl.displayName = creature.projectName
                cl.onWaitingExit = { [weak self] in
                    self?.bubbles.emitPopBurst(x: creature.homeX, y: creature.homeY)
                }
                clouds[creature.id] = cl
            } else {
                let cl = clouds[creature.id]!
                cl.homeX = creature.homeX
                cl.homeY = creature.homeY
                cl.scale = creature.scale
                cl.displayName = creature.projectName
            }
        }
    }

    private func syncOpenCode(state: TerrariumState) {
        let currentIds = Set(state.opencodeCreatures.map(\.id))
        let existingIds = Set(opencodeCreatures.keys)

        // Remove departed
        for id in existingIds.subtracting(currentIds) {
            opencodeCreatures.removeValue(forKey: id)
        }

        // Add new or update existing
        for creature in state.opencodeCreatures {
            if opencodeCreatures[creature.id] == nil {
                let oc = OpenCodeCreature(
                    sessionId: creature.id,
                    homeX: creature.homeX,
                    homeY: creature.homeY,
                    scale: creature.scale
                )
                oc.displayName = creature.projectName
                oc.onWaitingExit = { [weak self] in
                    self?.bubbles.emitPopBurst(x: creature.homeX, y: creature.homeY)
                }
                opencodeCreatures[creature.id] = oc
            } else {
                let oc = opencodeCreatures[creature.id]!
                oc.homeX = creature.homeX
                oc.homeY = creature.homeY
                oc.scale = creature.scale
                oc.displayName = creature.projectName
            }
        }
    }

    private func syncKiro(state: TerrariumState) {
        let currentIds = Set(state.kiroCreatures.map(\.id))
        let existingIds = Set(kiroCreatures.keys)

        for id in existingIds.subtracting(currentIds) {
            kiroCreatures.removeValue(forKey: id)
        }

        for creature in state.kiroCreatures {
            if kiroCreatures[creature.id] == nil {
                let k = KiroCreature(
                    sessionId: creature.id,
                    homeX: creature.homeX,
                    homeY: creature.homeY,
                    scale: creature.scale
                )
                k.displayName = creature.projectName
                k.onAskingExit = { [weak self] in
                    self?.bubbles.emitPopBurst(x: creature.homeX, y: creature.homeY)
                }
                kiroCreatures[creature.id] = k
            } else {
                let k = kiroCreatures[creature.id]!
                k.homeX = creature.homeX
                k.homeY = creature.homeY
                k.scale = creature.scale
                k.displayName = creature.projectName
            }
        }
    }

    private func syncAntigravity(state: TerrariumState) {
        let currentIds = Set(state.antigravityCreatures.map(\.id))
        let existingIds = Set(antigravityCreatures.keys)

        // Remove departed
        for id in existingIds.subtracting(currentIds) {
            antigravityCreatures.removeValue(forKey: id)
        }

        // Add new or update existing
        for creature in state.antigravityCreatures {
            if antigravityCreatures[creature.id] == nil {
                let ag = AntigravityCreature(
                    sessionId: creature.id,
                    homeX: creature.homeX,
                    homeY: creature.homeY,
                    scale: creature.scale
                )
                ag.displayName = creature.projectName
                ag.onAskingExit = { [weak self] in
                    self?.bubbles.emitPopBurst(x: creature.homeX, y: creature.homeY)
                }
                antigravityCreatures[creature.id] = ag
            } else {
                let ag = antigravityCreatures[creature.id]!
                ag.homeX = creature.homeX
                ag.homeY = creature.homeY
                ag.scale = creature.scale
                ag.displayName = creature.projectName
            }
        }
    }

    // MARK: - Hit Testing

    /// Returns the session ID of the creature nearest to the given normalized point (0..1),
    /// or nil if no creature is within the hit radius.
    func creatureAtPoint(nx: Float, ny: Float, hitRadius: Float = 0.08) -> String? {
        var bestId: String?
        var bestDist: Float = hitRadius

        for (id, oct) in octopuses {
            let dx = oct.currentX - nx
            let dy = oct.currentY - ny
            let dist = sqrt(dx * dx + dy * dy)
            if dist < bestDist {
                bestDist = dist
                bestId = id
            }
        }

        for (id, cl) in clouds {
            let dx = cl.currentX - nx
            let dy = cl.currentY - ny
            let dist = sqrt(dx * dx + dy * dy)
            if dist < bestDist {
                bestDist = dist
                bestId = id
            }
        }

        for (id, oc) in opencodeCreatures {
            let dx = oc.currentX - nx
            let dy = oc.currentY - ny
            let dist = sqrt(dx * dx + dy * dy)
            if dist < bestDist {
                bestDist = dist
                bestId = id
            }
        }

        for (id, ag) in antigravityCreatures {
            let dx = ag.currentX - nx
            let dy = ag.currentY - ny
            let dist = sqrt(dx * dx + dy * dy)
            if dist < bestDist {
                bestDist = dist
                bestId = id
            }
        }

        if crayfish.visible {
            let pos = crayfish.currentPosition()
            let dx = pos.x - nx
            let dy = pos.y - ny
            let dist = sqrt(dx * dx + dy * dy)
            if dist < bestDist {
                bestDist = dist
                bestId = "crayfish"  // sentinel — crayfish is gateway, not a session
            }
        }

        return bestId
    }

    private func syncOctopuses(state: TerrariumState) {
        let currentIds = Set(state.creatures.map(\.id))
        let existingIds = Set(octopuses.keys)

        // Remove departed
        for id in existingIds.subtracting(currentIds) {
            octopuses.removeValue(forKey: id)
        }

        // Add new or update existing
        for creature in state.creatures {
            if octopuses[creature.id] == nil {
                let oct = OctopusCreature(
                    sessionId: creature.id,
                    homeX: creature.homeX,
                    homeY: creature.homeY,
                    scale: creature.scale
                )
                oct.displayName = creature.projectName
                oct.onAskingExit = { [weak self] in
                    self?.bubbles.emitPopBurst(x: creature.homeX, y: creature.homeY)
                }
                octopuses[creature.id] = oct
            } else {
                let oct = octopuses[creature.id]!
                oct.homeX = creature.homeX
                oct.homeY = creature.homeY
                oct.scale = creature.scale
                oct.displayName = creature.projectName
            }
        }
    }
}
