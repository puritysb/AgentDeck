import SwiftUI
import RealityKit

/// Claude background tasks drawn as a brood the creature tends: up to three
/// egg pods on one soft tether that trails in the creature's wake, each with a
/// small embryo turning inside. A finished task hatches into rising bubbles.
/// Shared by the Apple Canvas and RealityKit accents. Pods are tasks, never
/// extra residents or a second count of child agents (those are the dashed
/// orbit and its wired satellites). Only geometry moves: the working colour
/// never pulses in brightness (DESIGN.md §10 rule 4).
///
/// Every offset is in body-radius units relative to the creature centre,
/// x toward screen right, y up, z toward the viewer.
enum BackgroundWorkPresentation {
    static let maxPods = 3
    /// Sway and embryo turn rate; the phase only advances while motion is allowed.
    static let radiansPerSecond: Float = 0.85
    static let hatchSeconds: Float = 1.6
    static let bubblesPerHatch = 3
    static let tetherLength: Float = 1.4
    /// The side the clutch trails to when the creature is still, so it never
    /// hides directly behind the arms.
    static let restLean: Float = 0.45
    /// Below this speed (body radii per second) motion is fidget, not a swim,
    /// and must not swing the strand from side to side.
    static let swimSpeed: Float = 0.5

    /// Where the tether leaves the body: the low rear edge, among the arms, on
    /// the side the strand trails to.
    static func anchor(lean: Float) -> SIMD3<Float> {
        [max(-1, min(1, lean)) * 0.6, -0.62, 0.10]
    }

    static func visibleCount(_ count: Int) -> Int { min(maxPods, max(0, count)) }
    static func overflow(_ count: Int) -> Int { max(0, count - maxPods) }
    static func label(_ count: Int) -> String {
        "\(count) background task" + (count == 1 ? "" : "s")
    }

    struct Pod: Equatable {
        var center: SIMD3<Float>
        /// Shell radius in body-radius units.
        var radius: Float
        /// Angle of the embryo inside the shell, radians.
        var spin: Float
    }

    /// Pods strung along the tether. The sway is a wave travelling down the
    /// strand, so the tip lags the base the way a trailing strand drags in water.
    static func pods(count: Int, phase: Float, lean: Float) -> [Pod] {
        let visible = visibleCount(count)
        guard visible > 0 else { return [] }
        let side = max(-1, min(1, lean))
        // Trail behind and slightly down, like a wake; it never reaches far
        // below the creature, where the sand or a neighbour's tag would be.
        var direction = SIMD2<Float>(side * 1.6, -0.35)
        direction /= simd_length(direction)
        let normal = SIMD2<Float>(-direction.y, direction.x)
        let origin = anchor(lean: side)
        return (0..<visible).map { index in
            let along = Float(index + 1) / Float(maxPods)
            let sway = sin(phase - Float(index) * 0.9) * 0.16 * along
            let point = SIMD2<Float>(origin.x, origin.y) + direction * tetherLength * along + normal * sway
            return Pod(center: [point.x, point.y, origin.z + 0.04 * Float(index)],
                       radius: 0.22 - 0.02 * Float(index),
                       spin: phase * 1.3 + Float(index) * 2.1)
        }
    }

    /// Embryo position relative to its pod centre (x right, y up).
    static func embryoOffset(_ pod: Pod) -> SIMD2<Float> {
        [cos(pod.spin) * pod.radius * 0.38, sin(pod.spin) * pod.radius * 0.38]
    }

    /// Wake lean from horizontal velocity (body radii per second): the clutch
    /// trails opposite the swim direction and keeps its side when still.
    static func lean(previous: Float, velocityX: Float, dt: Float) -> Float {
        guard dt > 0 else { return previous }
        let resting = previous < 0 ? -restLean : restLean
        let target = abs(velocityX) > swimSpeed ? max(-1, min(1, -velocityX * 0.8)) : resting
        return previous + (target - previous) * (1 - exp(-dt * 1.8))
    }

    struct Bubble: Equatable {
        var center: SIMD3<Float>
        var radius: Float
        var opacity: Float
    }

    /// Bubbles of one hatch: they rise, wobble and fade out once, never loop.
    static func bubbles(origin: SIMD3<Float>, age: Float) -> [Bubble] {
        guard age >= 0, age < hatchSeconds else { return [] }
        let progress = age / hatchSeconds
        return (0..<bubblesPerHatch).map { k in
            let lift = age * (0.9 + 0.3 * Float(k))
            let wobble = sin(age * 5 + Float(k) * 2) * 0.08
            return Bubble(center: origin + [wobble + (Float(k) - 1) * 0.12, lift, 0.02],
                          radius: 0.07 + 0.03 * Float(k % 2) + 0.03 * progress,
                          opacity: 1 - progress)
        }
    }
}

/// Per-creature brood memory: wake lean and the hatches still rising.
struct BackgroundBrood: Equatable {
    struct Hatch: Equatable { var origin: SIMD3<Float>; var age: Float }
    private(set) var count = 0
    private(set) var lean: Float = BackgroundWorkPresentation.restLean
    private(set) var hatches: [Hatch] = []
    private var lastX: Float?

    /// Records the task count of a working creature. A decrease hatches the
    /// pods that finished, from the tip of the strand inward. Leaving the
    /// working state (an approval prompt, an error, idle) hides the brood
    /// without hatching: the tasks did not finish, the creature only stopped
    /// showing them. Nothing hatches under Reduce Motion, where a hatch could
    /// never finish rising.
    mutating func observe(count newCount: Int, working: Bool, phase: Float, animate: Bool) {
        let previous = count
        count = working ? max(0, newCount) : 0
        // Reduce Motion switched on mid-hatch must not leave bubbles frozen in place.
        if !animate { hatches.removeAll() }
        guard working, animate, count < previous else { return }
        let before = BackgroundWorkPresentation.pods(count: previous, phase: phase, lean: lean)
        let finished = min(previous - count, before.count)
        for pod in before.suffix(finished) {
            hatches.append(Hatch(origin: pod.center, age: 0))
        }
        // Bounded: at most one strand's worth of hatches is ever in flight.
        if hatches.count > BackgroundWorkPresentation.maxPods {
            hatches.removeFirst(hatches.count - BackgroundWorkPresentation.maxPods)
        }
    }

    /// Advances wake lean and hatch ages. `x` is the creature centre in body radii.
    mutating func advance(dt: Float, x: Float) {
        guard dt > 0 else { lastX = x; return }
        if let lastX {
            lean = BackgroundWorkPresentation.lean(previous: lean, velocityX: (x - lastX) / dt, dt: dt)
        }
        lastX = x
        for index in hatches.indices { hatches[index].age += dt }
        hatches.removeAll { $0.age >= BackgroundWorkPresentation.hatchSeconds }
    }

    var bubbles: [BackgroundWorkPresentation.Bubble] {
        hatches.flatMap { BackgroundWorkPresentation.bubbles(origin: $0.origin, age: $0.age) }
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
                resident.addChild(makeBackgroundWork())
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
            broods[item.id, default: BackgroundBrood()].observe(count: item.backgroundTasks, working: item.activity == .working,
                                                                 phase: backgroundPhase, animate: animate)
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
            broods[item.id]?.advance(dt: Float(dt), x: entity.position.x / max(0.01, Self.broodBodyRadius * entity.scale.x))
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

    /// Body radius of a native resident in its own space; the activity bars sit
    /// just outside it at `nativeActivityBarX`.
    private static let broodBodyRadius: Float = 0.75
    private static let tetherBeads = 8

    private func makeBackgroundWork() -> Entity {
        let group = Entity()
        group.name = "background-work"
        func translucent(_ color: Color, _ opacity: Float) -> UnlitMaterial {
            var material = UnlitMaterial(color: nativeColor(color), applyPostProcessToneMap: false)
            material.blending = .transparent(opacity: .init(floatLiteral: opacity))
            return material
        }
        // Allocate a fixed pool once; frame updates only move and scale existing entities.
        let pods = Entity()
        pods.name = "background-pods"
        for index in 0..<BackgroundWorkPresentation.maxPods {
            let pod = Entity()
            pod.name = "background-pod-\(index)"
            let shell = ModelEntity(mesh: .generateSphere(radius: 1), materials: [translucent(DesignTokens.Session.working, 0.32)])
            shell.name = "shell"
            shell.scale = [1, 1.18, 1]
            let embryo = ModelEntity(mesh: .generateSphere(radius: 0.36), materials: [UnlitMaterial(color: nativeColor(DesignTokens.Session.working), applyPostProcessToneMap: false)])
            embryo.name = "embryo"
            let gloss = ModelEntity(mesh: .generateSphere(radius: 0.16), materials: [translucent(DesignTokens.Tide.s50, 0.7)])
            gloss.name = "gloss"
            gloss.position = [-0.42, 0.55, 0.75]
            pod.addChild(shell)
            pod.addChild(embryo)
            pod.addChild(gloss)
            pods.addChild(pod)
        }
        let tether = Entity()
        tether.name = "background-tether"
        for index in 0..<Self.tetherBeads {
            let bead = ModelEntity(mesh: .generateSphere(radius: 0.018), materials: [translucent(DesignTokens.Session.working, 0.55)])
            bead.name = "background-bead-\(index)"
            tether.addChild(bead)
        }
        let bubbles = Entity()
        bubbles.name = "background-bubbles"
        for index in 0..<(BackgroundWorkPresentation.maxPods * BackgroundWorkPresentation.bubblesPerHatch) {
            let bubble = ModelEntity(mesh: .generateSphere(radius: 1), materials: [translucent(DesignTokens.Tide.s50, 0.45)])
            bubble.name = "background-bubble-\(index)"
            bubble.components.set(OpacityComponent(opacity: 1))
            bubbles.addChild(bubble)
        }
        group.addChild(tether)
        group.addChild(pods)
        group.addChild(bubbles)
        return group
    }

    /// Positions the pooled brood from the shared maths. Pure placement: the
    /// count and hatches are owned by `broods`, updated in `sync` and `step`.
    private func updateBackgroundWork(_ resident: Entity, id: String) {
        guard let group = resident.findEntity(named: "background-work") else { return }
        let brood = broods[id] ?? BackgroundBrood()
        let pods = BackgroundWorkPresentation.pods(count: brood.count, phase: backgroundPhase, lean: brood.lean)
        let bubbles = brood.bubbles
        group.isEnabled = !pods.isEmpty || !bubbles.isEmpty
        guard group.isEnabled else { return }
        let r = Self.broodBodyRadius
        // Native residents stand on a support, so a strand below the arms would
        // sink into it: the 3D brood rides higher and further out, beside the hip.
        // Continuous in the lean, so a strand swinging across never jumps sides.
        let outward = max(-1, min(1, brood.lean)) * 0.66
        func place(_ p: SIMD3<Float>) -> SIMD3<Float> { [(p.x + outward) * r, (p.y + 0.9) * r, p.z * r + 0.12] }
        if let holder = group.findEntity(named: "background-pods") {
            for (index, pod) in holder.children.enumerated() {
                pod.isEnabled = index < pods.count
                guard index < pods.count else { continue }
                let shape = pods[index]
                pod.position = place(shape.center)
                // Shaded spheres read larger than the flat Canvas outline.
                pod.scale = .init(repeating: shape.radius * r * 0.8)
                let embryo = BackgroundWorkPresentation.embryoOffset(shape)
                pod.findEntity(named: "embryo")?.position = [embryo.x / shape.radius, embryo.y / shape.radius, 0.1]
            }
        }
        if let tether = group.findEntity(named: "background-tether") {
            tether.isEnabled = !pods.isEmpty
            let points = [BackgroundWorkPresentation.anchor(lean: brood.lean)] + pods.map(\.center)
            for (index, bead) in tether.children.enumerated() {
                // Beads spread evenly along the strand from the arms to the tip pod.
                let t = (Float(index) + 0.5) / Float(Self.tetherBeads) * Float(points.count - 1)
                let segment = min(points.count - 2, Int(t))
                bead.isEnabled = points.count > 1
                guard points.count > 1 else { continue }
                let local = t - Float(segment)
                bead.position = place(points[segment] + (points[segment + 1] - points[segment]) * local)
            }
        }
        if let holder = group.findEntity(named: "background-bubbles") {
            for (index, bubble) in holder.children.enumerated() {
                bubble.isEnabled = index < bubbles.count
                guard index < bubbles.count else { continue }
                bubble.position = place(bubbles[index].center)
                bubble.scale = .init(repeating: bubbles[index].radius * r)
                bubble.components.set(OpacityComponent(opacity: bubbles[index].opacity))
            }
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
