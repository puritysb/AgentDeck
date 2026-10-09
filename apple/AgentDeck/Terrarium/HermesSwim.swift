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
    // She mostly faces the viewer and leans into her travel. Following the
    // velocity up to +-66 deg turned her side-on and back on every lap of the
    // figure eight, with the tail swinging out horizontally: she read as
    // tumbling, not swimming (device review, 2026-10-02).
    var bodyYaw: Float { max(-0.55, min(0.55, atan2(velocity.x, 0.45 + abs(velocity.z)) * 0.8)) }
    /// One full turn when a task completes, eased so it starts and lands softly.
    var twirl: Float {
        guard celebration > 0 else { return 0 }
        let t = min(1, max(0, (1 - celebration) / 0.55))
        return 2 * .pi * t * t * (3 - 2 * t)
    }
    var yaw: Float { bodyYaw + twirl }
    var pitch: Float { max(-0.30, min(0.30, -velocity.z * 0.6 - velocity.y * 0.4)) }
    /// The concepts swim lying into the stroke: head leading, tail trailing.
    /// Upright travel read as a doll being dragged sideways.
    var roll: Float { max(-0.85, min(0.85, -velocity.x * 1.8)) }
    var arm: Float { attention * 1.4 + greeting * (0.55 + sin(phase) * 0.12) + celebration * 0.35 + effort * (0.18 + sin(phase) * 0.06) }

    var headRoll: Float { greeting * 0.10 - sadness * 0.15 - roll * 0.55
        + sin(elapsed * 0.9 + offset) * 0.05 * (1 - effort) * (1 - sadness) }
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
        /// Extra opening of the laptop lid beyond its modelled rest angle.
        var laptopLid: Float
        /// 0 = screen toward her, 1 = turned round to show the viewer (waiting).
        var laptopTurn: Float
        /// Amber alert screen visibility (waiting); pulses while shown.
        var laptopAlert: Float

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
        // a gentle flick: base+mid+tip bends summed to ~1.1 rad at speed and the
        // tail flopped out flat; now ~0.65 rad, with the follow-through at the tip
        let stroke = 0.08 + speed * 0.10 + effort * 0.03
        let tap = sin(elapsed * 3.5 + offset) * effort
        let wave = sin(elapsed * 4.5 + offset) * greeting
        let tension = sadness * 0.8 + effort * 0.25
        // small strokes only: her hands hold the laptop; quiet while she waits
        let paddle = sin(phase + 0.5) * (0.03 + speed * 0.03) * (1 - attention)
        return Pose(
            spine: [sin(phase - 0.15) * 0.025 + effort * 0.025 + sadness * 0.14, 0, -roll * 0.20],   // error: she slumps
            // at rest the tail curls forward under her (the concepts' J); it
            // straightens to trail behind as she picks up speed
            tailBase: [sin(phase) * stroke - 0.30 * (1 - speed), tailBank * 0.25, 0],
            tailMid: [sin(phase - 0.65) * stroke * 1.2, tailBank * 0.35, 0],
            tailTip: [sin(phase - 1.3) * stroke * 1.5, tailBank * 0.4, 0],
            fin: [sin(phase - 1.9) * stroke * 1.3, 0, 0],
            finLeft: [sin(phase - 2.1) * 0.09, -0.04 - speed * 0.09, -0.05 - effort * 0.08],
            finRight: [sin(phase - 2.25) * 0.09, 0.04 + speed * 0.09, 0.05 + effort * 0.08],
            // working keeps both hands on the laptop and types (wrist taps);
            // the big forward arm swing pulled them off it
            // hands stay on the laptop in every state (2026-10-02): a raised
            // arm went up behind the laptop and her hair and never showed, so
            // waiting is signalled by the laptop itself, and a greeting is a
            // small lift of the near hand with a wave of the wrist
            armLeft: [-effort * 0.12, greeting * 0.40 + effort * 0.10,
                      -(0.04 + greeting * 0.30 + effort * 0.06 + celebration * 0.14) + paddle],
            elbowLeft: [-effort * 0.10, 0, -(0.08 + effort * (0.10 + tap * 0.08) + greeting * 0.30)],
            wristLeft: [effort * tap * 0.16, wave * 0.35, wave * 0.15],
            armRight: [-effort * 0.12 - sadness * 0.10, -effort * 0.10, 0.04 + effort * 0.06 + paddle],
            elbowRight: [-effort * 0.10, 0, 0.08 + effort * (0.10 - tap * 0.08) + sadness * 0.15],
            wristRight: [-effort * tap * 0.16, 0, 0],
            // the head turns back toward the viewer by half the body's lean
            head: [effort * 0.09 + sadness * 0.28 - attention * 0.10 - gaze.y * 0.12,
                   gaze.x * 0.25 - bodyYaw * 0.45, headRoll + sin(elapsed * 0.8 + offset) * 0.018],
            hairLeft: sin(phase - 1.6) * (0.018 + speed * 0.025) + roll * 0.06,
            hairRight: sin(phase - 1.9) * (0.015 + speed * 0.025) + roll * 0.06,
            eyeLeft: eyelid(0) * (1 - tension * 0.30),
            eyeRight: eyelid(0.014) * (1 - tension * 0.30),
            pupil: [gaze.x * 0.006, gaze.y * 0.004],
            browLeft: -sadness * 0.18 + effort * 0.07 - attention * 0.09,
            browRight: sadness * 0.18 - effort * 0.07 + attention * 0.09,
            browLift: attention * 0.006 - effort * 0.002,
            mouthOpen: attention * 0.35,
            mouthCurve: greeting * 0.3 + celebration * 0.18 - sadness * 0.4,
            // error: the lid sags half shut; waiting: it opens a little wider
            laptopLid: effort * 0.15 + attention * 0.12 - sadness * 0.95 + sin(elapsed * 0.7 + offset) * 0.02,
            laptopTurn: attention,
            laptopAlert: attention > 0.5 ? 0.85 + 0.15 * sin(elapsed * 2.5) : 0)
    }

    mutating func step(_ delta: Float, home: SIMD3<Float>, size: Float,
                       activity: Activity, neighbours: [SIMD3<Float>], aspect: Float) {
        let dt = min(max(delta.isFinite ? delta : 0, 0), 0.05)
        guard dt > 0 else {
            // A paused clock must freeze motion, not a previous task's expression.
            if activity != previous {
                effort = activity == .working ? 1 : 0
                attention = activity == .waiting ? 1 : 0
                sadness = activity == .error ? 1 : 0
                celebration = 0
                previous = activity
            }
            return
        }
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
            sin(t * 1.37) * radius * 0.16 + sin(elapsed * 1.7 + offset) * size * 0.07   // a soft float
                + sin(elapsed * 3.4) * size * 0.05 * attention,                        // waiting: an eager bob
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
