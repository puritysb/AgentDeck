#pragma once

#include <cstdint>
#include <cstring>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include "config.h"

// ===== Agent state enums =====
enum class AgentState : uint8_t {
    DISCONNECTED = 0,
    IDLE,
    PROCESSING,
    AWAITING_PERMISSION,
    AWAITING_OPTION,
    AWAITING_DIFF
};

enum class CreatureState : uint8_t {
    SLEEPING = 0,
    FLOATING,
    WORKING,
    ASKING
};

enum class CrayfishState : uint8_t {
    DORMANT = 0,
    SITTING,
    ROUTING,
    SICK
};

enum class TetraState : uint8_t {
    HOVERING = 0,
    CIRCLING,
    STREAMING
};

// ===== Prompt option =====
struct PromptOption {
    char label[80];
    char action[40];
    uint8_t index;
    bool recommended;
    bool selected;
};

// Per-session prompt option (trimmed vs the global PromptOption — sized for
// small interactive surfaces that answer per session, e.g. the T-Embed knob).
struct SessionOption {
    char label[64];
    uint8_t index;
    bool recommended;
};
// This array is the largest single line item in g_state: cap × 66 B × 10
// sessions. The ESP32-classic boards have no PSRAM and a DRAM segment the
// terrarium canvas already eats into, and neither surface can render an option
// list anyway — TTGO is a 240×135 two-button panel, TC001 an 8×32 LED matrix.
// Without this guard the growth of g_state overflowed TTGO's dram0_0_seg by
// 768 bytes, which surfaces only as a link error on those two envs. Both
// consumers are bound-checked against this cap (protocol.cpp parse loop,
// knob_ui's local buffer), so a lower value truncates rather than corrupts.
#if defined(BOARD_TTGO) || defined(BOARD_LED8X32)
constexpr uint8_t SESSION_OPTIONS_CAP = 2;
#else
constexpr uint8_t SESSION_OPTIONS_CAP = 6;
#endif

// Voice "auto"-target preference: dictation with no explicit pick should land
// on a general-purpose assistant, not whichever project session happens to
// sort first — a coding session treats a spoken question as a work order for
// its repo. OpenClaw is identified by agent type; Hermes-style assistants run
// under a normal agent CLI, so they are recognized by project name prefix
// (case-insensitive "hermes").
inline bool isGeneralAssistantSession(const char* agentType, const char* projectName) {
    if (agentType && strcmp(agentType, "openclaw") == 0) return true;
    if (projectName) {
        const char* h = "hermes";
        for (size_t i = 0; h[i]; i++) {
            char c = projectName[i];
            if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
            if (c != h[i]) return false;
        }
        return true;
    }
    return false;
}

// ===== Session info (multi-agent) =====
struct SessionInfo {
    char id[32];
    char projectName[40];
    char modelName[32];
    char agentType[16];  // "claude-code" / "openclaw" / "codex-cli" / "codex-app"
    char state[20];
    uint16_t port;
    bool alive;
    // Per-session detail for the IPS10 D1 mosaic (cells show tool/elapsed; awaiting
    // cells render inline Approve/Deny). Populated from the enriched sessions_list.
    char currentTool[40];   // current tool/command for this session ("" when none)
    uint32_t elapsedSec;    // seconds since this session started (0 when unknown)
    char question[160];     // awaiting prompt text for this session ("" when not awaiting)
    char promptType[20];    // "yes_no" / "multi_select" / "diff_review" / ...
    char requestId[40];     // gated PreToolUse request id → reply permission_decision
    char permissionMode[20]; // managed-session Claude permission mode ("" when unknown)
    // Parsed per-session options from the enriched sessions_list (select_option
    // is session-scoped, so an interactive surface answers without global focus).
    SessionOption options[SESSION_OPTIONS_CAP];
    uint8_t optionCount;
    char activity[80];      // shared one-liner summary of recent work ("" when none)
#if defined(BOARD_IPS10)
    // Optional existing wire census. Six bytes per session, IPS10 only; no heap.
    bool childrenKnown;
    uint16_t childrenActive;
    uint16_t childrenCompleted;
    // Optional coordination census (workers spawned + background jobs this
    // session is waiting on). Unknown when absent, never a stale count.
    bool coordinationKnown;
    uint16_t backgroundJobs;
    uint16_t spawnedActive;
#endif
    // Daemon-computed "latest milestone" for this session (TIMELINE parity):
    // the newest chat/task row from the daemon's authoritative timeline store.
    // The on-device ring is tiny and empty after every (re)boot, so cards that
    // relied on it went blank/meaningless — the daemon owns this line instead.
    char lastEventText[100]; // milestone row text (turn ask/answer, task label)
    char lastEventTask[40];  // resolved enclosing-task label ("" when none)
    char lastEventHm[6];     // host-local "HH:MM" of that row ("" when unknown)
};

// ===== Timeline entry =====
struct TimelineEntry {
    uint32_t ts;        // seconds since midnight, UTC-derived (compact)
    char hm[6];         // host-local "HH:MM" (daemon-preformatted; "" on old daemons)
    char type[16];      // "chat_start", "tool_request", etc.
    char raw[120];      // description
    char detail[200];   // extended detail (optional)
    char status[12];    // "pending"/"approved"/"denied"
    char sessionId[32]; // owning session — lets the D1 detail overlay filter per session ("" = global)
    char agentType[16]; // "claude-code"/"codex-cli"/... — brand attribution for the row ("" = none)
    char projectName[40]; // worktree/project name for the row ("" = none)
    char taskId[24];    // enclosing task id (links turn rows to their task header; "" = none)
};

#if defined(BOARD_T_EMBED)
// Session-scoped timeline backfill for the knob's History scrub view. Kept
// separate from the global timeline ring so a query_session_timeline reply
// never clobbers the live feed.
struct ScrubEntry {
    char hm[6];
    char type[16];
    char text[100];
};
constexpr uint8_t KNOB_SCRUB_CAP = 12;
#endif

// ===== Main dashboard state =====
struct DashboardState {
    // Connection
    bool wsConnected;
    char bridgeIp[16];
    uint16_t bridgePort;
    char authToken[40];
    uint32_t lastMessageMs;   // millis() of last JSON received (serial OR ws); 0 = never

    // Agent
    AgentState state;
    char projectName[40];
    char modelName[32];
    char agentType[16];
    char effortLevel[8];

    // Usage
    float fiveHourPercent;    // 0-100
    float sevenDayPercent;    // 0-100
    char fiveHourReset[20];   // "1h 23m" formatted
    char sevenDayReset[20];   // "2d 4h" formatted
    uint32_t inputTokens;
    uint32_t outputTokens;
    uint32_t toolCalls;
    uint32_t sessionDurationSec;
    float estimatedCostUsd;
    bool usageStale;
    // Codex (ChatGPT) rolling-window limits — mirror the Claude 5h/7d shape.
    // Sourced from the user's local Codex rollout files (bridge codex-rate-limits.ts).
    // -1.0f sentinel = "no data" (window absent / not a Codex user).
    float codexPrimaryPercent;     // ≈5h window usedPercent (0-100)
    float codexSecondaryPercent;   // ≈7d window usedPercent (0-100)
    char codexPrimaryReset[20];    // "1h 23m" relative (needs NTP) or ""
    char codexSecondaryReset[20];
    // Antigravity local IDE quota. availableCredits is a raw count (no max),
    // so it renders as a text chip, not a gauge. -1.0f = "no data".
    float antigravityCredits;
    char antigravityPlan[24];
    // Account subscriptions from usage_update `subscriptions[]` — plan name +
    // (serial-preformatted) expiry like "~7/12". Empty when the daemon can't
    // resolve them; surfaces hide the line in that case.
    struct SubscriptionSlot { char name[28]; char until[12]; } subscriptions[3];
    uint8_t subscriptionCount;

    // Permission/Options
    char question[200];
    char promptType[20];
    PromptOption options[8];
    uint8_t optionCount;

    // Sessions (multi-agent). Cap is 10 — matches SERIAL_SESSIONS_CAP in
    // bridge/src/esp32-serial.ts and the daemon WS sessions_list. Keep in sync.
    SessionInfo sessions[10];
    uint8_t sessionCount;
#if defined(BOARD_IPS10)
    // Roster size on the daemon when it exceeds the cards (0 = not sent).
    uint16_t sessionsTotal;
#endif
    // Session explicitly selected by a steering surface. The daemon includes
    // it on state_update so companion devices can behave as one desk set.
    char focusedSessionId[32];
    uint8_t octopusCount;   // derived: claude-code sessions alive
    uint8_t cloudCount;     // derived: Codex CLI/App sessions alive
    uint8_t opencodeCount;  // derived: opencode sessions alive
    uint8_t antigravityCount; // derived: antigravity sessions alive
    uint8_t kiroCount;      // derived: kiro-cli/kiro-ide sessions alive
    uint8_t crayfishCount;  // derived: openclaw sessions alive
    bool sessionClearPending;       // empty sessions_list debounce in progress
    uint32_t sessionClearPendingMs; // millis() when the empty list first arrived
    // Per-type display names (dedup-numbered). Sized to the session cap so they
    // safely cover every board's MAX_OCTOPUS/MAX_CLOUD/MAX_OPENCODE (≤8).
    char sessionNames[10][24]; // display names for octopus instances
    char cloudNames[10][24];   // display names for cloud instances
    char opencodeNames[10][24]; // display names for opencode instances
    char antigravityNames[10][24]; // display names for antigravity instances
    char kiroNames[10][24]; // display names for kiro instances

    // Crayfish state (derived from sibling)
    CrayfishState crayfishState;
    bool gatewayAvailable;   // OpenClaw process reachable on localhost:18789
    bool gatewayConnected;   // OpenClaw Gateway authenticated — drives crayfish visibility
    bool gatewayHasError;

    // Current tool (processing indicator)
    char currentTool[40];
    char toolInput[80];

    // Timeline
    TimelineEntry timeline[TIMELINE_MAX_ENTRIES];
    uint8_t timelineHead;
    uint8_t timelineCount;

#if defined(BOARD_T_EMBED)
    // History scrub buffer (chronological ascending; filled by a session-scoped
    // timeline_history reply matching scrubSessionId).
    ScrubEntry scrub[KNOB_SCRUB_CAP];
    uint8_t scrubCount;
    char scrubSessionId[32];
#endif

    // Creature states (derived from agent state)
    CreatureState creatureState;
    TetraState tetraState;

    // Data reception tracking
    bool dataReceived;  // true after first state_update from bridge

    // Display
    bool hostDisplayOn;     // Mac display awake (from display_state event)
    uint8_t userBrightness; // user-set brightness (restored when host wakes)
    // Host-pushed dim instruction (from the display_state event's `dim` object).
    // Defaults reproduce legacy full-off so an un-upgraded host (no `dim` field)
    // still dims to 0 on sleep.
    bool hostDimEnabled;    // false ⇒ don't dim when the host display sleeps
    uint8_t hostDimMode;    // 0 = off (brightness 0), 1 = min (dim to hostDimLevel)
    uint8_t hostDimLevel;   // min-brightness, pre-scaled to 0-255

    // View state
    bool hudVisible;

    // Orientation change request (set by protocol/buttons, consumed by UI task)
    bool orientationChanged;
    bool pendingLandscape;
    int8_t pendingRotation;  // -1 = use pendingLandscape; 0-3 = explicit 90° rotation index

    void reset() {
        memset(this, 0, sizeof(DashboardState));
        state = AgentState::DISCONNECTED;
        creatureState = CreatureState::SLEEPING;
        crayfishState = CrayfishState::DORMANT;
        tetraState = TetraState::HOVERING;
        hostDisplayOn = true;
        userBrightness = 255;
        hostDimEnabled = true;
        hostDimMode = 0;     // off
        hostDimLevel = 25;   // ~10% fallback (only used in min mode)
        hudVisible = true;
        orientationChanged = false;
        pendingLandscape = true;
        pendingRotation = -1;
        sessionClearPending = false;
        sessionClearPendingMs = 0;
        // Sentinel -1.0f = "no data" (0 is a valid usage value)
        fiveHourPercent = -1.0f;
        sevenDayPercent = -1.0f;
        estimatedCostUsd = -1.0f;
        codexPrimaryPercent = -1.0f;
        codexSecondaryPercent = -1.0f;
        codexPrimaryReset[0] = '\0';
        codexSecondaryReset[0] = '\0';
        antigravityCredits = -1.0f;
        antigravityPlan[0] = '\0';
    }

    // Called while g_stateMutex is held. Keep long-lived connection memory
    // such as lastMessageMs, but clear volatile bridge data so every surface
    // renders a reconnect/disconnected state instead of stale session data.
    void markBridgeDisconnected() {
        wsConnected = false;
        state = AgentState::DISCONNECTED;
        projectName[0] = '\0';
        modelName[0] = '\0';
        agentType[0] = '\0';
        effortLevel[0] = '\0';
        currentTool[0] = '\0';
        toolInput[0] = '\0';
        question[0] = '\0';
        promptType[0] = '\0';
        optionCount = 0;
        focusedSessionId[0] = '\0';
        clearSessions();
        gatewayAvailable = false;
        gatewayConnected = false;
        gatewayHasError = false;
        dataReceived = false;
        fiveHourPercent = -1.0f;
        sevenDayPercent = -1.0f;
        fiveHourReset[0] = '\0';
        sevenDayReset[0] = '\0';
        codexPrimaryPercent = -1.0f;
        codexSecondaryPercent = -1.0f;
        codexPrimaryReset[0] = '\0';
        codexSecondaryReset[0] = '\0';
        antigravityCredits = -1.0f;
        antigravityPlan[0] = '\0';
        usageStale = true;
        updateCreatureStates();
    }

    void clearSessions() {
        sessionClearPending = false;
        sessionClearPendingMs = 0;
        sessionCount = 0;
        focusedSessionId[0] = '\0';
        octopusCount = 0;
        cloudCount = 0;
        opencodeCount = 0;
        antigravityCount = 0;
        kiroCount = 0;
        crayfishCount = 0;
        memset(sessions, 0, sizeof(sessions));
        memset(sessionNames, 0, sizeof(sessionNames));
        memset(cloudNames, 0, sizeof(cloudNames));
        memset(opencodeNames, 0, sizeof(opencodeNames));
        memset(antigravityNames, 0, sizeof(antigravityNames));
        memset(kiroNames, 0, sizeof(kiroNames));
        updateCreatureStates();
    }

    void applyPendingSessionClear(uint32_t nowMs) {
        if (!sessionClearPending) return;
        if ((uint32_t)(nowMs - sessionClearPendingMs) < SESSION_EMPTY_GRACE_MS) return;
        clearSessions();
    }

    // Derive creature states from agent state
    void updateCreatureStates() {
        switch (state) {
            case AgentState::DISCONNECTED:
                creatureState = CreatureState::SLEEPING;
                tetraState = TetraState::HOVERING;
                break;
            case AgentState::IDLE:
                creatureState = CreatureState::FLOATING;
                tetraState = TetraState::CIRCLING;
                break;
            case AgentState::PROCESSING:
                creatureState = CreatureState::WORKING;
                tetraState = TetraState::STREAMING;
                break;
            case AgentState::AWAITING_PERMISSION:
            case AgentState::AWAITING_OPTION:
            case AgentState::AWAITING_DIFF:
                creatureState = CreatureState::ASKING;
                tetraState = TetraState::HOVERING;
                break;
        }

        // Derive crayfish state from gateway when no sessions_list received.
        // Reachability alone (`gatewayAvailable`) isn't enough — the crayfish
        // only comes out when the Gateway is authenticated, matching the
        // iOS/Android terrariums.
        if (crayfishCount == 0) {
            if (gatewayHasError) {
                crayfishState = CrayfishState::SICK;
            } else if (gatewayConnected) {
                crayfishState = CrayfishState::SITTING;
            } else {
                crayfishState = CrayfishState::DORMANT;
            }
        }
    }

    // Add timeline entry (ring buffer)
    void addTimelineEntry(const TimelineEntry& entry) {
        uint8_t idx = (timelineHead + timelineCount) % TIMELINE_MAX_ENTRIES;
        if (timelineCount >= TIMELINE_MAX_ENTRIES) {
            timelineHead = (timelineHead + 1) % TIMELINE_MAX_ENTRIES;
        } else {
            timelineCount++;
        }
        timeline[idx] = entry;
    }

    // Active child count for a parent session, derived from the existing
    // fixed timeline ring. No protocol field and no heap/cache allocation:
    // old firmware ignores the summarized rows, new renderers can decorate
    // the parent without turning children into selectable sessions.
    uint8_t activeSubagentsForSession(const char* sessionId) const {
        if (!sessionId || !sessionId[0]) return 0;
        uint8_t count = 0;
        for (uint8_t i = 0; i < timelineCount; i++) {
            const TimelineEntry& entry =
                timeline[(timelineHead + i) % TIMELINE_MAX_ENTRIES];
            if (strcmp(entry.sessionId, sessionId) != 0 ||
                strncmp(entry.raw, "Subagent ", 9) != 0) {
                continue;
            }
            if (strcmp(entry.type, "tool_exec") == 0) {
                if (count < 255) count++;
            } else if (strcmp(entry.type, "tool_resolved") == 0 && count > 0) {
                count--;
            }
        }
        return count;
    }
};

// Global state — accessed from both cores (use mutex)
extern DashboardState g_state;
extern SemaphoreHandle_t g_stateMutex;

inline void lockState()   { xSemaphoreTake(g_stateMutex, portMAX_DELAY); }
inline void unlockState() { xSemaphoreGive(g_stateMutex); }
