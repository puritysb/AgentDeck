import SwiftUI
import RealityKit

/// AgentDeck-original Nous girl mermaid interpretation, authored in Blender.
/// Bundled mesh with named hinges; articulation never rebuilds geometry.
@available(iOS 18.0, macOS 15.0, *)
@MainActor
enum HermesMermaid {
    /// Cached entity handles; no hierarchy search or geometry allocation per frame.
    struct Rig {
        let head: Entity?
        let tail: Entity?
        let fin: Entity?
        let left: Entity?
        let right: Entity?
        let eyes: [Entity]
        let smile: Entity?
        init(_ root: Entity) {
            smile = root.findEntity(named: "smile")
            head = root.findEntity(named: "hermes_head")
            tail = root.findEntity(named: "hermes_tail")
            fin = root.findEntity(named: "hermes_fin")
            left = root.findEntity(named: "hermes_arm_left")
            right = root.findEntity(named: "hermes_arm_right")
            eyes = [root.findEntity(named: "hermes_eye_left"), root.findEntity(named: "hermes_eye_right")].compactMap { $0 }
        }
        func pose(_ swim: HermesSwim) {
            tail?.orientation = simd_quatf(angle: swim.tail, axis: [1,0,0]) * simd_quatf(angle: swim.tailBank, axis: [0,0,1])
            fin?.orientation = simd_quatf(angle: swim.fin, axis: [1,0,0])
            head?.orientation = simd_quatf(angle: swim.headRoll, axis: [0,0,1])
                * simd_quatf(angle: swim.headPitch, axis: [1,0,0])
            left?.orientation = simd_quatf(angle: -swim.arm, axis: [0,0,1])
            right?.orientation = simd_quatf(angle: swim.rightArm, axis: [0,0,1])
            for eye in eyes {
                eye.scale.y = swim.eyeHeight
                eye.scale.x = swim.eyeWidth
            }
            smile?.scale.y = swim.smileHeight
        }
    }
}
