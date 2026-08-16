#if defined(BOARD_T_EMBED)

#include "knob_ui.h"
#include "../../state/agent_state.h"
#include "../../net/ws_client.h"
#include "../../net/wifi_manager.h"
#include "../../net/serial_client.h"
#include "../../input/power_monitor.h"
#include "../display.h"
#include "../theme.h"
#include "../agent_label.h"
#include "../terrarium/creature_glyphs_generated.h"
#include "../../util/utf8.h"
#include "../../util/json.h"

#include <Arduino.h>
#include <lvgl.h>
#include <stdio.h>
#include <string.h>

// ── view model ──────────────────────────────────────────────────────────────

enum class Mode : uint8_t { LIST, DETAIL, SCRUB };

enum MenuKind : uint8_t {
    MI_OPTION,    // select_option(optIndex)
    MI_APPROVE,   // permission_decision allow (requestId) / select_option(0)
    MI_DENY,      // permission_decision deny (requestId) / escape
    MI_ESC,       // session escape
    MI_STOP,      // session interrupt
    MI_CONTINUE,  // send_prompt "go on"
    MI_HISTORY,   // query_session_timeline -> History scrub view
    MI_POWER,     // power the board off (no side key exists on this hardware)
    MI_MODE,      // session_command switch_mode (Shift+Tab cycle; managed only)
    MI_BACK,      // leave detail
};

struct MenuItem {
    char label[64];
    uint8_t kind;
    uint8_t optIndex;
    bool recommended;
};

static constexpr uint8_t MENU_MAX = SESSION_OPTIONS_CAP + 5;
static constexpr uint8_t MENU_VISIBLE = 3;

// Snapshot of the one session the UI is looking at (copied under lock).
struct SessionSnap {
    char id[32];
    char projectName[40];
    char agentType[16];
    char state[20];
    char currentTool[40];
    char question[160];
    char promptType[20];
    char requestId[40];
    char activity[80];
    char lastEventText[100];
    char permissionMode[20];
    uint32_t elapsedSec;
    uint16_t port;
};

static Mode s_mode = Mode::LIST;
static int s_listIdx = 0;
// Until the operator rotates (or the daemon broadcasts a focus), the carousel
// rests on a general-purpose assistant session (OpenClaw / Hermes) when one is
// live — that is also what push-to-talk targets, so an idle knob defaults its
// mic to conversation, not to whichever repo session happens to sort first.
static bool s_userNavigated = false;
static int s_menuIdx = 0;
static int s_menuScroll = 0;
static MenuItem s_menu[MENU_MAX];
static uint8_t s_menuCount = 0;
static char s_detailSessionId[32] = {0};  // session the detail view entered
static char s_lastSharedFocus[32] = {0};

// History scrub cursor: -1 = pin to latest entry once the backfill lands.
static int s_scrubIdx = -1;

// Set by the Power off menu item; the UI task performs the shutdown so the
// LVGL callback never blocks on hardware teardown.
static bool s_powerOffRequested = false;

// Non-empty while push-to-talk is capturing; holds the target session label.
static char s_listeningLabel[48] = {0};
static char s_speakingText[64] = {0};

// Transient "sent" flash — one-frame-cheap optimistic press feedback. Sized
// for voice_result transcripts (the longest text routed through notify), and
// held on screen long enough to actually read one.
static char s_flashText[96] = {0};
static uint32_t s_flashUntilMs = 0;

// ── widgets ─────────────────────────────────────────────────────────────────

static lv_obj_t* s_scr = nullptr;
static lv_obj_t* s_header = nullptr;
static lv_obj_t* s_headerLeft = nullptr;
static lv_obj_t* s_headerRight = nullptr;
static lv_obj_t* s_hdrWifi = nullptr;   // WiFi/WS link glyph
static lv_obj_t* s_hdrBatt = nullptr;   // battery % (+ charge bolt)
static lv_obj_t* s_body = nullptr;
static lv_obj_t* s_footer = nullptr;

static char s_lastSig[320] = {0};  // content signature — rebuild body on change

// Canonical agent creatures, kept as flash-backed A8 masks. LVGL recolors the
// masks at draw time, so the wheel carousel needs no runtime bitmap allocation.
static lv_image_dsc_t s_glyphClaude;
static lv_image_dsc_t s_glyphOpenClaw;
static lv_image_dsc_t s_glyphOpenCode;
static lv_image_dsc_t s_glyphCodex;
static lv_image_dsc_t s_glyphAntigravity;
static lv_image_dsc_t s_glyphKiro;

static void buildGlyph(lv_image_dsc_t& glyph, const uint8_t* data, int w, int h) {
    glyph.header.magic = LV_IMAGE_HEADER_MAGIC;
    glyph.header.cf = LV_COLOR_FORMAT_A8;
    glyph.header.flags = 0;
    glyph.header.w = w;
    glyph.header.h = h;
    glyph.header.stride = w;
    glyph.data_size = (uint32_t)(w * h);
    glyph.data = data;
}

static void initGlyphs() {
    using namespace CreatureGlyphs;
    buildGlyph(s_glyphClaude, OCTOPUS_A8, OCTOPUS_W, OCTOPUS_H);
    buildGlyph(s_glyphOpenClaw, OPENCLAW_MARK_A8, OPENCLAW_MARK_W, OPENCLAW_MARK_H);
    buildGlyph(s_glyphOpenCode, OPENCODE_A8, OPENCODE_W, OPENCODE_H);
    buildGlyph(s_glyphCodex, CODEX_A8, CODEX_W, CODEX_H);
    buildGlyph(s_glyphAntigravity, ANTIGRAVITY_A8, ANTIGRAVITY_W, ANTIGRAVITY_H);
    buildGlyph(s_glyphKiro, KIRO_A8, KIRO_W, KIRO_H);
}

static const lv_image_dsc_t* glyphForAgent(const char* agentType) {
    if (!agentType) return nullptr;
    if (strstr(agentType, "openclaw")) return &s_glyphOpenClaw;
    if (strstr(agentType, "opencode")) return &s_glyphOpenCode;
    if (strstr(agentType, "antigravity")) return &s_glyphAntigravity;
    if (strstr(agentType, "kiro")) return &s_glyphKiro;
    if (strstr(agentType, "codex")) return &s_glyphCodex;
    if (strstr(agentType, "claude")) return &s_glyphClaude;
    return nullptr;
}

// ── outbound commands (thread-safe queue; drained on the network core) ──────

// `question` NAMES the question this press answers, and the daemon's ask-gate
// requires it before it will commit an answer on the user's behalf: several
// surfaces map a hardware approve key to select_option(0) as a yes/no stand-in,
// which against a four-way question is a guess, not an answer. The knob's
// detail menu is built from the live option list, so it is the one ESP32
// surface that can say what it is answering — pass nullptr from the approve
// path so it stays on the refused side of that line.
//
// The text must be the RAW daemon string (see rawSessionQuestion): the display
// snapshot is sanitized in place for LVGL's font coverage, which rewrites
// punctuation and blanks non-Hangul CJK, and an echo of that matches nothing.
static void sendSelectOption(const char* sid, int index, const char* question) {
    char buf[Net::OUTBOUND_MAX_LEN];
    int n = snprintf(buf, sizeof(buf),
                     "{\"type\":\"select_option\",\"index\":%d,\"sessionId\":\"%s\"",
                     index, sid);
    if (n < 0 || (size_t)n >= sizeof(buf)) return;
    if (question && question[0]) {
        // A question longer than this device's 160-byte buffer (any CJK one —
        // the daemon caps at 120 CHARACTERS) already arrived truncated, and may
        // truncate again here. That is expected and safe: the daemon accepts a
        // device-truncated echo as a prefix (askEchoMatches, bridge/src/ask-gate.ts).
        strncat(buf, ",\"question\":\"", sizeof(buf) - strlen(buf) - 1);
        Json::escapeAppend(buf, sizeof(buf) - 2, question);  // -2 reserves `"}`
        strncat(buf, "\"", sizeof(buf) - strlen(buf) - 1);
    }
    strncat(buf, "}", sizeof(buf) - strlen(buf) - 1);
    Net::queueOutbound(buf);
}

static void sendPermissionDecision(const char* requestId, bool allow) {
    char buf[160];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"permission_decision\",\"requestId\":\"%s\",\"decision\":\"%s\"}",
             requestId, allow ? "allow" : "deny");
    Net::queueOutbound(buf);
}

static void sendSessionCommand(const char* sid, const char* cmdType) {
    char buf[160];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"session_command\",\"sessionId\":\"%s\",\"command\":{\"type\":\"%s\"}}",
             sid, cmdType);
    Net::queueOutbound(buf);
}

static void sendGoOn(const char* sid) {
    char buf[176];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"session_command\",\"sessionId\":\"%s\","
             "\"command\":{\"type\":\"send_prompt\",\"text\":\"go on\"}}",
             sid);
    Net::queueOutbound(buf);
}

static void sendHistoryQuery(const char* sid) {
    char buf[112];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"query_session_timeline\",\"sessionId\":\"%s\"}", sid);
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
    // The copy may have cut a UTF-8 sequence mid-byte — a torn Korean
    // transcript must degrade to a clean end, not a garbage glyph.
    Utf8::utf8TrimEnd(s_flashText);
    s_flashUntilMs = millis() + 2200;
}

// ── snapshot helpers ────────────────────────────────────────────────────────

static bool snapshotSession(int idx, SessionSnap& out) {
    bool ok = false;
    lockState();
    if (idx >= 0 && idx < g_state.sessionCount) {
        const SessionInfo& s = g_state.sessions[idx];
        strncpy(out.id, s.id, sizeof(out.id));
        strncpy(out.projectName, s.projectName, sizeof(out.projectName));
        strncpy(out.agentType, s.agentType, sizeof(out.agentType));
        strncpy(out.state, s.state, sizeof(out.state));
        strncpy(out.currentTool, s.currentTool, sizeof(out.currentTool));
        strncpy(out.question, s.question, sizeof(out.question));
        strncpy(out.promptType, s.promptType, sizeof(out.promptType));
        strncpy(out.requestId, s.requestId, sizeof(out.requestId));
        strncpy(out.activity, s.activity, sizeof(out.activity));
        strncpy(out.lastEventText, s.lastEventText, sizeof(out.lastEventText));
        strncpy(out.permissionMode, s.permissionMode, sizeof(out.permissionMode));
        out.elapsedSec = s.elapsedSec;
        out.port = s.port;
        ok = true;
    }
    unlockState();
    if (ok) {
        // Daemon text can carry punctuation outside Montserrat + the Hangul-only
        // Noto KR fallback (U+00B7 " · " above all) — sanitize once at snapshot
        // time so no render path ever draws a tofu box.
        Utf8::sanitizeLvglText(out.projectName);
        Utf8::sanitizeLvglText(out.question);
        Utf8::sanitizeLvglText(out.currentTool);
        Utf8::sanitizeLvglText(out.activity);
        Utf8::sanitizeLvglText(out.lastEventText);
    }
    return ok;
}

static int findSessionById(const char* sid) {
    int found = -1;
    lockState();
    for (uint8_t i = 0; i < g_state.sessionCount; i++) {
        if (strcmp(g_state.sessions[i].id, sid) == 0) { found = i; break; }
    }
    unlockState();
    return found;
}

// The question exactly as the daemon sent it — NOT SessionSnap.question, which
// snapshotSession() has already run through sanitizeLvglText() so no render
// path draws a tofu box. That rewrite is right for the screen and wrong for the
// wire: it maps · … " → to ASCII and blanks every non-Hangul CJK character, so
// an echo built from it names a question the daemon never asked.
static void rawSessionQuestion(const char* sid, char* out, size_t cap) {
    if (!out || cap == 0) return;
    out[0] = '\0';
    lockState();
    for (uint8_t i = 0; i < g_state.sessionCount; i++) {
        if (strcmp(g_state.sessions[i].id, sid) == 0) {
            strncpy(out, g_state.sessions[i].question, cap - 1);
            out[cap - 1] = '\0';
            break;
        }
    }
    unlockState();
}

static uint32_t agentColor(const char* agentType) {
    if (strcmp(agentType, "claude-code") == 0) return Theme::ClaudeBody;
    if (strncmp(agentType, "codex", 5) == 0) return Theme::CloudBody;
    if (strcmp(agentType, "openclaw") == 0) return Theme::CrayfishShell;
    if (strcmp(agentType, "opencode") == 0) return Theme::OpenCodeOuter;
    if (strcmp(agentType, "antigravity") == 0) return Theme::AntigravityMark;
    if (strncmp(agentType, "kiro", 4) == 0) return Theme::KiroMark;
    return Theme::HUDDim;
}

static uint32_t stateColorOf(const char* state) {
    if (strstr(state, "awaiting") != nullptr) return Theme::StatusAmber;
    if (strcmp(state, "processing") == 0) return Theme::StatusBlue;
    if (strcmp(state, "idle") == 0) return Theme::StatusGreen;
    return Theme::HUDDim;
}

static const char* statePhrase(const char* state) {
    if (strcmp(state, "processing") == 0) return "working";
    if (strcmp(state, "awaiting_permission") == 0) return "awaiting approval";
    if (strcmp(state, "awaiting_option") == 0) return "choosing";
    if (strcmp(state, "awaiting_diff") == 0) return "reviewing diff";
    if (strcmp(state, "idle") == 0) return "idle";
    return state[0] ? state : "-";
}

static void fmtElapsed(uint32_t sec, char* out, size_t n) {
    if (sec == 0) { out[0] = '\0'; return; }
    if (sec < 3600) snprintf(out, n, "%lum", (unsigned long)(sec / 60));
    else snprintf(out, n, "%luh%02lum", (unsigned long)(sec / 3600),
                  (unsigned long)((sec % 3600) / 60));
}

// ── menu construction ───────────────────────────────────────────────────────

static void addMenuItem(const char* label, uint8_t kind, uint8_t optIndex,
                        bool recommended) {
    if (s_menuCount >= MENU_MAX) return;
    MenuItem& m = s_menu[s_menuCount++];
    strncpy(m.label, label, sizeof(m.label) - 1);
    m.label[sizeof(m.label) - 1] = '\0';
    m.kind = kind;
    m.optIndex = optIndex;
    m.recommended = recommended;
}

// Build the state-dependent command menu for the entered session. Mirrors the
// Stream Deck detail-level grammar: awaiting = real options, processing = STOP,
// idle = GO ON; BACK is always last.
static void buildMenu(const SessionSnap& s) {
    s_menuCount = 0;
    bool awaiting = strstr(s.state, "awaiting") != nullptr;

    if (awaiting) {
        uint8_t optCount = 0;
        SessionOption opts[SESSION_OPTIONS_CAP];
        lockState();
        int idx = -1;
        for (uint8_t i = 0; i < g_state.sessionCount; i++)
            if (strcmp(g_state.sessions[i].id, s.id) == 0) { idx = i; break; }
        if (idx >= 0) {
            optCount = g_state.sessions[idx].optionCount;
            memcpy(opts, g_state.sessions[idx].options, sizeof(opts));
        }
        unlockState();

        if (optCount > 0) {
            for (uint8_t i = 0; i < optCount; i++) {
                Utf8::sanitizeLvglText(opts[i].label);
                addMenuItem(opts[i].label, MI_OPTION, opts[i].index,
                            opts[i].recommended);
            }
        } else {
            // No parsed options (plain permission gate) — Approve/Deny pair.
            addMenuItem("Approve", MI_APPROVE, 0, true);
            addMenuItem("Deny", MI_DENY, 0, false);
        }
        addMenuItem("Esc (cancel prompt)", MI_ESC, 0, false);
    } else if (strcmp(s.state, "processing") == 0) {
        addMenuItem("STOP (interrupt)", MI_STOP, 0, false);
    } else if (strncmp(s.id, "observed:", 9) != 0) {
        // "Go on" types into the managed PTY. An observed session's terminal
        // cannot be typed into, and its idle directive queue only drains at a
        // turn end that never comes — so the item is honest only for managed
        // sessions. (Observed processing sessions still get STOP: the soft-stop
        // ladder is real.)
        addMenuItem("Go on", MI_CONTINUE, 0, false);
    }
    addMenuItem("History", MI_HISTORY, 0, false);
    // INTENT step 1: cycle the agent's permission mode (Shift+Tab). Managed
    // PTY sessions only — observed terminals can't be typed into, and the
    // gateway has no mode.
    if (s.port > 0 && strcmp(s.agentType, "openclaw") != 0) {
        // INTENT dial: labeled once the roster carries the current mode.
        char modeLabel[48];
        if (s.permissionMode[0])
            snprintf(modeLabel, sizeof(modeLabel), "Mode: %s", s.permissionMode);
        else
            snprintf(modeLabel, sizeof(modeLabel), "Mode (Shift+Tab)");
        addMenuItem(modeLabel, MI_MODE, 0, false);
    }
    addMenuItem("Power off", MI_POWER, 0, false);
    addMenuItem("Back", MI_BACK, 0, false);

    if (s_menuIdx >= s_menuCount) s_menuIdx = s_menuCount - 1;
    if (s_menuIdx < 0) s_menuIdx = 0;
}

static void executeMenuItem(const SessionSnap& s, const MenuItem& m) {
    switch (m.kind) {
        case MI_OPTION: {
            // This item came from the live option list, so the press can name
            // the question it answers — which is what lets a held ask-gate
            // accept it instead of refusing an unattributed index.
            char q[sizeof(SessionSnap::question)];
            rawSessionQuestion(s.id, q, sizeof(q));
            sendSelectOption(s.id, m.optIndex, q);
            flash("sent: option");
            s_mode = Mode::LIST;
            break;
        }
        case MI_APPROVE:
            // Observed gate carries a requestId → resolve it; managed PTY
            // session drives the live prompt (same fallback as the IPS10
            // mosaic: select_option(0) is the affirmative). No question echo:
            // this item exists only when the session parsed NO options, so
            // "option 0" here is a yes/no stand-in, not a chosen answer — a
            // held ask-gate must keep refusing it.
            if (s.requestId[0]) sendPermissionDecision(s.requestId, true);
            else sendSelectOption(s.id, 0, nullptr);
            flash("sent: approve");
            s_mode = Mode::LIST;
            break;
        case MI_DENY:
            if (s.requestId[0]) sendPermissionDecision(s.requestId, false);
            else sendSessionCommand(s.id, "escape");
            flash("sent: deny");
            s_mode = Mode::LIST;
            break;
        case MI_ESC:
            sendSessionCommand(s.id, "escape");
            flash("sent: esc");
            s_mode = Mode::LIST;
            break;
        case MI_STOP:
            sendSessionCommand(s.id, "interrupt");
            flash("sent: stop");
            s_mode = Mode::LIST;
            break;
        case MI_CONTINUE:
            sendGoOn(s.id);
            flash("sent: go on");
            s_mode = Mode::LIST;
            break;
        case MI_HISTORY:
            lockState();
            g_state.scrubCount = 0;
            strncpy(g_state.scrubSessionId, s.id, sizeof(g_state.scrubSessionId) - 1);
            g_state.scrubSessionId[sizeof(g_state.scrubSessionId) - 1] = '\0';
            unlockState();
            sendHistoryQuery(s.id);
            s_scrubIdx = -1;
            s_mode = Mode::SCRUB;
            break;
        case MI_MODE:
            // Blind cycle for now — the roster doesn't carry the current mode
            // yet; when it does, this becomes a labeled INTENT dial.
            sendSessionCommand(s.id, "switch_mode");
            flash("sent: mode cycle");
            break;  // stay in DETAIL so repeated cycling is one press each
        case MI_POWER:
            s_powerOffRequested = true;
            flash("powering off");
            break;
        case MI_BACK:
        default:
            s_mode = Mode::LIST;
            break;
    }
}

// ── rendering ───────────────────────────────────────────────────────────────

static lv_obj_t* makeLabel(lv_obj_t* parent, const lv_font_t* font,
                           uint32_t color, const char* text) {
    lv_obj_t* l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_label_set_text(l, text);
    return l;
}

// One-shot slide for the wheel carousel: on a detent the incoming creature
// eases in from the side the rotation pulled it from, so the physical click
// and the on-screen motion agree. Interaction feedback only — status colors
// stay static per the design rules (amber awaiting is the only pulse).
static void animTranslateX(void* var, int32_t v) {
    lv_obj_set_style_translate_x((lv_obj_t*)var, v, 0);
}

static void startCarouselSlide(lv_obj_t* obj, int dir) {
    if (dir == 0) return;
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, obj);
    lv_anim_set_values(&a, dir * 36, 0);
    lv_anim_set_duration(&a, 140);
    lv_anim_set_exec_cb(&a, animTranslateX);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
    lv_anim_start(&a);
}

// Direction of the latest carousel move: +1 = CW (next slid in from the
// right), -1 = CCW, 0 = not a rotation (data refresh, mode return).
static int carouselSlideDir(int idx, uint8_t count) {
    static int lastIdx = -1;
    static uint8_t lastCount = 0;
    int dir = 0;
    if (lastIdx >= 0 && lastCount == count && count > 1 && idx != lastIdx) {
        int fwd = (idx - lastIdx + (int)count) % (int)count;
        dir = (fwd == 1) ? 1 : ((fwd == (int)count - 1) ? -1 : 0);
    }
    lastIdx = idx;
    lastCount = count;
    return dir;
}

static void renderListBody(bool connected, uint8_t sessionCount) {
    if (!connected) {
        bool wifiUp = Net::wifiConnected();
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_14, Theme::HUDDim,
                                wifiUp ? "Searching for AgentDeck..."
                                       : "No WiFi — provision over USB");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, -10);
        char netline[64];
        if (wifiUp) snprintf(netline, sizeof(netline), "WiFi ok " LV_SYMBOL_BULLET " %s", Net::wifiLocalIP());
        else snprintf(netline, sizeof(netline), "agentdeck wifi-setup");
        lv_obj_t* n = makeLabel(s_body, &lv_font_montserrat_12, Theme::HUDFaint, netline);
        lv_obj_align(n, LV_ALIGN_CENTER, 0, 14);
        return;
    }
    if (sessionCount == 0) {
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_14, Theme::HUDDim,
                                "No active sessions");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }

    SessionSnap s;
    if (!snapshotSession(s_listIdx, s)) return;
    int slideDir = carouselSlideDir(s_listIdx, sessionCount);

    // The encoder is a physical carousel: the selected agent creature owns the
    // center, while the previous/next creatures peek in from either side. A
    // detent now has an immediate visual identity change instead of merely
    // replacing several similar text rows.
    auto addCreature = [&](int idx, int x, int y, int scale, uint8_t opa) {
        SessionSnap peer;
        if (!snapshotSession(idx, peer)) return;
        const lv_image_dsc_t* glyph = glyphForAgent(peer.agentType);
        if (!glyph) return;
        lv_obj_t* image = lv_image_create(s_body);
        lv_image_set_src(image, glyph);
        lv_image_set_scale(image, scale);
        lv_obj_set_style_image_recolor(image, lv_color_hex(agentColor(peer.agentType)), 0);
        lv_obj_set_style_image_recolor_opa(image, LV_OPA_COVER, 0);
        lv_obj_set_style_opa(image, opa, 0);
        lv_obj_set_pos(image, x, y);
    };
    if (sessionCount > 1) {
        int prev = (s_listIdx + sessionCount - 1) % sessionCount;
        int next = (s_listIdx + 1) % sessionCount;
        addCreature(prev, 24, 8, 150, LV_OPA_40);
        addCreature(next, 232, 8, 150, LV_OPA_40);
    }

    lv_obj_t* halo = lv_obj_create(s_body);
    lv_obj_remove_style_all(halo);
    lv_obj_set_size(halo, 78, 70);
    lv_obj_set_style_bg_color(halo, lv_color_hex(Theme::MidWater), 0);
    lv_obj_set_style_bg_opa(halo, LV_OPA_50, 0);
    lv_obj_set_style_border_color(halo, lv_color_hex(stateColorOf(s.state)), 0);
    lv_obj_set_style_border_width(halo, strstr(s.state, "awaiting") ? 3 : 1, 0);
    lv_obj_set_style_radius(halo, 35, 0);
    lv_obj_align(halo, LV_ALIGN_TOP_MID, 0, 0);

    const lv_image_dsc_t* selectedGlyph = glyphForAgent(s.agentType);
    if (selectedGlyph) {
        lv_obj_t* image = lv_image_create(s_body);
        lv_image_set_src(image, selectedGlyph);
        lv_obj_set_style_image_recolor(image, lv_color_hex(agentColor(s.agentType)), 0);
        lv_obj_set_style_image_recolor_opa(image, LV_OPA_COVER, 0);
        lv_obj_align(image, LV_ALIGN_TOP_MID, 0, 3);
        startCarouselSlide(image, slideDir);
    } else {
        lv_obj_t* brand = makeLabel(s_body, &lv_font_montserrat_18,
                                    agentColor(s.agentType), agentShortLabel(s.agentType));
        lv_obj_align(brand, LV_ALIGN_TOP_MID, 0, 24);
        startCarouselSlide(brand, slideDir);
    }

    char elapsed[12];
    fmtElapsed(s.elapsedSec, elapsed, sizeof(elapsed));
    char stateLine[64];
    snprintf(stateLine, sizeof(stateLine), "%s  %s%s%s", agentShortLabel(s.agentType),
             statePhrase(s.state),
             elapsed[0] ? " " LV_SYMBOL_BULLET " " : "", elapsed);
    lv_obj_t* st = makeLabel(s_body, &lv_font_montserrat_12,
                             stateColorOf(s.state), stateLine);
    lv_obj_align(st, LV_ALIGN_TOP_MID, 0, 68);

    lv_obj_t* proj = makeLabel(s_body, &font_kr_16, Theme::HUDText,
                               s.projectName[0] ? s.projectName : "(no project)");
    lv_obj_set_width(proj, 304);
    lv_obj_set_style_text_align(proj, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(proj, LV_LABEL_LONG_DOT);
    lv_obj_align(proj, LV_ALIGN_TOP_MID, 0, 84);

    // Context line: awaiting question > live tool > activity > last milestone.
    const char* ctx = "";
    if (strstr(s.state, "awaiting") && s.question[0]) ctx = s.question;
    else if (s.currentTool[0]) ctx = s.currentTool;
    else if (s.activity[0]) ctx = s.activity;
    else if (s.lastEventText[0]) ctx = s.lastEventText;
    lv_obj_t* ctxl = makeLabel(s_body, &font_kr_16, Theme::HUDText, ctx);
    lv_obj_set_width(ctxl, 304);
    lv_obj_set_style_text_align(ctxl, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(ctxl, LV_LABEL_LONG_DOT);
    lv_obj_set_height(ctxl, 20);
    lv_obj_align(ctxl, LV_ALIGN_TOP_MID, 0, 105);

    // Awaiting badge: make "needs you" unmissable even on the context line.
    if (strstr(s.state, "awaiting") != nullptr) {
        lv_obj_t* bar = lv_obj_create(s_body);
        lv_obj_remove_style_all(bar);
        lv_obj_set_size(bar, 4, 126);
        lv_obj_set_style_bg_color(bar, lv_color_hex(Theme::StatusAmber), 0);
        lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
        lv_obj_align(bar, LV_ALIGN_TOP_LEFT, 0, 0);
    }
}

static void renderDetailBody(const SessionSnap& s) {
    // Question / context header (top ~44px)
    const char* head = "";
    if (strstr(s.state, "awaiting") && s.question[0]) head = s.question;
    else if (strcmp(s.state, "processing") == 0 && s.currentTool[0]) head = s.currentTool;
    else if (s.activity[0]) head = s.activity;
    // DOT, not WRAP: a fixed-height wrapped label clips the overflow line
    // mid-glyph; the ellipsis says "there is more" instead of shearing it.
    lv_obj_t* q = makeLabel(s_body, &font_kr_16, Theme::HUDText, head);
    lv_obj_set_width(q, 262);
    lv_label_set_long_mode(q, LV_LABEL_LONG_DOT);
    lv_obj_set_height(q, 36);
    lv_obj_align(q, LV_ALIGN_TOP_LEFT, 8, 2);

    // Three roomy rows are more legible than the former four 12px rows. The
    // encoder makes the hidden remainder cheap to reach.
    if (s_menuIdx < s_menuScroll) s_menuScroll = s_menuIdx;
    if (s_menuIdx >= s_menuScroll + MENU_VISIBLE)
        s_menuScroll = s_menuIdx - MENU_VISIBLE + 1;

    for (uint8_t row = 0; row < MENU_VISIBLE; row++) {
        int i = s_menuScroll + row;
        if (i >= s_menuCount) break;
        const MenuItem& m = s_menu[i];
        bool cur = (i == s_menuIdx);

        lv_obj_t* rowObj = lv_obj_create(s_body);
        lv_obj_remove_style_all(rowObj);
        lv_obj_set_size(rowObj, 312, 25);
        lv_obj_align(rowObj, LV_ALIGN_TOP_LEFT, 4, 40 + row * 27);
        if (cur) {
            lv_obj_set_style_bg_color(rowObj, lv_color_hex(Theme::ShallowWater), 0);
            lv_obj_set_style_bg_opa(rowObj, LV_OPA_COVER, 0);
            lv_obj_set_style_radius(rowObj, 3, 0);
        }

        char text[80];
        snprintf(text, sizeof(text), "%s%s%s", cur ? "> " : "  ", m.label,
                 m.recommended ? " *" : "");
        lv_obj_t* l = makeLabel(rowObj, &font_kr_16,
                                cur ? Theme::HUDText : Theme::HUDDim, text);
        lv_label_set_long_mode(l, LV_LABEL_LONG_DOT);
        lv_obj_set_width(l, 300);
        lv_obj_align(l, LV_ALIGN_LEFT_MID, 4, 0);
    }

    // Scroll hint
    if (s_menuCount > MENU_VISIBLE) {
        char pos[16];
        snprintf(pos, sizeof(pos), "%d/%d", s_menuIdx + 1, s_menuCount);
        lv_obj_t* p = makeLabel(s_body, &lv_font_montserrat_12, Theme::HUDFaint, pos);
        lv_obj_align(p, LV_ALIGN_TOP_RIGHT, -6, 3);
    }
}

static void renderScrubBody() {
    lockState();
    int scount = g_state.scrubCount;
    ScrubEntry cur;
    bool have = false;
    int idx = s_scrubIdx < 0 ? scount - 1 : s_scrubIdx;
    if (idx >= 0 && idx < scount) {
        cur = g_state.scrub[idx];
        have = true;
    }
    unlockState();

    if (!have) {
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_14, Theme::HUDDim,
                                "Loading history...");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }

    Utf8::sanitizeLvglText(cur.text);

    char head[48];
    snprintf(head, sizeof(head), "%d/%d  %s  %s", idx + 1, scount,
             cur.hm[0] ? cur.hm : "--:--", cur.type);
    lv_obj_t* h = makeLabel(s_body, &lv_font_montserrat_12, Theme::HUDFaint, head);
    lv_obj_align(h, LV_ALIGN_TOP_LEFT, 8, 2);

    lv_obj_t* t = makeLabel(s_body, &font_kr_16, Theme::HUDText, cur.text);
    lv_obj_set_width(t, 304);
    lv_label_set_long_mode(t, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_line_space(t, 3, 0);
    lv_obj_set_height(t, 100);
    lv_obj_align(t, LV_ALIGN_TOP_LEFT, 8, 20);
}

// ── public API ──────────────────────────────────────────────────────────────

namespace Knob {

void create() {
    initGlyphs();
    s_scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(s_scr, lv_color_hex(Theme::DeepSea), 0);
    lv_obj_set_style_bg_opa(s_scr, LV_OPA_COVER, 0);

    s_header = lv_obj_create(s_scr);
    lv_obj_remove_style_all(s_header);
    lv_obj_set_size(s_header, 320, 22);
    lv_obj_set_style_bg_color(s_header, lv_color_hex(Theme::MidWater), 0);
    lv_obj_set_style_bg_opa(s_header, LV_OPA_COVER, 0);
    lv_obj_align(s_header, LV_ALIGN_TOP_LEFT, 0, 0);

    s_headerLeft = makeLabel(s_header, &lv_font_montserrat_12, Theme::HUDText, "AGENTDECK");
    lv_obj_set_width(s_headerLeft, 156);
    lv_label_set_long_mode(s_headerLeft, LV_LABEL_LONG_DOT);
    lv_obj_align(s_headerLeft, LV_ALIGN_LEFT_MID, 8, 0);
    s_headerRight = makeLabel(s_header, &lv_font_montserrat_12, Theme::HUDDim, "");
    lv_obj_align(s_headerRight, LV_ALIGN_RIGHT_MID, -8, 0);
    s_hdrBatt = makeLabel(s_header, &lv_font_montserrat_12, Theme::HUDDim, "");
    lv_obj_align(s_hdrBatt, LV_ALIGN_RIGHT_MID, -44, 0);
    s_hdrWifi = makeLabel(s_header, &lv_font_montserrat_12, Theme::HUDDim, LV_SYMBOL_WIFI);
    lv_obj_align(s_hdrWifi, LV_ALIGN_RIGHT_MID, -100, 0);

    s_body = lv_obj_create(s_scr);
    lv_obj_remove_style_all(s_body);
    lv_obj_set_size(s_body, 320, 126);
    lv_obj_align(s_body, LV_ALIGN_TOP_LEFT, 0, 22);

    // Korean-capable face: voice transcripts render here, and montserrat alone
    // drew them as tofu boxes.
    s_footer = makeLabel(s_scr, &font_kr_12, Theme::HUDFaint, "");
    lv_obj_align(s_footer, LV_ALIGN_BOTTOM_LEFT, 8, -3);

    lv_screen_load(s_scr);
    s_lastSig[0] = '\0';
}

void notify(const char* text) {
    flash(text);
}

void onRotate(int detents) {
    if (detents == 0) return;
    lockState();
    uint8_t count = g_state.sessionCount;
    unlockState();

    if (s_mode == Mode::SCRUB) {
        lockState();
        int scount = g_state.scrubCount;
        unlockState();
        if (scount == 0) return;
        if (s_scrubIdx < 0) s_scrubIdx = scount - 1;
        s_scrubIdx += detents;  // CW = newer
        if (s_scrubIdx < 0) s_scrubIdx = 0;
        if (s_scrubIdx >= scount) s_scrubIdx = scount - 1;
        return;
    }
    if (s_mode == Mode::LIST) {
        if (count == 0) return;
        s_userNavigated = true;   // an explicit pick — stop auto-defaulting
        s_listIdx = (s_listIdx + detents) % (int)count;
        if (s_listIdx < 0) s_listIdx += count;
    } else {
        if (s_menuCount == 0) return;
        s_menuIdx += detents;
        if (s_menuIdx < 0) s_menuIdx = 0;
        if (s_menuIdx >= s_menuCount) s_menuIdx = s_menuCount - 1;
    }
}

void onKey(Input::KeyEvent evt) {
    if (evt == Input::KeyEvent::NONE) return;

    if (evt == Input::KeyEvent::LONG_PRESS) {
        // Back one level: SCRUB -> DETAIL -> LIST.
        s_mode = (s_mode == Mode::SCRUB) ? Mode::DETAIL : Mode::LIST;
        return;
    }

    // SHORT_PRESS
    if (s_mode == Mode::SCRUB) {
        s_mode = Mode::DETAIL;
        return;
    }
    if (s_mode == Mode::LIST) {
        SessionSnap s;
        if (!snapshotSession(s_listIdx, s)) return;
        strncpy(s_detailSessionId, s.id, sizeof(s_detailSessionId) - 1);
        s_detailSessionId[sizeof(s_detailSessionId) - 1] = '\0';
        // This was specified by the product grammar but never sent. Publishing
        // it lets the Focus Strip and every other surface follow the knob.
        sendFocusSession(s.id);
        strncpy(s_lastSharedFocus, s.id, sizeof(s_lastSharedFocus) - 1);
        s_lastSharedFocus[sizeof(s_lastSharedFocus) - 1] = '\0';
        s_menuIdx = 0;
        s_menuScroll = 0;
        buildMenu(s);
        s_mode = Mode::DETAIL;
    } else {
        SessionSnap s;
        int idx = findSessionById(s_detailSessionId);
        if (idx < 0 || !snapshotSession(idx, s)) {
            s_mode = Mode::LIST;  // session went away under us
            return;
        }
        if (s_menuIdx < s_menuCount) executeMenuItem(s, s_menu[s_menuIdx]);
    }
}

const char* focusedSessionLabel() {
    static char label[48];
    label[0] = '\0';
    int idx = (s_mode == Mode::DETAIL || s_mode == Mode::SCRUB)
        ? findSessionById(s_detailSessionId) : s_listIdx;
    SessionSnap s;
    if (idx >= 0 && snapshotSession(idx, s)) {
        snprintf(label, sizeof(label), "%s · %s",
                 s.projectName[0] ? s.projectName : "(no project)",
                 agentShortLabel(s.agentType));
    }
    return label;
}

void setListening(const char* targetLabel) {
    // Never store an empty label: an empty one reads as "not listening" and the
    // banner disappears, which is exactly how a working capture looked like a
    // dead button when no session was on screen.
    const char* label = (targetLabel && targetLabel[0]) ? targetLabel : "(no session)";
    strncpy(s_listeningLabel, label, sizeof(s_listeningLabel) - 1);
    s_listeningLabel[sizeof(s_listeningLabel) - 1] = '\0';
    Utf8::sanitizeLvglText(s_listeningLabel);
}

void clearListening() {
    s_listeningLabel[0] = '\0';
}

void setSpeaking(const char* text) {
    const char* t = (text && text[0]) ? text : "(reply)";
    strncpy(s_speakingText, t, sizeof(s_speakingText) - 1);
    s_speakingText[sizeof(s_speakingText) - 1] = '\0';
    Utf8::sanitizeLvglText(s_speakingText);
}

void clearSpeaking() {
    s_speakingText[0] = '\0';
}

bool atListLevel() {
    return s_mode == Mode::LIST;
}

bool consumePowerOffRequest() {
    bool v = s_powerOffRequested;
    s_powerOffRequested = false;
    return v;
}

const char* focusedSessionId() {
    static char sid[32];
    sid[0] = '\0';
    if (s_mode == Mode::DETAIL || s_mode == Mode::SCRUB) {
        strncpy(sid, s_detailSessionId, sizeof(sid) - 1);
        sid[sizeof(sid) - 1] = '\0';
        return sid;
    }
    SessionSnap s;
    if (snapshotSession(s_listIdx, s)) {
        strncpy(sid, s.id, sizeof(sid) - 1);
        sid[sizeof(sid) - 1] = '\0';
    }
    return sid;
}

int selectedSessionIdx() {
    lockState();
    uint8_t count = g_state.sessionCount;
    unlockState();
    if (count == 0) return -1;
    if (s_mode == Mode::DETAIL || s_mode == Mode::SCRUB) {
        int idx = findSessionById(s_detailSessionId);
        return idx >= 0 ? idx : -1;
    }
    return s_listIdx < count ? s_listIdx : -1;
}

void update(float dt) {
    (void)dt;
    uint32_t now = millis();

    lockState();
    bool connected = g_state.wsConnected;
    uint8_t count = g_state.sessionCount;
    char sharedFocus[32];
    strncpy(sharedFocus, g_state.focusedSessionId, sizeof(sharedFocus) - 1);
    sharedFocus[sizeof(sharedFocus) - 1] = '\0';
    unlockState();

    if (count > 0 && s_listIdx >= count) s_listIdx = count - 1;
    // Follow a newly broadcast focus once at list level. Comparing the last
    // broadcast value (rather than every frame) means local encoder rotation is
    // never fought by a stale daemon focus.
    if (s_mode == Mode::LIST) {
        if (!sharedFocus[0]) {
            // Remember a real clear so focusing the same session again later is
            // still a new broadcast and recenters the carousel.
            s_lastSharedFocus[0] = '\0';
        } else if (strcmp(sharedFocus, s_lastSharedFocus) != 0) {
            int focusedIdx = findSessionById(sharedFocus);
            if (focusedIdx >= 0) {
                s_listIdx = focusedIdx;
                s_userNavigated = true;   // explicit focus — stop auto-defaulting
            }
            strncpy(s_lastSharedFocus, sharedFocus, sizeof(s_lastSharedFocus) - 1);
            s_lastSharedFocus[sizeof(s_lastSharedFocus) - 1] = '\0';
        }
        // No pick yet from either the encoder or a daemon focus: rest the
        // carousel on a general assistant session when one is live, so the
        // default mic target is conversation (see s_userNavigated).
        if (!s_userNavigated && count > 0) {
            lockState();
            for (uint8_t i = 0; i < g_state.sessionCount; i++) {
                const SessionInfo& si = g_state.sessions[i];
                if (!si.alive || !si.id[0]) continue;
                if (isGeneralAssistantSession(si.agentType, si.projectName)) {
                    s_listIdx = i;
                    break;
                }
            }
            unlockState();
        }
    }

    // Detail mode follows its session; if the session or its state changed,
    // rebuild the menu (an answered prompt must not leave stale options up).
    SessionSnap detail;
    bool haveDetail = false;
    if (s_mode == Mode::DETAIL || s_mode == Mode::SCRUB) {
        int idx = findSessionById(s_detailSessionId);
        if (idx < 0 || !snapshotSession(idx, detail)) {
            s_mode = Mode::LIST;
        } else {
            haveDetail = true;
        }
    }

    bool flashOn = s_flashText[0] && (int32_t)(s_flashUntilMs - now) > 0;
    if (!flashOn) s_flashText[0] = '\0';
    bool listening = s_listeningLabel[0] != '\0';
    bool speaking = s_speakingText[0] != '\0';

    // Status cluster inputs (battery, radio link) — part of the signature so
    // the header refreshes exactly when they change.
    Input::PowerStatus pw = Input::powerStatus();
    bool wifiUp = Net::wifiConnected();
    bool wsUp = Net::wsConnected();
    bool serialUp = Net::serialConnected();
    int battBucket = pw.valid ? (pw.soc / 5) : -1;

    // Content signature — cheap change detection; rebuild the body only when
    // something the user can see actually changed.
    char sig[320];
    if (s_mode == Mode::SCRUB && haveDetail) {
        int scount, idx;
        char curHead[24] = {0};
        lockState();
        scount = g_state.scrubCount;
        idx = s_scrubIdx < 0 ? scount - 1 : s_scrubIdx;
        if (idx >= 0 && idx < scount) strncpy(curHead, g_state.scrub[idx].text, sizeof(curHead) - 1);
        unlockState();
        snprintf(sig, sizeof(sig), "S|%s|%d|%d|%.20s|%d%d%d%d",
                 detail.id, idx, scount, curHead,
                 battBucket, pw.charging ? 1 : 0, wifiUp ? 1 : 0, wsUp ? 1 : 0);
    } else if (s_mode == Mode::DETAIL && haveDetail) {
        buildMenu(detail);
        snprintf(sig, sizeof(sig), "D|%s|%s|%d|%d|%d|%.40s|%d|%s|%d%d%d%d",
                 detail.id, detail.state, s_menuIdx, s_menuScroll, s_menuCount,
                 detail.question, connected ? 1 : 0, s_flashText,
                 battBucket, pw.charging ? 1 : 0, wifiUp ? 1 : 0, wsUp ? 1 : 0);
    } else {
        SessionSnap s;
        bool have = snapshotSession(s_listIdx, s);
        snprintf(sig, sizeof(sig), "L|%d|%d|%s|%s|%.24s|%.40s|%lu|%d|%s|%d%d%d%d",
                 s_listIdx, count, have ? s.id : "", have ? s.state : "",
                 have ? s.currentTool : "", have ? s.activity : "",
                 have ? (unsigned long)(s.elapsedSec / 60) : 0,
                 connected ? 1 : 0, s_flashText,
                 battBucket, pw.charging ? 1 : 0, wifiUp ? 1 : 0, wsUp ? 1 : 0);
    }
    // Listening banner is part of the signature so it appears the instant the
    // hold starts and disappears on release.
    {
        size_t n = strlen(sig);
        snprintf(sig + n, sizeof(sig) - n, "|L%.24s|S%.24s|U%d",
                 s_listeningLabel, s_speakingText, serialUp ? 1 : 0);
    }
    if (strcmp(sig, s_lastSig) == 0) return;
    strncpy(s_lastSig, sig, sizeof(s_lastSig) - 1);
    s_lastSig[sizeof(s_lastSig) - 1] = '\0';

    // Status cluster: link glyph + battery. USB serial-primary parks the WiFi
    // radio by design, so a red WiFi glyph there would cry wolf on a healthy
    // docked link — show a green USB plug instead. Otherwise: green = WS to
    // the daemon, amber = WiFi without WS, red = no WiFi. Battery hides when
    // the gauge doesn't answer; charge bolt while the charger reports charging.
    lv_label_set_text_static(s_hdrWifi, serialUp ? LV_SYMBOL_USB : LV_SYMBOL_WIFI);
    lv_obj_set_style_text_color(
        s_hdrWifi,
        lv_color_hex((serialUp || wsUp) ? Theme::StatusGreen
                     : (wifiUp ? Theme::StatusAmber : Theme::StatusRed)), 0);
    if (pw.valid) {
        char batt[24];
        const char* battSym = pw.soc > 80 ? LV_SYMBOL_BATTERY_FULL
                            : pw.soc > 55 ? LV_SYMBOL_BATTERY_3
                            : pw.soc > 30 ? LV_SYMBOL_BATTERY_2
                            : pw.soc > 10 ? LV_SYMBOL_BATTERY_1
                                          : LV_SYMBOL_BATTERY_EMPTY;
        snprintf(batt, sizeof(batt), "%s%s %d%%",
                 pw.charging ? LV_SYMBOL_CHARGE : "", battSym, pw.soc);
        lv_label_set_text(s_hdrBatt, batt);
        uint32_t battColor = pw.charging ? Theme::StatusBlue
                           : pw.soc > 50 ? Theme::HUDDim
                           : pw.soc > 20 ? Theme::StatusAmber
                                         : Theme::StatusRed;
        lv_obj_set_style_text_color(s_hdrBatt, lv_color_hex(battColor), 0);
    } else {
        lv_label_set_text(s_hdrBatt, "");
    }

    // Header
    if ((s_mode == Mode::DETAIL || s_mode == Mode::SCRUB) && haveDetail) {
        char left[64];
        // U+00B7 " · " is a tofu box on this font stack — LV_SYMBOL_BULLET is
        // the covered separator (see Utf8::sanitizeLvglText).
        snprintf(left, sizeof(left), "%s " LV_SYMBOL_BULLET " %s",
                 agentShortLabel(detail.agentType),
                 detail.projectName[0] ? detail.projectName : "?");
        lv_label_set_text(s_headerLeft, left);
        lv_obj_set_style_text_font(s_headerLeft, &font_kr_12, 0);
        // State already has a larger, colored line in the body. Keeping the
        // right edge free prevents long phrases from colliding with WiFi/battery.
        lv_label_set_text(s_headerRight, "");
    } else {
        lv_label_set_text(s_headerLeft, "AGENTDECK");
        lv_obj_set_style_text_font(s_headerLeft, &lv_font_montserrat_12, 0);
        char right[24];
        if (connected && count > 0)
            snprintf(right, sizeof(right), "%d/%d", s_listIdx + 1, count);
        else
            snprintf(right, sizeof(right), "%s", connected ? "-" : "offline");
        lv_label_set_text(s_headerRight, right);
        lv_obj_set_style_text_color(s_headerRight, lv_color_hex(Theme::HUDDim), 0);
    }

    // Body
    lv_obj_clean(s_body);
    if (s_mode == Mode::SCRUB && haveDetail) {
        renderScrubBody();
    } else if (s_mode == Mode::DETAIL && haveDetail) {
        renderDetailBody(detail);
    } else {
        renderListBody(connected, count);
    }

    // Footer: the listening banner outranks everything — while the user is
    // speaking, the one thing they need on screen is who is listening.
    if (listening) {
        char line[72];
        snprintf(line, sizeof(line), LV_SYMBOL_BULLET " listening -> %s", s_listeningLabel);
        lv_label_set_text(s_footer, line);
        lv_obj_set_style_text_color(s_footer, lv_color_hex(Theme::StatusAmber), 0);
    } else if (speaking) {
        // Second-highest: the board is talking. Cyan rather than amber — amber
        // is reserved for "a session needs you" across every AgentDeck surface.
        char line[96];
        snprintf(line, sizeof(line), LV_SYMBOL_BULLET " reply: %s", s_speakingText);
        Utf8::utf8TrimEnd(line);
        lv_label_set_text(s_footer, line);
        lv_obj_set_style_text_color(s_footer, lv_color_hex(Theme::StatusCyan), 0);
    } else if (flashOn) {
        lv_label_set_text(s_footer, s_flashText);
        lv_obj_set_style_text_color(s_footer, lv_color_hex(Theme::StatusGreen), 0);
    } else {
        // Hold-to-talk lives on the encoder and only at list level — without
        // this hint the mic is undiscoverable (the listening banner only
        // appears once you already know to hold).
        const char* hint = "turn: session " LV_SYMBOL_BULLET " press: open "
                           LV_SYMBOL_BULLET " hold: talk";
        if (s_mode == Mode::DETAIL)
            hint = "turn: choose " LV_SYMBOL_BULLET " press: send " LV_SYMBOL_BULLET " hold: back";
        else if (s_mode == Mode::SCRUB)
            hint = "turn: older/newer " LV_SYMBOL_BULLET " press: back";
        lv_label_set_text(s_footer, hint);
        lv_obj_set_style_text_color(s_footer, lv_color_hex(Theme::HUDFaint), 0);
    }
}

}  // namespace Knob

#endif  // BOARD_T_EMBED
