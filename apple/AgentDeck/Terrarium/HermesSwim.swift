import Foundation
import simd

/// Cosmetic motion only. A neighbour is not evidence of delegation or teamwork.
/// Integrated in simulation time: roster order, frame rate and app suspension
/// must not restart a stroke or teleport a resident.
struct HermesSwim {
    enum Activity: String { case idle, working, waiting, error }
    var position: SIMD3<Float>
    private(set) var velocity = SIMD3<Float>.zero
    private(set) var phase: Float
    private(set) var effort: Float = 0
    private(set) var attention: Float = 0
    private(set) var sadness: Float = 0
    private(set) var celebration: Float = 0
    private(set) var greeting: Float = 0
    private(set) var elapsed: Float = 0
    private var previous: Activity?
    private let offset: Float

    init(id: String, position: SIMD3<Float>) {
        let hash = id.utf8.reduce(UInt32(2166136261)) { ($0 ^ UInt32($1)) &* 16777619 }
        offset = Float(hash % 10000) / 10000 * 2 * .pi
        phase = offset
        self.position = position
    }

    mutating func relocate(_ destination: SIMD3<Float>) {
        position = destination
        velocity = .zero
    }

    var blink: Float {
        let t = (elapsed + offset).truncatingRemainder(dividingBy: 4.7)
        return t < 0.18 ? max(0.08, abs(t - 0.09) / 0.09) : 1
    }
    var tail: Float { sin(phase) * (0.10 + min(1, simd_length(velocity) * 2) * 0.38 + effort * 0.10) }
    var fin: Float { sin(phase - 1.0) * (0.15 + min(1, simd_length(velocity) * 2) * 0.45 + effort * 0.12) }
    var yaw: Float { max(-1.15, min(1.15, atan2(velocity.x, 0.22 + abs(velocity.z)))) }
    var pitch: Float { max(-0.35, min(0.35, -velocity.z * 0.9 - velocity.y * 0.55)) }
    var roll: Float { max(-0.55, min(0.55, -velocity.x * 1.3)) }
    var arm: Float { attention * 1.4 + greeting * (0.55 + sin(phase) * 0.12) + celebration * 0.35 + effort * (0.18 + sin(phase) * 0.06) }

    var headRoll: Float { greeting * 0.10 - sadness * 0.15 - roll * 0.25 }
    var headPitch: Float { effort * 0.12 + sadness * 0.2 }
    var rightArm: Float { arm * 0.25 + sin(phase + 1) * effort * 0.08 }
    var eyeHeight: Float { blink * (1 - sadness * 0.5 - effort * 0.15) }
    var eyeWidth: Float { 1 + attention * 0.15 }
    var smileHeight: Float { 1 + attention * 1.5 + celebration * 0.4 }
    var tailBank: Float { velocity.x * 0.25 }

    mutating func step(_ delta: Float, home: SIMD3<Float>, size: Float,
                       activity: Activity, neighbours: [SIMD3<Float>], aspect: Float) {
        let dt = min(max(delta.isFinite ? delta : 0, 0), 0.05)
        guard dt > 0 else { return }
        elapsed += dt
        let blend = 1 - exp(-dt * 3)
        effort += ((activity == .working ? 1 : 0) - effort) * blend
        attention += ((activity == .waiting ? 1 : 0) - attention) * blend
        sadness += ((activity == .error ? 1 : 0) - sadness) * blend
        if previous == .working && activity == .idle { celebration = 1 }
        celebration = max(0, celebration - dt * 0.42)
        previous = activity
        phase += dt * (1.1 + simd_length(velocity) * 4 + effort * 1.4)

        // A slow three-dimensional figure eight, tightly bounded around the
        // assigned slot so crowded/portrait tanks retain their label layout.
        let t = elapsed * 0.34 + offset
        let radius = size * (0.85 + effort * 0.35) * (1 - attention * 0.85)
        var destination = home + SIMD3<Float>(sin(t) * radius,
            sin(t * 1.37) * radius * 0.16,
            sin(t * 0.83) * radius * 0.70)
        var nearest: SIMD3<Float>?
        var distance = Float.infinity
        for peer in neighbours {
            let d = simd_distance(peer, position)
            if d < distance { distance = d; nearest = peer }
        }
        // Occasional neighbour-facing greeting and curved pass, with no task
        // line, command symbol or implied transfer of work.
        let social = max(0, sin(elapsed * 0.18 + offset)) * (1 - effort) * (1 - attention) * (1 - sadness)
        greeting += ((distance < size * 3 ? social : 0) - greeting) * blend
        if let peer = nearest, distance > 0.001, distance < size * 3 {
            let direction = simd_normalize(peer - position)
            let arc = peer + SIMD3<Float>(cos(t) * size * 1.3, sin(t * 0.8) * size * 0.2,
                                                sin(t) * size * 1.3)
            var excursion = arc - home
            let length = simd_length(excursion)
            if length > size * 1.2 { excursion *= size * 1.2 / length }
            destination += (home + excursion - destination) * greeting * 0.65
            destination += SIMD3<Float>(direction.z, 0, -direction.x) * greeting * size * 0.10
        }
        // Separation is computed from one scene snapshot, never iteration order.
        for peer in neighbours {
            let difference = position - peer
            let d = simd_length(difference)
            let clearance = max(0.4, size * 1.15)
            if d > 0.001 && d < clearance {
                destination += difference / d * (clearance - d) * 0.8
            }
        }
        let halfWidth = min(3.65, max(0.9, aspect * 3.0)) - size * 0.35
        destination.x = max(-halfWidth, min(halfWidth, destination.x))
        destination.y = max(1.55, min(4.65, destination.y))
        destination.z = max(-1.0, min(1.7, destination.z))
        let desired = (destination - position) * 1.5
        velocity += (desired - velocity) * (1 - exp(-dt * 2.5))
        let speed = simd_length(velocity)
        let maximum = max(0.20, size * (0.50 + effort * 0.30))
        if speed > maximum { velocity *= maximum / speed }
        position += velocity * dt
    }
}
