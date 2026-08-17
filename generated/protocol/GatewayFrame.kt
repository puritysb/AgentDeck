// To parse the JSON, install Klaxon and do:
//
//   val gatewayFrame = GatewayFrame.fromJson(jsonString)

package dev.agentdeck.generated

import com.beust.klaxon.*

private fun <T> Klaxon.convert(k: kotlin.reflect.KClass<*>, fromJson: (JsonValue) -> T, toJson: (T) -> String, isUnion: Boolean = false) =
    this.converter(object: Converter {
        @Suppress("UNCHECKED_CAST")
        override fun toJson(value: Any)        = toJson(value as T)
        override fun fromJson(jv: JsonValue)   = fromJson(jv) as Any
        override fun canConvert(cls: Class<*>) = cls == k.java || (isUnion && cls.superclass == k.java)
    })

private val klaxon = Klaxon()
    .convert(GatewayEventName::class,     { GatewayEventName.fromValue(it.string!!) },     { "\"${it.value}\"" })
    .convert(GatewayMethodName::class,    { GatewayMethodName.fromValue(it.string!!) },    { "\"${it.value}\"" })
    .convert(Mode::class,                 { Mode.fromValue(it.string!!) },                 { "\"${it.value}\"" })
    .convert(ExecApprovalDecision::class, { ExecApprovalDecision.fromValue(it.string!!) }, { "\"${it.value}\"" })
    .convert(State::class,                { State.fromValue(it.string!!) },                { "\"${it.value}\"" })
    .convert(Status::class,               { Status.fromValue(it.string!!) },               { "\"${it.value}\"" })
    .convert(ConnectResultType::class,    { ConnectResultType.fromValue(it.string!!) },    { "\"${it.value}\"" })
    .convert(GatewayFrameType::class,     { GatewayFrameType.fromValue(it.string!!) },     { "\"${it.value}\"" })
    .convert(GatewayMethodResult::class,  { GatewayMethodResult.fromJson(it) },            { it.toJson() }, true)

/**
 * Client → Gateway: RPC request.
 *
 * Gateway → Client: RPC response (ok=true) or error (ok=false).
 *
 * Gateway → Client: unsolicited event.
 */
data class GatewayFrame (
    val id: String? = null,
    val method: GatewayMethodName? = null,
    val params: GatewayMethodParams? = null,
    val type: GatewayFrameType,
    val error: GatewayError? = null,
    val ok: Boolean? = null,
    val payload: GatewayMethodResult? = null,
    val event: GatewayEventName? = null,

    /**
     * Monotonic sequence number (optional, used for ordering on reconnect).
     */
    val seq: String? = null,

    /**
     * Server-side state version for dedup on replay.
     */
    val stateVersion: String? = null
) {
    public fun toJson() = klaxon.toJsonString(this)

    companion object {
        public fun fromJson(json: String) = klaxon.parse<GatewayFrame>(json)
    }
}

data class GatewayError (
    val code: String,
    val details: Any? = null,
    val message: String
)

enum class GatewayEventName(val value: String) {
    Chat("chat"),
    ConnectChallenge("connect.challenge"),
    ExecApprovalRequested("exec.approval.requested"),
    ExecApprovalResolved("exec.approval.resolved"),
    Health("health"),
    Presence("presence"),
    SessionMessage("session.message"),
    SessionTool("session.tool"),
    SessionsChanged("sessions.changed"),
    Shutdown("shutdown"),
    SystemPresence("system-presence"),
    Tick("tick");

    companion object {
        public fun fromValue(value: String): GatewayEventName = when (value) {
            "chat"                    -> Chat
            "connect.challenge"       -> ConnectChallenge
            "exec.approval.requested" -> ExecApprovalRequested
            "exec.approval.resolved"  -> ExecApprovalResolved
            "health"                  -> Health
            "presence"                -> Presence
            "session.message"         -> SessionMessage
            "session.tool"            -> SessionTool
            "sessions.changed"        -> SessionsChanged
            "shutdown"                -> Shutdown
            "system-presence"         -> SystemPresence
            "tick"                    -> Tick
            else                      -> throw IllegalArgumentException()
        }
    }
}

enum class GatewayMethodName(val value: String) {
    ChatAbort("chat.abort"),
    ChatSend("chat.send"),
    Connect("connect"),
    ExecApprovalList("exec.approval.list"),
    ExecApprovalResolve("exec.approval.resolve"),
    Health("health"),
    LogsTail("logs.tail"),
    ModelsList("models.list"),
    SessionsList("sessions.list"),
    SessionsMessagesSubscribe("sessions.messages.subscribe"),
    SessionsSubscribe("sessions.subscribe"),
    SystemPresence("system-presence");

    companion object {
        public fun fromValue(value: String): GatewayMethodName = when (value) {
            "chat.abort"                  -> ChatAbort
            "chat.send"                   -> ChatSend
            "connect"                     -> Connect
            "exec.approval.list"          -> ExecApprovalList
            "exec.approval.resolve"       -> ExecApprovalResolve
            "health"                      -> Health
            "logs.tail"                   -> LogsTail
            "models.list"                 -> ModelsList
            "sessions.list"               -> SessionsList
            "sessions.messages.subscribe" -> SessionsMessagesSubscribe
            "sessions.subscribe"          -> SessionsSubscribe
            "system-presence"             -> SystemPresence
            else                          -> throw IllegalArgumentException()
        }
    }
}

data class GatewayMethodParams (
    /**
     * Bearer token issued during device pairing.
     */
    val auth: GatewayMethodParamsAuth? = null,

    val caps: List<String>? = null,
    val client: Client? = null,
    val commands: List<String>? = null,

    /**
     * Ed25519 device signature over
     * `v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`.
     */
    val device: DeviceAuth? = null,

    val locale: String? = null,

    /**
     * Upper bound of protocol versions this client supports.
     */
    val maxProtocol: Double? = null,

    /**
     * Lower bound of protocol versions this client supports.
     */
    val minProtocol: Double? = null,

    val permissions: Map<String, Boolean>? = null,
    val role: String? = null,
    val scopes: List<String>? = null,
    val userAgent: String? = null,
    val probe: Boolean? = null,
    val cursor: Double? = null,
    val limit: Double? = null,
    val maxBytes: Double? = null,
    val idempotencyKey: String? = null,
    val message: String? = null,
    val sessionKey: String? = null,

    @Json(name = "runId")
    val runID: String? = null,

    val decision: ExecApprovalDecision? = null,
    val id: String? = null,
    val kind: String? = null,
    val key: String? = null
)

/**
 * Bearer token issued during device pairing.
 */
data class GatewayMethodParamsAuth (
    val bootstrapToken: String? = null,
    val deviceToken: String? = null,
    val password: String? = null,
    val token: String? = null
)

data class Client (
    val deviceFamily: String? = null,
    val displayName: String,
    val id: String,

    @Json(name = "instanceId")
    val instanceID: String? = null,

    val mode: Mode,
    val platform: String,
    val version: String
)

enum class Mode(val value: String) {
    Backend("backend"),
    Frontend("frontend"),
    Node("node"),
    Operator("operator");

    companion object {
        public fun fromValue(value: String): Mode = when (value) {
            "backend"  -> Backend
            "frontend" -> Frontend
            "node"     -> Node
            "operator" -> Operator
            else       -> throw IllegalArgumentException()
        }
    }
}

/**
 * The decisions the Gateway will accept for an exec approval. Mirror of OpenClaw's
 * `isApprovalDecision` / `DEFAULT_EXEC_APPROVAL_DECISIONS`. `'allow'` is NOT a member —
 * sending it is rejected as an invalid decision.
 */
enum class ExecApprovalDecision(val value: String) {
    AllowAlways("allow-always"),
    AllowOnce("allow-once"),
    Deny("deny");

    companion object {
        public fun fromValue(value: String): ExecApprovalDecision = when (value) {
            "allow-always" -> AllowAlways
            "allow-once"   -> AllowOnce
            "deny"         -> Deny
            else           -> throw IllegalArgumentException()
        }
    }
}

/**
 * Ed25519 device signature over
 * `v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`.
 */
data class DeviceAuth (
    val id: String,
    val nonce: String,
    val publicKey: String,
    val signature: String,
    val signedAt: Double
)

sealed class GatewayMethodResult {
    class ConnectResultValue(val value: ConnectResult)                                          : GatewayMethodResult()
    class ExecApprovalRequestedPayloadArrayValue(val value: List<ExecApprovalRequestedPayload>) : GatewayMethodResult()

    public fun toJson(): String = klaxon.toJsonString(when (this) {
        is ConnectResultValue                     -> this.value
        is ExecApprovalRequestedPayloadArrayValue -> this.value
    })

    companion object {
        public fun fromJson(jv: JsonValue): GatewayMethodResult = when (jv.inside) {
            is JsonObject   -> ConnectResultValue(jv.obj?.let { klaxon.parseFromJsonObject<ConnectResult>(it) }!!)
            is JsonArray<*> -> ExecApprovalRequestedPayloadArrayValue(jv.array?.let { klaxon.parseFromJsonArray<ExecApprovalRequestedPayload>(it) }!!)
            else            -> throw IllegalArgumentException()
        }
    }
}

/**
 * Same element shape as the requested event, minus the envelope.
 *
 * `exec.approval.requested` payload. The nested `request` is the real shape; the flat
 * fields are tolerated so a future/legacy Gateway that inlines them still parses instead of
 * silently producing an empty prompt.
 */
data class ExecApprovalRequestedPayload (
    @Json(name = "agentId")
    val agentID: String? = null,

    /**
     * Decisions this specific request permits (policy may drop allow-always).
     */
    val allowedDecisions: List<String>? = null,

    /**
     * Approval POLICY ("on-miss" | "always" | …), never a question.
     */
    val ask: String? = null,

    /**
     * Sanitized command display text — the thing the user is approving.
     */
    val command: String? = null,

    /**
     * Gateway-side static analysis summary of the command.
     */
    val commandAnalysis: String? = null,

    val commandArgv: List<String>? = null,

    /**
     * Non-node hosts send a preview instead of the full command.
     */
    val commandPreview: String? = null,

    @Json(name = "createdAtMs")
    val createdAtMS: Double? = null,

    val cwd: String? = null,

    @Json(name = "expiresAtMs")
    val expiresAtMS: Double? = null,

    val host: String? = null,
    val id: String,
    val request: ExecApprovalRequestBody? = null,
    val resolvedPath: String? = null,
    val security: String? = null,
    val sessionKey: String? = null,
    val unavailableDecisions: List<String>? = null,

    /**
     * Human-readable risk note, when the Gateway produced one.
     */
    val warningText: String? = null
)

/**
 * The `request` body OpenClaw nests inside the requested event.
 */
data class ExecApprovalRequestBody (
    @Json(name = "agentId")
    val agentID: String? = null,

    /**
     * Decisions this specific request permits (policy may drop allow-always).
     */
    val allowedDecisions: List<String>? = null,

    /**
     * Approval POLICY ("on-miss" | "always" | …), never a question.
     */
    val ask: String? = null,

    /**
     * Sanitized command display text — the thing the user is approving.
     */
    val command: String? = null,

    /**
     * Gateway-side static analysis summary of the command.
     */
    val commandAnalysis: String? = null,

    val commandArgv: List<String>? = null,

    /**
     * Non-node hosts send a preview instead of the full command.
     */
    val commandPreview: String? = null,

    val cwd: String? = null,
    val host: String? = null,
    val resolvedPath: String? = null,
    val security: String? = null,
    val sessionKey: String? = null,
    val unavailableDecisions: List<String>? = null,

    /**
     * Human-readable risk note, when the Gateway produced one.
     */
    val warningText: String? = null
)

/**
 * The Gateway answers `{ ok: true }`; `resolved` is kept for older builds.
 *
 * Same element shape as the requested event, minus the envelope.
 *
 * `exec.approval.requested` payload. The nested `request` is the real shape; the flat
 * fields are tolerated so a future/legacy Gateway that inlines them still parses instead of
 * silently producing an empty prompt.
 *
 * `exec.approval.resolved` payload (`buildResolvedEvent` in exec-approval).
 */
data class ConnectResult (
    val accepted: Boolean? = null,
    val auth: ConnectResultAuth? = null,
    val expiresAt: Double? = null,
    val features: Features? = null,
    val policy: Policy? = null,
    val protocol: Double? = null,
    val server: Server? = null,
    val sessionToken: String? = null,
    val type: ConnectResultType? = null,
    val checks: List<Check>? = null,

    @Json(name = "durationMs")
    val durationMS: Double? = null,

    val ok: Boolean? = null,
    val status: String? = null,
    val ts: Double? = null,
    val models: List<OpenClawModel>? = null,
    val cursor: Double? = null,
    val file: String? = null,
    val lines: List<String>? = null,
    val reset: Boolean? = null,
    val size: Double? = null,
    val truncated: Boolean? = null,

    @Json(name = "runId")
    val runID: String? = null,

    val aborted: Boolean? = null,
    val resolved: Boolean? = null,
    val sessions: List<GatewaySession>? = null,
    val subscribed: Boolean? = null,
    val key: String? = null,
    val devices: List<GatewayPresenceEntry>? = null,
    val entries: List<GatewayPresenceEntry>? = null,
    val nonce: String? = null,

    /**
     * Incremental text chunk (delta state).
     */
    val delta: String? = null,

    /**
     * Error message (error state).
     */
    val error: String? = null,

    /**
     * Token accounting (final state).
     */
    val inputTokens: Double? = null,

    /**
     * Model identifier used for this turn.
     */
    @Json(name = "modelId")
    val modelID: String? = null,

    /**
     * Session identifier when Gateway creates a new session mid-chat.
     */
    @Json(name = "newSessionId")
    val newSessionID: String? = null,

    val outputTokens: Double? = null,

    /**
     * User prompt text, as echoed by Gateway on first delta.
     */
    val prompt: String? = null,

    /**
     * Full assembled response (final state).
     */
    val response: String? = null,

    val sessionKey: String? = null,
    val state: State? = null,

    /**
     * Tool invocations observed in this turn.
     */
    val tools: List<ChatToolInvocation>? = null,

    val content: String? = null,
    val message: Any? = null,
    val role: String? = null,
    val text: String? = null,
    val input: Any? = null,
    val name: String? = null,
    val output: Any? = null,
    val tool: String? = null,
    val reason: String? = null,

    @Json(name = "agentId")
    val agentID: String? = null,

    /**
     * Decisions this specific request permits (policy may drop allow-always).
     */
    val allowedDecisions: List<String>? = null,

    /**
     * Approval POLICY ("on-miss" | "always" | …), never a question.
     */
    val ask: String? = null,

    /**
     * Sanitized command display text — the thing the user is approving.
     */
    val command: String? = null,

    /**
     * Gateway-side static analysis summary of the command.
     */
    val commandAnalysis: String? = null,

    val commandArgv: List<String>? = null,

    /**
     * Non-node hosts send a preview instead of the full command.
     */
    val commandPreview: String? = null,

    @Json(name = "createdAtMs")
    val createdAtMS: Double? = null,

    val cwd: String? = null,

    @Json(name = "expiresAtMs")
    val expiresAtMS: Double? = null,

    val host: String? = null,
    val id: String? = null,
    val request: ExecApprovalRequestBody? = null,
    val resolvedPath: String? = null,
    val security: String? = null,
    val unavailableDecisions: List<String>? = null,

    /**
     * Human-readable risk note, when the Gateway produced one.
     */
    val warningText: String? = null,

    val decision: String? = null,
    val resolvedBy: String? = null,

    @Json(name = "clientId")
    val clientID: String? = null,

    val connected: Boolean? = null,

    @Json(name = "deviceId")
    val deviceID: String? = null,

    val serverTime: Double? = null,
    val restartAt: Double? = null
)

data class ConnectResultAuth (
    val deviceToken: String,
    val deviceTokens: List<DeviceToken>? = null,

    @Json(name = "issuedAtMs")
    val issuedAtMS: Double? = null,

    val role: String,
    val scopes: List<String>
)

data class DeviceToken (
    val deviceToken: String,

    @Json(name = "issuedAtMs")
    val issuedAtMS: Double? = null,

    val role: String,
    val scopes: List<String>
)

data class Check (
    val id: String? = null,
    val message: String? = null,
    val name: String? = null,
    val status: String? = null
)

data class GatewayPresenceEntry (
    @Json(name = "clientId")
    val clientID: String? = null,

    val connected: Boolean,

    @Json(name = "deviceId")
    val deviceID: String? = null,

    val displayName: String? = null,
    val roles: List<String>? = null,
    val scopes: List<String>? = null
)

data class Features (
    val events: List<String>,
    val methods: List<String>
)

data class OpenClawModel (
    val available: Boolean? = null,
    val id: String? = null,
    val key: String? = null,
    val missing: Boolean? = null,
    val name: String? = null,
    val provider: String? = null,
    val tags: List<String>? = null,
    val title: String? = null
)

data class Policy (
    val maxPayload: Double? = null,

    @Json(name = "tickIntervalMs")
    val tickIntervalMS: Double? = null
)

data class Server (
    @Json(name = "connId")
    val connID: String,

    val version: String
)

data class GatewaySession (
    val displayName: String? = null,
    val key: String,
    val kind: String? = null,
    val label: String? = null,

    @Json(name = "sessionId")
    val sessionID: String? = null,

    val updatedAt: Double? = null
)

enum class State(val value: String) {
    Aborted("aborted"),
    Delta("delta"),
    Error("error"),
    Final("final");

    companion object {
        public fun fromValue(value: String): State = when (value) {
            "aborted" -> Aborted
            "delta"   -> Delta
            "error"   -> Error
            "final"   -> Final
            else      -> throw IllegalArgumentException()
        }
    }
}

data class ChatToolInvocation (
    val input: Any? = null,
    val name: String,
    val output: Any? = null,
    val status: Status? = null
)

enum class Status(val value: String) {
    Error("error"),
    Pending("pending"),
    Success("success");

    companion object {
        public fun fromValue(value: String): Status = when (value) {
            "error"   -> Error
            "pending" -> Pending
            "success" -> Success
            else      -> throw IllegalArgumentException()
        }
    }
}

enum class ConnectResultType(val value: String) {
    HelloOk("hello-ok");

    companion object {
        public fun fromValue(value: String): ConnectResultType = when (value) {
            "hello-ok" -> HelloOk
            else       -> throw IllegalArgumentException()
        }
    }
}

enum class GatewayFrameType(val value: String) {
    Event("event"),
    Req("req"),
    Res("res");

    companion object {
        public fun fromValue(value: String): GatewayFrameType = when (value) {
            "event" -> Event
            "req"   -> Req
            "res"   -> Res
            else    -> throw IllegalArgumentException()
        }
    }
}
