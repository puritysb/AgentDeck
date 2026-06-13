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

// ===== Session info (multi-agent) =====
struct SessionInfo {
    char id[32];
    char projectName[40];
    char modelName[32];
    char agentType[16];  // "claude-code" / "openclaw" / "codex-cli" / "codex-app"
    char state[20];
    uint16_t port;
    bool alive;
};

// ===== Timeline entry =====
struct TimelineEntry {
    uint32_t ts;        // seconds since midnight (compact)
    char type[16];      // "chat_start", "tool_request", etc.
    char raw[120];      // description
    char detail[200];   // extended detail (optional)
    char status[12];    // "pending"/"approved"/"denied"
};

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

    // Permission/Options
    char question[200];
    char promptType[20];
    PromptOption options[8];
    uint8_t optionCount;

    // Sessions (multi-agent)
    SessionInfo sessions[6];
    uint8_t sessionCount;
    uint8_t octopusCount;   // derived: claude-code sessions alive
    uint8_t cloudCount;     // derived: Codex CLI/App sessions alive
    uint8_t opencodeCount;  // derived: opencode sessions alive
    uint8_t crayfishCount;  // derived: openclaw sessions alive
    char sessionNames[6][24]; // display names for octopus instances (matches max MAX_OCTOPUS)
    char cloudNames[4][24];   // display names for cloud instances (matches max MAX_CLOUD)
    char opencodeNames[4][24]; // display names for opencode instances

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
    bool timelineView;  // true = timeline screen, false = aquarium

    // Orientation change request (set by protocol, consumed by UI task)
    bool orientationChanged;
    bool pendingLandscape;

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
        timelineView = false;
        orientationChanged = false;
        pendingLandscape = true;
        // Sentinel -1.0f = "no data" (0 is a valid usage value)
        fiveHourPercent = -1.0f;
        sevenDayPercent = -1.0f;
        estimatedCostUsd = -1.0f;
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
        sessionCount = 0;
        octopusCount = 0;
        cloudCount = 0;
        opencodeCount = 0;
        crayfishCount = 0;
        gatewayAvailable = false;
        gatewayConnected = false;
        gatewayHasError = false;
        dataReceived = false;
        fiveHourPercent = -1.0f;
        sevenDayPercent = -1.0f;
        fiveHourReset[0] = '\0';
        sevenDayReset[0] = '\0';
        usageStale = true;
        timelineView = false;
        updateCreatureStates();
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
};

// Global state — accessed from both cores (use mutex)
extern DashboardState g_state;
extern SemaphoreHandle_t g_stateMutex;

inline void lockState()   { xSemaphoreTake(g_stateMutex, portMAX_DELAY); }
inline void unlockState() { xSemaphoreGive(g_stateMutex); }
