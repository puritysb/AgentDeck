// Protocol.swift — Bridge ↔ Client communication types
// Ported from shared/src/protocol.ts

import Foundation

// MARK: - Constants

enum BridgeConstants {
    static let wsPort = 9120
    static let httpPort = 9120
    static let reconnectIntervalMs = 3000
    static let stuckTimeoutMs = 5 * 60 * 1000
    static let wsPingIntervalMs = 15000
    static let wsActivityTimeoutMs = 30000
}

// MARK: - Enums

enum BillingType: String, Codable, Sendable {
    case subscription
    case api
    case unknown
}

// MARK: - Model / Session

struct ModelCatalogEntry: Codable, Sendable {
    let key: String
    let name: String
    let role: String  // "default" | "fallback-{n}" | "configured"
    let available: Bool

    init(key: String, name: String, role: String, available: Bool) {
        self.key = key
        self.name = name
        self.role = role
        self.available = available
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decodeIfPresent(String.self, forKey: .key) ?? ""
        name = try container.decode(String.self, forKey: .name)
        role = try container.decode(String.self, forKey: .role)
        available = try container.decode(Bool.self, forKey: .available)
    }
}

enum DashboardDataRules {
    // OpenClaw / Gateway visibility SSOT — hand-mirrored from
    // shared/src/session-utils.ts (isOpenClawSessionActive / hasOpenClawSession).
    // Keep all three (TS / Swift / Kotlin) in lockstep.
    //
    // "Active" = authenticated / can-route (gatewayConnected). Reachability and
    // health are topology hints only and MUST NOT materialize a session — that
    // is what kept a phantom OpenClaw alive on devices after it was off.
    static func isOpenClawSessionActive(gatewayConnected: Bool) -> Bool {
        gatewayConnected
    }

    static func hasOpenClawSession(_ sessions: [[String: Any]]) -> Bool {
        sessions.contains { ($0["agentType"] as? String) == "openclaw" }
    }

    static func hasOpenClawSession(_ sessions: [SessionInfo]) -> Bool {
        sessions.contains { $0.agentType == "openclaw" }
    }

    static func agentTypeRank(_ agentType: String?) -> Int {
        switch agentType {
        case "openclaw": 0
        case "claude-code": 1
        case "codex-cli": 2
        case "codex-app": 3
        case "opencode": 4
        default: 5
        }
    }

    static func stateRank(_ state: String?) -> Int {
        switch state {
        case "processing": return 0
        case "awaiting_permission", "awaiting_option", "awaiting_diff": return 1
        case "idle": return 2
        case "disconnected": return 3
        default: return 4
        }
    }

    static func naturalLabelCompare(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let standard = lhs.localizedStandardCompare(rhs)
        if standard != .orderedSame { return standard }
        return lhs.localizedCaseInsensitiveCompare(rhs)
    }

    static func sortSessions(_ sessions: [SessionInfo]) -> [SessionInfo] {
        sessions.sorted { lhs, rhs in
            let typeRank = agentTypeRank(lhs.agentType) - agentTypeRank(rhs.agentType)
            if typeRank != 0 { return typeRank < 0 }

            let projectCompare = naturalLabelCompare(lhs.projectName ?? "", rhs.projectName ?? "")
            if projectCompare != .orderedSame { return projectCompare == .orderedAscending }

            let startDiff = startedAtTime(lhs.startedAt) - startedAtTime(rhs.startedAt)
            if startDiff != 0 { return startDiff < 0 }

            return naturalLabelCompare(lhs.id, rhs.id) == .orderedAscending
        }
    }

    #if os(macOS)
    static func sortSessions(_ sessions: [DaemonSessionEntry]) -> [DaemonSessionEntry] {
        sessions.sorted { lhs, rhs in
            let typeRank = agentTypeRank(lhs.agentType) - agentTypeRank(rhs.agentType)
            if typeRank != 0 { return typeRank < 0 }

            let projectCompare = naturalLabelCompare(lhs.projectName, rhs.projectName)
            if projectCompare != .orderedSame { return projectCompare == .orderedAscending }

            let startDiff = startedAtTime(lhs.startedAt) - startedAtTime(rhs.startedAt)
            if startDiff != 0 { return startDiff < 0 }

            return naturalLabelCompare(lhs.id, rhs.id) == .orderedAscending
        }
    }
    #endif

    static func sortSessionPayloads(_ sessions: [[String: Any]]) -> [[String: Any]] {
        sessions.sorted { lhs, rhs in
            let lhsType = lhs["agentType"] as? String
            let rhsType = rhs["agentType"] as? String
            let typeRank = agentTypeRank(lhsType) - agentTypeRank(rhsType)
            if typeRank != 0 { return typeRank < 0 }

            let lhsProject = (lhs["projectName"] as? String) ?? ""
            let rhsProject = (rhs["projectName"] as? String) ?? ""
            let projectCompare = naturalLabelCompare(lhsProject, rhsProject)
            if projectCompare != .orderedSame { return projectCompare == .orderedAscending }

            let lhsStartedAt = lhs["startedAt"] as? String
            let rhsStartedAt = rhs["startedAt"] as? String
            let startDiff = startedAtTime(lhsStartedAt) - startedAtTime(rhsStartedAt)
            if startDiff != 0 { return startDiff < 0 }

            let lhsId = (lhs["id"] as? String) ?? ""
            let rhsId = (rhs["id"] as? String) ?? ""
            return naturalLabelCompare(lhsId, rhsId) == .orderedAscending
        }
    }

    static func foldCodexSessionPayloadsForDisplay(_ sessions: [[String: Any]]) -> [[String: Any]] {
        var passthrough: [[String: Any]] = []
        var codexByProject: [String: [[String: Any]]] = [:]
        var codexProjectOrder: [String] = []

        for session in sessions {
            guard isCodexPayload(session),
                  let project = nonEmptyString(session["projectName"]) else {
                passthrough.append(session)
                continue
            }

            let key = "\(codexDisplayKind(session))|\(project.lowercased())"
            if codexByProject[key] == nil { codexProjectOrder.append(key) }
            codexByProject[key, default: []].append(session)
        }

        for key in codexProjectOrder {
            guard let group = codexByProject[key], !group.isEmpty else { continue }
            passthrough.append(foldCodexProjectGroup(group))
        }

        return passthrough
    }

    static func sortedModelCatalog(_ entries: [ModelCatalogEntry]) -> [ModelCatalogEntry] {
        entries.sorted(by: compareModelEntries)
    }

    static func canonicalizeModelCatalog(_ rows: [[String: Any]]) -> [[String: Any]] {
        var byKey: [String: [String: Any]] = [:]
        for row in rows {
            guard let key = row["key"] as? String, !key.isEmpty else { continue }
            byKey[key] = row
        }
        return byKey.values.sorted(by: compareModelRows)
    }

    static func mergedModelCatalog(existing: [[String: Any]], incoming: [[String: Any]]) -> [[String: Any]] {
        var byKey: [String: [String: Any]] = [:]
        for row in existing {
            guard let key = row["key"] as? String, !key.isEmpty else { continue }
            byKey[key] = row
        }
        for row in incoming {
            guard let key = row["key"] as? String, !key.isEmpty else { continue }
            byKey[key] = row
        }
        return byKey.values.sorted(by: compareModelRows)
    }

    /// Subtitle shown under the OpenClaw row in the HUD upstream rail. We
    /// only surface the model the user has marked as primary in OpenClaw
    /// (`role == "default"`); fallback tiers and user-configured extras stay
    /// hidden so the row reads as "what OpenClaw is routing to right now"
    /// instead of dumping the entire catalog. If no model carries the
    /// default role the row collapses to empty — promoting a non-default
    /// entry would silently override the explicit "primary only" rule.
    static func openClawDisplayLines(_ modelCatalog: [ModelCatalogEntry]) -> [String] {
        let primary = sortedModelCatalog(modelCatalog).first { $0.available && $0.role == "default" }
        guard let primary else { return [] }
        return [normalizedModelName(primary.name)]
    }

    private static func compareModelEntries(_ lhs: ModelCatalogEntry, _ rhs: ModelCatalogEntry) -> Bool {
        compareModelFields(
            lhsRole: lhs.role,
            lhsName: lhs.name,
            lhsKey: lhs.key,
            lhsAvailable: lhs.available,
            rhsRole: rhs.role,
            rhsName: rhs.name,
            rhsKey: rhs.key,
            rhsAvailable: rhs.available
        )
    }

    private static func compareModelRows(_ lhs: [String: Any], _ rhs: [String: Any]) -> Bool {
        compareModelFields(
            lhsRole: lhs["role"] as? String ?? "configured",
            lhsName: lhs["name"] as? String ?? "",
            lhsKey: lhs["key"] as? String ?? "",
            lhsAvailable: lhs["available"] as? Bool ?? true,
            rhsRole: rhs["role"] as? String ?? "configured",
            rhsName: rhs["name"] as? String ?? "",
            rhsKey: rhs["key"] as? String ?? "",
            rhsAvailable: rhs["available"] as? Bool ?? true
        )
    }

    private static func compareModelFields(
        lhsRole: String,
        lhsName: String,
        lhsKey: String,
        lhsAvailable: Bool,
        rhsRole: String,
        rhsName: String,
        rhsKey: String,
        rhsAvailable: Bool
    ) -> Bool {
        let roleRankDiff = modelRoleRank(lhsRole) - modelRoleRank(rhsRole)
        if roleRankDiff != 0 { return roleRankDiff < 0 }

        if lhsAvailable != rhsAvailable { return lhsAvailable && !rhsAvailable }

        let nameCompare = normalizedModelName(lhsName).localizedCaseInsensitiveCompare(normalizedModelName(rhsName))
        if nameCompare != .orderedSame { return nameCompare == .orderedAscending }

        return lhsKey.localizedCaseInsensitiveCompare(rhsKey) == .orderedAscending
    }

    static func startedAtTime(_ startedAt: String?) -> TimeInterval {
        guard let startedAt,
              let date = ISO8601DateFormatter().date(from: startedAt) else {
            return .greatestFiniteMagnitude
        }
        return date.timeIntervalSince1970
    }

    private static func isCodexPayload(_ session: [String: Any]) -> Bool {
        let id = session["id"] as? String
        let agentType = session["agentType"] as? String
        return agentType == "codex-cli" || agentType == "codex-app" || id?.hasPrefix("codex:") == true
    }

    private static func codexDisplayKind(_ session: [String: Any]) -> String {
        (session["agentType"] as? String) == "codex-app" ? "codex-app" : "codex-cli"
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : string
    }

    private static func foldCodexProjectGroup(_ group: [[String: Any]]) -> [String: Any] {
        guard group.count > 1 else { return group[0] }

        let ranked = group.sorted { lhs, rhs in
            let rankDiff = stateRank(lhs["state"] as? String) - stateRank(rhs["state"] as? String)
            if rankDiff != 0 { return rankDiff < 0 }

            let lhsStarted = startedAtTime(lhs["startedAt"] as? String)
            let rhsStarted = startedAtTime(rhs["startedAt"] as? String)
            if lhsStarted != rhsStarted {
                if lhsStarted == .greatestFiniteMagnitude { return false }
                if rhsStarted == .greatestFiniteMagnitude { return true }
                return lhsStarted > rhsStarted
            }

            let lhsId = (lhs["id"] as? String) ?? ""
            let rhsId = (rhs["id"] as? String) ?? ""
            return lhsId.localizedCaseInsensitiveCompare(rhsId) == .orderedAscending
        }

        var folded = ranked[0]
        let memberIds = group.flatMap { session -> [String] in
            if let ids = session["foldedSessionIds"] as? [String] { return ids }
            if let id = session["id"] as? String { return [id] }
            return []
        }
        let groupSize = group.reduce(0) { total, session in
            total + ((session["groupSize"] as? Int) ?? 1)
        }

        folded["state"] = ranked.first?["state"] as? String
        if let tool = ranked.compactMap({ session -> String? in
            guard stateRank(session["state"] as? String) == 0 else { return nil }
            return nonEmptyString(session["currentTool"])
        }).first {
            folded["currentTool"] = tool
        } else {
            folded.removeValue(forKey: "currentTool")
        }
        folded["groupSize"] = groupSize
        folded["foldedSessionIds"] = memberIds
        return folded
    }

    private static func modelRoleRank(_ role: String) -> Int {
        if role == "default" { return 0 }
        if role.hasPrefix("fallback-"),
           let suffix = role.split(separator: "-").last,
           let number = Int(suffix) {
            return 100 + number
        }
        return 10_000
    }

    private static func normalizedModelName(_ name: String) -> String {
        name
            .replacingOccurrences(of: "DeepSeek: DeepSeek ", with: "DeepSeek ")
            .replacingOccurrences(of: "DeepSeek:", with: "DeepSeek")
            .replacingOccurrences(of: "GPT: GPT ", with: "GPT ")
            .replacingOccurrences(of: "GLM: GLM ", with: "GLM ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

}

struct OcSessionStatus: Codable, Sendable {
    var model: String?
    var contextTokens: Int?
    var messageCount: Int?
    var uptime: String?
    var sessionId: String?
}

// MARK: - Ollama

struct OllamaModel: Codable, Sendable {
    let name: String
    let size: Int
    let sizeVram: Int
    /// "chat" for generation models, "embed" for embedding models. Drives
    /// per-category grouping in the topology rail so embedding models
    /// (which never "sit loaded" in the generation sense — Ollama pulls
    /// them per-request and unloads via keep_alive) don't get surfaced
    /// as "not loaded" in UIs that only understand VRAM residency.
    /// Defaults to "chat" for backward compatibility with state_update
    /// events produced by pre-2026-04-21 daemons.
    var kind: String? = nil
}

struct OllamaStatus: Codable, Sendable {
    let available: Bool
    let models: [OllamaModel]
}

struct SubscriptionInfo: Codable, Sendable {
    let name: String
    var until: String?
}

struct AntigravityStatusInfo: Codable, Sendable {
    var planName: String?
    var availableCredits: Int?
    var minimumCreditAmountForUsage: Int?
}

// MARK: - Button / Encoder State (Bridge → Client)

struct ButtonSlotState: Codable, Sendable {
    let slot: Int
    let title: String
    var subtitle: String?
    let bgColor: String
    let textColor: String
    let enabled: Bool
    var icon: String?
    var badge: String?
    var action: String?
    var dim: Bool?
}

struct EncoderSlotState: Codable, Sendable {
    let slot: Int
    let encoderType: String  // utility | action | terminal | voice
    let header: String
    var value: String?
    var icon: String?
    let accentColor: String
    var progress: Double?
    var counter: String?
    var detail: String?
    var voiceState: String?  // idle | recording | transcribing | error | review
    var recordingMs: Int?
    var transcription: String?
}

struct DeckSlotConfig: Codable, Sendable {
    let slot: Int
    let actionType: String
    var settings: [String: AnyCodable]?
}

// MARK: - Session Info

struct SessionInfo: Codable, Sendable, Identifiable {
    let id: String
    let port: Int
    let projectName: String?
    var agentType: String?
    var alive: Bool = true
    var state: String?
    var modelName: String?
    var effortLevel: String?
    var startedAt: String?
    var currentTool: String?
    var groupSize: Int?
    var foldedSessionIds: [String]?
    /// Awaiting prompt question text (observed sessions: Notification message or
    /// "Allow {tool}: …?"; managed PTY: parsed header).
    var question: String?
    /// Present when a gated PreToolUse permission is pending device approval —
    /// the HUD renders Allow/Deny and replies with `permissionDecision(requestId:)`.
    var requestId: String?
}

// MARK: - Bridge Events (Bridge → Client)

struct StateUpdateEvent: Codable, Sendable {
    let type: String  // "state_update"
    let state: String

    // CodingKeys excludes moduleHealth (parsed manually from raw JSON)
    private enum CodingKeys: String, CodingKey {
        case type, state, permissionMode, agentType, sessionId, focusedSessionId, agentCapabilities
        case currentTool, toolInput, toolProgress, projectName, modelName, effortLevel
        case billingType, options, promptType, question, navigable, cursorIndex
        case suggestedPrompt, modelCatalog, sessionStatus, remoteUrl, pairingUrl
        case workerSessionCount, ollamaStatus, mlxModels, subscriptions
        case codexAuthMode, codexWebAuthConnected, codexPlanType
        case codexAccountId, codexSubscriptionActiveUntil, codexLastRefreshAt
        case antigravityStatus, gatewayAvailable, gatewayConnected, gatewayHasError
        case gatewayAuthStatus, gatewayAuthRequestId, gatewayAuthMessage, gatewayDeviceId
        case daemonPort, mlxModelCatalog
        case voiceAssistantState, voiceAssistantText, voiceAssistantResponseText
    }
    var permissionMode: String?
    var agentType: String?
    /// Session ID associated with this state payload. In daemon mode this is
    /// the latest hook-attributed session, not necessarily the user's focus.
    var sessionId: String?
    /// Session explicitly focused by the user. Daemons keep this separate from
    /// `sessionId` so active sessions can change without moving selection UI.
    var focusedSessionId: String?
    var agentCapabilities: AgentCapabilities?
    var currentTool: String?
    var toolInput: String?
    var toolProgress: String?
    var projectName: String?
    var modelName: String?
    var effortLevel: String?
    var billingType: String?
    var options: [PromptOption]?
    var promptType: String?
    var question: String?
    var navigable: Bool?
    var cursorIndex: Int?
    var suggestedPrompt: String?
    var modelCatalog: [ModelCatalogEntry]?
    var sessionStatus: OcSessionStatus?
    var remoteUrl: String?
    var pairingUrl: String?
    var workerSessionCount: Int?
    var ollamaStatus: OllamaStatus?
    var mlxModels: [String]?
    var subscriptions: [SubscriptionInfo]?
    var codexAuthMode: String?
    var codexWebAuthConnected: Bool?
    var codexPlanType: String?
    var codexAccountId: String?
    var codexSubscriptionActiveUntil: String?
    var codexLastRefreshAt: String?
    var antigravityStatus: AntigravityStatusInfo?
    var gatewayAvailable: Bool?
    var gatewayConnected: Bool?
    var gatewayHasError: Bool?
    var gatewayAuthStatus: String?
    var gatewayAuthRequestId: String?
    var gatewayAuthMessage: String?
    var gatewayDeviceId: String?
    var daemonPort: Int?
    var mlxModelCatalog: [String]?
    var voiceAssistantState: String?  // idle | listening | processing | speaking | disabled
    var voiceAssistantText: String?
    var voiceAssistantResponseText: String?

    // Module health — parsed manually from raw JSON (not Codable)
    var moduleHealth: ModuleHealthState?
}

struct UsageEvent: Codable, Sendable {
    let type: String  // "usage_update"
    var sessionDurationSec: Int?
    var inputTokens: Int?
    var outputTokens: Int?
    var toolCalls: Int?
    var estimatedCostUsd: Double?
    var sessionPercent: Double?
    var costSpent: Double?
    var costLimit: Double?
    var resetTime: String?
    var resetDate: String?
    var fiveHourPercent: Double?
    var fiveHourResetsAt: String?
    var sevenDayPercent: Double?
    var sevenDayResetsAt: String?
    var extraUsageEnabled: Bool?
    var extraUsageMonthlyLimit: Double?
    var extraUsageUsedCredits: Double?
    var extraUsageUtilization: Double?
    var oauthConnected: Bool?
    var ollamaStatus: OllamaStatus?
    var usageStale: Bool?
    var tokenStatus: String?  // "valid" | "expired" | "missing" | "unknown"
    var codexAuthMode: String?
    var codexWebAuthConnected: Bool?
    var codexPlanType: String?
    var codexAccountId: String?
    var codexSubscriptionActiveUntil: String?
    var codexLastRefreshAt: String?
    var modelCatalog: [ModelCatalogEntry]?
    var mlxModels: [String]?
    var mlxModelCatalog: [String]?
    var subscriptions: [SubscriptionInfo]?
    var antigravityStatus: AntigravityStatusInfo?

    // Anthropic Admin API usage (when user has pasted a Console Admin
    // API key in Settings). Independent from Pro/Max subscription
    // quota above — these fields are for API spend tracking.
    var adminApiKeyPresent: Bool?
    var adminApiTodayInputTokens: Int?
    var adminApiTodayOutputTokens: Int?
    var adminApiTodayCacheReadTokens: Int?
    var adminApiTodayCacheCreationTokens: Int?
    var adminApiMonthInputTokens: Int?
    var adminApiMonthOutputTokens: Int?
    var adminApiMonthCacheReadTokens: Int?
    var adminApiMonthCacheCreationTokens: Int?
    var adminApiTopModels: [AdminApiModelUsage]?
    var adminApiFetchedAt: Double?
    var adminApiStale: Bool?
}

struct ConnectionEvent: Codable, Sendable {
    let type: String  // "connection"
    let status: String  // connected | reconnecting | disconnected
    var sessionId: String?
}

struct VoiceStateEvent: Codable, Sendable {
    let type: String  // "voice_state"
    let state: String  // idle | recording | transcribing | error
    var text: String?
    var error: String?
}

struct DisplayDimInstruction: Codable, Sendable {
    let enabled: Bool
    let mode: String   // "off" | "min"
    let level: Int     // 1-100 percent
}

struct DisplayStateEvent: Codable, Sendable {
    let type: String  // "display_state"
    let displayOn: Bool
    /// How to dim on sleep. Absent ⇒ legacy full-off (see DisplayDimInstruction).
    var dim: DisplayDimInstruction?
}

struct SessionsListEvent: Codable, Sendable {
    let type: String  // "sessions_list"
    let sessions: [SessionInfo]
}

struct PromptOptionsEvent: Codable, Sendable {
    let type: String  // "prompt_options"
    let promptType: String
    var question: String?
    let options: [PromptOption]
}

struct ButtonStateEvent: Codable, Sendable {
    let type: String  // "button_state"
    let buttons: [ButtonSlotState]
}

struct EncoderStateEvent: Codable, Sendable {
    let type: String  // "encoder_state"
    let encoders: [EncoderSlotState]
    var takeoverActive: Bool?
}

struct DeckSlotMapEvent: Codable, Sendable {
    let type: String  // "deck_slot_map"
    var buttons: [DeckSlotConfig]?
    var encoders: [DeckSlotConfig]?
}

struct UserPromptEvent: Codable, Sendable {
    let type: String  // "user_prompt"
    let text: String
}

// MARK: - Timeline Events

struct TimelineEventMsg: Codable, Sendable {
    let type: String  // "timeline_event"
    let entry: TimelineEntry
    var upsert: Bool?
}

struct TimelineHistoryMsg: Codable, Sendable {
    let type: String  // "timeline_history"
    let entries: [TimelineEntry]
}

// MARK: - Bridge Event Union

enum BridgeEvent: Sendable {
    case stateUpdate(StateUpdateEvent)
    case usageUpdate(UsageEvent)
    case connection(ConnectionEvent)
    case voiceState(VoiceStateEvent)
    case displayState(DisplayStateEvent)
    case sessionsList(SessionsListEvent)
    case promptOptions(PromptOptionsEvent)
    case buttonState(ButtonStateEvent)
    case encoderState(EncoderStateEvent)
    case deckSlotMap(DeckSlotMapEvent)
    case userPrompt(UserPromptEvent)
    case timelineEvent(TimelineEventMsg)
    case timelineHistory(TimelineHistoryMsg)
}

// MARK: - Plugin Commands (Client → Bridge)

enum PluginCommand: Encodable, Sendable {
    case respond(value: String)
    case selectOption(index: Int)
    case navigateOption(direction: String)
    case sendPrompt(text: String)
    case switchMode(mode: String?)
    case interrupt
    case escape
    case voice(action: String)
    case queryUsage
    case diag(action: String)
    case utility(action: String, value: Int?)
    case focusSession(sessionId: String)
    case clearSessionFocus
    case permissionDecision(requestId: String, decision: String)

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicCodingKey.self)
        switch self {
        case .respond(let value):
            try container.encode("respond", forKey: .init("type"))
            try container.encode(value, forKey: .init("value"))
        case .selectOption(let index):
            try container.encode("select_option", forKey: .init("type"))
            try container.encode(index, forKey: .init("index"))
        case .navigateOption(let direction):
            try container.encode("navigate_option", forKey: .init("type"))
            try container.encode(direction, forKey: .init("direction"))
        case .sendPrompt(let text):
            try container.encode("send_prompt", forKey: .init("type"))
            try container.encode(text, forKey: .init("text"))
        case .switchMode(let mode):
            try container.encode("switch_mode", forKey: .init("type"))
            if let mode { try container.encode(mode, forKey: .init("mode")) }
        case .interrupt:
            try container.encode("interrupt", forKey: .init("type"))
        case .escape:
            try container.encode("escape", forKey: .init("type"))
        case .voice(let action):
            try container.encode("voice", forKey: .init("type"))
            try container.encode(action, forKey: .init("action"))
        case .queryUsage:
            try container.encode("query_usage", forKey: .init("type"))
        case .diag(let action):
            try container.encode("diag", forKey: .init("type"))
            try container.encode(action, forKey: .init("action"))
        case .utility(let action, let value):
            try container.encode("utility", forKey: .init("type"))
            try container.encode(action, forKey: .init("action"))
            if let value { try container.encode(value, forKey: .init("value")) }
        case .focusSession(let sessionId):
            try container.encode("focus_session", forKey: .init("type"))
            try container.encode(sessionId, forKey: .init("sessionId"))
        case .clearSessionFocus:
            try container.encode("clear_session_focus", forKey: .init("type"))
        case .permissionDecision(let requestId, let decision):
            try container.encode("permission_decision", forKey: .init("type"))
            try container.encode(requestId, forKey: .init("requestId"))
            try container.encode(decision, forKey: .init("decision"))
        }
    }
}

// MARK: - Helpers

struct DynamicCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init(_ string: String) { self.stringValue = string; self.intValue = nil }
    init?(stringValue: String) { self.stringValue = stringValue; self.intValue = nil }
    init?(intValue: Int) { self.stringValue = "\(intValue)"; self.intValue = intValue }
}

/// Type-erased Codable wrapper for heterogeneous dictionaries
struct AnyCodable: Codable, @unchecked Sendable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let b = try? container.decode(Bool.self) { value = b }
        else if let i = try? container.decode(Int.self) { value = i }
        else if let d = try? container.decode(Double.self) { value = d }
        else if let s = try? container.decode(String.self) { value = s }
        else if let a = try? container.decode([AnyCodable].self) { value = a.map(\.value) }
        else if let o = try? container.decode([String: AnyCodable].self) { value = o.mapValues(\.value) }
        else { value = NSNull() }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let b as Bool: try container.encode(b)
        case let i as Int: try container.encode(i)
        case let d as Double: try container.encode(d)
        case let s as String: try container.encode(s)
        default: try container.encodeNil()
        }
    }
}
