// Standalone asset gate; does not launch AgentDeck or change its resources.
// xcrun swiftc -parse-as-library assets/terrarium/validate-hermes-character.swift -o /tmp/hermes-asset-check
// /tmp/hermes-asset-check assets/terrarium/hermes-character.usdz
import Foundation
import RealityKit

@main struct HermesAssetCheck {
    enum Failure: Error { case missing(String) }

    @MainActor static func main() async throws {
        let root = try await Entity(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let copy = root.clone(recursive: true)
        // Parent model entities may also contain model children.
        func collect(_ node: Entity) -> [ModelEntity] {
            var result = (node as? ModelEntity).map { [$0] } ?? []
            for child in node.children { result += collect(child) }
            return result
        }
        let original = collect(root), clone = collect(copy)
        let bones = Set(original.flatMap(\.jointNames).map { String($0.split(separator: "/").last ?? "") })
        let requiredBones: Set<String> = ["spine", "tail_base", "tail_mid", "tail_tip", "fin", "fin_left", "fin_right", "arm_left", "elbow_left", "wrist_left", "arm_right", "elbow_right", "wrist_right"]
        guard requiredBones.isSubset(of: bones) else { throw Failure.missing("deformation bones") }
        let requiredShapes: Set<String> = ["blink_left", "blink_right", "smile", "concern", "jaw_open", "brow_lift", "brow_frown", "hair_sway_left", "hair_sway_right", "blink_mid_left", "blink_mid_right"]
        var seen = Set<String>(), shapeMeshCount = 0
        for (model, other) in zip(original, clone) {
            guard let mesh = model.model?.mesh, let otherMesh = other.model?.mesh else { continue }
            if let loaded = model.components[BlendShapeWeightsComponent.self], !loaded.weightSet.allSatisfy({ $0.weights.allSatisfy({ $0 == 0 }) }) {
                throw Failure.missing("neutral imported default: \(model.name)")
            }
            var weights = BlendShapeWeightsComponent(weightsMapping: BlendShapeWeightsMapping(meshResource: mesh))
            let untouched = BlendShapeWeightsComponent(weightsMapping: BlendShapeWeightsMapping(meshResource: otherMesh))
            guard weights.weightSet.count > 0 else { continue }
            shapeMeshCount += 1
            other.components.set(untouched)
            for i in 0..<weights.weightSet.count {
                var data = weights.weightSet[i]
                seen.formUnion(data.weightNames)
                guard data.weights.allSatisfy({ $0 == 0 }) else { throw Failure.missing("neutral default: \(model.name)") }
                data.weights = BlendShapeWeights(data.weightNames.map { $0 == "blink_left" ? Float(1) : Float(0) })
                weights.weightSet[i] = data
            }
            model.components.set(weights)
            let expected = weights.weightSet.map { Array($0.weights) }
            for _ in 0..<20 { model.components.set(weights) }
            guard model.components[BlendShapeWeightsComponent.self]?.weightSet.map({ Array($0.weights) }) == expected else { throw Failure.missing("stable repeat") }
            guard other.components[BlendShapeWeightsComponent.self]?.weightSet.allSatisfy({ $0.weights.allSatisfy({ $0 == 0 }) }) == true else { throw Failure.missing("independent clone") }
        }
        guard requiredShapes.isSubset(of: seen) else { throw Failure.missing("relative shapes: \(requiredShapes.subtracting(seen))") }
        let bounds = root.visualBounds(relativeTo: nil).extents
        guard bounds.y > 0.8, bounds.y < 1.3, bounds.z > 0.2, bounds.z < bounds.y * 0.75 else { throw Failure.missing("Y-up volume/bounds: \(bounds)") }
        for name in ["resident_hermes", "hermes_head", "hermes_spine", "face", "hermes_pupil_left", "hermes_pupil_right"] {
            guard root.findEntity(named: name) != nil else { throw Failure.missing(name) }
        }
        print("PASS: 13 deformation bones, \(seen.count) relative shapes on \(shapeMeshCount) meshes, zero defaults, clone isolation, repeat stability, Y-up bounds \(bounds)")
        print("Technical import only; this does not establish visual acceptance or native app integration.")
    }
}
