// Offline motion samples from the SAME controller used by the native app.
// swiftc apple/AgentDeck/Terrarium/HermesSwim.swift assets/terrarium/preview-hermes-motion.swift -o /tmp/hermes-motion
import Foundation

@main struct MotionPreview {
    struct Frame: Codable {
        let frame: Int
        let activity: String
        let position: [Float]
        let yaw: Float, pitch: Float, roll: Float
        let pose: HermesSwim.Pose
    }
    static func main() throws {
        var swim = HermesSwim(id: "hermes-preview", position: [0,2.7,0])
        var frames: [Frame] = []
        for frame in 0..<396 {
            let seconds = Float(frame) / 12
            let activity: HermesSwim.Activity = seconds < 4 ? .idle : seconds < 10 ? .working
                : seconds < 14 ? .waiting : seconds < 20 ? .idle : seconds < 23 ? .error
                : seconds < 26 ? .idle : seconds < 29 ? .working : .idle
            for _ in 0..<5 { swim.step(1/60, home: [0,2.7,0], size: 0.8, activity: activity,
                                       neighbours: [[0.85,2.7,0.1],[-1.2,2.8,0.1]], aspect: 1.6) }
            frames.append(Frame(frame: frame+1, activity: activity.rawValue,
                position: [swim.position.x,swim.position.y,swim.position.z],
                yaw: swim.yaw, pitch: swim.pitch, roll: swim.roll, pose: swim.pose))
        }
        try JSONEncoder().encode(frames).write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
    }
}
