// GENERATED — DO NOT EDIT. Source: shared/src/daemon-parity.ts
// Regenerate: pnpm generate-daemon-parity; drift gate: daemon-parity.test.ts
import Foundation

enum DaemonParityRules {
    static let recoveryVersion = 1
    static let recoveryFile = "agentdeck-recovery.sqlite"
    static let recoveryFolderName = "AgentDeck Recovery"
    static let recoveryConsentFile = "recovery-consent.json"
    static let recoveryCursorFile = "daemon-recovery-cursor.json"
    static let recoveryBusyTimeoutMs = 250
    static let recoveryMaxRevision = 9007199254740991
    static let recoverySchema = "CREATE TABLE IF NOT EXISTS recovery_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL);"
    static let configurationHandoverHeader = "x-agentdeck-configuration"
    static let configurationMaxBodyBytes = 16384
    static let configurationMaxCounter = 9007199254740991
    static let configurationVersion = 1
    static let configurationSubscriptionId = "subscribe-configuration-v1"
    static let configurationMaxDevices = 16
    static let configurationMaxNameChars = 128
    static let configurationMaxIdBytes = 256
    static let configurationAnimations = ["single-frame","loop","tide"]
    static let checkpointVersion = 1
    static let checkpointSubscriptionId = "subscribe"
    static let checkpointMaxBytes = 262144
    static let receiptLimit = 1024
    static let checkpointAckMs = 1500
    static let checkpointPrepareLeaseMs = 10000
    static let checkpointMaxCounter = 9007199254740990
    static let receiptFields = ["cardId","sessionId","requestId","action","choiceId","decision","index","value","text","question"]
    static let receiptStatuses = ["applied","expired","unknown_card","rejected"]
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
