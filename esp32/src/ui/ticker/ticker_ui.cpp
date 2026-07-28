#if defined(BOARD_T_DISPLAY_PRO)

#include "ticker_ui.h"
#include "../../state/agent_state.h"
#include "../../net/wifi_manager.h"
#include "../../net/ws_client.h"
#include "../../input/power_monitor.h"
#include "../../camera/photo_capture.h"
#include "../display.h"
#include "../theme.h"
#include "../agent_label.h"
#include "../../util/utf8.h"

#include <Arduino.h>
#include <lvgl.h>
#include <esp_heap_caps.h>
#include <stdio.h>
#include <string.h>

// Pages: 0 FOCUS, 1 USAGE, 2 SESSIONS, and — only when the rear camera shield
// probed at boot — 3 CAM (show-and-tell capture; the no-camera unit runs this
// same binary and never grows the page).
static constexpr uint8_t PAGE_CAM = 3;
static uint8_t pageCount() { return Camera::present() ? 4 : 3; }
// In landscape the two short physical button pairs sit against the long
// top/bottom edges near the right end. From left to right the upper pair is
// previous/next (GPIO12/16); the lower pair is power-reset/Focus (RST/GPIO0).
static constexpr int KEY_RAIL_H = 16;
static constexpr int KEY_HINT_W = 44;
static constexpr int KEY_HINT_GAP = 3;
static constexpr int KEY_HINT_RIGHT_INSET = 54;
static constexpr int KEY_HINT_X =
    SCREEN_W - KEY_HINT_RIGHT_INSET - (KEY_HINT_W * 2 + KEY_HINT_GAP);
static constexpr int HEADER_Y = KEY_RAIL_H;
static constexpr int HEADER_H = 30;
static constexpr int BODY_Y = HEADER_Y + HEADER_H;
static constexpr int BODY_H = 222 - BODY_Y - KEY_RAIL_H;

static uint8_t s_page = 0;

static lv_obj_t* s_scr = nullptr;
static lv_obj_t* s_tabs[4] = {nullptr, nullptr, nullptr, nullptr};
static lv_obj_t* s_hdrWifi = nullptr;
static lv_obj_t* s_hdrBattery = nullptr;
static lv_obj_t* s_body = nullptr;
static lv_obj_t* s_hintPrimary = nullptr;
static lv_obj_t* s_hintPrev = nullptr;
static lv_obj_t* s_hintNext = nullptr;
static lv_obj_t* s_hintReset = nullptr;
static char s_sessionRowIds[3][32] = {};
static uint8_t s_sessionRowCount = 0;
static uint32_t s_buttonActiveUntil[3] = {0, 0, 0};

static char s_lastSig[320] = {0};

// Transient touch feedback shown on the Focus page hint line.
static char s_flashText[32] = {0};
static uint32_t s_flashUntilMs = 0;

// CAM page viewfinder: 2:1 downscale of the HVGA sensor frame, so the whole
// capture is visible. Buffer lives in PSRAM (76.8 KB — never DRAM, see the
// audio-ring board-guard note in ws_client.cpp).
static constexpr int CAM_VIEW_W = 240;
static constexpr int CAM_VIEW_H = 160;
static constexpr uint32_t CAM_PREVIEW_INTERVAL_MS = 100;
static lv_obj_t* s_camCanvas = nullptr;
static uint16_t* s_camBuf = nullptr;
static uint32_t s_camLastFrameMs = 0;

// ── outbound steering (thread-safe queue; drained on the network core) ──────

static void sendSelectOption(const char* sid, int index) {
    char buf[96];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"select_option\",\"index\":%d,\"sessionId\":\"%s\"}",
             index, sid);
    Net::queueOutbound(buf);
}

static void sendPermissionDecision(const char* requestId, bool allow) {
    char buf[160];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"permission_decision\",\"requestId\":\"%s\",\"decision\":\"%s\"}",
             requestId, allow ? "allow" : "deny");
    Net::queueOutbound(buf);
}

static void sendSessionEscape(const char* sid) {
    char buf[160];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"session_command\",\"sessionId\":\"%s\",\"command\":{\"type\":\"escape\"}}",
             sid);
    Net::queueOutbound(buf);
}

static void sendFocusSession(const char* sid) {
    char buf[80];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"focus_session\",\"sessionId\":\"%s\"}", sid);
    Net::queueOutbound(buf);
}

static void flash(const char* text) {
    strncpy(s_flashText, text, sizeof(s_flashText) - 1);
    s_flashText[sizeof(s_flashText) - 1] = '\0';
    s_flashUntilMs = millis() + 1200;
}

static bool sameSessionId(const char* a, const char* b) {
    if (!a || !b || !a[0] || !b[0]) return false;
    if (strcmp(a, b) == 0) return true;
    // ESP32 roster ids are intentionally capped at 31 bytes. A state_update can
    // arrive over WiFi with the daemon's full id, so accept the shared prefix.
    size_t alen = strlen(a);
    size_t blen = strlen(b);
    size_t n = alen < blen ? alen : blen;
    return n >= 31 && strncmp(a, b, n) == 0;
}

// Awaiting owns the strip. Otherwise follow the session explicitly focused by
// the Companion Knob/another surface, then fall back to live work and the first.
static int pickFocusSession() {
    int firstAwaiting = -1;
    int explicitFocus = -1;
    int firstProcessing = -1;
    for (uint8_t i = 0; i < g_state.sessionCount; i++) {
        if (strstr(g_state.sessions[i].state, "awaiting") != nullptr) {
            if (sameSessionId(g_state.sessions[i].id, g_state.focusedSessionId)) return i;
            if (firstAwaiting < 0) firstAwaiting = i;
        }
        if (explicitFocus < 0 &&
            sameSessionId(g_state.sessions[i].id, g_state.focusedSessionId))
            explicitFocus = i;
        if (firstProcessing < 0 && strcmp(g_state.sessions[i].state, "processing") == 0)
            firstProcessing = i;
    }
    if (firstAwaiting >= 0) return firstAwaiting;
    if (explicitFocus >= 0) return explicitFocus;
    if (firstProcessing >= 0) return firstProcessing;
    return g_state.sessionCount > 0 ? 0 : -1;
}

// Snapshot of the captioned session (copied under lock in update()).
struct FocusSnap {
    bool have;
    bool awaiting;
    char id[32];
    char agentType[16];
    char projectName[40];
    char state[20];
    char requestId[40];
    char caption[160];
};


static lv_obj_t* makeLabel(lv_obj_t* parent, const lv_font_t* font,
                           uint32_t color, const char* text) {
    lv_obj_t* l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_label_set_text(l, text);
    return l;
}

static uint32_t gaugeColor(float pct) {
    if (pct >= 85.0f) return Theme::StatusRed;
    if (pct >= 60.0f) return Theme::StatusAmber;
    return Theme::StatusGreen;
}

static lv_obj_t* makeKeyHint(lv_obj_t* rail, const char* text, int x,
                             uint32_t color) {
    // One persistent 44x14 capsule per physical switch. The narrow geometry is
    // intentional: the enclosure rocker is much shorter than the first
    // full-edge label study.
    lv_obj_t* chip = lv_obj_create(rail);
    lv_obj_remove_style_all(chip);
    lv_obj_set_size(chip, KEY_HINT_W, KEY_RAIL_H - 2);
    lv_obj_set_pos(chip, x, 1);
    lv_obj_set_style_bg_color(chip, lv_color_hex(Theme::MidWater), 0);
    lv_obj_set_style_bg_opa(chip, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(chip, 3, 0);

    lv_obj_t* hint = makeLabel(chip, &lv_font_montserrat_12, color, text);
    lv_obj_set_style_text_letter_space(hint, 1, 0);
    lv_obj_align(hint, LV_ALIGN_CENTER, 0, 0);
    return hint;
}

static void updateKeyHints(uint32_t now) {
    // Text is flash-backed and the label widgets live for the screen lifetime:
    // changing page/button feedback does not allocate inside the render loop.
    // Short names for the rocker capsules; computed from the cyclic page order
    // so the CAM page slots in only when the camera is present.
    static const char* const shortNames[4] = {"FOCUS", "USAGE", "SESS", "CAM"};
    static uint8_t lastPage = 0xFF;
    if (lastPage != s_page) {
        lastPage = s_page;
        uint8_t n = pageCount();
        lv_label_set_text_static(s_hintPrev, shortNames[(s_page + n - 1) % n]);
        lv_label_set_text_static(s_hintNext, shortNames[(s_page + 1) % n]);
        // The lower-right capsule doubles as the shutter on the CAM page.
        lv_label_set_text_static(s_hintPrimary, s_page == PAGE_CAM ? "SNAP" : "FOCUS");
    }

    static bool lastActive[3] = {false, false, false};
    lv_obj_t* hints[3] = {s_hintPrimary, s_hintPrev, s_hintNext};
    for (uint8_t i = 0; i < 3; i++) {
        bool active = (int32_t)(s_buttonActiveUntil[i] - now) > 0;
        if (active == lastActive[i]) continue;
        lastActive[i] = active;
        lv_obj_set_style_text_color(
            hints[i], lv_color_hex(active ? Theme::StatusCyan : Theme::HUDDim), 0);
    }
}

// One full-fill gauge row: label | bar (fill = pct) | % numeral | reset.
static void renderGaugeRow(lv_obj_t* parent, int y, const char* label,
                           float pct, const char* reset) {
    lv_obj_t* name = makeLabel(parent, &lv_font_montserrat_16, Theme::HUDText, label);
    lv_obj_align(name, LV_ALIGN_TOP_LEFT, 10, y + 8);

    lv_obj_t* track = lv_obj_create(parent);
    lv_obj_remove_style_all(track);
    lv_obj_set_size(track, 250, 34);
    lv_obj_set_style_bg_color(track, lv_color_hex(Theme::MidWater), 0);
    lv_obj_set_style_bg_opa(track, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(track, 4, 0);
    lv_obj_align(track, LV_ALIGN_TOP_LEFT, 118, y);

    bool haveData = pct >= 0.0f;
    if (haveData) {
        float clamped = pct > 100.0f ? 100.0f : pct;
        int w = (int)(250.0f * clamped / 100.0f);
        if (w > 0) {
            lv_obj_t* fill = lv_obj_create(track);
            lv_obj_remove_style_all(fill);
            lv_obj_set_size(fill, w < 4 ? 4 : w, 34);
            lv_obj_set_style_bg_color(fill, lv_color_hex(gaugeColor(clamped)), 0);
            lv_obj_set_style_bg_opa(fill, LV_OPA_COVER, 0);
            lv_obj_set_style_radius(fill, 4, 0);
            lv_obj_align(fill, LV_ALIGN_LEFT_MID, 0, 0);
        }
        // White numeral ON the bar (gauge grammar: full fill, sharp stage
        // colors, white numerals).
        char pctText[8];
        snprintf(pctText, sizeof(pctText), "%d%%", (int)clamped);
        lv_obj_t* p = makeLabel(track, &lv_font_montserrat_18, 0xFFFFFF, pctText);
        lv_obj_align(p, LV_ALIGN_LEFT_MID, 8, 0);
    } else {
        lv_obj_t* p = makeLabel(track, &lv_font_montserrat_18, Theme::HUDFaint, "--");
        lv_obj_align(p, LV_ALIGN_LEFT_MID, 8, 0);
    }

    lv_obj_t* r = makeLabel(parent, &lv_font_montserrat_14, Theme::HUDDim,
                            (haveData && reset[0]) ? reset : "");
    lv_obj_align(r, LV_ALIGN_TOP_LEFT, 378, y + 9);
}

static void renderUsagePage() {
    // Only windows that exist render — a retired window (e.g. Codex 5h on
    // current plans) disappears instead of showing a fabricated "--" row.
    struct GaugeData { const char* label; float pct; char reset[20]; };
    GaugeData rows[4];
    uint8_t n = 0;
    char subsLine[96] = {0};

    lockState();
    auto take = [&](const char* label, float pct, const char* reset) {
        if (pct < 0.0f) return;
        rows[n].label = label;
        rows[n].pct = pct;
        strncpy(rows[n].reset, reset, sizeof(rows[n].reset) - 1);
        rows[n].reset[sizeof(rows[n].reset) - 1] = '\0';
        n++;
    };
    take("Claude 5h", g_state.fiveHourPercent, g_state.fiveHourReset);
    take("Claude 7d", g_state.sevenDayPercent, g_state.sevenDayReset);
    take("Codex 5h", g_state.codexPrimaryPercent, g_state.codexPrimaryReset);
    take("Codex 7d", g_state.codexSecondaryPercent, g_state.codexSecondaryReset);
    // Account subscriptions (usage_update subscriptions[]) — the "what am I
    // paying for" line other dashboards carry.
    {
        size_t off = 0;
        for (uint8_t i = 0; i < g_state.subscriptionCount && off < sizeof(subsLine) - 24; i++) {
            off += snprintf(subsLine + off, sizeof(subsLine) - off, "%s%s %s",
                            i > 0 ? "  " LV_SYMBOL_BULLET "  " : "",
                            g_state.subscriptions[i].name,
                            g_state.subscriptions[i].until);
        }
    }
    unlockState();

    bool haveSubs = subsLine[0] != '\0';
    if (n == 0 && !haveSubs) {
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_14, Theme::HUDDim,
                                "Waiting for usage data...");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }

    int areaH = haveSubs ? BODY_H - 24 : BODY_H;
    int pitch = n > 0 ? areaH / (n > 0 ? n : 1) : 0;
    if (pitch > 48) pitch = 48;
    for (uint8_t i = 0; i < n; i++) {
        renderGaugeRow(s_body, 2 + i * pitch, rows[i].label, rows[i].pct, rows[i].reset);
    }

    if (haveSubs) {
        Utf8::sanitizeLvglText(subsLine);
        lv_obj_t* s = makeLabel(s_body, &lv_font_montserrat_14, Theme::HUDDim, subsLine);
        lv_label_set_long_mode(s, LV_LABEL_LONG_DOT);
        lv_obj_set_width(s, 460);
        lv_obj_align(s, LV_ALIGN_BOTTOM_LEFT, 10, -3);
    }
}

static uint32_t agentColor(const char* agentType) {
    if (strcmp(agentType, "claude-code") == 0) return Theme::ClaudeBody;
    if (strncmp(agentType, "codex", 5) == 0) return Theme::CloudBody;
    if (strcmp(agentType, "openclaw") == 0) return Theme::CrayfishShell;
    if (strcmp(agentType, "opencode") == 0) return Theme::OpenCodeOuter;
    return Theme::HUDDim;
}

static uint32_t stateColorOf(const char* state) {
    if (strstr(state, "awaiting") != nullptr) return Theme::StatusAmber;
    if (strcmp(state, "processing") == 0) return Theme::StatusBlue;
    if (strcmp(state, "idle") == 0) return Theme::StatusGreen;
    return Theme::HUDDim;
}

static void renderFocusPage(const FocusSnap& f, bool connected) {
    if (!connected) {
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_16, Theme::HUDDim,
                                "Searching for AgentDeck...");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }
    if (!f.have) {
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_16, Theme::HUDDim,
                                "No active sessions");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }

    if (f.awaiting) {
        // Full-height amber attention bar — the strip's "needs you" tint.
        lv_obj_t* bar = lv_obj_create(s_body);
        lv_obj_remove_style_all(bar);
        lv_obj_set_size(bar, 7, BODY_H);
        lv_obj_set_style_bg_color(bar, lv_color_hex(Theme::StatusAmber), 0);
        lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
        lv_obj_align(bar, LV_ALIGN_TOP_LEFT, 0, 0);
    }

    lv_obj_t* dot = lv_obj_create(s_body);
    lv_obj_remove_style_all(dot);
    lv_obj_set_size(dot, 14, 14);
    lv_obj_set_style_bg_color(dot, lv_color_hex(stateColorOf(f.state)), 0);
    lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(dot, 7, 0);
    lv_obj_align(dot, LV_ALIGN_TOP_LEFT, 15, 14);

    lv_obj_t* brand = makeLabel(s_body, &lv_font_montserrat_16,
                                agentColor(f.agentType), agentShortLabel(f.agentType));
    lv_obj_align(brand, LV_ALIGN_TOP_LEFT, 37, 11);

    lv_obj_t* proj = makeLabel(s_body, &font_kr_16, Theme::HUDText,
                               f.projectName[0] ? f.projectName : "(no project)");
    lv_obj_set_width(proj, 235);
    lv_label_set_long_mode(proj, LV_LABEL_LONG_DOT);
    lv_obj_align(proj, LV_ALIGN_TOP_LEFT, 132, 11);

    const char* status = f.awaiting ? "NEEDS INPUT"
                       : strcmp(f.state, "processing") == 0 ? "WORKING"
                       : strcmp(f.state, "idle") == 0 ? "READY" : f.state;
    lv_obj_t* st = makeLabel(s_body, &lv_font_montserrat_14,
                             stateColorOf(f.state), status);
    lv_obj_align(st, LV_ALIGN_TOP_RIGHT, -10, 12);

    // A single high-contrast thought, with generous leading. Limiting its box
    // keeps the interaction hint stable instead of letting logs fill the strip.
    lv_obj_t* cap = makeLabel(s_body, &font_kr_16, Theme::HUDText, f.caption);
    lv_obj_set_width(cap, 452);
    lv_label_set_long_mode(cap, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_line_space(cap, 6, 0);
    lv_obj_set_height(cap, f.awaiting ? 62 : 92);
    lv_obj_align(cap, LV_ALIGN_TOP_LEFT, 16, 51);

    bool flashOn = s_flashText[0] != '\0';
    if (f.awaiting && !flashOn) {
        auto actionChip = [&](int x, int w, const char* label, uint32_t color) {
            lv_obj_t* chip = lv_obj_create(s_body);
            lv_obj_remove_style_all(chip);
            lv_obj_set_size(chip, w, 34);
            lv_obj_set_pos(chip, x, BODY_H - 38);
            lv_obj_set_style_bg_color(chip, lv_color_hex(color), 0);
            lv_obj_set_style_bg_opa(chip, LV_OPA_COVER, 0);
            lv_obj_set_style_radius(chip, 5, 0);
            lv_obj_t* text = makeLabel(chip, &lv_font_montserrat_16, 0xFFFFFF, label);
            lv_obj_align(text, LV_ALIGN_CENTER, 0, 0);
        };
        actionChip(272, 92, "DENY", Theme::StatusRed);
        actionChip(372, 96, "APPROVE", Theme::StatusGreen);
        lv_obj_t* hint = makeLabel(s_body, &lv_font_montserrat_12,
                                   Theme::HUDFaint, "tap a labelled action");
        lv_obj_align(hint, LV_ALIGN_BOTTOM_LEFT, 16, -11);
    } else if (flashOn) {
        lv_obj_t* h = makeLabel(s_body, &lv_font_montserrat_14,
                                Theme::StatusGreen, s_flashText);
        lv_obj_align(h, LV_ALIGN_BOTTOM_LEFT, 16, -10);
    }
}

static void renderSessionsPage() {
    struct Row {
        char agentType[16];
        char projectName[40];
        char state[20];
        char line[100];
        bool focused;
    } rows[3];
    uint8_t n = 0;
    s_sessionRowCount = 0;
    memset(s_sessionRowIds, 0, sizeof(s_sessionRowIds));
    lockState();
    uint8_t order[10];
    uint8_t orderCount = 0;
    auto addIndex = [&](uint8_t idx) {
        for (uint8_t j = 0; j < orderCount; j++) if (order[j] == idx) return;
        if (orderCount < 10) order[orderCount++] = idx;
    };
    // Preserve the same glance priority as Focus: waits, explicit focus, work,
    // then the remaining roster. Three readable rows beat five tiny ones.
    for (uint8_t i = 0; i < g_state.sessionCount; i++)
        if (strstr(g_state.sessions[i].state, "awaiting") != nullptr) addIndex(i);
    for (uint8_t i = 0; i < g_state.sessionCount; i++)
        if (sameSessionId(g_state.sessions[i].id, g_state.focusedSessionId)) addIndex(i);
    for (uint8_t i = 0; i < g_state.sessionCount; i++)
        if (strcmp(g_state.sessions[i].state, "processing") == 0) addIndex(i);
    for (uint8_t i = 0; i < g_state.sessionCount; i++) addIndex(i);

    for (uint8_t oi = 0; oi < orderCount && n < 3; oi++) {
        const SessionInfo& s = g_state.sessions[order[oi]];
        strncpy(rows[n].agentType, s.agentType, sizeof(rows[n].agentType));
        strncpy(rows[n].projectName, s.projectName, sizeof(rows[n].projectName));
        strncpy(rows[n].state, s.state, sizeof(rows[n].state));
        // Glance rule: milestone line, live tool belongs to state surfaces.
        strncpy(rows[n].line, s.lastEventText[0] ? s.lastEventText : s.activity,
                sizeof(rows[n].line));
        rows[n].focused = sameSessionId(s.id, g_state.focusedSessionId);
        strncpy(s_sessionRowIds[n], s.id, sizeof(s_sessionRowIds[n]) - 1);
        n++;
    }
    s_sessionRowCount = n;
    unlockState();

    if (n == 0) {
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_14, Theme::HUDDim,
                                "No active sessions");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }

    for (uint8_t i = 0; i < n; i++) {
        Utf8::sanitizeLvglText(rows[i].projectName);
        Utf8::sanitizeLvglText(rows[i].line);
        const int pitch = BODY_H / 3;
        int y = 1 + i * pitch;

        if (rows[i].focused || strstr(rows[i].state, "awaiting") != nullptr) {
            lv_obj_t* rail = lv_obj_create(s_body);
            lv_obj_remove_style_all(rail);
            lv_obj_set_size(rail, 4, pitch - 5);
            lv_obj_set_style_bg_color(
                rail, lv_color_hex(strstr(rows[i].state, "awaiting") != nullptr
                                       ? Theme::StatusAmber : Theme::StatusCyan), 0);
            lv_obj_set_style_bg_opa(rail, LV_OPA_COVER, 0);
            lv_obj_align(rail, LV_ALIGN_TOP_LEFT, 2, y + 2);
        }

        lv_obj_t* dot = lv_obj_create(s_body);
        lv_obj_remove_style_all(dot);
        lv_obj_set_size(dot, 10, 10);
        lv_obj_set_style_bg_color(dot, lv_color_hex(stateColorOf(rows[i].state)), 0);
        lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(dot, 5, 0);
        lv_obj_align(dot, LV_ALIGN_TOP_LEFT, 12, y + 8);

        lv_obj_t* brand = makeLabel(s_body, &lv_font_montserrat_14,
                                    agentColor(rows[i].agentType),
                                    agentShortLabel(rows[i].agentType));
        lv_obj_align(brand, LV_ALIGN_TOP_LEFT, 30, y);

        lv_obj_t* proj = makeLabel(s_body, &font_kr_16, Theme::HUDText,
                                   rows[i].projectName);
        lv_obj_set_width(proj, 220);
        lv_label_set_long_mode(proj, LV_LABEL_LONG_DOT);
        lv_obj_align(proj, LV_ALIGN_TOP_LEFT, 122, y - 1);

        lv_obj_t* line = makeLabel(s_body, &font_kr_16, Theme::HUDDim, rows[i].line);
        lv_obj_set_width(line, 430);
        lv_label_set_long_mode(line, LV_LABEL_LONG_DOT);
        lv_obj_align(line, LV_ALIGN_TOP_LEFT, 30, y + 24);

        const char* rowStatus = rows[i].focused ? "FOCUS"
                              : strstr(rows[i].state, "awaiting") ? "INPUT"
                              : strcmp(rows[i].state, "processing") == 0 ? "WORK"
                              : "READY";
        lv_obj_t* st = makeLabel(s_body, &lv_font_montserrat_14,
                                 stateColorOf(rows[i].state), rowStatus);
        lv_obj_align(st, LV_ALIGN_TOP_RIGHT, -12, y);
    }
}

// CAM page: live viewfinder on the left, explicit action chips on the right.
// The canvas object is rebuilt with the body on every signature change, but
// the PSRAM pixel buffer persists — update() streams frames into it directly.
static void renderCameraPage() {
    s_camCanvas = nullptr;
    if (!Camera::present()) return;
    if (!s_camBuf) {
        s_camBuf = (uint16_t*)heap_caps_malloc(
            (size_t)CAM_VIEW_W * CAM_VIEW_H * 2, MALLOC_CAP_SPIRAM);
        if (s_camBuf) memset(s_camBuf, 0, (size_t)CAM_VIEW_W * CAM_VIEW_H * 2);
    }
    if (!s_camBuf) {
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_14, Theme::HUDDim,
                                "viewfinder buffer failed");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }

    s_camCanvas = lv_canvas_create(s_body);
    // Little-endian RGB565 — the universally supported source format;
    // grabPreview swaps the camera's big-endian pixels on copy and LVGL's
    // draw path converts to this display's RGB565_SWAPPED output.
    lv_canvas_set_buffer(s_camCanvas, s_camBuf, CAM_VIEW_W, CAM_VIEW_H,
                         LV_COLOR_FORMAT_RGB565);
    lv_obj_set_pos(s_camCanvas, 8, 0);

    // Where the shot goes: the strip's focus pick, same as every action.
    char target[64] = "-> (no session)";
    {
        lockState();
        int idx = pickFocusSession();
        if (idx >= 0) {
            snprintf(target, sizeof(target), "-> %s",
                     g_state.sessions[idx].projectName[0]
                         ? g_state.sessions[idx].projectName
                         : g_state.sessions[idx].agentType);
        }
        unlockState();
        Utf8::sanitizeLvglText(target);
    }
    lv_obj_t* tgt = makeLabel(s_body, &font_kr_16, Theme::HUDText, target);
    lv_obj_set_width(tgt, 210);
    lv_label_set_long_mode(tgt, LV_LABEL_LONG_DOT);
    lv_obj_align(tgt, LV_ALIGN_TOP_LEFT, 262, 6);

    auto actionChip = [&](int x, int y, int w, const char* label, uint32_t color) {
        lv_obj_t* chip = lv_obj_create(s_body);
        lv_obj_remove_style_all(chip);
        lv_obj_set_size(chip, w, 34);
        lv_obj_set_pos(chip, x, y);
        lv_obj_set_style_bg_color(chip, lv_color_hex(color), 0);
        lv_obj_set_style_bg_opa(chip, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(chip, 5, 0);
        lv_obj_t* text = makeLabel(chip, &lv_font_montserrat_16, 0xFFFFFF, label);
        lv_obj_align(text, LV_ALIGN_CENTER, 0, 0);
    };
    // Same geometry family as the Focus approve/deny chips.
    actionChip(262, BODY_H - 38, 96, "SNAP", Theme::StatusCyan);
    actionChip(368, BODY_H - 38, 100,
               Camera::lampDuty() > 0 ? "LED ON" : "LED",
               Camera::lampDuty() > 0 ? Theme::StatusAmber : Theme::MidWater);

    bool flashOn = s_flashText[0] != '\0';
    lv_obj_t* hint = makeLabel(s_body, &lv_font_montserrat_12,
                               flashOn ? Theme::StatusGreen : Theme::HUDFaint,
                               flashOn ? s_flashText
                                       : "BOOT or SNAP sends to the agent");
    lv_obj_align(hint, LV_ALIGN_TOP_LEFT, 262, 96);
}

namespace Ticker {

void create() {
    s_scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(s_scr, lv_color_hex(Theme::DeepSea), 0);
    lv_obj_set_style_bg_opa(s_scr, LV_OPA_COVER, 0);

    lv_obj_t* topRail = lv_obj_create(s_scr);
    lv_obj_remove_style_all(topRail);
    lv_obj_set_size(topRail, 480, KEY_RAIL_H);
    lv_obj_set_style_bg_opa(topRail, LV_OPA_TRANSP, 0);
    lv_obj_align(topRail, LV_ALIGN_TOP_LEFT, 0, 0);
    // Upper pair, left → right: previous page, next page.
    s_hintPrev = makeKeyHint(topRail, "SESS", KEY_HINT_X, Theme::HUDDim);
    s_hintNext = makeKeyHint(topRail, "USAGE",
                             KEY_HINT_X + KEY_HINT_W + KEY_HINT_GAP,
                             Theme::HUDDim);

    lv_obj_t* header = lv_obj_create(s_scr);
    lv_obj_remove_style_all(header);
    lv_obj_set_size(header, 480, HEADER_H);
    lv_obj_set_style_bg_color(header, lv_color_hex(Theme::MidWater), 0);
    lv_obj_set_style_bg_opa(header, LV_OPA_COVER, 0);
    lv_obj_align(header, LV_ALIGN_TOP_LEFT, 0, HEADER_Y);

    static const char* tabNames[4] = {"FOCUS", "USAGE", "SESSIONS", "CAM"};
    static const int tabX[4] = {10, 84, 158, 246};
    int tabCount = Camera::present() ? 4 : 3;
    for (int i = 0; i < tabCount; i++) {
        s_tabs[i] = makeLabel(header, &lv_font_montserrat_14, Theme::HUDDim, tabNames[i]);
        lv_obj_set_pos(s_tabs[i], tabX[i], 7);
    }
    s_hdrBattery = makeLabel(header, &lv_font_montserrat_14, Theme::HUDDim, "");
    lv_obj_align(s_hdrBattery, LV_ALIGN_RIGHT_MID, -32, 0);
    s_hdrWifi = makeLabel(header, &lv_font_montserrat_14, Theme::HUDDim, LV_SYMBOL_WIFI);
    lv_obj_align(s_hdrWifi, LV_ALIGN_RIGHT_MID, -8, 0);

    s_body = lv_obj_create(s_scr);
    lv_obj_remove_style_all(s_body);
    lv_obj_set_size(s_body, 480, BODY_H);
    lv_obj_align(s_body, LV_ALIGN_TOP_LEFT, 0, BODY_Y);

    lv_obj_t* bottomRail = lv_obj_create(s_scr);
    lv_obj_remove_style_all(bottomRail);
    lv_obj_set_size(bottomRail, 480, KEY_RAIL_H);
    lv_obj_set_style_bg_opa(bottomRail, LV_OPA_TRANSP, 0);
    lv_obj_align(bottomRail, LV_ALIGN_BOTTOM_LEFT, 0, 0);
    // Lower pair, left → right: hard power/reset, Focus/select.
    s_hintReset = makeKeyHint(bottomRail, LV_SYMBOL_POWER,
                              KEY_HINT_X, Theme::StatusRed);
    s_hintPrimary = makeKeyHint(bottomRail, "FOCUS",
                                KEY_HINT_X + KEY_HINT_W + KEY_HINT_GAP,
                                Theme::HUDDim);

    lv_screen_load(s_scr);
    s_lastSig[0] = '\0';
}

void nextPage() {
    s_page = (uint8_t)((s_page + 1) % pageCount());
}

void prevPage() {
    uint8_t n = pageCount();
    s_page = (uint8_t)((s_page + n - 1) % n);
}

// Capture one frame and hand it to the network task, aimed at the strip's
// current focus pick (same target logic as every other strip action).
static void snapPhoto() {
    if (!Camera::active()) {
        flash("camera not ready");
        return;
    }
    if (Net::photoUploadBusy()) {
        flash("still sending...");
        return;
    }
    lockState();
    int idx = pickFocusSession();
    char sid[32] = {0};
    if (idx >= 0) strncpy(sid, g_state.sessions[idx].id, sizeof(sid) - 1);
    unlockState();
    uint8_t* jpeg = nullptr;
    size_t len = 0;
    int w = 0, h = 0;
    // Blocking encode (~hundreds of ms) — acceptable for an explicit shutter.
    if (!Camera::captureJpeg(&jpeg, &len, &w, &h)) {
        flash("capture failed");
        return;
    }
    // Power the sensor down BEFORE the upload: camera + serial TX burst
    // together collapsed the rail into a full power-on reset mid-upload
    // (2026-07-27, 5 chunks then silence). The page watcher in update()
    // re-acquires the preview once the upload has drained.
    Camera::release();
    if (!Net::queuePhotoHttpUpload(jpeg, len, sid, w, h) &&
        !Net::queuePhotoUpload(jpeg, len, sid, w, h)) {
        free(jpeg);
        flash("no link - not sent");
        return;
    }
    char note[32];
    snprintf(note, sizeof(note), "sending %u KB...", (unsigned)(len / 1024));
    flash(note);
}

void primaryAction() {
    if (s_page == PAGE_CAM) {
        snapPhoto();
        return;
    }
    if (s_page != 0) {
        s_page = 0;
        flash("focus");
        return;
    }
    lockState();
    int idx = pickFocusSession();
    char sid[32] = {0};
    if (idx >= 0) strncpy(sid, g_state.sessions[idx].id, sizeof(sid) - 1);
    unlockState();
    if (sid[0]) {
        sendFocusSession(sid);
        flash("focused");
    }
}

void buttonFeedback(uint8_t button) {
    if (button >= 3) return;
    s_buttonActiveUntil[button] = millis() + 260;
}

void onTouch(const Input::TouchEvent& event) {
    if (event.gesture == Input::TouchGesture::NONE) return;
    if (event.gesture == Input::TouchGesture::SWIPE_LEFT) {
        nextPage();
        return;
    }
    if (event.gesture == Input::TouchGesture::SWIPE_RIGHT) {
        prevPage();
        return;
    }
    if (event.gesture != Input::TouchGesture::TAP) return;

    // Header tabs are direct, generously spaced targets.
    if (event.y < BODY_Y) {
        if (event.x < 74) s_page = 0;
        else if (event.x < 148) s_page = 1;
        else if (event.x < 240) s_page = 2;
        else if (event.x < 300 && Camera::present()) s_page = PAGE_CAM;
        return;
    }

    if (s_page == PAGE_CAM) {
        // Explicit chips only, mirroring the Focus-page approval rule: a stray
        // tap on the viewfinder never fires the shutter.
        if (event.y >= BODY_Y + BODY_H - 44 && event.x >= 262 && event.x < 362) {
            snapPhoto();
        } else if (event.y >= BODY_Y + BODY_H - 44 && event.x >= 368) {
            // Modest duty: the shield LED at full blast runs hot (vendor note).
            Camera::setLamp(Camera::lampDuty() > 0 ? 0 : 24);
            s_lastSig[0] = '\0';  // re-render the chip state
        } else if (event.y < BODY_Y + 50 && event.x >= 250) {
            // Tap the target line to cycle which session receives the shot —
            // no Sessions-page round trip. Awaiting still outranks the pick
            // (a response-wait owns the strip's attention).
            lockState();
            int cur = pickFocusSession();
            char sid[32] = {0};
            if (g_state.sessionCount > 0) {
                int next = cur < 0 ? 0 : (cur + 1) % g_state.sessionCount;
                strncpy(sid, g_state.sessions[next].id, sizeof(sid) - 1);
            }
            unlockState();
            if (sid[0]) {
                sendFocusSession(sid);
                flash("target changed");
            }
        }
        return;
    }

    if (s_page == 2) {
        int row = (event.y - BODY_Y) / (BODY_H / 3);
        if (row >= 0 && row < s_sessionRowCount && s_sessionRowIds[row][0]) {
            sendFocusSession(s_sessionRowIds[row]);
            s_page = 0;
            flash("focused from sessions");
        }
        return;
    }
    if (s_page != 0) return;

    // Approval is only sent from the visible, explicit bottom action chips.
    // A stray tap or long press elsewhere can never answer a permission gate.
    FocusSnap f = {};
    lockState();
    int idx = pickFocusSession();
    if (idx >= 0) {
        const SessionInfo& sess = g_state.sessions[idx];
        f.have = true;
        f.awaiting = strstr(sess.state, "awaiting") != nullptr;
        strncpy(f.id, sess.id, sizeof(f.id));
        strncpy(f.requestId, sess.requestId, sizeof(f.requestId));
    }
    unlockState();
    if (!f.have) return;
    if (f.awaiting && event.y >= BODY_Y + BODY_H - 44 && event.x >= 372) {
        if (f.requestId[0]) sendPermissionDecision(f.requestId, true);
        else sendSelectOption(f.id, 0);
        flash("sent: approve");
    } else if (f.awaiting && event.y >= BODY_Y + BODY_H - 44 &&
               event.x >= 272 && event.x < 364) {
        if (f.requestId[0]) sendPermissionDecision(f.requestId, false);
        else sendSessionEscape(f.id);
        flash("sent: deny");
    } else {
        sendFocusSession(f.id);
        flash("focused");
    }
}

void update(float dt) {
    (void)dt;
    uint32_t now = millis();
    updateKeyHints(now);

    // Camera power follows the page: acquire on entry, release on leave.
    // Keeping the sensor powered around the clock tripped the brownout
    // detector when WiFi TX started (see Camera::init).
    {
        static bool wasCamPage = false;
        static uint32_t lastReacquireMs = 0;
        bool isCamPage = (s_page == PAGE_CAM);
        if (isCamPage && !wasCamPage) {
            if (!Camera::acquire()) flash("camera power failed");
        } else if (!isCamPage && wasCamPage) {
            Camera::release();
        } else if (isCamPage && !Camera::active() && !Net::photoUploadBusy() &&
                   (uint32_t)(now - lastReacquireMs) > 2000) {
            // Preview comes back once the upload drains (snapPhoto released
            // the sensor so the TX burst never overlaps camera draw).
            lastReacquireMs = now;
            Camera::acquire();
        }
        wasCamPage = isCamPage;
    }

    bool flashOn = s_flashText[0] && (int32_t)(s_flashUntilMs - now) > 0;
    if (!flashOn) s_flashText[0] = '\0';

    // A response-wait owns the strip: snap to the Focus page and hold there.
    bool anyAwaitingNow = false;
    lockState();
    for (uint8_t i = 0; i < g_state.sessionCount; i++) {
        if (strstr(g_state.sessions[i].state, "awaiting") != nullptr) { anyAwaitingNow = true; break; }
    }
    unlockState();
    // The CAM page is exempt: yanking the strip away mid-framing loses the
    // shot, and the user composing a photo is at the desk anyway.
    if (anyAwaitingNow && s_page != 0 && s_page != PAGE_CAM) {
        s_page = 0;
    }

    bool wifiUp = Net::wifiConnected();
    bool wsUp = Net::wsConnected();
    Input::PowerStatus power = Input::powerStatus();

    // Focus snapshot (page 0 content)
    FocusSnap focus = {};
    {
        lockState();
        int idx = pickFocusSession();
        if (idx >= 0) {
            const SessionInfo& sess = g_state.sessions[idx];
            focus.have = true;
            focus.awaiting = strstr(sess.state, "awaiting") != nullptr;
            strncpy(focus.id, sess.id, sizeof(focus.id));
            strncpy(focus.agentType, sess.agentType, sizeof(focus.agentType));
            strncpy(focus.projectName, sess.projectName, sizeof(focus.projectName));
            strncpy(focus.state, sess.state, sizeof(focus.state));
            strncpy(focus.requestId, sess.requestId, sizeof(focus.requestId));
            // Caption: awaiting question > live activity/tool > last milestone.
            if (focus.awaiting && sess.question[0])
                strncpy(focus.caption, sess.question, sizeof(focus.caption));
            else if (strcmp(sess.state, "processing") == 0 && sess.activity[0])
                strncpy(focus.caption, sess.activity, sizeof(focus.caption));
            else if (strcmp(sess.state, "processing") == 0 && sess.currentTool[0])
                strncpy(focus.caption, sess.currentTool, sizeof(focus.caption));
            else if (sess.lastEventText[0])
                strncpy(focus.caption, sess.lastEventText, sizeof(focus.caption));
            else
                strncpy(focus.caption, "Ready for the next task", sizeof(focus.caption));
            focus.caption[sizeof(focus.caption) - 1] = '\0';
        }
        unlockState();
        Utf8::sanitizeLvglText(focus.projectName);
        Utf8::sanitizeLvglText(focus.caption);
    }

    // Signature: page + coarse usage buckets + session states/lines.
    char sig[320];
    {
        lockState();
        int c5 = (int)g_state.fiveHourPercent, c7 = (int)g_state.sevenDayPercent;
        int x5 = (int)g_state.codexPrimaryPercent, x7 = (int)g_state.codexSecondaryPercent;
        char sess[128] = {0};
        size_t off = 0;
        for (uint8_t i = 0; i < g_state.sessionCount && off < sizeof(sess) - 28; i++) {
            off += snprintf(sess + off, sizeof(sess) - off, "%.6s:%.8s:%.12s|",
                            g_state.sessions[i].state,
                            g_state.sessions[i].projectName,
                            g_state.sessions[i].lastEventText);
        }
        uint8_t count = g_state.sessionCount;
        bool connected = g_state.wsConnected;
        uint8_t subsCount = g_state.subscriptionCount;
        char focused[32];
        strncpy(focused, g_state.focusedSessionId, sizeof(focused) - 1);
        focused[sizeof(focused) - 1] = '\0';
        char resets[42];
        snprintf(resets, sizeof(resets), "%.9s|%.9s|%.9s|%.9s",
                 g_state.fiveHourReset, g_state.sevenDayReset,
                 g_state.codexPrimaryReset, g_state.codexSecondaryReset);
        unlockState();
        snprintf(sig, sizeof(sig), "%d|%d.%d.%d.%d|%s|%d|%d|%d%d%d|%d|%d%d|%.20s|%.6s%.10s%.36s|%.31s|%s",
                 s_page,
                 c5, c7, x5, x7, resets, subsCount, count,
                 connected ? 1 : 0, wifiUp ? 1 : 0, wsUp ? 1 : 0,
                 power.voltageMv / 20, power.charging ? 1 : 0, power.usbPowered ? 1 : 0,
                 s_flashText,
                 focus.state, focus.projectName, focus.caption,
                 focused, sess);
    }
    // Viewfinder frames stream outside the signature: the canvas buffer is
    // updated in place and invalidated, no widget churn.
    if (s_page == PAGE_CAM && s_camCanvas && s_camBuf &&
        (uint32_t)(now - s_camLastFrameMs) >= CAM_PREVIEW_INTERVAL_MS) {
        s_camLastFrameMs = now;
        if (Camera::grabPreview(s_camBuf, CAM_VIEW_W, CAM_VIEW_H)) {
            lv_obj_invalidate(s_camCanvas);
        }
    }

    if (strcmp(sig, s_lastSig) == 0) return;
    strncpy(s_lastSig, sig, sizeof(s_lastSig) - 1);
    s_lastSig[sizeof(s_lastSig) - 1] = '\0';

    lv_obj_set_style_text_color(
        s_hdrWifi,
        lv_color_hex(wsUp ? Theme::StatusGreen : (wifiUp ? Theme::StatusAmber : Theme::StatusRed)), 0);
    for (int i = 0; i < pageCount(); i++) {
        if (!s_tabs[i]) continue;
        lv_obj_set_style_text_color(s_tabs[i],
            lv_color_hex(i == s_page ? Theme::StatusCyan : Theme::HUDDim), 0);
    }
    if (power.valid) {
        char battery[24];
        snprintf(battery, sizeof(battery), "%s%s %.2fV",
                 power.charging ? LV_SYMBOL_CHARGE : "",
                 LV_SYMBOL_BATTERY_FULL, power.voltageMv / 1000.0f);
        lv_label_set_text(s_hdrBattery, battery);
        lv_obj_set_style_text_color(s_hdrBattery,
            lv_color_hex(power.charging ? Theme::StatusBlue : Theme::HUDDim), 0);
    } else if (power.usbPowered) {
        lv_label_set_text(s_hdrBattery, "USB");
        lv_obj_set_style_text_color(s_hdrBattery, lv_color_hex(Theme::StatusBlue), 0);
    } else {
        lv_label_set_text(s_hdrBattery, "");
    }

    lv_obj_clean(s_body);
    s_camCanvas = nullptr;  // owned by s_body — gone with the clean
    {
        lockState();
        bool connectedNow = g_state.wsConnected;
        unlockState();
        if (s_page == 0) renderFocusPage(focus, connectedNow);
        else if (s_page == 1) renderUsagePage();
        else if (s_page == PAGE_CAM) renderCameraPage();
        else renderSessionsPage();
    }
}

void onPhotoResult(bool delivered, const char* detail) {
    // Always surface the outcome — a shutter press that shows nothing is
    // indistinguishable from a dead camera (same rule as voice_result).
    char note[32];
    if (delivered) snprintf(note, sizeof(note), "photo sent");
    else snprintf(note, sizeof(note), "photo failed%s%.14s",
                  detail && detail[0] ? ": " : "", detail ? detail : "");
    Utf8::utf8TrimEnd(note);
    flash(note);
}

}  // namespace Ticker

#endif  // BOARD_T_DISPLAY_PRO
