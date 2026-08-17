// This file was generated from JSON Schema using quicktype, do not modify it directly.
// To parse the JSON, add this file to your project and do:
//
//   let aDGatewayFrame = try ADGatewayFrame(json)

import Foundation

/// Client → Gateway: RPC request.
///
/// Gateway → Client: RPC response (ok=true) or error (ok=false).
///
/// Gateway → Client: unsolicited event.
// MARK: - ADGatewayFrame
struct ADGatewayFrame: Codable {
    var id: String?
    var method: ADGatewayMethodName?
    var params: ADGatewayMethodParams?
    var type: ADGatewayFrameType
    var error: ADGatewayError?
    var ok: Bool?
    var payload: ADGatewayMethodResult?
    var event: ADGatewayEventName?
    /// Monotonic sequence number (optional, used for ordering on reconnect).
    var seq: String?
    /// Server-side state version for dedup on replay.
    var stateVersion: String?

    enum CodingKeys: String, CodingKey {
        case id = "id"
        case method = "method"
        case params = "params"
        case type = "type"
        case error = "error"
        case ok = "ok"
        case payload = "payload"
        case event = "event"
        case seq = "seq"
        case stateVersion = "stateVersion"
    }
}

// MARK: ADGatewayFrame convenience initializers and mutators

extension ADGatewayFrame {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADGatewayFrame.self, from: data)
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
        id: String?? = nil,
        method: ADGatewayMethodName?? = nil,
        params: ADGatewayMethodParams?? = nil,
        type: ADGatewayFrameType? = nil,
        error: ADGatewayError?? = nil,
        ok: Bool?? = nil,
        payload: ADGatewayMethodResult?? = nil,
        event: ADGatewayEventName?? = nil,
        seq: String?? = nil,
        stateVersion: String?? = nil
    ) -> ADGatewayFrame {
        return ADGatewayFrame(
            id: id ?? self.id,
            method: method ?? self.method,
            params: params ?? self.params,
            type: type ?? self.type,
            error: error ?? self.error,
            ok: ok ?? self.ok,
            payload: payload ?? self.payload,
            event: event ?? self.event,
            seq: seq ?? self.seq,
            stateVersion: stateVersion ?? self.stateVersion
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - ADGatewayError
struct ADGatewayError: Codable {
    var code: String
    var details: JSONAny?
    var message: String

    enum CodingKeys: String, CodingKey {
        case code = "code"
        case details = "details"
        case message = "message"
    }
}

// MARK: ADGatewayError convenience initializers and mutators

extension ADGatewayError {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADGatewayError.self, from: data)
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
        code: String? = nil,
        details: JSONAny?? = nil,
        message: String? = nil
    ) -> ADGatewayError {
        return ADGatewayError(
            code: code ?? self.code,
            details: details ?? self.details,
            message: message ?? self.message
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADGatewayEventName: String, Codable {
    case chat = "chat"
    case connectChallenge = "connect.challenge"
    case execApprovalRequested = "exec.approval.requested"
    case execApprovalResolved = "exec.approval.resolved"
    case health = "health"
    case presence = "presence"
    case sessionMessage = "session.message"
    case sessionTool = "session.tool"
    case sessionsChanged = "sessions.changed"
    case shutdown = "shutdown"
    case systemPresence = "system-presence"
    case tick = "tick"
}

enum ADGatewayMethodName: String, Codable {
    case chatAbort = "chat.abort"
    case chatSend = "chat.send"
    case connect = "connect"
    case execApprovalList = "exec.approval.list"
    case execApprovalResolve = "exec.approval.resolve"
    case health = "health"
    case logsTail = "logs.tail"
    case modelsList = "models.list"
    case sessionsList = "sessions.list"
    case sessionsMessagesSubscribe = "sessions.messages.subscribe"
    case sessionsSubscribe = "sessions.subscribe"
    case systemPresence = "system-presence"
}

// MARK: - ADGatewayMethodParams
struct ADGatewayMethodParams: Codable {
    /// Bearer token issued during device pairing.
    var auth: ADGatewayMethodParamsAuth?
    var caps: [String]?
    var client: ADClient?
    var commands: [String]?
    /// Ed25519 device signature over
    /// `v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`.
    var device: ADDeviceAuth?
    var locale: String?
    /// Upper bound of protocol versions this client supports.
    var maxProtocol: Double?
    /// Lower bound of protocol versions this client supports.
    var minProtocol: Double?
    var permissions: [String: Bool]?
    var role: String?
    var scopes: [String]?
    var userAgent: String?
    var probe: Bool?
    var cursor: Double?
    var limit: Double?
    var maxBytes: Double?
    var idempotencyKey: String?
    var message: String?
    var sessionKey: String?
    var runId: String?
    var decision: ADExecApprovalDecision?
    var id: String?
    var kind: String?
    var key: String?

    enum CodingKeys: String, CodingKey {
        case auth = "auth"
        case caps = "caps"
        case client = "client"
        case commands = "commands"
        case device = "device"
        case locale = "locale"
        case maxProtocol = "maxProtocol"
        case minProtocol = "minProtocol"
        case permissions = "permissions"
        case role = "role"
        case scopes = "scopes"
        case userAgent = "userAgent"
        case probe = "probe"
        case cursor = "cursor"
        case limit = "limit"
        case maxBytes = "maxBytes"
        case idempotencyKey = "idempotencyKey"
        case message = "message"
        case sessionKey = "sessionKey"
        case runId = "runId"
        case decision = "decision"
        case id = "id"
        case kind = "kind"
        case key = "key"
    }
}

// MARK: ADGatewayMethodParams convenience initializers and mutators

extension ADGatewayMethodParams {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADGatewayMethodParams.self, from: data)
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
        auth: ADGatewayMethodParamsAuth?? = nil,
        caps: [String]?? = nil,
        client: ADClient?? = nil,
        commands: [String]?? = nil,
        device: ADDeviceAuth?? = nil,
        locale: String?? = nil,
        maxProtocol: Double?? = nil,
        minProtocol: Double?? = nil,
        permissions: [String: Bool]?? = nil,
        role: String?? = nil,
        scopes: [String]?? = nil,
        userAgent: String?? = nil,
        probe: Bool?? = nil,
        cursor: Double?? = nil,
        limit: Double?? = nil,
        maxBytes: Double?? = nil,
        idempotencyKey: String?? = nil,
        message: String?? = nil,
        sessionKey: String?? = nil,
        runId: String?? = nil,
        decision: ADExecApprovalDecision?? = nil,
        id: String?? = nil,
        kind: String?? = nil,
        key: String?? = nil
    ) -> ADGatewayMethodParams {
        return ADGatewayMethodParams(
            auth: auth ?? self.auth,
            caps: caps ?? self.caps,
            client: client ?? self.client,
            commands: commands ?? self.commands,
            device: device ?? self.device,
            locale: locale ?? self.locale,
            maxProtocol: maxProtocol ?? self.maxProtocol,
            minProtocol: minProtocol ?? self.minProtocol,
            permissions: permissions ?? self.permissions,
            role: role ?? self.role,
            scopes: scopes ?? self.scopes,
            userAgent: userAgent ?? self.userAgent,
            probe: probe ?? self.probe,
            cursor: cursor ?? self.cursor,
            limit: limit ?? self.limit,
            maxBytes: maxBytes ?? self.maxBytes,
            idempotencyKey: idempotencyKey ?? self.idempotencyKey,
            message: message ?? self.message,
            sessionKey: sessionKey ?? self.sessionKey,
            runId: runId ?? self.runId,
            decision: decision ?? self.decision,
            id: id ?? self.id,
            kind: kind ?? self.kind,
            key: key ?? self.key
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

/// Bearer token issued during device pairing.
// MARK: - ADGatewayMethodParamsAuth
struct ADGatewayMethodParamsAuth: Codable {
    var bootstrapToken: String?
    var deviceToken: String?
    var password: String?
    var token: String?

    enum CodingKeys: String, CodingKey {
        case bootstrapToken = "bootstrapToken"
        case deviceToken = "deviceToken"
        case password = "password"
        case token = "token"
    }
}

// MARK: ADGatewayMethodParamsAuth convenience initializers and mutators

extension ADGatewayMethodParamsAuth {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADGatewayMethodParamsAuth.self, from: data)
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
        bootstrapToken: String?? = nil,
        deviceToken: String?? = nil,
        password: String?? = nil,
        token: String?? = nil
    ) -> ADGatewayMethodParamsAuth {
        return ADGatewayMethodParamsAuth(
            bootstrapToken: bootstrapToken ?? self.bootstrapToken,
            deviceToken: deviceToken ?? self.deviceToken,
            password: password ?? self.password,
            token: token ?? self.token
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - ADClient
struct ADClient: Codable {
    var deviceFamily: String?
    var displayName: String
    var id: String
    var instanceId: String?
    var mode: ADMode
    var platform: String
    var version: String

    enum CodingKeys: String, CodingKey {
        case deviceFamily = "deviceFamily"
        case displayName = "displayName"
        case id = "id"
        case instanceId = "instanceId"
        case mode = "mode"
        case platform = "platform"
        case version = "version"
    }
}

// MARK: ADClient convenience initializers and mutators

extension ADClient {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADClient.self, from: data)
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
        deviceFamily: String?? = nil,
        displayName: String? = nil,
        id: String? = nil,
        instanceId: String?? = nil,
        mode: ADMode? = nil,
        platform: String? = nil,
        version: String? = nil
    ) -> ADClient {
        return ADClient(
            deviceFamily: deviceFamily ?? self.deviceFamily,
            displayName: displayName ?? self.displayName,
            id: id ?? self.id,
            instanceId: instanceId ?? self.instanceId,
            mode: mode ?? self.mode,
            platform: platform ?? self.platform,
            version: version ?? self.version
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADMode: String, Codable {
    case backend = "backend"
    case frontend = "frontend"
    case modeOperator = "operator"
    case node = "node"
}

/// The decisions the Gateway will accept for an exec approval. Mirror of OpenClaw's
/// `isApprovalDecision` / `DEFAULT_EXEC_APPROVAL_DECISIONS`. `'allow'` is NOT a member —
/// sending it is rejected as an invalid decision.
enum ADExecApprovalDecision: String, Codable {
    case allowAlways = "allow-always"
    case allowOnce = "allow-once"
    case deny = "deny"
}

/// Ed25519 device signature over
/// `v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`.
// MARK: - ADDeviceAuth
struct ADDeviceAuth: Codable {
    var id: String
    var nonce: String
    var publicKey: String
    var signature: String
    var signedAt: Double

    enum CodingKeys: String, CodingKey {
        case id = "id"
        case nonce = "nonce"
        case publicKey = "publicKey"
        case signature = "signature"
        case signedAt = "signedAt"
    }
}

// MARK: ADDeviceAuth convenience initializers and mutators

extension ADDeviceAuth {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADDeviceAuth.self, from: data)
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
        id: String? = nil,
        nonce: String? = nil,
        publicKey: String? = nil,
        signature: String? = nil,
        signedAt: Double? = nil
    ) -> ADDeviceAuth {
        return ADDeviceAuth(
            id: id ?? self.id,
            nonce: nonce ?? self.nonce,
            publicKey: publicKey ?? self.publicKey,
            signature: signature ?? self.signature,
            signedAt: signedAt ?? self.signedAt
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADGatewayMethodResult: Codable {
    case adConnectResult(ADConnectResult)
    case adExecApprovalRequestedPayloadArray([ADExecApprovalRequestedPayload])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let x = try? container.decode([ADExecApprovalRequestedPayload].self) {
            self = .adExecApprovalRequestedPayloadArray(x)
            return
        }
        if let x = try? container.decode(ADConnectResult.self) {
            self = .adConnectResult(x)
            return
        }
        throw DecodingError.typeMismatch(ADGatewayMethodResult.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Wrong type for ADGatewayMethodResult"))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .adConnectResult(let x):
            try container.encode(x)
        case .adExecApprovalRequestedPayloadArray(let x):
            try container.encode(x)
        }
    }
}

/// Same element shape as the requested event, minus the envelope.
///
/// `exec.approval.requested` payload. The nested `request` is the real shape; the flat
/// fields are tolerated so a future/legacy Gateway that inlines them still parses instead of
/// silently producing an empty prompt.
// MARK: - ADExecApprovalRequestedPayload
struct ADExecApprovalRequestedPayload: Codable {
    var agentId: String?
    /// Decisions this specific request permits (policy may drop allow-always).
    var allowedDecisions: [String]?
    /// Approval POLICY ("on-miss" | "always" | …), never a question.
    var ask: String?
    /// Sanitized command display text — the thing the user is approving.
    var command: String?
    /// Gateway-side static analysis summary of the command.
    var commandAnalysis: String?
    var commandArgv: [String]?
    /// Non-node hosts send a preview instead of the full command.
    var commandPreview: String?
    var createdAtMs: Double?
    var cwd: String?
    var expiresAtMs: Double?
    var host: String?
    var id: String
    var request: ADExecApprovalRequestBody?
    var resolvedPath: String?
    var security: String?
    var sessionKey: String?
    var unavailableDecisions: [String]?
    /// Human-readable risk note, when the Gateway produced one.
    var warningText: String?

    enum CodingKeys: String, CodingKey {
        case agentId = "agentId"
        case allowedDecisions = "allowedDecisions"
        case ask = "ask"
        case command = "command"
        case commandAnalysis = "commandAnalysis"
        case commandArgv = "commandArgv"
        case commandPreview = "commandPreview"
        case createdAtMs = "createdAtMs"
        case cwd = "cwd"
        case expiresAtMs = "expiresAtMs"
        case host = "host"
        case id = "id"
        case request = "request"
        case resolvedPath = "resolvedPath"
        case security = "security"
        case sessionKey = "sessionKey"
        case unavailableDecisions = "unavailableDecisions"
        case warningText = "warningText"
    }
}

// MARK: ADExecApprovalRequestedPayload convenience initializers and mutators

extension ADExecApprovalRequestedPayload {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADExecApprovalRequestedPayload.self, from: data)
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
        agentId: String?? = nil,
        allowedDecisions: [String]?? = nil,
        ask: String?? = nil,
        command: String?? = nil,
        commandAnalysis: String?? = nil,
        commandArgv: [String]?? = nil,
        commandPreview: String?? = nil,
        createdAtMs: Double?? = nil,
        cwd: String?? = nil,
        expiresAtMs: Double?? = nil,
        host: String?? = nil,
        id: String? = nil,
        request: ADExecApprovalRequestBody?? = nil,
        resolvedPath: String?? = nil,
        security: String?? = nil,
        sessionKey: String?? = nil,
        unavailableDecisions: [String]?? = nil,
        warningText: String?? = nil
    ) -> ADExecApprovalRequestedPayload {
        return ADExecApprovalRequestedPayload(
            agentId: agentId ?? self.agentId,
            allowedDecisions: allowedDecisions ?? self.allowedDecisions,
            ask: ask ?? self.ask,
            command: command ?? self.command,
            commandAnalysis: commandAnalysis ?? self.commandAnalysis,
            commandArgv: commandArgv ?? self.commandArgv,
            commandPreview: commandPreview ?? self.commandPreview,
            createdAtMs: createdAtMs ?? self.createdAtMs,
            cwd: cwd ?? self.cwd,
            expiresAtMs: expiresAtMs ?? self.expiresAtMs,
            host: host ?? self.host,
            id: id ?? self.id,
            request: request ?? self.request,
            resolvedPath: resolvedPath ?? self.resolvedPath,
            security: security ?? self.security,
            sessionKey: sessionKey ?? self.sessionKey,
            unavailableDecisions: unavailableDecisions ?? self.unavailableDecisions,
            warningText: warningText ?? self.warningText
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

/// The `request` body OpenClaw nests inside the requested event.
// MARK: - ADExecApprovalRequestBody
struct ADExecApprovalRequestBody: Codable {
    var agentId: String?
    /// Decisions this specific request permits (policy may drop allow-always).
    var allowedDecisions: [String]?
    /// Approval POLICY ("on-miss" | "always" | …), never a question.
    var ask: String?
    /// Sanitized command display text — the thing the user is approving.
    var command: String?
    /// Gateway-side static analysis summary of the command.
    var commandAnalysis: String?
    var commandArgv: [String]?
    /// Non-node hosts send a preview instead of the full command.
    var commandPreview: String?
    var cwd: String?
    var host: String?
    var resolvedPath: String?
    var security: String?
    var sessionKey: String?
    var unavailableDecisions: [String]?
    /// Human-readable risk note, when the Gateway produced one.
    var warningText: String?

    enum CodingKeys: String, CodingKey {
        case agentId = "agentId"
        case allowedDecisions = "allowedDecisions"
        case ask = "ask"
        case command = "command"
        case commandAnalysis = "commandAnalysis"
        case commandArgv = "commandArgv"
        case commandPreview = "commandPreview"
        case cwd = "cwd"
        case host = "host"
        case resolvedPath = "resolvedPath"
        case security = "security"
        case sessionKey = "sessionKey"
        case unavailableDecisions = "unavailableDecisions"
        case warningText = "warningText"
    }
}

// MARK: ADExecApprovalRequestBody convenience initializers and mutators

extension ADExecApprovalRequestBody {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADExecApprovalRequestBody.self, from: data)
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
        agentId: String?? = nil,
        allowedDecisions: [String]?? = nil,
        ask: String?? = nil,
        command: String?? = nil,
        commandAnalysis: String?? = nil,
        commandArgv: [String]?? = nil,
        commandPreview: String?? = nil,
        cwd: String?? = nil,
        host: String?? = nil,
        resolvedPath: String?? = nil,
        security: String?? = nil,
        sessionKey: String?? = nil,
        unavailableDecisions: [String]?? = nil,
        warningText: String?? = nil
    ) -> ADExecApprovalRequestBody {
        return ADExecApprovalRequestBody(
            agentId: agentId ?? self.agentId,
            allowedDecisions: allowedDecisions ?? self.allowedDecisions,
            ask: ask ?? self.ask,
            command: command ?? self.command,
            commandAnalysis: commandAnalysis ?? self.commandAnalysis,
            commandArgv: commandArgv ?? self.commandArgv,
            commandPreview: commandPreview ?? self.commandPreview,
            cwd: cwd ?? self.cwd,
            host: host ?? self.host,
            resolvedPath: resolvedPath ?? self.resolvedPath,
            security: security ?? self.security,
            sessionKey: sessionKey ?? self.sessionKey,
            unavailableDecisions: unavailableDecisions ?? self.unavailableDecisions,
            warningText: warningText ?? self.warningText
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

/// The Gateway answers `{ ok: true }`; `resolved` is kept for older builds.
///
/// Same element shape as the requested event, minus the envelope.
///
/// `exec.approval.requested` payload. The nested `request` is the real shape; the flat
/// fields are tolerated so a future/legacy Gateway that inlines them still parses instead of
/// silently producing an empty prompt.
///
/// `exec.approval.resolved` payload (`buildResolvedEvent` in exec-approval).
// MARK: - ADConnectResult
struct ADConnectResult: Codable {
    var accepted: Bool?
    var auth: ADConnectResultAuth?
    var expiresAt: Double?
    var features: ADFeatures?
    var policy: ADPolicy?
    var connectResultProtocol: Double?
    var server: ADServer?
    var sessionToken: String?
    var type: ADConnectResultType?
    var checks: [ADCheck]?
    var durationMs: Double?
    var ok: Bool?
    var status: String?
    var ts: Double?
    var models: [ADOpenClawModel]?
    var cursor: Double?
    var file: String?
    var lines: [String]?
    var reset: Bool?
    var size: Double?
    var truncated: Bool?
    var runId: String?
    var aborted: Bool?
    var resolved: Bool?
    var sessions: [ADGatewaySession]?
    var subscribed: Bool?
    var key: String?
    var devices: [ADGatewayPresenceEntry]?
    var entries: [ADGatewayPresenceEntry]?
    var nonce: String?
    /// Incremental text chunk (delta state).
    var delta: String?
    /// Error message (error state).
    var error: String?
    /// Token accounting (final state).
    var inputTokens: Double?
    /// Model identifier used for this turn.
    var modelId: String?
    /// Session identifier when Gateway creates a new session mid-chat.
    var newSessionId: String?
    var outputTokens: Double?
    /// User prompt text, as echoed by Gateway on first delta.
    var prompt: String?
    /// Full assembled response (final state).
    var response: String?
    var sessionKey: String?
    var state: ADState?
    /// Tool invocations observed in this turn.
    var tools: [ADChatToolInvocation]?
    var content: String?
    var message: JSONAny?
    var role: String?
    var text: String?
    var input: JSONAny?
    var name: String?
    var output: JSONAny?
    var tool: String?
    var reason: String?
    var agentId: String?
    /// Decisions this specific request permits (policy may drop allow-always).
    var allowedDecisions: [String]?
    /// Approval POLICY ("on-miss" | "always" | …), never a question.
    var ask: String?
    /// Sanitized command display text — the thing the user is approving.
    var command: String?
    /// Gateway-side static analysis summary of the command.
    var commandAnalysis: String?
    var commandArgv: [String]?
    /// Non-node hosts send a preview instead of the full command.
    var commandPreview: String?
    var createdAtMs: Double?
    var cwd: String?
    var expiresAtMs: Double?
    var host: String?
    var id: String?
    var request: ADExecApprovalRequestBody?
    var resolvedPath: String?
    var security: String?
    var unavailableDecisions: [String]?
    /// Human-readable risk note, when the Gateway produced one.
    var warningText: String?
    var decision: String?
    var resolvedBy: String?
    var clientId: String?
    var connected: Bool?
    var deviceId: String?
    var serverTime: Double?
    var restartAt: Double?

    enum CodingKeys: String, CodingKey {
        case accepted = "accepted"
        case auth = "auth"
        case expiresAt = "expiresAt"
        case features = "features"
        case policy = "policy"
        case connectResultProtocol = "protocol"
        case server = "server"
        case sessionToken = "sessionToken"
        case type = "type"
        case checks = "checks"
        case durationMs = "durationMs"
        case ok = "ok"
        case status = "status"
        case ts = "ts"
        case models = "models"
        case cursor = "cursor"
        case file = "file"
        case lines = "lines"
        case reset = "reset"
        case size = "size"
        case truncated = "truncated"
        case runId = "runId"
        case aborted = "aborted"
        case resolved = "resolved"
        case sessions = "sessions"
        case subscribed = "subscribed"
        case key = "key"
        case devices = "devices"
        case entries = "entries"
        case nonce = "nonce"
        case delta = "delta"
        case error = "error"
        case inputTokens = "inputTokens"
        case modelId = "modelId"
        case newSessionId = "newSessionId"
        case outputTokens = "outputTokens"
        case prompt = "prompt"
        case response = "response"
        case sessionKey = "sessionKey"
        case state = "state"
        case tools = "tools"
        case content = "content"
        case message = "message"
        case role = "role"
        case text = "text"
        case input = "input"
        case name = "name"
        case output = "output"
        case tool = "tool"
        case reason = "reason"
        case agentId = "agentId"
        case allowedDecisions = "allowedDecisions"
        case ask = "ask"
        case command = "command"
        case commandAnalysis = "commandAnalysis"
        case commandArgv = "commandArgv"
        case commandPreview = "commandPreview"
        case createdAtMs = "createdAtMs"
        case cwd = "cwd"
        case expiresAtMs = "expiresAtMs"
        case host = "host"
        case id = "id"
        case request = "request"
        case resolvedPath = "resolvedPath"
        case security = "security"
        case unavailableDecisions = "unavailableDecisions"
        case warningText = "warningText"
        case decision = "decision"
        case resolvedBy = "resolvedBy"
        case clientId = "clientId"
        case connected = "connected"
        case deviceId = "deviceId"
        case serverTime = "serverTime"
        case restartAt = "restartAt"
    }
}

// MARK: ADConnectResult convenience initializers and mutators

extension ADConnectResult {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADConnectResult.self, from: data)
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
        accepted: Bool?? = nil,
        auth: ADConnectResultAuth?? = nil,
        expiresAt: Double?? = nil,
        features: ADFeatures?? = nil,
        policy: ADPolicy?? = nil,
        connectResultProtocol: Double?? = nil,
        server: ADServer?? = nil,
        sessionToken: String?? = nil,
        type: ADConnectResultType?? = nil,
        checks: [ADCheck]?? = nil,
        durationMs: Double?? = nil,
        ok: Bool?? = nil,
        status: String?? = nil,
        ts: Double?? = nil,
        models: [ADOpenClawModel]?? = nil,
        cursor: Double?? = nil,
        file: String?? = nil,
        lines: [String]?? = nil,
        reset: Bool?? = nil,
        size: Double?? = nil,
        truncated: Bool?? = nil,
        runId: String?? = nil,
        aborted: Bool?? = nil,
        resolved: Bool?? = nil,
        sessions: [ADGatewaySession]?? = nil,
        subscribed: Bool?? = nil,
        key: String?? = nil,
        devices: [ADGatewayPresenceEntry]?? = nil,
        entries: [ADGatewayPresenceEntry]?? = nil,
        nonce: String?? = nil,
        delta: String?? = nil,
        error: String?? = nil,
        inputTokens: Double?? = nil,
        modelId: String?? = nil,
        newSessionId: String?? = nil,
        outputTokens: Double?? = nil,
        prompt: String?? = nil,
        response: String?? = nil,
        sessionKey: String?? = nil,
        state: ADState?? = nil,
        tools: [ADChatToolInvocation]?? = nil,
        content: String?? = nil,
        message: JSONAny?? = nil,
        role: String?? = nil,
        text: String?? = nil,
        input: JSONAny?? = nil,
        name: String?? = nil,
        output: JSONAny?? = nil,
        tool: String?? = nil,
        reason: String?? = nil,
        agentId: String?? = nil,
        allowedDecisions: [String]?? = nil,
        ask: String?? = nil,
        command: String?? = nil,
        commandAnalysis: String?? = nil,
        commandArgv: [String]?? = nil,
        commandPreview: String?? = nil,
        createdAtMs: Double?? = nil,
        cwd: String?? = nil,
        expiresAtMs: Double?? = nil,
        host: String?? = nil,
        id: String?? = nil,
        request: ADExecApprovalRequestBody?? = nil,
        resolvedPath: String?? = nil,
        security: String?? = nil,
        unavailableDecisions: [String]?? = nil,
        warningText: String?? = nil,
        decision: String?? = nil,
        resolvedBy: String?? = nil,
        clientId: String?? = nil,
        connected: Bool?? = nil,
        deviceId: String?? = nil,
        serverTime: Double?? = nil,
        restartAt: Double?? = nil
    ) -> ADConnectResult {
        return ADConnectResult(
            accepted: accepted ?? self.accepted,
            auth: auth ?? self.auth,
            expiresAt: expiresAt ?? self.expiresAt,
            features: features ?? self.features,
            policy: policy ?? self.policy,
            connectResultProtocol: connectResultProtocol ?? self.connectResultProtocol,
            server: server ?? self.server,
            sessionToken: sessionToken ?? self.sessionToken,
            type: type ?? self.type,
            checks: checks ?? self.checks,
            durationMs: durationMs ?? self.durationMs,
            ok: ok ?? self.ok,
            status: status ?? self.status,
            ts: ts ?? self.ts,
            models: models ?? self.models,
            cursor: cursor ?? self.cursor,
            file: file ?? self.file,
            lines: lines ?? self.lines,
            reset: reset ?? self.reset,
            size: size ?? self.size,
            truncated: truncated ?? self.truncated,
            runId: runId ?? self.runId,
            aborted: aborted ?? self.aborted,
            resolved: resolved ?? self.resolved,
            sessions: sessions ?? self.sessions,
            subscribed: subscribed ?? self.subscribed,
            key: key ?? self.key,
            devices: devices ?? self.devices,
            entries: entries ?? self.entries,
            nonce: nonce ?? self.nonce,
            delta: delta ?? self.delta,
            error: error ?? self.error,
            inputTokens: inputTokens ?? self.inputTokens,
            modelId: modelId ?? self.modelId,
            newSessionId: newSessionId ?? self.newSessionId,
            outputTokens: outputTokens ?? self.outputTokens,
            prompt: prompt ?? self.prompt,
            response: response ?? self.response,
            sessionKey: sessionKey ?? self.sessionKey,
            state: state ?? self.state,
            tools: tools ?? self.tools,
            content: content ?? self.content,
            message: message ?? self.message,
            role: role ?? self.role,
            text: text ?? self.text,
            input: input ?? self.input,
            name: name ?? self.name,
            output: output ?? self.output,
            tool: tool ?? self.tool,
            reason: reason ?? self.reason,
            agentId: agentId ?? self.agentId,
            allowedDecisions: allowedDecisions ?? self.allowedDecisions,
            ask: ask ?? self.ask,
            command: command ?? self.command,
            commandAnalysis: commandAnalysis ?? self.commandAnalysis,
            commandArgv: commandArgv ?? self.commandArgv,
            commandPreview: commandPreview ?? self.commandPreview,
            createdAtMs: createdAtMs ?? self.createdAtMs,
            cwd: cwd ?? self.cwd,
            expiresAtMs: expiresAtMs ?? self.expiresAtMs,
            host: host ?? self.host,
            id: id ?? self.id,
            request: request ?? self.request,
            resolvedPath: resolvedPath ?? self.resolvedPath,
            security: security ?? self.security,
            unavailableDecisions: unavailableDecisions ?? self.unavailableDecisions,
            warningText: warningText ?? self.warningText,
            decision: decision ?? self.decision,
            resolvedBy: resolvedBy ?? self.resolvedBy,
            clientId: clientId ?? self.clientId,
            connected: connected ?? self.connected,
            deviceId: deviceId ?? self.deviceId,
            serverTime: serverTime ?? self.serverTime,
            restartAt: restartAt ?? self.restartAt
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - ADConnectResultAuth
struct ADConnectResultAuth: Codable {
    var deviceToken: String
    var deviceTokens: [ADDeviceToken]?
    var issuedAtMs: Double?
    var role: String
    var scopes: [String]

    enum CodingKeys: String, CodingKey {
        case deviceToken = "deviceToken"
        case deviceTokens = "deviceTokens"
        case issuedAtMs = "issuedAtMs"
        case role = "role"
        case scopes = "scopes"
    }
}

// MARK: ADConnectResultAuth convenience initializers and mutators

extension ADConnectResultAuth {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADConnectResultAuth.self, from: data)
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
        deviceToken: String? = nil,
        deviceTokens: [ADDeviceToken]?? = nil,
        issuedAtMs: Double?? = nil,
        role: String? = nil,
        scopes: [String]? = nil
    ) -> ADConnectResultAuth {
        return ADConnectResultAuth(
            deviceToken: deviceToken ?? self.deviceToken,
            deviceTokens: deviceTokens ?? self.deviceTokens,
            issuedAtMs: issuedAtMs ?? self.issuedAtMs,
            role: role ?? self.role,
            scopes: scopes ?? self.scopes
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - ADDeviceToken
struct ADDeviceToken: Codable {
    var deviceToken: String
    var issuedAtMs: Double?
    var role: String
    var scopes: [String]

    enum CodingKeys: String, CodingKey {
        case deviceToken = "deviceToken"
        case issuedAtMs = "issuedAtMs"
        case role = "role"
        case scopes = "scopes"
    }
}

// MARK: ADDeviceToken convenience initializers and mutators

extension ADDeviceToken {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADDeviceToken.self, from: data)
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
        deviceToken: String? = nil,
        issuedAtMs: Double?? = nil,
        role: String? = nil,
        scopes: [String]? = nil
    ) -> ADDeviceToken {
        return ADDeviceToken(
            deviceToken: deviceToken ?? self.deviceToken,
            issuedAtMs: issuedAtMs ?? self.issuedAtMs,
            role: role ?? self.role,
            scopes: scopes ?? self.scopes
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - ADCheck
struct ADCheck: Codable {
    var id: String?
    var message: String?
    var name: String?
    var status: String?

    enum CodingKeys: String, CodingKey {
        case id = "id"
        case message = "message"
        case name = "name"
        case status = "status"
    }
}

// MARK: ADCheck convenience initializers and mutators

extension ADCheck {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADCheck.self, from: data)
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
        id: String?? = nil,
        message: String?? = nil,
        name: String?? = nil,
        status: String?? = nil
    ) -> ADCheck {
        return ADCheck(
            id: id ?? self.id,
            message: message ?? self.message,
            name: name ?? self.name,
            status: status ?? self.status
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - ADGatewayPresenceEntry
struct ADGatewayPresenceEntry: Codable {
    var clientId: String?
    var connected: Bool
    var deviceId: String?
    var displayName: String?
    var roles: [String]?
    var scopes: [String]?

    enum CodingKeys: String, CodingKey {
        case clientId = "clientId"
        case connected = "connected"
        case deviceId = "deviceId"
        case displayName = "displayName"
        case roles = "roles"
        case scopes = "scopes"
    }
}

// MARK: ADGatewayPresenceEntry convenience initializers and mutators

extension ADGatewayPresenceEntry {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADGatewayPresenceEntry.self, from: data)
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
        clientId: String?? = nil,
        connected: Bool? = nil,
        deviceId: String?? = nil,
        displayName: String?? = nil,
        roles: [String]?? = nil,
        scopes: [String]?? = nil
    ) -> ADGatewayPresenceEntry {
        return ADGatewayPresenceEntry(
            clientId: clientId ?? self.clientId,
            connected: connected ?? self.connected,
            deviceId: deviceId ?? self.deviceId,
            displayName: displayName ?? self.displayName,
            roles: roles ?? self.roles,
            scopes: scopes ?? self.scopes
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - ADFeatures
struct ADFeatures: Codable {
    var events: [String]
    var methods: [String]

    enum CodingKeys: String, CodingKey {
        case events = "events"
        case methods = "methods"
    }
}

// MARK: ADFeatures convenience initializers and mutators

extension ADFeatures {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADFeatures.self, from: data)
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
        events: [String]? = nil,
        methods: [String]? = nil
    ) -> ADFeatures {
        return ADFeatures(
            events: events ?? self.events,
            methods: methods ?? self.methods
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - ADOpenClawModel
struct ADOpenClawModel: Codable {
    var available: Bool?
    var id: String?
    var key: String?
    var missing: Bool?
    var name: String?
    var provider: String?
    var tags: [String]?
    var title: String?

    enum CodingKeys: String, CodingKey {
        case available = "available"
        case id = "id"
        case key = "key"
        case missing = "missing"
        case name = "name"
        case provider = "provider"
        case tags = "tags"
        case title = "title"
    }
}

// MARK: ADOpenClawModel convenience initializers and mutators

extension ADOpenClawModel {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADOpenClawModel.self, from: data)
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
        available: Bool?? = nil,
        id: String?? = nil,
        key: String?? = nil,
        missing: Bool?? = nil,
        name: String?? = nil,
        provider: String?? = nil,
        tags: [String]?? = nil,
        title: String?? = nil
    ) -> ADOpenClawModel {
        return ADOpenClawModel(
            available: available ?? self.available,
            id: id ?? self.id,
            key: key ?? self.key,
            missing: missing ?? self.missing,
            name: name ?? self.name,
            provider: provider ?? self.provider,
            tags: tags ?? self.tags,
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

// MARK: - ADPolicy
struct ADPolicy: Codable {
    var maxPayload: Double?
    var tickIntervalMs: Double?

    enum CodingKeys: String, CodingKey {
        case maxPayload = "maxPayload"
        case tickIntervalMs = "tickIntervalMs"
    }
}

// MARK: ADPolicy convenience initializers and mutators

extension ADPolicy {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADPolicy.self, from: data)
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
        maxPayload: Double?? = nil,
        tickIntervalMs: Double?? = nil
    ) -> ADPolicy {
        return ADPolicy(
            maxPayload: maxPayload ?? self.maxPayload,
            tickIntervalMs: tickIntervalMs ?? self.tickIntervalMs
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - ADServer
struct ADServer: Codable {
    var connId: String
    var version: String

    enum CodingKeys: String, CodingKey {
        case connId = "connId"
        case version = "version"
    }
}

// MARK: ADServer convenience initializers and mutators

extension ADServer {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADServer.self, from: data)
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
        connId: String? = nil,
        version: String? = nil
    ) -> ADServer {
        return ADServer(
            connId: connId ?? self.connId,
            version: version ?? self.version
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - ADGatewaySession
struct ADGatewaySession: Codable {
    var displayName: String?
    var key: String
    var kind: String?
    var label: String?
    var sessionId: String?
    var updatedAt: Double?

    enum CodingKeys: String, CodingKey {
        case displayName = "displayName"
        case key = "key"
        case kind = "kind"
        case label = "label"
        case sessionId = "sessionId"
        case updatedAt = "updatedAt"
    }
}

// MARK: ADGatewaySession convenience initializers and mutators

extension ADGatewaySession {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADGatewaySession.self, from: data)
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
        displayName: String?? = nil,
        key: String? = nil,
        kind: String?? = nil,
        label: String?? = nil,
        sessionId: String?? = nil,
        updatedAt: Double?? = nil
    ) -> ADGatewaySession {
        return ADGatewaySession(
            displayName: displayName ?? self.displayName,
            key: key ?? self.key,
            kind: kind ?? self.kind,
            label: label ?? self.label,
            sessionId: sessionId ?? self.sessionId,
            updatedAt: updatedAt ?? self.updatedAt
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADState: String, Codable {
    case aborted = "aborted"
    case delta = "delta"
    case error = "error"
    case stateFinal = "final"
}

// MARK: - ADChatToolInvocation
struct ADChatToolInvocation: Codable {
    var input: JSONAny?
    var name: String
    var output: JSONAny?
    var status: ADStatus?

    enum CodingKeys: String, CodingKey {
        case input = "input"
        case name = "name"
        case output = "output"
        case status = "status"
    }
}

// MARK: ADChatToolInvocation convenience initializers and mutators

extension ADChatToolInvocation {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADChatToolInvocation.self, from: data)
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
        input: JSONAny?? = nil,
        name: String? = nil,
        output: JSONAny?? = nil,
        status: ADStatus?? = nil
    ) -> ADChatToolInvocation {
        return ADChatToolInvocation(
            input: input ?? self.input,
            name: name ?? self.name,
            output: output ?? self.output,
            status: status ?? self.status
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADStatus: String, Codable {
    case error = "error"
    case pending = "pending"
    case success = "success"
}

enum ADConnectResultType: String, Codable {
    case helloOk = "hello-ok"
}

enum ADGatewayFrameType: String, Codable {
    case event = "event"
    case req = "req"
    case res = "res"
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

    public func hash(into hasher: inout Hasher) {
            hasher.combine(0)
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

final class JSONCodingKey: CodingKey {
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
