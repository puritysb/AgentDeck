import RealityKit

/// Continuous cruising with bounded steering. Residents disturb the school;
/// separation and alignment propagate the disturbance to neighboring fish.
@available(iOS 18.0, macOS 15.0, *)
@MainActor
final class AquariumShoal {
    /// A transient water stroke, shared with the resident's visible work pose.
    struct WorkWake {
        let position: SIMD3<Float>
        let strength: Float
        let radius: Float
    }
    let root = Entity()
    private var fish: [Entity] = []
    private(set) var snail: Entity?
    private var snailTime: Double = 0
    private var tails: [Entity?] = []
    private(set) var positions: [SIMD3<Float>] = []
    private(set) var velocities: [SIMD3<Float>] = []
    private var tailRest: [simd_quatf] = []
    private var tailPhase: [Float] = []
    private var time: Float = 0
    private(set) var alertness: [Float] = []

    func load(_ habitat: Entity) {
        guard fish.isEmpty else { return }
        func find(_ node: Entity) -> [Entity] {
            if node.name.lowercased().replacingOccurrences(of: "_", with: " ").hasPrefix("fish yaw") { return [node] }
            return node.children.flatMap { find($0) }
        }
        func findSnail(_ node: Entity) -> Entity? {
            if node.name.replacingOccurrences(of: "_", with: " ").lowercased() == "fauna snail" { return node }
            return node.children.compactMap { findSnail($0) }.first
        }
        if snail == nil, let source = findSnail(habitat) {
            let body = source.clone(recursive: true)
            body.stopAllAnimations(recursive: true)
            body.transform = Transform(matrix: source.transformMatrix(relativeTo: nil))
            body.position = .zero
            body.scale *= 0.60
            let walker = Entity()
            walker.name = "wandering-snail"
            walker.addChild(body)
            root.addChild(walker)
            source.isEnabled = false
            snail = walker
            updateSnail()
        }
        let sources = find(habitat).sorted { $0.name < $1.name }
        guard let source = sources.first else { return }
        let template = source.clone(recursive: true)
        template.stopAllAnimations(recursive: true)
        template.transform = Transform(matrix: source.transformMatrix(relativeTo: nil))
        template.position = .zero
        // Authored first fish faces +Y in Blender, -Z in the Y-up USD scene.
        template.orientation = simd_quatf(angle: -.pi / 2, axis: [0,1,0]) * template.orientation
        for source in sources { source.isEnabled = false }
        for index in 0..<14 {
            let entity = Entity()
            let model = template.clone(recursive: true)
            entity.addChild(model)
            root.addChild(entity)
            fish.append(entity)
            func tail(_ node: Entity) -> Entity? {
                if node.name.lowercased().contains("caudal") { return node }
                return node.children.compactMap { tail($0) }.first
            }
            let fin = tail(model)
            tails.append(fin)
            tailRest.append(fin?.orientation ?? simd_quatf(angle: 0, axis: [0,0,1]))
            tailPhase.append(Float(index))
            alertness.append(0)
            let phase = Float(index) * 0.43
            positions.append([cos(phase) * 3.2, 2.3 + sin(phase * 2) * 0.4, sin(phase) * 1.3])
            velocities.append([-sin(phase) * 0.5, 0, cos(phase) * 0.5])
            entity.position = positions[index]
        }
    }

    /// A six-minute ground circuit around both planted islands. Depth occlusion
    /// comes from the scene itself; never fade or teleport the animal for visibility.
    static func snailPosition(at seconds: Double) -> SIMD3<Float> {
        let route: [SIMD2<Float>] = [
            [-4.9, 1.4], [-5.5, -0.3], [-5.6, -2.7], [-3.5, -3.8],
            [-0.5, -3.7], [2, -4.3], [5.4, -4.5], [5.7, -1.5],
            [5, 1.4], [2.8, 2.6], [-0.8, 2.6], [-3.7, 2.2]
        ]
        let phase = Float((seconds.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 360) * Float(route.count)
        let index = Int(phase) % route.count, t = phase - floor(phase)
        let a = route[(index + route.count - 1) % route.count]
        let b = route[index], c = route[(index + 1) % route.count], d = route[(index + 2) % route.count]
        let linear = c - a
        let quadratic = a * 2 - b * 5 + c * 4 - d
        let cubic = -a + b * 3 - c * 3 + d
        let tSquared: Float = t * t
        let tCubed: Float = tSquared * t
        var p: SIMD2<Float> = b * 2
        p += linear * t
        p += quadratic * tSquared
        p += cubic * tCubed
        p *= 0.5
        // Match the authored bowl and sand ribbon, including the rear slope.
        let gardenY = -p.y
        let rise = max(0, gardenY - 2)
        var height = rise * rise * 0.16 - 0.10
        let v = (gardenY + 7) / 11
        if v >= 0 && v <= 1 {
            let center = 0.3 + 1.15 * sin(v * 3.5)
            let taper: Float = 4 * (1 - v) + 0.35
            let ripple: Float = 1 + 0.055 * sin(v * 31)
            let width: Float = taper * ripple
            let u = (p.x - center) / width + 0.5
            if u > 0 && u < 1 {
                let edge = min(1, min(u, 1 - u) * width / 0.08)
                let edgeHeight: Float = 0.025 * edge * edge * (3 - 2 * edge)
                let ribbonHeight: Float = 0.05 * sin(Float.pi * u)
                height += edgeHeight + ribbonHeight
            }
        }
        return [p.x, height + 0.008, p.y]
    }

    private func updateSnail() {
        guard let snail else { return }
        let position = Self.snailPosition(at: snailTime)
        let direction = Self.snailPosition(at: snailTime + 0.2) - Self.snailPosition(at: snailTime - 0.2)
        let yaw = atan2(-direction.z, direction.x)
        let pitch = atan2(direction.y, simd_length(SIMD2(direction.x, direction.z)))
        snail.position = position
        snail.orientation = simd_quatf(angle: yaw, axis: [0,1,0]) * simd_quatf(angle: pitch, axis: [0,0,1])
    }

    func step(_ delta: Double, residents: [SIMD3<Float>], wakes: [WorkWake] = []) {
        let dt = Float(min(max(delta, 0), 1.0 / 20))
        time += dt
        snailTime += Double(dt)
        updateSnail()
        let oldPositions = positions
        let oldVelocities = velocities
        let oldAlertness = alertness
        for i in positions.indices {
            let p = oldPositions[i]
            var alarm = oldAlertness[i] * exp(-dt * 1.8)
            var wakeForce = SIMD3<Float>.zero
            for wake in wakes {
                var offset = p - wake.position
                // A bottom resident's stroke reaches the cruising layer above it.
                offset.y *= 0.45
                let distance = simd_length(offset)
                let influence = max(0, 1 - distance / max(0.1, wake.radius)) * min(1, max(0, wake.strength))
                alarm = max(alarm, influence)
                let away = distance > 0.01 ? offset / distance : SIMD3<Float>(1, 0, 0)
                wakeForce += away * influence * 3.6
            }
            var force = SIMD3<Float>(-p.z * 0.08, (2.4 - p.y) * 0.18, p.x * 0.035)
            // Soft aquarium bounds turn the school before it reaches the glass.
            // Stronger strokes need ceiling/floor steering as well as glass bounds.
            force.y += max(0, 1.5 - p.y) * 2 - max(0, p.y - 3.3) * 2
            force.x -= max(0, abs(p.x) - 3.6) * (p.x > 0 ? 0.9 : -0.9)
            force.z -= max(0, abs(p.z) - 1.8) * (p.z > 0 ? 0.9 : -0.9)
            force += SIMD3(sin(time * 0.39 + Float(i)), sin(time * 0.57 + Float(i) * 0.8) * 0.3, cos(time * 0.31 + Float(i))) * 0.08
            for j in positions.indices where i != j {
                let offset = p - oldPositions[j]
                let distance = simd_length(offset)
                if distance < 0.55 { force += offset / max(0.04, distance * distance) * 0.18 }
                else if distance < 1.4 {
                    // Delayed, weaker contagion; never amplify or sustain an alarm
                    // after its originating work stroke has stopped.
                    alarm = max(alarm, oldAlertness[j] * 0.65 * exp(-dt * 1.8))
                    force += (oldVelocities[j] - oldVelocities[i]) * 0.055 - offset * 0.012
                }
            }
            for resident in residents {
                let offset = p - resident
                let distance = simd_length(offset)
                if distance < 1.25 {
                    force += offset / max(0.08, distance) * (1.25 - distance) * 1.4
                }
            }
            alertness[i] = alarm
            force += wakeForce
            let acceleration = simd_length(force)
            let limit: Float = 0.7 + alarm * 2.4
            if acceleration > limit { force *= limit / acceleration }
            var velocity = oldVelocities[i] + force * dt
            let speed = simd_length(velocity)
            if speed > 0.001 {
                // Burst, then ease back into cruising instead of staying scattered.
                let cruise: Float = 0.48 + alarm * 1.15
                let eased = speed + (cruise - speed) * (1 - exp(-dt * 2))
                velocity *= min(0.8 + alarm, max(0.32, eased)) / speed
            }
            velocities[i] = velocity
            positions[i] += velocity * dt
            fish[i].position = positions[i]
            let yaw = atan2(-velocity.z, velocity.x)
            let pitch = atan2(velocity.y, max(0.01, simd_length(SIMD2(velocity.x, velocity.z))))
            let orientation = simd_quatf(angle: yaw, axis: [0,1,0]) * simd_quatf(angle: pitch, axis: [0,0,1])
            fish[i].orientation = simd_slerp(fish[i].orientation, orientation, 1 - exp(-dt * (5 + alarm * 7)))
            tailPhase[i] += dt * (8 + simd_length(velocity) * 6 + alarm * 10)
            tails[i]?.orientation = tailRest[i] * simd_quatf(angle: sin(tailPhase[i]) * 0.22, axis: [0,0,1])
        }
    }
}
