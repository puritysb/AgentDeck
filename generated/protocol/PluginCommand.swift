// This file was generated from JSON Schema using quicktype, do not modify it directly.
// To parse the JSON, add this file to your project and do:
//
//   let aDPluginCommand = try ADPluginCommand(json)

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

import Foundation

/// Request a session's recent timeline. The daemon replies (to the requester only) with a
/// `timeline_history` carrying that session's entries. Lets a device that connects
/// mid-session fill its per-session Detail view.
///
/// Session-scoped command — daemon forwards the inner command to the specified session's
/// bridge. Enables direct control of a specific session from any client (MenuBarExtra,
/// Dashboard, etc.)
///
/// Self-announcement from a rich UI client (Elgato Stream Deck plugin, a future Android
/// companion app, etc.) so the daemon can surface the hardware under its rightful Downstream
/// row instead of treating every WS connection as an anonymous dashboard viewer. Sent once
/// per connect, immediately after the WebSocket opens. Daemon wipes the cached entry when
/// the WS connection closes.
///
/// APME vibe check — user approves or rejects a completed run's output quality.
///
/// Ask bridge/daemon for model recommendation given a task context.
///
/// Device approval decision for a gated PreToolUse permission request (observed sessions).
/// The daemon holds the hook's HTTP response open keyed by `requestId`; this command
/// resolves it into a Claude Code permission decision. See
/// bridge/src/permission-resolver.ts.
///
/// Trigger an independent on-demand review of a session's latest work (the REVIEW deck
/// button). Daemon-side eval with an independent judge model — no agent control involved, so
/// every session type qualifies. Results flow back as review_status / review_result events
/// plus SessionInfo badge fields.
// MARK: - ADPluginCommand
struct ADPluginCommand: Codable, Equatable {
    var type: ADType
    var value: ADValue?
    var index: Double?
    /// Echo of the question text the device was DISPLAYING when pressed. A multi-group
    /// AskUserQuestion advances to the next question as soon as one is answered, so an index
    /// pressed against the previous question would otherwise select the wrong option in the new
    /// one. The daemon drops a press whose echo no longer matches the active question and
    /// re-broadcasts so the device re-syncs. Optional: omitted ⇒ no guard (older clients, ESP32
    /// firmware) — never make this required.
    var question: String?
    /// Target session for daemon-side host push-to-talk (deck surfaces have no session of their
    /// own). Absent ⇒ the focused session, then the legacy session-bridge behavior when a bridge
    /// handles it directly.
    var sessionId: String?
    var direction: ADDirection?
    var text: String?
    var mode: ADMode?
    var action: ADAction?
    /// Optional epoch-ms lower bound; omit for the full retained history.
    var since: Double?
    var agent: ADAgent?
    var command: ADCommand?
    /// Human-readable label for the surface (appears verbatim in diagnostics).
    var clientLabel: String?
    /// Short stable id — "streamdeck-plugin", "android-companion", etc.
    var clientType: String?
    /// Physical device roster this client is driving, if any.
    var devices: [ADDevice]?
    var note: String?
    var runId: String?
    var verdict: ADVerdict?
    var budgetUsd: Double?
    var latencyBudgetMs: Double?
    var preferLocal: Bool?
    var taskKind: String?
    var decision: ADDecision?
    var requestId: String?
    var offset: Double?
    var otaId: String?
    var seq: Double?
    var stage: String?
    var written: Double?
    var error: String?

    enum CodingKeys: String, CodingKey {
        case type = "type"
        case value = "value"
        case index = "index"
        case question = "question"
        case sessionId = "sessionId"
        case direction = "direction"
        case text = "text"
        case mode = "mode"
        case action = "action"
        case since = "since"
        case agent = "agent"
        case command = "command"
        case clientLabel = "clientLabel"
        case clientType = "clientType"
        case devices = "devices"
        case note = "note"
        case runId = "runId"
        case verdict = "verdict"
        case budgetUsd = "budgetUsd"
        case latencyBudgetMs = "latencyBudgetMs"
        case preferLocal = "preferLocal"
        case taskKind = "taskKind"
        case decision = "decision"
        case requestId = "requestId"
        case offset = "offset"
        case otaId = "otaId"
        case seq = "seq"
        case stage = "stage"
        case written = "written"
        case error = "error"
    }
}

// MARK: ADPluginCommand convenience initializers and mutators

extension ADPluginCommand {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADPluginCommand.self, from: data)
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
        type: ADType? = nil,
        value: ADValue?? = nil,
        index: Double?? = nil,
        question: String?? = nil,
        sessionId: String?? = nil,
        direction: ADDirection?? = nil,
        text: String?? = nil,
        mode: ADMode?? = nil,
        action: ADAction?? = nil,
        since: Double?? = nil,
        agent: ADAgent?? = nil,
        command: ADCommand?? = nil,
        clientLabel: String?? = nil,
        clientType: String?? = nil,
        devices: [ADDevice]?? = nil,
        note: String?? = nil,
        runId: String?? = nil,
        verdict: ADVerdict?? = nil,
        budgetUsd: Double?? = nil,
        latencyBudgetMs: Double?? = nil,
        preferLocal: Bool?? = nil,
        taskKind: String?? = nil,
        decision: ADDecision?? = nil,
        requestId: String?? = nil,
        offset: Double?? = nil,
        otaId: String?? = nil,
        seq: Double?? = nil,
        stage: String?? = nil,
        written: Double?? = nil,
        error: String?? = nil
    ) -> ADPluginCommand {
        return ADPluginCommand(
            type: type ?? self.type,
            value: value ?? self.value,
            index: index ?? self.index,
            question: question ?? self.question,
            sessionId: sessionId ?? self.sessionId,
            direction: direction ?? self.direction,
            text: text ?? self.text,
            mode: mode ?? self.mode,
            action: action ?? self.action,
            since: since ?? self.since,
            agent: agent ?? self.agent,
            command: command ?? self.command,
            clientLabel: clientLabel ?? self.clientLabel,
            clientType: clientType ?? self.clientType,
            devices: devices ?? self.devices,
            note: note ?? self.note,
            runId: runId ?? self.runId,
            verdict: verdict ?? self.verdict,
            budgetUsd: budgetUsd ?? self.budgetUsd,
            latencyBudgetMs: latencyBudgetMs ?? self.latencyBudgetMs,
            preferLocal: preferLocal ?? self.preferLocal,
            taskKind: taskKind ?? self.taskKind,
            decision: decision ?? self.decision,
            requestId: requestId ?? self.requestId,
            offset: offset ?? self.offset,
            otaId: otaId ?? self.otaId,
            seq: seq ?? self.seq,
            stage: stage ?? self.stage,
            written: written ?? self.written,
            error: error ?? self.error
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADAction: String, Codable, Equatable {
    case adjustBrightness = "adjust_brightness"
    case adjustVolume = "adjust_volume"
    case analyze = "analyze"
    case cancel = "cancel"
    case dump = "dump"
    case mediaNext = "media_next"
    case mediaPlayPause = "media_play_pause"
    case mediaPrev = "media_prev"
    case start = "start"
    case stop = "stop"
    case toggleMute = "toggle_mute"
}

enum ADAgent: String, Codable, Equatable {
    case claudeCode = "claude-code"
    case openclaw = "openclaw"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADCommand
struct ADCommand: Codable, Equatable {
    var type: String

    enum CodingKeys: String, CodingKey {
        case type = "type"
    }
}

// MARK: ADCommand convenience initializers and mutators

extension ADCommand {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADCommand.self, from: data)
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
        type: String? = nil
    ) -> ADCommand {
        return ADCommand(
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

enum ADDecision: String, Codable, Equatable {
    case allow = "allow"
    case deny = "deny"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - ADDevice
struct ADDevice: Codable, Equatable {
    var columns: Double?
    /// "streamdeck" | "streamdeckplus" | "streamdeckmini" | ... — free-form.
    var family: String?
    var id: String
    var name: String
    var rows: Double?

    enum CodingKeys: String, CodingKey {
        case columns = "columns"
        case family = "family"
        case id = "id"
        case name = "name"
        case rows = "rows"
    }
}

// MARK: ADDevice convenience initializers and mutators

extension ADDevice {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(ADDevice.self, from: data)
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
        columns: Double?? = nil,
        family: String?? = nil,
        id: String? = nil,
        name: String? = nil,
        rows: Double?? = nil
    ) -> ADDevice {
        return ADDevice(
            columns: columns ?? self.columns,
            family: family ?? self.family,
            id: id ?? self.id,
            name: name ?? self.name,
            rows: rows ?? self.rows
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

enum ADDirection: String, Codable, Equatable {
    case down = "down"
    case up = "up"
}

enum ADMode: String, Codable, Equatable {
    case acceptEdits = "acceptEdits"
    case modeDefault = "default"
    case plan = "plan"
}

enum ADType: String, Codable, Equatable {
    case apmeRecommend = "apme_recommend"
    case apmeVibe = "apme_vibe"
    case clearSessionFocus = "clear_session_focus"
    case clientRegister = "client_register"
    case diag = "diag"
    case escape = "escape"
    case esp32OtaAck = "esp32_ota_ack"
    case esp32OtaError = "esp32_ota_error"
    case focusSession = "focus_session"
    case interrupt = "interrupt"
    case navigateOption = "navigate_option"
    case permissionDecision = "permission_decision"
    case querySessionTimeline = "query_session_timeline"
    case queryUsage = "query_usage"
    case respond = "respond"
    case reviewRun = "review_run"
    case selectOption = "select_option"
    case sendPrompt = "send_prompt"
    case sessionCommand = "session_command"
    case switchAgent = "switch_agent"
    case switchMode = "switch_mode"
    case utility = "utility"
    case voice = "voice"
}

enum ADValue: Codable, Equatable {
    case double(Double)
    case string(String)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let x = try? container.decode(Double.self) {
            self = .double(x)
            return
        }
        if let x = try? container.decode(String.self) {
            self = .string(x)
            return
        }
        throw DecodingError.typeMismatch(ADValue.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Wrong type for ADValue"))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .double(let x):
            try container.encode(x)
        case .string(let x):
            try container.encode(x)
        }
    }
}

enum ADVerdict: String, Codable, Equatable {
    case approve = "approve"
    case neutral = "neutral"
    case reject = "reject"
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
