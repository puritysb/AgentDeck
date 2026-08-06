package dev.agentdeck.net

import android.util.Log
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonPrimitive

@Serializable
enum class AgentState {
    @SerialName("disconnected") DISCONNECTED,
    @SerialName("idle") IDLE,
    @SerialName("processing") PROCESSING,
    @SerialName("awaiting_permission") AWAITING_PERMISSION,
    @SerialName("awaiting_option") AWAITING_OPTION,
    @SerialName("awaiting_diff") AWAITING_DIFF,
}

@Serializable
enum class PermissionMode {
    @SerialName("default") DEFAULT,
    @SerialName("plan") PLAN,
    @SerialName("acceptEdits") ACCEPT_EDITS,
    @SerialName("dontAsk") DONT_ASK,
    @SerialName("bypassPermissions") BYPASS_PERMISSIONS,
}

@Serializable
data class AgentCapabilities(
    val type: String? = null,
    val displayName: String? = null,
    val hasTerminal: Boolean = false,
    val hasModeSwitching: Boolean = false,
    val hasDiffReview: Boolean = false,
    val hasOptionLists: Boolean = false,
    val hasNavigablePrompts: Boolean = false,
    val hasSuggestedPrompts: Boolean = false,
    val hasApiUsage: Boolean = false,
    val hasModelCatalog: Boolean = false,
)

@Serializable
data class ModelCatalogEntry(
    val key: String = "",
    val name: String,
    val role: String? = null,
    val available: Boolean = true,
)

@Serializable
data class OcSessionStatus(
    val model: String? = null,
    val contextTokens: Int? = null,
    val messageCount: Int? = null,
    val uptime: String? = null,
    val sessionId: String? = null,
)

@Serializable
data class PromptOption(
    val label: String,
    val value: String? = null,
    val description: String? = null,
    val index: Int? = null,
    val shortcut: String? = null,
    val recommended: Boolean? = null,
    val selected: Boolean? = null,
    val kind: String? = null,
)

@Serializable
data class StateUpdate(
    val state: AgentState = AgentState.DISCONNECTED,
    val permissionMode: PermissionMode = PermissionMode.DEFAULT,
    val agentType: String? = null,
    /** Session this state payload describes; may move with hook activity. */
    val sessionId: String? = null,
    /** Session explicitly focused by the user; visual selection must use this. */
    val focusedSessionId: String? = null,
    val currentTool: String? = null,
    val toolInput: String? = null,
    val toolProgress: String? = null,
    val projectName: String? = null,
    val modelName: String? = null,
    val effortLevel: String? = null,
    val billingType: String? = null,
    val options: List<PromptOption>? = null,
    val promptType: String? = null,
    val question: String? = null,
    val suggestedPrompt: String? = null,
    val remoteUrl: String? = null,
    val navigable: Boolean? = null,
    val cursorIndex: Int? = null,
    val agentCapabilities: AgentCapabilities? = null,
    val modelCatalog: List<ModelCatalogEntry>? = null,
    val sessionStatus: OcSessionStatus? = null,
    val pairingUrl: String? = null,
    val workerSessionCount: Int? = null,
    val ollamaStatus: OllamaStatus? = null,
    val mlxModels: List<String>? = null,
    val subscriptions: List<SubscriptionInfo>? = null,
    val antigravityStatus: AntigravityStatusInfo? = null,
    val gatewayAvailable: Boolean? = null,
    val gatewayConnected: Boolean? = null,
    val gatewayHasError: Boolean? = null,
    val moduleHealth: ModuleHealthState? = null,
    val voiceAssistantState: String? = null,
    val voiceAssistantText: String? = null,
    val voiceAssistantResponseText: String? = null,
)

/**
 * A per-model scoped usage limit (e.g. the Claude weekly cap for "Fable").
 * Distinct from the account-wide 5h/7d windows: a scoped model can be the ACTIVE
 * binding constraint while 5h/7d read low. Mirrors the TS `ScopedUsageLimit`.
 */
@Serializable
data class ScopedUsageLimit(
    val kind: String? = null,
    val label: String,
    val percent: Double,
    val severity: String? = null,
    val resetsAt: String? = null,
    val active: Boolean? = null,
)

@Serializable
data class UsageUpdate(
    val sessionDurationSec: Int = 0,
    val inputTokens: Int = 0,
    val outputTokens: Int = 0,
    val toolCalls: Int = 0,
    val estimatedCostUsd: Double? = null,
    val fiveHourPercent: Double? = null,
    val sevenDayPercent: Double? = null,
    val fiveHourResetsAt: String? = null,
    val sevenDayResetsAt: String? = null,
    val extraUsageEnabled: Boolean? = null,
    val extraUsageMonthlyLimit: Double? = null,
    val extraUsageUsedCredits: Double? = null,
    val extraUsageUtilization: Double? = null,
    // Per-model scoped weekly caps (e.g. "Fable"). Rendered on the tablet usage
    // card and both e-ink surfaces; the field keeps this hand mirror in parity
    // with the generated protocol.
    val scopedLimits: List<ScopedUsageLimit>? = null,
    val sessionPercent: Double? = null,
    val costSpent: Double? = null,
    val costLimit: Double? = null,
    val resetTime: String? = null,
    val resetDate: String? = null,
    val oauthConnected: Boolean? = null,
    val ollamaStatus: OllamaStatus? = null,
    val usageStale: Boolean? = null,
    val tokenStatus: String? = null,  // "valid" | "expired" | "missing" | "unknown"
    val codexAuthMode: String? = null,
    val codexWebAuthConnected: Boolean? = null,
    val codexPlanType: String? = null,
    val codexAccountId: String? = null,
    val codexSubscriptionActiveUntil: String? = null,
    val codexLastRefreshAt: String? = null,
    // Codex (ChatGPT) usage limits parsed from local rollout files — primary ≈
    // 5h window, secondary ≈ weekly. Mirrors Claude's fiveHourPercent/
    // sevenDayPercent shape. Only rides on usage_update, not state_update.
    val codexRateLimits: CodexRateLimits? = null,
    val modelCatalog: List<ModelCatalogEntry>? = null,
    val mlxModels: List<String>? = null,
    val subscriptions: List<SubscriptionInfo>? = null,
    val antigravityStatus: AntigravityStatusInfo? = null,
)

@Serializable
data class SubscriptionInfo(
    val name: String,
    val until: String? = null,
)

@Serializable
data class AntigravityStatusInfo(
    val planName: String? = null,
    val availableCredits: Int? = null,
    val minimumCreditAmountForUsage: Int? = null,
    val subscriptionActiveUntil: String? = null,
)

/** One Codex (ChatGPT) rate-limit window, mirroring the Claude 5h/7d shape.
 *  Sourced from the user's own local Codex rollout files — not an API call. */
@Serializable
data class CodexRateLimitWindow(
    val usedPercent: Double? = null,
    /** Rolling window length in minutes (primary ≈ 300 = 5h, secondary ≈ 10080 = 7d). */
    val windowMinutes: Int? = null,
    /** ISO-8601 reset instant. */
    val resetsAt: String? = null,
    /** True when this window's snapshot has expired (set centrally by the daemon).
     *  Renderers dim the gauge and show a "stale" marker instead of "now".
     *
     *  The HARD signal — some consumers drop the gauge entirely on it. A merely
     *  OLD snapshot of a still-live window must never set it; that rides
     *  [CodexRateLimits.capturedAt]. */
    val stale: Boolean? = null,
)

/** Codex credit balance — the metering credit-based plans report (e.g.
 *  `limit_id: "premium"`) when the 5h/7d windows are null. */
@Serializable
data class CodexCredits(
    val hasCredits: Boolean? = null,
    val unlimited: Boolean? = null,
    /** Remaining balance — Codex reports this as a string (e.g. "0"). */
    val balance: String? = null,
)

/** Codex usage limits. `primary` is the short (5h-style) window, `secondary`
 *  the long (weekly) window — same idea as the Claude 5h/7d gauges. Credit-based
 *  plans report null windows and convey usage via `credits` + `limitId`. */
@Serializable
data class CodexRateLimits(
    val primary: CodexRateLimitWindow? = null,
    val secondary: CodexRateLimitWindow? = null,
    /** Plan tier reported alongside the limits (e.g. "plus", "pro"). */
    val planType: String? = null,
    /** Limit identifier reported by Codex (e.g. "premium" for credit-based plans). */
    val limitId: String? = null,
    /** Credit balance for credit-based plans (present when windows are null). */
    val credits: CodexCredits? = null,
    /** ISO-8601 instant this snapshot was WRITTEN by Codex (the rate-limit line's
     *  own timestamp, else the rollout file's mtime).
     *
     *  The only field that separates "94% right now" from "94% four hours ago":
     *  Codex usage is read passively from rollout files, so the numbers freeze
     *  when Codex stops being used, and [CodexRateLimitWindow.stale] cannot expose
     *  that — it fires only once the window has ENDED, which for the weekly window
     *  is up to 7 days out. */
    val capturedAt: String? = null,
)

@Serializable
data class OllamaModel(
    val name: String,
    val size: Long = 0,
    val sizeVram: Long = 0,
)

@Serializable
data class OllamaStatus(
    val available: Boolean = false,
    val models: List<OllamaModel> = emptyList(),
)

@Serializable
data class VoiceState(
    val state: String = "idle",
    val text: String? = null,
    val error: String? = null,
)

// --- Button state (Bridge → Android) ---

@Serializable
data class ButtonSlotState(
    val slot: Int,
    val title: String,
    val subtitle: String? = null,
    val bgColor: String,
    val textColor: String,
    val enabled: Boolean = true,
    val icon: String? = null,
    val badge: String? = null,
    val action: String? = null,
    val dim: Boolean = false,
)

// --- Encoder LCD state (Bridge → Android) ---

@Serializable
data class EncoderSlotState(
    val slot: Int,
    val encoderType: String,
    val header: String,
    val value: String? = null,
    val icon: String? = null,
    val accentColor: String = "#94A3B8",
    val progress: Float? = null,
    val counter: String? = null,
    val detail: String? = null,
    val voiceState: String? = null,
    val recordingMs: Long? = null,
    val transcription: String? = null,
)

@Serializable
data class DeckSlotConfig(
    val slot: Int,
    val actionType: String,
    val settings: Map<String, JsonElement>? = null,
)

// --- Multi-session discovery ---

@Serializable
data class SessionInfo(
    val id: String,
    val port: Int,
    val projectName: String? = null,
    val agentType: String? = null,
    val alive: Boolean = true,
    val state: String? = null,
    val modelName: String? = null,
    val effortLevel: String? = null,
    val startedAt: String? = null,
    // Explicit deck/tab sort override (default 0); lower sorts first. Set via
    // `agentdeck <agent> --weight <n>`. Mirrors shared SessionInfo.weight.
    val weight: Int? = null,
    val question: String? = null,
    // For an observed session these are pressable only when liveAnswerable is
    // true; otherwise render them but send nothing (answer in the terminal).
    val options: List<PromptOption>? = null,
    val promptType: String? = null,
    val navigable: Boolean? = null,
    val controlMode: String? = null,
    // Present when a gated PreToolUse permission is pending device approval —
    // the HUD renders Allow/Deny and replies with permissionDecision(requestId).
    // Never set for an AskUserQuestion: a binary control would collapse a
    // multiple-choice question (those ride liveAnswerable + select_option).
    val requestId: String? = null,
    // Will a press on [options] reach the agent? True when the daemon can type
    // into the session's terminal (CLI daemon only) OR is holding the session's
    // AskUserQuestion open to answer it with our choice. Sent in both
    // polarities, so decode absence as "unknown", never as true.
    val liveAnswerable: Boolean? = null,
    // Observed sessions: a soft STOP is pending / prompts queued for turn end.
    val stopRequested: Boolean? = null,
    val queuedDirectives: Int? = null,
    // One AskUserQuestion call may hold several question groups, presented one
    // at a time (question/options are the active one). Present only for a
    // multi-group prompt, so a surface can render "Q 2/3".
    val askGroupIndex: Int? = null,
    val askGroupCount: Int? = null,
    // Shared per-session "what is this agent doing" one-liner, computed by the
    // bridge (session-activity.ts heuristic → Foundation Models upgrade).
    // SSOT for the session summary line — render this instead of hand-rolling
    // model/state strings so all surfaces (InkDeck/Android/Apple) agree.
    val activity: String? = null,
)

@Serializable
data class ModuleHealthState(
    val adb: AdbHealth? = null,
    val d200h: D200hHealth? = null,
    val pixoo: PixooHealth? = null,
    val serial: SerialHealth? = null,
    val streamDeck: StreamDeckHealth? = null,
)

@Serializable
data class StreamDeckHealth(
    val devices: List<StreamDeckDeviceInfo> = emptyList(),
)

@Serializable
data class StreamDeckDeviceInfo(
    val id: String = "",
    val name: String = "",
    val family: String? = null,
    val columns: Int? = null,
    val rows: Int? = null,
)

@Serializable
data class AdbHealth(
    val available: Boolean = false,
    val devices: List<String> = emptyList(),
    val classifiedDevices: List<ClassifiedDevice> = emptyList(),
    val reverseReadyCount: Int = 0,
    val lastError: String? = null,
)

@Serializable
data class ClassifiedDevice(
    val serial: String,
    val manufacturer: String? = null,
    val model: String? = null,
    @SerialName("class") val deviceClass: String = "android.tablet",
)

@Serializable
data class D200hHealth(
    val connected: Boolean = false,
)

@Serializable
data class PixooHealth(
    val configuredDeviceCount: Int = 0,
    val deviceIps: List<String> = emptyList(),
    val hasFrame: Boolean = false,
    val displayDimmed: Boolean = false,
    val lastPushError: String? = null,
    val devices: List<PixooDeviceHealth> = emptyList(),
)

@Serializable
data class PixooDeviceHealth(
    val ip: String = "",
    val online: Boolean = false,
    val failures: Int = 0,
    val backedOff: Boolean = false,
)

@Serializable
data class SerialHealth(
    val connectedPorts: List<String> = emptyList(),
    val connectedBoards: List<SerialPortInfo> = emptyList(),
    val lastError: String? = null,
)

@Serializable
data class SerialPortInfo(
    val port: String,
    val board: String? = null,
    val firmwareVersion: String? = null,
)

// --- Bridge timeline entry (rich OpenClaw events) ---

@Serializable
data class BridgeTimelineEntry(
    @Serializable(with = FlexibleLongSerializer::class)
    val ts: Long,
    val type: String,
    val raw: String,
    val detail: String? = null,
    val approvalId: String? = null,
    val status: String? = null,
    val agentType: String? = null,
    val projectName: String? = null,
    val sessionId: String? = null,
    val runId: String? = null,
    @Serializable(with = FlexibleLongSerializer::class)
    val startedAt: Long? = null,
    @Serializable(with = FlexibleLongSerializer::class)
    val endedAt: Long? = null,
    val taskId: String? = null,
    val boundarySignal: String? = null,
    val automated: Boolean? = null,
    val summaryKind: String? = null,
    // Task-judge rollup attached on the second task_end emit. Daemon mirrors
    // these in DaemonServer::claudeCodeEntryDict; missing one here would
    // silently nil-strip on decode and dashboard task headers would never
    // show a score badge even though the Node daemon broadcast it.
    val taskScore: Double? = null,
    val taskOutcome: String? = null,
    val taskCategory: String? = null,
    val taskSummary: String? = null,
)

fun BridgeTimelineEntry.toTimelineEntry() = dev.agentdeck.state.TimelineEntry(
    timestamp = ts,
    type = type,
    summary = raw,
    detail = detail,
    agentType = agentType,
    projectName = projectName,
    sessionId = sessionId,
    runId = runId,
    startedAt = startedAt,
    endedAt = endedAt,
    status = status,
    automated = automated,
    taskId = taskId,
    boundarySignal = boundarySignal,
    summaryKind = summaryKind,
    taskScore = taskScore,
    taskOutcome = taskOutcome,
    taskCategory = taskCategory,
    taskSummary = taskSummary,
)

/**
 * Host's instruction for how to dim downstream devices when its display sleeps.
 * Mirrors the `dim` object on the `display_state` event. Absent ⇒ legacy
 * full-off. `level` is a 1-100 percent (mapped to screenBrightness 0.0-1.0).
 */
data class DimConfig(val enabled: Boolean, val mode: String, val level: Int)

sealed class BridgeEvent {
    data class State(val data: StateUpdate) : BridgeEvent()
    data class Usage(val data: UsageUpdate) : BridgeEvent()
    data class Voice(val data: VoiceState) : BridgeEvent()
    data class Connected(val sessionId: String?) : BridgeEvent()
    data object Disconnected : BridgeEvent()
    data class DisplaySleep(val displayOn: Boolean, val dim: DimConfig? = null) : BridgeEvent()
    data class SessionsList(val sessions: List<SessionInfo>) : BridgeEvent()
    data class EncoderState(val encoders: List<EncoderSlotState>, val takeoverActive: Boolean) : BridgeEvent()
    data class ButtonState(val buttons: List<ButtonSlotState>) : BridgeEvent()
    data class SlotMap(val buttons: List<DeckSlotConfig>, val encoders: List<DeckSlotConfig>) : BridgeEvent()
    data class Timeline(val entry: BridgeTimelineEntry, val upsert: Boolean = false) : BridgeEvent()
    data class TimelineHistory(val entries: List<BridgeTimelineEntry>) : BridgeEvent()
    data class UserPrompt(val text: String) : BridgeEvent()
}

// --- App -> Bridge commands ---

object PluginCommands {
    fun respond(value: String): String =
        """{"type":"respond","value":${Json.encodeToString(kotlinx.serialization.serializer<String>(), value)}}"""

    /**
     * Answer an awaiting prompt. [sessionId] addresses the session directly
     * instead of relying on a preceding `focus_session` relay landing first;
     * [question] echoes what was on screen so the daemon can drop a press that
     * answers a question the prompt has already moved past (one
     * AskUserQuestion call can hold several questions and advances between
     * them). Both optional — older daemons ignore them.
     */
    fun selectOption(index: Int, sessionId: String? = null, question: String? = null): String {
        val str = kotlinx.serialization.serializer<String>()
        val session = sessionId?.let { ""","sessionId":${Json.encodeToString(str, it)}""" } ?: ""
        val echo = question?.takeIf { it.isNotEmpty() }
            ?.let { ""","question":${Json.encodeToString(str, it)}""" } ?: ""
        return """{"type":"select_option","index":$index$session$echo}"""
    }

    fun focusSession(sessionId: String): String =
        """{"type":"focus_session","sessionId":${Json.encodeToString(kotlinx.serialization.serializer<String>(), sessionId)}}"""

    fun sendPrompt(text: String): String =
        """{"type":"send_prompt","text":${Json.encodeToString(kotlinx.serialization.serializer<String>(), text)}}"""

    fun interrupt(): String = """{"type":"interrupt"}"""

    fun escape(): String = """{"type":"escape"}"""

    fun queryUsage(): String = """{"type":"query_usage"}"""

    /**
     * Announce this Android dashboard app to the daemon so its topology rail
     * can render an Android row (volunteer-roster model like the Stream Deck
     * plugin / XTeink `eink-device`; the daemon evicts it when this WS closes).
     */
    fun clientRegisterAndroidDashboard(id: String, name: String, kind: String): String {
        val enc = { s: String -> Json.encodeToString(kotlinx.serialization.serializer<String>(), s) }
        return """{"type":"client_register","clientType":"android-dashboard",""" +
            """"devices":[{"id":${enc(id)},"name":${enc(name)},"kind":${enc(kind)}}]}"""
    }

    fun switchMode(): String = """{"type":"switch_mode"}"""

    fun utility(action: String, value: Int? = null): String {
        val valueStr = if (value != null) ""","value":$value""" else ""
        return """{"type":"utility","action":"$action"$valueStr}"""
    }

    fun navigateOption(direction: String): String =
        """{"type":"navigate_option","direction":"$direction"}"""

    /** Device approval for a gated PreToolUse permission request (observed session). */
    fun permissionDecision(requestId: String, decision: String): String =
        """{"type":"permission_decision","requestId":${Json.encodeToString(kotlinx.serialization.serializer<String>(), requestId)},"decision":"$decision"}"""
}

// --- JSON parsing ---

val protocolJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    coerceInputValues = true
}

object FlexibleLongSerializer : KSerializer<Long> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("FlexibleLong", PrimitiveKind.LONG)

    override fun deserialize(decoder: Decoder): Long {
        if (decoder is JsonDecoder) {
            val primitive = decoder.decodeJsonElement().jsonPrimitive
            primitive.longOrNull?.let { return it }
            primitive.doubleOrNull?.let { return it.toLong() }
        }
        return decoder.decodeLong()
    }

    override fun serialize(encoder: Encoder, value: Long) {
        encoder.encodeLong(value)
    }
}

fun parseBridgeMessage(text: String): BridgeEvent? {
    return try {
        val element = protocolJson.parseToJsonElement(text)
        val obj = element.jsonObject
        val type = obj["type"]?.jsonPrimitive?.content ?: return null

        when (type) {
            "state_update" -> {
                val data = protocolJson.decodeFromJsonElement<StateUpdate>(element)
                BridgeEvent.State(data)
            }
            "usage_update" -> {
                val data = protocolJson.decodeFromJsonElement<UsageUpdate>(element)
                BridgeEvent.Usage(data)
            }
            "voice_state" -> {
                val data = protocolJson.decodeFromJsonElement<VoiceState>(element)
                BridgeEvent.Voice(data)
            }
            "connection" -> {
                val status = obj["status"]?.jsonPrimitive?.content
                val sessionId = obj["sessionId"]?.jsonPrimitive?.content
                if (status == "connected") BridgeEvent.Connected(sessionId)
                else BridgeEvent.Disconnected
            }
            "display_state" -> {
                val displayOn = obj["displayOn"]?.jsonPrimitive?.boolean ?: true
                // Optional dim instruction (absent ⇒ legacy enabled/full-off).
                val dim = obj["dim"]?.jsonObject?.let { d ->
                    DimConfig(
                        enabled = d["enabled"]?.jsonPrimitive?.boolean ?: true,
                        mode = d["mode"]?.jsonPrimitive?.content ?: "off",
                        level = (d["level"]?.jsonPrimitive?.longOrNull?.toInt() ?: 10)
                            .coerceIn(1, 100),
                    )
                }
                BridgeEvent.DisplaySleep(displayOn, dim)
            }
            "sessions_list" -> {
                val sessionsArray = obj["sessions"]
                if (sessionsArray != null) {
                    val sessions = protocolJson.decodeFromJsonElement<List<SessionInfo>>(sessionsArray)
                    BridgeEvent.SessionsList(sessions)
                } else null
            }
            "encoder_state" -> {
                val encodersArray = obj["encoders"]
                val takeoverActive = obj["takeoverActive"]?.jsonPrimitive?.boolean ?: false
                if (encodersArray != null) {
                    val encoders = protocolJson.decodeFromJsonElement<List<EncoderSlotState>>(encodersArray)
                    BridgeEvent.EncoderState(encoders, takeoverActive)
                } else null
            }
            "button_state" -> {
                val buttonsArray = obj["buttons"]
                if (buttonsArray != null) {
                    val buttons = protocolJson.decodeFromJsonElement<List<ButtonSlotState>>(buttonsArray)
                    BridgeEvent.ButtonState(buttons)
                } else null
            }
            "deck_slot_map" -> {
                val buttonsArray = obj["buttons"]
                val encodersArray = obj["encoders"]
                if (buttonsArray != null && encodersArray != null) {
                    val buttons = protocolJson.decodeFromJsonElement<List<DeckSlotConfig>>(buttonsArray)
                    val encoders = protocolJson.decodeFromJsonElement<List<DeckSlotConfig>>(encodersArray)
                    BridgeEvent.SlotMap(buttons, encoders)
                } else null
            }
            "user_prompt" -> {
                val promptText = obj["text"]?.jsonPrimitive?.content
                if (promptText != null) BridgeEvent.UserPrompt(promptText) else null
            }
            "timeline_event" -> {
                val entryObj = obj["entry"]
                val isUpsert = obj["upsert"]?.jsonPrimitive?.boolean ?: false
                if (entryObj != null) {
                    val entry = protocolJson.decodeFromJsonElement<BridgeTimelineEntry>(entryObj)
                    BridgeEvent.Timeline(entry, isUpsert)
                } else null
            }
            "timeline_history" -> {
                val entriesArray = obj["entries"]
                if (entriesArray != null) {
                    val entries = protocolJson.decodeFromJsonElement<List<BridgeTimelineEntry>>(entriesArray)
                    BridgeEvent.TimelineHistory(entries)
                } else null
            }
            else -> null
        }
    } catch (e: Exception) {
        Log.e("Terrarium", "parseBridgeMessage failed: ${e.message}, raw=${text.take(300)}")
        null
    }
}
