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
    private(set) var gaze = SIMD2<Float>.zero
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

    private func eyelid(_ lag: Float) -> Float {
        let period: Float = 5.3
        let time = elapsed + offset + lag
        let t = time.truncatingRemainder(dividingBy: period)
        func closure(_ t: Float) -> Float {
            guard t >= 0 && t < 0.22 else { return 1 }
            // Fast closure, slower opening; occasional double blink.
            return t < 0.075 ? max(0, 1 - t / 0.075) : min(1, (t - 0.075) / 0.145)
        }
        let first = closure(t)
        return Int(time / period) % 3 == 2 ? min(first, closure(t - 0.36)) : first
    }
    var blink: Float { eyelid(0) }
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


    /// One numeric pose contract for the native rig and the Blender review.
    /// Euler axes are model-local X/Y/Z, composed X then Y then Z.
    struct Pose: Codable {
        var spine, tailBase, tailMid, tailTip, fin, finLeft, finRight: SIMD3<Float>
        var armLeft, elbowLeft, wristLeft, armRight, elbowRight, wristRight: SIMD3<Float>
        var head: SIMD3<Float>
        var hairLeft, hairRight: Float
        var eyeLeft, eyeRight: Float
        var pupil: SIMD2<Float>
        var browLeft, browRight, browLift, mouthOpen, mouthCurve: Float

        func rotation(for bone: String) -> SIMD3<Float> {
            switch bone {
            case "spine": spine
            case "tail_base": tailBase
            case "tail_mid": tailMid
            case "tail_tip": tailTip
            case "fin": fin
            case "fin_left": finLeft
            case "fin_right": finRight
            case "arm_left": armLeft
            case "elbow_left": elbowLeft
            case "wrist_left": wristLeft
            case "arm_right": armRight
            case "elbow_right": elbowRight
            case "wrist_right": wristRight
            default: .zero
            }
        }
    }

    var pose: Pose {
        let speed = min(1, simd_length(velocity) * 2)
        let stroke = 0.12 + speed * 0.15 + effort * 0.04
        let tap = sin(elapsed * 3.5 + offset) * effort
        let wave = sin(elapsed * 4.5 + offset) * greeting
        let tension = sadness * 0.8 + effort * 0.25
        return Pose(
            spine: [sin(phase - 0.15) * 0.025 + effort * 0.025, 0, -roll * 0.10],
            tailBase: [sin(phase) * stroke, tailBank * 0.25, 0],
            tailMid: [sin(phase - 0.65) * stroke * 1.3, tailBank * 0.35, 0],
            tailTip: [sin(phase - 1.3) * stroke * 1.5, tailBank * 0.4, 0],
            fin: [sin(phase - 1.9) * stroke, 0, 0],
            finLeft: [sin(phase - 2.1) * 0.09, -0.04 - speed * 0.09, -0.05 - effort * 0.08],
            finRight: [sin(phase - 2.25) * 0.09, 0.04 + speed * 0.09, 0.05 + effort * 0.08],
            armLeft: [-effort * 0.55, attention * 1.15 + greeting * 0.95 + effort * 0.45,
                      -(0.04 + attention * 0.9 + greeting * 0.65 + effort * 0.28 + celebration * 0.14)],
            elbowLeft: [-effort * 0.28, 0, -(0.08 + effort * (0.38 + tap * 0.08) + attention * 0.35 + greeting * 0.55)],
            wristLeft: [effort * tap * 0.16, wave * 0.35, wave * 0.15],
            armRight: [-effort * 0.55 - sadness * 0.10, -effort * 0.45, 0.04 + effort * 0.28 + attention * 0.1],
            elbowRight: [-effort * 0.28, 0, 0.08 + effort * (0.38 - tap * 0.08) + sadness * 0.15],
            wristRight: [-effort * tap * 0.16, 0, 0],
            head: [effort * 0.09 + sadness * 0.10 - gaze.y * 0.12,
                   gaze.x * 0.25, headRoll + sin(elapsed * 0.8 + offset) * 0.018],
            hairLeft: sin(phase - 1.6) * (0.018 + speed * 0.025) + roll * 0.06,
            hairRight: sin(phase - 1.9) * (0.015 + speed * 0.025) + roll * 0.06,
            eyeLeft: eyelid(0) * (1 - tension * 0.30),
            eyeRight: eyelid(0.014) * (1 - tension * 0.30),
            pupil: [gaze.x * 0.006, gaze.y * 0.004],
            browLeft: -sadness * 0.18 + effort * 0.07 - attention * 0.09,
            browRight: sadness * 0.18 - effort * 0.07 + attention * 0.09,
            browLift: attention * 0.006 - effort * 0.002,
            mouthOpen: attention * 0.35,
            mouthCurve: greeting * 0.3 + celebration * 0.18 - sadness * 0.4)
    }

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
        let lookTarget: SIMD2<Float>
        if let peer = nearest, greeting > 0.12 {
            let direction = peer - position
            lookTarget = [max(-1, min(1, direction.x)), max(-0.5, min(0.5, direction.y))]
        } else {
            lookTarget = [velocity.x * 1.2 + sin(elapsed * 0.43 + offset) * 0.13,
                          -effort * 0.22 + attention * 0.12]
        }
        gaze += (lookTarget - gaze) * (1 - exp(-dt * 4))
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
