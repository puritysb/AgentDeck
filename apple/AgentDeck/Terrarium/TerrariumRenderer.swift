// TerrariumRenderer.swift — Assembles all creature + environment subsystems
// 17-layer rendering order matching Android ColorRenderer.kt

import SwiftUI
import simd

final class TerrariumRenderer {
    // MARK: - Creatures

    private var octopuses: [String: OctopusCreature] = [:]
    private var clouds: [String: CloudCreature] = [:]
    private var opencodeCreatures: [String: OpenCodeCreature] = [:]
    private var antigravityCreatures: [String: AntigravityCreature] = [:]
    private var kiroCreatures: [String: KiroCreature] = [:]
    private var hermesCreatures: [String: HermesCreature] = [:]
    var animateHermes = true
    var animateCompanions = true
    private var ciMotions: [String: CiCompanionMotion] = [:]
    private var ciCenters: [String: SIMD2<Float>] = [:]
    private var ciPoints: [String: SIMD2<Float>] = [:]
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
    private(set) var backgroundOrbitPhase: Float = 0
    private(set) var broods: [String: BackgroundBrood] = [:]
    /// Brood ids in sorted order, kept as broods come and go (never sorted per frame).
    private var broodIDs: [String] = []
    /// Width over height of the last drawn canvas, for body-radius distances.
    private var canvasAspect: Float = 1.6
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

    func update(dt: Float, state sourceState: TerrariumState) {
        if animateCompanions {
            backgroundOrbitPhase += min(max(dt, 0), 0.05) * BackgroundWorkPresentation.radiansPerSecond
        }
        var state = sourceState
        let foreground = AquariumResident.foreground(AquariumResident.project(state), focusedID: state.focusedSessionId)
        let visibleIDs = Set(foreground.map(\.id))
        state.creatures = state.creatures.filter { visibleIDs.contains($0.id) }
        state.cloudCreatures = state.cloudCreatures.filter { visibleIDs.contains($0.id) }
        state.opencodeCreatures = state.opencodeCreatures.filter { visibleIDs.contains($0.id) }
        state.antigravityCreatures = state.antigravityCreatures.filter { visibleIDs.contains($0.id) }
        state.kiroCreatures = state.kiroCreatures.filter { visibleIDs.contains($0.id) }
        state.hermesCreatures = state.hermesCreatures.filter { visibleIDs.contains($0.id) }
        state.crayfishVisible = state.crayfishVisible && visibleIDs.contains("crayfish")
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
        let hermesIDs = Set(state.hermesCreatures.map(\.id))
        hermesCreatures = hermesCreatures.filter { hermesIDs.contains($0.key) }
        for (index, item) in state.hermesCreatures.enumerated() {
            if hermesCreatures[item.id] == nil {
                hermesCreatures[item.id] = HermesCreature(id: item.id, index: index, count: hermesIDs.count)
            }
            hermesCreatures[item.id]?.home = [Float(index - hermesIDs.count / 2) * 0.9, 2.5, 0]
            hermesCreatures[item.id]?.scale = min(1, 3 / Float(max(1, hermesIDs.count)))
            hermesCreatures[item.id]?.update(dt: animateHermes ? dt : 0, state: state)
        }

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
                hermesCreatures[id] != nil ||
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
        spreadFloorOctopuses()
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

        // Jar buddies, for every creature kind through one path: counts finish on
        // an explicit decrease, then the follow point and finishes advance.
        // nil stays nil: an unknown count is retained, never read as zero.
        let broodDt = animateCompanions ? min(max(dt, 0), 0.05) : 0
        if broodIDs.contains(where: { residentPose($0) == nil }) {
            broodIDs.removeAll { residentPose($0) == nil }
            broods = broods.filter { residentPose($0.key) != nil }
        }
        for resident in foreground {
            let explicit = state.backgroundTaskCounts[resident.id]
            guard broods[resident.id] != nil || (explicit ?? 0) > 0, let pose = residentPose(resident.id) else { continue }
            if broods[resident.id] == nil {
                broods[resident.id] = BackgroundBrood()
                // Stable draw order: buddies of overlapping creatures never swap layers.
                broodIDs.insert(resident.id, at: broodIDs.firstIndex { $0 > resident.id } ?? broodIDs.endIndex)
            }
            // Mutate in place: a copied brood would reallocate its spacing every frame.
            broods[resident.id]?.observe(explicit: explicit, working: resident.activity == .working,
                                         position: pose.center, phase: backgroundOrbitPhase, animate: animateCompanions)
        }
        // Advance every brood whose creature still has a pose, in or out of the
        // foreground, so a finish already playing completes.
        for id in broodIDs {
            guard let pose = residentPose(id) else { continue }
            if !visibleIDs.contains(id) {
                broods[id]?.observe(explicit: nil, working: false, position: pose.center,
                                    phase: backgroundOrbitPhase, animate: animateCompanions)
            }
            guard let brood = broods[id], !brood.isEmpty || !brood.hasSettled else { continue }
            // The first frame snaps into even spacing; later ones ease.
            broods[id]?.advance(dt: brood.hasSettled ? broodDt : 0, position: pose.center,
                                room: broodRoom(id, pose, among: foreground), phase: backgroundOrbitPhase)
        }

        ciCenters = octopuses.mapValues { [ $0.currentX,$0.currentY ] }
            .merging(clouds.mapValues { [$0.currentX,$0.currentY] }) { a,_ in a }
            .merging(opencodeCreatures.mapValues { [$0.currentX,$0.currentY] }) { a,_ in a }
            .merging(antigravityCreatures.mapValues { [$0.currentX,$0.currentY] }) { a,_ in a }
            .merging(kiroCreatures.mapValues { [$0.currentX,$0.currentY] }) { a,_ in a }
            .merging(hermesCreatures.mapValues { [$0.currentX,$0.currentY] }) { a,_ in a }
        for id in ciCenters.keys {
            guard let wait = state.ciWaits[id] else { ciMotions.removeValue(forKey:id);continue }
            var motion = ciMotions[id] ?? CiCompanionMotion(id:id)
            motion.update(wait,dt:animateCompanions ? dt : 0)
            ciMotions[id] = motion
        }
        ciMotions = ciMotions.filter { ciCenters[$0.key] != nil && state.ciWaits[$0.key] != nil }
        lastState = state
    }

    /// Octopuses standing on the floor (idle, waiting, asleep) share one line,
    /// so the band layout's allowed half-overlap would read as a pile. Spread
    /// them apart with the shared rule (DESIGN.md §6.4); swimmers are untouched.
    private func spreadFloorOctopuses() {
        let standing = octopuses.values.filter { $0.visualState != .working }.sorted { $0.sessionId < $1.sessionId }
        let xs = CreatureLayout.spreadFloorResidents(
            standing.map { (x: $0.homeX, width: OctopusCreature.layoutWidth * $0.scale) },
            minX: TerrariumRules.floorSpacingMinX, maxX: TerrariumRules.crayfishClearMaxX,
            minGapRatio: TerrariumRules.floorSpacingMinGapRatio)
        for (oct, x) in zip(standing, xs) { oct.restX = x }
        for oct in octopuses.values where oct.visualState == .working { oct.restX = nil }
    }

    // MARK: - Draw (layer order matching Android ColorRenderer)

    func draw(context: inout GraphicsContext, size: CGSize, includeHabitat: Bool = true) {
        if size.height > 0 { canvasAspect = Float(size.width / size.height) }
        if includeHabitat {
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
        }

        // Layer 6.7: Focus halo (drawn behind every creature so the sprite
        // sits cleanly inside the glow). Driven by stateHolder's focused
        // session id; dashboards send a `focus_session` command on session
        // row taps so this is the visible feedback for that gesture.
        drawFocusHalo(context: &context, size: size)

        // Layer 6.8: read-only parent/child topology. The dashed Saturn ring
        // and wired satellites belong to the parent creature and never enter
        // hit testing, session selection, approval, or steering paths.
        drawSubagentOrbits(context: &context, size: size)
        // Jar buddies on the far half of their orbit pass behind the creatures.
        drawBackgroundWork(context: &context, size: size, near: false)

        // Name tags are collected while creatures draw and painted once, in
        // priority order, after the last creature (DESIGN.md §6.4).
        let nameTags = TerrariumNameTagLayer()
        TerrariumNameTagLayer.active = nameTags
        defer { TerrariumNameTagLayer.active = nil }

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

        for hermes in hermesCreatures.values { hermes.draw(context: &context, size: size) }

        // Layer 9.455: jar buddies on the near half of their orbit cross in
        // front of their creature (finishes and the count ride here too),
        // still under the name tags.
        drawBackgroundWork(context: &context, size: size, near: true)

        // Layer 9.46: name tags, resolved together so none hides a resident.
        TerrariumNameTagLayer.active = nil
        nameTags.flush(context: &context)
        ciPoints.removeAll()
        if let state = lastState {
            for (id,motion) in ciMotions {
                guard let wait=state.ciWaits[id],motion.visible(wait),let center=ciCenters[id] else { continue }
                let angle=motion.angle
                let point=CiCompanionPresentation.position(center:center,angle:angle,size:size)
                ciPoints[id]=point
                CiCompanionPresentation.draw(context:&context,size:size,center:center,position:point,wait:wait)
            }
        }


        if includeHabitat {
            // Layer 9.5: Front-layer fish
            tetra.drawFrontLayer(context: &context, size: size)

            // Layer 9.7: Front-layer plankton
            plankton.drawFrontLayer(context: &context, size: size)

            // Layer 10: Bubbles
            bubbles.draw(context: &context, size: size)

            // Layer 10.5: Water surface line
            waterSurface.draw(context: &context, size: size)
        }

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
        } else if let hermes = hermesCreatures[id] {
            pos = (hermes.currentX, hermes.currentY, hermes.scale)
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

    // MARK: - Background work (separate from the child-agent orbits)

    /// Centre (normalized) and body radius (normalized by width) of any live
    /// creature, whatever its kind: the one anchor jar buddies need.
    /// Free water around a creature, in its body radii: a close neighbour
    /// shrinks its buddies' orbit. `among` is the frame's foreground roster.
    func broodRoom(_ id: String, _ pose: (center: SIMD2<Float>, radius: Float), among roster: [AquariumResident]) -> BackgroundWorkPresentation.Room {
        var room = BackgroundWorkPresentation.Room()
        let unit = max(0.0001, pose.radius)
        for other in roster where other.id != id {
            guard let neighbour = residentPose(other.id) else { continue }
            // x is normalized by width, y by height: bring y into width units.
            room.note([(neighbour.center.x - pose.center.x) / unit,
                       -(neighbour.center.y - pose.center.y) / canvasAspect / unit])
        }
        return room
    }

    func residentPose(_ id: String) -> (center: SIMD2<Float>, radius: Float)? {
        if let c = octopuses[id] { return ([c.currentX, c.currentY], TerrariumLayout.octopusBodyRadius * c.scale) }
        if let c = clouds[id] { return ([c.currentX, c.currentY], 0.045 * c.scale) }
        if let c = opencodeCreatures[id] { return ([c.currentX, c.currentY], 0.044 * c.scale) }
        if let c = antigravityCreatures[id] { return ([c.currentX, c.currentY], 0.044 * c.scale) }
        if let c = kiroCreatures[id] { return ([c.currentX, c.currentY], 0.040 * c.scale) }
        if let c = hermesCreatures[id] { return ([c.currentX, c.currentY], 0.05 * c.scale) }
        if isCrayfishFocusId(id), crayfish.visible {
            let p = crayfish.currentPosition()
            return ([p.x, p.y], TerrariumLayout.crayfishWidthFraction / 2)
        }
        return nil
    }

    /// Unit jar-buddy parts in screen space (y down), belly radius 1 centred on
    /// the origin, facing right. Built once; each frame only moves the context transform.
    private enum BuddyPaths {
        static let body: Path = {
            var p = Path(ellipseIn: CGRect(x: -1, y: -0.9, width: 2, height: 1.8))
            p.addRect(CGRect(x: -0.46, y: -1.14, width: 0.92, height: 0.4))
            return p
        }()
        static let belt = Path(ellipseIn: CGRect(x: -0.84, y: 0.22, width: 1.68, height: 0.5))
        static let rim = Path(roundedRect: CGRect(x: -0.62, y: -1.3, width: 1.24, height: 0.22), cornerRadius: 0.1)
        static let gloss = Path(ellipseIn: CGRect(x: -0.6, y: -0.62, width: 0.32, height: 0.22))
        /// Eyes and cheeks sit a little toward the direction of travel.
        static let eyes: Path = {
            var p = Path(ellipseIn: CGRect(x: -0.3, y: -0.18, width: 0.2, height: 0.24))
            p.addEllipse(in: CGRect(x: 0.3, y: -0.18, width: 0.2, height: 0.24))
            return p
        }()
        static let cheeks: Path = {
            var p = Path(ellipseIn: CGRect(x: -0.56, y: 0.06, width: 0.24, height: 0.13))
            p.addEllipse(in: CGRect(x: 0.58, y: 0.06, width: 0.24, height: 0.13))
            return p
        }()
        /// A side fin, hinged at the origin; scaled by the beat.
        static let fin: Path = {
            var p = Path()
            p.move(to: .zero)
            p.addQuadCurve(to: CGPoint(x: 0.1, y: 0.55), control: CGPoint(x: 0.5, y: 0.1))
            p.addQuadCurve(to: .zero, control: CGPoint(x: -0.1, y: 0.3))
            return p
        }()
        /// A small fan tail, hinged at the origin, pointing left (behind).
        static let tail: Path = {
            var p = Path()
            p.move(to: .zero)
            p.addLine(to: CGPoint(x: -0.55, y: -0.32))
            p.addQuadCurve(to: CGPoint(x: -0.55, y: 0.32), control: CGPoint(x: -0.4, y: 0))
            p.closeSubpath()
            return p
        }()
        /// Lid and knob, centred on the lid's seat so it can hop and spin in place.
        static let lid = Path(ellipseIn: CGRect(x: -0.58, y: -0.2, width: 1.16, height: 0.34))
        static let knob = Path(ellipseIn: CGRect(x: -0.14, y: -0.4, width: 0.28, height: 0.26))
        static let lidSeat: CGFloat = -1.34
        static let sparkle: Path = {
            var p = Path()
            for k in 0..<6 {
                let a = CGFloat(k) * .pi / 3
                p.move(to: CGPoint(x: cos(a) * 0.55, y: sin(a) * 0.55))
                p.addLine(to: CGPoint(x: cos(a), y: sin(a)))
            }
            return p
        }()
    }

    /// Jar buddies (see `BackgroundWorkPresentation`) for every creature kind:
    /// small clay jars orbiting their creature like moons, one per running
    /// background task. Lids jiggle and bubbles simmer from the mouths; a
    /// finished buddy pops its lid, sparkles and shrinks away where it was.
    /// Drawn in two passes: `near: false` (the far half, before creatures)
    /// and `near: true` (the near half, finishes and count, after them).
    private func drawBackgroundWork(context: inout GraphicsContext, size: CGSize, near: Bool) {
        for id in broodIDs {
            guard let brood = broods[id], !brood.isEmpty, let pose = residentPose(id) else { continue }
            let r = max(12, size.width * CGFloat(pose.radius))
            let lag = brood.lag(from: pose.center)
            // Buddies circle the followed point, which trails the creature when it swims.
            let center = CGPoint(x: CGFloat(pose.center.x + lag.x) * size.width, y: CGFloat(pose.center.y + lag.y) * size.height)
            let phase = backgroundOrbitPhase
            let shown = BackgroundWorkPresentation.visibleCount(brood.count)
            for index in 0..<shown {
                let buddy = brood.buddy(index: index, phase: phase)
                guard buddy.isBehind != near else { continue }
                drawBuddy(buddy, at: screen(buddy.center, from: center, r: r), r: r, context: &context, pose: nil, lidLift: buddy.lidLift)
                for k in 0..<BackgroundWorkPresentation.simmerPerBuddy {
                    drawBubble(BackgroundWorkPresentation.simmer(buddy, slot: index, k: k, phase: phase), from: center, r: r, context: &context)
                }
            }
            guard near else { continue }
            // Finishes play where their buddy was, not with the creature, and
            // never pop into the creature's own name tag (it may have sunk
            // toward the floor in the same snapshot).
            let owner = CGPoint(x: CGFloat(pose.center.x) * size.width, y: CGFloat(pose.center.y) * size.height)
            for finish in brood.finishes {
                guard let pop = BackgroundWorkPresentation.finish(age: finish.age) else { continue }
                let drift = SIMD3<Float>(Float((CGFloat(finish.base.x) * size.width - owner.x) / r),
                                         Float(-(CGFloat(finish.base.y) * size.height - owner.y) / r), 0)
                var popped = finish.buddy
                popped.center = BackgroundWorkPresentation.clearOfTag(finish.buddy.center + drift)
                drawBuddy(popped, at: screen(popped.center, from: owner, r: r), r: r, context: &context, pose: pop, lidLift: 0)
                for k in 0..<BackgroundWorkPresentation.bubblesPerFinish {
                    if let bubble = BackgroundWorkPresentation.puff(mouth: BackgroundWorkPresentation.mouth(popped), age: finish.age, k: k) {
                        drawBubble(bubble, from: owner, r: r, context: &context)
                    }
                }
            }
            // The count sits under the creature's feet, below the orbit;
            // "+n" leads it when more tasks run than buddies swim.
            if shown > 0 {
                let anchor = CGPoint(x: CGFloat(pose.center.x) * size.width, y: CGFloat(pose.center.y) * size.height + r * 1.05)
                let extra = BackgroundWorkPresentation.overflow(brood.count)
                let text = BackgroundWorkPresentation.label(brood.count)
                let ink = DesignTokens.Session.working
                context.draw(Text(extra > 0 ? "+\(extra) · " : "").font(.custom("IBMPlexSans-Bold", size: 10)).foregroundStyle(ink)
                             + Text(text).font(.custom("IBMPlexSans", size: 10)).foregroundStyle(ink),
                             at: anchor, anchor: .top)
            }
        }
    }

    private func screen(_ p: SIMD3<Float>, from origin: CGPoint, r: CGFloat) -> CGPoint {
        CGPoint(x: origin.x + CGFloat(p.x) * r, y: origin.y - CGFloat(p.y) * r)
    }

    private func drawBuddy(_ buddy: BackgroundWorkPresentation.Buddy, at point: CGPoint, r: CGFloat, context: inout GraphicsContext,
                           pose: BackgroundWorkPresentation.FinishPose?, lidLift: Float) {
        let s = CGFloat(buddy.radius) * r * CGFloat(pose?.scale ?? 1)
        // Rounding a side of the orbit the jar turns edge-on, never to nothing.
        let turn = CGFloat(buddy.facing < 0 ? min(-0.18, buddy.facing) : max(0.18, buddy.facing))
        guard s > 0.2 else { return }
        var c = context
        c.translateBy(x: point.x, y: point.y)
        if let pose, pose.sparkleOpacity > 0 {
            // Sparkle first, behind the jar, at full size.
            var spark = c
            let reach = CGFloat(buddy.radius) * r * CGFloat(pose.sparkle)
            spark.translateBy(x: 0, y: -CGFloat(buddy.radius) * r * 1.4)
            spark.scaleBy(x: reach, y: reach)
            spark.stroke(BuddyPaths.sparkle, with: .color(DesignTokens.Tide.s50.opacity(Double(pose.sparkleOpacity))),
                         style: StrokeStyle(lineWidth: 0.12, lineCap: .round))
        }
        c.opacity = Double((pose?.opacity ?? 1) * buddy.opacity)
        // Lean into climbs and dives; mirror to face the direction of travel.
        c.rotate(by: .radians(Double(-buddy.tilt)))
        c.scaleBy(x: s * turn, y: s)
        let clay = DesignTokens.Tide.s200, shade = DesignTokens.Tide.s300
        var tail = c
        tail.translateBy(x: -0.92, y: 0.15)
        tail.rotate(by: .radians(Double(buddy.tail)))
        tail.fill(BuddyPaths.tail, with: .color(shade))
        c.fill(BuddyPaths.body, with: .color(clay))
        c.fill(BuddyPaths.belt, with: .color(shade.opacity(0.55)))
        c.fill(BuddyPaths.gloss, with: .color(DesignTokens.Tide.s50.opacity(0.8)))
        c.fill(BuddyPaths.eyes, with: .color(DesignTokens.Ink.s900))
        c.fill(BuddyPaths.cheeks, with: .color(DesignTokens.Coral.s500.opacity(0.35)))
        var fin = c
        fin.translateBy(x: 0.1, y: 0.25)
        fin.scaleBy(x: 1, y: 0.6 + CGFloat(buddy.fin) * 0.5)
        fin.fill(BuddyPaths.fin, with: .color(shade))
        c.fill(BuddyPaths.rim, with: .color(shade))
        // The one cue of live work: a thin working-cyan line on the rim.
        c.stroke(BuddyPaths.rim, with: .color(DesignTokens.Session.working), lineWidth: 0.08)
        var lid = c
        lid.opacity *= Double(pose?.lidOpacity ?? 1)
        lid.translateBy(x: 0, y: BuddyPaths.lidSeat - CGFloat(pose?.lidLift ?? lidLift))
        lid.rotate(by: .radians(Double(pose?.lidSpin ?? 0)))
        lid.fill(BuddyPaths.lid, with: .color(DesignTokens.Tide.s100))
        lid.fill(BuddyPaths.knob, with: .color(DesignTokens.Coral.s700))
    }

    private func drawBubble(_ bubble: BackgroundWorkPresentation.Bubble, from origin: CGPoint, r: CGFloat, context: inout GraphicsContext) {
        let p = screen(bubble.center, from: origin, r: r)
        let br = max(1.5, CGFloat(bubble.radius) * r)
        context.stroke(Path(ellipseIn: CGRect(x: p.x - br, y: p.y - br, width: br * 2, height: br * 2)),
                       with: .color(DesignTokens.Tide.s50.opacity(Double(bubble.opacity) * 0.8)), lineWidth: 1)
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

        for (id, hermes) in hermesCreatures {
            let distance = hypot(hermes.currentX - nx, hermes.currentY - ny)
            if distance < bestDist { bestId = id; bestDist = distance }
        }

        for (id, k) in kiroCreatures {
            let distance = hypot(k.currentX-nx, k.currentY-ny)
            if distance < bestDist { bestId = id; bestDist = distance }
        }
        for (id,point) in ciPoints {
            let distance=hypot(point.x-nx,point.y-ny)
            if distance<bestDist { bestId=id;bestDist=distance }
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
