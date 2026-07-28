#include "protocol.h"
#include "wifi_manager.h"
#include "ws_client.h"
#include "serial_client.h"
#include "../state/agent_state.h"
#include "../util/ota_capability.h"
#include "../util/reset_reason.h"
#include "../util/usage_format.h"
#include "../util/utf8.h"
#include "config.h"
#include <ArduinoJson.h>
#include <Arduino.h>
#include <WiFi.h>
#include <Update.h>
#include <mbedtls/base64.h>
// Unconditional: the board headers define capability macros (BOARD_HAS_SPEAKER,
// BOARD_SPK_CODEC_ES8311, ...) that the guards below test. Only the -DBOARD_*
// selectors come from build flags; everything else needs this include first.
#include "../boards/board_config.h"
#if defined(BOARD_IPS35) || defined(BOARD_AMOLED)
#include <Wire.h>
#endif
#if defined(BOARD_T_EMBED)
#include "../ui/knob/knob_ui.h"
#include "../input/power_monitor.h"
#include "../input/ir_receiver.h"
#include "../input/nfc_reader.h"
#include "../audio/mic_capture.h"
#include "../audio/speaker_playback.h"
#endif
#if defined(BOARD_T_DISPLAY_PRO)
#include "../input/touch_strip.h"
#include "../input/light_sensor.h"
#include "../input/power_monitor.h"
#include "../ui/ticker/ticker_ui.h"
#include "../ui/pocket/pocket_ui.h"
#include "../camera/photo_capture.h"
#endif
#if defined(BOARD_IPS10)
#include "../ui/display.h"         // UI::hwI2cProbe — audio-codec hardware probe
#endif
#if defined(BOARD_SPK_CODEC_ES8311)
#include "../audio/speaker_playback.h"
#include "../audio/es8311_codec.h"
#endif

// Reusable JSON document — sized for typical bridge messages
static JsonDocument doc;

struct OtaRxState {
    bool active;
    char otaId[40];
    uint32_t expectedSize;
    uint32_t written;
    uint32_t nextSeq;
};

static OtaRxState otaRx = {false, {0}, 0, 0, 0};
static uint8_t otaChunkBuf[1024];

static AgentState parseState(const char* s) {
    if (!s) return AgentState::DISCONNECTED;
    if (strcmp(s, "idle") == 0)                 return AgentState::IDLE;
    if (strcmp(s, "processing") == 0)           return AgentState::PROCESSING;
    if (strcmp(s, "awaiting_permission") == 0)  return AgentState::AWAITING_PERMISSION;
    if (strcmp(s, "awaiting_option") == 0)      return AgentState::AWAITING_OPTION;
    if (strcmp(s, "awaiting_diff") == 0)        return AgentState::AWAITING_DIFF;
    return AgentState::DISCONNECTED;
}

static bool isCodexAgent(const char* agentType) {
    return agentType &&
           (strcmp(agentType, "codex-cli") == 0 ||
            strcmp(agentType, "codex-app") == 0);
}

// strncpy + NUL + drop any mid-UTF-8 cut. Daemon text (prompts, activity,
// timeline rows, 프로젝트명) can exceed these byte-sized buffers — a plain
// strncpy leaves a split 한글/CJK sequence that renders as a broken glyph.
static void copyTextU8(char* dst, size_t cap, const char* src) {
    if (cap == 0) return;
    strncpy(dst, src ? src : "", cap - 1);
    dst[cap - 1] = '\0';
    Utf8::utf8TrimEnd(dst);
}

static void handleStateUpdate(JsonObject& obj) {
    lockState();

    g_state.state = parseState(obj["state"].as<const char*>());
    if (obj["focusedSessionId"].is<const char*>()) {
        copyTextU8(g_state.focusedSessionId, sizeof(g_state.focusedSessionId),
                   obj["focusedSessionId"].as<const char*>());
    }

    // Project & model
    if (obj["projectName"].is<const char*>())
        copyTextU8(g_state.projectName, sizeof(g_state.projectName), obj["projectName"].as<const char*>());
    if (obj["modelName"].is<const char*>())
        strncpy(g_state.modelName, obj["modelName"].as<const char*>(), sizeof(g_state.modelName) - 1);
    if (obj["agentType"].is<const char*>())
        strncpy(g_state.agentType, obj["agentType"].as<const char*>(), sizeof(g_state.agentType) - 1);
    if (obj["effortLevel"].is<const char*>())
        strncpy(g_state.effortLevel, obj["effortLevel"].as<const char*>(), sizeof(g_state.effortLevel) - 1);

    // Current tool
    if (obj["currentTool"].is<const char*>())
        strncpy(g_state.currentTool, obj["currentTool"].as<const char*>(), sizeof(g_state.currentTool) - 1);
    else
        g_state.currentTool[0] = '\0';
    if (obj["toolInput"].is<const char*>())
        copyTextU8(g_state.toolInput, sizeof(g_state.toolInput), obj["toolInput"].as<const char*>());
    else
        g_state.toolInput[0] = '\0';

    // Permission/Options
    if (obj["question"].is<const char*>())
        copyTextU8(g_state.question, sizeof(g_state.question), obj["question"].as<const char*>());
    if (obj["promptType"].is<const char*>())
        strncpy(g_state.promptType, obj["promptType"].as<const char*>(), sizeof(g_state.promptType) - 1);

    // Options array
    if (obj["options"].is<JsonArray>()) {
        JsonArray opts = obj["options"].as<JsonArray>();
        g_state.optionCount = min((int)opts.size(), 8);
        for (uint8_t i = 0; i < g_state.optionCount; i++) {
            JsonObject o = opts[i].as<JsonObject>();
            copyTextU8(g_state.options[i].label, sizeof(g_state.options[i].label), o["label"] | "");
            g_state.options[i].index = o["index"] | i;
            g_state.options[i].recommended = o["recommended"] | false;
            g_state.options[i].selected = o["selected"] | false;

            // Build action string
            if (o["shortcut"].is<const char*>()) {
                strncpy(g_state.options[i].action, o["shortcut"].as<const char*>(),
                        sizeof(g_state.options[i].action) - 1);
            }
        }
    }

    // Gateway
    // gatewayAvailable = OpenClaw process reachable (kept for future topology
    // widgets). gatewayConnected = authenticated — the one that drives
    // crayfish rendering. Older daemons that don't broadcast gatewayConnected
    // will leave it at false, so the crayfish stays dormant until they update.
    g_state.gatewayAvailable = obj["gatewayAvailable"] | false;
    g_state.gatewayConnected = obj["gatewayConnected"] | false;
    g_state.gatewayHasError = obj["gatewayHasError"] | false;

    // Mark that we've received real data from bridge
    g_state.dataReceived = true;

    // Derive creature states
    g_state.updateCreatureStates();

    unlockState();
}

static void handleUsageUpdate(JsonObject& obj) {
    lockState();
    g_state.dataReceived = true;

    // Percent fields: use -1.0f sentinel for "no data" (0 is a valid value).
    // When bridge omits the field (stale TTL expired), clear to sentinel
    // instead of keeping the old sticky value.
    g_state.fiveHourPercent = obj["fiveHourPercent"].is<float>()
        ? obj["fiveHourPercent"].as<float>() : -1.0f;
    g_state.sevenDayPercent = obj["sevenDayPercent"].is<float>()
        ? obj["sevenDayPercent"].as<float>() : -1.0f;

    g_state.inputTokens = obj["inputTokens"] | g_state.inputTokens;
    g_state.outputTokens = obj["outputTokens"] | g_state.outputTokens;
    g_state.toolCalls = obj["toolCalls"] | g_state.toolCalls;
    g_state.sessionDurationSec = obj["sessionDurationSec"] | g_state.sessionDurationSec;
    g_state.estimatedCostUsd = obj["estimatedCostUsd"].is<float>()
        ? obj["estimatedCostUsd"].as<float>() : -1.0f;
    g_state.usageStale = obj["usageStale"] | false;

    // Reset times: pre-formatted "Xh Ym" (relay) or ISO 8601 (bridge WebSocket)
    auto storeResetTime = [](JsonObject& obj, const char* key, char* out, size_t outLen) {
        if (!obj[key].is<const char*>()) { out[0] = '\0'; return; }
        const char* val = obj[key].as<const char*>();

        // Already formatted (no 'T' separator) — store directly
        if (strchr(val, 'T') == nullptr) {
            strncpy(out, val, outLen - 1);
            out[outLen - 1] = '\0';
            return;
        }

        // ISO 8601 — parse and compute relative time (needs NTP)
        struct tm tm = {};
        int tzH = 0, tzM = 0;
        char tzSign = '+';
        if (sscanf(val, "%d-%d-%dT%d:%d:%d",
                   &tm.tm_year, &tm.tm_mon, &tm.tm_mday,
                   &tm.tm_hour, &tm.tm_min, &tm.tm_sec) >= 6) {
            // Parse timezone offset (e.g. "+00:00", "+09:00")
            const char* tz = strrchr(val, '+');
            if (!tz) tz = strrchr(val, '-');
            // Make sure it's not the date separator
            if (tz && tz > val + 10) {
                tzSign = *tz;
                sscanf(tz + 1, "%d:%d", &tzH, &tzM);
            }

            tm.tm_year -= 1900;
            tm.tm_mon -= 1;

            // Convert to UTC epoch using timegm-equivalent
            // (mktime uses local time, but we set TZ to UTC via configTzTime)
            time_t resetEpoch = mktime(&tm);
            // Apply timezone offset to get UTC
            int offsetSec = (tzH * 3600 + tzM * 60) * (tzSign == '+' ? -1 : 1);
            resetEpoch += offsetSec;

            time_t now = time(nullptr);
            // Check if NTP has synced (time > 2025-01-01)
            if (now < 1735689600) {
                // No NTP yet — can't compute relative time
                out[0] = '\0';
                return;
            }

            int diffSec = (int)(resetEpoch - now);
            if (diffSec <= 0) {
                strncpy(out, "now", outLen - 1);
                out[outLen - 1] = '\0';
                return;
            }

            int diffMin = diffSec / 60;
            if (diffMin < 60) {
                snprintf(out, outLen, "%dm", diffMin);
            } else {
                int h = diffMin / 60;
                int m = diffMin % 60;
                if (h < 24) {
                    if (m > 0) snprintf(out, outLen, "%dh %dm", h, m);
                    else snprintf(out, outLen, "%dh", h);
                } else {
                    int d = h / 24;
                    int rh = h % 24;
                    if (rh > 0) snprintf(out, outLen, "%dd %dh", d, rh);
                    else snprintf(out, outLen, "%dd", d);
                }
            }
        } else {
            out[0] = '\0';
        }
    };

    storeResetTime(obj, "fiveHourResetsAt", g_state.fiveHourReset, sizeof(g_state.fiveHourReset));
    storeResetTime(obj, "sevenDayResetsAt", g_state.sevenDayReset, sizeof(g_state.sevenDayReset));

    // Codex (ChatGPT) rolling-window limits. Nested object mirrors the Claude
    // 5h/7d shape — primary ≈ 5h window, secondary ≈ 7d. Absent (→ sentinel)
    // for non-Codex users. Reuses the storeResetTime lambda on each window.
    g_state.codexPrimaryPercent = -1.0f;
    g_state.codexSecondaryPercent = -1.0f;
    g_state.codexPrimaryReset[0] = '\0';
    g_state.codexSecondaryReset[0] = '\0';
    if (obj["codexRateLimits"].is<JsonObject>()) {
        JsonObject cx = obj["codexRateLimits"].as<JsonObject>();
        if (cx["primary"].is<JsonObject>()) {
            JsonObject p = cx["primary"].as<JsonObject>();
            if (!p["stale"].as<bool>()) {
                if (p["usedPercent"].is<float>()) g_state.codexPrimaryPercent = p["usedPercent"].as<float>();
                storeResetTime(p, "resetsAt", g_state.codexPrimaryReset, sizeof(g_state.codexPrimaryReset));
            }
        }
        if (cx["secondary"].is<JsonObject>()) {
            JsonObject s = cx["secondary"].as<JsonObject>();
            if (!s["stale"].as<bool>()) {
                if (s["usedPercent"].is<float>()) g_state.codexSecondaryPercent = s["usedPercent"].as<float>();
                storeResetTime(s, "resetsAt", g_state.codexSecondaryReset, sizeof(g_state.codexSecondaryReset));
            }
        }
    }

    // Antigravity local IDE quota — availableCredits is a raw count (no max),
    // so consumers render it as a text chip rather than a percentage gauge.
    g_state.antigravityCredits = -1.0f;
    g_state.antigravityPlan[0] = '\0';
    if (obj["antigravityStatus"].is<JsonObject>()) {
        JsonObject ag = obj["antigravityStatus"].as<JsonObject>();
        if (ag["availableCredits"].is<float>())
            g_state.antigravityCredits = ag["availableCredits"].as<float>();
        if (ag["planName"].is<const char*>()) {
            strncpy(g_state.antigravityPlan, ag["planName"].as<const char*>(),
                    sizeof(g_state.antigravityPlan) - 1);
            g_state.antigravityPlan[sizeof(g_state.antigravityPlan) - 1] = '\0';
        }
    }

    // Account subscriptions (plan name + preformatted expiry). Only replace
    // when the key is present so a payload without it keeps the last known.
    if (obj["subscriptions"].is<JsonArray>()) {
        JsonArray subs = obj["subscriptions"].as<JsonArray>();
        g_state.subscriptionCount = 0;
        for (JsonObject sub : subs) {
            if (g_state.subscriptionCount >= 3) break;
            auto& slot = g_state.subscriptions[g_state.subscriptionCount];
            strncpy(slot.name, sub["name"] | "", sizeof(slot.name) - 1);
            slot.name[sizeof(slot.name) - 1] = '\0';
            // `until` arrives pre-formatted ("~7/12") over serial but as raw ISO
            // over the WiFi WS path (the daemon broadcasts the unmodified event).
            // Normalize both to the short "~M/D" form so the panels never render
            // a bare ISO timestamp.
            UsageFormat::formatShortExpiry(sub["until"] | "", slot.until, sizeof(slot.until));
            if (slot.name[0]) g_state.subscriptionCount++;
        }
    }

    unlockState();
}

static void handleSessionsList(JsonObject& obj) {
    lockState();
    g_state.dataReceived = true;

    JsonArray sessions = obj["sessions"].as<JsonArray>();
    // Cap 10 — keep in sync with sessions[10] (agent_state.h) and
    // SERIAL_SESSIONS_CAP (bridge/src/esp32-serial.ts).
    uint8_t incomingCount = min((int)sessions.size(), 10);
    if (incomingCount == 0) {
        if (g_state.sessionCount > 0) {
            uint32_t nowMs = millis();
            if (!g_state.sessionClearPending) {
                g_state.sessionClearPending = true;
                g_state.sessionClearPendingMs = nowMs;
                unlockState();
                return;
            }
            if ((uint32_t)(nowMs - g_state.sessionClearPendingMs) < SESSION_EMPTY_GRACE_MS) {
                unlockState();
                return;
            }
        }
        g_state.clearSessions();
        unlockState();
        return;
    }

    g_state.sessionClearPending = false;
    g_state.sessionClearPendingMs = 0;
    g_state.sessionCount = incomingCount;
    g_state.octopusCount = 0;
    g_state.cloudCount = 0;
    g_state.opencodeCount = 0;
    g_state.antigravityCount = 0;
    g_state.crayfishCount = 0;

    for (uint8_t i = 0; i < g_state.sessionCount; i++) {
        JsonObject s = sessions[i].as<JsonObject>();
        strncpy(g_state.sessions[i].id, s["id"] | "", sizeof(g_state.sessions[i].id) - 1);
        copyTextU8(g_state.sessions[i].projectName, sizeof(g_state.sessions[i].projectName),
                   s["projectName"] | "");
        strncpy(g_state.sessions[i].modelName, s["modelName"] | "",
                sizeof(g_state.sessions[i].modelName) - 1);
        strncpy(g_state.sessions[i].agentType, s["agentType"] | "",
                sizeof(g_state.sessions[i].agentType) - 1);
        strncpy(g_state.sessions[i].state, s["state"] | "",
                sizeof(g_state.sessions[i].state) - 1);
        g_state.sessions[i].port = s["port"] | 0;
        g_state.sessions[i].alive = s["alive"] | false;

        // Per-session detail for the D1 mosaic (tool/elapsed line + inline
        // Approve/Deny). Absent keys default to "" / 0 so non-enriched daemons
        // and idle sessions render cleanly.
        strncpy(g_state.sessions[i].currentTool, s["currentTool"] | "",
                sizeof(g_state.sessions[i].currentTool) - 1);
        g_state.sessions[i].currentTool[sizeof(g_state.sessions[i].currentTool) - 1] = '\0';
        g_state.sessions[i].elapsedSec = s["elapsedSec"] | 0;
        copyTextU8(g_state.sessions[i].question, sizeof(g_state.sessions[i].question),
                   s["question"] | "");
        strncpy(g_state.sessions[i].promptType, s["promptType"] | "",
                sizeof(g_state.sessions[i].promptType) - 1);
        g_state.sessions[i].promptType[sizeof(g_state.sessions[i].promptType) - 1] = '\0';
        strncpy(g_state.sessions[i].requestId, s["requestId"] | "",
                sizeof(g_state.sessions[i].requestId) - 1);
        g_state.sessions[i].requestId[sizeof(g_state.sessions[i].requestId) - 1] = '\0';
        strncpy(g_state.sessions[i].permissionMode, s["permissionMode"] | "",
                sizeof(g_state.sessions[i].permissionMode) - 1);
        g_state.sessions[i].permissionMode[sizeof(g_state.sessions[i].permissionMode) - 1] = '\0';
        // Per-session options — lets an interactive surface answer with the
        // session-scoped select_option without global focus (knob detail view).
        g_state.sessions[i].optionCount = 0;
        if (s["options"].is<JsonArray>()) {
            JsonArray sopts = s["options"].as<JsonArray>();
            uint8_t n = 0;
            for (JsonObject o : sopts) {
                if (n >= SESSION_OPTIONS_CAP) break;
                SessionOption& dst = g_state.sessions[i].options[n];
                copyTextU8(dst.label, sizeof(dst.label), o["label"] | "");
                dst.index = o["index"] | n;
                dst.recommended = o["recommended"] | false;
                n++;
            }
            g_state.sessions[i].optionCount = n;
        }
        // Shared per-session activity one-liner (heuristic → Foundation Models
        // summary) — the most meaningful glanceable line for a dashboard row.
        copyTextU8(g_state.sessions[i].activity, sizeof(g_state.sessions[i].activity),
                   s["activity"] | "");
        // Daemon-computed latest milestone (TIMELINE parity for cards).
        copyTextU8(g_state.sessions[i].lastEventText, sizeof(g_state.sessions[i].lastEventText),
                   s["lastEventText"] | "");
        copyTextU8(g_state.sessions[i].lastEventTask, sizeof(g_state.sessions[i].lastEventTask),
                   s["lastEventTask"] | "");
        strncpy(g_state.sessions[i].lastEventHm, s["lastEventHm"] | "",
                sizeof(g_state.sessions[i].lastEventHm) - 1);
        g_state.sessions[i].lastEventHm[sizeof(g_state.sessions[i].lastEventHm) - 1] = '\0';

        if (g_state.sessions[i].alive) {
            if (strcmp(g_state.sessions[i].agentType, "openclaw") == 0) {
                g_state.crayfishCount++;
                // Derive crayfish state from sibling
                if (strcmp(g_state.sessions[i].state, "processing") == 0)
                    g_state.crayfishState = CrayfishState::ROUTING;
                else if (g_state.sessions[i].state[0] != '\0')
                    g_state.crayfishState = CrayfishState::SITTING;
            } else if (isCodexAgent(g_state.sessions[i].agentType)) {
                g_state.cloudCount++;
            } else if (strcmp(g_state.sessions[i].agentType, "opencode") == 0) {
                g_state.opencodeCount++;
            } else if (strcmp(g_state.sessions[i].agentType, "antigravity") == 0) {
                g_state.antigravityCount++;
            } else if (strcmp(g_state.sessions[i].agentType, "claude-code") == 0) {
                g_state.octopusCount++;
            }
        }
    }

    // Populate sessionNames for octopus name tags (with dedup numbering)
    // First pass: collect raw names
    char rawNames[MAX_OCTOPUS][24];
    uint8_t nameIdx = 0;
    for (uint8_t i = 0; i < g_state.sessionCount && nameIdx < MAX_OCTOPUS; i++) {
        if (g_state.sessions[i].alive &&
            strcmp(g_state.sessions[i].agentType, "claude-code") == 0) {
            const char* name = g_state.sessions[i].projectName;
            if (name[0]) {
                strncpy(rawNames[nameIdx], name, sizeof(rawNames[nameIdx]) - 1);
                rawNames[nameIdx][sizeof(rawNames[nameIdx]) - 1] = '\0';
            } else {
                snprintf(rawNames[nameIdx], sizeof(rawNames[nameIdx]), "Session %d", nameIdx + 1);
            }
            nameIdx++;
        }
    }
    // Second pass: detect duplicates and add #1, #2 suffixes
    for (uint8_t i = 0; i < nameIdx; i++) {
        bool hasDup = false;
        for (uint8_t j = 0; j < nameIdx; j++) {
            if (j != i && strcmp(rawNames[i], rawNames[j]) == 0) {
                hasDup = true;
                break;
            }
        }
        if (hasDup) {
            uint8_t occurrence = 1;
            for (uint8_t j = 0; j < i; j++) {
                if (strcmp(rawNames[i], rawNames[j]) == 0) occurrence++;
            }
            snprintf(g_state.sessionNames[i], sizeof(g_state.sessionNames[i]),
                     "%s #%d", rawNames[i], occurrence);
        } else {
            strncpy(g_state.sessionNames[i], rawNames[i],
                    sizeof(g_state.sessionNames[i]) - 1);
            g_state.sessionNames[i][sizeof(g_state.sessionNames[i]) - 1] = '\0';
        }
    }

    // Populate cloudNames for cloud creature name tags (same dedup logic)
    if (MAX_CLOUD > 0) {
    char cloudRawNames[MAX_CLOUD > 0 ? MAX_CLOUD : 1][24];
    uint8_t cloudNameIdx = 0;
    for (uint8_t i = 0; i < g_state.sessionCount && cloudNameIdx < MAX_CLOUD; i++) {
        if (g_state.sessions[i].alive &&
            isCodexAgent(g_state.sessions[i].agentType)) {
            const char* name = g_state.sessions[i].projectName;
            if (name[0]) {
                strncpy(cloudRawNames[cloudNameIdx], name, sizeof(cloudRawNames[cloudNameIdx]) - 1);
                cloudRawNames[cloudNameIdx][sizeof(cloudRawNames[cloudNameIdx]) - 1] = '\0';
            } else {
                snprintf(cloudRawNames[cloudNameIdx], sizeof(cloudRawNames[cloudNameIdx]), "Codex %d", cloudNameIdx + 1);
            }
            cloudNameIdx++;
        }
    }
    for (uint8_t i = 0; i < cloudNameIdx; i++) {
        bool hasDup = false;
        for (uint8_t j = 0; j < cloudNameIdx; j++) {
            if (j != i && strcmp(cloudRawNames[i], cloudRawNames[j]) == 0) {
                hasDup = true;
                break;
            }
        }
        if (hasDup) {
            uint8_t occurrence = 1;
            for (uint8_t j = 0; j < i; j++) {
                if (strcmp(cloudRawNames[i], cloudRawNames[j]) == 0) occurrence++;
            }
            snprintf(g_state.cloudNames[i], sizeof(g_state.cloudNames[i]),
                     "%s #%d", cloudRawNames[i], occurrence);
        } else {
            strncpy(g_state.cloudNames[i], cloudRawNames[i],
                    sizeof(g_state.cloudNames[i]) - 1);
            g_state.cloudNames[i][sizeof(g_state.cloudNames[i]) - 1] = '\0';
        }
    }
    }  // MAX_CLOUD > 0

    // Populate opencodeNames for opencode creature name tags (same dedup logic)
    if (MAX_OPENCODE > 0) {
    char opencodeRawNames[MAX_OPENCODE > 0 ? MAX_OPENCODE : 1][24];
    uint8_t opencodeNameIdx = 0;
    for (uint8_t i = 0; i < g_state.sessionCount && opencodeNameIdx < MAX_OPENCODE; i++) {
        if (g_state.sessions[i].alive &&
            strcmp(g_state.sessions[i].agentType, "opencode") == 0) {
            const char* name = g_state.sessions[i].projectName;
            if (name[0]) {
                strncpy(opencodeRawNames[opencodeNameIdx], name, sizeof(opencodeRawNames[opencodeNameIdx]) - 1);
                opencodeRawNames[opencodeNameIdx][sizeof(opencodeRawNames[opencodeNameIdx]) - 1] = '\0';
            } else {
                snprintf(opencodeRawNames[opencodeNameIdx], sizeof(opencodeRawNames[opencodeNameIdx]), "OpenCode %d", opencodeNameIdx + 1);
            }
            opencodeNameIdx++;
        }
    }
    for (uint8_t i = 0; i < opencodeNameIdx; i++) {
        bool hasDup = false;
        for (uint8_t j = 0; j < opencodeNameIdx; j++) {
            if (j != i && strcmp(opencodeRawNames[i], opencodeRawNames[j]) == 0) {
                hasDup = true;
                break;
            }
        }
        if (hasDup) {
            uint8_t occurrence = 1;
            for (uint8_t j = 0; j < i; j++) {
                if (strcmp(opencodeRawNames[i], opencodeRawNames[j]) == 0) occurrence++;
            }
            snprintf(g_state.opencodeNames[i], sizeof(g_state.opencodeNames[i]),
                     "%s #%d", opencodeRawNames[i], occurrence);
        } else {
            strncpy(g_state.opencodeNames[i], opencodeRawNames[i],
                    sizeof(g_state.opencodeNames[i]) - 1);
            g_state.opencodeNames[i][sizeof(g_state.opencodeNames[i]) - 1] = '\0';
        }
    }
    }  // MAX_OPENCODE > 0

    // Populate antigravityNames for antigravity creature name tags (same dedup logic)
    if (MAX_ANTIGRAVITY > 0) {
    char antigravityRawNames[MAX_ANTIGRAVITY > 0 ? MAX_ANTIGRAVITY : 1][24];
    uint8_t antigravityNameIdx = 0;
    for (uint8_t i = 0; i < g_state.sessionCount && antigravityNameIdx < MAX_ANTIGRAVITY; i++) {
        if (g_state.sessions[i].alive &&
            strcmp(g_state.sessions[i].agentType, "antigravity") == 0) {
            const char* name = g_state.sessions[i].projectName;
            if (name[0]) {
                strncpy(antigravityRawNames[antigravityNameIdx], name, sizeof(antigravityRawNames[antigravityNameIdx]) - 1);
                antigravityRawNames[antigravityNameIdx][sizeof(antigravityRawNames[antigravityNameIdx]) - 1] = '\0';
            } else {
                snprintf(antigravityRawNames[antigravityNameIdx], sizeof(antigravityRawNames[antigravityNameIdx]), "Antigravity %d", antigravityNameIdx + 1);
            }
            antigravityNameIdx++;
        }
    }
    for (uint8_t i = 0; i < antigravityNameIdx; i++) {
        bool hasDup = false;
        for (uint8_t j = 0; j < antigravityNameIdx; j++) {
            if (j != i && strcmp(antigravityRawNames[i], antigravityRawNames[j]) == 0) {
                hasDup = true;
                break;
            }
        }
        if (hasDup) {
            uint8_t occurrence = 1;
            for (uint8_t j = 0; j < i; j++) {
                if (strcmp(antigravityRawNames[i], antigravityRawNames[j]) == 0) occurrence++;
            }
            snprintf(g_state.antigravityNames[i], sizeof(g_state.antigravityNames[i]),
                     "%s #%d", antigravityRawNames[i], occurrence);
        } else {
            strncpy(g_state.antigravityNames[i], antigravityRawNames[i],
                    sizeof(g_state.antigravityNames[i]) - 1);
            g_state.antigravityNames[i][sizeof(g_state.antigravityNames[i]) - 1] = '\0';
        }
    }
    }  // MAX_ANTIGRAVITY > 0

    // No OpenClaw sessions: gate crayfish on authentication, not reachability.
    if (g_state.crayfishCount == 0) {
        if (g_state.gatewayHasError) {
            g_state.crayfishState = CrayfishState::SICK;
        } else if (g_state.gatewayConnected) {
            g_state.crayfishState = CrayfishState::SITTING;
        } else {
            g_state.crayfishState = CrayfishState::DORMANT;
        }
    }

    unlockState();
}

static void handleTimelineEvent(JsonObject& obj) {
    TimelineEntry entry;
    memset(&entry, 0, sizeof(entry));

    JsonObject e = obj["entry"].as<JsonObject>();
    uint64_t tsMs = e["ts"] | 0ULL;
    // Convert to seconds since midnight (compact for display)
    entry.ts = (uint32_t)((tsMs / 1000) % 86400);
    strncpy(entry.hm, e["localHm"] | "", sizeof(entry.hm) - 1);

    strncpy(entry.type, e["type"] | "", sizeof(entry.type) - 1);
    copyTextU8(entry.raw, sizeof(entry.raw), e["raw"] | "");
    if (e["detail"].is<const char*>())
        copyTextU8(entry.detail, sizeof(entry.detail), e["detail"].as<const char*>());
    if (e["status"].is<const char*>())
        strncpy(entry.status, e["status"].as<const char*>(), sizeof(entry.status) - 1);
    strncpy(entry.sessionId, e["sessionId"] | "", sizeof(entry.sessionId) - 1);
    strncpy(entry.agentType, e["agentType"] | "", sizeof(entry.agentType) - 1);
    copyTextU8(entry.projectName, sizeof(entry.projectName), e["projectName"] | "");
    strncpy(entry.taskId, e["taskId"] | "", sizeof(entry.taskId) - 1);

    lockState();
    // Upsert: check if existing entry matches (same ts + type)
    bool upsert = obj["upsert"] | false;
    if (upsert) {
        for (uint8_t i = 0; i < g_state.timelineCount; i++) {
            uint8_t idx = (g_state.timelineHead + i) % TIMELINE_MAX_ENTRIES;
            if (g_state.timeline[idx].ts == entry.ts &&
                strcmp(g_state.timeline[idx].type, entry.type) == 0) {
                g_state.timeline[idx] = entry;
                unlockState();
                return;
            }
        }
    }
    g_state.addTimelineEntry(entry);
    unlockState();
}

static void handleTimelineHistory(JsonObject& obj) {
    JsonArray entries = obj["entries"].as<JsonArray>();

#if defined(BOARD_T_EMBED)
    // Session-scoped reply (query_session_timeline) → knob History scrub
    // buffer, NOT the global ring — the reply is a backfill for one session
    // and must not clobber the live feed.
    {
        const char* sid = obj["sessionId"] | "";
        if (sid[0]) {
            size_t total = entries.size();
            size_t start = total > KNOB_SCRUB_CAP ? total - KNOB_SCRUB_CAP : 0;
            lockState();
            if (strcmp(g_state.scrubSessionId, sid) == 0) {
                g_state.scrubCount = 0;
                size_t i = 0;
                for (JsonObject e : entries) {
                    if (i++ < start) continue;
                    if (g_state.scrubCount >= KNOB_SCRUB_CAP) break;
                    ScrubEntry& se = g_state.scrub[g_state.scrubCount++];
                    memset(&se, 0, sizeof(se));
                    strncpy(se.hm, e["localHm"] | "", sizeof(se.hm) - 1);
                    strncpy(se.type, e["type"] | "", sizeof(se.type) - 1);
                    copyTextU8(se.text, sizeof(se.text), e["raw"] | "");
                }
            }
            unlockState();
            return;
        }
    }
#endif

    lockState();
    // Reset timeline and load history
    g_state.timelineHead = 0;
    g_state.timelineCount = 0;

    for (JsonObject e : entries) {
        TimelineEntry entry;
        memset(&entry, 0, sizeof(entry));

        uint64_t tsMs = e["ts"] | 0ULL;
        entry.ts = (uint32_t)((tsMs / 1000) % 86400);
        strncpy(entry.hm, e["localHm"] | "", sizeof(entry.hm) - 1);
        strncpy(entry.type, e["type"] | "", sizeof(entry.type) - 1);
        copyTextU8(entry.raw, sizeof(entry.raw), e["raw"] | "");
        if (e["detail"].is<const char*>())
            copyTextU8(entry.detail, sizeof(entry.detail), e["detail"].as<const char*>());
        if (e["status"].is<const char*>())
            strncpy(entry.status, e["status"].as<const char*>(), sizeof(entry.status) - 1);
        strncpy(entry.sessionId, e["sessionId"] | "", sizeof(entry.sessionId) - 1);
        strncpy(entry.agentType, e["agentType"] | "", sizeof(entry.agentType) - 1);
        copyTextU8(entry.projectName, sizeof(entry.projectName), e["projectName"] | "");
        strncpy(entry.taskId, e["taskId"] | "", sizeof(entry.taskId) - 1);

        g_state.addTimelineEntry(entry);
    }
    unlockState();
}

static void handleWifiProvision(JsonObject& obj) {
    const char* ssid = obj["ssid"] | "";
    const char* password = obj["password"] | "";
    const char* bridgeIp = obj["bridgeIp"] | "";
    uint16_t bridgePort = obj["bridgePort"] | BRIDGE_DEFAULT_PORT;
    const char* authToken = obj["authToken"] | "";

    if (ssid[0] == '\0' || password[0] == '\0') {
        Serial.println("[Provision] Missing SSID or password");
        Serial.println("{\"type\":\"wifi_provision_ack\",\"success\":false,\"error\":\"missing credentials\"}");
        return;
    }

    Serial.printf("[Provision] Received WiFi credentials: SSID=%s\n", ssid);

    // Store bridge endpoint for direct WebSocket connection after WiFi connects
    lockState();
    strncpy(g_state.bridgeIp, bridgeIp, sizeof(g_state.bridgeIp) - 1);
    g_state.bridgePort = bridgePort;
    strncpy(g_state.authToken, authToken, sizeof(g_state.authToken) - 1);
    unlockState();

    bool ok = false;
#if defined(BOARD_IPS10) || defined(BOARD_T_DISPLAY_PRO)
    if (Net::serialConnected()) {
        // USB serial is the primary transport on these boards. Persist the
        // credentials/endpoint but do not join now: on the IPS10 that avoids
        // waking the hosted C6 radio; on the T-Display-S3-Pro a join while on
        // the desk cable browned out the 3.3 V rail (E BOD loop, 2026-07-27).
        // WiFi comes up from the serial-death path when USB actually goes away.
        Net::wifiSaveProvisionedCredentials(ssid, password);
        Net::wifiSaveProvisionedBridge(bridgeIp, bridgePort, authToken);
        ok = true;
    } else
#endif
    {
        ok = Net::wifiConnectWith(ssid, password);
    }
    if (ok) {
        if (!Net::wifiRadioParked() && !Net::serialConnected()) {
            Net::wifiSaveProvisionedBridge(bridgeIp, bridgePort, authToken);
        }
        if (!Net::wifiRadioParked() && !Net::serialConnected() && bridgeIp[0] != '\0' && bridgePort != 0 && !Net::wsConnected()) {
            Net::wsConnect(bridgeIp, bridgePort, authToken);
        }
    }

    // Build ack response with ArduinoJson for safe serialization
    JsonDocument resp;
    resp["type"] = "wifi_provision_ack";
    resp["success"] = ok;
    if (ok) {
        resp["ip"] = Net::wifiLocalIP();
    } else {
        resp["error"] = "connection failed";
    }
    char buf[256];
    serializeJson(resp, buf, sizeof(buf));
    Net::serialWriteJsonLine(buf);
}

static void sendOtaAck(const char* otaId, const char* stage, uint32_t seq, uint32_t offset, uint32_t written) {
    JsonDocument resp;
    resp["type"] = "esp32_ota_ack";
    resp["otaId"] = otaId;
    resp["stage"] = stage;
    if (seq != UINT32_MAX) resp["seq"] = seq;
    resp["offset"] = offset;
    resp["written"] = written;

    char buf[192];
    serializeJson(resp, buf, sizeof(buf));
    Net::serialWriteJsonLine(buf);
    if (Net::wsConnected()) Net::wsSend(buf);
}

static void sendOtaError(const char* otaId, const char* stage, const char* error) {
    JsonDocument resp;
    resp["type"] = "esp32_ota_error";
    if (otaId && otaId[0]) resp["otaId"] = otaId;
    resp["stage"] = stage;
    resp["error"] = error;

    char buf[192];
    serializeJson(resp, buf, sizeof(buf));
    Net::serialWriteJsonLine(buf);
    if (Net::wsConnected()) Net::wsSend(buf);
}

static void resetOtaRx() {
    otaRx.active = false;
    otaRx.otaId[0] = '\0';
    otaRx.expectedSize = 0;
    otaRx.written = 0;
    otaRx.nextSeq = 0;
}

static void handleOtaBegin(JsonObject& obj) {
    const char* otaId = obj["otaId"] | "";
    const char* md5 = obj["md5"] | "";
    uint32_t size = obj["size"] | 0U;
    if (!otaId[0] || size == 0) {
        sendOtaError(otaId, "begin", "missing_parameters");
        return;
    }

    OtaCapability::Info cap = OtaCapability::get();
    if (!cap.supported) {
        sendOtaError(otaId, "begin", cap.reason);
        return;
    }
    if (cap.slotSize > 0 && size > cap.slotSize) {
        sendOtaError(otaId, "begin", "image_too_large");
        return;
    }
    if (otaRx.active) {
        Update.abort();
        resetOtaRx();
    }

    if (strlen(md5) == 32) {
        Update.setMD5(md5);
    }
    if (!Update.begin(size, U_FLASH)) {
        sendOtaError(otaId, "begin", "update_begin_failed");
        resetOtaRx();
        return;
    }

    otaRx.active = true;
    strncpy(otaRx.otaId, otaId, sizeof(otaRx.otaId) - 1);
    otaRx.otaId[sizeof(otaRx.otaId) - 1] = '\0';
    otaRx.expectedSize = size;
    otaRx.written = 0;
    otaRx.nextSeq = 0;
    sendOtaAck(otaRx.otaId, "begin", UINT32_MAX, 0, 0);
}

static void handleOtaChunk(JsonObject& obj) {
    const char* otaId = obj["otaId"] | "";
    uint32_t seq = obj["seq"] | UINT32_MAX;
    uint32_t offset = obj["offset"] | 0U;
    const char* data = obj["data"] | "";
    if (!otaRx.active || strcmp(otaRx.otaId, otaId) != 0) {
        sendOtaError(otaId, "chunk", "no_active_update");
        return;
    }
    if (seq + 1 == otaRx.nextSeq && offset < otaRx.written) {
        // Host may resend the last chunk after a WiFi reconnect if the ack was
        // lost after flash write completed. Treat that as idempotent.
        sendOtaAck(otaId, "chunk", seq, offset, otaRx.written);
        return;
    }
    if (seq != otaRx.nextSeq || offset != otaRx.written) {
        sendOtaError(otaId, "chunk", "unexpected_offset");
        return;
    }
    if (!data[0]) {
        sendOtaError(otaId, "chunk", "missing_data");
        return;
    }

    size_t decodedLen = 0;
    int rc = mbedtls_base64_decode(
        otaChunkBuf,
        sizeof(otaChunkBuf),
        &decodedLen,
        reinterpret_cast<const unsigned char*>(data),
        strlen(data)
    );
    if (rc != 0 || decodedLen == 0) {
        sendOtaError(otaId, "chunk", "base64_decode_failed");
        return;
    }
    if (otaRx.written + decodedLen > otaRx.expectedSize) {
        sendOtaError(otaId, "chunk", "image_overflow");
        return;
    }

    size_t wrote = Update.write(otaChunkBuf, decodedLen);
    if (wrote != decodedLen) {
        sendOtaError(otaId, "chunk", "update_write_failed");
        return;
    }

    otaRx.written += decodedLen;
    otaRx.nextSeq++;
    sendOtaAck(otaId, "chunk", seq, offset, otaRx.written);
}

static void handleOtaEnd(JsonObject& obj) {
    const char* otaId = obj["otaId"] | "";
    if (!otaRx.active || strcmp(otaRx.otaId, otaId) != 0) {
        sendOtaError(otaId, "end", "no_active_update");
        return;
    }
    if (otaRx.written != otaRx.expectedSize) {
        sendOtaError(otaId, "end", "size_mismatch");
        Update.abort();
        resetOtaRx();
        return;
    }
    if (!Update.end(true)) {
        sendOtaError(otaId, "end", "update_end_failed");
        resetOtaRx();
        return;
    }

    sendOtaAck(otaId, "end", UINT32_MAX, otaRx.written, otaRx.written);
    resetOtaRx();
    delay(250);
    ESP.restart();
}

static void handleOtaAbort(JsonObject& obj) {
    const char* otaId = obj["otaId"] | "";
    if (otaRx.active && (!otaId[0] || strcmp(otaRx.otaId, otaId) == 0)) {
        Update.abort();
        resetOtaRx();
    }
    sendOtaAck(otaId, "abort", UINT32_MAX, 0, 0);
}

static void sendDeviceInfo() {
    JsonDocument resp;
    resp["type"] = "device_info";

    #if defined(BOARD_LED8X32)
    resp["board"] = "ulanzi_tc001";
    #elif defined(BOARD_INKDECK)
    resp["board"] = "inkdeck";
    #elif defined(BOARD_TTGO)
    resp["board"] = "ttgo_t_display";
    #elif defined(BOARD_T_EMBED)
    resp["board"] = "t_embed";
    #elif defined(BOARD_T_DISPLAY_PRO)
    resp["board"] = "t_display_pro";
    #elif defined(BOARD_ESP32_C6_147)
    resp["board"] = "esp32_c6_147";
    #elif IS_ROUND
    resp["board"] = "round_amoled";
    #elif defined(BOARD_BOX_86) || defined(BOARD_86_BOX)
    resp["board"] = "86box";
    #elif defined(BOARD_IPS10)
    resp["board"] = "ips_10";
    #else
    resp["board"] = "ips_35";
    #endif

    resp["version"] = FIRMWARE_VERSION;
    resp["buildHash"] = GIT_SHA;
    resp["buildEpoch"] = (uint32_t)BUILD_EPOCH;
    resp["protocolRevision"] = PROTOCOL_REVISION;
    resp["wifiConfigured"] = Net::wifiConfigured();
    resp["wifiConnected"] = Net::wifiConnected();
    resp["wifiRadioParked"] = Net::wifiRadioParked();
    resp["uptimeSec"] = millis() / 1000;
    {
        esp_reset_reason_t resetReason = esp_reset_reason();
        resp["resetReasonCode"] = (int)resetReason;
        resp["resetReason"] = Util::resetReasonName(resetReason);
    }
    // Debug aid: what this board actually holds — lets a host-side probe
    // (daemon /devices) distinguish "data never parsed" from "render gating"
    // without stealing the serial port.
    resp["timelineCount"] = g_state.timelineCount;
    resp["sessionCount"] = g_state.sessionCount;
    resp["usageFiveH"] = (int)g_state.fiveHourPercent;   // -1 = no usage data held
    {
        uint8_t processing = 0;
        for (uint8_t i = 0; i < g_state.sessionCount; i++)
            if (strcmp(g_state.sessions[i].state, "processing") == 0) processing++;
        resp["processingCount"] = processing;
    }
    if (Net::wifiConnected()) {
        resp["ip"] = Net::wifiLocalIP();
    }
#if defined(BOARD_T_EMBED)
    {
        // Battery telemetry for the dashboard downstream rail (gauge-validated;
        // absent fields mean "no gauge answer", not 0%).
        // Capability advertisement — only what this firmware actually exposes
        // today (grow as ir/subghz land).
        {
            JsonArray caps = resp["capabilities"].to<JsonArray>();
            if (Input::powerStatus().valid) caps.add("battery");
            // Advertise only what actually initialized — a capability the
            // daemon cannot use is worse than an absent one.
            if (Input::nfcReady()) caps.add("nfc");
            if (Audio::micReady()) caps.add("audio");
            if (Audio::playbackReady()) caps.add("audio_out");
            if (Input::irReady()) caps.add("ir_rx");
        }
        Input::PowerStatus ps = Input::powerStatus();
        if (ps.valid) {
            resp["batteryPercent"] = ps.soc;
            resp["batteryCharging"] = ps.charging;
            resp["usbPowered"] = ps.usbPowered;
        } else {
            resp["batteryDiag"] = ps.gaugeErr;  // Wire error code — see power_monitor.h
        }
    }
#endif
#if defined(BOARD_IPS10)
    {
        // Speaker capability, advertised on the WiFi path only — and that is
        // deliberate, not an oversight. This board's host link is a CH340
        // pinned at 115200 (~11.5 KB/s), while a 16 kHz PCM16 reply base64'd
        // into JSON needs ~44 KB/s. Serial physically cannot carry it, so the
        // serial device_info in serial_client.cpp stays quiet and the daemon's
        // `audio_out` gate keeps voice replies on the socket that can.
        JsonArray caps = resp["capabilities"].to<JsonArray>();
        if (Audio::playbackReady()) caps.add("audio_out");
    }
#endif
#if defined(BOARD_T_DISPLAY_PRO)
    {
        // Remote peripheral diag — lets /devices answer "did touch/ALS init?"
        // without stealing the serial port.
        resp["touchReady"] = Input::touchReady();
        resp["touchDownSamples"] = Input::touchDownSamples();
        resp["touchGestures"] = Input::touchGestures();
        resp["touchLastX"] = Input::touchLastX();
        resp["touchLastY"] = Input::touchLastY();
        resp["touchMaxX"] = Input::touchMaxX();
        resp["touchMaxY"] = Input::touchMaxY();
        resp["alsReady"] = Input::lightReady();
        Input::PowerStatus ps = Input::powerStatus();
        // Advertise only what actually initialized (t_embed rule): the caps
        // array exists whenever either the charger or the camera answered.
        if (ps.valid || Camera::present()) {
            JsonArray caps = resp["capabilities"].to<JsonArray>();
            if (ps.valid) caps.add("battery");
            if (Camera::present()) caps.add("camera");
        }
        if (ps.valid) {
            resp["batteryVoltageMv"] = ps.voltageMv;
            resp["batteryCharging"] = ps.charging;
            resp["usbPowered"] = ps.usbPowered;
        } else {
            resp["batteryDiag"] = ps.gaugeErr;
        }
    }
#endif
    OtaCapability::Info ota = OtaCapability::get();
    resp["otaSupported"] = ota.supported;
    resp["otaSlotCount"] = ota.slotCount;
    resp["otaSlotSize"] = ota.slotSize;
    resp["otaFreeSketchSpace"] = ota.freeSketchSpace;
    if (!ota.supported) resp["otaReason"] = ota.reason;

    // 896: t_embed capabilities + battery pushed past 512, and the strip's
    // touch forensics fields pushed past 768 (serializeJson truncates
    // silently on overflow — size for the fattest board, not the average).
    char buf[896];
    serializeJson(resp, buf, sizeof(buf));
    // Both transports: serial for the USB-attached identify flow, WS so a
    // WiFi-only board (InkDeck) is registrable by the daemon without a cable.
    Net::serialWriteJsonLine(buf);
    if (Net::wsConnected()) Net::wsSend(buf);
}

namespace Protocol {

void announceDeviceInfo() { sendDeviceInfo(); }

void parseMessage(const char* json, size_t length) {
    // Reject oversized frames before feeding the elastic JsonDocument — an
    // unbounded sessions_list/timeline_history would otherwise grow the doc
    // until it fragments/exhausts the heap on no-PSRAM boards.
    if (length > PROTOCOL_MAX_MSG_BYTES) {
        Serial.printf("[Protocol] frame too large: %u bytes (max %u) — dropped\n",
                      (unsigned)length, (unsigned)PROTOCOL_MAX_MSG_BYTES);
        return;
    }
    doc.clear();
    DeserializationError err = deserializeJson(doc, json, length);
    if (err) {
        Serial.printf("[Protocol] JSON error: %s\n", err.c_str());
        return;
    }

    JsonObject obj = doc.as<JsonObject>();
    const char* type = obj["type"] | "";

    if (strcmp(type, "state_update") == 0) {
        handleStateUpdate(obj);
    } else if (strcmp(type, "usage_update") == 0) {
        handleUsageUpdate(obj);
    } else if (strcmp(type, "sessions_list") == 0) {
        handleSessionsList(obj);
    } else if (strcmp(type, "timeline_event") == 0) {
        handleTimelineEvent(obj);
#if defined(BOARD_T_EMBED)
    } else if (strcmp(type, "voice_result") == 0) {
        // What the host actually heard. Shown even when empty/failed — a
        // device that displays nothing is indistinguishable from a dead mic.
        const char* text = obj["text"] | "";
        const char* err = obj["error"] | "";
        bool delivered = obj["delivered"] | false;
        char note[96];
        if (err[0]) snprintf(note, sizeof(note), "voice error");
        else if (!text[0]) snprintf(note, sizeof(note), "heard nothing");
        else if (!delivered) snprintf(note, sizeof(note), "NOT sent: \"%s\"", text);
        else snprintf(note, sizeof(note), "\"%s\"", text);
        Utf8::utf8TrimEnd(note);
        Knob::notify(note);
    } else if (strcmp(type, "audio_play_begin") == 0) {
        // Host is about to stream a spoken reply as binary WS frames. Show what
        // is being said so a talking board is legible with the audio muted.
        uint32_t rate = obj["sampleRate"] | 16000;
        Audio::playbackBegin(rate);
        char said[96];
        snprintf(said, sizeof(said), "%s", obj["text"] | "");
        Utf8::sanitizeLvglText(said);
        Utf8::utf8TrimEnd(said);
        Knob::setSpeaking(said);
    } else if (strcmp(type, "audio_play_chunk") == 0) {
        // Serial counterpart of the binary WS frame (same PCM, base64-wrapped).
        const char* b64 = obj["d"] | "";
        size_t b64len = strlen(b64);
        if (b64len > 0 && b64len < 4096) {
            static uint8_t pcm[3072];
            size_t got = 0;
            if (mbedtls_base64_decode(pcm, sizeof(pcm), &got,
                                      (const unsigned char*)b64, b64len) == 0 && got > 0) {
                Audio::playbackFeed(pcm, got);
            }
        }
    } else if (strcmp(type, "audio_play_end") == 0) {
        Audio::playbackEnd();
        Knob::clearSpeaking();
    } else if (strcmp(type, "voice_reply_skipped") == 0) {
        // The turn finished but held nothing worth reading aloud (a diff, a
        // tool-only turn). Say that rather than leaving the user waiting.
        Knob::notify("reply: nothing to read aloud");
#endif
#if defined(BOARD_T_DISPLAY_PRO)
    } else if (strcmp(type, "photo_result") == 0) {
        // Outcome of a CAM snap: delivered to the target session, or why not.
        // Shown even on failure — same visibility rule as voice_result. Both
        // render trees get it; whichever is inactive no-ops.
        bool delivered = obj["delivered"] | false;
        const char* errText = obj["error"] | "";
        const char* reason = obj["deliverReason"] | "";
        Ticker::onPhotoResult(delivered, errText[0] ? errText : reason);
        Pocket::onPhotoResult(delivered, errText[0] ? errText : reason);
#endif
    } else if (strcmp(type, "timeline_history") == 0) {
        handleTimelineHistory(obj);
    } else if (strcmp(type, "wifi_provision") == 0) {
        handleWifiProvision(obj);
    } else if (strcmp(type, "device_info_request") == 0) {
        sendDeviceInfo();
    } else if (strcmp(type, "esp32_ota_begin") == 0) {
        handleOtaBegin(obj);
    } else if (strcmp(type, "esp32_ota_chunk") == 0) {
        handleOtaChunk(obj);
    } else if (strcmp(type, "esp32_ota_end") == 0) {
        handleOtaEnd(obj);
    } else if (strcmp(type, "esp32_ota_abort") == 0) {
        handleOtaAbort(obj);
    } else if (strcmp(type, "display_state") == 0) {
        bool displayOn = obj["displayOn"] | true;
        // Optional `dim` instruction. Absent (un-upgraded host) ⇒ the `| default`
        // values keep legacy full-off: enabled=true, mode=off. We read displayOn
        // first so even firmware that ignored `dim` would still dim to 0.
        bool dimEnabled = obj["dim"]["enabled"] | true;
        const char* dimMode = obj["dim"]["mode"] | "off";
        int dimLevelPct = obj["dim"]["level"] | 0;
        uint8_t dimMode8 = (strcmp(dimMode, "min") == 0) ? 1 : 0;
        // Scale percent (1-100) → 0-255 backlight domain, rounded, floored at 1
        // so "minimum brightness" never collapses to full-off.
        int scaled = (dimLevelPct * 255 + 50) / 100;
        if (scaled < 1) scaled = 1;
        if (scaled > 255) scaled = 255;
        lockState();
        g_state.hostDisplayOn = displayOn;
        g_state.hostDimEnabled = dimEnabled;
        g_state.hostDimMode = dimMode8;
        g_state.hostDimLevel = (uint8_t)scaled;
        unlockState();
        Serial.printf("[Host] display %s (dim=%d mode=%d level=%d)\n",
                      displayOn ? "on" : "off", dimEnabled, dimMode8, scaled);
    } else if (strcmp(type, "set_orientation") == 0) {
        bool landscape = obj["landscape"] | true;
        lockState();
        g_state.pendingLandscape = landscape;
        g_state.orientationChanged = true;
        unlockState();
    } else if (strcmp(type, "connection") == 0) {
        // Connection status is handled by WS event callbacks
    } else if (strcmp(type, "touch_diag") == 0) {
#if defined(BOARD_IPS35)
        Serial.println("[TouchDiag] === I2C scan ===");
        for (uint8_t addr = 1; addr < 127; addr++) {
            Wire.beginTransmission(addr);
            if (Wire.endTransmission() == 0) {
                Serial.printf("[TouchDiag] Found device at 0x%02X\n", addr);
            }
        }
        // AXS15231B command protocol touch read
        static const uint8_t cmd[] = {
            0xB5, 0xAB, 0xA5, 0x5A, 0x00, 0x00, 0x00, 0x08,
            0x00, 0x00, 0x00
        };
        for (int attempt = 0; attempt < 5; attempt++) {
            Wire.beginTransmission(BOARD_TOUCH_ADDR);
            Wire.write(cmd, sizeof(cmd));
            uint8_t err = Wire.endTransmission();
            int n = Wire.requestFrom((uint8_t)BOARD_TOUCH_ADDR, (uint8_t)8);
            Serial.printf("[TouchDiag] Attempt %d: CMD err=%d, read %d bytes: ", attempt, err, n);
            for (int i = 0; i < n; i++) {
                Serial.printf("%02X ", Wire.read());
            }
            Serial.println();
            delay(100);
        }
        // Also try old register-style read for comparison
        Wire.beginTransmission(BOARD_TOUCH_ADDR);
        Wire.write((uint8_t)0x01);
        uint8_t err2 = Wire.endTransmission(false);
        int n2 = Wire.requestFrom((uint8_t)BOARD_TOUCH_ADDR, (uint8_t)6);
        Serial.printf("[TouchDiag] Old-style reg 0x01: err=%d, read %d bytes: ", err2, n2);
        for (int i = 0; i < n2; i++) {
            Serial.printf("%02X ", Wire.read());
        }
        Serial.println();
        Serial.printf("[TouchDiag] INT pin (GPIO %d) = %d\n", BOARD_PIN_TOUCH_INT, digitalRead(BOARD_PIN_TOUCH_INT));
#elif defined(BOARD_AMOLED)
        Serial.println("[TouchDiag] Round AMOLED — CST816S scan");
        for (uint8_t addr = 1; addr < 127; addr++) {
            Wire.beginTransmission(addr);
            if (Wire.endTransmission() == 0) {
                Serial.printf("[TouchDiag] Found device at 0x%02X\n", addr);
            }
        }
#else
        Serial.println("[TouchDiag] Not supported on this board");
#endif
    } else if (strcmp(type, "i2c_diag") == 0) {
        // Audio-codec hardware probe. Deliberately firmware-local: the daemon
        // never originates it (daemon-server.ts's esp32WifiEvents allowlist
        // would drop it anyway), so it costs no protocol surface — no
        // shared/src/protocol.ts entry, no generate-protocol, no Swift/Kotlin
        // mirrors, no XTeink fork re-port. Trigger it by writing the JSON line
        // straight into the board's serial port, the way flash.sh does.
        //   {"type":"i2c_diag"}                      sweep the touch bus
        //   {"type":"i2c_diag","sda":N,"scl":N}      probe a candidate 2nd bus
        //   {"type":"i2c_diag","dump":24}            register dump of a device
#if defined(BOARD_IPS10)
        if (obj["dump"].is<int>()) {
            UI::hwI2cDumpDevice((uint8_t)(obj["dump"].as<int>()));
        } else {
            int sda = obj["sda"].is<int>() ? obj["sda"].as<int>() : -1;
            int scl = obj["scl"].is<int>() ? obj["scl"].as<int>() : -1;
            UI::hwI2cProbe(sda, scl);
        }
#else
        Serial.println("[I2CDiag] Not supported on this board");
#endif
#if defined(BOARD_HAS_SPEAKER) && !defined(BOARD_T_EMBED)
    } else if (strcmp(type, "audio_play_begin") == 0) {
        // Spoken reply from the host. The T-Embed arm above additionally drives
        // its knob UI ("speaking" state); this board has no such surface yet, so
        // it is playback only.
        Audio::playbackBegin(obj["sampleRate"] | 16000);
    } else if (strcmp(type, "audio_play_chunk") == 0) {
        // Serial-transport counterpart of the binary WS frame. Present for
        // symmetry, but see the device_info note: this board's 115200 link
        // cannot sustain a reply, so in practice the PCM arrives over WS.
        const char* b64 = obj["d"] | "";
        size_t b64len = strlen(b64);
        if (b64len > 0 && b64len < 4096) {
            static uint8_t pcm[3072];
            size_t got = 0;
            if (mbedtls_base64_decode(pcm, sizeof(pcm), &got,
                                      (const unsigned char*)b64, b64len) == 0 && got > 0) {
                Audio::playbackFeed(pcm, got);
            }
        }
    } else if (strcmp(type, "audio_play_end") == 0) {
        Audio::playbackEnd();
#endif
#if defined(BOARD_PIN_MIC_DIN)
    } else if (strcmp(type, "mic_test") == 0) {
        // Capture probe, same firmware-local rationale as i2c_diag. The mic pin
        // is the one part of this board's audio map that has never been proven:
        // the BSP names GPIO 11, but only the TX direction was confirmed by ear.
        // Reports level rather than audio, because level is what distinguishes
        // "wrong pin" (flat) from "right pin, quiet" (floor moves with speech).
        {
            int gain = obj["gain"].is<int>() ? obj["gain"].as<int>() : -1;
            int ms   = obj["ms"].is<int>() ? obj["ms"].as<int>() : 1500;
            if (ms < 200) ms = 200;
            if (ms > 5000) ms = 5000;
            if (gain >= 0) Es8311::setMicGain(gain);

            // The codec ADC only runs once begin() has programmed it, and
            // begin() needs the I2S clock already up.
            if (!Audio::captureReady()) Audio::playbackInit();
            if (!Es8311::ready()) Es8311::begin(16000);

            Serial.printf("[MicTest] %d ms at gain step %d (%d dB) — make some noise\n",
                          ms, Es8311::micGain(), Es8311::micGain() * 6);
            static int16_t mic[512];
            const int frames = (16000 * ms / 1000) / 512;
            int32_t peak = 0; int64_t sumSq = 0; int32_t samples = 0; int zeroFrames = 0;
            for (int f = 0; f < frames; f++) {
                size_t got = Audio::captureRead((uint8_t*)mic, sizeof(mic));
                if (got == 0) { zeroFrames++; continue; }
                const int n = (int)(got / 2);
                for (int i = 0; i < n; i++) {
                    int32_t v = mic[i];
                    if (v < 0) v = -v;
                    if (v > peak) peak = v;
                    sumSq += (int64_t)mic[i] * mic[i];
                }
                samples += n;
            }
            if (samples == 0) {
                Serial.printf("[MicTest] no samples (%d empty reads) — RX channel not delivering\n",
                              zeroFrames);
            } else {
                const double rms = sqrt((double)sumSq / (double)samples);
                Serial.printf("[MicTest] %ld samples, peak %ld (%.1f%% FS), rms %.0f (%.2f%% FS)%s\n",
                              (long)samples, (long)peak, peak * 100.0 / 32768.0,
                              rms, rms * 100.0 / 32768.0,
                              peak < 16 ? "  <- flat: wrong pin, or ADC muted" : "");
            }
        }
#endif
    } else if (strcmp(type, "audio_test") == 0) {
        // Firmware-local, same rationale as i2c_diag above. Plays a 1 s 440 Hz
        // tone so the ES8311 pin-map hypothesis can be judged by ear — that is
        // the only instrument available for it. Silence is a real result: it
        // says the codec initialised over I2C (its own log line proves that)
        // but the I2S pins or PA-enable are wrong.
#if defined(BOARD_SPK_CODEC_ES8311)
        // Params so level and content can be tuned by ear without a reflash:
        //   vol   codec DAC volume 0-100          (default deliberately low)
        //   hz    fixed tone, or 0 for a sweep
        //   ms    duration
        // The default is a 200 Hz -> 3 kHz sweep rather than a fixed tone: a
        // buzzer can only sit at one frequency, so a smooth glide is the
        // cheapest proof that this is a real DAC driving a real speaker.
        {
            // ladder: play the same sweep at rising levels so a comfortable
            // volume can be picked by ear in one pass instead of one reflash
            // per guess.
            const bool ladder = obj["ladder"] | false;
            int vol = obj["vol"].is<int>() ? obj["vol"].as<int>() : 70;
            int hz  = obj["hz"].is<int>()  ? obj["hz"].as<int>()  : 0;
            int ms  = obj["ms"].is<int>()  ? obj["ms"].as<int>()  : 2000;
            if (ms < 100) ms = 100;
            if (ms > 10000) ms = 10000;
            if (ladder) {
                static const int kLevels[] = { 60, 70, 80, 90 };
                for (int li = 0; li < 4; li++) {
                    Serial.printf("[AudioTest] ladder step %d/4 — volume %d%% (%.0f dB)\n",
                                  li + 1, kLevels[li], -60.0f + kLevels[li] * 0.6f);
                    // Set first: playbackBegin() spawns the task that inits
                    // the codec, and that init applies the stored level.
                    Es8311::setVolume(kLevels[li]);
                    Audio::playbackBegin(16000);
                    static int16_t lb[512];
                    float ph = 0.0f;
                    const int tot = 16000 * 1200 / 1000;
                    for (int d = 0; d < tot; d += 512) {
                        for (int i = 0; i < 512; i++) {
                            float pr = (float)(d + i) / (float)tot;
                            ph += 2.0f * PI * (200.0f + pr * 2800.0f) / 16000.0f;
                            if (ph > 2.0f * PI) ph -= 2.0f * PI;
                            float env = pr > 0.9f ? (1.0f - (pr - 0.9f) / 0.1f) : 1.0f;
                            lb[i] = (int16_t)(6000.0f * env * sinf(ph));
                        }
                        Audio::playbackFeed((const uint8_t*)lb, sizeof(lb));
                        delay(20);
                    }
                    Audio::playbackEnd();
                    delay(900);
                }
                Serial.println("[AudioTest] ladder done");
                return;
            }

            Serial.printf("[AudioTest] %s, %d ms, volume %d%% — listen\n",
                          hz > 0 ? "fixed tone" : "200 Hz -> 3 kHz sweep", ms, vol);
            if (!Audio::playbackInit()) {
                Serial.println("[AudioTest] playbackInit failed");
            } else {
                Es8311::setVolume(vol);
                Audio::playbackBegin(16000);

                constexpr int kRate = 16000;
                const int total = (kRate * ms) / 1000;
                static int16_t buf[512];
                // Fixed amplitude well below full scale — headroom for the amp,
                // and the codec register is the real volume control.
                constexpr float kAmp = 2200.0f;
                float phase = 0.0f;
                for (int done = 0; done < total; done += 512) {
                    for (int i = 0; i < 512; i++) {
                        float progress = (float)(done + i) / (float)total;
                        float f = (hz > 0) ? (float)hz : (200.0f + progress * 2800.0f);
                        // Phase accumulator, not sin(2*pi*f*t): sweeping the
                        // frequency inside the latter tears the waveform at
                        // every buffer edge and you hear clicks, not a glide.
                        phase += 2.0f * PI * f / (float)kRate;
                        if (phase > 2.0f * PI) phase -= 2.0f * PI;
                        // Fade the last 10% so it ends without a thump.
                        float env = progress > 0.9f ? (1.0f - (progress - 0.9f) / 0.1f) : 1.0f;
                        buf[i] = (int16_t)(kAmp * env * sinf(phase));
                    }
                    Audio::playbackFeed((const uint8_t*)buf, sizeof(buf));
                    delay(20);
                }
                Audio::playbackEnd();
            }
        }
#else
        Serial.println("[AudioTest] Not supported on this board");
#endif
    }
    // Ignore: encoder_state, button_state, deck_slot_map, voice_state
    // (not needed for display-only client)
}

}  // namespace Protocol
