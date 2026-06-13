// To parse the JSON, install Klaxon and do:
//
//   val pluginCommand = PluginCommand.fromJson(jsonString)

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
    .convert(Action::class,    { Action.fromValue(it.string!!) },    { "\"${it.value}\"" })
    .convert(Agent::class,     { Agent.fromValue(it.string!!) },     { "\"${it.value}\"" })
    .convert(Decision::class,  { Decision.fromValue(it.string!!) },  { "\"${it.value}\"" })
    .convert(Direction::class, { Direction.fromValue(it.string!!) }, { "\"${it.value}\"" })
    .convert(Mode::class,      { Mode.fromValue(it.string!!) },      { "\"${it.value}\"" })
    .convert(Type::class,      { Type.fromValue(it.string!!) },      { "\"${it.value}\"" })
    .convert(Verdict::class,   { Verdict.fromValue(it.string!!) },   { "\"${it.value}\"" })
    .convert(Value::class,     { Value.fromJson(it) },               { it.toJson() }, true)

/**
 * Session-scoped command — daemon forwards the inner command to the specified session's
 * bridge. Enables direct control of a specific session from any client (MenuBarExtra,
 * Dashboard, etc.)
 *
 * Self-announcement from a rich UI client (Elgato Stream Deck plugin, a future Android
 * companion app, etc.) so the daemon can surface the hardware under its rightful Downstream
 * row instead of treating every WS connection as an anonymous dashboard viewer. Sent once
 * per connect, immediately after the WebSocket opens. Daemon wipes the cached entry when
 * the WS connection closes.
 *
 * APME vibe check — user approves or rejects a completed run's output quality.
 *
 * Ask bridge/daemon for model recommendation given a task context.
 *
 * Device approval decision for a gated PreToolUse permission request (observed sessions).
 * The daemon holds the hook's HTTP response open keyed by `requestId`; this command
 * resolves it into a Claude Code permission decision. See bridge/src/permission-resolver.ts.
 */
data class PluginCommand (
    val type: Type,
    val value: Value? = null,
    val index: Double? = null,
    val direction: Direction? = null,
    val text: String? = null,
    val mode: Mode? = null,
    val action: Action? = null,
    val agent: Agent? = null,

    @Json(name = "sessionId")
    val sessionID: String? = null,

    val command: Command? = null,

    /**
     * Human-readable label for the surface (appears verbatim in diagnostics).
     */
    val clientLabel: String? = null,

    /**
     * Short stable id — "streamdeck-plugin", "android-companion", etc.
     */
    val clientType: String? = null,

    /**
     * Physical device roster this client is driving, if any.
     */
    val devices: List<Device>? = null,

    val note: String? = null,

    @Json(name = "runId")
    val runID: String? = null,

    val verdict: Verdict? = null,
    val budgetUsd: Double? = null,

    @Json(name = "latencyBudgetMs")
    val latencyBudgetMS: Double? = null,

    val preferLocal: Boolean? = null,
    val taskKind: String? = null,
    val decision: Decision? = null,

    @Json(name = "requestId")
    val requestID: String? = null
) {
    public fun toJson() = klaxon.toJsonString(this)

    companion object {
        public fun fromJson(json: String) = klaxon.parse<PluginCommand>(json)
    }
}

enum class Action(val value: String) {
    AdjustBrightness("adjust_brightness"),
    AdjustVolume("adjust_volume"),
    Analyze("analyze"),
    Cancel("cancel"),
    Dump("dump"),
    MediaNext("media_next"),
    MediaPlayPause("media_play_pause"),
    MediaPrev("media_prev"),
    Start("start"),
    Stop("stop"),
    ToggleMute("toggle_mute");

    companion object {
        public fun fromValue(value: String): Action = when (value) {
            "adjust_brightness" -> AdjustBrightness
            "adjust_volume"     -> AdjustVolume
            "analyze"           -> Analyze
            "cancel"            -> Cancel
            "dump"              -> Dump
            "media_next"        -> MediaNext
            "media_play_pause"  -> MediaPlayPause
            "media_prev"        -> MediaPrev
            "start"             -> Start
            "stop"              -> Stop
            "toggle_mute"       -> ToggleMute
            else                -> throw IllegalArgumentException()
        }
    }
}

enum class Agent(val value: String) {
    ClaudeCode("claude-code"),
    Openclaw("openclaw");

    companion object {
        public fun fromValue(value: String): Agent = when (value) {
            "claude-code" -> ClaudeCode
            "openclaw"    -> Openclaw
            else          -> throw IllegalArgumentException()
        }
    }
}

data class Command (
    val type: String
)

enum class Decision(val value: String) {
    Allow("allow"),
    Deny("deny");

    companion object {
        public fun fromValue(value: String): Decision = when (value) {
            "allow" -> Allow
            "deny"  -> Deny
            else    -> throw IllegalArgumentException()
        }
    }
}

data class Device (
    val columns: Double? = null,

    /**
     * "streamdeck" | "streamdeckplus" | "streamdeckmini" | ... — free-form.
     */
    val family: String? = null,

    val id: String,
    val name: String,
    val rows: Double? = null
)

enum class Direction(val value: String) {
    Down("down"),
    Up("up");

    companion object {
        public fun fromValue(value: String): Direction = when (value) {
            "down" -> Down
            "up"   -> Up
            else   -> throw IllegalArgumentException()
        }
    }
}

enum class Mode(val value: String) {
    AcceptEdits("acceptEdits"),
    Default("default"),
    Plan("plan");

    companion object {
        public fun fromValue(value: String): Mode = when (value) {
            "acceptEdits" -> AcceptEdits
            "default"     -> Default
            "plan"        -> Plan
            else          -> throw IllegalArgumentException()
        }
    }
}

enum class Type(val value: String) {
    ApmeRecommend("apme_recommend"),
    ApmeVibe("apme_vibe"),
    ClearSessionFocus("clear_session_focus"),
    ClientRegister("client_register"),
    Diag("diag"),
    Escape("escape"),
    FocusSession("focus_session"),
    Interrupt("interrupt"),
    NavigateOption("navigate_option"),
    PermissionDecision("permission_decision"),
    QueryUsage("query_usage"),
    Respond("respond"),
    SelectOption("select_option"),
    SendPrompt("send_prompt"),
    SessionCommand("session_command"),
    SwitchAgent("switch_agent"),
    SwitchMode("switch_mode"),
    Utility("utility"),
    Voice("voice");

    companion object {
        public fun fromValue(value: String): Type = when (value) {
            "apme_recommend"      -> ApmeRecommend
            "apme_vibe"           -> ApmeVibe
            "clear_session_focus" -> ClearSessionFocus
            "client_register"     -> ClientRegister
            "diag"                -> Diag
            "escape"              -> Escape
            "focus_session"       -> FocusSession
            "interrupt"           -> Interrupt
            "navigate_option"     -> NavigateOption
            "permission_decision" -> PermissionDecision
            "query_usage"         -> QueryUsage
            "respond"             -> Respond
            "select_option"       -> SelectOption
            "send_prompt"         -> SendPrompt
            "session_command"     -> SessionCommand
            "switch_agent"        -> SwitchAgent
            "switch_mode"         -> SwitchMode
            "utility"             -> Utility
            "voice"               -> Voice
            else                  -> throw IllegalArgumentException()
        }
    }
}

sealed class Value {
    class DoubleValue(val value: Double) : Value()
    class StringValue(val value: String) : Value()

    public fun toJson(): String = klaxon.toJsonString(when (this) {
        is DoubleValue -> this.value
        is StringValue -> this.value
    })

    companion object {
        public fun fromJson(jv: JsonValue): Value = when (jv.inside) {
            is Double -> DoubleValue(jv.double!!)
            is String -> StringValue(jv.string!!)
            else      -> throw IllegalArgumentException()
        }
    }
}

enum class Verdict(val value: String) {
    Approve("approve"),
    Neutral("neutral"),
    Reject("reject");

    companion object {
        public fun fromValue(value: String): Verdict = when (value) {
            "approve" -> Approve
            "neutral" -> Neutral
            "reject"  -> Reject
            else      -> throw IllegalArgumentException()
        }
    }
}
