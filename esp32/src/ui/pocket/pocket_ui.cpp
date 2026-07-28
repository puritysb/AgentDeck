#if defined(BOARD_T_DISPLAY_PRO)

#include "pocket_ui.h"
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

// Portrait geometry (rotation 0).
static constexpr int POCKET_W = 222;
static constexpr int POCKET_H = 480;
static constexpr int STATUS_H = 26;
static constexpr int NAV_H = 44;
static constexpr int CONTENT_Y = STATUS_H;
static constexpr int CONTENT_H = POCKET_H - STATUS_H - NAV_H;

// Viewfinder: 2:1 decimated, 90°-rotated sensor frame (320x480 -> 160x240).
static constexpr int VF_W = 160;
static constexpr int VF_H = 240;
static constexpr uint32_t VF_INTERVAL_MS = 100;

enum Tab : uint8_t { TAB_SESSIONS = 0, TAB_CAM = 1, TAB_USAGE = 2 };
static constexpr uint8_t TAB_COUNT = 3;

static uint8_t s_tab = TAB_SESSIONS;
static lv_obj_t* s_scr = nullptr;
static lv_obj_t* s_status = nullptr;
static lv_obj_t* s_statusText = nullptr;
static lv_obj_t* s_statusLink = nullptr;
static lv_obj_t* s_content = nullptr;
static lv_obj_t* s_navBtns[TAB_COUNT] = {nullptr, nullptr, nullptr};
static lv_obj_t* s_toast = nullptr;
static lv_obj_t* s_toastText = nullptr;
static uint32_t s_toastUntilMs = 0;

static lv_obj_t* s_vfCanvas = nullptr;
static uint16_t* s_vfBuf = nullptr;
static uint32_t s_vfLastMs = 0;
static lv_obj_t* s_camTarget = nullptr;

static char s_cardIds[10][32] = {};
static uint8_t s_cardCount = 0;
static char s_lastSig[360] = {0};

// ── small helpers (mirrors of the ticker's file-statics; the two UIs are
// alternative render trees over the same state, never active together) ───────

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

static bool sameSessionId(const char* a, const char* b) {
    if (!a || !b || !a[0] || !b[0]) return false;
    if (strcmp(a, b) == 0) return true;
    size_t alen = strlen(a), blen = strlen(b);
    size_t n = alen < blen ? alen : blen;
    return n >= 31 && strncmp(a, b, n) == 0;
}

// Awaiting owns the shot target; explicit focus, then live work, then first.
static int pickFocusSession() {
    int firstAwaiting = -1, explicitFocus = -1, firstProcessing = -1;
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

static void sendFocusSession(const char* sid) {
    char buf[80];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"focus_session\",\"sessionId\":\"%s\"}", sid);
    Net::queueOutbound(buf);
}

static void toast(const char* text) {
    if (!s_toastText) return;
    lv_label_set_text(s_toastText, text);
    lv_obj_clear_flag(s_toast, LV_OBJ_FLAG_HIDDEN);
    s_toastUntilMs = millis() + 1800;
}

// ── camera actions ──────────────────────────────────────────────────────────

static void snapPhoto() {
    if (!Camera::active()) {
        toast("camera not ready");
        return;
    }
    if (Net::photoUploadBusy()) {
        toast("still sending...");
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
    if (!Camera::captureJpegPortrait(&jpeg, &len, &w, &h)) {
        toast("capture failed");
        return;
    }
    // Sensor off before the upload burst (rail collapse lesson, 2026-07-27);
    // update() re-acquires once the upload drains.
    Camera::release();
    // HTTP first: one POST over TCP, immune to the CDC's block drops and the
    // WS client's TX jam. Chunked transports remain the no-WiFi fallback.
    if (!Net::queuePhotoHttpUpload(jpeg, len, sid, w, h) &&
        !Net::queuePhotoUpload(jpeg, len, sid, w, h)) {
        free(jpeg);
        toast("no link - not sent");
        return;
    }
    char note[32];
    snprintf(note, sizeof(note), "sending %u KB...", (unsigned)(len / 1024));
    toast(note);
}

static void cycleTarget() {
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
        s_lastSig[0] = '\0';
    }
}

// ── LVGL event callbacks (run inside lv_timer_handler on the UI core) ───────

static void onCardClicked(lv_event_t* e) {
    int idx = (int)(intptr_t)lv_event_get_user_data(e);
    if (idx < 0 || idx >= s_cardCount || !s_cardIds[idx][0]) return;
    sendFocusSession(s_cardIds[idx]);
    toast("focused");
    s_lastSig[0] = '\0';
}

static void onNavClicked(lv_event_t* e) {
    int tab = (int)(intptr_t)lv_event_get_user_data(e);
    if (tab >= 0 && tab < TAB_COUNT) s_tab = (uint8_t)tab;
}

static void onSnapClicked(lv_event_t*) { snapPhoto(); }
static void onLampClicked(lv_event_t*) {
    Camera::setLamp(Camera::lampDuty() > 0 ? 0 : 24);
    s_lastSig[0] = '\0';
}
static void onTargetClicked(lv_event_t*) { cycleTarget(); }

// ── widget builders ─────────────────────────────────────────────────────────

static lv_obj_t* makeLabel(lv_obj_t* parent, const lv_font_t* font,
                           uint32_t color, const char* text) {
    lv_obj_t* l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_label_set_text(l, text);
    return l;
}

static lv_obj_t* makeButton(lv_obj_t* parent, int w, int h, uint32_t bg,
                            const char* text, const lv_font_t* font,
                            lv_event_cb_t cb, void* user) {
    lv_obj_t* btn = lv_obj_create(parent);
    lv_obj_remove_style_all(btn);
    lv_obj_set_size(btn, w, h);
    lv_obj_set_style_bg_color(btn, lv_color_hex(bg), 0);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(btn, 6, 0);
    lv_obj_add_flag(btn, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(btn, cb, LV_EVENT_CLICKED, user);
    lv_obj_t* l = makeLabel(btn, font, 0xFFFFFF, text);
    lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
    return btn;
}

static void renderSessionsTab() {
    lv_obj_set_layout(s_content, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(s_content, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(s_content, 6, 0);
    lv_obj_set_style_pad_all(s_content, 6, 0);

    struct Row {
        char agentType[16];
        char projectName[40];
        char state[20];
        char line[100];
        bool focused;
    } rows[10];
    uint8_t n = 0;
    s_cardCount = 0;
    memset(s_cardIds, 0, sizeof(s_cardIds));
    lockState();
    for (uint8_t i = 0; i < g_state.sessionCount && n < 10; i++) {
        const SessionInfo& s = g_state.sessions[i];
        strncpy(rows[n].agentType, s.agentType, sizeof(rows[n].agentType));
        strncpy(rows[n].projectName, s.projectName, sizeof(rows[n].projectName));
        strncpy(rows[n].state, s.state, sizeof(rows[n].state));
        strncpy(rows[n].line, s.lastEventText[0] ? s.lastEventText : s.activity,
                sizeof(rows[n].line));
        rows[n].focused = sameSessionId(s.id, g_state.focusedSessionId);
        strncpy(s_cardIds[n], s.id, sizeof(s_cardIds[n]) - 1);
        n++;
    }
    unlockState();
    s_cardCount = n;

    if (n == 0) {
        lv_obj_t* l = makeLabel(s_content, &lv_font_montserrat_14, Theme::HUDDim,
                                "No active sessions");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }

    for (uint8_t i = 0; i < n; i++) {
        Utf8::sanitizeLvglText(rows[i].projectName);
        Utf8::sanitizeLvglText(rows[i].line);
        bool awaiting = strstr(rows[i].state, "awaiting") != nullptr;

        lv_obj_t* card = lv_obj_create(s_content);
        lv_obj_remove_style_all(card);
        lv_obj_set_size(card, POCKET_W - 12, 66);
        lv_obj_set_style_bg_color(card, lv_color_hex(Theme::MidWater), 0);
        lv_obj_set_style_bg_opa(card, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(card, 6, 0);
        lv_obj_add_flag(card, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_event_cb(card, onCardClicked, LV_EVENT_CLICKED,
                            (void*)(intptr_t)i);

        if (rows[i].focused || awaiting) {
            lv_obj_t* rail = lv_obj_create(card);
            lv_obj_remove_style_all(rail);
            lv_obj_set_size(rail, 4, 58);
            lv_obj_set_style_bg_color(
                rail, lv_color_hex(awaiting ? Theme::StatusAmber : Theme::StatusCyan), 0);
            lv_obj_set_style_bg_opa(rail, LV_OPA_COVER, 0);
            lv_obj_align(rail, LV_ALIGN_LEFT_MID, 2, 0);
        }

        lv_obj_t* dot = lv_obj_create(card);
        lv_obj_remove_style_all(dot);
        lv_obj_set_size(dot, 10, 10);
        lv_obj_set_style_bg_color(dot, lv_color_hex(stateColorOf(rows[i].state)), 0);
        lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(dot, 5, 0);
        lv_obj_set_pos(dot, 12, 8);

        lv_obj_t* brand = makeLabel(card, &lv_font_montserrat_12,
                                    agentColor(rows[i].agentType),
                                    agentShortLabel(rows[i].agentType));
        lv_obj_set_pos(brand, 28, 5);

        const char* rowStatus = awaiting ? "INPUT"
                              : strcmp(rows[i].state, "processing") == 0 ? "WORK"
                              : "READY";
        lv_obj_t* st = makeLabel(card, &lv_font_montserrat_12,
                                 stateColorOf(rows[i].state), rowStatus);
        lv_obj_align(st, LV_ALIGN_TOP_RIGHT, -8, 5);

        lv_obj_t* proj = makeLabel(card, &font_kr_16, Theme::HUDText,
                                   rows[i].projectName[0] ? rows[i].projectName
                                                          : "(no project)");
        lv_obj_set_width(proj, POCKET_W - 40);
        lv_label_set_long_mode(proj, LV_LABEL_LONG_DOT);
        lv_obj_set_pos(proj, 12, 22);

        lv_obj_t* line = makeLabel(card, &font_kr_12, Theme::HUDDim, rows[i].line);
        lv_obj_set_width(line, POCKET_W - 40);
        lv_label_set_long_mode(line, LV_LABEL_LONG_DOT);
        lv_obj_set_pos(line, 12, 46);
    }
}

static void renderCamTab() {
    // Absolute layout — undo the sessions tab's flex before positioning.
    lv_obj_set_layout(s_content, LV_LAYOUT_NONE);
    lv_obj_set_style_pad_all(s_content, 0, 0);
    s_vfCanvas = nullptr;

    if (!Camera::present()) {
        lv_obj_t* l = makeLabel(s_content, &lv_font_montserrat_14, Theme::HUDDim,
                                "no camera shield");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }
    if (!s_vfBuf) {
        s_vfBuf = (uint16_t*)heap_caps_malloc(
            (size_t)VF_W * VF_H * 2, MALLOC_CAP_SPIRAM);
        if (s_vfBuf) memset(s_vfBuf, 0, (size_t)VF_W * VF_H * 2);
    }

    // Where the shot goes — tap to cycle.
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
    s_camTarget = lv_obj_create(s_content);
    lv_obj_remove_style_all(s_camTarget);
    lv_obj_set_size(s_camTarget, POCKET_W - 12, 30);
    lv_obj_set_pos(s_camTarget, 6, 4);
    lv_obj_set_style_bg_color(s_camTarget, lv_color_hex(Theme::MidWater), 0);
    lv_obj_set_style_bg_opa(s_camTarget, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(s_camTarget, 6, 0);
    lv_obj_add_flag(s_camTarget, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(s_camTarget, onTargetClicked, LV_EVENT_CLICKED, nullptr);
    lv_obj_t* tgt = makeLabel(s_camTarget, &font_kr_16, Theme::HUDText, target);
    lv_obj_set_width(tgt, POCKET_W - 28);
    lv_label_set_long_mode(tgt, LV_LABEL_LONG_DOT);
    lv_obj_align(tgt, LV_ALIGN_LEFT_MID, 8, 0);

    if (s_vfBuf) {
        s_vfCanvas = lv_canvas_create(s_content);
        lv_canvas_set_buffer(s_vfCanvas, s_vfBuf, VF_W, VF_H,
                             LV_COLOR_FORMAT_RGB565);
        lv_obj_set_pos(s_vfCanvas, (POCKET_W - VF_W) / 2, 40);
    }

    lv_obj_t* snap = makeButton(s_content, POCKET_W - 12, 48, Theme::StatusCyan,
                                "SNAP", &lv_font_montserrat_18, onSnapClicked,
                                nullptr);
    lv_obj_set_pos(snap, 6, 292);

    lv_obj_t* lamp = makeButton(
        s_content, 84, 34,
        Camera::lampDuty() > 0 ? Theme::StatusAmber : Theme::MidWater,
        Camera::lampDuty() > 0 ? "LED ON" : "LED",
        &lv_font_montserrat_14, onLampClicked, nullptr);
    lv_obj_set_pos(lamp, 6, 350);

    lv_obj_t* hint = makeLabel(s_content, &lv_font_montserrat_12, Theme::HUDFaint,
                               "BOOT = shutter · tap bar = target");
    lv_obj_set_pos(hint, 6, 394);
}

static void renderUsageTab() {
    lv_obj_set_layout(s_content, LV_LAYOUT_NONE);
    lv_obj_set_style_pad_all(s_content, 6, 0);
    struct GaugeData { const char* label; float pct; char reset[20]; };
    GaugeData rowsArr[4];
    uint8_t n = 0;
    lockState();
    auto take = [&](const char* label, float pct, const char* reset) {
        if (pct < 0.0f) return;
        rowsArr[n].label = label;
        rowsArr[n].pct = pct;
        strncpy(rowsArr[n].reset, reset, sizeof(rowsArr[n].reset) - 1);
        rowsArr[n].reset[sizeof(rowsArr[n].reset) - 1] = '\0';
        n++;
    };
    take("Claude 5h", g_state.fiveHourPercent, g_state.fiveHourReset);
    take("Claude 7d", g_state.sevenDayPercent, g_state.sevenDayReset);
    take("Codex 5h", g_state.codexPrimaryPercent, g_state.codexPrimaryReset);
    take("Codex 7d", g_state.codexSecondaryPercent, g_state.codexSecondaryReset);
    unlockState();

    if (n == 0) {
        lv_obj_t* l = makeLabel(s_content, &lv_font_montserrat_14, Theme::HUDDim,
                                "Waiting for usage data...");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }
    for (uint8_t i = 0; i < n; i++) {
        int y = 8 + i * 92;
        lv_obj_t* name = makeLabel(s_content, &lv_font_montserrat_14,
                                   Theme::HUDText, rowsArr[i].label);
        lv_obj_set_pos(name, 6, y);
        lv_obj_t* track = lv_obj_create(s_content);
        lv_obj_remove_style_all(track);
        lv_obj_set_size(track, POCKET_W - 24, 34);
        lv_obj_set_style_bg_color(track, lv_color_hex(Theme::MidWater), 0);
        lv_obj_set_style_bg_opa(track, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(track, 4, 0);
        lv_obj_set_pos(track, 6, y + 22);
        float clamped = rowsArr[i].pct > 100.0f ? 100.0f : rowsArr[i].pct;
        int w = (int)((POCKET_W - 24) * clamped / 100.0f);
        if (w > 0) {
            uint32_t color = clamped >= 85.0f ? Theme::StatusRed
                           : clamped >= 60.0f ? Theme::StatusAmber
                                              : Theme::StatusGreen;
            lv_obj_t* fill = lv_obj_create(track);
            lv_obj_remove_style_all(fill);
            lv_obj_set_size(fill, w < 4 ? 4 : w, 34);
            lv_obj_set_style_bg_color(fill, lv_color_hex(color), 0);
            lv_obj_set_style_bg_opa(fill, LV_OPA_COVER, 0);
            lv_obj_set_style_radius(fill, 4, 0);
            lv_obj_align(fill, LV_ALIGN_LEFT_MID, 0, 0);
        }
        char pctText[8];
        snprintf(pctText, sizeof(pctText), "%d%%", (int)clamped);
        lv_obj_t* p = makeLabel(track, &lv_font_montserrat_16, 0xFFFFFF, pctText);
        lv_obj_align(p, LV_ALIGN_LEFT_MID, 8, 0);
        if (rowsArr[i].reset[0]) {
            lv_obj_t* r = makeLabel(s_content, &lv_font_montserrat_12,
                                    Theme::HUDDim, rowsArr[i].reset);
            lv_obj_align(r, LV_ALIGN_TOP_RIGHT, -8, y + 2);
        }
    }
}

namespace Pocket {

void create() {
    s_scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(s_scr, lv_color_hex(Theme::DeepSea), 0);
    lv_obj_set_style_bg_opa(s_scr, LV_OPA_COVER, 0);

    s_status = lv_obj_create(s_scr);
    lv_obj_remove_style_all(s_status);
    lv_obj_set_size(s_status, POCKET_W, STATUS_H);
    lv_obj_set_style_bg_color(s_status, lv_color_hex(Theme::MidWater), 0);
    lv_obj_set_style_bg_opa(s_status, LV_OPA_COVER, 0);
    s_statusText = makeLabel(s_status, &lv_font_montserrat_12, Theme::HUDText,
                             "AgentDeck");
    lv_obj_align(s_statusText, LV_ALIGN_LEFT_MID, 8, 0);
    s_statusLink = makeLabel(s_status, &lv_font_montserrat_12, Theme::HUDDim,
                             LV_SYMBOL_WIFI);
    lv_obj_align(s_statusLink, LV_ALIGN_RIGHT_MID, -8, 0);

    s_content = lv_obj_create(s_scr);
    lv_obj_remove_style_all(s_content);
    lv_obj_set_size(s_content, POCKET_W, CONTENT_H);
    lv_obj_set_pos(s_content, 0, CONTENT_Y);
    lv_obj_set_scroll_dir(s_content, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(s_content, LV_SCROLLBAR_MODE_AUTO);

    lv_obj_t* nav = lv_obj_create(s_scr);
    lv_obj_remove_style_all(nav);
    lv_obj_set_size(nav, POCKET_W, NAV_H);
    lv_obj_align(nav, LV_ALIGN_BOTTOM_LEFT, 0, 0);
    lv_obj_set_style_bg_color(nav, lv_color_hex(Theme::MidWater), 0);
    lv_obj_set_style_bg_opa(nav, LV_OPA_COVER, 0);
    static const char* navNames[TAB_COUNT] = {"SESS", "CAM", "USAGE"};
    for (int i = 0; i < TAB_COUNT; i++) {
        s_navBtns[i] = makeButton(nav, 66, 34, Theme::DeepSea, navNames[i],
                                  &lv_font_montserrat_14, onNavClicked,
                                  (void*)(intptr_t)i);
        lv_obj_align(s_navBtns[i], LV_ALIGN_LEFT_MID, 5 + i * 72, 0);
    }

    // Toast overlay — small, top-centered, hidden until used.
    s_toast = lv_obj_create(s_scr);
    lv_obj_remove_style_all(s_toast);
    lv_obj_set_size(s_toast, POCKET_W - 24, 30);
    lv_obj_set_pos(s_toast, 12, STATUS_H + 6);
    lv_obj_set_style_bg_color(s_toast, lv_color_hex(Theme::StatusCyan), 0);
    lv_obj_set_style_bg_opa(s_toast, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(s_toast, 6, 0);
    lv_obj_add_flag(s_toast, LV_OBJ_FLAG_HIDDEN);
    s_toastText = makeLabel(s_toast, &font_kr_12, 0xFFFFFF, "");
    lv_obj_align(s_toastText, LV_ALIGN_CENTER, 0, 0);

    lv_screen_load(s_scr);
    s_lastSig[0] = '\0';
}

void nextTab() { s_tab = (uint8_t)((s_tab + 1) % TAB_COUNT); }
void prevTab() { s_tab = (uint8_t)((s_tab + TAB_COUNT - 1) % TAB_COUNT); }

void primaryAction() {
    // Phone grammar: BOOT takes you to the camera; on the camera it shoots.
    if (s_tab != TAB_CAM) {
        s_tab = TAB_CAM;
        return;
    }
    snapPhoto();
}

void onPhotoResult(bool delivered, const char* detail) {
    if (!s_scr) return;  // landscape unit — ticker owns feedback
    char note[48];
    if (delivered) snprintf(note, sizeof(note), "photo sent");
    else snprintf(note, sizeof(note), "photo failed%s%.20s",
                  detail && detail[0] ? ": " : "", detail ? detail : "");
    Utf8::utf8TrimEnd(note);
    toast(note);
}

void update(float dt) {
    (void)dt;
    uint32_t now = millis();

    // Camera power follows the CAM tab (and comes back after an upload).
    {
        static bool wasCam = false;
        static uint32_t lastReacquireMs = 0;
        bool isCam = (s_tab == TAB_CAM) && Camera::present();
        if (isCam && !wasCam) {
            if (!Camera::acquire()) toast("camera power failed");
        } else if (!isCam && wasCam) {
            Camera::release();
        } else if (isCam && !Camera::active() && !Net::photoUploadBusy() &&
                   (uint32_t)(now - lastReacquireMs) > 2000) {
            lastReacquireMs = now;
            Camera::acquire();
        }
        wasCam = isCam;
    }

    if (s_toastUntilMs && (int32_t)(s_toastUntilMs - now) <= 0) {
        s_toastUntilMs = 0;
        if (s_toast) lv_obj_add_flag(s_toast, LV_OBJ_FLAG_HIDDEN);
    }

    // Viewfinder frames stream outside the signature.
    if (s_tab == TAB_CAM && s_vfCanvas && s_vfBuf &&
        (uint32_t)(now - s_vfLastMs) >= VF_INTERVAL_MS) {
        s_vfLastMs = now;
        if (Camera::grabPreviewPortrait(s_vfBuf, VF_W, VF_H)) {
            lv_obj_invalidate(s_vfCanvas);
        }
    }

    bool wifiUp = Net::wifiConnected();
    bool wsUp = Net::wsConnected();

    // Signature: tab + session states + usage buckets + focus + link.
    char sig[360];
    {
        lockState();
        char sess[160] = {0};
        size_t off = 0;
        for (uint8_t i = 0; i < g_state.sessionCount && off < sizeof(sess) - 28; i++) {
            off += snprintf(sess + off, sizeof(sess) - off, "%.6s:%.8s:%.10s|",
                            g_state.sessions[i].state,
                            g_state.sessions[i].projectName,
                            g_state.sessions[i].lastEventText);
        }
        int c5 = (int)g_state.fiveHourPercent, c7 = (int)g_state.sevenDayPercent;
        int x5 = (int)g_state.codexPrimaryPercent, x7 = (int)g_state.codexSecondaryPercent;
        char focused[32];
        strncpy(focused, g_state.focusedSessionId, sizeof(focused) - 1);
        focused[sizeof(focused) - 1] = '\0';
        uint8_t count = g_state.sessionCount;
        bool connected = g_state.wsConnected;
        unlockState();
        snprintf(sig, sizeof(sig), "%d|%d|%d.%d.%d.%d|%d%d%d|%d|%.31s|%s",
                 s_tab, count, c5, c7, x5, x7,
                 connected ? 1 : 0, wifiUp ? 1 : 0, wsUp ? 1 : 0,
                 Camera::lampDuty() > 0 ? 1 : 0, focused, sess);
    }
    if (strcmp(sig, s_lastSig) == 0) return;
    strncpy(s_lastSig, sig, sizeof(s_lastSig) - 1);
    s_lastSig[sizeof(s_lastSig) - 1] = '\0';

    lv_obj_set_style_text_color(
        s_statusLink,
        lv_color_hex(wsUp ? Theme::StatusGreen
                          : (wifiUp ? Theme::StatusAmber : Theme::StatusRed)), 0);
    for (int i = 0; i < TAB_COUNT; i++) {
        lv_obj_set_style_bg_color(
            s_navBtns[i],
            lv_color_hex(i == s_tab ? Theme::StatusCyan : Theme::DeepSea), 0);
    }

    // Rebuild the active tab, preserving scroll position across data refreshes.
    int32_t scrollY = lv_obj_get_scroll_y(s_content);
    lv_obj_clean(s_content);
    s_vfCanvas = nullptr;
    s_camTarget = nullptr;
    if (s_tab == TAB_SESSIONS) renderSessionsTab();
    else if (s_tab == TAB_CAM) renderCamTab();
    else renderUsageTab();
    if (s_tab == TAB_SESSIONS && scrollY > 0) {
        lv_obj_scroll_to_y(s_content, scrollY, LV_ANIM_OFF);
    }
}

}  // namespace Pocket

#endif  // BOARD_T_DISPLAY_PRO
