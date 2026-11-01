// GENERATED FILE — DO NOT EDIT.
// Source: shared/src/device-controller.ts. Regenerate: node scripts/generate-device-controller-rules.mjs
// Drift gate: shared/src/__tests__/device-controller.test.ts
enum DeviceControllerRules {
    static let observedInputAgents = ["claude-code","opencode"]
    static let keyCanvas: Double = 144
    static let optionFont: Double = 22
    static let optionLines = 3
    static let questionFont: Double = 16
    static func compactCapabilities(_ row: [String: Any]) -> [String: Bool] {
        let alive = row["alive"] as? Bool == true
        let mode = row["controlMode"] as? String ?? ""
        let agent = row["agentType"] as? String ?? ""
        let managed = mode == "managed" || (mode != "observed" && (row["port"] as? Int ?? 0) > 0)
        let input = alive && row["controllerInput"] as? Bool != false && (managed || agent == "openclaw" || (mode == "observed" && observedInputAgents.contains(agent)))
        let request = row["requestId"] as? String ?? ""
        let question = row["question"] as? String ?? ""
        let choices = row["options"] as? [[String: Any]] ?? []
        let options = choices.count
        let labelsFit = choices.allSatisfy { ($0["label"] as? String).map { $0.utf8.count <= 63 } ?? false }
        let live = row["liveAnswerable"] as? Bool
        let held = !request.isEmpty && (!request.hasPrefix("ocperm:") || live == true)
        let awaiting = (row["state"] as? String ?? "").hasPrefix("awaiting_")
        let answer = alive && awaiting && (held || ((live ?? managed) && options > 0))
            && request.utf8.count <= 39 && question.utf8.count <= 159 && options <= 6 && labelsFit
        return ["controllerInput": input, "controllerAnswerable": answer]
    }
}
