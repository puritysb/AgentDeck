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
            for entity in residents.values { entity.findEntity(named: "label")?.isEnabled = labelsVisible }
        }
    }

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
                resident.findEntity(named: "label")?.removeFromParent()
                let label = makeLabel(String(item.title.prefix(22)), activity: item.activity, helpers: item.helpers)
                label.isEnabled = labelsVisible
                resident.addChild(label)
            }
            resident.findEntity(named: "focus")?.isEnabled = state.focusedSessionId == item.id || (item.id == "crayfish" && state.focusedSessionId == "openclaw-gateway")
        }
        descriptors = next
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

    private func makeLabel(_ title: String, activity: AquariumResident.Activity, helpers: Int) -> Entity {
        let group = Entity()
        group.name = "label"
        let active = activity == .working
        let color: Color = switch activity {
        case .waiting: DesignTokens.Status.awaiting
        case .working: DesignTokens.Status.processing
        case .error: DesignTokens.Status.error
        case .idle: DesignTokens.Status.idle
        }
        let backing = ModelEntity(mesh: .generateBox(size: [2.05, 0.58, 0.008], cornerRadius: 0.06),
            materials: [UnlitMaterial(color: nativeColor(TerrariumColors.deepSea), applyPostProcessToneMap: false)])
        backing.position = [0, 0.83, 0.40]
        group.addChild(backing)
        if active {
            let badge = ModelEntity(mesh: .generateBox(size: [1.95, 0.26, 0.008], cornerRadius: 0.04),
                materials: [UnlitMaterial(color: nativeColor(color), applyPostProcessToneMap: false)])
            badge.name = "working-badge"
            badge.position = [0, 0.70, 0.42]
            group.addChild(badge)
        }
        for (index, text) in [title, activity.rawValue + (helpers > 0 ? " · \(helpers) agents" : "")].enumerated() {
            let mesh = MeshResource.generateText(text, extrusionDepth: 0.002,
                font: .init(name: index == 1 && active ? "IBMPlexSans-Bold" : "IBMPlexSans", size: 0.16)
                    ?? .systemFont(ofSize: 0.16, weight: index == 1 ? .bold : .regular))
            let ink = index == 0 ? TerrariumColors.hudText : active ? DesignTokens.Ink.s900 : color
            let label = ModelEntity(mesh: mesh, materials: [UnlitMaterial(color: nativeColor(ink), applyPostProcessToneMap: false)])
            let bounds = label.visualBounds(relativeTo: label)
            let fit = min(1, 1.82 / max(0.01, bounds.extents.x))
            label.scale = .init(repeating: fit)
            label.position = [-bounds.center.x * fit, (index == 0 ? 0.96 : 0.70) - bounds.center.y * fit, 0.44]
            group.addChild(label)
        }
        return group
    }

    #if os(macOS)
    private func nativeColor(_ color: Color) -> NSColor { NSColor(color) }
    #else
    private func nativeColor(_ color: Color) -> UIColor { UIColor(color) }
    #endif
}
