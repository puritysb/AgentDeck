// GENERATED — DO NOT EDIT. Source: shared/src/daemon-parity.ts
// Regenerate: pnpm generate-daemon-parity; drift gate: daemon-parity.test.ts
import Foundation

enum DaemonParityRules {
    static let takeoverYieldMs = 147000
    static let kiroObservationWindowMs = 1800000
    static func kiroLegacyTurnState(_ state: String, event: String, hasToolUse: Bool) -> String {
        if event == "AssistantMessage" { return hasToolUse ? "processing" : "idle" }
        switch event {
        case "Prompt": return "processing"
        case "ToolResult": return "processing"
        case "ToolResults": return "processing"
        case "TurnEnd": return "idle"
        default: return state
        }
    }
    static func acceptsDaemonRuntime(isSwift: Bool?, expectingNode: Bool) -> Bool {
        !expectingNode || isSwift != true
    }
    static func kiroTurnState(_ state: String, event: String) -> String {
        switch event {
        case "turn_start": return "processing"
        case "turn_end": return "idle"
        default: return state
        }
    }
}
