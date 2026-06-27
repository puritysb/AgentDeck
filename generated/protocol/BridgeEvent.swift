// This file was generated from JSON Schema using quicktype, do not modify it directly.
// To parse the JSON, add this file to your project and do:
//
//   let aDBridgeEvent = try ADBridgeEvent(json)

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

import Foundation

/// Bridge → clients — fires when a run completes evaluation (layer 1 or 2).
///
/// Bridge → clients — scorecard refresh (broadcast after eval completes or on demand).
///
/// Bridge → clients — model recommendation for the next task (on-demand / context-aware).
// MARK: - ADBridgeEvent
struct ADBridgeEvent: Codable, Equatable {
    var agentCapabilities: ADAgentCapabilities?
    var agentType: ADAgentType?
    /// Local Antigravity IDE quota summary, when available
    var antigravityStatus: ADAntigravityStatusInfo?
    var billingType: ADBillingType?
    var currentTool: String?
    var cursorIndex: Double?
    var effortLevel: String?
    /// Session explicitly focused by the user; visual selection should use this.
    var focusedSessionId: String?
    /// Human-readable OpenClaw auth/pairing diagnostic
    var gatewayAuthMessage: String?
    /// OpenClaw device pairing request id, when Gateway requires approval
    var gatewayAuthRequestId: String?
    /// OpenClaw Gateway auth/pairing state
    var gatewayAuthStatus: ADGatewayAuthStatus?
    /// OpenClaw Gateway reachability (port 18789)
    var gatewayAvailable: Bool?
    /// OpenClaw Gateway authenticated adapter connection
    var gatewayConnected: Bool?
    /// OpenClaw Gateway has doctor warnings/errors
    var gatewayHasError: Bool?
    /// MLX local server model list
    var mlxModels: [String]?
    var modelCatalog: [ADModelCatalogEntry]?
    var modelName: String?
    /// Daemon-owned hardware/module health, intentionally loose for cross-version clients
    var moduleHealth: [String: JSONAny]?
    var navigable: Bool?
    /// Ollama process status + running models
    var ollamaStatus: ADOllamaStatus?
    var options: [ADPromptOption]?
    /// Authenticated WS URL for remote pairing (ws://ip:port?token=hex)
    var pairingUrl: String?
    var permissionMode: ADPermissionMode?
    var projectName: String?
    var promptType: ADPromptType?
    var question: String?
    var remoteUrl: String?
    /// Set when the focused session has a gated PreToolUse permission pending device approval —
    /// clients reply with `permission_decision { requestId }` instead of `select_option`. See
    /// bridge/src/permission-resolver.ts.
    var requestId: String?
    /// Session ID associated with this state payload; may move with hook activity.
    var sessionId: String?
    var sessionStatus: ADOcSessionStatus?
    var state: ADState?
    /// Subscription-backed authenticated services
    var subscriptions: [ADSubscriptionInfo]?
    var suggestedPrompt: String?
    var toolInput: String?
    var toolProgress: String?
    var type: ADType
    /// LLM response text (speaking)
    var voiceAssistantResponseText: String?
    /// Voice assistant pipeline state (wake word → STT → LLM → TTS)
    var voiceAssistantState: ADVoiceAssistantState?
    /// Transcribed user speech (processing/speaking)
    var voiceAssistantText: String?
    /// Number of OpenClaw backend worker sessions (multi-agent)
    var workerSessionCount: Double?
    var codexAccountId: String?
    var codexAuthMode: String?
    var codexLastRefreshAt: String?
    var codexPlanType: String?
    var codexSubscriptionActiveUntil: String?
    var codexWebAuthConnected: Bool?
    var costLimit: Double?
    var costSpent: Double?
    var estimatedCostUsd: Double?
    var extraUsageEnabled: Bool?
    var extraUsageMonthlyLimit: Double?
    var extraUsageUsedCredits: Double?
    var extraUsageUtilization: Double?
    var fiveHourPercent: Double?
    var fiveHourResetsAt: String?
    var inputTokens: Double?
    var oauthConnected: Bool?
    var outputTokens: Double?
    var resetDate: String?
    var resetTime: String?
    var sessionDurationSec: Double?
    var sessionPercent: Double?
    var sevenDayPercent: Double?
    var sevenDayResetsAt: String?
    var tokenStatus: ADTokenStatus?
    var toolCalls: Double?
    var usageStale: Bool?
    var status: ADBridgeEventStatus?
    /// Transcribed user speech
    var text: String?
    var error: String?
    var deviceId: String?
    /// LLM response text
    var responseText: String?
    var timestamp: Double?
    /// How to dim on sleep. Absent ⇒ legacy full-off.
    var dim: ADDisplayDimInstruction?
    var displayOn: Bool?
    var sessions: [ADSessionInfo]?
    var encoders: [ADEncoderSlotState]?
    var takeoverActive: Bool?
    var buttons: [ADDeckSlotConfig]?
    var entry: ADTimelineEntry?
    var upsert: Bool?
    var entries: [ADTimelineEntry]?
    var run: ADApmeRunSummary?
    var scorecards: [ADApmeModelScorecard]?
    var candidates: [ADApmeRecommendation]?
    var taskKind: String?

    enum CodingKeys: String, CodingKey {
        case agentCapabilities = "agentCapabilities"
        case agentType = "agentType"
        case antigravityStatus = "antigravityStatus"
        case billingType = "billingType"
        case currentTool = "currentTool"
        case cursorIndex = "cursorIndex"
        case effortLevel = "effortLevel"
        case focusedSessionId = "focusedSessionId"
        case gatewayAuthMessage = "gatewayAuthMessage"
        case gatewayAuthRequestId = "gatewayAuthRequestId"
        case gatewayAuthStatus = "gatewayAuthStatus"
        case gatewayAvailable = "gatewayAvailable"
        case gatewayConnected = "gatewayConnected"
        case gatewayHasError = "gatewayHasError"
        case mlxModels = "mlxModels"
        case modelCatalog = "modelCatalog"
        case modelName = "modelName"
        case moduleHealth = "moduleHealth"
        case navigable = "navigable"
        case ollamaStatus = "ollamaStatus"
        case options = "options"
        case pairingUrl = "pairingUrl"
        case permissionMode = "permissionMode"
        case projectName = "projectName"
        case promptType = "promptType"
        case question = "question"
        case remoteUrl = "remoteUrl"
        case requestId = "requestId"
        case sessionId = "sessionId"
        case sessionStatus = "sessionStatus"
        case state = "state"
        case subscriptions = "subscriptions"
        case suggestedPrompt = "suggestedPrompt"
        case toolInput = "toolInput"
        case toolProgress = "toolProgress"
        case type = "type"
        case voiceAssistantResponseText = "voiceAssistantResponseText"
        case voiceAssistantState = "voiceAssistantState"
        case voiceAssistantText = "voiceAssistantText"
        case workerSessionCount = "workerSessionCount"
        case codexAccountId = "codexAccountId"
        case codexAuthMode = "codexAuthMode"
        case codexLastRefreshAt = "codexLastRefreshAt"
        case codexPlanType = "codexPlanType"
        case codexSubscriptionActiveUntil = "codexSubscriptionActiveUntil"
        case codexWebAuthConnected = "codexWebAuthConnected"
        case costLimit = "costLimit"
        case costSpent = "costSpent"
        case estimatedCostUsd = "estimatedCostUsd"
        case extraUsageEnabled = "extraUsageEnabled"
        case extraUsageMonthlyLimit = "extraUsageMonthlyLimit"
        case extraUsageUsedCredits = "extraUsageUsedCredits"
        case extraUsageUtilization = "extraUsageUtilization"
        case fiveHourPercent = "fiveHourPercent"
        case fiveHourResetsAt = "fiveHourResetsAt"
        case inputTokens = "inputTokens"
        case oauthConnected = "oauthConnected"
        case outputTokens = "outputTokens"
        case resetDate = "resetDate"
        case resetTime = "resetTime"
        case sessionDurationSec = "sessionDurationSec"
        case sessionPercent = "sessionPercent"
        case sevenDayPercent = "sevenDayPercent"
        case sevenDayResetsAt = "sevenDayResetsAt"
        case tokenStatus = "tokenStatus"
        case toolCalls = "toolCalls"
        case usageStale = "usageStale"
        case status = "status"
        case text = "text"
        case error = "error"
        case deviceId = "deviceId"
        case responseText = "responseText"
        case timestamp = "timestamp"
        case dim = "dim"
        case displayOn = "displayOn"
        case sessions = "sessions"
        case encoders = "encoders"
        case takeoverActive = "takeoverActive"
        case buttons = "buttons"
        case entry = "entry"
        case upsert = "upsert"
        case entries = "entries"
        case run = "run"
        case scorecards = "scorecards"
        case candidates = "candidates"
        case taskKind = "taskKind"
    }
}

// MARK: ADBridgeEvent convenience initializers and mutators

extension ADBridgeEvent {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADBridgeEvent.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        agentCapabilities: ADAgentCapabilities?? = nil,
        agentType: ADAgentType?? = nil,
        antigravityStatus: ADAntigravityStatusInfo?? = nil,
        billingType: ADBillingType?? = nil,
        currentTool: String?? = nil,
        cursorIndex: Double?? = nil,
        effortLevel: String?? = nil,
        focusedSessionId: String?? = nil,
        gatewayAuthMessage: String?? = nil,
        gatewayAuthRequestId: String?? = nil,
        gatewayAuthStatus: ADGatewayAuthStatus?? = nil,
        gatewayAvailable: Bool?? = nil,
        gatewayConnected: Bool?? = nil,
        gatewayHasError: Bool?? = nil,
        mlxModels: [String]?? = nil,
        modelCatalog: [ADModelCatalogEntry]?? = nil,
        modelName: String?? = nil,
        moduleHealth: [String: JSONAny]?? = nil,
        navigable: Bool?? = nil,
        ollamaStatus: ADOllamaStatus?? = nil,
        options: [ADPromptOption]?? = nil,
        pairingUrl: String?? = nil,
        permissionMode: ADPermissionMode?? = nil,
        projectName: String?? = nil,
        promptType: ADPromptType?? = nil,
        question: String?? = nil,
        remoteUrl: String?? = nil,
        requestId: String?? = nil,
        sessionId: String?? = nil,
        sessionStatus: ADOcSessionStatus?? = nil,
        state: ADState?? = nil,
        subscriptions: [ADSubscriptionInfo]?? = nil,
        suggestedPrompt: String?? = nil,
        toolInput: String?? = nil,
        toolProgress: String?? = nil,
        type: ADType? = nil,
        voiceAssistantResponseText: String?? = nil,
        voiceAssistantState: ADVoiceAssistantState?? = nil,
        voiceAssistantText: String?? = nil,
        workerSessionCount: Double?? = nil,
        codexAccountId: String?? = nil,
        codexAuthMode: String?? = nil,
        codexLastRefreshAt: String?? = nil,
        codexPlanType: String?? = nil,
        codexSubscriptionActiveUntil: String?? = nil,
        codexWebAuthConnected: Bool?? = nil,
        costLimit: Double?? = nil,
        costSpent: Double?? = nil,
        estimatedCostUsd: Double?? = nil,
        extraUsageEnabled: Bool?? = nil,
        extraUsageMonthlyLimit: Double?? = nil,
        extraUsageUsedCredits: Double?? = nil,
        extraUsageUtilization: Double?? = nil,
        fiveHourPercent: Double?? = nil,
        fiveHourResetsAt: String?? = nil,
        inputTokens: Double?? = nil,
        oauthConnected: Bool?? = nil,
        outputTokens: Double?? = nil,
        resetDate: String?? = nil,
        resetTime: String?? = nil,
        sessionDurationSec: Double?? = nil,
        sessionPercent: Double?? = nil,
        sevenDayPercent: Double?? = nil,
        sevenDayResetsAt: String?? = nil,
        tokenStatus: ADTokenStatus?? = nil,
        toolCalls: Double?? = nil,
        usageStale: Bool?? = nil,
        status: ADBridgeEventStatus?? = nil,
        text: String?? = nil,
        error: String?? = nil,
        deviceId: String?? = nil,
        responseText: String?? = nil,
        timestamp: Double?? = nil,
        dim: ADDisplayDimInstruction?? = nil,
        displayOn: Bool?? = nil,
        sessions: [ADSessionInfo]?? = nil,
        encoders: [ADEncoderSlotState]?? = nil,
        takeoverActive: Bool?? = nil,
        buttons: [ADDeckSlotConfig]?? = nil,
        entry: ADTimelineEntry?? = nil,
        upsert: Bool?? = nil,
        entries: [ADTimelineEntry]?? = nil,
        run: ADApmeRunSummary?? = nil,
        scorecards: [ADApmeModelScorecard]?? = nil,
        candidates: [ADApmeRecommendation]?? = nil,
        taskKind: String?? = nil
    ) -> ADBridgeEvent {
        return ADBridgeEvent(
            agentCapabilities: agentCapabilities ?? self.agentCapabilities,
            agentType: agentType ?? self.agentType,
            antigravityStatus: antigravityStatus ?? self.antigravityStatus,
            billingType: billingType ?? self.billingType,
            currentTool: currentTool ?? self.currentTool,
            cursorIndex: cursorIndex ?? self.cursorIndex,
            effortLevel: effortLevel ?? self.effortLevel,
            focusedSessionId: focusedSessionId ?? self.focusedSessionId,
            gatewayAuthMessage: gatewayAuthMessage ?? self.gatewayAuthMessage,
            gatewayAuthRequestId: gatewayAuthRequestId ?? self.gatewayAuthRequestId,
            gatewayAuthStatus: gatewayAuthStatus ?? self.gatewayAuthStatus,
            gatewayAvailable: gatewayAvailable ?? self.gatewayAvailable,
            gatewayConnected: gatewayConnected ?? self.gatewayConnected,
            gatewayHasError: gatewayHasError ?? self.gatewayHasError,
            mlxModels: mlxModels ?? self.mlxModels,
            modelCatalog: modelCatalog ?? self.modelCatalog,
            modelName: modelName ?? self.modelName,
            moduleHealth: moduleHealth ?? self.moduleHealth,
            navigable: navigable ?? self.navigable,
            ollamaStatus: ollamaStatus ?? self.ollamaStatus,
            options: options ?? self.options,
            pairingUrl: pairingUrl ?? self.pairingUrl,
            permissionMode: permissionMode ?? self.permissionMode,
            projectName: projectName ?? self.projectName,
            promptType: promptType ?? self.promptType,
            question: question ?? self.question,
            remoteUrl: remoteUrl ?? self.remoteUrl,
            requestId: requestId ?? self.requestId,
            sessionId: sessionId ?? self.sessionId,
            sessionStatus: sessionStatus ?? self.sessionStatus,
            state: state ?? self.state,
            subscriptions: subscriptions ?? self.subscriptions,
            suggestedPrompt: suggestedPrompt ?? self.suggestedPrompt,
            toolInput: toolInput ?? self.toolInput,
            toolProgress: toolProgress ?? self.toolProgress,
            type: type ?? self.type,
            voiceAssistantResponseText: voiceAssistantResponseText ?? self.voiceAssistantResponseText,
            voiceAssistantState: voiceAssistantState ?? self.voiceAssistantState,
            voiceAssistantText: voiceAssistantText ?? self.voiceAssistantText,
            workerSessionCount: workerSessionCount ?? self.workerSessionCount,
            codexAccountId: codexAccountId ?? self.codexAccountId,
            codexAuthMode: codexAuthMode ?? self.codexAuthMode,
            codexLastRefreshAt: codexLastRefreshAt ?? self.codexLastRefreshAt,
            codexPlanType: codexPlanType ?? self.codexPlanType,
            codexSubscriptionActiveUntil: codexSubscriptionActiveUntil ?? self.codexSubscriptionActiveUntil,
            codexWebAuthConnected: codexWebAuthConnected ?? self.codexWebAuthConnected,
            costLimit: costLimit ?? self.costLimit,
            costSpent: costSpent ?? self.costSpent,
            estimatedCostUsd: estimatedCostUsd ?? self.estimatedCostUsd,
            extraUsageEnabled: extraUsageEnabled ?? self.extraUsageEnabled,
            extraUsageMonthlyLimit: extraUsageMonthlyLimit ?? self.extraUsageMonthlyLimit,
            extraUsageUsedCredits: extraUsageUsedCredits ?? self.extraUsageUsedCredits,
            extraUsageUtilization: extraUsageUtilization ?? self.extraUsageUtilization,
            fiveHourPercent: fiveHourPercent ?? self.fiveHourPercent,
            fiveHourResetsAt: fiveHourResetsAt ?? self.fiveHourResetsAt,
            inputTokens: inputTokens ?? self.inputTokens,
            oauthConnected: oauthConnected ?? self.oauthConnected,
            outputTokens: outputTokens ?? self.outputTokens,
            resetDate: resetDate ?? self.resetDate,
            resetTime: resetTime ?? self.resetTime,
            sessionDurationSec: sessionDurationSec ?? self.sessionDurationSec,
            sessionPercent: sessionPercent ?? self.sessionPercent,
            sevenDayPercent: sevenDayPercent ?? self.sevenDayPercent,
            sevenDayResetsAt: sevenDayResetsAt ?? self.sevenDayResetsAt,
            tokenStatus: tokenStatus ?? self.tokenStatus,
            toolCalls: toolCalls ?? self.toolCalls,
            usageStale: usageStale ?? self.usageStale,
            status: status ?? self.status,
            text: text ?? self.text,
            error: error ?? self.error,
            deviceId: deviceId ?? self.deviceId,
            responseText: responseText ?? self.responseText,
            timestamp: timestamp ?? self.timestamp,
            dim: dim ?? self.dim,
            displayOn: displayOn ?? self.displayOn,
            sessions: sessions ?? self.sessions,
            encoders: encoders ?? self.encoders,
            takeoverActive: takeoverActive ?? self.takeoverActive,
            buttons: buttons ?? self.buttons,
            entry: entry ?? self.entry,
            upsert: upsert ?? self.upsert,
            entries: entries ?? self.entries,
            run: run ?? self.run,
            scorecards: scorecards ?? self.scorecards,
            candidates: candidates ?? self.candidates,
            taskKind: taskKind ?? self.taskKind
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADAgentCapabilities
struct ADAgentCapabilities: Codable, Equatable {
    var displayName: String
    /// OAuth-based API usage tracking
    var hasApiUsage: Bool
    /// Diff review UI (view/apply/deny)
    var hasDiffReview: Bool
    /// CLI-based model catalog (openclaw models list)
    var hasModelCatalog: Bool
    /// Plan/AcceptEdits/Default mode switching
    var hasModeSwitching: Bool
    /// Arrow-key navigable prompts
    var hasNavigablePrompts: Bool
    /// Numbered option lists with arrow navigation
    var hasOptionLists: Bool
    /// Ghost text suggested prompts
    var hasSuggestedPrompts: Bool
    /// PTY terminal attachment (stdin/stdout proxy)
    var hasTerminal: Bool
    var type: ADAgentType

    enum CodingKeys: String, CodingKey {
        case displayName = "displayName"
        case hasApiUsage = "hasApiUsage"
        case hasDiffReview = "hasDiffReview"
        case hasModelCatalog = "hasModelCatalog"
        case hasModeSwitching = "hasModeSwitching"
        case hasNavigablePrompts = "hasNavigablePrompts"
        case hasOptionLists = "hasOptionLists"
        case hasSuggestedPrompts = "hasSuggestedPrompts"
        case hasTerminal = "hasTerminal"
        case type = "type"
    }
}

// MARK: ADAgentCapabilities convenience initializers and mutators

extension ADAgentCapabilities {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADAgentCapabilities.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        displayName: String? = nil,
        hasApiUsage: Bool? = nil,
        hasDiffReview: Bool? = nil,
        hasModelCatalog: Bool? = nil,
        hasModeSwitching: Bool? = nil,
        hasNavigablePrompts: Bool? = nil,
        hasOptionLists: Bool? = nil,
        hasSuggestedPrompts: Bool? = nil,
        hasTerminal: Bool? = nil,
        type: ADAgentType? = nil
    ) -> ADAgentCapabilities {
        return ADAgentCapabilities(
            displayName: displayName ?? self.displayName,
            hasApiUsage: hasApiUsage ?? self.hasApiUsage,
            hasDiffReview: hasDiffReview ?? self.hasDiffReview,
            hasModelCatalog: hasModelCatalog ?? self.hasModelCatalog,
            hasModeSwitching: hasModeSwitching ?? self.hasModeSwitching,
            hasNavigablePrompts: hasNavigablePrompts ?? self.hasNavigablePrompts,
            hasOptionLists: hasOptionLists ?? self.hasOptionLists,
            hasSuggestedPrompts: hasSuggestedPrompts ?? self.hasSuggestedPrompts,
            hasTerminal: hasTerminal ?? self.hasTerminal,
            type: type ?? self.type
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADAgentType: String, Codable, Equatable {
    case claudeCode = "claude-code"
    case codexApp = "codex-app"
    case codexCli = "codex-cli"
    case monitor = "monitor"
    case openclaw = "openclaw"
    case opencode = "opencode"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

/// Local Antigravity IDE quota summary, when available
// MARK: - ADAntigravityStatusInfo
struct ADAntigravityStatusInfo: Codable, Equatable {
    var availableCredits: Double?
    var minimumCreditAmountForUsage: Double?
    var planName: String?

    enum CodingKeys: String, CodingKey {
        case availableCredits = "availableCredits"
        case minimumCreditAmountForUsage = "minimumCreditAmountForUsage"
        case planName = "planName"
    }
}

// MARK: ADAntigravityStatusInfo convenience initializers and mutators

extension ADAntigravityStatusInfo {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADAntigravityStatusInfo.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        availableCredits: Double?? = nil,
        minimumCreditAmountForUsage: Double?? = nil,
        planName: String?? = nil
    ) -> ADAntigravityStatusInfo {
        return ADAntigravityStatusInfo(
            availableCredits: availableCredits ?? self.availableCredits,
            minimumCreditAmountForUsage: minimumCreditAmountForUsage ?? self.minimumCreditAmountForUsage,
            planName: planName ?? self.planName
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADBillingType: String, Codable, Equatable {
    case api = "api"
    case subscription = "subscription"
    case unknown = "unknown"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADDeckSlotConfig
struct ADDeckSlotConfig: Codable, Equatable {
    var actionType: String?
    var settings: [String: JSONAny]?
    var slot: Double
    var action: String?
    var badge: String?
    var bgColor: String?
    var dim: Bool?
    var enabled: Bool?
    var icon: String?
    var subtitle: String?
    var textColor: String?
    var title: String?

    enum CodingKeys: String, CodingKey {
        case actionType = "actionType"
        case settings = "settings"
        case slot = "slot"
        case action = "action"
        case badge = "badge"
        case bgColor = "bgColor"
        case dim = "dim"
        case enabled = "enabled"
        case icon = "icon"
        case subtitle = "subtitle"
        case textColor = "textColor"
        case title = "title"
    }
}

// MARK: ADDeckSlotConfig convenience initializers and mutators

extension ADDeckSlotConfig {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADDeckSlotConfig.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        actionType: String?? = nil,
        settings: [String: JSONAny]?? = nil,
        slot: Double? = nil,
        action: String?? = nil,
        badge: String?? = nil,
        bgColor: String?? = nil,
        dim: Bool?? = nil,
        enabled: Bool?? = nil,
        icon: String?? = nil,
        subtitle: String?? = nil,
        textColor: String?? = nil,
        title: String?? = nil
    ) -> ADDeckSlotConfig {
        return ADDeckSlotConfig(
            actionType: actionType ?? self.actionType,
            settings: settings ?? self.settings,
            slot: slot ?? self.slot,
            action: action ?? self.action,
            badge: badge ?? self.badge,
            bgColor: bgColor ?? self.bgColor,
            dim: dim ?? self.dim,
            enabled: enabled ?? self.enabled,
            icon: icon ?? self.icon,
            subtitle: subtitle ?? self.subtitle,
            textColor: textColor ?? self.textColor,
            title: title ?? self.title
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADApmeRecommendation
struct ADApmeRecommendation: Codable, Equatable {
    var agentType: ADAgentType
    var confidence: Double
    var expectedCostUsd: Double
    var expectedScore: Double
    var modelId: String
    var rationale: String

    enum CodingKeys: String, CodingKey {
        case agentType = "agentType"
        case confidence = "confidence"
        case expectedCostUsd = "expectedCostUsd"
        case expectedScore = "expectedScore"
        case modelId = "modelId"
        case rationale = "rationale"
    }
}

// MARK: ADApmeRecommendation convenience initializers and mutators

extension ADApmeRecommendation {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADApmeRecommendation.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        agentType: ADAgentType? = nil,
        confidence: Double? = nil,
        expectedCostUsd: Double? = nil,
        expectedScore: Double? = nil,
        modelId: String? = nil,
        rationale: String? = nil
    ) -> ADApmeRecommendation {
        return ADApmeRecommendation(
            agentType: agentType ?? self.agentType,
            confidence: confidence ?? self.confidence,
            expectedCostUsd: expectedCostUsd ?? self.expectedCostUsd,
            expectedScore: expectedScore ?? self.expectedScore,
            modelId: modelId ?? self.modelId,
            rationale: rationale ?? self.rationale
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

/// How to dim on sleep. Absent ⇒ legacy full-off.
///
/// Per-broadcast instruction telling downstream devices HOW to dim when the host display
/// sleeps. Resolved by the daemon from the `displaySleepDim` settings.json key and embedded
/// in every `display_state` event so that Pixoo / D200H / ESP32 dumb-apply a single
/// consistent snapshot. Absent ⇒ legacy behavior (full-off when displayOn=false).
// MARK: - ADDisplayDimInstruction
struct ADDisplayDimInstruction: Codable, Equatable {
    /// Master toggle. false ⇒ leave devices at their normal brightness.
    var enabled: Bool
    /// Minimum-brightness percent (1-100). Ignored when mode='off'.
    var level: Double
    /// 'off' ⇒ brightness 0; 'min' ⇒ dim to `level`.
    var mode: ADMode

    enum CodingKeys: String, CodingKey {
        case enabled = "enabled"
        case level = "level"
        case mode = "mode"
    }
}

// MARK: ADDisplayDimInstruction convenience initializers and mutators

extension ADDisplayDimInstruction {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADDisplayDimInstruction.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        enabled: Bool? = nil,
        level: Double? = nil,
        mode: ADMode? = nil
    ) -> ADDisplayDimInstruction {
        return ADDisplayDimInstruction(
            enabled: enabled ?? self.enabled,
            level: level ?? self.level,
            mode: mode ?? self.mode
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

/// 'off' ⇒ brightness 0; 'min' ⇒ dim to `level`.
enum ADMode: String, Codable, Equatable {
    case min = "min"
    case off = "off"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADEncoderSlotState
struct ADEncoderSlotState: Codable, Equatable {
    var accentColor: String?
    var counter: String?
    var detail: String?
    var encoderType: ADEncoderType?
    var header: String?
    var icon: String?
    var progress: Double?
    var recordingMs: Double?
    var slot: Double
    var transcription: String?
    var value: String?
    var voiceState: ADVoiceState?
    var actionType: String?
    var settings: [String: JSONAny]?

    enum CodingKeys: String, CodingKey {
        case accentColor = "accentColor"
        case counter = "counter"
        case detail = "detail"
        case encoderType = "encoderType"
        case header = "header"
        case icon = "icon"
        case progress = "progress"
        case recordingMs = "recordingMs"
        case slot = "slot"
        case transcription = "transcription"
        case value = "value"
        case voiceState = "voiceState"
        case actionType = "actionType"
        case settings = "settings"
    }
}

// MARK: ADEncoderSlotState convenience initializers and mutators

extension ADEncoderSlotState {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADEncoderSlotState.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        accentColor: String?? = nil,
        counter: String?? = nil,
        detail: String?? = nil,
        encoderType: ADEncoderType?? = nil,
        header: String?? = nil,
        icon: String?? = nil,
        progress: Double?? = nil,
        recordingMs: Double?? = nil,
        slot: Double? = nil,
        transcription: String?? = nil,
        value: String?? = nil,
        voiceState: ADVoiceState?? = nil,
        actionType: String?? = nil,
        settings: [String: JSONAny]?? = nil
    ) -> ADEncoderSlotState {
        return ADEncoderSlotState(
            accentColor: accentColor ?? self.accentColor,
            counter: counter ?? self.counter,
            detail: detail ?? self.detail,
            encoderType: encoderType ?? self.encoderType,
            header: header ?? self.header,
            icon: icon ?? self.icon,
            progress: progress ?? self.progress,
            recordingMs: recordingMs ?? self.recordingMs,
            slot: slot ?? self.slot,
            transcription: transcription ?? self.transcription,
            value: value ?? self.value,
            voiceState: voiceState ?? self.voiceState,
            actionType: actionType ?? self.actionType,
            settings: settings ?? self.settings
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADEncoderType: String, Codable, Equatable {
    case action = "action"
    case usage = "usage"
    case utility = "utility"
    case voice = "voice"
}

enum ADVoiceState: String, Codable, Equatable {
    case error = "error"
    case idle = "idle"
    case recording = "recording"
    case review = "review"
    case transcribing = "transcribing"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADTimelineEntry
struct ADTimelineEntry: Codable, Equatable {
    var agentType: String?
    var approvalId: String?
    var automated: Bool?
    /// Only on task_end. Why the task closed.
    var boundarySignal: String?
    var detail: String?
    var endedAt: Double?
    var projectName: String?
    var raw: String
    var repeatCount: Double?
    var runId: String?
    var sessionId: String?
    var startedAt: Double?
    var status: ADEntryStatus?
    /// How the row's `raw` summary was produced. Lets clients decide whether the detail pane is
    /// worth showing — when `'none'`, detail is just the unfiltered response that the heuristic
    /// couldn't summarize, and showing it duplicates content rather than adding value.   -
    /// `'llm'`     : LLM-summarized (clean, short, distinct from detail)   - `'heuristic'`:
    /// topic-hint extracted from response or prompt   - `'none'`    : last-resort fallback
    /// (literal "Completed", bare tool name, etc.)   - `'progress'`: non-terminal assistant
    /// status update (work still running)
    var summaryKind: ADSummaryKind?
    var taskCategory: String?
    /// APME task id. Set on task_start/task_end and on every turn entry inside the task scope.
    var taskId: String?
    var taskOutcome: String?
    /// Per-task evaluation result, attached when the task_judge resolves (always AFTER the
    /// initial task_end emit — clients upsert the existing row by (type='task_end', taskId) and
    /// merge these four fields).
    ///
    /// - `taskScore`   : 0..1 composite (matches `tasks.composite_score`)   - `taskOutcome` :
    /// terminal outcome string from `bridge/src/apme/outcome.ts`     (`'committed' | 'abandoned'
    /// | 'iterated' | 'ab_winner' | 'ab_loser'     | 'interrupted' | 'exploratory' |
    /// 'pending'`). UIs collapse into     three visual classes — success / fail / partial /
    /// pending — and pick     the badge color via design-system status tokens.   -
    /// `taskCategory`: task_rollup category ('general' | 'conversation' | …)   - `taskSummary` :
    /// one-line judge summary
    var taskScore: Double?
    var taskSummary: String?
    var ts: Double
    var type: ADTimelineEntryType

    enum CodingKeys: String, CodingKey {
        case agentType = "agentType"
        case approvalId = "approvalId"
        case automated = "automated"
        case boundarySignal = "boundarySignal"
        case detail = "detail"
        case endedAt = "endedAt"
        case projectName = "projectName"
        case raw = "raw"
        case repeatCount = "repeatCount"
        case runId = "runId"
        case sessionId = "sessionId"
        case startedAt = "startedAt"
        case status = "status"
        case summaryKind = "summaryKind"
        case taskCategory = "taskCategory"
        case taskId = "taskId"
        case taskOutcome = "taskOutcome"
        case taskScore = "taskScore"
        case taskSummary = "taskSummary"
        case ts = "ts"
        case type = "type"
    }
}

// MARK: ADTimelineEntry convenience initializers and mutators

extension ADTimelineEntry {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADTimelineEntry.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        agentType: String?? = nil,
        approvalId: String?? = nil,
        automated: Bool?? = nil,
        boundarySignal: String?? = nil,
        detail: String?? = nil,
        endedAt: Double?? = nil,
        projectName: String?? = nil,
        raw: String? = nil,
        repeatCount: Double?? = nil,
        runId: String?? = nil,
        sessionId: String?? = nil,
        startedAt: Double?? = nil,
        status: ADEntryStatus?? = nil,
        summaryKind: ADSummaryKind?? = nil,
        taskCategory: String?? = nil,
        taskId: String?? = nil,
        taskOutcome: String?? = nil,
        taskScore: Double?? = nil,
        taskSummary: String?? = nil,
        ts: Double? = nil,
        type: ADTimelineEntryType? = nil
    ) -> ADTimelineEntry {
        return ADTimelineEntry(
            agentType: agentType ?? self.agentType,
            approvalId: approvalId ?? self.approvalId,
            automated: automated ?? self.automated,
            boundarySignal: boundarySignal ?? self.boundarySignal,
            detail: detail ?? self.detail,
            endedAt: endedAt ?? self.endedAt,
            projectName: projectName ?? self.projectName,
            raw: raw ?? self.raw,
            repeatCount: repeatCount ?? self.repeatCount,
            runId: runId ?? self.runId,
            sessionId: sessionId ?? self.sessionId,
            startedAt: startedAt ?? self.startedAt,
            status: status ?? self.status,
            summaryKind: summaryKind ?? self.summaryKind,
            taskCategory: taskCategory ?? self.taskCategory,
            taskId: taskId ?? self.taskId,
            taskOutcome: taskOutcome ?? self.taskOutcome,
            taskScore: taskScore ?? self.taskScore,
            taskSummary: taskSummary ?? self.taskSummary,
            ts: ts ?? self.ts,
            type: type ?? self.type
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADEntryStatus: String, Codable, Equatable {
    case approved = "approved"
    case denied = "denied"
    case pending = "pending"
}

/// How the row's `raw` summary was produced. Lets clients decide whether the detail pane is
/// worth showing — when `'none'`, detail is just the unfiltered response that the heuristic
/// couldn't summarize, and showing it duplicates content rather than adding value.   -
/// `'llm'`     : LLM-summarized (clean, short, distinct from detail)   - `'heuristic'`:
/// topic-hint extracted from response or prompt   - `'none'`    : last-resort fallback
/// (literal "Completed", bare tool name, etc.)   - `'progress'`: non-terminal assistant
/// status update (work still running)
enum ADSummaryKind: String, Codable, Equatable {
    case heuristic = "heuristic"
    case llm = "llm"
    case none = "none"
    case progress = "progress"
}

/// Shared timeline types and log parser for OpenClaw mode. Used by both bridge
/// (BridgeLogStream) and plugin (LogStream).
enum ADTimelineEntryType: String, Codable, Equatable {
    case chatEnd = "chat_end"
    case chatResponse = "chat_response"
    case chatStart = "chat_start"
    case error = "error"
    case evalResult = "eval_result"
    case memoryRecall = "memory_recall"
    case modelCall = "model_call"
    case modelResponse = "model_response"
    case scheduled = "scheduled"
    case taskEnd = "task_end"
    case taskStart = "task_start"
    case toolExec = "tool_exec"
    case toolRequest = "tool_request"
    case toolResolved = "tool_resolved"
    case userAction = "user_action"
}

/// OpenClaw Gateway auth/pairing state
enum ADGatewayAuthStatus: String, Codable, Equatable {
    case approvalPending = "approval_pending"
    case authFailed = "auth_failed"
    case connected = "connected"
    case deviceAuthInvalid = "device_auth_invalid"
    case gatewayNotFound = "gateway_not_found"
    case gatewayReachable = "gateway_reachable"
    case gatewayTokenMissing = "gateway_token_missing"
    case pairingRequired = "pairing_required"
    case tokenMismatch = "token_mismatch"
    case unsupportedProtocol = "unsupported_protocol"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADModelCatalogEntry
struct ADModelCatalogEntry: Codable, Equatable {
    var available: Bool
    var key: String
    var name: String
    var role: String

    enum CodingKeys: String, CodingKey {
        case available = "available"
        case key = "key"
        case name = "name"
        case role = "role"
    }
}

// MARK: ADModelCatalogEntry convenience initializers and mutators

extension ADModelCatalogEntry {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADModelCatalogEntry.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        available: Bool? = nil,
        key: String? = nil,
        name: String? = nil,
        role: String? = nil
    ) -> ADModelCatalogEntry {
        return ADModelCatalogEntry(
            available: available ?? self.available,
            key: key ?? self.key,
            name: name ?? self.name,
            role: role ?? self.role
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

/// Ollama process status + running models
// MARK: - ADOllamaStatus
struct ADOllamaStatus: Codable, Equatable {
    var available: Bool
    var models: [ADOllamaModel]

    enum CodingKeys: String, CodingKey {
        case available = "available"
        case models = "models"
    }
}

// MARK: ADOllamaStatus convenience initializers and mutators

extension ADOllamaStatus {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADOllamaStatus.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        available: Bool? = nil,
        models: [ADOllamaModel]? = nil
    ) -> ADOllamaStatus {
        return ADOllamaStatus(
            available: available ?? self.available,
            models: models ?? self.models
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADOllamaModel
struct ADOllamaModel: Codable, Equatable {
    var name: String
    var size: Double
    var sizeVram: Double

    enum CodingKeys: String, CodingKey {
        case name = "name"
        case size = "size"
        case sizeVram = "sizeVram"
    }
}

// MARK: ADOllamaModel convenience initializers and mutators

extension ADOllamaModel {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADOllamaModel.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        name: String? = nil,
        size: Double? = nil,
        sizeVram: Double? = nil
    ) -> ADOllamaModel {
        return ADOllamaModel(
            name: name ?? self.name,
            size: size ?? self.size,
            sizeVram: sizeVram ?? self.sizeVram
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADPromptOption
struct ADPromptOption: Codable, Equatable {
    var index: Double
    var kind: ADKind?
    var label: String
    var recommended: Bool?
    var selected: Bool?
    var shortcut: String?

    enum CodingKeys: String, CodingKey {
        case index = "index"
        case kind = "kind"
        case label = "label"
        case recommended = "recommended"
        case selected = "selected"
        case shortcut = "shortcut"
    }
}

// MARK: ADPromptOption convenience initializers and mutators

extension ADPromptOption {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADPromptOption.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        index: Double? = nil,
        kind: ADKind?? = nil,
        label: String? = nil,
        recommended: Bool?? = nil,
        selected: Bool?? = nil,
        shortcut: String?? = nil
    ) -> ADPromptOption {
        return ADPromptOption(
            index: index ?? self.index,
            kind: kind ?? self.kind,
            label: label ?? self.label,
            recommended: recommended ?? self.recommended,
            selected: selected ?? self.selected,
            shortcut: shortcut ?? self.shortcut
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADKind: String, Codable, Equatable {
    case choice = "choice"
    case freeformInput = "freeform_input"
}

enum ADPermissionMode: String, Codable, Equatable {
    case acceptEdits = "acceptEdits"
    case bypassPermissions = "bypassPermissions"
    case dontAsk = "dontAsk"
    case permissionModeDefault = "default"
    case plan = "plan"
}

enum ADPromptType: String, Codable, Equatable {
    case diffReview = "diff_review"
    case multiSelect = "multi_select"
    case yesNo = "yes_no"
    case yesNoAlways = "yes_no_always"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

/// A run that has finished evaluation.
// MARK: - ADApmeRunSummary
struct ADApmeRunSummary: Codable, Equatable {
    var agentType: ADAgentType
    var compositeScore: Double?
    var costUsd: Double?
    var endedAt: Double?
    var evals: [ADApmeEvalRow]
    var exitCode: Double?
    var inputTokens: Double?
    var modelId: String?
    var outcome: ADOutcome?
    var outputTokens: Double?
    var overallScore: Double?
    var projectName: String?
    var runId: String
    var sessionId: String
    var startedAt: Double
    var taskCategory: String?
    var taskPrompt: String?

    enum CodingKeys: String, CodingKey {
        case agentType = "agentType"
        case compositeScore = "compositeScore"
        case costUsd = "costUsd"
        case endedAt = "endedAt"
        case evals = "evals"
        case exitCode = "exitCode"
        case inputTokens = "inputTokens"
        case modelId = "modelId"
        case outcome = "outcome"
        case outputTokens = "outputTokens"
        case overallScore = "overallScore"
        case projectName = "projectName"
        case runId = "runId"
        case sessionId = "sessionId"
        case startedAt = "startedAt"
        case taskCategory = "taskCategory"
        case taskPrompt = "taskPrompt"
    }
}

// MARK: ADApmeRunSummary convenience initializers and mutators

extension ADApmeRunSummary {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADApmeRunSummary.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        agentType: ADAgentType? = nil,
        compositeScore: Double?? = nil,
        costUsd: Double?? = nil,
        endedAt: Double?? = nil,
        evals: [ADApmeEvalRow]? = nil,
        exitCode: Double?? = nil,
        inputTokens: Double?? = nil,
        modelId: String?? = nil,
        outcome: ADOutcome?? = nil,
        outputTokens: Double?? = nil,
        overallScore: Double?? = nil,
        projectName: String?? = nil,
        runId: String? = nil,
        sessionId: String? = nil,
        startedAt: Double? = nil,
        taskCategory: String?? = nil,
        taskPrompt: String?? = nil
    ) -> ADApmeRunSummary {
        return ADApmeRunSummary(
            agentType: agentType ?? self.agentType,
            compositeScore: compositeScore ?? self.compositeScore,
            costUsd: costUsd ?? self.costUsd,
            endedAt: endedAt ?? self.endedAt,
            evals: evals ?? self.evals,
            exitCode: exitCode ?? self.exitCode,
            inputTokens: inputTokens ?? self.inputTokens,
            modelId: modelId ?? self.modelId,
            outcome: outcome ?? self.outcome,
            outputTokens: outputTokens ?? self.outputTokens,
            overallScore: overallScore ?? self.overallScore,
            projectName: projectName ?? self.projectName,
            runId: runId ?? self.runId,
            sessionId: sessionId ?? self.sessionId,
            startedAt: startedAt ?? self.startedAt,
            taskCategory: taskCategory ?? self.taskCategory,
            taskPrompt: taskPrompt ?? self.taskPrompt
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

/// A single evaluation score on a completed run.
// MARK: - ADApmeEvalRow
struct ADApmeEvalRow: Codable, Equatable {
    var createdAt: Double
    var judgeModel: String?
    var layer: ADLayer
    var metric: String
    var rubricVer: Double?
    var score: Double

    enum CodingKeys: String, CodingKey {
        case createdAt = "createdAt"
        case judgeModel = "judgeModel"
        case layer = "layer"
        case metric = "metric"
        case rubricVer = "rubricVer"
        case score = "score"
    }
}

// MARK: ADApmeEvalRow convenience initializers and mutators

extension ADApmeEvalRow {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADApmeEvalRow.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        createdAt: Double? = nil,
        judgeModel: String?? = nil,
        layer: ADLayer? = nil,
        metric: String? = nil,
        rubricVer: Double?? = nil,
        score: Double? = nil
    ) -> ADApmeEvalRow {
        return ADApmeEvalRow(
            createdAt: createdAt ?? self.createdAt,
            judgeModel: judgeModel ?? self.judgeModel,
            layer: layer ?? self.layer,
            metric: metric ?? self.metric,
            rubricVer: rubricVer ?? self.rubricVer,
            score: score ?? self.score
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADLayer: String, Codable, Equatable {
    case deterministic = "deterministic"
    case llmJudge = "llm_judge"
    case taskJudge = "task_judge"
    case trajectory = "trajectory"
    case turnJudge = "turn_judge"
    case vibe = "vibe"
}

enum ADOutcome: String, Codable, Equatable {
    case abLoser = "ab_loser"
    case abWinner = "ab_winner"
    case abandoned = "abandoned"
    case committed = "committed"
    case exploratory = "exploratory"
    case interrupted = "interrupted"
    case iterated = "iterated"
    case pending = "pending"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADApmeModelScorecard
struct ADApmeModelScorecard: Codable, Equatable {
    var agentType: ADAgentType
    var avgOverall: Double?
    var avgTestsPass: Double?
    var costPerQuality: Double?
    var modelId: String
    var runs: Double
    var totalCost: Double?

    enum CodingKeys: String, CodingKey {
        case agentType = "agentType"
        case avgOverall = "avgOverall"
        case avgTestsPass = "avgTestsPass"
        case costPerQuality = "costPerQuality"
        case modelId = "modelId"
        case runs = "runs"
        case totalCost = "totalCost"
    }
}

// MARK: ADApmeModelScorecard convenience initializers and mutators

extension ADApmeModelScorecard {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADApmeModelScorecard.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        agentType: ADAgentType? = nil,
        avgOverall: Double?? = nil,
        avgTestsPass: Double?? = nil,
        costPerQuality: Double?? = nil,
        modelId: String? = nil,
        runs: Double? = nil,
        totalCost: Double?? = nil
    ) -> ADApmeModelScorecard {
        return ADApmeModelScorecard(
            agentType: agentType ?? self.agentType,
            avgOverall: avgOverall ?? self.avgOverall,
            avgTestsPass: avgTestsPass ?? self.avgTestsPass,
            costPerQuality: costPerQuality ?? self.costPerQuality,
            modelId: modelId ?? self.modelId,
            runs: runs ?? self.runs,
            totalCost: totalCost ?? self.totalCost
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADOcSessionStatus
struct ADOcSessionStatus: Codable, Equatable {
    var contextTokens: Double?
    var messageCount: Double?
    var model: String?
    var sessionId: String?
    var uptime: String?

    enum CodingKeys: String, CodingKey {
        case contextTokens = "contextTokens"
        case messageCount = "messageCount"
        case model = "model"
        case sessionId = "sessionId"
        case uptime = "uptime"
    }
}

// MARK: ADOcSessionStatus convenience initializers and mutators

extension ADOcSessionStatus {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADOcSessionStatus.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        contextTokens: Double?? = nil,
        messageCount: Double?? = nil,
        model: String?? = nil,
        sessionId: String?? = nil,
        uptime: String?? = nil
    ) -> ADOcSessionStatus {
        return ADOcSessionStatus(
            contextTokens: contextTokens ?? self.contextTokens,
            messageCount: messageCount ?? self.messageCount,
            model: model ?? self.model,
            sessionId: sessionId ?? self.sessionId,
            uptime: uptime ?? self.uptime
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADSessionInfo
struct ADSessionInfo: Codable, Equatable {
    var agentType: ADAgentType?
    var alive: Bool
    var contextPercent: Double?
    var controlMode: ADControlMode?
    var currentTask: String?
    var currentTool: String?
    var cwd: String?
    var effortLevel: String?
    var elapsedSec: Double?
    var foldedSessionIds: [String]?
    var goal: String?
    var groupSize: Double?
    var id: String
    var modelName: String?
    var options: [ADPromptOption]?
    var pid: Double?
    var port: Double
    var projectName: String
    var promptType: ADPromptType?
    var question: String?
    var requestId: String?
    var startedAt: String?
    var state: String?
    var totalTokens: Double?

    enum CodingKeys: String, CodingKey {
        case agentType = "agentType"
        case alive = "alive"
        case contextPercent = "contextPercent"
        case controlMode = "controlMode"
        case currentTask = "currentTask"
        case currentTool = "currentTool"
        case cwd = "cwd"
        case effortLevel = "effortLevel"
        case elapsedSec = "elapsedSec"
        case foldedSessionIds = "foldedSessionIds"
        case goal = "goal"
        case groupSize = "groupSize"
        case id = "id"
        case modelName = "modelName"
        case options = "options"
        case pid = "pid"
        case port = "port"
        case projectName = "projectName"
        case promptType = "promptType"
        case question = "question"
        case requestId = "requestId"
        case startedAt = "startedAt"
        case state = "state"
        case totalTokens = "totalTokens"
    }
}

// MARK: ADSessionInfo convenience initializers and mutators

extension ADSessionInfo {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADSessionInfo.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        agentType: ADAgentType?? = nil,
        alive: Bool? = nil,
        contextPercent: Double?? = nil,
        controlMode: ADControlMode?? = nil,
        currentTask: String?? = nil,
        currentTool: String?? = nil,
        cwd: String?? = nil,
        effortLevel: String?? = nil,
        elapsedSec: Double?? = nil,
        foldedSessionIds: [String]?? = nil,
        goal: String?? = nil,
        groupSize: Double?? = nil,
        id: String? = nil,
        modelName: String?? = nil,
        options: [ADPromptOption]?? = nil,
        pid: Double?? = nil,
        port: Double? = nil,
        projectName: String? = nil,
        promptType: ADPromptType?? = nil,
        question: String?? = nil,
        requestId: String?? = nil,
        startedAt: String?? = nil,
        state: String?? = nil,
        totalTokens: Double?? = nil
    ) -> ADSessionInfo {
        return ADSessionInfo(
            agentType: agentType ?? self.agentType,
            alive: alive ?? self.alive,
            contextPercent: contextPercent ?? self.contextPercent,
            controlMode: controlMode ?? self.controlMode,
            currentTask: currentTask ?? self.currentTask,
            currentTool: currentTool ?? self.currentTool,
            cwd: cwd ?? self.cwd,
            effortLevel: effortLevel ?? self.effortLevel,
            elapsedSec: elapsedSec ?? self.elapsedSec,
            foldedSessionIds: foldedSessionIds ?? self.foldedSessionIds,
            goal: goal ?? self.goal,
            groupSize: groupSize ?? self.groupSize,
            id: id ?? self.id,
            modelName: modelName ?? self.modelName,
            options: options ?? self.options,
            pid: pid ?? self.pid,
            port: port ?? self.port,
            projectName: projectName ?? self.projectName,
            promptType: promptType ?? self.promptType,
            question: question ?? self.question,
            requestId: requestId ?? self.requestId,
            startedAt: startedAt ?? self.startedAt,
            state: state ?? self.state,
            totalTokens: totalTokens ?? self.totalTokens
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADControlMode: String, Codable, Equatable {
    case managed = "managed"
    case observed = "observed"
}

/// Voice assistant pipeline state (wake word → STT → LLM → TTS)
enum ADState: String, Codable, Equatable {
    case awaitingDiff = "awaiting_diff"
    case awaitingOption = "awaiting_option"
    case awaitingPermission = "awaiting_permission"
    case disabled = "disabled"
    case disconnected = "disconnected"
    case error = "error"
    case idle = "idle"
    case listening = "listening"
    case processing = "processing"
    case recording = "recording"
    case speaking = "speaking"
    case transcribing = "transcribing"
}

enum ADBridgeEventStatus: String, Codable, Equatable {
    case connected = "connected"
    case disconnected = "disconnected"
    case reconnecting = "reconnecting"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADSubscriptionInfo
struct ADSubscriptionInfo: Codable, Equatable {
    var name: String
    var until: String?

    enum CodingKeys: String, CodingKey {
        case name = "name"
        case until = "until"
    }
}

// MARK: ADSubscriptionInfo convenience initializers and mutators

extension ADSubscriptionInfo {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADSubscriptionInfo.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        name: String? = nil,
        until: String?? = nil
    ) -> ADSubscriptionInfo {
        return ADSubscriptionInfo(
            name: name ?? self.name,
            until: until ?? self.until
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADTokenStatus: String, Codable, Equatable {
    case expired = "expired"
    case missing = "missing"
    case unknown = "unknown"
    case valid = "valid"
}

enum ADType: String, Codable, Equatable {
    case apmeEval = "apme_eval"
    case apmeRecommendation = "apme_recommendation"
    case apmeScorecard = "apme_scorecard"
    case buttonState = "button_state"
    case connection = "connection"
    case deckSlotMap = "deck_slot_map"
    case displayState = "display_state"
    case encoderState = "encoder_state"
    case promptOptions = "prompt_options"
    case sessionsList = "sessions_list"
    case stateUpdate = "state_update"
    case timelineEvent = "timeline_event"
    case timelineHistory = "timeline_history"
    case usageUpdate = "usage_update"
    case userPrompt = "user_prompt"
    case voiceAssistantState = "voice_assistant_state"
    case voiceState = "voice_state"
    case wakeWordDetected = "wake_word_detected"
}

/// Voice assistant pipeline state (wake word → STT → LLM → TTS)
enum ADVoiceAssistantState: String, Codable, Equatable {
    case disabled = "disabled"
    case idle = "idle"
    case listening = "listening"
    case processing = "processing"
    case speaking = "speaking"
}

// MARK: - Helper functions for creating encoders and decoders

func newJSONDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    if #available(iOS 10.0, OSX 10.12, tvOS 10.0, watchOS 3.0, *) {
        decoder.dateDecodingStrategy = .iso8601
    }
    return decoder
}

func newJSONEncoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    if #available(iOS 10.0, OSX 10.12, tvOS 10.0, watchOS 3.0, *) {
        encoder.dateEncodingStrategy = .iso8601
    }
    return encoder
}

// MARK: - Encode/decode helpers

class JSONNull: Codable, Hashable {

    public static func == (lhs: JSONNull, rhs: JSONNull) -> Bool {
            return true
    }

    public var hashValue: Int {
            return 0
    }

    public init() {}

    public required init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if !container.decodeNil() {
                    throw DecodingError.typeMismatch(JSONNull.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Wrong type for JSONNull"))
            }
    }

    public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encodeNil()
    }
}

class JSONCodingKey: CodingKey {
    let key: String

    required init?(intValue: Int) {
            return nil
    }

    required init?(stringValue: String) {
            key = stringValue
    }

    var intValue: Int? {
            return nil
    }

    var stringValue: String {
            return key
    }
}

class JSONAny: Codable {

    let value: Any

    static func decodingError(forCodingPath codingPath: [CodingKey]) -> DecodingError {
            let context = DecodingError.Context(codingPath: codingPath, debugDescription: "Cannot decode JSONAny")
            return DecodingError.typeMismatch(JSONAny.self, context)
    }

    static func encodingError(forValue value: Any, codingPath: [CodingKey]) -> EncodingError {
            let context = EncodingError.Context(codingPath: codingPath, debugDescription: "Cannot encode JSONAny")
            return EncodingError.invalidValue(value, context)
    }

    static func decode(from container: SingleValueDecodingContainer) throws -> Any {
            if let value = try? container.decode(Bool.self) {
                    return value
            }
            if let value = try? container.decode(Int64.self) {
                    return value
            }
            if let value = try? container.decode(Double.self) {
                    return value
            }
            if let value = try? container.decode(String.self) {
                    return value
            }
            if container.decodeNil() {
                    return JSONNull()
            }
            throw decodingError(forCodingPath: container.codingPath)
    }

    static func decode(from container: inout UnkeyedDecodingContainer) throws -> Any {
            if let value = try? container.decode(Bool.self) {
                    return value
            }
            if let value = try? container.decode(Int64.self) {
                    return value
            }
            if let value = try? container.decode(Double.self) {
                    return value
            }
            if let value = try? container.decode(String.self) {
                    return value
            }
            if let value = try? container.decodeNil() {
                    if value {
                            return JSONNull()
                    }
            }
            if var container = try? container.nestedUnkeyedContainer() {
                    return try decodeArray(from: &container)
            }
            if var container = try? container.nestedContainer(keyedBy: JSONCodingKey.self) {
                    return try decodeDictionary(from: &container)
            }
            throw decodingError(forCodingPath: container.codingPath)
    }

    static func decode(from container: inout KeyedDecodingContainer<JSONCodingKey>, forKey key: JSONCodingKey) throws -> Any {
            if let value = try? container.decode(Bool.self, forKey: key) {
                    return value
            }
            if let value = try? container.decode(Int64.self, forKey: key) {
                    return value
            }
            if let value = try? container.decode(Double.self, forKey: key) {
                    return value
            }
            if let value = try? container.decode(String.self, forKey: key) {
                    return value
            }
            if let value = try? container.decodeNil(forKey: key) {
                    if value {
                            return JSONNull()
                    }
            }
            if var container = try? container.nestedUnkeyedContainer(forKey: key) {
                    return try decodeArray(from: &container)
            }
            if var container = try? container.nestedContainer(keyedBy: JSONCodingKey.self, forKey: key) {
                    return try decodeDictionary(from: &container)
            }
            throw decodingError(forCodingPath: container.codingPath)
    }

    static func decodeArray(from container: inout UnkeyedDecodingContainer) throws -> [Any] {
            var arr: [Any] = []
            while !container.isAtEnd {
                    let value = try decode(from: &container)
                    arr.append(value)
            }
            return arr
    }

    static func decodeDictionary(from container: inout KeyedDecodingContainer<JSONCodingKey>) throws -> [String: Any] {
            var dict = [String: Any]()
            for key in container.allKeys {
                    let value = try decode(from: &container, forKey: key)
                    dict[key.stringValue] = value
            }
            return dict
    }

    static func encode(to container: inout UnkeyedEncodingContainer, array: [Any]) throws {
            for value in array {
                    if let value = value as? Bool {
                            try container.encode(value)
                    } else if let value = value as? Int64 {
                            try container.encode(value)
                    } else if let value = value as? Double {
                            try container.encode(value)
                    } else if let value = value as? String {
                            try container.encode(value)
                    } else if value is JSONNull {
                            try container.encodeNil()
                    } else if let value = value as? [Any] {
                            var container = container.nestedUnkeyedContainer()
                            try encode(to: &container, array: value)
                    } else if let value = value as? [String: Any] {
                            var container = container.nestedContainer(keyedBy: JSONCodingKey.self)
                            try encode(to: &container, dictionary: value)
                    } else {
                            throw encodingError(forValue: value, codingPath: container.codingPath)
                    }
            }
    }

    static func encode(to container: inout KeyedEncodingContainer<JSONCodingKey>, dictionary: [String: Any]) throws {
            for (key, value) in dictionary {
                    let key = JSONCodingKey(stringValue: key)!
                    if let value = value as? Bool {
                            try container.encode(value, forKey: key)
                    } else if let value = value as? Int64 {
                            try container.encode(value, forKey: key)
                    } else if let value = value as? Double {
                            try container.encode(value, forKey: key)
                    } else if let value = value as? String {
                            try container.encode(value, forKey: key)
                    } else if value is JSONNull {
                            try container.encodeNil(forKey: key)
                    } else if let value = value as? [Any] {
                            var container = container.nestedUnkeyedContainer(forKey: key)
                            try encode(to: &container, array: value)
                    } else if let value = value as? [String: Any] {
                            var container = container.nestedContainer(keyedBy: JSONCodingKey.self, forKey: key)
                            try encode(to: &container, dictionary: value)
                    } else {
                            throw encodingError(forValue: value, codingPath: container.codingPath)
                    }
            }
    }

    static func encode(to container: inout SingleValueEncodingContainer, value: Any) throws {
            if let value = value as? Bool {
                    try container.encode(value)
            } else if let value = value as? Int64 {
                    try container.encode(value)
            } else if let value = value as? Double {
                    try container.encode(value)
            } else if let value = value as? String {
                    try container.encode(value)
            } else if value is JSONNull {
                    try container.encodeNil()
            } else {
                    throw encodingError(forValue: value, codingPath: container.codingPath)
            }
    }

    public required init(from decoder: Decoder) throws {
            if var arrayContainer = try? decoder.unkeyedContainer() {
                    self.value = try JSONAny.decodeArray(from: &arrayContainer)
            } else if var container = try? decoder.container(keyedBy: JSONCodingKey.self) {
                    self.value = try JSONAny.decodeDictionary(from: &container)
            } else {
                    let container = try decoder.singleValueContainer()
                    self.value = try JSONAny.decode(from: container)
            }
    }

    public func encode(to encoder: Encoder) throws {
            if let arr = self.value as? [Any] {
                    var container = encoder.unkeyedContainer()
                    try JSONAny.encode(to: &container, array: arr)
            } else if let dict = self.value as? [String: Any] {
                    var container = encoder.container(keyedBy: JSONCodingKey.self)
                    try JSONAny.encode(to: &container, dictionary: dict)
            } else {
                    var container = encoder.singleValueContainer()
                    try JSONAny.encode(to: &container, value: self.value)
            }
    }
}
