import SwiftUI
import RealityKit

/// A presentation projection of canonical live residents, never inferred providers.
struct AquariumResident: Equatable {
    enum Activity: String { case idle = "IDLE", working = "WORKING", waiting = "WAITING", error = "ERROR" }
    let id: String
    let kind: String
    let title: String
    let activity: Activity
    var helpers: Int = 0

    static func foreground(_ items: [Self], focusedID: String?) -> [Self] {
        func priority(_ item: Self) -> Int {
            if item.id == focusedID || (item.id == "crayfish" && focusedID == "openclaw-gateway") { return 0 }
            if item.activity == .waiting { return 1 }
            if item.activity == .working { return 2 }
            return 3
        }
        return Array(items.sorted {
            let a = priority($0), b = priority($1)
            return a == b ? $0.id < $1.id : a < b
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
        if state.crayfishVisible {
            items.append(Self(id: "crayfish", kind: "openclaw", title: "OpenClaw", activity: state.crayfishState == .sick ? .error : state.crayfishState == .waiting ? .waiting : state.crayfishState == .routing ? .working : .idle))
        }
        return items.sorted { $0.id < $1.id }
    }
}

@available(iOS 18.0, macOS 15.0, *)
@MainActor
final class AquariumResidents {
    let root = Entity()
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
    private struct Joint {
        let entity: Entity
        let rest: Transform
    }
    private var joints: [String: [Joint]] = [:]
    private var supports: [String: Entity] = [:]
    private var footHeights: [String: Float] = [:]
    let shoal = AquariumShoal()
    private var time: Double = 0
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
            motions.removeValue(forKey: id)
            joints.removeValue(forKey: id)
            supports.removeValue(forKey: id)?.removeFromParent()
        }

        // Existing residents retain their relative order when sessions arrive or depart.
        let existing = slotOrder.filter(ids.contains)
        slotOrder = existing + next.map(\.id).filter { !existing.contains($0) }
        let bottomIDs = slotOrder.filter { id in next.contains { $0.id == id && Self.isGrounded($0.kind) } }
        let waterIDs = slotOrder.filter { !bottomIDs.contains($0) }
        let waterLayout = Self.layout(count: waterIDs.count, aspect: aspect)
        let bottomLayout = Self.bottomLayout(count: bottomIDs.count, aspect: aspect)
        for item in next {
            let grounded = Self.isGrounded(item.kind)
            if grounded {
                let index = bottomIDs.firstIndex(of: item.id) ?? 0
                let surface = bottomLayout.positions[index]
                size = bottomLayout.size
                targets[item.id] = surface + [0, (footHeights[item.kind] ?? 0.43) * size, 0]
                // A broad, flat-topped substrate rock is fixed in habitat space.
                // It does not follow the resident's pacing or breathing.
                if supports[item.id] == nil {
                    let support = makeSubstrate()
                    support.name = "substrate|" + item.id
                    root.addChild(support)
                    supports[item.id] = support
                }
                supports[item.id]?.position = [surface.x, 0, surface.z]
                supports[item.id]?.scale = [max(0.65, size * 1.35), surface.y, max(0.55, size)]
            } else {
                let index = waterIDs.firstIndex(of: item.id) ?? 0
                size = waterLayout.size
                var position = waterLayout.positions[index]
                // Water residents occupy the clear region above the substrate.
                position.y += 0.5
                targets[item.id] = position
            }
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
                resident.position = targets[item.id]!
                root.addChild(resident)
                residents[item.id] = resident
                motions[item.id] = Motion(phase: Self.seed(item.id) * 6.28)
                func collect(_ node: Entity) -> [Joint] {
                    (node.name.hasPrefix("joint_") ? [Joint(entity: node, rest: node.transform)] : []) + node.children.flatMap { collect($0) }
                }
                joints[item.id] = collect(body)
            }
            guard let resident = residents[item.id] else { continue }
            // Canonical state controls visibility immediately, even while paused.
            resident.findEntity(named: "activity")?.isEnabled = item.activity == .working
            resident.scale = .init(repeating: size)
            if !animate { resident.position = targets[item.id]! }
            if resident.findEntity(named: "label") == nil || descriptors.first(where: { $0.id == item.id }) != item {
                rebuildLabel(for: item, on: resident, compact: labelCompact[item.id] ?? false)
            }
            resident.findEntity(named: "focus")?.isEnabled = state.focusedSessionId == item.id || (item.id == "crayfish" && state.focusedSessionId == "openclaw-gateway")
        }
        descriptors = next
        applyLabelLayout()
    }

    private var focusedID: String?

    private func rebuildLabel(for item: AquariumResident, on resident: Entity, compact: Bool) {
        resident.findEntity(named: "label")?.removeFromParent()
        let label = makeLabel(String(item.title.prefix(22)), activity: item.activity, helpers: item.helpers, compact: compact)
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
        guard animate else { return }
        // Bound integration after occlusion/sleep; no wall-clock jump on resume.
        let dt = min(max(delta, 0), 1.0 / 20)
        time += dt
        let blend = Float(1 - exp(-dt * 3))
        var wakes: [AquariumShoal.WorkWake] = []
        for item in descriptors {
            guard let entity = residents[item.id], var target = targets[item.id], var motion = motions[item.id] else { continue }
            motion.effort += ((item.activity == .working ? 1 : 0) - motion.effort) * blend
            motion.attention += ((item.activity == .waiting ? 1 : 0) - motion.attention) * blend
            motion.fatigue += ((item.activity == .error ? 1 : 0) - motion.fatigue) * blend
            // Integrate phase rather than multiplying time by a state-dependent rate.
            // State transitions and changes in the roster must never snap a pose.
            motion.phase += Float(dt) * (TerrariumRules.nativeActivityIdleRate + motion.effort * TerrariumRules.nativeActivityWorkRate)
            let phase = motion.phase
            motions[item.id] = motion
            // A short power stroke followed by a longer recovery. The same stroke
            // drives the pose and water disturbance, so fish react to visible action.
            let stroke = pow(max(0, sin(phase)), 6) * motion.effort
            let workSwing = sin(phase) * motion.effort
            let grounded = Self.isGrounded(item.kind)
            let residentSize = entity.scale.x
            // Bottom dwellers pace horizontally with planted feet. No vertical
            // sine wave, spring settling, roll, or whole-body scale at contact.
            target.x += sin(phase * 0.5) * residentSize * (grounded ? motion.effort * TerrariumRules.nativeActivityGroundTravel : 0.18)
            if !grounded {
                target.x += workSwing * residentSize * TerrariumRules.nativeActivityWaterTravel
                target.z += sin(phase * 0.5) * 0.12 + stroke * residentSize * 0.24
            }
            if stroke > 0.001 {
                wakes.append(.init(position: entity.position, strength: stroke, radius: max(1.2, residentSize * 2.8)))
            }
            entity.position += (target - entity.position) * blend
            if grounded { entity.position.y = target.y }
            if let body = entity.findEntity(named: "body") {
                let yaw = sin(phase * 0.5) * (grounded ? motion.effort * TerrariumRules.nativeActivityGroundYaw : 0.20 + motion.effort * TerrariumRules.nativeActivityWorkYaw)
                let orientation = simd_quatf(angle: yaw, axis: [0,1,0])
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
                    let lift = motion.attention * 0.40 - motion.fatigue * 0.25
                    joint.orientation = pose.rest.rotation * simd_quatf(angle: side * (lift + wave * 0.025 + motion.effort * (0.20 + sin(phase) * 0.58)), axis: [0,0,1])
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
                label.scale = .init(repeating: pulse)
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

    private func makeLabel(_ title: String, activity: AquariumResident.Activity, helpers: Int, compact: Bool = false) -> Entity {
        let group = Entity()
        group.name = "label"
        let active = activity == .working
        // Session state colours (DESIGN.md §2.7), never the marketing Status palette.
        let color: Color = switch activity {
        case .waiting: DesignTokens.Session.awaiting
        case .working: DesignTokens.Session.working
        case .error: DesignTokens.Session.error
        case .idle: DesignTokens.Session.idle
        }
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
        group.addChild(text(activity.rawValue + (helpers > 0 ? " · \(helpers) agents" : ""), name: "status", bold: active, size: 0.16,
                            ink: active ? DesignTokens.Ink.s900 : color, y: 0.70, maxWidth: 1.82))
        return group
    }

    #if os(macOS)
    private func nativeColor(_ color: Color) -> NSColor { NSColor(color) }
    #else
    private func nativeColor(_ color: Color) -> UIColor { UIColor(color) }
    #endif
}
