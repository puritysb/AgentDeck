package dev.agentdeck.state

import dev.agentdeck.net.AgentCapabilities
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeEvent
import dev.agentdeck.net.DimConfig
import dev.agentdeck.net.ModelCatalogEntry
import dev.agentdeck.net.ModuleHealthState
import dev.agentdeck.net.OcSessionStatus
import dev.agentdeck.net.OllamaStatus
import dev.agentdeck.net.PermissionMode
import dev.agentdeck.net.PromptOption
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.net.SubscriptionInfo
import dev.agentdeck.net.AntigravityStatusInfo
import dev.agentdeck.net.CodexRateLimits
import dev.agentdeck.net.StateUpdate
import dev.agentdeck.net.UsageUpdate
import dev.agentdeck.net.VoiceState
import dev.agentdeck.net.toTimelineEntry
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

private const val TAG = "Terrarium"
private const val VERBOSE_STATE_LOGS = false
private val AGGREGATE_AGENT_TYPES = setOf("daemon", "openclaw")

private inline fun stateDebug(message: () -> String) {
    if (VERBOSE_STATE_LOGS || Log.isLoggable(TAG, Log.DEBUG)) {
        Log.d(TAG, message())
    }
}

data class DashboardState(
    val agentState: AgentState = AgentState.DISCONNECTED,
    val permissionMode: PermissionMode = PermissionMode.DEFAULT,
    val agentType: String? = null,
    val currentTool: String? = null,
    val toolInput: String? = null,
    val toolProgress: String? = null,
    val projectName: String? = null,
    val modelName: String? = null,
    val effortLevel: String? = null,
    val billingType: String? = null,
    val options: List<PromptOption> = emptyList(),
    val promptType: String? = null,
    val question: String? = null,
    val suggestedPrompt: String? = null,
    val remoteUrl: String? = null,
    val usage: UsageUpdate = UsageUpdate(),
    val voice: VoiceState = VoiceState(),
    val sessionId: String? = null,
    val bridgeConnected: Boolean = false,
    val agentCapabilities: AgentCapabilities? = null,
    val modelCatalog: List<ModelCatalogEntry>? = null,
    val sessionStatus: OcSessionStatus? = null,
    val pairingUrl: String? = null,
    val navigable: Boolean? = null,
    val cursorIndex: Int? = null,
    val hostDisplayOn: Boolean = true,
    /** Host's dim instruction (off/min/level). null ⇒ legacy full-off. */
    val hostDim: DimConfig? = null,
    /**
     * Session explicitly focused by the user, broadcast by the daemon's
     * focus relay. Use this — not [sessionId] — for visual selection
     * (the daemon connection's [sessionId] is a bridge-core UUID, not a
     * real session id).
     */
    val focusedSessionId: String? = null,
    val siblingSessions: List<SessionInfo> = emptyList(),
    val workerSessionCount: Int? = null,
    val oauthConnected: Boolean? = null,
    val ollamaStatus: OllamaStatus? = null,
    val gatewayAvailable: Boolean? = null,
    val gatewayConnected: Boolean? = null,
    val gatewayHasError: Boolean? = null,
    val moduleHealth: ModuleHealthState? = null,
    val voiceAssistantState: String? = null,
    val voiceAssistantText: String? = null,
    val voiceAssistantResponseText: String? = null,
    val mlxModels: List<String> = emptyList(),
    val subscriptions: List<SubscriptionInfo> = emptyList(),
    val antigravityStatus: AntigravityStatusInfo? = null,
    /**
     * Codex (ChatGPT) usage limits — hoisted from usage_update so a later
     * usage event carrying null doesn't wipe the last known value. Only
     * rides on usage_update (never state_update), exactly like macOS/iOS.
     */
    val codexRateLimits: CodexRateLimits? = null,
)

class AgentStateHolder private constructor() {

    companion object {
        val instance: AgentStateHolder by lazy { AgentStateHolder() }
    }

    private val _state = MutableStateFlow(DashboardState())
    val state: StateFlow<DashboardState> = _state.asStateFlow()

    /** Last known state for offline cache display */
    private var lastKnownState: DashboardState? = null

    init {
        BridgeConnection.instance.onEvent = ::handleEvent
    }

    fun getLastKnownState(): DashboardState? = lastKnownState

    private fun handleEvent(event: BridgeEvent) {
        when (event) {
            is BridgeEvent.State -> {
                stateDebug { "StateEvent: state=${event.data.state}, agentType=${event.data.agentType}, tool=${event.data.currentTool}" }
                _state.update { current ->
                    // Keep aggregate identity when current is daemon/openclaw and incoming event is from a coding agent.
                    // No need to wait for siblingSessions to be populated — the first state_update may arrive
                    // before sessions_list, and we must preserve the aggregate sessionId from the start.
                    val keepAggregateIdentity =
                        current.agentType in AGGREGATE_AGENT_TYPES &&
                            event.data.agentType != null &&
                            event.data.agentType !in AGGREGATE_AGENT_TYPES
                    val resolvedAgentType = when {
                        keepAggregateIdentity -> current.agentType
                        else -> event.data.agentType ?: current.agentType
                    }
                    val resolvedGatewayAvailable = event.data.gatewayAvailable ?: current.gatewayAvailable
                    val resolvedGatewayConnected = event.data.gatewayConnected ?: current.gatewayConnected
                    val resolvedGatewayHasError = if (resolvedGatewayAvailable == false && resolvedGatewayConnected != true) {
                        false
                    } else {
                        event.data.gatewayHasError ?: current.gatewayHasError
                    }
                    val clearOpenClawDetails = resolvedGatewayConnected != true
                    stateDebug { "AgentType resolve: event=${event.data.agentType}, current=${current.agentType}, resolved=$resolvedAgentType" }
                    // When the dashboard is pinned to an aggregate primary
                    // (daemon / openclaw) and a sibling (claude / codex / …)
                    // emits a state_update, that sibling's state is *not* the
                    // aggregate's state — it lives in `siblingSessions`. Apply
                    // the incoming state only when we are NOT keeping the
                    // aggregate identity, otherwise the OpenClaw crayfish
                    // animates as if Claude's PROCESSING were its own.
                    val resolvedAgentState =
                        if (keepAggregateIdentity) current.agentState else event.data.state
                    // sessionId on state_update tracks the latest hook-active session.
                    // In aggregate mode (daemon/openclaw), keep the original bridge-core UUID
                    // as sessionId, not a sibling session's ID. This prevents the sibling from
                    // being skipped as "self" when processing siblingSessions for creature rendering.
                    // Also skip sessionId update when the event itself is from an aggregate primary.
                    val isAggregateEvent = event.data.agentType in AGGREGATE_AGENT_TYPES
                    current.copy(
                        agentState = resolvedAgentState,
                        permissionMode = event.data.permissionMode,
                        agentType = resolvedAgentType,
                        currentTool = event.data.currentTool,
                        toolInput = event.data.toolInput,
                        toolProgress = event.data.toolProgress,
                        projectName = if (keepAggregateIdentity) current.projectName else event.data.projectName ?: current.projectName,
                        modelName = if (keepAggregateIdentity) current.modelName else event.data.modelName ?: current.modelName,
                        effortLevel = if (keepAggregateIdentity) current.effortLevel else event.data.effortLevel ?: current.effortLevel,
                        billingType = event.data.billingType ?: current.billingType,
                        options = event.data.options ?: emptyList(),
                        promptType = event.data.promptType,
                        question = event.data.question,
                        suggestedPrompt = event.data.suggestedPrompt,
                        remoteUrl = event.data.remoteUrl ?: current.remoteUrl,
                        agentCapabilities = event.data.agentCapabilities
                            ?: current.agentCapabilities.takeUnless { clearOpenClawDetails && it?.type == "openclaw" },
                        modelCatalog = event.data.modelCatalog
                            ?: current.modelCatalog.takeUnless { clearOpenClawDetails && current.agentType == "openclaw" },
                        sessionStatus = event.data.sessionStatus
                            ?: current.sessionStatus.takeUnless { clearOpenClawDetails },
                        pairingUrl = event.data.pairingUrl ?: current.pairingUrl,
                        navigable = event.data.navigable,
                        cursorIndex = event.data.cursorIndex,
                        workerSessionCount = when {
                            resolvedGatewayConnected != true -> null
                            event.data.workerSessionCount != null -> event.data.workerSessionCount
                            else -> current.workerSessionCount
                        },
                        ollamaStatus = event.data.ollamaStatus ?: current.ollamaStatus,
                        mlxModels = event.data.mlxModels ?: current.mlxModels,
                        subscriptions = event.data.subscriptions ?: current.subscriptions,
                        antigravityStatus = event.data.antigravityStatus ?: current.antigravityStatus,
                        gatewayAvailable = resolvedGatewayAvailable,
                        gatewayConnected = resolvedGatewayConnected,
                        gatewayHasError = resolvedGatewayHasError,
                        moduleHealth = event.data.moduleHealth ?: current.moduleHealth,
                        voiceAssistantState = event.data.voiceAssistantState ?: current.voiceAssistantState,
                        voiceAssistantText = event.data.voiceAssistantText,
                        voiceAssistantResponseText = event.data.voiceAssistantResponseText,
                        // sessionId on state_update tracks the latest hook-active session ("may move with hook activity"
                        // per shared/src/protocol.ts). Mirrors Apple `if let sid = e.sessionId { state.sessionId = sid }`.
                        // Absent → keep current (set originally by BridgeEvent.Connected).
                        // In aggregate mode (daemon/openclaw), keep the original bridge-core UUID as sessionId,
                        // not a sibling session's ID. This prevents the sibling from being skipped as "self"
                        // when processing siblingSessions for creature rendering.
                        sessionId = when {
                            isAggregateEvent || keepAggregateIdentity -> current.sessionId
                            else -> event.data.sessionId ?: current.sessionId
                        },
                        // focusedSessionId carries explicit user-focus state.
                        // Mirror Apple AgentStateHolder.handleStateUpdate:
                        //   absent → keep current (session-bridge updates
                        //     don't carry focus context).
                        //   present empty ("") → daemon explicitly cleared
                        //     focus; propagate as null so highlights drop.
                        //   present non-empty → adopt as the new focus.
                        focusedSessionId = if (event.data.focusedSessionId != null) {
                            event.data.focusedSessionId.takeIf { it.isNotEmpty() }
                        } else {
                            current.focusedSessionId
                        },
                    ).also {
                        stateDebug { "State updated: sessionId=${it.sessionId}, agentType=${it.agentType}, agentState=${it.agentState}, siblingSessions.size=${it.siblingSessions.size}" }
                    }
                }
                lastKnownState = _state.value
                // Apple AgentStateHolder parity: the OpenClaw Gateway provides
                // its own rich timeline entries via timeline_event — suppress
                // the StateTimelineGenerator fallback ("Connected"/"Prompt
                // sent"/tool rows) as soon as the gateway is confirmed
                // connected, so the generator can't race ahead of the first
                // timeline push after (re)connect.
                if (event.data.gatewayConnected == true) {
                    StateTimelineGenerator.instance.setReceivingBridgeTimeline(true)
                }
                StateTimelineGenerator.instance.onStateUpdate(event.data)
                SessionMetrics.instance.onMessageReceived()
            }

            is BridgeEvent.UserPrompt -> {
                StateTimelineGenerator.instance.setLastUserPrompt(event.text)
            }

            is BridgeEvent.Usage -> {
                // Scrub upstream subscription-quota numbers when the daemon
                // flags the data as stale (no live CLI to fetch a fresh
                // value). Every surface that reads state.usage.fiveHourPercent
                // / sevenDayPercent / extraUsage* then collapses on null,
                // matching macOS/Pixoo/D200H/plugin behavior without each
                // downstream view needing its own stale check.
                val incoming = if (event.data.usageStale == true) {
                    event.data.copy(
                        fiveHourPercent = null,
                        sevenDayPercent = null,
                        fiveHourResetsAt = null,
                        sevenDayResetsAt = null,
                        extraUsageEnabled = null,
                        extraUsageMonthlyLimit = null,
                        extraUsageUsedCredits = null,
                        extraUsageUtilization = null,
                    )
                } else event.data
                _state.update { current ->
                    current.copy(
                        usage = incoming,
                        oauthConnected = incoming.oauthConnected ?: current.oauthConnected,
                        ollamaStatus = incoming.ollamaStatus ?: current.ollamaStatus,
                        modelCatalog = incoming.modelCatalog
                            ?: current.modelCatalog.takeUnless {
                                current.gatewayConnected != true && current.agentType == "openclaw"
                            },
                        mlxModels = incoming.mlxModels ?: current.mlxModels,
                        subscriptions = incoming.subscriptions ?: current.subscriptions,
                        antigravityStatus = incoming.antigravityStatus ?: current.antigravityStatus,
                        // codexRateLimits only rides on usage_update — hoist it
                        // so a later null incoming doesn't wipe it (mirrors iOS).
                        codexRateLimits = incoming.codexRateLimits ?: current.codexRateLimits,
                    )
                }
                lastKnownState = _state.value
                SessionMetrics.instance.onMessageReceived()
            }

            is BridgeEvent.Voice -> {
                _state.update { it.copy(voice = event.data) }
            }

            is BridgeEvent.Connected -> {
                // Clear stale timeline (logs) on (re)connect. A fresh daemon with
                // an empty store sends NO `timeline_history`, so the replace path
                // (BridgeEvent.TimelineHistory) never fires and old rows linger.
                // `connection` precedes `timeline_history` in the initial burst,
                // so a daemon that HAS history repopulates it immediately after
                // this clear; a fresh one correctly stays empty.
                TimelineStore.instance.clear()
                _state.update {
                    it.copy(
                        bridgeConnected = true,
                        sessionId = event.sessionId,
                        // Drop any focus carried over from a prior connection.
                        // The daemon's relay re-emits focus on its first
                        // state_update, so re-establishing connection should
                        // start clean.
                        focusedSessionId = null,
                    )
                }
                SessionMetrics.instance.onConnected()
            }

            is BridgeEvent.DisplaySleep -> {
                _state.update { it.copy(hostDisplayOn = event.displayOn, hostDim = event.dim) }
            }

            is BridgeEvent.SessionsList -> {
                stateDebug { "SessionsList: ${event.sessions.size} sessions" }
                if (VERBOSE_STATE_LOGS || Log.isLoggable(TAG, Log.DEBUG)) {
                    for (s in event.sessions) {
                        Log.d(TAG, "  Session: id=${s.id}, agentType=${s.agentType}, state=${s.state}, projectName=${s.projectName}")
                    }
                }
                _state.update { it.copy(siblingSessions = event.sessions) }
            }

            is BridgeEvent.EncoderState -> { /* Deck tab removed — ignore */ }

            is BridgeEvent.ButtonState -> { /* Deck tab removed — ignore */ }

            is BridgeEvent.SlotMap -> { /* Deck tab removed — ignore */ }

            is BridgeEvent.Timeline -> {
                if (event.upsert) {
                    TimelineStore.instance.upsertEntry(event.entry.toTimelineEntry())
                } else {
                    TimelineStore.instance.addEntry(event.entry.toTimelineEntry())
                }
                StateTimelineGenerator.instance.setReceivingBridgeTimeline(true)
            }

            is BridgeEvent.TimelineHistory -> {
                // The daemon's only history push to a client is the full store
                // snapshot on (re)connect — replace, don't merge, so re-stamped
                // OpenClaw rows can't stack up across the tablet's reconnects.
                TimelineStore.instance.replaceSnapshot(event.entries.map { it.toTimelineEntry() })
                StateTimelineGenerator.instance.setReceivingBridgeTimeline(true)
            }

            is BridgeEvent.Disconnected -> {
                _state.update {
                    it.copy(
                        bridgeConnected = false,
                        agentState = AgentState.DISCONNECTED,
                        hostDisplayOn = true,
                        gatewayConnected = false,
                        gatewayHasError = false,
                        workerSessionCount = null,
                        siblingSessions = emptyList(),
                        // Both session ids are connection-scoped — clear so
                        // a fresh connection starts clean (mirrors Apple
                        // AgentStateHolder.resetToDisconnected).
                        sessionId = null,
                        focusedSessionId = null,
                        // Purge Node-relayed usage/LIMITS cache. A fresh (or
                        // limited) daemon on reconnect never re-emits these, and
                        // the top-level fields use null-coalescing merge that
                        // would otherwise keep the OLD daemon's values frozen —
                        // showing LIMITS/subscription data that is actually
                        // unavailable. Cleared on the DISCONNECT edge (not
                        // Connect) because the reconnect burst delivers
                        // usage_update BEFORE the connection event, so the fresh
                        // daemon's real values repopulate cleanly right after.
                        // Mirrors Apple AgentStateHolder.clearRelayedUsageState().
                        usage = UsageUpdate(),
                        subscriptions = emptyList(),
                        antigravityStatus = null,
                        codexRateLimits = null,
                    )
                }
                SessionMetrics.instance.onDisconnected()
                StateTimelineGenerator.instance.onDisconnected()
            }
        }
    }
}
