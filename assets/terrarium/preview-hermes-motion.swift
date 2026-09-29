// Offline motion sample from the SAME controller used by the app.
// swiftc apple/AgentDeck/Terrarium/HermesSwim.swift assets/terrarium/preview-hermes-motion.swift -o /tmp/hermes-motion
import Foundation

@main struct MotionPreview {
    struct Frame: Codable {
        let frame: Int
        let position: [Float]
        let yaw: Float, pitch: Float, roll: Float, tail: Float, fin: Float, arm: Float, blink: Float, turn: Float
        let headRoll: Float, headPitch: Float, rightArm: Float, eyeWidth: Float, smileHeight: Float
    }
    static func main() throws {
        var swim = HermesSwim(id: "hermes-preview", position: [0,2.7,0])
        var frames: [Frame] = []
        for frame in 0..<180 {
            let seconds = Float(frame) / 12
            let activity: HermesSwim.Activity = seconds < 3 ? .idle : seconds < 7 ? .working
                : seconds < 9 ? .waiting : seconds < 12 ? .working : .idle
            // Integrate at 60 Hz, record 12 Hz.
            for _ in 0..<5 { swim.step(1/60, home: [0,2.7,0], size: 0.8, activity: activity,
                                       neighbours: [[1.1,2,0],[-1.2,2.8,0.1]], aspect: 1.6) }
            frames.append(Frame(frame: frame+1, position: [swim.position.x,swim.position.y,swim.position.z],
                yaw: swim.yaw, pitch: swim.pitch, roll: swim.roll, tail: swim.tail, fin: swim.fin,
                arm: swim.arm, blink: swim.eyeHeight, turn: swim.tailBank, headRoll: swim.headRoll, headPitch: swim.headPitch,
                rightArm: swim.rightArm, eyeWidth: swim.eyeWidth, smileHeight: swim.smileHeight))
        }
        try JSONEncoder().encode(frames).write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
    }
}
