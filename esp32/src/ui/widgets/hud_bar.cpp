#include "hud_bar.h"
#include "../theme.h"
#include "../display.h"
#include "../assets/logo.h"
#include "../../state/agent_state.h"
#include "config.h"
#include "net/serial_client.h"
#include "net/ws_client.h"
#include <Arduino.h>

#if defined(IPS10_PERF_HUD)
// Defined in main.cpp (global scope) — perf overlay worst-frame stats.
extern volatile uint32_t g_perfWorstUs, g_perfWorstView, g_perfWorstFlush, g_perfWorstInner;
extern volatile uint32_t g_bufInternal;   // 1 = LVGL draw buffer internal SRAM, 0 = PSRAM
#endif

// === Left panel: AgentDeck logo + session list ===
static lv_obj_t* panelLeft = nullptr;
static lv_obj_t* lblLogo = nullptr;
static lv_obj_t* logoLine = nullptr;   // accent underline
static lv_obj_t* lblSessions = nullptr;

#if defined(BOARD_IPS10)
// === IPS10 (800×1280) tablet sidebar: a LIVING AGENT MOSAIC ===
// One cell per active agent; each cell's height fluidly grows when the agent is working
// and shrinks when idle, and shows inline what that agent is doing. Replaces the static
// session list + separate timeline with a single dynamic surface.
static lv_obj_t* lblLogoImg = nullptr;
static lv_obj_t* lblStatus  = nullptr;   // header status line: "● N sessions · serial/ws"
static lv_obj_t* terrCount  = nullptr;   // "N LIVE" caption over the terrarium
// D1 full-width top bar (brand · daemon status · 5h/7d usage gauges).
static constexpr int IPS10_TOPBAR_H = 56;
static lv_obj_t* tbDaemon  = nullptr;    // "● daemon :9120 · N agents"
#if defined(IPS10_PERF_HUD)
static lv_obj_t* tbPerf    = nullptr;    // worst-frame perf overlay (debug)
#endif
static lv_obj_t* tb5hFill  = nullptr;    // 5h usage bar fill
static lv_obj_t* tb7dFill  = nullptr;    // 7d usage bar fill
static lv_obj_t* tb5hPct   = nullptr;    // "62%"
static lv_obj_t* tb7dPct   = nullptr;
#include "../terrarium/creature_glyphs_generated.h"  // OCTOPUS_A8 / CRAYFISH_BODY_A8 / OPENCODE_A8 masks
static constexpr int IPS10_SIDEBAR_W_MIN = 372;     // portrait / fallback minimum
static constexpr int IPS10_TERRARIUM_W = 408;       // keep in sync with terrarium/renderer.cpp
// Actual treemap-pane width, computed from g_screenW at init so it fills the space
// right of the terrarium (≈844px landscape / ≈376px portrait) instead of leaving a
// dead band in the middle on the 1280-wide landscape panel. (D1 ~63/37 split.)
static int ips10SidebarW = IPS10_SIDEBAR_W_MIN;
static constexpr int MOSAIC_MAX = 10;         // up to 10 agent cells (matches sessions[10])
static lv_obj_t* cellsBox = nullptr;          // absolute-positioned container for the treemap
static lv_obj_t* cell[MOSAIC_MAX] = {nullptr};
// D1 card sub-widgets (per cell) — flat stacked labels (no nested flex / no wrap, to
// keep LVGL layout cheap + robust).
static lv_obj_t* cellName[MOSAIC_MAX] = {nullptr};   // ●agent-name (bold) + colored [STATE]
static lv_obj_t* cellProj[MOSAIC_MAX] = {nullptr};   // project name (dim)
static lv_obj_t* cellTool[MOSAIC_MAX] = {nullptr};   // "▸ tool" in a bordered box
static lv_obj_t* cellBody[MOSAIC_MAX] = {nullptr};   // think / awaiting question (single line, dotted)
static lv_obj_t* cellMeta[MOSAIC_MAX] = {nullptr};   // model · elapsed footer (hidden on short cells)
// Animated current rect per cell (lerped toward the treemap target) — fluid boundaries.
static float cellCurX[MOSAIC_MAX] = {0};
static float cellCurY[MOSAIC_MAX] = {0};
static float cellCurW[MOSAIC_MAX] = {0};
static float cellCurH[MOSAIC_MAX] = {0};
static bool cellInit[MOSAIC_MAX] = {false};   // snap (no lerp) on a cell's first appearance

// Inline Approve/Deny on awaiting cells (shown only when the cell is tall enough).
static lv_obj_t* cellYes[MOSAIC_MAX] = {nullptr};
static lv_obj_t* cellNo[MOSAIC_MAX]  = {nullptr};

// D1 card visual polish: a tinted creature glyph (agent mark) in each card's top-right
// corner, plus a proper state "pill" chip. The glyph is the canonical creature silhouette
// (A8 alpha mask) recolored to the agent accent — brings back the creature imagery the flat
// label cards had lost. Unmapped/unknown agents hide the image (dot fallback in name).
static lv_obj_t* cellGlyph[MOSAIC_MAX] = {nullptr};   // creature mark overlay (IGNORE_LAYOUT)
static lv_obj_t* cellPill[MOSAIC_MAX]  = {nullptr};   // state pill chip (content-sized label)

// Runtime-built A8 image descriptors for the creature glyphs we have masks for.
static lv_image_dsc_t glyphOctopus;    // Claude
static lv_image_dsc_t glyphCrayfish;   // OpenClaw
static lv_image_dsc_t glyphOpencode;   // OpenCode
static lv_image_dsc_t glyphCodex;      // Codex
static bool glyphsReady = false;
static void ips10BuildGlyph(lv_image_dsc_t& g, const uint8_t* data, int w, int h) {
    g.header.magic  = LV_IMAGE_HEADER_MAGIC;
    g.header.cf     = LV_COLOR_FORMAT_A8;     // alpha-only mask → filled with image_recolor
    g.header.flags  = 0;
    g.header.w      = w;
    g.header.h      = h;
    g.header.stride = w;                      // 1 byte/px
    g.data_size     = (uint32_t)(w * h);
    g.data          = data;
}
static void ips10InitGlyphs() {
    if (glyphsReady) return;
    using namespace CreatureGlyphs;
    ips10BuildGlyph(glyphOctopus,  OCTOPUS_A8,       OCTOPUS_W,       OCTOPUS_H);
    // Cards use the FULL OpenClaw mark (eyes + both claws), not the body-only CRAYFISH_BODY
    // the terrarium pairs with procedural claws — the body alone reads as a shapeless blob.
    ips10BuildGlyph(glyphCrayfish, OPENCLAW_MARK_A8, OPENCLAW_MARK_W, OPENCLAW_MARK_H);
    ips10BuildGlyph(glyphOpencode, OPENCODE_A8,      OPENCODE_W,      OPENCODE_H);
    ips10BuildGlyph(glyphCodex,    CODEX_A8,         CODEX_W,         CODEX_H);
    glyphsReady = true;
}
// Map an agent type to its glyph descriptor (null → no glyph, e.g. unknown agent).
static const lv_image_dsc_t* ips10AgentGlyph(const char* agentType) {
    if (!agentType) return nullptr;
    if (strstr(agentType, "openclaw"))  return &glyphCrayfish;
    if (strstr(agentType, "codex"))     return &glyphCodex;
    if (strstr(agentType, "opencode"))  return &glyphOpencode;
    if (strstr(agentType, "claude"))    return &glyphOctopus;
    return nullptr;   // unknown → dot fallback in the name line
}

// Per-cell snapshot used by the tap handler + detail overlay (no g_state access on tap).
struct CellMeta {
    char sid[32];
    char requestId[40];
    char state[20];
    char question[160];
    char agent[16];
    char model[32];
    char name[40];
    char tool[40];
    uint32_t elapsed;
    uint32_t accent;
};
static CellMeta cellMetaData[MOSAIC_MAX];

// Tap-to-focus: cells matching this sid get the linked accent border (D1 focus link).
static char focusSid[32] = "";

// Detail overlay (floats on lv_layer_top, above terrarium + sidebar).
static lv_obj_t* detailBack  = nullptr;   // dimmed backdrop (tap to close)
static lv_obj_t* detailPanel = nullptr;
static lv_obj_t* detailTitle = nullptr;
static lv_obj_t* detailSub   = nullptr;   // agent · model · elapsed
static lv_obj_t* detailAction = nullptr;  // current tool / question
static lv_obj_t* detailLog   = nullptr;   // per-session activity log
static lv_obj_t* detailFoot  = nullptr;   // button row
static lv_obj_t* detailBtnA  = nullptr;   // primary (Approve / Interrupt)
static lv_obj_t* detailBtnALabel = nullptr;
static lv_obj_t* detailBtnB  = nullptr;   // secondary (Deny / Close)
static lv_obj_t* detailBtnBLabel = nullptr;
static int detailCellIdx = -1;            // which cell the overlay is showing (-1 = closed)

// ── outbound (UI core → network core via the thread-safe queue) ──
static void hudSendJson(const char* json) {
    Net::queueOutbound(json);
}
static void hudSendPermissionDecision(const char* requestId, const char* decision) {
    if (!requestId || !requestId[0]) return;
    char buf[160];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"permission_decision\",\"requestId\":\"%s\",\"decision\":\"%s\"}",
             requestId, decision);
    hudSendJson(buf);
}
static void hudSendSelectOption(const char* sid, int index) {
    char buf[96];
    if (sid && sid[0])
        snprintf(buf, sizeof(buf), "{\"type\":\"select_option\",\"index\":%d,\"sessionId\":\"%s\"}", index, sid);
    else
        snprintf(buf, sizeof(buf), "{\"type\":\"select_option\",\"index\":%d}", index);
    hudSendJson(buf);
}
static void hudSendSessionEscape(const char* sid) {
    if (!sid || !sid[0]) return;
    char buf[160];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"session_command\",\"sessionId\":\"%s\",\"command\":{\"type\":\"escape\"}}", sid);
    hudSendJson(buf);
}
// Approve/Deny that works against both daemons AND both prompt shapes:
//  • Observed gate (Node OR Swift daemon held PreToolUse) carries a requestId →
//    resolve it with permission_decision allow/deny.
//  • Managed PTY session (no requestId) → drive the live prompt. A raw
//    respond 'y'/'n' is ignored by Claude's navigable (❯) selector, so approve
//    uses select_option(0) (the daemon converts to arrows+Enter / number+Enter,
//    selecting the affirmative) and deny sends Esc, which Claude maps to its
//    "No, and tell Claude what to do differently (esc)" option.
static void hudSendApprove(const char* requestId, const char* sid, bool approve) {
    if (requestId && requestId[0]) {
        hudSendPermissionDecision(requestId, approve ? "allow" : "deny");
    } else if (sid && sid[0]) {
        if (approve) hudSendSelectOption(sid, 0);
        else         hudSendSessionEscape(sid);
    }
}

// Activity weight by state → drives cell size. D1: awaiting needs you, so it
// SWELLS biggest (room for the prompt + Approve/Deny); working next; idle collapses
// to a glanceable sliver.
static float ips10StateWeight(const char* state) {
    if (strstr(state, "awaiting") != nullptr) return 1.7f;  // pulls the brightest signal
    if (strcmp(state, "processing") == 0) return 1.0f;
    return 0.40f;  // idle / unknown
}
// Human phrase for the in-cell activity line.
static const char* ips10StatePhrase(const char* state) {
    if (strcmp(state, "processing") == 0) return "working";
    if (strcmp(state, "awaiting_permission") == 0) return "awaiting permission";
    if (strcmp(state, "awaiting_option") == 0) return "choosing option";
    if (strcmp(state, "awaiting_diff") == 0) return "reviewing diff";
    if (strcmp(state, "idle") == 0) return "idle";
    return state;
}
static uint32_t ips10AgentColor(const char* agentType) {
    if (strstr(agentType, "openclaw") != nullptr) return Theme::CrayfishShell;
    if (strstr(agentType, "codex") != nullptr) return Theme::CloudBody;
    if (strstr(agentType, "opencode") != nullptr) return Theme::OpenCodeOuter;
    if (strstr(agentType, "claude") != nullptr) return Theme::ClaudeBody;
    return Theme::HUDDim;
}
// D1 "Tide Bento" semantic state tokens (docs/design/tenin/screen.css :root):
//   --ok #52D988 (working) · --attn #FFA93D (awaiting) · --error #FF6B6B · --faint #5D7470 (idle)
// Product-UI bright STATE palette — data.js SSOT (tenin/data.js STATE.*.color).
static constexpr uint32_t D1_OK    = 0x3ED6E8;  // processing (cyan)
static constexpr uint32_t D1_ATTN  = 0xFFA93D;  // awaiting
static constexpr uint32_t D1_ERROR = 0xFF6B6B;  // error
static constexpr uint32_t D1_IDLE  = 0x7A8A9C;  // idle
static uint32_t ips10StateColor(const char* state) {
    if (strstr(state, "awaiting") != nullptr) return D1_ATTN;
    if (strcmp(state, "processing") == 0)     return D1_OK;
    if (strstr(state, "error") != nullptr || strstr(state, "fail") != nullptr) return D1_ERROR;
    return D1_IDLE;   // idle / unknown → faint slate (matches D1 idle cells)
}
// Compact elapsed for the cell footer: "45s" / "18m" / "2h" / "3d" (NTP-less device,
// value arrives pre-derived as seconds from the daemon's startedAt).
static void ips10FormatElapsed(uint32_t sec, char* out, size_t n) {
    if (sec == 0)            { out[0] = '\0'; }
    else if (sec < 60)       snprintf(out, n, "%lus", (unsigned long)sec);
    else if (sec < 3600)     snprintf(out, n, "%lum", (unsigned long)(sec / 60));
    else if (sec < 86400)    snprintf(out, n, "%luh", (unsigned long)(sec / 3600));
    else                     snprintf(out, n, "%lud", (unsigned long)(sec / 86400));
}
// Bold agent label for the card header (the project name goes on its own dim line).
static const char* ips10AgentLabel(const char* agentType) {
    if (strstr(agentType, "openclaw") != nullptr) return "OpenClaw";
    if (strstr(agentType, "codex") != nullptr)    return "Codex";
    if (strstr(agentType, "opencode") != nullptr) return "OpenCode";
    if (strstr(agentType, "claude") != nullptr)   return "Claude";
    return "Agent";
}
// Short uppercase pill text (D1 state pill).
static const char* ips10StatePill(const char* state) {
    if (strcmp(state, "processing") == 0)      return "WORKING";
    if (strcmp(state, "awaiting_option") == 0) return "CHOOSE";
    if (strcmp(state, "awaiting_diff") == 0)   return "DIFF";
    if (strstr(state, "awaiting") != nullptr)  return "AWAITING";
    if (strcmp(state, "idle") == 0)            return "IDLE";
    return state;
}
#endif

// === Right panel: Tank Status (water-fill gauges) ===
static lv_obj_t* panelRight = nullptr;
static lv_obj_t* lblTankHeader = nullptr;

// 5h gauge
static lv_obj_t* gauge5hBox = nullptr;
static lv_obj_t* gauge5hFill = nullptr;
static lv_obj_t* gauge5hPct = nullptr;
static lv_obj_t* gauge5hPeriod = nullptr;
static lv_obj_t* gauge5hReset = nullptr;

// 7d gauge
static lv_obj_t* gauge7dBox = nullptr;
static lv_obj_t* gauge7dFill = nullptr;
static lv_obj_t* gauge7dPct = nullptr;
static lv_obj_t* gauge7dPeriod = nullptr;
static lv_obj_t* gauge7dReset = nullptr;

// Stale indicator
static lv_obj_t* lblStale = nullptr;

static bool visible = true;
static bool lastShowTankStatus = true;
static bool firstUpdate = true;

// Panel Y offset: just below water surface
static constexpr int PANEL_TOP_Y = 28;

// Gauge dimensions
#if defined(BOARD_TTGO)
static constexpr int GAUGE_SIZE = 40;
#elif IS_ROUND
static constexpr int GAUGE_SIZE = 44;
#else
static constexpr int GAUGE_SIZE = 58;
#endif
static constexpr int GAUGE_BORDER = 1;
static constexpr int GAUGE_INNER = GAUGE_SIZE - GAUGE_BORDER * 2;
static constexpr int GAUGE_GAP = 8;
static constexpr int GAUGE_RADIUS = 6;

static bool isCodexAgentType(const char* agentType) {
    return agentType &&
           (strstr(agentType, "codex-cli") != nullptr ||
            strstr(agentType, "codex-app") != nullptr);
}

static uint32_t agentDotColor(const char* agentType) {
    if (agentType && strstr(agentType, "openclaw") != nullptr) {
        return Theme::CrayfishShell;
    }
    if (isCodexAgentType(agentType)) {
        return Theme::CloudBody;
    }
    if (agentType && strstr(agentType, "opencode") != nullptr) {
        return Theme::OpenCodeOuter;
    }
    if (agentType && strstr(agentType, "claude-code") != nullptr) {
        return Theme::ClaudeBody;
    }
    return Theme::HUDDim;
}

namespace HUD {

// Helper: create a water-fill gauge column: [gauge box] + "1h 55m"
static void createGauge(lv_obj_t* parent,
                        lv_obj_t*& box, lv_obj_t*& fill,
                        lv_obj_t*& pctLabel, lv_obj_t*& periodLabel,
                        lv_obj_t*& resetLabel, const char* period) {
    // Column wrapper: gauge + reset time
    lv_obj_t* col = lv_obj_create(parent);
    lv_obj_set_size(col, GAUGE_SIZE, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(col, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(col, 0, 0);
    lv_obj_set_style_pad_all(col, 0, 0);
    lv_obj_set_style_pad_row(col, 1, 0);
    lv_obj_clear_flag(col, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(col, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    // Gauge box (glass background)
    box = lv_obj_create(col);
    lv_obj_set_size(box, GAUGE_SIZE, GAUGE_SIZE);
    lv_obj_set_style_bg_color(box, lv_color_hex(0xFFFFFF), 0);
    lv_obj_set_style_bg_opa(box, (lv_opa_t)32, 0);  // 12.5% white glass
    lv_obj_set_style_border_width(box, GAUGE_BORDER, 0);
    lv_obj_set_style_border_color(box, lv_color_hex(0xFFFFFF), 0);
    lv_obj_set_style_border_opa(box, (lv_opa_t)20, 0);
    lv_obj_set_style_radius(box, GAUGE_RADIUS, 0);
    lv_obj_set_style_pad_all(box, 0, 0);
    lv_obj_clear_flag(box, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_clip_corner(box, true, 0);

    // Water fill bar (bottom-aligned, inside border)
    fill = lv_obj_create(box);
    lv_obj_set_size(fill, GAUGE_INNER, 0);
    lv_obj_align(fill, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_set_style_bg_color(fill, lv_color_hex(Theme::StatusGreen), 0);
    lv_obj_set_style_bg_opa(fill, LV_OPA_50, 0);
    lv_obj_set_style_border_width(fill, 0, 0);
    lv_obj_set_style_radius(fill, 0, 0);
    lv_obj_set_style_pad_all(fill, 0, 0);
    lv_obj_clear_flag(fill, LV_OBJ_FLAG_SCROLLABLE);

    // Period label at top inside gauge ("5h" / "7d")
    periodLabel = lv_label_create(box);
    lv_obj_set_style_text_color(periodLabel, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(periodLabel, &lv_font_montserrat_10, 0);
    lv_obj_align(periodLabel, LV_ALIGN_TOP_MID, 0, 4);
    lv_label_set_text(periodLabel, period);

    // Percentage text (centered in gauge)
    pctLabel = lv_label_create(box);
    lv_obj_set_style_text_color(pctLabel, lv_color_hex(Theme::HUDText), 0);
    lv_obj_set_style_text_font(pctLabel, &lv_font_montserrat_16, 0);
    lv_obj_align(pctLabel, LV_ALIGN_CENTER, 0, 2);
    lv_label_set_text(pctLabel, "0%");

    // Reset time BELOW gauge box (e.g. "1h 55m")
    resetLabel = lv_label_create(col);
    lv_obj_set_style_text_color(resetLabel, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(resetLabel, &lv_font_montserrat_10, 0);
    lv_obj_set_style_text_opa(resetLabel, (lv_opa_t)178, 0);  // 70%
    lv_label_set_text(resetLabel, "");
}

#if defined(BOARD_IPS10)
// ───────── D1 detail overlay (tap a cell → header · activity log · actions) ─────────
static void detailClose() {
    detailCellIdx = -1;
    focusSid[0] = '\0';
    if (detailBack) lv_obj_add_flag(detailBack, LV_OBJ_FLAG_HIDDEN);
}
static void detailBackCb(lv_event_t* e) {
    // Close when the tap lands on the scrim itself (outside the panel). Accept both the
    // original target and the current target so a slightly-bubbled event still closes.
    if (lv_event_get_target(e) == detailBack || lv_event_get_current_target(e) == detailBack)
        detailClose();
}
static void detailCloseCb(lv_event_t* e) {   // explicit ✕ / Cancel → always a way out
    (void)e;
    detailClose();
}
static void detailBtnACb(lv_event_t* e) {
    (void)e;
    if (detailCellIdx < 0) return;
    CellMeta& m = cellMetaData[detailCellIdx];
    if (strstr(m.state, "awaiting") != nullptr) {
        hudSendApprove(m.requestId, m.sid, true);
    } else if (strcmp(m.state, "processing") == 0 && m.sid[0]) {
        char buf[160];
        snprintf(buf, sizeof(buf),
                 "{\"type\":\"session_command\",\"sessionId\":\"%s\",\"command\":{\"type\":\"interrupt\"}}", m.sid);
        hudSendJson(buf);
    }
    detailClose();
}
static void detailBtnBCb(lv_event_t* e) {
    (void)e;
    if (detailCellIdx >= 0) {
        CellMeta& m = cellMetaData[detailCellIdx];
        if (strstr(m.state, "awaiting") != nullptr) hudSendApprove(m.requestId, m.sid, false);
    }
    detailClose();
}
static void detailEnsure() {
    if (detailBack) return;
    detailBack = lv_obj_create(lv_layer_top());
#if defined(BOARD_IPS10)
    // PERF: cover only the CARDS region (right of the office, below the top bar), not the whole
    // screen. The office is a 408-wide software-transposed canvas — the single most expensive
    // thing to re-flush. Scoping the modal to the cards area means closing it only re-renders +
    // re-flushes the right side, never the office, so the modal feels instant to open/close.
    lv_obj_set_size(detailBack, g_screenW - (IPS10_TERRARIUM_W + 8), g_screenH - IPS10_TOPBAR_H);
    lv_obj_set_pos(detailBack, IPS10_TERRARIUM_W + 8, IPS10_TOPBAR_H);
#else
    lv_obj_set_size(detailBack, LV_PCT(100), LV_PCT(100));
#endif
    lv_obj_set_style_bg_color(detailBack, lv_color_hex(0x05140F), 0);
    // Lighter scrim (~47%) so the terrarium + cards stay visibly dimmed behind the
    // modal instead of being blacked out — reads as a floating layer, not a takeover.
    lv_obj_set_style_bg_opa(detailBack, (lv_opa_t)120, 0);
    lv_obj_set_style_border_width(detailBack, 0, 0);
    lv_obj_set_style_radius(detailBack, 0, 0);
    lv_obj_set_style_pad_all(detailBack, 0, 0);
    lv_obj_clear_flag(detailBack, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(detailBack, detailBackCb, LV_EVENT_CLICKED, NULL);

    detailPanel = lv_obj_create(detailBack);
    // Floating modal card: wide-but-short on the 1280×800 panel so there are clear
    // margins on every side (≈300px L/R, ≈120px T/B). The old 560×720 was 90% of the
    // screen height → read as a full-screen cover rather than a modal layer.
    lv_obj_set_size(detailPanel, 680, 560);
    lv_obj_center(detailPanel);
    // Soft drop shadow lifts the card off the dimmed backdrop (modal depth cue).
    lv_obj_set_style_shadow_width(detailPanel, 48, 0);
    lv_obj_set_style_shadow_spread(detailPanel, 2, 0);
    lv_obj_set_style_shadow_color(detailPanel, lv_color_hex(0x000000), 0);
    lv_obj_set_style_shadow_opa(detailPanel, (lv_opa_t)160, 0);
    lv_obj_set_style_bg_color(detailPanel, lv_color_hex(0x0D2723), 0);
    lv_obj_set_style_bg_opa(detailPanel, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(detailPanel, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_border_width(detailPanel, 1, 0);
    lv_obj_set_style_radius(detailPanel, 16, 0);
    lv_obj_set_style_pad_all(detailPanel, 18, 0);
    lv_obj_set_style_pad_row(detailPanel, 10, 0);
    lv_obj_clear_flag(detailPanel, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(detailPanel, LV_FLEX_FLOW_COLUMN);

    // Explicit close (✕) — top-right overlay, OUTSIDE the flex flow. Always available so the
    // user can back out of an Approve/Deny prompt WITHOUT choosing either. (Scrim-tap also
    // closes, but a visible affordance makes the exit obvious.)
    lv_obj_t* closeBtn = lv_button_create(detailPanel);
    lv_obj_add_flag(closeBtn, LV_OBJ_FLAG_IGNORE_LAYOUT);
    lv_obj_set_size(closeBtn, 44, 44);
    lv_obj_align(closeBtn, LV_ALIGN_TOP_RIGHT, 4, -4);
    lv_obj_set_style_radius(closeBtn, 22, 0);
    lv_obj_set_style_bg_color(closeBtn, lv_color_hex(0x16413C), 0);
    lv_obj_set_style_bg_opa(closeBtn, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(closeBtn, 1, 0);
    lv_obj_set_style_border_color(closeBtn, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_shadow_width(closeBtn, 0, 0);
    lv_obj_add_event_cb(closeBtn, detailCloseCb, LV_EVENT_CLICKED, NULL);
    lv_obj_t* closeLbl = lv_label_create(closeBtn);
    lv_label_set_text(closeLbl, LV_SYMBOL_CLOSE);
    lv_obj_set_style_text_color(closeLbl, lv_color_hex(Theme::HUDText), 0);
    lv_obj_center(closeLbl);

    detailTitle = lv_label_create(detailPanel);
    lv_obj_set_style_text_color(detailTitle, lv_color_hex(Theme::HUDText), 0);
    lv_obj_set_style_text_font(detailTitle, &font_kr_20, 0);
    lv_label_set_long_mode(detailTitle, LV_LABEL_LONG_DOT);
    lv_obj_set_width(detailTitle, LV_PCT(100));

    detailSub = lv_label_create(detailPanel);
    lv_obj_set_style_text_color(detailSub, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(detailSub, &font_kr_12, 0);
    lv_label_set_recolor(detailSub, true);
    lv_obj_set_width(detailSub, LV_PCT(100));

    detailAction = lv_label_create(detailPanel);
    lv_obj_set_style_text_color(detailAction, lv_color_hex(Theme::HUDText), 0);
    lv_obj_set_style_text_font(detailAction, &font_kr_12, 0);
    lv_label_set_long_mode(detailAction, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(detailAction, LV_PCT(100));

    detailLog = lv_label_create(detailPanel);
    lv_obj_set_style_text_color(detailLog, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(detailLog, &font_kr_12, 0);
    lv_obj_set_style_bg_color(detailLog, lv_color_hex(0x07140F), 0);
    lv_obj_set_style_bg_opa(detailLog, (lv_opa_t)150, 0);
    lv_obj_set_style_pad_all(detailLog, 10, 0);
    lv_obj_set_style_radius(detailLog, 9, 0);
    lv_label_set_recolor(detailLog, true);
    lv_label_set_long_mode(detailLog, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(detailLog, LV_PCT(100));
    lv_obj_set_flex_grow(detailLog, 1);

    detailFoot = lv_obj_create(detailPanel);
    lv_obj_set_size(detailFoot, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(detailFoot, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(detailFoot, 0, 0);
    lv_obj_set_style_pad_all(detailFoot, 0, 0);
    lv_obj_set_style_pad_column(detailFoot, 10, 0);
    lv_obj_clear_flag(detailFoot, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(detailFoot, LV_FLEX_FLOW_ROW);

    detailBtnA = lv_button_create(detailFoot);
    lv_obj_set_flex_grow(detailBtnA, 1);
    lv_obj_set_height(detailBtnA, 48);
    lv_obj_add_event_cb(detailBtnA, detailBtnACb, LV_EVENT_CLICKED, NULL);
    detailBtnALabel = lv_label_create(detailBtnA);
    lv_obj_center(detailBtnALabel);

    detailBtnB = lv_button_create(detailFoot);
    lv_obj_set_flex_grow(detailBtnB, 1);
    lv_obj_set_height(detailBtnB, 48);
    lv_obj_add_event_cb(detailBtnB, detailBtnBCb, LV_EVENT_CLICKED, NULL);
    detailBtnBLabel = lv_label_create(detailBtnB);
    lv_obj_center(detailBtnBLabel);
}
static void detailRefresh() {
    if (detailCellIdx < 0 || !detailBack) return;
#if defined(IPS10_PERF_PROFILE)
    uint32_t _drt0 = micros();
#endif
    CellMeta& m = cellMetaData[detailCellIdx];
    lv_label_set_text(detailTitle, m.name[0] ? m.name : "Session");

    char sub[96];
    snprintf(sub, sizeof(sub), "#%06lX %s# " LV_SYMBOL_BULLET " %s", (unsigned long)m.accent,
             m.agent[0] ? m.agent : "agent", m.model[0] ? m.model : "");
    lv_label_set_text(detailSub, sub);

    bool awaiting = (strstr(m.state, "awaiting") != nullptr);
    if (awaiting && m.question[0]) {
        lv_label_set_text(detailAction, m.question);
    } else if (m.tool[0]) {
        char t[64]; snprintf(t, sizeof(t), LV_SYMBOL_PLAY " %s", m.tool);
        lv_label_set_text(detailAction, t);
    } else {
        lv_label_set_text(detailAction, ips10StatePhrase(m.state));
    }

    // Activity log — this session's timeline entries (oldest → newest).
    char logbuf[640]; int lp = 0; logbuf[0] = '\0';
    lockState();
    for (uint8_t i = 0; i < g_state.timelineCount; i++) {
        uint8_t idx = (g_state.timelineHead + i) % TIMELINE_MAX_ENTRIES;
        const TimelineEntry& te = g_state.timeline[idx];
        if (m.sid[0] && te.sessionId[0] && strcmp(te.sessionId, m.sid) != 0) continue;
        int hh = te.ts / 3600, mm = (te.ts % 3600) / 60;
        lp += snprintf(logbuf + lp, sizeof(logbuf) - lp, "%02d:%02d  %s\n", hh, mm, te.raw);
        if ((size_t)lp >= sizeof(logbuf) - 80) break;
    }
    unlockState();
    if (lp == 0) snprintf(logbuf, sizeof(logbuf), "No activity recorded for this session yet.");
    else if (logbuf[lp - 1] == '\n') logbuf[lp - 1] = '\0';
    for (char* c = logbuf; *c; c++) if (*c == '#') *c = ' ';
    lv_label_set_text(detailLog, logbuf);

    // Footer buttons by state.
    if (awaiting) {
        lv_obj_set_style_bg_color(detailBtnA, lv_color_hex(Theme::StatusAmber), 0);
        lv_label_set_text(detailBtnALabel, "Approve");
        lv_obj_set_style_text_color(detailBtnALabel, lv_color_hex(0x1A1205), 0);
        lv_obj_clear_flag(detailBtnB, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_bg_color(detailBtnB, lv_color_hex(Theme::StatusRed), 0);
        lv_label_set_text(detailBtnBLabel, "Deny");
        lv_obj_set_style_text_color(detailBtnBLabel, lv_color_hex(0x2A0C0C), 0);
    } else if (strcmp(m.state, "processing") == 0) {
        lv_obj_set_style_bg_color(detailBtnA, lv_color_hex(Theme::HUDDim), 0);
        lv_label_set_text(detailBtnALabel, "Interrupt");
        lv_obj_set_style_text_color(detailBtnALabel, lv_color_hex(0x07140F), 0);
        lv_obj_clear_flag(detailBtnB, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_bg_color(detailBtnB, lv_color_hex(0x16413C), 0);
        lv_label_set_text(detailBtnBLabel, "Close");
        lv_obj_set_style_text_color(detailBtnBLabel, lv_color_hex(Theme::HUDText), 0);
    } else {
        lv_obj_set_style_bg_color(detailBtnA, lv_color_hex(0x16413C), 0);
        lv_label_set_text(detailBtnALabel, "Close");
        lv_obj_set_style_text_color(detailBtnALabel, lv_color_hex(Theme::HUDText), 0);
        lv_obj_add_flag(detailBtnB, LV_OBJ_FLAG_HIDDEN);
    }
#if defined(IPS10_PERF_PROFILE)
    Serial.printf("[PROF] detailRefresh %lu us\n", (unsigned long)(micros() - _drt0));
#endif
}
static void detailOpen(int idx) {
    if (idx < 0 || idx >= MOSAIC_MAX) return;
    detailEnsure();
    detailCellIdx = idx;
    strncpy(focusSid, cellMetaData[idx].sid, sizeof(focusSid) - 1);
    focusSid[sizeof(focusSid) - 1] = '\0';
    lv_obj_clear_flag(detailBack, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(detailBack);
    detailRefresh();
}
static void cellTapCb(lv_event_t* e) {
    detailOpen((int)(intptr_t)lv_event_get_user_data(e));
}
static void cellYesCb(lv_event_t* e) {
    int idx = (int)(intptr_t)lv_event_get_user_data(e);
    if (idx >= 0 && idx < MOSAIC_MAX) hudSendApprove(cellMetaData[idx].requestId, cellMetaData[idx].sid, true);
}
static void cellNoCb(lv_event_t* e) {
    int idx = (int)(intptr_t)lv_event_get_user_data(e);
    if (idx >= 0 && idx < MOSAIC_MAX) hudSendApprove(cellMetaData[idx].requestId, cellMetaData[idx].sid, false);
}
#endif // BOARD_IPS10

void init(lv_obj_t* parent) {
#if defined(BOARD_IPS10)
    // === IPS10 tablet layout: terrarium on the left, treemap pane fills the rest ===
    // The terrarium renders in the left ~408px (creatures biased left); the treemap
    // pane takes everything to its right so the 1280-wide landscape panel has no dead
    // middle band. Recomputed here each init (orientation changes rebuild the UI).
    // Anchor the cards region's LEFT edge at the terrarium boundary and let it run to
    // the right screen edge (explicit pos, not right-align — which was making it look
    // centered). Left-aligned children so cards start at the terrarium boundary.
    const int cardsX = IPS10_TERRARIUM_W + 8;
    ips10SidebarW = (g_screenW > 0 ? g_screenW : 800) - cardsX - 8;
    if (ips10SidebarW < IPS10_SIDEBAR_W_MIN) ips10SidebarW = IPS10_SIDEBAR_W_MIN;
    // === Full-width top bar (D1 topbar): brand · daemon status · 5h/7d usage gauges. ===
    {
        lv_obj_t* tb = lv_obj_create(parent);
        lv_obj_set_size(tb, g_screenW, IPS10_TOPBAR_H);
        lv_obj_set_pos(tb, 0, 0);
        lv_obj_set_style_bg_color(tb, lv_color_hex(0x07140F), 0);
        lv_obj_set_style_bg_opa(tb, (lv_opa_t)190, 0);
        lv_obj_set_style_border_side(tb, LV_BORDER_SIDE_BOTTOM, 0);
        lv_obj_set_style_border_width(tb, 1, 0);
        lv_obj_set_style_border_color(tb, lv_color_hex(0x1B3F39), 0);
        lv_obj_set_style_radius(tb, 0, 0);
        lv_obj_set_style_pad_left(tb, 18, 0); lv_obj_set_style_pad_right(tb, 18, 0);
        lv_obj_set_style_pad_top(tb, 0, 0); lv_obj_set_style_pad_bottom(tb, 0, 0);
        lv_obj_set_style_pad_column(tb, 16, 0);
        lv_obj_clear_flag(tb, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_clear_flag(tb, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_flex_flow(tb, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(tb, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

        lv_obj_t* mk = lv_image_create(tb);
        lv_image_set_src(mk, &img_logo_64);
        lv_image_set_scale(mk, 256 * 30 / 64);   // 64→30px
        lblLogo = lv_label_create(tb);
        lv_obj_set_style_text_font(lblLogo, &lv_font_montserrat_16, 0);
        lv_label_set_recolor(lblLogo, true);
        lv_label_set_text(lblLogo, "#E7EFE8 Agent##3ED6E8 Deck#");   // Deck in cyan

        tbDaemon = lv_label_create(tb);
        lv_obj_set_style_text_font(tbDaemon, &font_kr_12, 0);
        lv_label_set_recolor(tbDaemon, true);
        lv_obj_set_style_text_color(tbDaemon, lv_color_hex(0x8FA6A2), 0);
        lv_label_set_text(tbDaemon, "");

#if defined(IPS10_PERF_HUD)
        tbPerf = lv_label_create(tb);
        lv_obj_set_style_text_font(tbPerf, &font_kr_12, 0);
        lv_obj_set_style_text_color(tbPerf, lv_color_hex(0xFFA93D), 0);
        lv_label_set_text(tbPerf, "perf");
#endif

        lv_obj_t* sp = lv_obj_create(tb);   // flex spacer → pushes gauges right
        lv_obj_set_style_bg_opa(sp, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(sp, 0, 0);
        lv_obj_set_height(sp, 1);
        lv_obj_set_flex_grow(sp, 1);
        lv_obj_clear_flag(sp, LV_OBJ_FLAG_SCROLLABLE);

        struct { const char* lab; lv_obj_t** fill; lv_obj_t** pct; } G[2] = {
            {"5H", &tb5hFill, &tb5hPct}, {"7D", &tb7dFill, &tb7dPct} };
        for (int gi = 0; gi < 2; gi++) {
            lv_obj_t* g = lv_obj_create(tb);
            lv_obj_set_size(g, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
            lv_obj_set_style_bg_opa(g, LV_OPA_TRANSP, 0);
            lv_obj_set_style_border_width(g, 0, 0);
            lv_obj_set_style_pad_all(g, 0, 0);
            lv_obj_set_style_pad_column(g, 8, 0);
            lv_obj_clear_flag(g, LV_OBJ_FLAG_SCROLLABLE);
            lv_obj_set_flex_flow(g, LV_FLEX_FLOW_ROW);
            lv_obj_set_flex_align(g, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
            lv_obj_t* lab = lv_label_create(g);
            lv_obj_set_style_text_font(lab, &font_kr_12, 0);
            lv_obj_set_style_text_color(lab, lv_color_hex(0x5D7470), 0);
            lv_label_set_text(lab, G[gi].lab);
            lv_obj_t* track = lv_obj_create(g);
            lv_obj_set_size(track, 92, 6);
            lv_obj_set_style_radius(track, 3, 0);
            lv_obj_set_style_bg_color(track, lv_color_hex(0xFFFFFF), 0);
            lv_obj_set_style_bg_opa(track, (lv_opa_t)45, 0);
            lv_obj_set_style_border_width(track, 0, 0);
            lv_obj_set_style_pad_all(track, 0, 0);
            lv_obj_clear_flag(track, LV_OBJ_FLAG_SCROLLABLE);
            lv_obj_t* fill = lv_obj_create(track);
            lv_obj_set_size(fill, 0, 6);
            lv_obj_set_pos(fill, 0, 0);
            lv_obj_set_style_radius(fill, 3, 0);
            lv_obj_set_style_bg_color(fill, lv_color_hex(0x3ED6E8), 0);
            lv_obj_set_style_bg_opa(fill, LV_OPA_COVER, 0);
            lv_obj_set_style_border_width(fill, 0, 0);
            lv_obj_clear_flag(fill, LV_OBJ_FLAG_SCROLLABLE);
            *G[gi].fill = fill;
            lv_obj_t* pct = lv_label_create(g);
            lv_obj_set_style_text_font(pct, &font_kr_12, 0);
            lv_obj_set_style_text_color(pct, lv_color_hex(0xE7EFE8), 0);
            lv_label_set_text(pct, "-");   // em dash placeholder
            *G[gi].pct = pct;
        }
    }

    // Cards panel — sits BELOW the top bar (no in-panel header anymore; brand moved to the bar).
    panelLeft = lv_obj_create(parent);
    lv_obj_set_size(panelLeft, ips10SidebarW, g_screenH - IPS10_TOPBAR_H - 12);
    lv_obj_align(panelLeft, LV_ALIGN_TOP_LEFT, cardsX, IPS10_TOPBAR_H + 6);
    lv_obj_set_style_bg_opa(panelLeft, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(panelLeft, 0, 0);
    lv_obj_set_style_radius(panelLeft, 14, 0);
    lv_obj_set_style_pad_top(panelLeft, 8, 0);
    lv_obj_set_style_pad_bottom(panelLeft, 12, 0);
    lv_obj_set_style_pad_left(panelLeft, 14, 0);
    lv_obj_set_style_pad_right(panelLeft, 14, 0);
    lv_obj_set_style_pad_row(panelLeft, 8, 0);
    lv_obj_clear_flag(panelLeft, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(panelLeft, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(panelLeft, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);

    // === Office caption (top-left) + state legend (bottom-left) — HUD overlays on the screen
    //     above the office canvas (office.js: caption top, legend bottom). Each sits in a dark
    //     translucent chip so the text reads cleanly over the busy pixel scene. ===
    {
        // (No "THE BULLPEN / N LIVE" caption — the top bar already shows the agent count, and
        //  the team-room rugs + clustered workers carry the spatial identity. terrCount stays
        //  null so the shared update() path skips it.)
        terrCount = nullptr;

        // legend chip: round colour swatches (state colours), bottom-left per office.js.
        lv_obj_t* terrLegend = lv_obj_create(parent);
        lv_obj_add_flag(terrLegend, LV_OBJ_FLAG_IGNORE_LAYOUT);
        lv_obj_set_size(terrLegend, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_align(terrLegend, LV_ALIGN_BOTTOM_LEFT, 12, -10);
        lv_obj_set_style_bg_color(terrLegend, lv_color_hex(0x07140F), 0);
        lv_obj_set_style_bg_opa(terrLegend, (lv_opa_t)160, 0);
        lv_obj_set_style_radius(terrLegend, 7, 0);
        lv_obj_set_style_pad_left(terrLegend, 9, 0); lv_obj_set_style_pad_right(terrLegend, 9, 0);
        lv_obj_set_style_pad_top(terrLegend, 5, 0); lv_obj_set_style_pad_bottom(terrLegend, 5, 0);
        lv_obj_set_style_pad_column(terrLegend, 12, 0);
        lv_obj_set_style_border_width(terrLegend, 0, 0);
        lv_obj_clear_flag(terrLegend, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_clear_flag(terrLegend, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_flex_flow(terrLegend, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(terrLegend, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        const uint32_t legC[3] = { D1_ATTN, D1_OK, D1_IDLE };
        const char*    legT[3] = { "Awaiting", "Working", "Idle" };
        for (int li = 0; li < 3; li++) {
            lv_obj_t* item = lv_obj_create(terrLegend);
            lv_obj_set_size(item, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
            lv_obj_set_style_bg_opa(item, LV_OPA_TRANSP, 0);
            lv_obj_set_style_border_width(item, 0, 0);
            lv_obj_set_style_pad_all(item, 0, 0);
            lv_obj_set_style_pad_column(item, 6, 0);
            lv_obj_clear_flag(item, LV_OBJ_FLAG_SCROLLABLE);
            lv_obj_clear_flag(item, LV_OBJ_FLAG_CLICKABLE);
            lv_obj_set_flex_flow(item, LV_FLEX_FLOW_ROW);
            lv_obj_set_flex_align(item, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
            lv_obj_t* sw = lv_obj_create(item);
            lv_obj_set_size(sw, 11, 11);
            lv_obj_set_style_radius(sw, 6, 0);
            lv_obj_set_style_bg_color(sw, lv_color_hex(legC[li]), 0);
            lv_obj_set_style_bg_opa(sw, LV_OPA_COVER, 0);
            lv_obj_set_style_border_width(sw, 0, 0);
            lv_obj_clear_flag(sw, LV_OBJ_FLAG_SCROLLABLE);
            lv_obj_t* lt = lv_label_create(item);
            lv_obj_set_style_text_color(lt, lv_color_hex(0x8FA6A2), 0);  // D1 --dim
            lv_obj_set_style_text_font(lt, &font_kr_12, 0);
            lv_label_set_text(lt, legT[li]);
        }
    }

    // Not used on IPS10 (the mosaic replaces the flat session list); keep null so
    // the shared update() path guards them out.
    lblSessions = nullptr;

    // === Agent treemap — absolute-positioned cells tile the whole region in 2D ===
    cellsBox = lv_obj_create(panelLeft);
    lv_obj_set_width(cellsBox, ips10SidebarW - 28);
    lv_obj_set_flex_grow(cellsBox, 1);          // eat all leftover vertical space
    // Solid "deck" backdrop (NOT transparent). The cells tile this region with a 6px
    // GAP and lerp toward new sizes when the live session count changes — during that
    // settle (and on any transient empty list) the un-tiled area would otherwise show
    // the screen's pure-black root (0x000000), reading as "the right side flickers to
    // black". A solid deep ink-green deck makes the inter-cell gutters and transition
    // gaps an intentional surface instead of black, and reads as cards-on-a-deck (D1).
    lv_obj_set_style_bg_color(cellsBox, lv_color_hex(0x0B1D1A), 0);   // D1 --ink-1 deck
    lv_obj_set_style_bg_opa(cellsBox, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(cellsBox, 12, 0);
    lv_obj_set_style_border_width(cellsBox, 0, 0);
    lv_obj_set_style_pad_all(cellsBox, 0, 0);
    lv_obj_clear_flag(cellsBox, LV_OBJ_FLAG_SCROLLABLE);
    // No flex layout → children are placed by absolute lv_obj_set_pos (the treemap).

    ips10InitGlyphs();   // build the A8 creature-mark descriptors once before the cells use them

    for (int i = 0; i < MOSAIC_MAX; i++) {
        cell[i] = lv_obj_create(cellsBox);
        lv_obj_set_size(cell[i], 80, 60);
        lv_obj_set_pos(cell[i], 0, 0);
        // D1 card: raised-surface vertical gradient (#16413c → #102a27), rounded, agent-color
        // accent rail on the left edge. Matches docs/design/tenin/screen.css .cell background.
        lv_obj_set_style_bg_color(cell[i], lv_color_hex(0x16413C), 0);
        lv_obj_set_style_bg_grad_color(cell[i], lv_color_hex(0x102A27), 0);
        lv_obj_set_style_bg_grad_dir(cell[i], LV_GRAD_DIR_VER, 0);
        lv_obj_set_style_bg_opa(cell[i], LV_OPA_COVER, 0);   // opaque (no per-pixel blend)
        lv_obj_set_style_radius(cell[i], 12, 0);
        lv_obj_set_style_border_side(cell[i], LV_BORDER_SIDE_LEFT, 0);
        lv_obj_set_style_border_width(cell[i], 3, 0);
        lv_obj_set_style_border_color(cell[i], lv_color_hex(Theme::HUDDim), 0);
        lv_obj_set_style_pad_left(cell[i], 11, 0);
        lv_obj_set_style_pad_right(cell[i], 10, 0);
        lv_obj_set_style_pad_top(cell[i], 9, 0);
        lv_obj_set_style_pad_bottom(cell[i], 9, 0);
        lv_obj_set_style_pad_row(cell[i], 5, 0);
        lv_obj_clear_flag(cell[i], LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_flex_flow(cell[i], LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(cell[i], LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
        // Cells are PASSIVE status tiles: everything the user needs is shown inline as text
        // (name · state · tool · activity · meta) and awaiting cells expose explicit Approve/Deny
        // buttons. No tap-to-open detail overlay — it popped spuriously on stray/phantom touches
        // and a separate modal isn't needed when the card already carries the text. Non-clickable
        // so a phantom press on the cell body does nothing. (cellTapCb kept but never bound/fired.)
        lv_obj_clear_flag(cell[i], LV_OBJ_FLAG_CLICKABLE);
        (void)cellTapCb;  // retained for reference; intentionally not wired to a tap

        // Creature mark — top-right overlay, OUTSIDE the flex flow (IGNORE_LAYOUT) so it
        // never perturbs the text column's layout (nested layout churn is what black-
        // screened earlier builds). Tinted to the agent accent at render time.
        cellGlyph[i] = lv_image_create(cell[i]);
        lv_obj_add_flag(cellGlyph[i], LV_OBJ_FLAG_IGNORE_LAYOUT);
        lv_obj_add_flag(cellGlyph[i], LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_image_recolor_opa(cellGlyph[i], LV_OPA_COVER, 0);
        lv_obj_set_style_image_opa(cellGlyph[i], (lv_opa_t)235, 0);
        lv_obj_clear_flag(cellGlyph[i], LV_OBJ_FLAG_CLICKABLE);  // taps fall through to the cell

        // Name line: ●agent-name (bold) + colored [STATE] (one recolor label, no flex).
        cellName[i] = lv_label_create(cell[i]);
        lv_obj_set_style_text_color(cellName[i], lv_color_hex(Theme::HUDText), 0);
        lv_obj_set_style_text_font(cellName[i], &font_kr_16, 0);   // larger for legibility (D1)
        lv_label_set_recolor(cellName[i], true);
        lv_label_set_long_mode(cellName[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(cellName[i], 60);
        lv_label_set_text(cellName[i], "");

        // State pill chip — short content-sized rounded label (NOT a nested flex row, so it
        // stays layout-cheap). bg/text colored per state at render time.
        cellPill[i] = lv_label_create(cell[i]);
        lv_obj_set_style_text_font(cellPill[i], &font_kr_12, 0);
        lv_obj_set_style_text_color(cellPill[i], lv_color_hex(0x05140F), 0);
        lv_obj_set_style_bg_opa(cellPill[i], LV_OPA_COVER, 0);
        lv_obj_set_style_radius(cellPill[i], 8, 0);
        lv_obj_set_style_pad_left(cellPill[i], 8, 0);
        lv_obj_set_style_pad_right(cellPill[i], 8, 0);
        lv_obj_set_style_pad_top(cellPill[i], 2, 0);
        lv_obj_set_style_pad_bottom(cellPill[i], 2, 0);
        lv_label_set_long_mode(cellPill[i], LV_LABEL_LONG_CLIP);
        lv_label_set_text(cellPill[i], "");

        cellProj[i] = lv_label_create(cell[i]);
        lv_obj_set_style_text_color(cellProj[i], lv_color_hex(Theme::HUDDim), 0);
        lv_obj_set_style_text_font(cellProj[i], &font_kr_12, 0);
        lv_label_set_long_mode(cellProj[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(cellProj[i], 60);
        lv_label_set_text(cellProj[i], "");

        // Tool box: "▸ tool" in a bordered/filled box.
        cellTool[i] = lv_label_create(cell[i]);
        lv_obj_set_style_text_color(cellTool[i], lv_color_hex(Theme::HUDText), 0);
        lv_obj_set_style_text_font(cellTool[i], &font_kr_12, 0);
        lv_obj_set_style_bg_color(cellTool[i], lv_color_hex(0x07140F), 0);
        lv_obj_set_style_bg_opa(cellTool[i], (lv_opa_t)150, 0);
        lv_obj_set_style_border_width(cellTool[i], 1, 0);
        lv_obj_set_style_border_color(cellTool[i], lv_color_hex(Theme::HUDDim), 0);
        lv_obj_set_style_border_opa(cellTool[i], (lv_opa_t)90, 0);
        lv_obj_set_style_radius(cellTool[i], 6, 0);
        lv_obj_set_style_pad_left(cellTool[i], 7, 0);
        lv_obj_set_style_pad_right(cellTool[i], 7, 0);
        lv_obj_set_style_pad_top(cellTool[i], 4, 0);
        lv_obj_set_style_pad_bottom(cellTool[i], 4, 0);
        lv_label_set_long_mode(cellTool[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(cellTool[i], 60);
        lv_label_set_text(cellTool[i], "");

        cellBody[i] = lv_label_create(cell[i]);
        lv_obj_set_style_text_color(cellBody[i], lv_color_hex(Theme::HUDDim), 0);
        lv_obj_set_style_text_font(cellBody[i], &font_kr_12, 0);
        lv_label_set_long_mode(cellBody[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(cellBody[i], 60);
        lv_label_set_text(cellBody[i], "");

        // Footer: model · elapsed (faint).
        cellMeta[i] = lv_label_create(cell[i]);
        lv_obj_set_width(cellMeta[i], 60);
        lv_obj_set_style_text_color(cellMeta[i], lv_color_hex(Theme::HUDFaint), 0);
        lv_obj_set_style_text_font(cellMeta[i], &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_opa(cellMeta[i], (lv_opa_t)180, 0);
        lv_label_set_long_mode(cellMeta[i], LV_LABEL_LONG_DOT);
        lv_label_set_text(cellMeta[i], "");

        // Inline Approve/Deny — shown only on awaiting cells that are tall enough.
        cellYes[i] = lv_button_create(cell[i]);
        lv_obj_set_height(cellYes[i], 32);
        lv_obj_set_width(cellYes[i], LV_PCT(100));
        lv_obj_set_style_bg_color(cellYes[i], lv_color_hex(Theme::StatusAmber), 0);
        lv_obj_set_style_radius(cellYes[i], 7, 0);
        lv_obj_add_event_cb(cellYes[i], cellYesCb, LV_EVENT_CLICKED, (void*)(intptr_t)i);
        lv_obj_t* yesLbl = lv_label_create(cellYes[i]);
        lv_label_set_text(yesLbl, "Approve");
        lv_obj_set_style_text_color(yesLbl, lv_color_hex(0x1A1205), 0);
        lv_obj_center(yesLbl);
        lv_obj_add_flag(cellYes[i], LV_OBJ_FLAG_HIDDEN);

        cellNo[i] = lv_button_create(cell[i]);
        lv_obj_set_height(cellNo[i], 32);
        lv_obj_set_width(cellNo[i], LV_PCT(100));
        lv_obj_set_style_bg_color(cellNo[i], lv_color_hex(0x16413C), 0);
        lv_obj_set_style_radius(cellNo[i], 7, 0);
        lv_obj_add_event_cb(cellNo[i], cellNoCb, LV_EVENT_CLICKED, (void*)(intptr_t)i);
        lv_obj_t* noLbl = lv_label_create(cellNo[i]);
        lv_label_set_text(noLbl, "Deny");
        lv_obj_set_style_text_color(noLbl, lv_color_hex(Theme::HUDText), 0);
        lv_obj_center(noLbl);
        lv_obj_add_flag(cellNo[i], LV_OBJ_FLAG_HIDDEN);

        lv_obj_add_flag(cell[i], LV_OBJ_FLAG_HIDDEN);
    }

    // Usage lives solely in the full-width top bar (5H/7D gauges) on the D1 layout.
    // The old bottom "CLAUDE USAGE" panel was redundant with it, so it is not created
    // here. Leaving these null makes every `if (panelRight)` visibility guard below a
    // no-op, so nothing re-shows it at runtime.
    panelRight = nullptr;
    lblTankHeader = nullptr;

#elif IS_ROUND
    // === Round AMOLED layout: top status bar + bottom gauges ===

    // Top status bar — centered, narrow
    panelLeft = lv_obj_create(parent);
    lv_obj_set_size(panelLeft, 260, LV_SIZE_CONTENT);
    lv_obj_align(panelLeft, LV_ALIGN_TOP_MID, 0, 20);
    lv_obj_set_style_bg_color(panelLeft, lv_color_hex(0x000000), 0);
    lv_obj_set_style_bg_opa(panelLeft, LV_OPA_50, 0);
    lv_obj_set_style_border_width(panelLeft, 0, 0);
    lv_obj_set_style_radius(panelLeft, 12, 0);
    lv_obj_set_style_pad_top(panelLeft, 4, 0);
    lv_obj_set_style_pad_bottom(panelLeft, 4, 0);
    lv_obj_set_style_pad_left(panelLeft, 8, 0);
    lv_obj_set_style_pad_right(panelLeft, 8, 0);
    lv_obj_set_style_pad_row(panelLeft, 1, 0);
    lv_obj_clear_flag(panelLeft, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(panelLeft, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(panelLeft, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    // Logo text — smaller for round display
    lblLogo = lv_label_create(panelLeft);
    lv_obj_set_style_text_color(lblLogo, lv_color_hex(Theme::HUDText), 0);
    lv_obj_set_style_text_font(lblLogo, &lv_font_montserrat_14, 0);
    lv_label_set_text(lblLogo, "AgentDeck");

    // Accent underline
    logoLine = lv_obj_create(panelLeft);
    lv_obj_set_size(logoLine, 100, 2);
    lv_obj_set_style_bg_color(logoLine, lv_color_hex(Theme::StatusBlue), 0);
    lv_obj_set_style_bg_opa(logoLine, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(logoLine, 0, 0);
    lv_obj_set_style_radius(logoLine, 1, 0);
    lv_obj_set_style_pad_all(logoLine, 0, 0);
    lv_obj_clear_flag(logoLine, LV_OBJ_FLAG_SCROLLABLE);

    // Session list — compact, 1-line per session
    lblSessions = lv_label_create(panelLeft);
    lv_obj_set_style_text_color(lblSessions, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(lblSessions, &lv_font_montserrat_10, 0);
    lv_label_set_recolor(lblSessions, true);
    lv_label_set_text(lblSessions, "");
    lv_obj_set_width(lblSessions, 240);
    lv_obj_set_style_text_align(lblSessions, LV_TEXT_ALIGN_CENTER, 0);

    // Bottom gauge panel — centered at bottom of circle
    panelRight = lv_obj_create(parent);
    int panelW = GAUGE_SIZE * 2 + GAUGE_GAP + 16;
    lv_obj_set_size(panelRight, panelW, LV_SIZE_CONTENT);
    lv_obj_align(panelRight, LV_ALIGN_BOTTOM_MID, 0, -30);
    lv_obj_set_style_bg_color(panelRight, lv_color_hex(0x000000), 0);
    lv_obj_set_style_bg_opa(panelRight, LV_OPA_50, 0);
    lv_obj_set_style_border_width(panelRight, 0, 0);
    lv_obj_set_style_radius(panelRight, 12, 0);
    lv_obj_set_style_pad_top(panelRight, 3, 0);
    lv_obj_set_style_pad_bottom(panelRight, 4, 0);
    lv_obj_set_style_pad_left(panelRight, 8, 0);
    lv_obj_set_style_pad_right(panelRight, 8, 0);
    lv_obj_set_style_pad_row(panelRight, 1, 0);
    lv_obj_set_style_pad_column(panelRight, GAUGE_GAP, 0);
    lv_obj_clear_flag(panelRight, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(panelRight, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(panelRight, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    // No header for round — save space

    lblTankHeader = nullptr;

#else
    // === Rectangular layout: left panel + right panel ===

    // === Left panel: AgentDeck logo + sessions ===
    const bool portrait = !UI::isLandscape();
    panelLeft = lv_obj_create(parent);
#if defined(BOARD_TTGO)
    lv_obj_set_size(panelLeft, 110, LV_SIZE_CONTENT);
    lv_obj_set_pos(panelLeft, 6, 6);
#else
    if (portrait) {
        // Portrait: full-width panel at top
        lv_obj_set_size(panelLeft, g_screenW - 16, LV_SIZE_CONTENT);
        lv_obj_set_pos(panelLeft, 8, PANEL_TOP_Y);
    } else {
        lv_obj_set_size(panelLeft, 170, LV_SIZE_CONTENT);
        lv_obj_set_pos(panelLeft, 8, PANEL_TOP_Y);
    }
#endif
    lv_obj_set_style_bg_color(panelLeft, lv_color_hex(0x000000), 0);
    lv_obj_set_style_bg_opa(panelLeft, LV_OPA_50, 0);
    lv_obj_set_style_border_width(panelLeft, 0, 0);
    lv_obj_set_style_radius(panelLeft, 8, 0);
    lv_obj_set_style_pad_top(panelLeft, 6, 0);
    lv_obj_set_style_pad_bottom(panelLeft, 6, 0);
    lv_obj_set_style_pad_left(panelLeft, 8, 0);
    lv_obj_set_style_pad_right(panelLeft, 8, 0);
    lv_obj_set_style_pad_row(panelLeft, 2, 0);
    lv_obj_clear_flag(panelLeft, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(panelLeft, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(panelLeft, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    // Logo text — large, centered (like Android tablet/e-reader)
    lblLogo = lv_label_create(panelLeft);
    lv_obj_set_style_text_color(lblLogo, lv_color_hex(Theme::HUDText), 0);
#if defined(BOARD_TTGO)
    lv_obj_set_style_text_font(lblLogo, &lv_font_montserrat_14, 0);
#else
    lv_obj_set_style_text_font(lblLogo, &lv_font_montserrat_20, 0);
#endif
    lv_label_set_text(lblLogo, "AgentDeck");

    // Accent underline below logo
    logoLine = lv_obj_create(panelLeft);
#if defined(BOARD_TTGO)
    lv_obj_set_size(logoLine, 80, 2);
#else
    lv_obj_set_size(logoLine, 130, 2);
#endif
    lv_obj_set_style_bg_color(logoLine, lv_color_hex(Theme::StatusBlue), 0);
    lv_obj_set_style_bg_opa(logoLine, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(logoLine, 0, 0);
    lv_obj_set_style_radius(logoLine, 1, 0);
    lv_obj_set_style_pad_all(logoLine, 0, 0);
    lv_obj_clear_flag(logoLine, LV_OBJ_FLAG_SCROLLABLE);

    // Session list (recolor enabled for colored dots)
    lblSessions = lv_label_create(panelLeft);
    lv_obj_set_style_text_color(lblSessions, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(lblSessions, &font_kr_12, 0);
    lv_label_set_recolor(lblSessions, true);
    lv_label_set_text(lblSessions, "");
#if defined(BOARD_TTGO)
    lv_obj_set_width(lblSessions, 98);
#else
    lv_obj_set_width(lblSessions, 150);
#endif

    // === Right panel: Tank Status with water-fill gauges ===
    panelRight = lv_obj_create(parent);
    int panelW = GAUGE_SIZE * 2 + GAUGE_GAP + 16;
    lv_obj_set_size(panelRight, panelW, LV_SIZE_CONTENT);
#if defined(BOARD_TTGO)
    lv_obj_set_pos(panelRight, g_screenW - panelW - 6, 6);
#else
    if (portrait) {
        // Portrait: below left panel, aligned to bottom-right
        lv_obj_align(panelRight, LV_ALIGN_BOTTOM_RIGHT, -8, -8);
    } else {
        lv_obj_set_pos(panelRight, g_screenW - panelW - 8, PANEL_TOP_Y);
    }
#endif
    lv_obj_set_style_bg_color(panelRight, lv_color_hex(0x000000), 0);
    lv_obj_set_style_bg_opa(panelRight, LV_OPA_50, 0);
    lv_obj_set_style_border_width(panelRight, 0, 0);
    lv_obj_set_style_radius(panelRight, 8, 0);
    lv_obj_set_style_pad_top(panelRight, 3, 0);
    lv_obj_set_style_pad_bottom(panelRight, 0, 0);
    lv_obj_set_style_pad_left(panelRight, 8, 0);
    lv_obj_set_style_pad_right(panelRight, 8, 0);
    lv_obj_set_style_pad_row(panelRight, 1, 0);
    lv_obj_set_style_pad_column(panelRight, GAUGE_GAP, 0);
    lv_obj_clear_flag(panelRight, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(panelRight, LV_FLEX_FLOW_COLUMN);

    // Header
    lblTankHeader = lv_label_create(panelRight);
    lv_obj_set_style_text_color(lblTankHeader, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(lblTankHeader, &lv_font_montserrat_10, 0);
    lv_label_set_text(lblTankHeader, "TANK STATUS");
#endif

    // Gauge row (horizontal) — shared by both layouts
    lv_obj_t* gaugeRow = lv_obj_create(panelRight);
    lv_obj_set_size(gaugeRow, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(gaugeRow, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(gaugeRow, 0, 0);
    lv_obj_set_style_pad_all(gaugeRow, 0, 0);
    lv_obj_set_style_pad_column(gaugeRow, GAUGE_GAP, 0);
    lv_obj_set_style_pad_row(gaugeRow, 0, 0);
    lv_obj_clear_flag(gaugeRow, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(gaugeRow, LV_FLEX_FLOW_ROW);

    // Create two gauges side by side
    createGauge(gaugeRow, gauge5hBox, gauge5hFill, gauge5hPct, gauge5hPeriod, gauge5hReset, "5h");
    createGauge(gaugeRow, gauge7dBox, gauge7dFill, gauge7dPct, gauge7dPeriod, gauge7dReset, "7d");

    // Stale indicator (only shown when data is stale, hidden by default)
    lblStale = lv_label_create(panelRight);
    lv_obj_set_style_text_color(lblStale, lv_color_hex(Theme::StatusAmber), 0);
    lv_obj_set_style_text_font(lblStale, &lv_font_montserrat_10, 0);
    lv_label_set_text(lblStale, "");
    lv_obj_add_flag(lblStale, LV_OBJ_FLAG_HIDDEN);
}

// Helper: status color for AgentState
static uint32_t stateColor(AgentState st) {
    switch (st) {
        case AgentState::IDLE:                 return Theme::StatusGreen;
        case AgentState::PROCESSING:           return Theme::StatusBlue;
        case AgentState::AWAITING_PERMISSION:
        case AgentState::AWAITING_OPTION:
        case AgentState::AWAITING_DIFF:        return Theme::StatusAmber;
        default:                               return Theme::StatusRed;
    }
}

// Map session state string to color
static uint32_t sessionStateColor(const char* state) {
    if (strcmp(state, "idle") == 0)       return Theme::StatusGreen;
    if (strcmp(state, "processing") == 0) return Theme::StatusBlue;
    if (strstr(state, "awaiting") != nullptr) return Theme::StatusAmber;
    return Theme::HUDDim;
}

// Gauge color based on usage %
static uint32_t gaugeColor(float pct) {
    if (pct >= 90.0f) return Theme::StatusRed;
    if (pct >= 70.0f) return Theme::StatusAmber;
    return Theme::StatusGreen;
}

// Update a water-fill gauge. pct < 0 means "no data" (sentinel).
static void updateGauge(lv_obj_t* fill, lv_obj_t* pctLabel, lv_obj_t* resetLabel,
                        float pct, const char* resetStr, bool stale) {
    if (pct < 0.0f) {
        // No data — empty gauge, "--" text
        lv_obj_set_height(fill, 0);
        lv_obj_align(fill, LV_ALIGN_BOTTOM_MID, 0, 0);
        lv_obj_set_style_bg_color(fill, lv_color_hex(Theme::HUDDim), 0);
        lv_label_set_text(pctLabel, "--");
        lv_label_set_text(resetLabel, "");
        return;
    }

    // Fill height proportional to percentage (inside border)
    int fillH = (int)(GAUGE_INNER * pct / 100.0f);
    if (fillH < 0) fillH = 0;
    if (fillH > GAUGE_INNER) fillH = GAUGE_INNER;
    lv_obj_set_height(fill, fillH);
    lv_obj_align(fill, LV_ALIGN_BOTTOM_MID, 0, 0);

    // Fill color
    uint32_t color = gaugeColor(pct);
    lv_obj_set_style_bg_color(fill, lv_color_hex(color), 0);

    // Percentage text (append "!" when stale, matching Android behavior)
    char pctBuf[12];
    if (stale)
        snprintf(pctBuf, sizeof(pctBuf), "%d%%!", (int)pct);
    else
        snprintf(pctBuf, sizeof(pctBuf), "%d%%", (int)pct);
    lv_label_set_text(pctLabel, pctBuf);

    // Reset time below gauge
    if (resetStr[0]) {
        lv_label_set_text(resetLabel, resetStr);
    } else {
        lv_label_set_text(resetLabel, "");
    }
}

void update() {
    if (!panelLeft) return;

    lockState();
    bool hasData = g_state.dataReceived;
    float p5h = g_state.fiveHourPercent;
    float p7d = g_state.sevenDayPercent;
    char reset5h[20], reset7d[20];
    strncpy(reset5h, g_state.fiveHourReset, sizeof(reset5h) - 1);
    strncpy(reset7d, g_state.sevenDayReset, sizeof(reset7d) - 1);
    reset5h[sizeof(reset5h) - 1] = '\0';
    reset7d[sizeof(reset7d) - 1] = '\0';
    bool usageStale = g_state.usageStale;

    // Copy session list
    uint8_t sessionCount = hasData ? g_state.sessionCount : (uint8_t)0;
    SessionInfo sessions[10];
    memcpy(sessions, g_state.sessions, sizeof(sessions));

    // Fallback: if no sessions, use primary state
    AgentState primaryState = g_state.state;
    char primaryProject[40], primaryAgent[16];
    strncpy(primaryProject, g_state.projectName, sizeof(primaryProject) - 1);
    primaryProject[sizeof(primaryProject) - 1] = '\0';
    strncpy(primaryAgent, g_state.agentType, sizeof(primaryAgent) - 1);
    primaryAgent[sizeof(primaryAgent) - 1] = '\0';

    // HUD shows the OpenClaw label only when the Gateway is authenticated,
    // matching the creature gate. Reachability alone (`gatewayAvailable`)
    // used to light up an "OpenClaw" row even with no shared token.
    bool gateway = g_state.gatewayConnected;
    unlockState();

    // === Left panel: session list ===
    char buf[400];
    int pos = 0;

    if (sessionCount > 0) {
        // Show real session list from bridge
        for (uint8_t i = 0; i < sessionCount && i < 10; i++) {
            if (!sessions[i].alive) continue;

            // Pick color by agent type
            uint32_t dotColor = agentDotColor(sessions[i].agentType);

            // State color for status dot
            uint32_t sColor = sessionStateColor(sessions[i].state);

            // Format: colored-type-dot + project name + state dot
            pos += snprintf(buf + pos, sizeof(buf) - pos,
                "#%06lX " LV_SYMBOL_BULLET "# %s  #%06lX " LV_SYMBOL_BULLET "#\n",
                (unsigned long)dotColor,
                sessions[i].projectName[0] ? sessions[i].projectName : sessions[i].id,
                (unsigned long)sColor);
        }
    } else if (hasData) {
        // Fallback: show primary session info (only when real data received)
        uint32_t dotColor = agentDotColor(primaryAgent);
        uint32_t sColor = stateColor(primaryState);

        pos += snprintf(buf + pos, sizeof(buf) - pos,
            "#%06lX " LV_SYMBOL_BULLET "# %s  #%06lX " LV_SYMBOL_BULLET "#\n",
            (unsigned long)dotColor,
            primaryProject[0] ? primaryProject : "Agent",
            (unsigned long)sColor);
    } else {
        // No data yet — show connecting message
        pos += snprintf(buf + pos, sizeof(buf) - pos,
            "#808080 Connecting...#\n");
    }

    // Gateway indicator (if available but no openclaw session shown)
    if (gateway) {
        bool hasOC = false;
        for (uint8_t i = 0; i < sessionCount; i++) {
            if (sessions[i].alive && strstr(sessions[i].agentType, "openclaw") != nullptr) {
                hasOC = true;
                break;
            }
        }
        if (!hasOC) {
            pos += snprintf(buf + pos, sizeof(buf) - pos,
                "#%06lX " LV_SYMBOL_BULLET "# OpenClaw\n",
                (unsigned long)Theme::CrayfishShell);
        }
    }

    // Remove trailing newline
    if (pos > 0 && buf[pos - 1] == '\n') buf[pos - 1] = '\0';
    else buf[pos] = '\0';

    if (lblSessions) lv_label_set_text(lblSessions, buf);  // null on IPS10 (mosaic instead)

    // === Right panel: water-fill gauges ===
    updateGauge(gauge5hFill, gauge5hPct, gauge5hReset, p5h, reset5h, usageStale);
    updateGauge(gauge7dFill, gauge7dPct, gauge7dReset, p7d, reset7d, usageStale);

    // Stale indicator (shown only when we have data but it's stale)
    bool showStale = usageStale && (p5h >= 0.0f || p7d >= 0.0f);
    if (showStale) {
        lv_label_set_text(lblStale, "! stale");
        lv_obj_clear_flag(lblStale, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_label_set_text(lblStale, "");
        lv_obj_add_flag(lblStale, LV_OBJ_FLAG_HIDDEN);
    }

#if defined(BOARD_IPS10)
    // === Living agent mosaic — one cell per agent, height fluidly tracks activity,
    //     each cell narrates inline what that agent is doing. ===
    if (cellsBox) {
        struct MCell { uint32_t accent; uint32_t stateCol; char name[40]; char agent[16]; char state[20];
                       char model[32]; char tool[40]; uint32_t elapsed;
                       char sid[32]; char requestId[40]; char question[160]; };
        MCell mc[MOSAIC_MAX];
        int n = 0;
        char latestAction[48] = "";

        lockState();
        if (g_state.timelineCount > 0) {
            int li = (g_state.timelineHead + g_state.timelineCount - 1) % TIMELINE_MAX_ENTRIES;
            strncpy(latestAction, g_state.timeline[li].raw, sizeof(latestAction) - 1);
            latestAction[sizeof(latestAction) - 1] = '\0';
        }
        for (uint8_t s = 0; s < g_state.sessionCount && n < MOSAIC_MAX; s++) {
            if (!g_state.sessions[s].alive) continue;
            const SessionInfo& si = g_state.sessions[s];
            mc[n].accent = ips10AgentColor(si.agentType);
            mc[n].stateCol = ips10StateColor(si.state);
            strncpy(mc[n].name, si.projectName[0] ? si.projectName : si.id, sizeof(mc[n].name) - 1);
            mc[n].name[sizeof(mc[n].name) - 1] = '\0';
            strncpy(mc[n].agent, si.agentType, sizeof(mc[n].agent) - 1); mc[n].agent[sizeof(mc[n].agent) - 1] = '\0';
            strncpy(mc[n].state, si.state, sizeof(mc[n].state) - 1); mc[n].state[sizeof(mc[n].state) - 1] = '\0';
            strncpy(mc[n].model, si.modelName, sizeof(mc[n].model) - 1); mc[n].model[sizeof(mc[n].model) - 1] = '\0';
            strncpy(mc[n].tool, si.currentTool, sizeof(mc[n].tool) - 1); mc[n].tool[sizeof(mc[n].tool) - 1] = '\0';
            mc[n].elapsed = si.elapsedSec;
            strncpy(mc[n].sid, si.id, sizeof(mc[n].sid) - 1); mc[n].sid[sizeof(mc[n].sid) - 1] = '\0';
            strncpy(mc[n].requestId, si.requestId, sizeof(mc[n].requestId) - 1); mc[n].requestId[sizeof(mc[n].requestId) - 1] = '\0';
            strncpy(mc[n].question, si.question, sizeof(mc[n].question) - 1); mc[n].question[sizeof(mc[n].question) - 1] = '\0';
            n++;
        }
        bool hasOC = false;
        for (int i = 0; i < n; i++) if (strstr(mc[i].agent, "openclaw")) hasOC = true;
        if (g_state.gatewayConnected && !hasOC && n < MOSAIC_MAX) {
            mc[n].accent = Theme::CrayfishShell; mc[n].stateCol = Theme::StatusGreen;
            strcpy(mc[n].name, "OpenClaw"); strcpy(mc[n].agent, "openclaw");
            strcpy(mc[n].state, "idle"); mc[n].model[0] = '\0'; mc[n].tool[0] = '\0'; mc[n].elapsed = 0;
            mc[n].sid[0] = '\0'; mc[n].requestId[0] = '\0'; mc[n].question[0] = '\0'; n++;
        }
        if (n == 0 && hasData) {  // single-session fallback (no sessions_list yet)
            mc[0].accent = ips10AgentColor(g_state.agentType);
            const char* ps = (primaryState == AgentState::PROCESSING) ? "processing" :
                             (primaryState == AgentState::AWAITING_PERMISSION || primaryState == AgentState::AWAITING_OPTION ||
                              primaryState == AgentState::AWAITING_DIFF) ? "awaiting_permission" : "idle";
            mc[0].stateCol = ips10StateColor(ps);
            strncpy(mc[0].name, primaryProject[0] ? primaryProject : "Agent", sizeof(mc[0].name) - 1);
            mc[0].name[sizeof(mc[0].name) - 1] = '\0';
            strncpy(mc[0].agent, primaryAgent, sizeof(mc[0].agent) - 1); mc[0].agent[sizeof(mc[0].agent) - 1] = '\0';
            strncpy(mc[0].state, ps, sizeof(mc[0].state) - 1); mc[0].state[sizeof(mc[0].state) - 1] = '\0';
            strncpy(mc[0].tool, g_state.currentTool, sizeof(mc[0].tool) - 1); mc[0].tool[sizeof(mc[0].tool) - 1] = '\0';
            mc[0].model[0] = '\0'; mc[0].elapsed = g_state.sessionDurationSec;
            mc[0].sid[0] = '\0'; mc[0].requestId[0] = '\0';
            strncpy(mc[0].question, g_state.question, sizeof(mc[0].question) - 1); mc[0].question[sizeof(mc[0].question) - 1] = '\0';
            n = 1;
        }
        unlockState();

        for (int i = 0; i < n; i++) {  // protect recolor markup
            for (char* c = mc[i].name; *c; c++) if (*c == '#' || *c == '\n') *c = ' ';
            for (char* c = mc[i].tool; *c; c++) if (*c == '#' || *c == '\n') *c = ' ';
        }
        for (char* c = latestAction; *c; c++) if (*c == '#' || *c == '\n') *c = ' ';

        // Top-bar daemon status + office caption track the live agent count.
        bool linkUp = g_state.wsConnected || Net::serialConnected();
        if (tbDaemon) {
            char sb[64];
            snprintf(sb, sizeof(sb), "#%06lX " LV_SYMBOL_BULLET "# daemon " LV_SYMBOL_BULLET " %d agent%s " LV_SYMBOL_BULLET " %s",
                     (unsigned long)(linkUp ? D1_OK : D1_IDLE), n, n == 1 ? "" : "s",
                     g_state.wsConnected ? "ws" : (Net::serialConnected() ? "serial" : "offline"));
            lv_label_set_text(tbDaemon, sb);
        }
#if defined(IPS10_PERF_HUD)
        if (tbPerf) {
            char pb[80];
            snprintf(pb, sizeof(pb), "WORST %lums v%lu f%lu ppa%lu buf:%s",
                     (unsigned long)(g_perfWorstUs / 1000),
                     (unsigned long)(g_perfWorstView / 1000),
                     (unsigned long)(g_perfWorstFlush / 1000),
                     (unsigned long)(g_perfWorstInner / 1000),
                     g_bufInternal ? "INT" : "PSRAM");
            lv_label_set_text(tbPerf, pb);
        }
#endif
        // Top-bar 5h / 7d usage gauges (bar fill width + pct). p5h/p7d are 0..100
        // percent (same scale as g_state.fiveHourPercent / updateGauge); negative =
        // no data. The 92px track maps 0..100% → 0..92px.
        if (tb5hFill) {
            int w5 = p5h >= 0.0f ? (int)(p5h / 100.0f * 92.0f + 0.5f) : 0; if (w5 > 92) w5 = 92;
            lv_obj_set_width(tb5hFill, w5);
            lv_obj_set_style_bg_color(tb5hFill, lv_color_hex(p5h >= 85.0f ? D1_ATTN : D1_OK), 0);
            char pb[8]; if (p5h >= 0.0f) snprintf(pb, sizeof(pb), "%d%%", (int)(p5h + 0.5f)); else snprintf(pb, sizeof(pb), "-");
            if (tb5hPct) lv_label_set_text(tb5hPct, pb);
        }
        if (tb7dFill) {
            int w7 = p7d >= 0.0f ? (int)(p7d / 100.0f * 92.0f + 0.5f) : 0; if (w7 > 92) w7 = 92;
            lv_obj_set_width(tb7dFill, w7);
            lv_obj_set_style_bg_color(tb7dFill, lv_color_hex(p7d >= 85.0f ? D1_ATTN : D1_OK), 0);
            char pb[8]; if (p7d >= 0.0f) snprintf(pb, sizeof(pb), "%d%%", (int)(p7d + 0.5f)); else snprintf(pb, sizeof(pb), "-");
            if (tb7dPct) lv_label_set_text(tb7dPct, pb);
        }
        if (terrCount) {
            char tc[40]; snprintf(tc, sizeof(tc), "THE BULLPEN " LV_SYMBOL_BULLET " %d LIVE", n);
            lv_label_set_text(terrCount, tc);
        }

        // Use the KNOWN panel geometry, not lv_obj_get_content_width/height — those
        // return stale/partial values depending on layout timing, which made the
        // treemap fill only a small top-left corner of the (correctly-sized) region.
        int availW = ips10SidebarW - 30;                 // panel content width (− border/pad)
        int availH = lv_obj_get_content_height(cellsBox);
        if (availH < 320) availH = (g_screenH - 16) - 150;  // robust fallback (logo + usage bands)

        // Activity weights + descending order (bigger weight → placed first / larger tile).
        float weights[MOSAIC_MAX]; int order[MOSAIC_MAX]; float wsum = 0;
        for (int i = 0; i < n; i++) { weights[i] = ips10StateWeight(mc[i].state); wsum += weights[i]; order[i] = i; }
        if (wsum <= 0) wsum = 1;
        for (int a = 0; a < n; a++)
            for (int b = a + 1; b < n; b++)
                if (weights[order[b]] > weights[order[a]]) { int tmp = order[a]; order[a] = order[b]; order[b] = tmp; }

        // Squarified treemap (matches the D1 mockup): pack tiles so each stays as
        // close to square as possible — far better for the in-cell text than the old
        // slice-and-dice, which made full-height slivers in a wide pane.
        float tgtX[MOSAIC_MAX], tgtY[MOSAIC_MAX], tgtW[MOSAIC_MAX], tgtH[MOSAIC_MAX];
        float area[MOSAIC_MAX];
        for (int i = 0; i < n; i++) area[i] = (weights[i] / wsum) * (float)availW * (float)availH;

        float rx = 0, ry = 0, rw = (float)availW, rh = (float)availH;
        int rowStart = 0, k = 0;
        // Lay out order[a..b-1] as one row along the shorter side of the remaining rect.
        auto layoutRow = [&](int a, int b) {
            float s = 0; for (int j = a; j < b; j++) s += area[order[j]];
            if (s <= 0) return;
            if (rw >= rh) {                    // remaining rect is wide → stack row vertically in a left column
                float cw = s / (rh > 0 ? rh : 1); float cy = ry;
                for (int j = a; j < b; j++) { int gi = order[j]; float ch = area[gi] / (cw > 0 ? cw : 1);
                    tgtX[gi] = rx; tgtY[gi] = cy; tgtW[gi] = cw; tgtH[gi] = ch; cy += ch; }
                rx += cw; rw -= cw;
            } else {                           // remaining rect is tall → lay row horizontally along the top
                float ch = s / (rw > 0 ? rw : 1); float cx = rx;
                for (int j = a; j < b; j++) { int gi = order[j]; float cw = area[gi] / (ch > 0 ? ch : 1);
                    tgtX[gi] = cx; tgtY[gi] = ry; tgtW[gi] = cw; tgtH[gi] = ch; cx += cw; }
                ry += ch; rh -= ch;
            }
        };
        // Worst (largest) aspect ratio of order[a..b-1] laid along `side`.
        auto rowWorst = [&](int a, int b, float side) -> float {
            float s = 0, mn = 1e30f, mx = 0;
            for (int j = a; j < b; j++) { float v = area[order[j]]; s += v; if (v < mn) mn = v; if (v > mx) mx = v; }
            if (s <= 0 || side <= 0) return 1e30f;
            float s2 = s * s, sd2 = side * side;
            float r1 = sd2 * mx / s2, r2 = s2 / (sd2 * mn);
            return r1 > r2 ? r1 : r2;
        };
        while (k < n) {
            float side = (rw < rh) ? rw : rh;
            if (k > rowStart && rowWorst(rowStart, k, side) < rowWorst(rowStart, k + 1, side)) {
                layoutRow(rowStart, k);        // adding order[k] would worsen aspect → close row
                rowStart = k;
            } else {
                k++;                           // keep growing the row
            }
        }
        if (rowStart < n) layoutRow(rowStart, n);

        bool actionUsed = false;
        const float GAP = 6.0f;
        // Per-cell change signature: when a settled cell's content is unchanged we
        // skip ALL LVGL label/style churn, so the wide card region stops invalidating
        // every frame (that invalidation is what forces the costly per-frame flush).
        static uint32_t cellSig[MOSAIC_MAX] = {0};
        for (int i = 0; i < MOSAIC_MAX; i++) {
            if (i >= n) {
                if (!lv_obj_has_flag(cell[i], LV_OBJ_FLAG_HIDDEN)) lv_obj_add_flag(cell[i], LV_OBJ_FLAG_HIDDEN);
                cellInit[i] = false; cellSig[i] = 0; continue;
            }
            // SNAP to the treemap target (no per-frame lerp). A full cards-region re-render is
            // ~250 ms on this panel (LVGL re-traverses the whole widget tree per flush slice), so
            // a multi-frame lerp meant ~25 such re-renders per layout change → seconds of drag.
            // Snapping makes a layout change a single re-render: instant, not sluggish.
            cellCurX[i] = tgtX[i]; cellCurY[i] = tgtY[i]; cellCurW[i] = tgtW[i]; cellCurH[i] = tgtH[i];
            cellInit[i] = true;
            int px = (int)(cellCurX[i] + 0.5f), py = (int)(cellCurY[i] + 0.5f);
            int pw = (int)(cellCurW[i] - GAP + 0.5f); if (pw < 10) pw = 10;
            int ph = (int)(cellCurH[i] - GAP + 0.5f); if (ph < 10) ph = 10;

            // Persist cell data for the tap handler / detail overlay.
            CellMeta& cm = cellMetaData[i];
            strncpy(cm.sid, mc[i].sid, sizeof(cm.sid) - 1); cm.sid[sizeof(cm.sid) - 1] = '\0';
            strncpy(cm.requestId, mc[i].requestId, sizeof(cm.requestId) - 1); cm.requestId[sizeof(cm.requestId) - 1] = '\0';
            strncpy(cm.state, mc[i].state, sizeof(cm.state) - 1); cm.state[sizeof(cm.state) - 1] = '\0';
            strncpy(cm.question, mc[i].question, sizeof(cm.question) - 1); cm.question[sizeof(cm.question) - 1] = '\0';
            strncpy(cm.agent, mc[i].agent, sizeof(cm.agent) - 1); cm.agent[sizeof(cm.agent) - 1] = '\0';
            strncpy(cm.model, mc[i].model, sizeof(cm.model) - 1); cm.model[sizeof(cm.model) - 1] = '\0';
            strncpy(cm.name, mc[i].name, sizeof(cm.name) - 1); cm.name[sizeof(cm.name) - 1] = '\0';
            strncpy(cm.tool, mc[i].tool, sizeof(cm.tool) - 1); cm.tool[sizeof(cm.tool) - 1] = '\0';
            cm.elapsed = mc[i].elapsed; cm.accent = mc[i].accent;

            bool awaiting = (strstr(mc[i].state, "awaiting") != nullptr);
            bool working  = (strcmp(mc[i].state, "processing") == 0);
            bool idle     = (!awaiting && !working);
            bool linked   = (focusSid[0] && mc[i].sid[0] && strcmp(focusSid, mc[i].sid) == 0);

            lv_obj_clear_flag(cell[i], LV_OBJ_FLAG_HIDDEN);
            lv_obj_set_pos(cell[i], px, py);     // LVGL no-ops these when unchanged (settled)
            lv_obj_set_size(cell[i], pw, ph);

            // Change signature (content + size + focus). Skip label churn when unchanged.
            uint32_t sig = 2166136261u;
            for (const char* s = mc[i].state;    *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (const char* s = mc[i].name;     *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (const char* s = mc[i].tool;     *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (const char* s = mc[i].model;    *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (const char* s = mc[i].question; *s; s++) sig = sig * 31u + (uint8_t)*s;
            sig ^= (uint32_t)mc[i].elapsed + (uint32_t)(pw * 131) + (uint32_t)(ph * 17) + (linked ? 7u : 0u);
            if (sig == cellSig[i]) continue;     // settled + unchanged → no LVGL work
            cellSig[i] = sig;

            // accent rail = STATE colour (data.js: the cell's --accent is the state, so awaiting
            // reads amber, working cyan, etc. at a glance); the agent identity is the glyph.
            // Focus just thickens the same rail.
            lv_obj_set_style_border_width(cell[i], linked ? 4 : 3, 0);
            lv_obj_set_style_border_color(cell[i], lv_color_hex(mc[i].stateCol), 0);

            int innerW = pw - 24; if (innerW < 24) innerW = 24;

            // Creature mark — top-right overlay, tinted to the agent accent, sized to the
            // cell (32–60px). Skipped on tiny cells and for agents with no mask (unknown).
            const lv_image_dsc_t* gdsc = ips10AgentGlyph(mc[i].agent);
            int glyphSz = 0;
            if (gdsc && pw >= 92 && ph >= 52) {
                glyphSz = (pw < ph ? pw : ph) * 42 / 100;
                if (glyphSz < 32) glyphSz = 32;
                if (glyphSz > 60) glyphSz = 60;
                lv_image_set_src(cellGlyph[i], gdsc);
                lv_obj_set_style_image_recolor(cellGlyph[i], lv_color_hex(mc[i].accent), 0);
                lv_image_set_scale(cellGlyph[i], 256 * glyphSz / 64);   // 64px mask → glyphSz px
                lv_obj_align(cellGlyph[i], LV_ALIGN_TOP_RIGHT, -8, 6);
                lv_obj_clear_flag(cellGlyph[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellGlyph[i], LV_OBJ_FLAG_HIDDEN);
            }

            int nameW = innerW - (glyphSz ? glyphSz + 8 : 0); if (nameW < 24) nameW = 24;
            lv_obj_set_width(cellName[i], nameW);
            lv_obj_set_width(cellProj[i], innerW);
            lv_obj_set_width(cellTool[i], innerW);
            lv_obj_set_width(cellBody[i], innerW);
            lv_obj_set_width(cellMeta[i], innerW);

            // name line: ●agent-name — state now lives in the pill chip below.
            char nb[64];
            snprintf(nb, sizeof(nb), "#%06lX " LV_SYMBOL_BULLET "# %s",
                     (unsigned long)mc[i].accent, ips10AgentLabel(mc[i].agent));
            lv_label_set_text(cellName[i], nb);

            // state pill chip — bright states get dark text; the dim idle bg gets light text.
            if (ph >= 44) {
                lv_label_set_text(cellPill[i], ips10StatePill(mc[i].state));
                lv_obj_set_style_bg_color(cellPill[i], lv_color_hex(mc[i].stateCol), 0);
                lv_obj_set_style_text_color(cellPill[i],
                    lv_color_hex(idle ? Theme::HUDText : 0x05140F), 0);
                lv_obj_set_style_bg_opa(cellPill[i], idle ? (lv_opa_t)90 : LV_OPA_COVER, 0);
                lv_obj_clear_flag(cellPill[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellPill[i], LV_OBJ_FLAG_HIDDEN);
            }

            // project (dim) — its own line under the name
            if (ph >= 56 && mc[i].name[0]) {
                lv_label_set_text(cellProj[i], mc[i].name);
                lv_obj_clear_flag(cellProj[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellProj[i], LV_OBJ_FLAG_HIDDEN);
            }

            // tool box (working/awaiting, when there's room)
            if (!idle && mc[i].tool[0] && ph >= 80) {
                char tb[64]; snprintf(tb, sizeof(tb), LV_SYMBOL_PLAY " %s", mc[i].tool);
                lv_label_set_text(cellTool[i], tb);
                lv_obj_clear_flag(cellTool[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellTool[i], LV_OBJ_FLAG_HIDDEN);
            }

            // body: awaiting → prompt; working → latest reasoning/timeline line
            const char* body = "";
            if (awaiting && mc[i].question[0]) body = mc[i].question;
            else if (working && latestAction[0] && !actionUsed) { body = latestAction; actionUsed = true; }
            if (!idle && body[0] && ph >= 104) {
                lv_label_set_text(cellBody[i], body);
                lv_obj_clear_flag(cellBody[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellBody[i], LV_OBJ_FLAG_HIDDEN);
            }

            // inline Approve/Deny (awaiting permission/diff with room)
            bool showButtons = awaiting && strcmp(mc[i].state, "awaiting_option") != 0 && ph >= 132 && pw >= 130;
            if (showButtons) {
                lv_obj_clear_flag(cellYes[i], LV_OBJ_FLAG_HIDDEN);
                lv_obj_clear_flag(cellNo[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellYes[i], LV_OBJ_FLAG_HIDDEN);
                lv_obj_add_flag(cellNo[i], LV_OBJ_FLAG_HIDDEN);
            }

            // footer: model · elapsed (idle cards show just header + this). Hidden when
            // the inline buttons own the space.
            char el[12]; ips10FormatElapsed(mc[i].elapsed, el, sizeof(el));
            if (!showButtons && ph >= 64 && (mc[i].model[0] || el[0])) {
                char fb[56];
                if (mc[i].model[0] && el[0]) snprintf(fb, sizeof(fb), "%s " LV_SYMBOL_BULLET " %s", mc[i].model, el);
                else if (mc[i].model[0])     snprintf(fb, sizeof(fb), "%s", mc[i].model);
                else                         snprintf(fb, sizeof(fb), "%s", el);
                lv_label_set_text(cellMeta[i], fb);
                lv_obj_clear_flag(cellMeta[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellMeta[i], LV_OBJ_FLAG_HIDDEN);
            }
        }
        // Keep an open detail overlay in sync with live state — but THROTTLED, not per frame.
        // detailRefresh() rebuilds the whole panel (title/sub/action + a 640-char timeline log
        // + footer buttons) and re-lays-out its labels; doing that every frame pegged the main
        // loop while the modal was open, which made closing it feel laggy. ~400ms is plenty for
        // a status panel and frees the loop for snappy input/close. (detailOpen still refreshes
        // immediately, so opening is instant.)
        if (detailCellIdx >= 0) {
            static uint32_t lastDetailRefreshMs = 0;
            uint32_t nowMs = (uint32_t)millis();
            if (nowMs - lastDetailRefreshMs >= 400) { lastDetailRefreshMs = nowMs; detailRefresh(); }
        }
    }
#endif

    bool connected = hasData && (g_state.wsConnected || Net::serialConnected());
    bool showTankStatus = connected && (p5h >= 0.0f || p7d >= 0.0f);
    if (firstUpdate || showTankStatus != lastShowTankStatus) {
        firstUpdate = false;
        lastShowTankStatus = showTankStatus;

        if (showTankStatus) {
            if (panelRight && visible) {
                lv_obj_clear_flag(panelRight, LV_OBJ_FLAG_HIDDEN);
            }
#if !IS_ROUND && !defined(BOARD_IPS10)   // IPS10 has a fixed D1 cards position (set in init); don't re-align
            if (UI::isLandscape()) {
#if defined(BOARD_TTGO)
                lv_obj_align(panelLeft, LV_ALIGN_TOP_LEFT, 6, 6);
#else
                lv_obj_align(panelLeft, LV_ALIGN_TOP_LEFT, 8, PANEL_TOP_Y);
#endif
            }
#endif
        } else {
            if (panelRight) {
                lv_obj_add_flag(panelRight, LV_OBJ_FLAG_HIDDEN);
            }
#if !IS_ROUND && !defined(BOARD_IPS10)   // IPS10 keeps its fixed D1 cards position
            if (UI::isLandscape()) {
#if defined(BOARD_TTGO)
                lv_obj_align(panelLeft, LV_ALIGN_TOP_MID, 0, 6);
#else
                lv_obj_align(panelLeft, LV_ALIGN_TOP_MID, 0, PANEL_TOP_Y);
#endif
            }
#endif
        }
    }
}

void setVisible(bool v) {
    visible = v;
    if (panelLeft) {
        if (v) {
            lv_obj_clear_flag(panelLeft, LV_OBJ_FLAG_HIDDEN);
            if (lastShowTankStatus && panelRight) {
                lv_obj_clear_flag(panelRight, LV_OBJ_FLAG_HIDDEN);
            }
        } else {
            lv_obj_add_flag(panelLeft, LV_OBJ_FLAG_HIDDEN);
            if (panelRight) {
                lv_obj_add_flag(panelRight, LV_OBJ_FLAG_HIDDEN);
            }
        }
    }
}

bool isVisible() {
    return visible;
}

}  // namespace HUD
