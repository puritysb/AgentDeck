// To parse the JSON, install Klaxon and do:
//
//   val bridgeEvent = BridgeEvent.fromJson(jsonString)

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
    .convert(AgentType::class,           { AgentType.fromValue(it.string!!) },           { "\"${it.value}\"" })
    .convert(BillingType::class,         { BillingType.fromValue(it.string!!) },         { "\"${it.value}\"" })
    .convert(Mode::class,                { Mode.fromValue(it.string!!) },                { "\"${it.value}\"" })
    .convert(EncoderType::class,         { EncoderType.fromValue(it.string!!) },         { "\"${it.value}\"" })
    .convert(VoiceState::class,          { VoiceState.fromValue(it.string!!) },          { "\"${it.value}\"" })
    .convert(EntryStatus::class,         { EntryStatus.fromValue(it.string!!) },         { "\"${it.value}\"" })
    .convert(SummaryKind::class,         { SummaryKind.fromValue(it.string!!) },         { "\"${it.value}\"" })
    .convert(TimelineEntryType::class,   { TimelineEntryType.fromValue(it.string!!) },   { "\"${it.value}\"" })
    .convert(GatewayAuthStatus::class,   { GatewayAuthStatus.fromValue(it.string!!) },   { "\"${it.value}\"" })
    .convert(Kind::class,                { Kind.fromValue(it.string!!) },                { "\"${it.value}\"" })
    .convert(PermissionMode::class,      { PermissionMode.fromValue(it.string!!) },      { "\"${it.value}\"" })
    .convert(PromptType::class,          { PromptType.fromValue(it.string!!) },          { "\"${it.value}\"" })
    .convert(Risk::class,                { Risk.fromValue(it.string!!) },                { "\"${it.value}\"" })
    .convert(Layer::class,               { Layer.fromValue(it.string!!) },               { "\"${it.value}\"" })
    .convert(Outcome::class,             { Outcome.fromValue(it.string!!) },             { "\"${it.value}\"" })
    .convert(ControlMode::class,         { ControlMode.fromValue(it.string!!) },         { "\"${it.value}\"" })
    .convert(ReviewStatus::class,        { ReviewStatus.fromValue(it.string!!) },        { "\"${it.value}\"" })
    .convert(State::class,               { State.fromValue(it.string!!) },               { "\"${it.value}\"" })
    .convert(BridgeEventStatus::class,   { BridgeEventStatus.fromValue(it.string!!) },   { "\"${it.value}\"" })
    .convert(TokenStatus::class,         { TokenStatus.fromValue(it.string!!) },         { "\"${it.value}\"" })
    .convert(Type::class,                { Type.fromValue(it.string!!) },                { "\"${it.value}\"" })
    .convert(VoiceAssistantState::class, { VoiceAssistantState.fromValue(it.string!!) }, { "\"${it.value}\"" })

/**
 * Bridge → clients — fires when a run completes evaluation (layer 1 or 2).
 *
 * Bridge → clients — scorecard refresh (broadcast after eval completes or on demand).
 *
 * Bridge → clients — model recommendation for the next task (on-demand / context-aware).
 *
 * On-demand independent review lifecycle. Triggered by the REVIEW deck button
 * (ReviewRunCommand) — the daemon reviews the session's latest work with an independent
 * judge model (Node: working-tree diff; Swift: APME trajectory) and reports risk findings.
 * Needs no agent control, so it works for every session type including observed codex.
 */
data class BridgeEvent (
    val agentCapabilities: AgentCapabilities? = null,
    val agentType: AgentType? = null,

    /**
     * Local Antigravity IDE quota summary, when available
     */
    val antigravityStatus: AntigravityStatusInfo? = null,

    val billingType: BillingType? = null,
    val currentTool: String? = null,
    val cursorIndex: Double? = null,
    val effortLevel: String? = null,

    /**
     * Session explicitly focused by the user; visual selection should use this.
     *
     * Session explicitly focused when the daemon relayed this event.
     */
    @Json(name = "focusedSessionId")
    val focusedSessionID: String? = null,

    /**
     * Human-readable OpenClaw auth/pairing diagnostic
     */
    val gatewayAuthMessage: String? = null,

    /**
     * OpenClaw device pairing request id, when Gateway requires approval
     */
    @Json(name = "gatewayAuthRequestId")
    val gatewayAuthRequestID: String? = null,

    /**
     * OpenClaw Gateway auth/pairing state
     */
    val gatewayAuthStatus: GatewayAuthStatus? = null,

    /**
     * OpenClaw Gateway reachability (port 18789)
     */
    val gatewayAvailable: Boolean? = null,

    /**
     * OpenClaw Gateway authenticated adapter connection
     */
    val gatewayConnected: Boolean? = null,

    /**
     * OpenClaw Gateway has doctor warnings/errors
     */
    val gatewayHasError: Boolean? = null,

    /**
     * MLX local server model list
     */
    val mlxModels: List<String>? = null,

    val modelCatalog: List<ModelCatalogEntry>? = null,
    val modelName: String? = null,

    /**
     * Daemon-owned hardware/module health, intentionally loose for cross-version clients
     */
    val moduleHealth: Map<String, Any?>? = null,

    val navigable: Boolean? = null,

    /**
     * Ollama process status + running models
     */
    val ollamaStatus: OllamaStatus? = null,

    val options: List<PromptOption>? = null,

    /**
     * Authenticated WS URL for remote pairing (ws://ip:port?token=hex)
     */
    @Json(name = "pairingUrl")
    val pairingURL: String? = null,

    val permissionMode: PermissionMode? = null,
    val projectName: String? = null,
    val promptType: PromptType? = null,
    val question: String? = null,

    @Json(name = "remoteUrl")
    val remoteURL: String? = null,

    /**
     * Set when the focused session has a gated PreToolUse permission pending device approval —
     * clients reply with `permission_decision { requestId }` instead of `select_option`. See
     * bridge/src/permission-resolver.ts.
     */
    @Json(name = "requestId")
    val requestID: String? = null,

    /**
     * Session ID associated with this state payload; may move with hook activity.
     *
     * Session that produced these options. Required for safe device actions.
     *
     * Which session the capture targets, for daemon host push-to-talk. Absent on the legacy
     * session-bridge voice path (implicitly that bridge's own session).
     *
     * Set when this history is a reply to `query_session_timeline` — scopes the entries to one
     * session so reconnecting glance devices (XTeink X3) can fill a per-session Detail view on
     * demand instead of waiting for live events.
     */
    @Json(name = "sessionId")
    val sessionID: String? = null,

    val sessionStatus: OcSessionStatus? = null,
    val state: State? = null,

    /**
     * Subscription-backed authenticated services
     */
    val subscriptions: List<SubscriptionInfo>? = null,

    val suggestedPrompt: String? = null,
    val toolInput: String? = null,
    val toolProgress: String? = null,
    val type: Type,

    /**
     * LLM response text (speaking)
     */
    val voiceAssistantResponseText: String? = null,

    /**
     * Voice assistant pipeline state (wake word → STT → LLM → TTS)
     */
    val voiceAssistantState: VoiceAssistantState? = null,

    /**
     * Transcribed user speech (processing/speaking)
     */
    val voiceAssistantText: String? = null,

    /**
     * Number of OpenClaw backend worker sessions (multi-agent)
     */
    val workerSessionCount: Double? = null,

    @Json(name = "codexAccountId")
    val codexAccountID: String? = null,

    val codexAuthMode: String? = null,
    val codexLastRefreshAt: String? = null,
    val codexPlanType: String? = null,
    val codexRateLimits: CodexRateLimits? = null,
    val codexSubscriptionActiveUntil: String? = null,
    val codexWebAuthConnected: Boolean? = null,
    val costLimit: Double? = null,
    val costSpent: Double? = null,
    val estimatedCostUsd: Double? = null,
    val extraUsageEnabled: Boolean? = null,
    val extraUsageMonthlyLimit: Double? = null,
    val extraUsageUsedCredits: Double? = null,
    val extraUsageUtilization: Double? = null,
    val fiveHourPercent: Double? = null,
    val fiveHourResetsAt: String? = null,
    val inputTokens: Double? = null,
    val oauthConnected: Boolean? = null,
    val outputTokens: Double? = null,
    val resetDate: String? = null,
    val resetTime: String? = null,
    val scopedLimits: List<ScopedUsageLimit>? = null,

    @Json(name = "sessionDurationSec")
    val sessionDurationSEC: Double? = null,

    val sessionPercent: Double? = null,
    val sevenDayPercent: Double? = null,
    val sevenDayResetsAt: String? = null,
    val tokenStatus: TokenStatus? = null,
    val toolCalls: Double? = null,
    val usageStale: Boolean? = null,
    val status: BridgeEventStatus? = null,

    /**
     * Transcribed user speech
     */
    val text: String? = null,

    val error: String? = null,

    @Json(name = "deviceId")
    val deviceID: String? = null,

    /**
     * LLM response text
     */
    val responseText: String? = null,

    val timestamp: Double? = null,

    /**
     * How to dim on sleep. Absent ⇒ legacy full-off.
     */
    val dim: DisplayDimInstruction? = null,

    val displayOn: Boolean? = null,
    val sessions: List<SessionInfo>? = null,
    val encoders: List<EncoderSlotState>? = null,
    val takeoverActive: Boolean? = null,
    val buttons: List<DeckSlotConfig>? = null,
    val entry: TimelineEntry? = null,
    val upsert: Boolean? = null,
    val entries: List<TimelineEntry>? = null,
    val run: ApmeRunSummary? = null,
    val scorecards: List<ApmeModelScorecard>? = null,
    val candidates: List<ApmeRecommendation>? = null,
    val taskKind: String? = null,
    val message: String? = null,
    val findings: Double? = null,

    /**
     * Local HTML report path (Node daemon writes + opens it in a browser).
     */
    val reportPath: String? = null,

    val risk: Risk? = null,
    val summary: String? = null,
    val md5: String? = null,

    @Json(name = "otaId")
    val otaID: String? = null,

    val size: Double? = null,
    val data: String? = null,
    val offset: Double? = null,
    val seq: Double? = null
) {
    public fun toJson() = klaxon.toJsonString(this)

    companion object {
        public fun fromJson(json: String) = klaxon.parse<BridgeEvent>(json)
    }
}

data class AgentCapabilities (
    val displayName: String,

    /**
     * OAuth-based API usage tracking
     */
    @Json(name = "hasApiUsage")
    val hasAPIUsage: Boolean,

    /**
     * Diff review UI (view/apply/deny)
     */
    val hasDiffReview: Boolean,

    /**
     * CLI-based model catalog (openclaw models list)
     */
    val hasModelCatalog: Boolean,

    /**
     * Plan/AcceptEdits/Default mode switching
     */
    val hasModeSwitching: Boolean,

    /**
     * Arrow-key navigable prompts
     */
    val hasNavigablePrompts: Boolean,

    /**
     * Numbered option lists with arrow navigation
     */
    val hasOptionLists: Boolean,

    /**
     * Ghost text suggested prompts
     */
    val hasSuggestedPrompts: Boolean,

    /**
     * PTY terminal attachment (stdin/stdout proxy)
     */
    val hasTerminal: Boolean,

    val type: AgentType
)

enum class AgentType(val value: String) {
    Antigravity("antigravity"),
    ClaudeCode("claude-code"),
    CodexApp("codex-app"),
    CodexCLI("codex-cli"),
    Monitor("monitor"),
    Openclaw("openclaw"),
    Opencode("opencode");

    companion object {
        public fun fromValue(value: String): AgentType = when (value) {
            "antigravity" -> Antigravity
            "claude-code" -> ClaudeCode
            "codex-app"   -> CodexApp
            "codex-cli"   -> CodexCLI
            "monitor"     -> Monitor
            "openclaw"    -> Openclaw
            "opencode"    -> Opencode
            else          -> throw IllegalArgumentException()
        }
    }
}

/**
 * Local Antigravity IDE quota summary, when available
 */
data class AntigravityStatusInfo (
    val availableCredits: Double? = null,
    val minimumCreditAmountForUsage: Double? = null,
    val planName: String? = null,
    val subscriptionActiveUntil: String? = null
)

enum class BillingType(val value: String) {
    API("api"),
    Subscription("subscription"),
    Unknown("unknown");

    companion object {
        public fun fromValue(value: String): BillingType = when (value) {
            "api"          -> API
            "subscription" -> Subscription
            "unknown"      -> Unknown
            else           -> throw IllegalArgumentException()
        }
    }
}

data class DeckSlotConfig (
    val actionType: String? = null,
    val settings: Map<String, Any?>? = null,
    val slot: Double,
    val action: String? = null,
    val badge: String? = null,
    val bgColor: String? = null,
    val dim: Boolean? = null,
    val enabled: Boolean? = null,
    val icon: String? = null,
    val subtitle: String? = null,
    val textColor: String? = null,
    val title: String? = null
)

data class ApmeRecommendation (
    val agentType: AgentType,
    val confidence: Double,
    val expectedCostUsd: Double,
    val expectedScore: Double,

    @Json(name = "modelId")
    val modelID: String,

    val rationale: String
)

/**
 * Codex usage limits parsed from local rollout files. `primary` is the short (5h-style)
 * window, `secondary` the long (weekly) window — same idea as the Claude 5h/7d gauges.
 * Credit-based plans report `primary`/`secondary` as null and convey usage via `credits` +
 * `limitId` instead.
 */
data class CodexRateLimits (
    /**
     * ISO-8601 mtime of the rollout file this snapshot was read from. A secondary freshness
     * anchor — the per-window `stale` flag is the authoritative signal.
     */
    val capturedAt: String? = null,

    /**
     * Credit balance for credit-based plans (present when windows are null).
     */
    val credits: CodexCredits? = null,

    /**
     * Limit identifier reported by Codex (e.g. "premium" for credit-based plans).
     */
    @Json(name = "limitId")
    val limitID: String? = null,

    /**
     * Plan tier reported alongside the limits (e.g. "plus", "pro").
     */
    val planType: String? = null,

    val primary: CodexRateLimitWindow? = null,
    val secondary: CodexRateLimitWindow? = null
)

/**
 * Credit balance for credit-based plans (present when windows are null).
 *
 * Codex credits balance, the metering Codex reports for credit-based plans (e.g. `limit_id:
 * "premium"`) where the rolling 5h/7d windows are null. Mirrors the rollout's
 * `rate_limits.credits` block.
 */
data class CodexCredits (
    /**
     * Remaining balance — Codex reports this as a string (e.g. "0").
     */
    val balance: String? = null,

    /**
     * Whether the plan has any credit allowance configured.
     */
    val hasCredits: Boolean,

    /**
     * Unlimited credits (no balance ceiling).
     */
    val unlimited: Boolean
)

/**
 * One Codex (ChatGPT) rate-limit window, mirroring the Claude 5h/7d shape. Sourced from the
 * user's own local Codex session rollout files — Codex CLI writes these snapshots itself,
 * so this is local-file data, not an API call.
 */
data class CodexRateLimitWindow (
    /**
     * ISO-8601 reset instant (converted from the rollout's unix `resets_at`).
     */
    val resetsAt: String? = null,

    /**
     * True when this window's snapshot has expired (its `resets_at` slid into the past with no
     * fresher Codex activity). The passive rollout read is frozen, so the percent is
     * last-known-only — renderers should dim the gauge and show a "stale" marker instead of a
     * misleading "now" countdown. Set centrally in `buildUsageEvent`; `resetsAt` is cleared at
     * the same time so no formatter prints "now".
     */
    val stale: Boolean? = null,

    val usedPercent: Double,

    /**
     * Rolling window length in minutes (primary ≈ 300 = 5h, secondary ≈ 10080 = 7d).
     */
    val windowMinutes: Double
)

/**
 * How to dim on sleep. Absent ⇒ legacy full-off.
 *
 * Per-broadcast instruction telling downstream devices HOW to dim when the host display
 * sleeps. Resolved by the daemon from the `displaySleepDim` settings.json key and embedded
 * in every `display_state` event so that Pixoo / D200H / ESP32 dumb-apply a single
 * consistent snapshot. Absent ⇒ legacy behavior (full-off when displayOn=false).
 */
data class DisplayDimInstruction (
    /**
     * Master toggle. false ⇒ leave devices at their normal brightness.
     */
    val enabled: Boolean,

    /**
     * Minimum-brightness percent (1-100). Ignored when mode='off'.
     *
     * This is the requested level, not a promise. Consumers clamp it up to their own hardware
     * floor (Pixoo 1, iDotMatrix 5, Timebox 0 because brightness is baked into the frame), so
     * the same `level` legitimately renders differently across panels. Do not "fix" that
     * divergence by forcing a shared floor — it would push devices below what their firmware
     * accepts.
     */
    val level: Double,

    /**
     * 'off' ⇒ the panel must read as dark; 'min' ⇒ dim to `level` but stay readable.
     *
     * Consumers must branch on this rather than inferring intent from the resulting brightness
     * number: a device whose hardware floor is 5 cannot distinguish "off" from "min at level 5"
     * by value alone. Where a floor makes brightness unable to express dark — the iDotMatrix
     * firmware accepts 5-100, and there is no screen-off command — 'off' means pushing black
     * pixels, not the lowest brightness.
     */
    val mode: Mode
)

/**
 * 'off' ⇒ the panel must read as dark; 'min' ⇒ dim to `level` but stay readable.
 *
 * Consumers must branch on this rather than inferring intent from the resulting brightness
 * number: a device whose hardware floor is 5 cannot distinguish "off" from "min at level 5"
 * by value alone. Where a floor makes brightness unable to express dark — the iDotMatrix
 * firmware accepts 5-100, and there is no screen-off command — 'off' means pushing black
 * pixels, not the lowest brightness.
 */
enum class Mode(val value: String) {
    Min("min"),
    Off("off");

    companion object {
        public fun fromValue(value: String): Mode = when (value) {
            "min" -> Min
            "off" -> Off
            else  -> throw IllegalArgumentException()
        }
    }
}

data class EncoderSlotState (
    val accentColor: String? = null,
    val counter: String? = null,
    val detail: String? = null,
    val encoderType: EncoderType? = null,
    val header: String? = null,
    val icon: String? = null,
    val progress: Double? = null,

    @Json(name = "recordingMs")
    val recordingMS: Double? = null,

    val slot: Double,
    val transcription: String? = null,
    val value: String? = null,
    val voiceState: VoiceState? = null,
    val actionType: String? = null,
    val settings: Map<String, Any?>? = null
)

enum class EncoderType(val value: String) {
    Action("action"),
    Usage("usage"),
    Utility("utility"),
    Voice("voice");

    companion object {
        public fun fromValue(value: String): EncoderType = when (value) {
            "action"  -> Action
            "usage"   -> Usage
            "utility" -> Utility
            "voice"   -> Voice
            else      -> throw IllegalArgumentException()
        }
    }
}

enum class VoiceState(val value: String) {
    Error("error"),
    Idle("idle"),
    Recording("recording"),
    Review("review"),
    Transcribing("transcribing");

    companion object {
        public fun fromValue(value: String): VoiceState = when (value) {
            "error"        -> Error
            "idle"         -> Idle
            "recording"    -> Recording
            "review"       -> Review
            "transcribing" -> Transcribing
            else           -> throw IllegalArgumentException()
        }
    }
}

data class TimelineEntry (
    val agentType: String? = null,

    @Json(name = "approvalId")
    val approvalID: String? = null,

    val automated: Boolean? = null,

    /**
     * Only on task_end. Why the task closed.
     */
    val boundarySignal: String? = null,

    val detail: String? = null,
    val endedAt: Double? = null,
    val projectName: String? = null,
    val raw: String,
    val repeatCount: Double? = null,

    @Json(name = "runId")
    val runID: String? = null,

    @Json(name = "sessionId")
    val sessionID: String? = null,

    val startedAt: Double? = null,
    val status: EntryStatus? = null,

    /**
     * How the row's `raw` summary was produced. Lets clients decide whether the detail pane is
     * worth showing — when `'none'`, detail is just the unfiltered response that the heuristic
     * couldn't summarize, and showing it duplicates content rather than adding value.   -
     * `'llm'`     : LLM-summarized (clean, short, distinct from detail)   - `'heuristic'`:
     * topic-hint extracted from response or prompt   - `'none'`    : last-resort fallback
     * (literal "Completed", bare tool name, etc.)   - `'progress'`: non-terminal assistant
     * status update (work still running)
     */
    val summaryKind: SummaryKind? = null,

    val taskCategory: String? = null,

    /**
     * APME task id. Set on task_start/task_end and on every turn entry inside the task scope.
     */
    @Json(name = "taskId")
    val taskID: String? = null,

    val taskOutcome: String? = null,

    /**
     * Per-task evaluation result, attached when the task_judge resolves (always AFTER the
     * initial task_end emit — clients upsert the existing row by (type='task_end', taskId) and
     * merge these four fields).
     *
     * - `taskScore`   : 0..1 composite (matches `tasks.composite_score`)   - `taskOutcome` :
     * terminal outcome string from `bridge/src/apme/outcome.ts`     (`'committed' | 'abandoned'
     * | 'iterated' | 'ab_winner' | 'ab_loser'     | 'interrupted' | 'exploratory' |
     * 'pending'`). UIs collapse into     three visual classes — success / fail / partial /
     * pending — and pick     the badge color via design-system status tokens.   -
     * `taskCategory`: task_rollup category ('general' | 'conversation' | …)   - `taskSummary` :
     * one-line judge summary
     */
    val taskScore: Double? = null,

    val taskSummary: String? = null,
    val ts: Double,
    val type: TimelineEntryType
)

enum class EntryStatus(val value: String) {
    Approved("approved"),
    Denied("denied"),
    Pending("pending");

    companion object {
        public fun fromValue(value: String): EntryStatus = when (value) {
            "approved" -> Approved
            "denied"   -> Denied
            "pending"  -> Pending
            else       -> throw IllegalArgumentException()
        }
    }
}

/**
 * How the row's `raw` summary was produced. Lets clients decide whether the detail pane is
 * worth showing — when `'none'`, detail is just the unfiltered response that the heuristic
 * couldn't summarize, and showing it duplicates content rather than adding value.   -
 * `'llm'`     : LLM-summarized (clean, short, distinct from detail)   - `'heuristic'`:
 * topic-hint extracted from response or prompt   - `'none'`    : last-resort fallback
 * (literal "Completed", bare tool name, etc.)   - `'progress'`: non-terminal assistant
 * status update (work still running)
 */
enum class SummaryKind(val value: String) {
    Heuristic("heuristic"),
    Llm("llm"),
    None("none"),
    Progress("progress");

    companion object {
        public fun fromValue(value: String): SummaryKind = when (value) {
            "heuristic" -> Heuristic
            "llm"       -> Llm
            "none"      -> None
            "progress"  -> Progress
            else        -> throw IllegalArgumentException()
        }
    }
}

/**
 * Shared timeline types and log parser for OpenClaw mode. Used by both bridge
 * (BridgeLogStream) and plugin (LogStream).
 */
enum class TimelineEntryType(val value: String) {
    ChatEnd("chat_end"),
    ChatResponse("chat_response"),
    ChatStart("chat_start"),
    Error("error"),
    EvalResult("eval_result"),
    MemoryRecall("memory_recall"),
    ModelCall("model_call"),
    ModelResponse("model_response"),
    Scheduled("scheduled"),
    TaskEnd("task_end"),
    TaskMilestone("task_milestone"),
    TaskStart("task_start"),
    ToolExec("tool_exec"),
    ToolRequest("tool_request"),
    ToolResolved("tool_resolved"),
    UserAction("user_action");

    companion object {
        public fun fromValue(value: String): TimelineEntryType = when (value) {
            "chat_end"       -> ChatEnd
            "chat_response"  -> ChatResponse
            "chat_start"     -> ChatStart
            "error"          -> Error
            "eval_result"    -> EvalResult
            "memory_recall"  -> MemoryRecall
            "model_call"     -> ModelCall
            "model_response" -> ModelResponse
            "scheduled"      -> Scheduled
            "task_end"       -> TaskEnd
            "task_milestone" -> TaskMilestone
            "task_start"     -> TaskStart
            "tool_exec"      -> ToolExec
            "tool_request"   -> ToolRequest
            "tool_resolved"  -> ToolResolved
            "user_action"    -> UserAction
            else             -> throw IllegalArgumentException()
        }
    }
}

/**
 * OpenClaw Gateway auth/pairing state
 */
enum class GatewayAuthStatus(val value: String) {
    ApprovalPending("approval_pending"),
    AuthFailed("auth_failed"),
    Connected("connected"),
    DeviceAuthInvalid("device_auth_invalid"),
    GatewayNotFound("gateway_not_found"),
    GatewayReachable("gateway_reachable"),
    GatewayTokenMissing("gateway_token_missing"),
    PairingRequired("pairing_required"),
    TokenMismatch("token_mismatch"),
    UnsupportedProtocol("unsupported_protocol");

    companion object {
        public fun fromValue(value: String): GatewayAuthStatus = when (value) {
            "approval_pending"      -> ApprovalPending
            "auth_failed"           -> AuthFailed
            "connected"             -> Connected
            "device_auth_invalid"   -> DeviceAuthInvalid
            "gateway_not_found"     -> GatewayNotFound
            "gateway_reachable"     -> GatewayReachable
            "gateway_token_missing" -> GatewayTokenMissing
            "pairing_required"      -> PairingRequired
            "token_mismatch"        -> TokenMismatch
            "unsupported_protocol"  -> UnsupportedProtocol
            else                    -> throw IllegalArgumentException()
        }
    }
}

data class ModelCatalogEntry (
    val available: Boolean,
    val key: String,
    val name: String,
    val role: String
)

/**
 * Ollama process status + running models
 */
data class OllamaStatus (
    val available: Boolean,
    val models: List<OllamaModel>
)

data class OllamaModel (
    val name: String,
    val size: Double,

    @Json(name = "sizeVram")
    val sizeVRAM: Double
)

data class PromptOption (
    val index: Double,
    val kind: Kind? = null,
    val label: String,
    val recommended: Boolean? = null,
    val selected: Boolean? = null,
    val shortcut: String? = null
)

enum class Kind(val value: String) {
    Choice("choice"),
    FreeformInput("freeform_input");

    companion object {
        public fun fromValue(value: String): Kind = when (value) {
            "choice"         -> Choice
            "freeform_input" -> FreeformInput
            else             -> throw IllegalArgumentException()
        }
    }
}

enum class PermissionMode(val value: String) {
    AcceptEdits("acceptEdits"),
    BypassPermissions("bypassPermissions"),
    Default("default"),
    DontAsk("dontAsk"),
    Plan("plan");

    companion object {
        public fun fromValue(value: String): PermissionMode = when (value) {
            "acceptEdits"       -> AcceptEdits
            "bypassPermissions" -> BypassPermissions
            "default"           -> Default
            "dontAsk"           -> DontAsk
            "plan"              -> Plan
            else                -> throw IllegalArgumentException()
        }
    }
}

enum class PromptType(val value: String) {
    DiffReview("diff_review"),
    MultiSelect("multi_select"),
    YesNo("yes_no"),
    YesNoAlways("yes_no_always");

    companion object {
        public fun fromValue(value: String): PromptType = when (value) {
            "diff_review"   -> DiffReview
            "multi_select"  -> MultiSelect
            "yes_no"        -> YesNo
            "yes_no_always" -> YesNoAlways
            else            -> throw IllegalArgumentException()
        }
    }
}

/**
 * Last review verdict (with reviewFindings) — devices render "risk: low · 2" on the REVIEW
 * tile.
 */
enum class Risk(val value: String) {
    High("high"),
    Low("low"),
    Medium("medium");

    companion object {
        public fun fromValue(value: String): Risk = when (value) {
            "high"   -> High
            "low"    -> Low
            "medium" -> Medium
            else     -> throw IllegalArgumentException()
        }
    }
}

/**
 * A run that has finished evaluation.
 */
data class ApmeRunSummary (
    val agentType: AgentType,
    val compositeScore: Double? = null,
    val costUsd: Double? = null,
    val endedAt: Double? = null,
    val evals: List<ApmeEvalRow>,
    val exitCode: Double? = null,
    val inputTokens: Double? = null,

    @Json(name = "modelId")
    val modelID: String? = null,

    val outcome: Outcome? = null,
    val outputTokens: Double? = null,
    val overallScore: Double? = null,
    val projectName: String? = null,

    @Json(name = "runId")
    val runID: String,

    @Json(name = "sessionId")
    val sessionID: String,

    val startedAt: Double,
    val taskCategory: String? = null,
    val taskPrompt: String? = null
)

/**
 * A single evaluation score on a completed run.
 */
data class ApmeEvalRow (
    val createdAt: Double,
    val judgeModel: String? = null,
    val layer: Layer,
    val metric: String,
    val rubricVer: Double? = null,
    val score: Double
)

enum class Layer(val value: String) {
    Deterministic("deterministic"),
    LlmJudge("llm_judge"),
    ManualReview("manual_review"),
    TaskJudge("task_judge"),
    Trajectory("trajectory"),
    TurnJudge("turn_judge"),
    Vibe("vibe");

    companion object {
        public fun fromValue(value: String): Layer = when (value) {
            "deterministic" -> Deterministic
            "llm_judge"     -> LlmJudge
            "manual_review" -> ManualReview
            "task_judge"    -> TaskJudge
            "trajectory"    -> Trajectory
            "turn_judge"    -> TurnJudge
            "vibe"          -> Vibe
            else            -> throw IllegalArgumentException()
        }
    }
}

enum class Outcome(val value: String) {
    AbLoser("ab_loser"),
    AbWinner("ab_winner"),
    Abandoned("abandoned"),
    Committed("committed"),
    Exploratory("exploratory"),
    Interrupted("interrupted"),
    Iterated("iterated"),
    Pending("pending");

    companion object {
        public fun fromValue(value: String): Outcome = when (value) {
            "ab_loser"    -> AbLoser
            "ab_winner"   -> AbWinner
            "abandoned"   -> Abandoned
            "committed"   -> Committed
            "exploratory" -> Exploratory
            "interrupted" -> Interrupted
            "iterated"    -> Iterated
            "pending"     -> Pending
            else          -> throw IllegalArgumentException()
        }
    }
}

/**
 * A per-model scoped usage limit (e.g. the Claude weekly cap for a specific model like
 * "Fable"). These come from the usage API's `limits[]` array and are distinct from the
 * account-wide 5h/7d windows: a scoped model can be the ACTIVE binding constraint (`active:
 * true`) while the 5h/7d numbers still read low.
 */
data class ScopedUsageLimit (
    /**
     * True when this limit is the currently active/binding constraint.
     */
    val active: Boolean? = null,

    /**
     * Raw API kind, e.g. "weekly_scoped". Forwarded for display grouping.
     */
    val kind: String? = null,

    /**
     * Human label — the scoped model display name (e.g. "Fable"), else the kind.
     */
    val label: String,

    /**
     * Percent of this limit already CONSUMED (0–100).
     */
    val percent: Double,

    /**
     * ISO-8601 reset instant for this limit's window.
     */
    val resetsAt: String? = null,

    /**
     * API severity: "normal" | "warning" | "critical" (forwarded as-is).
     */
    val severity: String? = null
)

data class ApmeModelScorecard (
    val agentType: AgentType,
    val avgOverall: Double? = null,
    val avgTestsPass: Double? = null,
    val costPerQuality: Double? = null,

    @Json(name = "modelId")
    val modelID: String,

    val runs: Double,
    val totalCost: Double? = null
)

data class OcSessionStatus (
    val contextTokens: Double? = null,
    val messageCount: Double? = null,
    val model: String? = null,

    @Json(name = "sessionId")
    val sessionID: String? = null,

    val uptime: String? = null
)

data class SessionInfo (
    /**
     * Daemon-synthesized "what is this agent doing right now" one-liner — a shared source so
     * glance surfaces (XTeink X3 rows, TRMNL list) render the same text.
     */
    val activity: String? = null,

    val agentType: AgentType? = null,
    val alive: Boolean,
    val contextPercent: Double? = null,
    val controlMode: ControlMode? = null,
    val currentTask: String? = null,
    val currentTool: String? = null,
    val cwd: String? = null,
    val effortLevel: String? = null,

    @Json(name = "elapsedSec")
    val elapsedSEC: Double? = null,

    @Json(name = "foldedSessionIds")
    val foldedSessionIDS: List<String>? = null,

    val goal: String? = null,
    val groupSize: Double? = null,
    val id: String,

    /**
     * Observed sessions: this daemon can answer the session's LIVE on-screen prompt by typing
     * into its terminal/app host (`observed-inject.ts`), so a deck may render its `options` as
     * pressable instead of inert. Absent/false means no reachable host was found, or the daemon
     * cannot inject at all (App Store Swift daemon — no subprocess). Emitted explicitly in BOTH
     * polarities: a flag only ever sent when true latches one-way under retain-on-absent
     * merging.
     */
    val liveAnswerable: Boolean? = null,

    val modelName: String? = null,
    val options: List<PromptOption>? = null,
    val pid: Double? = null,
    val port: Double,
    val projectName: String,
    val promptType: PromptType? = null,
    val question: String? = null,

    /**
     * Observed sessions: deck prompts queued for delivery at the current turn's end (Stop-hook
     * directive queue).
     */
    val queuedDirectives: Double? = null,

    @Json(name = "requestId")
    val requestID: String? = null,

    val reviewFindings: Double? = null,

    /**
     * Last review verdict (with reviewFindings) — devices render "risk: low · 2" on the REVIEW
     * tile.
     */
    val reviewRisk: Risk? = null,

    /**
     * On-demand review lifecycle for the REVIEW badge tile ('running' while the judge works).
     */
    val reviewStatus: ReviewStatus? = null,

    val startedAt: String? = null,
    val state: String? = null,

    /**
     * Observed sessions: a device requested a soft STOP (deny at the next tool call) — render
     * "stopping…" instead of an active STOP.
     */
    val stopRequested: Boolean? = null,

    val totalTokens: Double? = null,
    val weight: Double? = null
)

enum class ControlMode(val value: String) {
    Managed("managed"),
    Observed("observed");

    companion object {
        public fun fromValue(value: String): ControlMode = when (value) {
            "managed"  -> Managed
            "observed" -> Observed
            else       -> throw IllegalArgumentException()
        }
    }
}

/**
 * On-demand review lifecycle for the REVIEW badge tile ('running' while the judge works).
 */
enum class ReviewStatus(val value: String) {
    Done("done"),
    Error("error"),
    Running("running");

    companion object {
        public fun fromValue(value: String): ReviewStatus = when (value) {
            "done"    -> Done
            "error"   -> Error
            "running" -> Running
            else      -> throw IllegalArgumentException()
        }
    }
}

/**
 * Voice assistant pipeline state (wake word → STT → LLM → TTS)
 */
enum class State(val value: String) {
    AwaitingDiff("awaiting_diff"),
    AwaitingOption("awaiting_option"),
    AwaitingPermission("awaiting_permission"),
    Disabled("disabled"),
    Disconnected("disconnected"),
    Error("error"),
    Idle("idle"),
    Listening("listening"),
    Processing("processing"),
    Recording("recording"),
    Speaking("speaking"),
    Transcribing("transcribing");

    companion object {
        public fun fromValue(value: String): State = when (value) {
            "awaiting_diff"       -> AwaitingDiff
            "awaiting_option"     -> AwaitingOption
            "awaiting_permission" -> AwaitingPermission
            "disabled"            -> Disabled
            "disconnected"        -> Disconnected
            "error"               -> Error
            "idle"                -> Idle
            "listening"           -> Listening
            "processing"          -> Processing
            "recording"           -> Recording
            "speaking"            -> Speaking
            "transcribing"        -> Transcribing
            else                  -> throw IllegalArgumentException()
        }
    }
}

enum class BridgeEventStatus(val value: String) {
    Connected("connected"),
    Disconnected("disconnected"),
    Error("error"),
    Reconnecting("reconnecting"),
    Running("running");

    companion object {
        public fun fromValue(value: String): BridgeEventStatus = when (value) {
            "connected"    -> Connected
            "disconnected" -> Disconnected
            "error"        -> Error
            "reconnecting" -> Reconnecting
            "running"      -> Running
            else           -> throw IllegalArgumentException()
        }
    }
}

data class SubscriptionInfo (
    val name: String,
    val until: String? = null
)

enum class TokenStatus(val value: String) {
    Expired("expired"),
    Missing("missing"),
    Unknown("unknown"),
    Valid("valid");

    companion object {
        public fun fromValue(value: String): TokenStatus = when (value) {
            "expired" -> Expired
            "missing" -> Missing
            "unknown" -> Unknown
            "valid"   -> Valid
            else      -> throw IllegalArgumentException()
        }
    }
}

enum class Type(val value: String) {
    ApmeEval("apme_eval"),
    ApmeRecommendation("apme_recommendation"),
    ApmeScorecard("apme_scorecard"),
    ButtonState("button_state"),
    Connection("connection"),
    DeckSlotMap("deck_slot_map"),
    DisplayState("display_state"),
    EncoderState("encoder_state"),
    Esp32OtaAbort("esp32_ota_abort"),
    Esp32OtaBegin("esp32_ota_begin"),
    Esp32OtaChunk("esp32_ota_chunk"),
    Esp32OtaEnd("esp32_ota_end"),
    PromptOptions("prompt_options"),
    ReviewResult("review_result"),
    ReviewStatus("review_status"),
    SessionsList("sessions_list"),
    StateUpdate("state_update"),
    TimelineEvent("timeline_event"),
    TimelineHistory("timeline_history"),
    UsageUpdate("usage_update"),
    UserPrompt("user_prompt"),
    VoiceAssistantState("voice_assistant_state"),
    VoiceState("voice_state"),
    WakeWordDetected("wake_word_detected");

    companion object {
        public fun fromValue(value: String): Type = when (value) {
            "apme_eval"             -> ApmeEval
            "apme_recommendation"   -> ApmeRecommendation
            "apme_scorecard"        -> ApmeScorecard
            "button_state"          -> ButtonState
            "connection"            -> Connection
            "deck_slot_map"         -> DeckSlotMap
            "display_state"         -> DisplayState
            "encoder_state"         -> EncoderState
            "esp32_ota_abort"       -> Esp32OtaAbort
            "esp32_ota_begin"       -> Esp32OtaBegin
            "esp32_ota_chunk"       -> Esp32OtaChunk
            "esp32_ota_end"         -> Esp32OtaEnd
            "prompt_options"        -> PromptOptions
            "review_result"         -> ReviewResult
            "review_status"         -> ReviewStatus
            "sessions_list"         -> SessionsList
            "state_update"          -> StateUpdate
            "timeline_event"        -> TimelineEvent
            "timeline_history"      -> TimelineHistory
            "usage_update"          -> UsageUpdate
            "user_prompt"           -> UserPrompt
            "voice_assistant_state" -> VoiceAssistantState
            "voice_state"           -> VoiceState
            "wake_word_detected"    -> WakeWordDetected
            else                    -> throw IllegalArgumentException()
        }
    }
}

/**
 * Voice assistant pipeline state (wake word → STT → LLM → TTS)
 */
enum class VoiceAssistantState(val value: String) {
    Disabled("disabled"),
    Idle("idle"),
    Listening("listening"),
    Processing("processing"),
    Speaking("speaking");

    companion object {
        public fun fromValue(value: String): VoiceAssistantState = when (value) {
            "disabled"   -> Disabled
            "idle"       -> Idle
            "listening"  -> Listening
            "processing" -> Processing
            "speaking"   -> Speaking
            else         -> throw IllegalArgumentException()
        }
    }
}
