// GENERATED — DO NOT EDIT. Source: shared/src/daemon-parity.ts
// Regenerate: pnpm generate-daemon-parity; drift gate: daemon-parity.test.ts
import Foundation

enum DaemonParityRules {
    static let takeoverYieldMs = 147000
    static let kiroObservationWindowMs = 1800000
    static let defaultPortWindow = 9120...9139
    static func daemonPortWindow(_ raw: String?) -> ClosedRange<Int> {
        let whitespace = CharacterSet(charactersIn: String(String.UnicodeScalarView(
            [9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279].compactMap { UnicodeScalar($0) })))
        let text = (raw ?? "").trimmingCharacters(in: whitespace)
        let pieces = text.components(separatedBy: "-")
        guard pieces.count == 2 else { return defaultPortWindow }
        let values = pieces.map { $0.trimmingCharacters(in: whitespace) }
        guard values.allSatisfy({ (4...5).contains($0.utf8.count) && $0.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) }),
              let lo = Int(values[0]), let hi = Int(values[1]),
              lo >= 1024, hi <= 65535, lo <= hi else { return defaultPortWindow }
        return lo...hi
    }
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
