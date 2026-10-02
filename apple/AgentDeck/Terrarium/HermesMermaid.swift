import SwiftUI
import RealityKit

/// Bundled skinned mesh plus portrait controls; no per-frame mesh generation.
@available(iOS 18.0, macOS 15.0, *)
@MainActor
enum HermesMermaid {
    static let requiredBones: Set<String> = ["spine", "tail_base", "tail_mid", "tail_tip", "fin",
        "fin_left", "fin_right", "arm_left", "elbow_left", "wrist_left", "arm_right", "elbow_right", "wrist_right"]

    static func rotation(_ angles: SIMD3<Float>) -> simd_quatf {
        simd_quatf(angle: angles.x, axis: [1,0,0])
            * simd_quatf(angle: angles.y, axis: [0,1,0])
            * simd_quatf(angle: angles.z, axis: [0,0,1])
    }

    @MainActor
    final class Rig {
        @MainActor
        struct Control {
            let entity: Entity
            let rest: Transform
            init(_ entity: Entity) { self.entity = entity; rest = entity.transform }
            func rotate(_ angles: SIMD3<Float>) {
                entity.orientation = rest.rotation * HermesMermaid.rotation(angles)
            }
        }
        @MainActor
        final class Skin {
            let entity: ModelEntity
            let names: [String]
            let rest: [Transform]
            var transforms: [Transform]
            init(_ entity: ModelEntity) {
                self.entity = entity
                names = entity.jointNames.map { String($0.split(separator: "/").last ?? "") }
                rest = entity.jointTransforms
                transforms = rest
            }
            func apply(_ pose: HermesSwim.Pose) {
                guard names.count == rest.count else { return }
                for i in transforms.indices {
                    transforms[i].rotation = rest[i].rotation * HermesMermaid.rotation(pose.rotation(for: names[i]))
                }
                entity.jointTransforms = transforms
            }
        }
        let skins: [Skin]
        let controls: [String: Control]
        /// The laptop's centre in its parent's frame: it turns round about
        /// this point, not about the spine origin it is parented at.
        private var laptopPivot: SIMD3<Float>?
        var boneNames: Set<String> { Set(skins.flatMap(\.names)) }
        var isComplete: Bool {
            HermesMermaid.requiredBones.isSubset(of: boneNames)
                && ["hermes_head", "hermes_spine", "hermes_eye_left", "hermes_eye_right",
                    "hermes_lid_left", "hermes_lid_right", "closed_lid_left", "closed_lid_right",
                    "hermes_pupil_left", "hermes_pupil_right", "hermes_brow_left", "hermes_brow_right",
                    "hermes_hair_left", "hermes_hair_right", "hermes_mouth", "mouth_open",
                    "hermes_lip_upper", "hermes_lip_lower"].allSatisfy { controls[$0] != nil }
        }
        init(_ root: Entity) {
            var skin: [Skin] = []
            var nodes: [String: Control] = [:]
            func visit(_ entity: Entity) {
                if let model = entity as? ModelEntity, !model.jointNames.isEmpty { skin.append(Skin(model)) }
                nodes[entity.name] = Control(entity)
                for child in entity.children { visit(child) }
            }
            visit(root)
            skins = skin
            controls = nodes
            // Export includes these meshes; hide them before the first scene frame,
            // including Reduce Motion where the controller never advances.
            controls["hermes_lid_left"]?.entity.isEnabled = false
            controls["hermes_lid_right"]?.entity.isEnabled = false
            controls["mouth_open"]?.entity.isEnabled = false
            controls["laptop_screen_alert"]?.entity.isEnabled = false
            if let laptop = controls["laptop"]?.entity, let parent = laptop.parent {
                let bounds = laptop.visualBounds(relativeTo: parent)
                if !bounds.isEmpty { laptopPivot = bounds.center }
            }
        }
        func pose(_ swim: HermesSwim) { apply(swim.pose) }
        func apply(_ pose: HermesSwim.Pose) {
            for skin in skins { skin.apply(pose) }
            controls["hermes_spine"]?.rotate(pose.spine)
            controls["hermes_head"]?.rotate(pose.head)
            controls["hermes_hair_left"]?.rotate([pose.hairLeft, 0, 0])
            controls["hermes_hair_right"]?.rotate([pose.hairRight, 0, 0])
            controls["hermes_laptop_lid"]?.rotate([pose.laptopLid, 0, 0])   // optional prop control
            if let laptop = controls["laptop"], let pivot = laptopPivot {
                // turn about the laptop's own centre: p' = c + q (p - c)
                let q = simd_quatf(angle: .pi * pose.laptopTurn, axis: [0, 1, 0])
                laptop.entity.orientation = q * laptop.rest.rotation
                laptop.entity.position = pivot + q.act(laptop.rest.translation - pivot)
            }
            if let alert = controls["laptop_screen_alert"] {
                alert.entity.isEnabled = pose.laptopAlert > 0.01
                alert.entity.scale = alert.rest.scale * (0.96 + 0.04 * pose.laptopAlert)
            }
            for (side, openness, angle) in [("left", pose.eyeLeft, pose.browLeft), ("right", pose.eyeRight, pose.browRight)] {
                if let eye = controls["hermes_eye_" + side] {
                    eye.entity.scale = eye.rest.scale * [1, max(0.05, openness), 1]
                    eye.entity.isEnabled = openness > 0.12
                }
                // A full blink uses a closed-lid mesh rather than disappearing eyes.
                controls["hermes_lid_" + side]?.entity.isEnabled = openness <= 0.12
                controls["closed_lid_" + side]?.entity.isEnabled = true
                if let pupil = controls["hermes_pupil_" + side] {
                    pupil.entity.position = pupil.rest.translation + [pose.pupil.x, pose.pupil.y, 0]
                }
                if let brow = controls["hermes_brow_" + side] {
                    brow.rotate([0, 0, angle])
                    brow.entity.position = brow.rest.translation + [0, pose.browLift, 0]
                }
            }
            if let lip = controls["hermes_lip_lower"] {
                lip.entity.position = lip.rest.translation + [0, -pose.mouthOpen * 0.012, 0]
                lip.entity.scale.y = lip.rest.scale.y * (1 + pose.mouthCurve)
            }
            if let upper = controls["hermes_lip_upper"] {
                upper.entity.scale.y = upper.rest.scale.y * (1 - pose.mouthCurve)
            }
            if let opening = controls["mouth_open"] {
                opening.entity.isEnabled = pose.mouthOpen > 0.03
                opening.entity.scale.y = max(0.01, pose.mouthOpen)
            }
        }
    }
}
