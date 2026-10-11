import SwiftUI
import RealityKit

/// Claude background tasks drawn as octopus jars: octopuses hide in clay
/// jars, and a background task is work left simmering on the side. One arm
/// curls out from the lower body and carries up to three small jars; while a
/// task runs its lid jiggles and tiny bubbles rise from its mouth. A finished
/// task pops its lid with a little spin, puffs bubbles and a sparkle, and
/// the jar shrinks away. Shared by the Apple Canvas and RealityKit accents.
/// Jars are tasks, never extra residents or a second count of child agents
/// (those are the dashed orbit and its wired satellites). Only geometry and
/// opacity move: nothing pulses in brightness (DESIGN.md §10 rule 4).
///
/// Every offset is in body-radius units relative to the creature centre,
/// x toward screen right, y up, z toward the viewer.
enum BackgroundWorkPresentation {
    static let maxJars = 3
    /// Sway and jiggle rate; the phase only advances while motion is allowed.
    static let radiansPerSecond: Float = 0.85
    static let finishSeconds: Float = 1.4
    static let bubblesPerFinish = 3
    /// Jar belly radius and the spacing between jars along the arm.
    static let jarRadius: Float = 0.23
    static let jarSpacing: Float = 0.52
    /// The arm leaves the sprite's arm tip (24-unit sprite: arms end at x 0/24,
    /// y 10.95–14.05) and runs under the jars at this height.
    static let shoulder: SIMD2<Float> = [0.92, -0.04]
    static let carryHeight: Float = -0.5
    /// The side the jars are carried on when the creature is still.
    static let restLean: Float = 0.45
    /// Below this speed (body radii per second) motion is fidget, not a swim,
    /// and must not swing the jars from side to side.
    static let swimSpeed: Float = 0.5

    static func visibleCount(_ count: Int) -> Int { min(maxJars, max(0, count)) }
    static func overflow(_ count: Int) -> Int { max(0, count - maxJars) }
    static func label(_ count: Int) -> String {
        "\(count) background task" + (count == 1 ? "" : "s")
    }

    /// Which arm carries the jars, -1…1. Steep around zero so a swim reversal
    /// swaps sides in a few frames instead of resting under the body.
    static func side(_ lean: Float) -> Float { max(-1, min(1, lean / 0.25)) }

    struct Jar: Equatable {
        /// Belly centre.
        var center: SIMD3<Float>
        /// Belly radius in body radii.
        var radius: Float
        /// Lean of the jar, radians (positive leans toward screen left).
        var tilt: Float
        /// Lid hop above its seat, in jar radii.
        var lidLift: Float
    }

    /// One jar on the carrying arm. `index` may run past the last visible jar:
    /// that is where a jar beyond the cap finishes. The outer jars lag the
    /// arm's sway the way a load drags in water.
    static func jar(index: Int, phase: Float, lean: Float) -> Jar {
        let s = side(lean)
        let along = Float(index)
        let sway = sin(phase * 1.2 - along * 0.8) * 0.035 * (along + 1)
        let x = s * (shoulder.x + 0.2 + jarSpacing * along)
        let y = carryHeight + sway + jarRadius * 0.9
        // Staggered little hops: the lid sits still most of the time.
        let hop = pow(max(0, sin(phase * 3.4 + along * 2.3)), 6)
        return Jar(center: [x, y, 0.12 + 0.03 * along],
                   radius: jarRadius,
                   tilt: -s * cos(phase * 1.2 - along * 0.8) * 0.06 * (along + 1),
                   lidLift: hop * 0.18)
    }

    static func jars(count: Int, phase: Float, lean: Float) -> [Jar] {
        (0..<visibleCount(count)).map { jar(index: $0, phase: phase, lean: lean) }
    }

    /// The arm's path: shoulder, down to the carrying line under the jars,
    /// and a small upward curl past the last jar.
    static func arm(count: Int, phase: Float, lean: Float) -> [SIMD2<Float>] {
        let s = side(lean)
        let jars = jars(count: count, phase: phase, lean: lean)
        guard let last = jars.last else { return [] }
        let bottoms = jars.map { SIMD2<Float>($0.center.x, $0.center.y - $0.radius * 0.95) }
        return [[s * shoulder.x, shoulder.y], [s * (shoulder.x + 0.12), carryHeight + 0.05]] + bottoms
            + [[last.center.x + s * (last.radius + 0.06), last.center.y - last.radius * 0.6],
               [last.center.x + s * (last.radius + 0.1), last.center.y - last.radius * 0.1]]
    }

    struct Bubble: Equatable {
        var center: SIMD3<Float>
        var radius: Float
        var opacity: Float
    }

    /// The jar mouth, where bubbles leave.
    static func mouth(_ jar: Jar) -> SIMD3<Float> { jar.center + [0, jar.radius * 1.35, 0.02] }

    /// Two tiny bubbles per running jar, each rising from the mouth and fading
    /// before the next leaves. `slot` staggers jars so they never rise in step.
    static func simmer(_ jar: Jar, slot: Int, phase: Float) -> [Bubble] {
        (0..<2).map { k in
            let raw = phase * 0.45 + Float(slot) * 0.37 + Float(k) * 0.5
            let t = raw - floor(raw)
            return Bubble(center: mouth(jar) + [sin(t * 6 + Float(slot)) * 0.03, t * 0.5, 0],
                          radius: 0.025 + 0.015 * Float(k),
                          opacity: (1 - t) * 0.8)
        }
    }

    /// One finished jar, `age` seconds after its count dropped.
    struct FinishPose: Equatable {
        /// Jar scale, 1 → 0, and its opacity.
        var scale: Float
        var opacity: Float
        /// Lid offset above its seat (jar radii), spin (radians) and opacity.
        var lidLift: Float
        var lidSpin: Float
        var lidOpacity: Float
        /// Sparkle reach (jar radii) and opacity.
        var sparkle: Float
        var sparkleOpacity: Float
    }

    static func finish(age: Float) -> FinishPose? {
        guard age >= 0, age < finishSeconds else { return nil }
        let p = age / finishSeconds
        let pop = min(1, p * 2.5)
        let fade = max(0, min(1, (p - 0.35) / 0.65))
        return FinishPose(scale: 1 - fade * fade, opacity: 1 - fade,
                          lidLift: (1 - (1 - pop) * (1 - pop)) * 1.6, lidSpin: pop * .pi * 1.5,
                          lidOpacity: max(0, 1 - p * 1.6),
                          sparkle: 0.6 + pop * 0.9, sparkleOpacity: max(0, 1 - p * 2))
    }

    /// The puff of a finish: bubbles rise once from the mouth and fade.
    static func puff(mouth: SIMD3<Float>, age: Float) -> [Bubble] {
        guard age >= 0, age < finishSeconds else { return [] }
        let progress = age / finishSeconds
        return (0..<bubblesPerFinish).map { k in
            let lift = age * (0.7 + 0.25 * Float(k))
            let wobble = sin(age * 5 + Float(k) * 2) * 0.05
            return Bubble(center: mouth + [wobble + (Float(k) - 1) * 0.07, lift, 0.02],
                          radius: 0.04 + 0.02 * Float(k % 2) + 0.02 * progress,
                          opacity: 1 - progress)
        }
    }

    /// Wake lean from horizontal velocity (body radii per second): the jars
    /// ride opposite the swim direction and keep their side when still. A
    /// reversal swings across faster than it settles.
    static func lean(previous: Float, velocityX: Float, dt: Float) -> Float {
        guard dt > 0 else { return previous }
        let resting = previous < 0 ? -restLean : restLean
        let target = abs(velocityX) > swimSpeed ? max(-1, min(1, -velocityX * 0.8)) : resting
        let rate: Float = (target < 0) != (previous < 0) ? 4.0 : 1.8
        return previous + (target - previous) * (1 - exp(-dt * rate))
    }
}

/// Per-creature jar memory: the last explicit task count, the wake lean, and
/// the finishes still playing.
struct BackgroundBrood: Equatable {
    /// A finish plays where its jar was, not with the creature: `base` is the
    /// creature's position (caller's coordinates) when the count dropped.
    struct Finish: Equatable {
        var jar: BackgroundWorkPresentation.Jar
        var base: SIMD2<Float>
        var age: Float
    }
    /// Last explicit count from the producer; nil until one arrives.
    private(set) var known: Int?
    private(set) var working = false
    private(set) var lean: Float = BackgroundWorkPresentation.restLean
    private(set) var finishes: [Finish] = []
    private var lastX: Float?

    /// Jars to show: only a working creature carries them.
    var count: Int { working ? known ?? 0 : 0 }
    var isEmpty: Bool { count == 0 && finishes.isEmpty }

    /// Records one snapshot. `explicit` is the producer's count; nil means
    /// unknown (a daemon restart, a compacted session, a snapshot without the
    /// field) and is never read as zero. A jar finishes only on an explicit
    /// lower count, and only while the jars were showing. The last task
    /// finishing usually turns the creature idle in the same snapshot; an
    /// explicit zero still finishes them then. Leaving the working state with
    /// tasks remaining (an approval prompt, an error) hides the jars without
    /// finishing them. Nothing finishes under Reduce Motion, where the
    /// animation could never play out.
    mutating func observe(explicit: Int?, working nowWorking: Bool, position: SIMD2<Float>, phase: Float, animate: Bool) {
        let shown = count
        let previous = known ?? 0
        if let explicit {
            known = max(0, explicit)
        } else if !nowWorking {
            // An unknown count is retained only while the creature works.
            known = nil
        }
        working = nowWorking
        if !animate { finishes.removeAll(); return }
        guard let now = known, explicit != nil, now < previous, shown > 0, nowWorking || now == 0 else { return }
        // Finished jars leave from the end of the arm. At a capped count the
        // last visible jar is still carried, so the finish plays just past it.
        let first = nowWorking ? BackgroundWorkPresentation.visibleCount(now) : 0
        let finished = min(previous - now, BackgroundWorkPresentation.maxJars)
        for index in first..<(first + finished) {
            finishes.append(Finish(jar: BackgroundWorkPresentation.jar(index: index, phase: phase, lean: lean), base: position, age: 0))
        }
        // Bounded: at most one arm's worth of finishes is ever in flight.
        if finishes.count > BackgroundWorkPresentation.maxJars {
            finishes.removeFirst(finishes.count - BackgroundWorkPresentation.maxJars)
        }
    }

    /// Advances wake lean and finish ages. `x` is the creature centre in body radii.
    mutating func advance(dt: Float, x: Float) {
        guard dt > 0 else { lastX = nil; return }
        if let lastX {
            lean = BackgroundWorkPresentation.lean(previous: lean, velocityX: (x - lastX) / dt, dt: dt)
        }
        lastX = x
        guard !finishes.isEmpty else { return }
        for index in finishes.indices { finishes[index].age += dt }
        finishes.removeAll { $0.age >= BackgroundWorkPresentation.finishSeconds }
    }
}


/// A presentation projection of canonical live residents, never inferred providers.
struct AquariumResident: Equatable {
    enum Activity: String { case idle = "IDLE", working = "WORKING", waiting = "WAITING", error = "ERROR" }
    let id: String
    let kind: String
    let title: String
    let activity: Activity
    var helpers: Int = 0
    var backgroundTasks: Int = 0
    var ciWaitLabel: String? = nil
    var ciWait: CiWaitStatus? = nil

    static func foreground(_ items: [Self], focusedID: String?) -> [Self] {
        func priority(_ item: Self) -> Int {
            if item.id == focusedID || (item.id == "crayfish" && focusedID == "openclaw-gateway") { return 0 }
            if item.activity == .waiting { return 1 }
            if item.ciWait?.agentWaiting == true || item.ciWait?.phase == "failed" { return 2 }
            if item.activity == .working { return 3 }
            return 4
        }
        return Array(items.sorted {
            let a = priority($0), b = priority($1)
            if a != b { return a < b }
            if a == 2 {
                let first = $0.ciWait?.openedAt ?? 0, second = $1.ciWait?.openedAt ?? 0
                if first != second { return first < second }
            }
            return $0.id < $1.id
        }.prefix(TerrariumRules.nativeResidentLimit))
    }

    static func project(_ state: TerrariumState) -> [Self] {
        var items: [Self] = state.creatures.map {
            Self(id: $0.id, kind: "claudecode", title: $0.projectName ?? "Claude", activity: $0.state == .asking ? .waiting : $0.state == .working ? .working : .idle, helpers: $0.subagentActivity.activeCount)
        }
        items += state.cloudCreatures.filter { $0.state != .dormant }.map {
            Self(id: $0.id, kind: "codex", title: ($0.projectName ?? "Codex") + ($0.groupSize > 1 ? " ×\($0.groupSize)" : ""), activity: $0.state == .waiting ? .waiting : $0.state == .pulsing ? .working : .idle, helpers: $0.subagentActivity.activeCount)
        }
        items += state.opencodeCreatures.filter { $0.state != .dormant }.map {
            Self(id: $0.id, kind: "opencode", title: $0.projectName ?? "OpenCode", activity: $0.state == .waiting ? .waiting : $0.state == .pulsing ? .working : .idle, helpers: $0.subagentActivity.activeCount)
        }
        items += state.antigravityCreatures.map {
            Self(id: $0.id, kind: "antigravity", title: $0.projectName ?? "Antigravity", activity: $0.state == .asking ? .waiting : $0.state == .working ? .working : .idle, helpers: $0.subagentActivity.activeCount)
        }
        items += state.kiroCreatures.map {
            Self(id: $0.id, kind: "kiro", title: $0.projectName ?? "Kiro", activity: $0.state == .asking ? .waiting : $0.state == .working ? .working : .idle, helpers: $0.subagentActivity.activeCount)
        }
        items += state.hermesCreatures.map {
            Self(id: $0.id, kind: "hermes", title: $0.projectName ?? "Hermes",
                 activity: Activity(rawValue: $0.activity.rawValue.uppercased()) ?? .idle,
                 helpers: $0.subagentActivity.activeCount)
        }
        if state.crayfishVisible {
            items.append(Self(id: "crayfish", kind: "openclaw", title: "OpenClaw", activity: state.crayfishState == .sick ? .error : state.crayfishState == .waiting ? .waiting : state.crayfishState == .routing ? .working : .idle))
        }
        return items.map { item in
            var copy = item
            copy.backgroundTasks = item.activity == .working ? state.backgroundTaskCounts[item.id] ?? 0 : 0
            copy.ciWaitLabel = state.ciWaitLabels[item.id]
            copy.ciWait = state.ciWaits[item.id]
            return copy
        }.sorted { $0.id < $1.id }
    }
}

@available(iOS 18.0, macOS 15.0, *)
@MainActor
final class AquariumResidents {
    let root = Entity()
    private var ciTemplate: Entity?
    private var ciMotions: [String: CiCompanionMotion] = [:]
    var ciClock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    func loadCiCompanion(_ library: Entity) {
        let imported = library.findEntity(named: "ci_companion") ?? library
        let template = imported.clone(recursive: true)
        template.transform = Transform(matrix: imported.transformMatrix(relativeTo: nil))
        ciTemplate = template
    }
    private var templates: [String: Entity] = [:]
    private var substrateTemplate: Entity?
    private(set) var residents: [String: Entity] = [:]
    private var descriptors: [AquariumResident] = []
    private var slotOrder: [String] = []
    private var targets: [String: SIMD3<Float>] = [:]
    private struct Motion {
        var phase: Float
        var effort: Float = 0
        var attention: Float = 0
        var fatigue: Float = 0
    }
    private var motions: [String: Motion] = [:]
    private var hermesSwims: [String: HermesSwim] = [:]
    private var hermesRigs: [String: HermesMermaid.Rig] = [:]

    func loadHermesTemplate(_ library: Entity) {
        guard let imported = library.findEntity(named: "resident_hermes") else { return }
        let template = imported.clone(recursive: true)
        template.transform = Transform(matrix: imported.transformMatrix(relativeTo: nil))
        guard HermesMermaid.Rig(template).isComplete else { return }
        templates["hermes"] = template
        footHeights["hermes"] = max(0, -template.visualBounds(relativeTo: nil).min.y)
    }
    private struct Joint {
        let entity: Entity
        let rest: Transform
    }
    private var joints: [String: [Joint]] = [:]
    private var supports: [String: Entity] = [:]
    private var footHeights: [String: Float] = [:]
    let shoal = AquariumShoal()
    private var time: Double = 0
    private var backgroundPhase: Float = 0
    private var broods: [String: BackgroundBrood] = [:]
    private var size: Float = 0.85
    var animate = true
    var labelsVisible = true {
        didSet {
            guard labelsVisible != oldValue else { return }
            for (id, entity) in residents {
                entity.findEntity(named: "label")?.isEnabled = labelsVisible && labelDecisions[id]?.mode != .hidden
            }
        }
    }
    /// The scene camera, so tags can be placed in screen space (DESIGN.md §6.4).
    weak var camera: PerspectiveCamera?
    private var aspect: Float = 1.6
    private var labelDecisions: [String: ResidentLabelLayout.Decision] = [:]
    /// Tags draw in the resolved priority order, not RealityKit's depth order:
    /// one sort group with a post-pass depth write lets a rear awaiting tag
    /// paint over a nearer idle one.
    private let labelSortGroup = ModelSortGroup(depthPass: .postPass)
    private var labelDrawOrder: [String: Int] = [:]
    private var labelCompact: [String: Bool] = [:]

    func loadTemplates(_ library: Entity) {
        templates.removeAll()
        footHeights.removeAll()
        substrateTemplate = nil
        if let imported = library.findEntity(named: "aquarium_substrate") {
            let template = imported.clone(recursive: true)
            template.transform = Transform(matrix: imported.transformMatrix(relativeTo: nil))
            substrateTemplate = template
        }
        for kind in ["claudecode", "codex", "openclaw", "opencode", "antigravity", "kiro"] {
            if let imported = library.findEntity(named: "resident_" + kind) {
                let template = imported.clone(recursive: true)
                // USD stores Z-up → Y-up on an ancestor. Preserve that transform
                // when extracting a template, otherwise its face lies flat.
                template.transform = Transform(matrix: imported.transformMatrix(relativeTo: nil))
                templates[kind] = template
                footHeights[kind] = -template.visualBounds(relativeTo: nil).min.y
                templateHalfWidths[kind] = template.visualBounds(relativeTo: nil).extents.x / 2
            }
        }
    }

    var templateCount: Int { substrateTemplate == nil ? 0 : templates.count }

    func sync(_ state: TerrariumState, aspect: Float) {
        self.aspect = aspect
        focusedID = state.focusedSessionId
        let next = AquariumResident.foreground(AquariumResident.project(state), focusedID: state.focusedSessionId)
        let ids = Set(next.map(\.id))
        for id in Array(residents.keys) where !ids.contains(id) {
            residents.removeValue(forKey: id)?.removeFromParent()
            targets.removeValue(forKey: id)
            labelDecisions.removeValue(forKey: id)
            labelDrawOrder.removeValue(forKey: id)
            labelCompact.removeValue(forKey: id)
            motions.removeValue(forKey: id)
            ciMotions.removeValue(forKey: id)
            hermesSwims.removeValue(forKey: id)
            hermesRigs.removeValue(forKey: id)
            joints.removeValue(forKey: id)
            supports.removeValue(forKey: id)?.removeFromParent()
            broods.removeValue(forKey: id)
            broodRigs.removeValue(forKey: id)
            armReach.removeValue(forKey: id)
        }

        // Existing residents retain their relative order when sessions arrive or depart.
        let existing = slotOrder.filter(ids.contains)
        slotOrder = existing + next.map(\.id).filter { !existing.contains($0) }
        let bottomIDs = slotOrder.filter { id in next.contains { $0.id == id && (Self.isGrounded($0.kind) || $0.kind == "hermes") } }
        let waterIDs = slotOrder.filter { !bottomIDs.contains($0) }
        let waterLayout = Self.layout(count: waterIDs.count, aspect: aspect)
        let bottomLayout = Self.bottomLayout(count: bottomIDs.count, aspect: aspect)
        for item in next {
            let onShell = item.kind == "hermes"
            let grounded = Self.isGrounded(item.kind) || onShell
            if grounded {
                let index = bottomIDs.firstIndex(of: item.id) ?? 0
                let surface = bottomLayout.positions[index]
                size = bottomLayout.size
                targets[item.id] = surface + [0, (onShell ? ((footHeights["hermes"] ?? 0.7) + 0.10) * Self.hermesScale : (footHeights[item.kind] ?? 0.43)) * size, 0]
                // A broad, flat-topped substrate rock is fixed in habitat space.
                // It does not follow the resident's pacing or breathing.
                if supports[item.id] == nil {
                    let support = onShell ? Entity() : makeSubstrate()
                    if onShell {
                        let rock = makeSubstrate()
                        rock.name = "support-rock"
                        support.addChild(rock)
                        support.addChild(HermesMermaid.makeShell())
                    }
                    support.name = "substrate|" + item.id
                    root.addChild(support)
                    supports[item.id] = support
                }
                supports[item.id]?.position = [surface.x, 0, surface.z]
                let rock = onShell ? supports[item.id]?.findEntity(named: "support-rock") : supports[item.id]
                rock?.scale = [max(0.65, size * 1.35), surface.y, max(0.55, size)]
                if let shell = supports[item.id]?.findEntity(named: "hermes-shell") {
                    shell.position = [0, surface.y, 0]
                    shell.scale = .init(repeating: size * Self.hermesScale)
                }
            } else {
                let index = waterIDs.firstIndex(of: item.id) ?? 0
                size = waterLayout.size
                var position = waterLayout.positions[index]
                // Water residents occupy the clear region above the substrate.
                position.y += 0.5
                targets[item.id] = position
            }
            supports[item.id]?.isEnabled = true
            if residents[item.id] == nil, let template = templates[item.kind] {
                let resident = Entity()
                resident.name = "session|" + item.id
                let body = Entity()
                body.addChild(template.clone(recursive: true))
                body.name = "body"
                resident.addChild(body)
                body.generateCollisionShapes(recursive: true)
                resident.components.set(InputTargetComponent())
                // Keep selection outside the silhouette: a rear glow can peek
                // through articulated limbs and look like broken geometry.
                let focus = Entity()
                focus.name = "focus"
                for side: Float in [-1, 1] {
                    let rail = ModelEntity(mesh: .generateBox(size: [TerrariumRules.nativeActivitySelectionWidth, TerrariumRules.nativeActivitySelectionHeight, 0.008]),
                        materials: [UnlitMaterial(color: nativeColor(TerrariumColors.tetraNeon), applyPostProcessToneMap: false)])
                    rail.position = [side * TerrariumRules.nativeActivitySelectionX, 0, 0.42]
                    focus.addChild(rail)
                }
                resident.addChild(focus)
                resident.addChild(makeActivityIndicator())
                let (brood, rig) = makeBackgroundWork()
                resident.addChild(brood)
                broodRigs[item.id] = rig
                armReach[item.id] = templateHalfWidths[item.kind] ?? Self.defaultArmReach
                resident.position = targets[item.id]!
                root.addChild(resident)
                residents[item.id] = resident
                motions[item.id] = Motion(phase: Self.seed(item.id) * 6.28)
                func collect(_ node: Entity) -> [Joint] {
                    (node.name.hasPrefix("joint_") ? [Joint(entity: node, rest: node.transform)] : []) + node.children.flatMap { collect($0) }
                }
                joints[item.id] = collect(body)
                if item.kind == "hermes" {
                    hermesSwims[item.id] = HermesSwim(id: item.id, position: resident.position)
                    hermesRigs[item.id] = HermesMermaid.Rig(body)
                }
            }
            guard let resident = residents[item.id] else { continue }
            // Canonical state controls visibility immediately, even while paused.
            resident.findEntity(named: "activity")?.isEnabled = item.activity == .working && item.backgroundTasks == 0
            // The raw count, not the descriptor's: nil (unknown) must not read as zero.
            broods[item.id, default: BackgroundBrood()].observe(explicit: state.backgroundTaskCounts[item.id],
                working: item.activity == .working, position: [resident.position.x, resident.position.y],
                phase: backgroundPhase, animate: animate)
            if !animate { broods[item.id]?.advance(dt: 0, x: 0) }
            updateBackgroundWork(resident, id: item.id)
            resident.scale = .init(repeating: size * (item.kind == "hermes" ? Self.hermesScale : 1))
            if !animate {
                resident.position = targets[item.id]!
                hermesSwims[item.id]?.relocate(resident.position)
                if var swim = hermesSwims[item.id] {
                    swim.step(0, home: resident.position, size: size,
                        activity: HermesSwim.Activity(rawValue: item.activity.rawValue.lowercased()) ?? .idle,
                        neighbours: [], aspect: aspect)
                    hermesSwims[item.id] = swim
                    hermesRigs[item.id]?.pose(swim)
                }
            }
            if resident.findEntity(named: "label") == nil || descriptors.first(where: { $0.id == item.id }) != item {
                rebuildLabel(for: item, on: resident, compact: labelCompact[item.id] ?? false)
                resident.findEntity(named: "ci-cue")?.removeFromParent()
                if let wait = item.ciWait, item.activity != .waiting {
                    let mark = wait.phase == "passed" ? "✓" : wait.phase == "failed" ? "!" : wait.phase == "unknown" ? "?" : "CI"
                    let mesh = MeshResource.generateText(mark, extrusionDepth: 0.002,
                        font: .init(name: "IBMPlexSans-Bold",size: 0.22) ?? .systemFont(ofSize: 0.22))
                    let cue = ModelEntity(mesh: mesh, materials: [UnlitMaterial(color: nativeColor(CiCompanionPresentation.color(wait)),applyPostProcessToneMap: false)])
                    cue.name = "ci-cue"
                    cue.position = [TerrariumRules.nativeActivityBarX,0,0.44]
                    resident.addChild(cue)
                }
            }
            if let wait = item.ciWait, item.activity != .waiting {
                var motion = ciMotions[item.id] ?? CiCompanionMotion(id:item.id)
                motion.update(wait,dt:0,now:ciClock())
                ciMotions[item.id] = motion
                if motion.visible(wait,now:ciClock()), resident.findEntity(named:"ci-companion") == nil, let ciTemplate {
                    let helper = Entity();helper.name="ci-companion"
                    helper.addChild(ciTemplate.clone(recursive:true));helper.scale = .init(repeating:TerrariumRules.ciCompanionNativeSize)
                    helper.generateCollisionShapes(recursive:true)
                    resident.addChild(helper)
                }
                resident.findEntity(named:"ci-companion")?.isEnabled = motion.visible(wait,now:ciClock())
                let angle = motion.angle
                resident.findEntity(named:"ci-companion")?.position = [cos(angle)*TerrariumRules.ciCompanionNativeRadiusX,
                    sin(angle)*TerrariumRules.ciCompanionNativeRadiusY,0.44+sin(angle)*TerrariumRules.ciCompanionNativeDepth]
            } else {
                resident.findEntity(named:"ci-companion")?.removeFromParent();ciMotions.removeValue(forKey:item.id)
            }
            resident.findEntity(named: "focus")?.isEnabled = state.focusedSessionId == item.id || (item.id == "crayfish" && state.focusedSessionId == "openclaw-gateway")
        }
        descriptors = next
        applyLabelLayout()
    }

    private var focusedID: String?

    private func rebuildLabel(for item: AquariumResident, on resident: Entity, compact: Bool) {
        resident.findEntity(named: "label")?.removeFromParent()
        let label = makeLabel(String(item.title.prefix(22)), activity: item.activity, helpers: item.helpers, backgroundTasks: item.backgroundTasks, compact: compact, ciWaitLabel: item.ciWaitLabel, ciWait: item.ciWait)
        label.isEnabled = labelsVisible && labelDecisions[item.id]?.mode != .hidden
        resident.addChild(label)
        labelCompact[item.id] = compact
        labelDecisions[item.id] = nil  // force opacity to be re-applied
    }

    /// Resident-local tag rects; must match `makeLabel`'s geometry.
    private static let fullTagCorners: (min: SIMD2<Float>, max: SIMD2<Float>) = ([-1.025, 0.54], [1.025, 1.12])
    private static let compactTagCorners: (min: SIMD2<Float>, max: SIMD2<Float>) = ([-0.95, 0.56], [0.95, 0.84])

    /// Places every tag so none hides another resident (DESIGN.md §6.4).
    private func applyLabelLayout() {
        guard let camera else { return }
        let fov = camera.camera.fieldOfViewInDegrees * .pi / 180
        let f = 1 / tan(fov / 2)
        let near: Float = 0.1, far: Float = 100
        let projection = simd_float4x4(columns: (
            [f / max(aspect, 0.1), 0, 0, 0], [0, f, 0, 0],
            [0, 0, (far + near) / (near - far), -1], [0, 0, 2 * far * near / (near - far), 0]))
        let viewProjection = projection * camera.transformMatrix(relativeTo: nil).inverse
        func screenBox(_ points: [SIMD3<Float>]) -> ResidentLabelLayout.Box? {
            var box = ResidentLabelLayout.Box(left: .infinity, top: .infinity, right: -.infinity, bottom: -.infinity)
            for point in points {
                let clip = viewProjection * SIMD4<Float>(point, 1)
                guard clip.w > 0.0001 else { return nil }
                let x = clip.x / clip.w, y = -clip.y / clip.w
                box = .init(left: min(box.left, x), top: min(box.top, y), right: max(box.right, x), bottom: max(box.bottom, y))
            }
            return box
        }
        func tagBox(_ resident: Entity, _ corners: (min: SIMD2<Float>, max: SIMD2<Float>)) -> ResidentLabelLayout.Box? {
            let m = resident.transformMatrix(relativeTo: nil)
            let z: Float = 0.40
            let local: [SIMD3<Float>] = [[corners.min.x, corners.min.y, z], [corners.max.x, corners.min.y, z],
                                         [corners.min.x, corners.max.y, z], [corners.max.x, corners.max.y, z]]
            return screenBox(local.map { point in
                let p = m * SIMD4<Float>(point, 1)
                return SIMD3<Float>(p.x, p.y, p.z)
            })
        }
        var inputs: [ResidentLabelLayout.Input] = []
        for item in descriptors {
            guard let resident = residents[item.id], let body = resident.findEntity(named: "body") else { continue }
            let bounds = body.visualBounds(relativeTo: nil)
            let lo = bounds.min, hi = bounds.max
            guard let bodyBox = screenBox([[lo.x, lo.y, lo.z], [hi.x, lo.y, lo.z], [lo.x, hi.y, lo.z], [hi.x, hi.y, lo.z],
                                           [lo.x, lo.y, hi.z], [hi.x, lo.y, hi.z], [lo.x, hi.y, hi.z], [hi.x, hi.y, hi.z]]),
                  let full = tagBox(resident, Self.fullTagCorners), let compact = tagBox(resident, Self.compactTagCorners) else { continue }
            let focused = item.id == focusedID || (item.id == "crayfish" && focusedID == "openclaw-gateway")
            let rank: ResidentLabelLayout.Rank = focused ? .focused
                : item.activity == .waiting || item.activity == .error ? .awaiting
                : item.activity == .working ? .working : .idle
            inputs.append(.init(id: item.id, rank: rank, body: bodyBox, fullTag: full, compactTag: compact))
        }
        for (drawIndex, decision) in ResidentLabelLayout.resolve(inputs).enumerated() {
            guard let resident = residents[decision.id],
                  let item = descriptors.first(where: { $0.id == decision.id }) else { continue }
            let compact = decision.mode == .compact
            if labelCompact[decision.id] != compact && decision.mode != .hidden {
                rebuildLabel(for: item, on: resident, compact: compact)
            }
            guard labelDecisions[decision.id] != decision || labelDrawOrder[decision.id] != drawIndex,
                  let label = resident.findEntity(named: "label") else { continue }
            labelDecisions[decision.id] = decision
            labelDrawOrder[decision.id] = drawIndex
            label.isEnabled = labelsVisible && decision.mode != .hidden
            let working = item.activity == .working
            // Each part's opacity and its place in the priority order.
            let parts: [(name: String, opacity: Float)] = [
                ("backing", decision.backingOpacity),
                ("working-badge", decision.signalOpacity),
                ("title", decision.textOpacity),
                ("status", working ? decision.signalOpacity : decision.textOpacity),
            ]
            for (slot, part) in parts.enumerated() {
                guard let entity = label.findEntity(named: part.name) else { continue }
                entity.components.set(OpacityComponent(opacity: part.opacity))
                entity.components.set(ModelSortGroupComponent(group: labelSortGroup, order: Int32(drawIndex * parts.count + slot)))
            }
        }
    }

    func step(_ delta: Double) {
        // Result lifetime is monotonic time, independent of animation/sleep.
        for item in descriptors {
            if let wait = item.ciWait, let motion = ciMotions[item.id] {
                residents[item.id]?.findEntity(named: "ci-companion")?.isEnabled = motion.visible(wait,now:ciClock())
            }
        }
        guard animate else { return }
        // Bound integration after occlusion/sleep; no wall-clock jump on resume.
        let dt = min(max(delta, 0), 1.0 / 20)
        time += dt
        backgroundPhase += Float(dt) * BackgroundWorkPresentation.radiansPerSecond
        let blend = Float(1 - exp(-dt * 3))
        var wakes: [AquariumShoal.WorkWake] = []
        let snapshot = residents.keys.sorted().compactMap { id in residents[id].map { (id, $0.position) } }
        let greetings = hermesSwims.keys.sorted().compactMap { id in hermesSwims[id].map { ($0.position, $0.greeting) } }
        for item in descriptors {
            guard let entity = residents[item.id], var target = targets[item.id], var motion = motions[item.id] else { continue }
            let reach = (armReach[item.id] ?? Self.defaultArmReach) * entity.scale.x
            broods[item.id]?.advance(dt: Float(dt), x: entity.position.x / max(0.01, reach))
            updateBackgroundWork(entity, id: item.id)
            motion.effort += ((item.activity == .working ? 1 : 0) - motion.effort) * blend
            motion.attention += ((item.activity == .waiting ? 1 : 0) - motion.attention) * blend
            motion.fatigue += ((item.activity == .error ? 1 : 0) - motion.fatigue) * blend
            // Integrate phase rather than multiplying time by a state-dependent rate.
            // State transitions and changes in the roster must never snap a pose.
            motion.phase += Float(dt) * (TerrariumRules.nativeActivityIdleRate + motion.effort * TerrariumRules.nativeActivityWorkRate)
            if let wait = item.ciWait, var companion = ciMotions[item.id] {
                companion.update(wait,dt:Float(dt),now:ciClock());ciMotions[item.id] = companion
                if let helper=entity.findEntity(named:"ci-companion") {
                    helper.isEnabled=companion.visible(wait,now:ciClock())
                    let angle=companion.angle
                    helper.position=[cos(angle)*TerrariumRules.ciCompanionNativeRadiusX,
                        sin(angle)*TerrariumRules.ciCompanionNativeRadiusY,0.44+sin(angle)*TerrariumRules.ciCompanionNativeDepth]
                }
            }
            let phase = motion.phase
            motions[item.id] = motion
            // A short power stroke followed by a longer recovery. The same stroke
            // drives the pose and water disturbance, so fish react to visible action.
            let stroke = pow(max(0, sin(phase)), 6) * motion.effort
            let workSwing = sin(phase) * motion.effort
            var socialTurn: Float = 0
            var socialWave: Float = 0
            if item.activity == .idle && item.kind != "hermes" {
                for (position, greeting) in greetings {
                    let distance = simd_distance(position, entity.position)
                    let influence = greeting * max(0, 1 - distance / 2.5)
                    socialTurn += max(-1, min(1, position.x - entity.position.x)) * influence * 0.18
                    socialWave = max(socialWave, influence * 0.22)
                }
            }
            let grounded = Self.isGrounded(item.kind)
            let residentSize = entity.scale.x
            // Bottom dwellers pace horizontally with planted feet. No vertical
            // sine wave, spring settling, roll, or whole-body scale at contact.
            target.x += sin(phase * 0.5) * residentSize * (grounded ? motion.effort * TerrariumRules.nativeActivityGroundTravel : 0.18)
            if !grounded {
                target.x += workSwing * residentSize * TerrariumRules.nativeActivityWaterTravel
                target.z += sin(phase * 0.5) * 0.12 + stroke * residentSize * 0.24
            }
            if stroke > 0.001 && item.kind != "hermes" {
                wakes.append(.init(position: entity.position, strength: stroke, radius: max(1.2, residentSize * 2.8)))
            }
            if item.kind == "hermes", var swim = hermesSwims[item.id] {
                swim.step(Float(dt), home: targets[item.id]!, size: residentSize,
                    activity: HermesSwim.Activity(rawValue: item.activity.rawValue.lowercased()) ?? .idle,
                    neighbours: snapshot.filter { $0.0 != item.id }.map { $0.1 }, aspect: aspect)
                hermesSwims[item.id] = swim
                entity.position = swim.position
                if let body = entity.findEntity(named: "body") {
                    let orientation = simd_quatf(angle: swim.yaw, axis: [0,1,0])
                        * simd_quatf(angle: swim.pitch, axis: [1,0,0])
                        * simd_quatf(angle: swim.roll, axis: [0,0,1])
                    body.orientation = simd_slerp(body.orientation, orientation, blend)
                }
                hermesRigs[item.id]?.pose(swim)
                if swim.effort > 0.01 {
                    wakes.append(.init(position: swim.position, strength: swim.effort * abs(swim.tail), radius: residentSize * 2))
                }
            } else {
                entity.position += (target - entity.position) * blend
                if grounded { entity.position.y = target.y }
                if let body = entity.findEntity(named: "body") {
                    let yaw = sin(phase * 0.5) * (grounded ? motion.effort * TerrariumRules.nativeActivityGroundYaw : 0.20 + motion.effort * TerrariumRules.nativeActivityWorkYaw)
                    let orientation = simd_quatf(angle: yaw + socialTurn, axis: [0,1,0])
                        * simd_quatf(angle: grounded ? 0 : motion.fatigue * 0.16 + workSwing * TerrariumRules.nativeActivityWorkYaw, axis: [1,0,0])
                        * simd_quatf(angle: grounded ? 0 : -workSwing * TerrariumRules.nativeActivityWorkRoll, axis: [0,0,1])
                    body.orientation = simd_slerp(body.orientation, orientation, blend)
                    let breath = grounded ? Float(0) : sin(phase * 1.3) * 0.009 + workSwing * TerrariumRules.nativeActivityWorkBreath
                    body.scale = [1 + breath, 1 - breath * 0.6, 1 + breath]
                }
                for (index, pose) in (joints[item.id] ?? []).enumerated() {
                    let joint = pose.entity
                    let name = joint.name
                    let side: Float = name.hasSuffix("_0") ? -1 : 1
                    let wave = sin(phase * 2 + Float(index) * 1.8)
                    joint.transform = pose.rest
                    if name.hasPrefix("joint_foot") {
                        // Alternate original-foot steps; swing feet only rise above rest.
                        let number = Int(name.split(separator: "_").last ?? "0") ?? 0
                        let stride = sin(phase * 2 + Float(number % 2) * .pi)
                        joint.position.y += max(0, stride) * TerrariumRules.nativeActivityFootLift * motion.effort
                        joint.orientation = pose.rest.rotation * simd_quatf(angle: stride * 0.12 * motion.effort, axis: [0,1,0])
                    } else {
                        let lift = motion.attention * 0.40 - motion.fatigue * 0.25 + socialWave
                        joint.orientation = pose.rest.rotation * simd_quatf(angle: side * (lift + wave * 0.025 + motion.effort * (0.20 + sin(phase) * 0.58)), axis: [0,0,1])
                    }
                }
            }
            if item.activity == .working, let indicator = entity.findEntity(named: "activity") {
                for (index, bar) in indicator.children.enumerated() {
                    bar.scale.y = TerrariumRules.nativeActivityBarMinimum + TerrariumRules.nativeActivityBarRange * (0.5 + 0.5 * sin(phase * TerrariumRules.nativeActivityBarRate + Float(index) * TerrariumRules.nativeActivityBarPhase))
                }
            }
            // Only awaiting attention pulses; other status colors stay steady.
            if let label = entity.findEntity(named: "label") {
                let pulse: Float = item.activity == .waiting ? 1 + sin(Float(time) * 2.5) * 0.035 : 1
                // Hermes swims larger; her tag keeps the shared text size
                label.scale = .init(repeating: pulse / (item.kind == "hermes" ? Self.hermesScale : 1))
            }
        }
        shoal.step(dt, residents: residents.values.map { $0.position }, wakes: wakes)
        applyLabelLayout()
    }

    /// Slots are separated in camera projection, then unprojected to depth tiers.
    /// Merely changing world Z causes distant rows to overlap in screen space.
    static func layout(count: Int, aspect: Float) -> (positions: [SIMD3<Float>], size: Float) {
        guard count > 0 else { return ([], 0.85) }
        let width = min(6.2, max(1.6, 5.5 * aspect))
        let columns = min(count, max(1, Int(ceil(sqrt(Float(count) * width / 3.5)))))
        let rows = (count + columns - 1) / columns
        let size = min(0.95, width / Float(columns) * 0.43, 2.9 / Float(rows) * 0.46)
        let positions = (0..<count).map { index -> SIMD3<Float> in
            let row = index / columns
            let rowCount = min(columns, count - row * columns)
            let x = (Float(index % columns) - Float(rowCount - 1) / 2) * width / Float(columns)
            let y: Float = rows == 1 ? 2.7 : 3.8 - Float(row) * 2.1 / Float(rows - 1)
            let z = Float((index + row) % 3) * 0.65 - 0.30
            let perspective = (14 - z) / 13
            return [x * perspective, 4.8 + (y - 4.8) * perspective, z]
        }
        return (positions, size)
    }

    /// Hermes is drawn larger than the other residents so her face and the
    /// Nous sticker on her laptop read at aquarium distance (2026-10-02).
    static let hermesScale: Float = 1.35

    static func isGrounded(_ kind: String) -> Bool {
        kind == "claudecode" || kind == "openclaw"
    }

    static func bottomLayout(count: Int, aspect: Float) -> (positions: [SIMD3<Float>], size: Float) {
        guard count > 0 else { return ([], 0.85) }
        let width = min(6.2, max(1.6, 5.5 * aspect))
        let columns = min(count, max(1, Int(ceil(sqrt(Float(count) * width / 4)))))
        let rows = (count + columns - 1) / columns
        let rise = min(0.48, 1.5 / Float(max(1, rows - 1)))
        let depth = min(1.4, 4 / Float(max(1, rows - 1)))
        let size = min(0.85, width / Float(columns) * 0.40, 1.8 / sqrt(Float(count)))
        return ((0..<count).map { index in
            let row = index / columns
            let rowCount = min(columns, count - row * columns)
            return SIMD3<Float>((Float(index % columns) - Float(rowCount - 1) / 2) * width / Float(columns),
                                0.95 + Float(row) * rise, 1.0 - Float(row) * depth)
        }, size)
    }

    private func makeSubstrate() -> Entity {
        // A wrapper preserves the exported Z-up conversion when the runtime
        // scales the shared shelf in the native scene's Y-up coordinates.
        let shelf = Entity()
        if let substrateTemplate { shelf.addChild(substrateTemplate.clone(recursive: true)) }
        return shelf
    }

    private static func seed(_ id: String) -> Float {
        let hash = id.utf8.reduce(UInt32(2166136261)) { ($0 ^ UInt32($1)) &* 16777619 }
        return Float(hash % 10000) / 10000
    }

    static func sessionID(for entity: Entity) -> String? {
        var current: Entity? = entity
        while let node = current {
            if node.name.hasPrefix("session|") { return String(node.name.dropFirst(8)) }
            current = node.parent
        }
        return nil
    }

    /// A small equalizer beside (never behind) the body works for every provider.
    /// It remains visible in viewing mode and frozen under Reduce Motion.
    private func makeActivityIndicator() -> Entity {
        let group = Entity()
        group.name = "activity"
        for index in 0..<Int(TerrariumRules.nativeActivityBarCount) {
            let bar = ModelEntity(mesh: .generateBox(size: [TerrariumRules.nativeActivityBarWidth, TerrariumRules.nativeActivityBarHeight, 0.012], cornerRadius: TerrariumRules.nativeActivityBarRadius),
                materials: [UnlitMaterial(color: nativeColor(DesignTokens.Tide.s50), applyPostProcessToneMap: false)])
            bar.position = [TerrariumRules.nativeActivityBarX + Float(index) * TerrariumRules.nativeActivityBarSpacing, TerrariumRules.nativeActivityBarY, 0.44]
            group.addChild(bar)
        }
        return group
    }

    /// One pooled jar: the body group and the lid that hops and spins on it.
    private struct JarRig {
        let root: Entity
        let lid: Entity
    }
    /// Pooled jar entities per resident, cached so a frame never searches the tree.
    private struct BroodRig {
        let group: Entity
        let carried: [JarRig]
        let finishing: [JarRig]
        let arm: [Entity]
        let joints: [Entity]
        let bubbles: [ModelEntity]
        let overflow: ModelEntity
        var overflowShown = 0
        var overflowWidth: Float = 0
    }
    private var broodRigs: [String: BroodRig] = [:]
    /// A resident's arm-tip half width in its own space, measured from the template.
    private var armReach: [String: Float] = [:]
    private var templateHalfWidths: [String: Float] = [:]
    private static let defaultArmReach: Float = 0.75
    private static let armSegments = 6
    private static let bubblePool = BackgroundWorkPresentation.maxJars * (2 + BackgroundWorkPresentation.bubblesPerFinish)

    private func makeJar(named name: String) -> JarRig {
        func clay(_ color: Color) -> SimpleMaterial { SimpleMaterial(color: nativeColor(color), roughness: 0.75, isMetallic: false) }
        let root = Entity()
        root.name = name
        let belly = ModelEntity(mesh: .generateSphere(radius: 1), materials: [clay(DesignTokens.Tide.s200)])
        belly.scale = [1, 0.9, 1]
        let belt = ModelEntity(mesh: .generateCylinder(height: 0.26, radius: 0.93), materials: [clay(DesignTokens.Tide.s300)])
        belt.position = [0, -0.42, 0]
        let neck = ModelEntity(mesh: .generateCylinder(height: 0.42, radius: 0.46), materials: [clay(DesignTokens.Tide.s200)])
        neck.position = [0, 0.95, 0]
        let rim = ModelEntity(mesh: .generateCylinder(height: 0.14, radius: 0.62), materials: [clay(DesignTokens.Tide.s300)])
        rim.position = [0, 1.2, 0]
        // The one cue of live work: a thin working-cyan band on the rim.
        let band = ModelEntity(mesh: .generateCylinder(height: 0.05, radius: 0.64),
                               materials: [UnlitMaterial(color: nativeColor(DesignTokens.Session.working), applyPostProcessToneMap: false)])
        band.position = [0, 1.2, 0]
        for x: Float in [-0.32, 0.32] {
            let eye = ModelEntity(mesh: .generateSphere(radius: 0.1),
                                  materials: [UnlitMaterial(color: nativeColor(DesignTokens.Ink.s900), applyPostProcessToneMap: false)])
            eye.position = [x, 0.02, 0.9]
            eye.scale = [1, 1.2, 0.5]
            root.addChild(eye)
        }
        let lid = Entity()
        lid.name = "lid"
        let cap = ModelEntity(mesh: .generateCylinder(height: 0.14, radius: 0.58), materials: [clay(DesignTokens.Tide.s100)])
        let knob = ModelEntity(mesh: .generateSphere(radius: 0.15), materials: [clay(DesignTokens.Coral.s700)])
        knob.position = [0, 0.14, 0]
        lid.addChild(cap)
        lid.addChild(knob)
        for part in [belly, belt, neck, rim, band] { root.addChild(part) }
        root.addChild(lid)
        root.components.set(OpacityComponent(opacity: 1))
        return JarRig(root: root, lid: lid)
    }

    private func makeBackgroundWork() -> (Entity, BroodRig) {
        let group = Entity()
        group.name = "background-work"
        // Allocate a fixed pool once; frame updates only move and scale existing entities.
        let carried = (0..<BackgroundWorkPresentation.maxJars).map { makeJar(named: "background-jar-\($0)") }
        let finishing = (0..<BackgroundWorkPresentation.maxJars).map { makeJar(named: "background-finish-\($0)") }
        let armMaterial = SimpleMaterial(color: nativeColor(TerrariumColors.claudeBodyLight), roughness: 0.6, isMetallic: false)
        let arm = (0..<Self.armSegments).map { index -> Entity in
            let span = ModelEntity(mesh: .generateCylinder(height: 1, radius: 1), materials: [armMaterial])
            span.name = "background-arm-\(index)"
            return span
        }
        let joints = (0...Self.armSegments).map { index -> Entity in
            let joint = ModelEntity(mesh: .generateSphere(radius: 1), materials: [armMaterial])
            joint.name = "background-arm-joint-\(index)"
            return joint
        }
        let bubbles = (0..<Self.bubblePool).map { index -> ModelEntity in
            var material = UnlitMaterial(color: nativeColor(DesignTokens.Tide.s50), applyPostProcessToneMap: false)
            material.blending = .transparent(opacity: .init(floatLiteral: 0.5))
            let bubble = ModelEntity(mesh: .generateSphere(radius: 1), materials: [material])
            bubble.name = "background-bubble-\(index)"
            bubble.components.set(OpacityComponent(opacity: 1))
            return bubble
        }
        let overflow = ModelEntity()
        overflow.name = "background-overflow"
        overflow.model = ModelComponent(mesh: .generateBox(size: 0.001),
            materials: [UnlitMaterial(color: nativeColor(DesignTokens.Session.working), applyPostProcessToneMap: false)])
        for entity in arm + joints + carried.map(\.root) + finishing.map(\.root) + bubbles + [overflow] { group.addChild(entity) }
        return (group, BroodRig(group: group, carried: carried, finishing: finishing, arm: arm, joints: joints, bubbles: bubbles, overflow: overflow))
    }

    /// Positions the pooled jars from the shared maths. Pure placement: the
    /// count and finishes are owned by `broods`, updated in `sync` and `step`.
    private func updateBackgroundWork(_ resident: Entity, id: String) {
        guard var rig = broodRigs[id] else { return }
        let brood = broods[id] ?? BackgroundBrood()
        rig.group.isEnabled = !brood.isEmpty
        guard !brood.isEmpty else { return }
        typealias P = BackgroundWorkPresentation
        let phase = backgroundPhase
        let jars = P.jars(count: brood.count, phase: phase, lean: brood.lean)
        let r = armReach[id] ?? Self.defaultArmReach
        // Native residents stand on a support: lift the jars clear of its rim.
        func place(_ p: SIMD3<Float>) -> SIMD3<Float> { [p.x * r, (p.y + 0.1) * r, p.z * r + 0.12] }
        func pose(_ jarRig: JarRig, _ jar: P.Jar, at position: SIMD3<Float>, finish: P.FinishPose?, lidLift: Float) {
            let size = jar.radius * r * (finish?.scale ?? 1)
            jarRig.root.position = position
            jarRig.root.scale = .init(repeating: max(0.0001, size))
            jarRig.root.orientation = simd_quatf(angle: jar.tilt, axis: [0, 0, 1])
            jarRig.root.components.set(OpacityComponent(opacity: finish?.opacity ?? 1))
            jarRig.lid.position = [0, 1.34 + (finish?.lidLift ?? lidLift), 0]
            jarRig.lid.orientation = simd_quatf(angle: finish?.lidSpin ?? 0, axis: [0, 0, 1])
            jarRig.lid.isEnabled = (finish?.lidOpacity ?? 1) > 0.05
        }
        for (index, jarRig) in rig.carried.enumerated() {
            jarRig.root.isEnabled = index < jars.count
            guard index < jars.count else { continue }
            pose(jarRig, jars[index], at: place(jars[index].center), finish: nil, lidLift: jars[index].lidLift)
        }
        // The carrying arm: capsule spans with round joints, shoulder to curl.
        let points = P.arm(count: brood.count, phase: phase, lean: brood.lean).map { place([$0.x, $0.y, 0.1]) }
        let thickness = 0.08 * r
        for (index, span) in rig.arm.enumerated() {
            span.isEnabled = index + 1 < points.count
            guard index + 1 < points.count else { continue }
            let a = points[index], b = points[index + 1]
            let delta = b - a, length = simd_length(delta)
            span.position = (a + b) / 2
            span.scale = [thickness, max(0.0001, length), thickness]
            span.orientation = length > 0 ? simd_quatf(from: [0, 1, 0], to: delta / length) : simd_quatf()
        }
        for (index, joint) in rig.joints.enumerated() {
            joint.isEnabled = index < points.count
            guard index < points.count else { continue }
            joint.position = points[index]
            // The curl tapers toward its tip.
            joint.scale = .init(repeating: thickness * (index == points.count - 1 ? 0.7 : 1))
        }
        // Finishes play where their jar was, not with the creature.
        let current = SIMD2<Float>(resident.position.x, resident.position.y)
        let scale = max(0.001, resident.scale.x)
        var bubbles: [(P.Bubble, SIMD3<Float>)] = []
        for (index, jar) in jars.enumerated() {
            for bubble in P.simmer(jar, slot: index, phase: phase) { bubbles.append((bubble, .zero)) }
        }
        for (index, jarRig) in rig.finishing.enumerated() {
            guard index < brood.finishes.count, let finish = P.finish(age: brood.finishes[index].age) else {
                jarRig.root.isEnabled = false
                continue
            }
            let item = brood.finishes[index]
            let drift2 = (item.base - current) / scale
            let drift = SIMD3<Float>(drift2.x, drift2.y, 0)
            jarRig.root.isEnabled = true
            pose(jarRig, item.jar, at: place(item.jar.center) + drift, finish: finish, lidLift: 0)
            for bubble in P.puff(mouth: P.mouth(item.jar), age: item.age) { bubbles.append((bubble, drift)) }
        }
        for (index, entity) in rig.bubbles.enumerated() {
            entity.isEnabled = index < bubbles.count
            guard index < bubbles.count else { continue }
            let (bubble, drift) = bubbles[index]
            entity.position = place(bubble.center) + drift
            entity.scale = .init(repeating: bubble.radius * r)
            entity.components.set(OpacityComponent(opacity: bubble.opacity))
        }
        // "+n" tags the last jar; its mesh is rebuilt only when n changes.
        let extra = P.overflow(brood.count)
        rig.overflow.isEnabled = extra > 0 && !jars.isEmpty
        if extra > 0, let tip = jars.last {
            if rig.overflowShown != extra {
                rig.overflow.model?.mesh = MeshResource.generateText("+\(extra)", extrusionDepth: 0.002,
                    font: .init(name: "IBMPlexSans-Bold", size: 0.16) ?? .systemFont(ofSize: 0.16))
                rig.overflowShown = extra
                rig.overflowWidth = rig.overflow.visualBounds(relativeTo: rig.overflow).extents.x
                broodRigs[id] = rig
            }
            let side: Float = brood.lean < 0 ? -1 : 1
            let anchor = place(tip.center) + [side * (tip.radius * r * 1.3 + 0.04), -0.05, 0.05]
            rig.overflow.position = side > 0 ? anchor : anchor - [rig.overflowWidth, 0, 0]
        }
    }


    private func makeLabel(_ title: String, activity: AquariumResident.Activity, helpers: Int, backgroundTasks: Int = 0, compact: Bool = false, ciWaitLabel: String? = nil, ciWait: CiWaitStatus? = nil) -> Entity {
        let group = Entity()
        group.name = "label"
        let active = activity == .working
        // Session state colours (DESIGN.md §2.7), never the marketing Status palette.
        let stateColor: Color = switch activity {
        case .waiting: DesignTokens.Session.awaiting
        case .working: DesignTokens.Session.working
        case .error: DesignTokens.Session.error
        case .idle: DesignTokens.Session.idle
        }
        let color = ciWait.map { CiCompanionPresentation.color($0) } ?? stateColor
        func text(_ string: String, name: String, bold: Bool, size: Float, ink: Color, y: Float, maxWidth: Float) -> Entity {
            let mesh = MeshResource.generateText(string, extrusionDepth: 0.002,
                font: .init(name: bold ? "IBMPlexSans-Bold" : "IBMPlexSans", size: CGFloat(size))
                    ?? .systemFont(ofSize: CGFloat(size), weight: bold ? .bold : .regular))
            let entity = ModelEntity(mesh: mesh, materials: [UnlitMaterial(color: nativeColor(ink), applyPostProcessToneMap: false)])
            entity.name = name
            let bounds = entity.visualBounds(relativeTo: entity)
            let fit = min(1, maxWidth / max(0.01, bounds.extents.x))
            entity.scale = .init(repeating: fit)
            entity.position = [-bounds.center.x * fit, y - bounds.center.y * fit, 0.44]
            return entity
        }
        if compact {
            // A dense tank's idle tag: title only, low on the body (§6.4).
            let corners = Self.compactTagCorners
            let backing = ModelEntity(mesh: .generateBox(size: [corners.max.x - corners.min.x, corners.max.y - corners.min.y, 0.008], cornerRadius: 0.05),
                materials: [UnlitMaterial(color: nativeColor(TerrariumColors.deepSea), applyPostProcessToneMap: false)])
            backing.name = "backing"
            backing.position = [0, (corners.min.y + corners.max.y) / 2, 0.40]
            group.addChild(backing)
            group.addChild(text(title, name: "title", bold: false, size: 0.14, ink: DesignTokens.UI.hudSubtext, y: (corners.min.y + corners.max.y) / 2, maxWidth: 1.72))
            return group
        }
        let corners = Self.fullTagCorners
        let backing = ModelEntity(mesh: .generateBox(size: [corners.max.x - corners.min.x, corners.max.y - corners.min.y, 0.008], cornerRadius: 0.06),
            materials: [UnlitMaterial(color: nativeColor(TerrariumColors.deepSea), applyPostProcessToneMap: false)])
        backing.name = "backing"
        backing.position = [0, (corners.min.y + corners.max.y) / 2, 0.40]
        group.addChild(backing)
        if active {
            let badge = ModelEntity(mesh: .generateBox(size: [1.95, 0.26, 0.008], cornerRadius: 0.04),
                materials: [UnlitMaterial(color: nativeColor(color), applyPostProcessToneMap: false)])
            badge.name = "working-badge"
            badge.position = [0, 0.70, 0.42]
            group.addChild(badge)
        }
        group.addChild(text(title, name: "title", bold: false, size: 0.16, ink: TerrariumColors.hudText, y: 0.96, maxWidth: 1.82))
        let status = backgroundTasks > 0 ? BackgroundWorkPresentation.label(backgroundTasks) : activity.rawValue
        group.addChild(text((ciWaitLabel ?? status) + (helpers > 0 ? " · \(helpers) agents" : ""), name: "status", bold: active, size: 0.16,
                            ink: active ? DesignTokens.Ink.s900 : color, y: 0.70, maxWidth: 1.82))
        return group
    }

    #if os(macOS)
    private func nativeColor(_ color: Color) -> NSColor { NSColor(color) }
    #else
    private func nativeColor(_ color: Color) -> UIColor { UIColor(color) }
    #endif
}
