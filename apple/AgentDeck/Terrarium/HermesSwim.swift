import Foundation
import simd

/// Cosmetic motion only. A neighbour is not evidence of delegation or teamwork.
/// Integrated in simulation time: roster order, frame rate and app suspension
/// must not restart a stroke or teleport a resident.
struct HermesSwim {
    enum Activity: String { case idle, working, waiting, error }
    var position: SIMD3<Float>
    /// Sequential shell lifecycle: open before emergence, settle before closing.
    private(set) var shellOpen: Float = 0
    private(set) var emergence: Float = 0
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
    private var previousActive = false
    private var clearingMouth = true
    private var frontLaneReached = false
    private var depthLaneReached = false
    private var returnDepthReached = false
    private var centerLaneReached = false
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

    /// A shared front approach clears the valve's rim before entering its basin.
    static func mouth(home: SIMD3<Float>, size: Float) -> SIMD3<Float> {
        [home.x, home.y + size * TerrariumRules.hermesHomeMouthLift,
         TerrariumRules.hermesHomeSharedZ + TerrariumRules.hermesHomeMouthFront]
    }
    var dockScale: Float {
        let p = emergence * emergence * (3 - 2 * emergence)
        return TerrariumRules.hermesHomeCompactScale + (1 - TerrariumRules.hermesHomeCompactScale) * p
    }

    private func eyelid(_ lag: Float) -> Float {
        let period = TerrariumRules.hermesHomeBlinkPeriod
        let time = elapsed + offset + lag
        let t = time.truncatingRemainder(dividingBy: period)
        func closure(_ t: Float) -> Float {
            guard t >= 0 && t < TerrariumRules.hermesHomeBlinkClose + TerrariumRules.hermesHomeBlinkHold + TerrariumRules.hermesHomeBlinkOpen else { return 1 }
            // Fast closure, slower opening; occasional double blink.
            if t < TerrariumRules.hermesHomeBlinkClose { return max(0,1-t/TerrariumRules.hermesHomeBlinkClose) }
            if t < TerrariumRules.hermesHomeBlinkClose + TerrariumRules.hermesHomeBlinkHold { return 0 }
            return min(1,(t-TerrariumRules.hermesHomeBlinkClose-TerrariumRules.hermesHomeBlinkHold)/TerrariumRules.hermesHomeBlinkOpen)
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
    var navigatingDoorway: Bool { emergence < 1 || clearingMouth || !depthLaneReached || !previousActive }
    var pitch: Float { navigatingDoorway ? 0 : max(-0.30, min(0.30, -velocity.z * 0.6 - velocity.y * 0.4)) }
    /// The concepts swim lying into the stroke: head leading, tail trailing.
    /// Upright travel read as a doll being dragged sideways.
    var roll: Float { navigatingDoorway ? 0 : max(-0.85, min(0.85, -velocity.x * 1.8)) }
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
            pupil: [gaze.x * 0.004, gaze.y * 0.003],
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
                       activity: Activity, neighbours: [SIMD3<Float>], aspect: Float, shellActive: Bool? = nil, berth: SIMD3<Float>? = nil, grounded: Bool = false, aperture: Float? = nil) {
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
            shellOpen = (shellActive ?? (activity == .working || activity == .waiting)) ? 1 : 0
            emergence = shellOpen
            previousActive = shellOpen > 0
            centerLaneReached = previousActive; depthLaneReached = previousActive
            clearingMouth = !previousActive; frontLaneReached = false; returnDepthReached = false
            if let berth { position = shellOpen > 0 ? berth + SIMD3(0,grounded ? 0 : size * TerrariumRules.hermesHomeSwimLift,0) : home; velocity = .zero }
            return
        }
        let active = shellActive ?? (activity == .working || activity == .waiting)
        if active != previousActive {
            // Reverse the leg already in progress. Restarting at the first
            // waypoint cuts diagonally through the shell on a short turn.
            if emergence == 1 {
                if active {
                    let wasAtCenter = centerLaneReached
                    clearingMouth = frontLaneReached
                    depthLaneReached = !returnDepthReached
                    centerLaneReached = !wasAtCenter
                } else {
                    returnDepthReached = !depthLaneReached
                    frontLaneReached = clearingMouth
                    centerLaneReached = !centerLaneReached
                }
            } else {
                clearingMouth = true; frontLaneReached = false
                depthLaneReached = false; returnDepthReached = false
                centerLaneReached = false
            }
            previousActive = active
        }
        let mouth = Self.mouth(home: home, size: size)
        let wasDocking = emergence < 1
        if active {
            shellOpen = min(1, shellOpen + dt * TerrariumRules.hermesHomeOpenRate)
            // The lid clears her head before the mermaid leaves the pearl basin.
            if min(shellOpen, aperture ?? 1) >= TerrariumRules.hermesHomeLidClearance { emergence = min(1, emergence + dt * TerrariumRules.hermesHomeEmergeRate) }
        } else if emergence < 1 || (simd_distance(position, mouth) < max(0.01, size * TerrariumRules.hermesHomeSettleDistance) && simd_length(velocity) < TerrariumRules.hermesHomeSettleSpeed) {
            if emergence == 0 || (aperture ?? 1) >= TerrariumRules.hermesHomeLidClearance {
                emergence = max(0, emergence - dt * TerrariumRules.hermesHomeEmergeRate)
            }
            if emergence == 0 { shellOpen = max(0, shellOpen - dt * TerrariumRules.hermesHomeCloseRate) }
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
        let t = elapsed * TerrariumRules.hermesHomeTravelRate + offset
        let resting = !active
        let radius = size * (TerrariumRules.hermesHomeSwimRadius + effort * TerrariumRules.hermesHomeWorkRadius) * (berth == nil ? 1 : TerrariumRules.hermesHomeBerthTravelScale) * (1 - attention * 0.85)
        var destination = (berth ?? home) + SIMD3<Float>(sin(t) * radius,
            size * TerrariumRules.hermesHomeSwimLift + sin(t * 1.37) * radius * 0.16 + sin(elapsed * 1.7 + offset) * size * 0.07   // above her shell
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
        if !resting, let peer = nearest, distance > 0.001, distance < size * 3 {
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
        for peer in neighbours where !resting {
            let difference = position - peer
            let d = simd_length(difference)
            let clearance = max(0.4, size * 1.15)
            if d > 0.001 && d < clearance {
                destination += difference / d * (clearance - d) * 0.8
            }
        }
        let halfWidth = min(3.65, max(0.9, aspect * 3.0)) - size * 0.35
        destination.x = max(-halfWidth, min(halfWidth, destination.x))
        if let berth, abs(berth.x) > 0.001 {
            let inward = min(halfWidth, max(0, abs(berth.x) - size * TerrariumRules.hermesHomeBerthInwardTravel))
            destination.x = berth.x < 0 ? min(-inward, destination.x) : max(inward, destination.x)
        }
        destination.y = max(home.y, min(4.65, destination.y))
        destination.z = max(berth.map { min(-1, $0.z - radius) } ?? -1, min(berth == nil ? 1.7 : TerrariumRules.hermesHomeFrontLimit, destination.z))
        if grounded {
            destination = (berth ?? home) + SIMD3(sin(t) * size * effort * TerrariumRules.nativeActivityGroundTravel, 0, 0)
        }
        // Idle is a planted resting pose, not an endless swimming loop. Gaze,
        // blinking and gentle articulation remain; neighbours cannot move the seat.
        let laneY = home.y + size * TerrariumRules.hermesHomeLaneLift
        let center = SIMD3<Float>(home.x, laneY, mouth.z)
        let corner = SIMD3<Float>((berth ?? home).x, laneY, mouth.z)
        let depthCorner = SIMD3<Float>(corner.x, laneY, (berth ?? home).z)
        func settled(_ waypoint: SIMD3<Float>) -> Bool {
            simd_distance(position, waypoint) < max(0.01, size * TerrariumRules.hermesHomeLaneDistance)
                && simd_length(velocity) < TerrariumRules.hermesHomeLaneSpeed
        }
        // Keep the depth leg below the occupied swimming berths. A diagonal
        // climb through another row's resident would cut across its body.
        if active {
            if !centerLaneReached {
                if settled(center) { centerLaneReached = true }
                destination = center
            } else if clearingMouth {
                if settled(corner) { clearingMouth = false }
                destination = corner
            } else if !depthLaneReached {
                if settled(depthCorner) { depthLaneReached = true }
                destination = depthCorner
            }
        } else {
            if !returnDepthReached {
                if settled(depthCorner) { returnDepthReached = true }
                destination = depthCorner
            } else if !frontLaneReached {
                if settled(corner) { frontLaneReached = true }
                destination = corner
            } else if !centerLaneReached {
                if settled(center) { centerLaneReached = true }
                destination = center
            } else { destination = mouth }
        }
        // Docking is a reversible path over the lip, not a damped fall through
        // the floor. Shrinking happens around the feet only once in the basin.
        if emergence < 1 || wasDocking {
            let p = emergence * emergence * (3 - 2 * emergence)
            let next = home + (mouth - home) * p
            velocity = (next - position) / dt
            position = next
            return
        }
        let desired = (destination - position) * 1.5
        velocity += (desired - velocity) * (1 - exp(-dt * 2.5))
        let speed = simd_length(velocity)
        let maximum = max(0.20, size * (0.50 + effort * 0.30))
        if speed > maximum { velocity *= maximum / speed }
        position += velocity * dt
        if resting && simd_distance(position, mouth) < 0.002 && simd_length(velocity) < 0.005 {
            position = mouth
            velocity = .zero
        }
    }
}

/// One entrance lease. Returning residents wait outside rather than crossing an emergence.
struct SharedShellTraffic {
    struct Request { var id:String;var wantsOut:Bool;var emergence:Float;var distance:Float }
    private(set) var owner:String?
    mutating func update(_ requests:[Request]) {
        func needs(_ r:Request)->Bool { r.wantsOut ? r.emergence < 1 || r.distance < TerrariumRules.hermesHomeMouthClearance : r.emergence > 0 }
        if !requests.contains(where:{$0.id==owner && needs($0)}) { owner=nil }
        if owner==nil { owner=requests.filter(needs).sorted { $0.wantsOut != $1.wantsOut ? !$0.wantsOut : $0.id < $1.id }.first?.id }
    }
    func active(_ id:String,wantsOut:Bool,emergence:Float)->Bool { wantsOut ? emergence > 0 || owner==id : emergence > 0 && owner != id }
}
