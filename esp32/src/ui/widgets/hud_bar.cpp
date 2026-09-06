#include "hud_bar.h"
#include "../theme.h"
#include "../display.h"
#include "../assets/logo.h"
#include "../../state/agent_state.h"
#include "../../util/usage_format.h"
#include "../../util/utf8.h"
#include "../agent_label.h"
#include "config.h"
#include "net/serial_client.h"
#include "net/ws_client.h"
#if defined(BOARD_HAS_VOICE_CAPTURE)
#include "../../audio/mic_capture.h"
#endif
#if defined(BOARD_HAS_SPEAKER)
#include "../../audio/speaker_playback.h"   // playTone press/sent feedback
#endif
#if defined(BOARD_SPK_CODEC_ES8311)
#include "../../audio/es8311_codec.h"       // volume steppers
#endif
#include <Arduino.h>
#include <cstdarg>

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

#if !defined(BOARD_IPS10)
static void appendBounded(char* buf, size_t len, size_t& pos, const char* fmt, ...) {
    if (!buf || len == 0) return;
    if (pos >= len) {
        buf[len - 1] = '\0';
        return;
    }

    va_list args;
    va_start(args, fmt);
    int written = vsnprintf(buf + pos, len - pos, fmt, args);
    va_end(args);

    if (written < 0) {
        buf[pos] = '\0';
        return;
    }
    const size_t used = (size_t)written;
    if (used >= len - pos) {
        pos = len - 1;
        buf[pos] = '\0';
    } else {
        pos += used;
    }
}
#endif

#if defined(BOARD_IPS10)
#include "collaboration_layout.h"
// === IPS10 (800×1280) tablet sidebar: a LIVING AGENT MOSAIC ===
// One cell per active agent; each cell's height fluidly grows when the agent is working
// and shrinks when idle, and shows inline what that agent is doing. Replaces the static
// session list + separate timeline with a single dynamic surface.
static lv_obj_t* lblLogoImg = nullptr;
static lv_obj_t* lblStatus  = nullptr;   // header status line: "● N sessions · serial/ws"
static lv_obj_t* terrCount  = nullptr;   // "N LIVE" caption over the terrarium
// D1 full-width top bar (brand · daemon status · 5h/7d usage gauges).
static constexpr int IPS10_TOPBAR_H = 56;
// Usage bar track width — compact 2-row blocks (5H over 7D) keep the bar narrow,
// so the track shrinks to 48 and two windows still fit on one block.
static constexpr int TB_BAR_W = 48;
static lv_obj_t* tbDaemon  = nullptr;    // "● daemon :9120 · N agents"
#if defined(IPS10_PERF_HUD)
static lv_obj_t* tbPerf    = nullptr;    // worst-frame perf overlay (debug)
#endif
static lv_obj_t* tb5hFill  = nullptr;    // 5h usage bar fill (Claude)
static lv_obj_t* tb7dFill  = nullptr;    // 7d usage bar fill (Claude)
static lv_obj_t* tb5hPct   = nullptr;    // "62% 2h13m"
static lv_obj_t* tb7dPct   = nullptr;
// Codex (ChatGPT) usage gauges — mirror the Claude 5h/7d pair, blue-tinted.
// The whole group hides when no Codex limits are present (common case).
static lv_obj_t* tbCodexBlock = nullptr; // whole Codex block (hide when no data at all)
static lv_obj_t* tbCx5hGrp = nullptr;    // per-window ROW (hide when that window is absent)
static lv_obj_t* tbCx7dGrp = nullptr;
static lv_obj_t* tbCx5hFill = nullptr;
static lv_obj_t* tbCx7dFill = nullptr;
static lv_obj_t* tbCx5hPct  = nullptr;
static lv_obj_t* tbCx7dPct  = nullptr;
// Antigravity chip (brand mark + plan name, e.g. "Pro") — hidden when no data.
static lv_obj_t* tbAgIcon   = nullptr;
static lv_obj_t* tbAg       = nullptr;
// Leading agent icons before the gauge pairs (Codex icon hides with its gauges).
static lv_obj_t* tbCodexIcon = nullptr;
#include "../terrarium/creature_glyphs_generated.h"  // canonical agent-mark masks
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
// Allocated by LVGL once at init, one short census label per existing card.
// No per-frame heap object creation; values are bounded in the session snapshot.
static lv_obj_t* cellCoord[MOSAIC_MAX] = {nullptr};
// 960 bytes of IPS10-only static text, reused instead of lv_label_set_text's
// heap copy on every census change. The ten label widgets live with the HUD.
static char cellCoordText[MOSAIC_MAX][96] = {};
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
// label cards had lost. Unknown agents have no glyph → their cell hides the image (dot fallback in name).
static lv_obj_t* cellGlyph[MOSAIC_MAX] = {nullptr};   // creature mark overlay (IGNORE_LAYOUT)
static lv_obj_t* cellPill[MOSAIC_MAX]  = {nullptr};   // state pill chip (content-sized label)

// Runtime-built A8 image descriptors for the three creature glyphs we have masks for.
static lv_image_dsc_t glyphOctopus;    // Claude
static lv_image_dsc_t glyphCrayfish;   // OpenClaw
static lv_image_dsc_t glyphOpencode;   // OpenCode
static lv_image_dsc_t glyphAntigravityColor; // Antigravity full-color mark
static lv_image_dsc_t glyphCodex;      // Codex (cloud + >_ mark)
static lv_image_dsc_t glyphKiro;       // Kiro (ghost mark, design/brand/kiro.svg)
static uint8_t glyphAntigravityColorData[64 * 64 * 3]; // RGB565 plane + A8 plane, IPS10-only static reuse.
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
static uint32_t ips10AntigravityGradientColor(int x, int y, int w, int h) {
    const int nx = (w > 1) ? (x * 255 / (w - 1)) : 0;
    const int ny = (h > 1) ? (y * 255 / (h - 1)) : 0;
    if (ny < 76) {
        if (nx < 112) return Theme::AntigravityYellow;
        return (nx > 174) ? Theme::AntigravityRed : Theme::AntigravityOrange;
    }
    if (ny > 184) {
        return (nx < 112) ? Theme::AntigravityCyan : Theme::AntigravityBlue;
    }
    if (nx < 82) return Theme::AntigravityGreen;
    if (nx > 174) return (ny < 148) ? Theme::AntigravityRed : Theme::AntigravityPurple;
    return Theme::AntigravityCyan;
}
static void ips10BuildAntigravityColorGlyph() {
    using namespace CreatureGlyphs;
    const int w = ANTIGRAVITY_W;
    const int h = ANTIGRAVITY_H;
    uint8_t* rgb = glyphAntigravityColorData;
    uint8_t* a8 = glyphAntigravityColorData + (w * h * 2);
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            const int i = y * w + x;
            const uint32_t c = ips10AntigravityGradientColor(x, y, w, h);
            const uint16_t c565 = RGB565((uint8_t)(c >> 16), (uint8_t)(c >> 8), (uint8_t)c);
            rgb[i * 2 + 0] = (uint8_t)(c565 & 0xff);
            rgb[i * 2 + 1] = (uint8_t)(c565 >> 8);
            a8[i] = ANTIGRAVITY_A8[i];
        }
    }
    glyphAntigravityColor.header.magic  = LV_IMAGE_HEADER_MAGIC;
    glyphAntigravityColor.header.cf     = LV_COLOR_FORMAT_RGB565A8;
    glyphAntigravityColor.header.flags  = 0;
    glyphAntigravityColor.header.w      = w;
    glyphAntigravityColor.header.h      = h;
    glyphAntigravityColor.header.stride = (uint32_t)(w * 2);
    glyphAntigravityColor.data_size     = (uint32_t)(w * h * 3);
    glyphAntigravityColor.data          = glyphAntigravityColorData;
}
static void ips10InitGlyphs() {
    if (glyphsReady) return;
    using namespace CreatureGlyphs;
    ips10BuildGlyph(glyphOctopus,  OCTOPUS_A8,       OCTOPUS_W,       OCTOPUS_H);
    // Full official OpenClaw mark, rasterized directly from design/brand/openclaw.svg.
    ips10BuildGlyph(glyphCrayfish, OPENCLAW_MARK_A8, OPENCLAW_MARK_W, OPENCLAW_MARK_H);
    ips10BuildGlyph(glyphOpencode, OPENCODE_A8,      OPENCODE_W,      OPENCODE_H);
    ips10BuildAntigravityColorGlyph();
    ips10BuildGlyph(glyphCodex,    CODEX_A8,         CODEX_W,         CODEX_H);
    ips10BuildGlyph(glyphKiro,     KIRO_A8,          KIRO_W,          KIRO_H);
    glyphsReady = true;
}
static bool ips10IsAntigravityAgent(const char* agentType) {
    return agentType && strstr(agentType, "antigravity") != nullptr;
}
// Map an agent type to its glyph descriptor (null → no glyph, i.e. unknown agent).
static const lv_image_dsc_t* ips10AgentGlyph(const char* agentType) {
    if (!agentType) return nullptr;
    if (strstr(agentType, "openclaw"))  return &glyphCrayfish;
    if (strstr(agentType, "opencode"))  return &glyphOpencode;
    if (strstr(agentType, "antigravity")) return &glyphAntigravityColor;
    if (strstr(agentType, "codex"))     return &glyphCodex;
    if (strstr(agentType, "claude"))    return &glyphOctopus;
    if (strstr(agentType, "kiro"))      return &glyphKiro;
    return nullptr;   // unknown agent → dot fallback in the name line
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

#if defined(BOARD_IPS10) && defined(BOARD_HAS_VOICE_CAPTURE)
// Board-local voice target: which session hears the next hold-to-talk. Set by
// tapping a session card, cleared by tapping the same card again (back to
// auto = daemon focus → first live session). Deliberately NOT sent upstream as
// focus_session — a wall panel picking a mic target must not steal the
// daemon-wide focus that every other surface renders.
static char voiceTargetSid[32] = "";
static char voiceTargetName[40] = "";
#endif

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
    if (strstr(agentType, "opencode") != nullptr) return Theme::OpenCodeInner; // Use dark grey instead of light off-white on white cards
    if (strstr(agentType, "antigravity") != nullptr) return Theme::AntigravityCyan;
    if (strstr(agentType, "claude") != nullptr) return Theme::ClaudeBody;
    if (strstr(agentType, "kiro") != nullptr) return Theme::KiroMark;
    return Theme::HUDDim;
}
// D1 "Tide Bento" semantic state tokens (docs/design/tenin/screen.css :root):
//   --ok #52D988 (working) · --attn #FFA93D (awaiting) · --error #FF6B6B · --faint #5D7470 (idle)
// Product-UI bright STATE palette — data.js SSOT (tenin/data.js STATE.*.color).
static constexpr uint32_t D1_OK    = 0x3ED6E8;  // processing (cyan)
static constexpr uint32_t D1_ATTN  = 0xFFA93D;  // awaiting
static constexpr uint32_t D1_ERROR = 0xFF6B6B;  // error
static constexpr uint32_t D1_IDLE  = 0x7A8A9C;  // idle
static constexpr uint32_t D1_CODEX = 0x6166E0;  // Codex brand blue (Brand.codex)
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
// Bold agent label for the card header (the project name goes on its own dim
// line). Deliberately NOT a local map: this was one, it predated Kiro, and a
// Kiro session rendered its card header as the generic "Agent" while the desk
// beside it — which reads a different copy — said "Kiro". agent_label.h names
// this exact surface as its consumer and the file already includes it, so the
// local copy was shadowing the SSOT rather than filling a gap.
static const char* ips10AgentLabel(const char* agentType) {
    return agentShortLabel(agentType);
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

// Per-provider tank groups: each = a brand-coloured header ("● CLAUDE" / "● CODEX")
// over its 5h/7d water tanks. The group is the hide unit, so 1 or 2 providers lay
// out cohesively and the panel simply grows a second block when Codex data arrives.
// IPS10 renders usage in its D1 topbar instead — the whole tank panel is
// !BOARD_IPS10 only.
static lv_obj_t* claudeGroup = nullptr;
static lv_obj_t* codexGroup  = nullptr;

// Claude 5h / 7d tanks
static lv_obj_t* gauge5hBox = nullptr;
static lv_obj_t* gauge5hFill = nullptr;
static lv_obj_t* gauge5hPct = nullptr;
static lv_obj_t* gauge5hPeriod = nullptr;
static lv_obj_t* gauge5hReset = nullptr;
static lv_obj_t* gauge7dBox = nullptr;
static lv_obj_t* gauge7dFill = nullptr;
static lv_obj_t* gauge7dPct = nullptr;
static lv_obj_t* gauge7dPeriod = nullptr;
static lv_obj_t* gauge7dReset = nullptr;

// Codex 5h / 7d tanks (same water-tank widget, blue-headed group)
static lv_obj_t* gaugeCx5hBox = nullptr;
static lv_obj_t* gaugeCx5hFill = nullptr;
static lv_obj_t* gaugeCx5hPct = nullptr;
static lv_obj_t* gaugeCx5hPeriod = nullptr;
static lv_obj_t* gaugeCx5hReset = nullptr;
static lv_obj_t* gaugeCx7dBox = nullptr;
static lv_obj_t* gaugeCx7dFill = nullptr;
static lv_obj_t* gaugeCx7dPct = nullptr;
static lv_obj_t* gaugeCx7dPeriod = nullptr;
static lv_obj_t* gaugeCx7dReset = nullptr;

// Stale indicator
static lv_obj_t* lblStale = nullptr;

#if !defined(BOARD_IPS10)
// Account chip (styled pill) — shortened Antigravity plan ("AGY Pro") + any
// subscription expiries. Hidden when the daemon supplies none (e.g. the App Store
// Swift daemon exposes no subscription/Antigravity data). The raw Antigravity
// credit count is never shown (meaningless at a glance).
static lv_obj_t* acctChip = nullptr;
static lv_obj_t* acctChipLabel = nullptr;
#endif

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
    if (agentType && strstr(agentType, "antigravity") != nullptr) {
        return Theme::AntigravityCyan;
    }
    if (agentType && strstr(agentType, "claude-code") != nullptr) {
        return Theme::ClaudeBody;
    }
    return Theme::HUDDim;
}

namespace HUD {

// Helper: create a water-fill gauge column: [gauge box] + "1h 55m".
// Returns the column wrapper so callers can hide the whole gauge as a unit
// (e.g. hide the Claude pair when only Codex data is present).
static lv_obj_t* createGauge(lv_obj_t* parent,
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
    return col;
}

// Provider tank group: a brand-coloured header ("● CLAUDE") stacked over a row of
// the provider's 5h/7d water tanks. Returned container is the hide unit. Keeps the
// existing tank aesthetic while making the provider unambiguous (matches the IPS10
// "brand mark conveys the provider, labels stay 5h/7d" convention).
static lv_obj_t* makeTankGroup(lv_obj_t* parent, const char* name, uint32_t brandColor,
                               lv_obj_t*& b5, lv_obj_t*& f5, lv_obj_t*& p5, lv_obj_t*& pe5, lv_obj_t*& r5,
                               lv_obj_t*& b7, lv_obj_t*& f7, lv_obj_t*& p7, lv_obj_t*& pe7, lv_obj_t*& r7) {
    lv_obj_t* grp = lv_obj_create(parent);
    lv_obj_set_size(grp, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(grp, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(grp, 0, 0);
    lv_obj_set_style_pad_all(grp, 0, 0);
    lv_obj_set_style_pad_row(grp, 2, 0);
    lv_obj_clear_flag(grp, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(grp, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(grp, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    // Brand header: coloured dot + provider name
    lv_obj_t* hdr = lv_label_create(grp);
    lv_obj_set_style_text_font(hdr, &lv_font_montserrat_10, 0);
    lv_label_set_recolor(hdr, true);
    char h[48];
    snprintf(h, sizeof(h), "#%06lX " LV_SYMBOL_BULLET "# #%06lX %s#",
             (unsigned long)brandColor, (unsigned long)brandColor, name);
    lv_label_set_text(hdr, h);

    // Tanks row (5h + 7d side by side)
    lv_obj_t* row = lv_obj_create(grp);
    lv_obj_set_size(row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(row, 0, 0);
    lv_obj_set_style_pad_all(row, 0, 0);
    lv_obj_set_style_pad_column(row, GAUGE_GAP, 0);
    lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    createGauge(row, b5, f5, p5, pe5, r5, "5h");
    createGauge(row, b7, f7, p7, pe7, r7, "7d");
    return grp;
}

#if defined(BOARD_IPS10)
// Delegates to the shared LVGL-text sanitizer (util/utf8.h) — one map for
// every LVGL surface, so the knob and the mosaic can never drift.
static void sanitizeIps10Text(char* s) {
    Utf8::sanitizeLvglText(s);
}

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
    // Awaiting is display-only: btnA is a plain "Close", so it just dismisses.
    // Only processing keeps an actionable Interrupt.
    if (strcmp(m.state, "processing") == 0 && m.sid[0]) {
        char buf[160];
        snprintf(buf, sizeof(buf),
                 "{\"type\":\"session_command\",\"sessionId\":\"%s\",\"command\":{\"type\":\"interrupt\"}}", m.sid);
        hudSendJson(buf);
    }
    detailClose();
}
static void detailBtnBCb(lv_event_t* e) {
    (void)e;
    // btnB is only shown for processing ("Close"); awaiting no longer exposes a
    // Deny. Always just dismiss.
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

    // Scrollable container for the terminal-like log feed to prevent truncation
    lv_obj_t* logScroll = lv_obj_create(detailPanel);
    lv_obj_set_width(logScroll, LV_PCT(100));
    lv_obj_set_flex_grow(logScroll, 1);
    lv_obj_set_style_bg_color(logScroll, lv_color_hex(0x07140F), 0);
    lv_obj_set_style_bg_opa(logScroll, (lv_opa_t)150, 0);
    lv_obj_set_style_border_width(logScroll, 0, 0);
    lv_obj_set_style_radius(logScroll, 9, 0);
    lv_obj_set_style_pad_all(logScroll, 10, 0);
    lv_obj_set_scroll_dir(logScroll, LV_DIR_VER);

    detailLog = lv_label_create(logScroll);
    lv_obj_set_style_text_color(detailLog, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(detailLog, &font_kr_12, 0);
    lv_label_set_recolor(detailLog, true);
    lv_label_set_long_mode(detailLog, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(detailLog, LV_PCT(100));
    lv_obj_set_height(detailLog, LV_SIZE_CONTENT);

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
    char titleBuf[64];
    strncpy(titleBuf, m.name[0] ? m.name : "Session", sizeof(titleBuf) - 1);
    titleBuf[sizeof(titleBuf) - 1] = '\0';
    sanitizeIps10Text(titleBuf);
    lv_label_set_text(detailTitle, titleBuf);

    char sub[96];
    snprintf(sub, sizeof(sub), "#%06lX %s# " LV_SYMBOL_BULLET " %s", (unsigned long)m.accent,
             m.agent[0] ? m.agent : "agent", m.model[0] ? m.model : "");
    lv_label_set_text(detailSub, sub);

    bool awaiting = (strstr(m.state, "awaiting") != nullptr);
    char actionBuf[256];
    if (awaiting && m.question[0]) {
        strncpy(actionBuf, m.question, sizeof(actionBuf) - 1);
        actionBuf[sizeof(actionBuf) - 1] = '\0';
        sanitizeIps10Text(actionBuf);
        lv_label_set_text(detailAction, actionBuf);
    } else if (m.tool[0]) {
        char t[64]; snprintf(t, sizeof(t), LV_SYMBOL_PLAY " %s", m.tool);
        strncpy(actionBuf, t, sizeof(actionBuf) - 1);
        actionBuf[sizeof(actionBuf) - 1] = '\0';
        sanitizeIps10Text(actionBuf);
        lv_label_set_text(detailAction, actionBuf);
    } else {
        lv_label_set_text(detailAction, ips10StatePhrase(m.state));
    }

    // Activity log — this session's timeline entries (oldest → newest).
    static char logbuf[2048]; int lp = 0; logbuf[0] = '\0';
    lockState();
    for (uint8_t i = 0; i < g_state.timelineCount; i++) {
        uint8_t idx = (g_state.timelineHead + i) % TIMELINE_MAX_ENTRIES;
        const TimelineEntry& te = g_state.timeline[idx];
        if (m.sid[0] && te.sessionId[0] && strcmp(te.sessionId, m.sid) != 0) continue;
        int hh = te.ts / 3600, mm = (te.ts % 3600) / 60;
        int w = snprintf(logbuf + lp, sizeof(logbuf) - lp, "%02d:%02d  %s\n", hh, mm, te.raw);
        if (w < 0) break;
        lp += w;
        if ((size_t)lp >= sizeof(logbuf)) lp = (int)sizeof(logbuf) - 1;
        if ((size_t)lp >= sizeof(logbuf) - 160) break;
    }
    unlockState();
    if (lp == 0) snprintf(logbuf, sizeof(logbuf), "No activity recorded for this session yet.");
    else if (logbuf[lp - 1] == '\n') logbuf[lp - 1] = '\0';
    Utf8::utf8TrimEnd(logbuf);   // the last appended row may have been byte-cut mid-한글
    for (char* c = logbuf; *c; c++) if (*c == '#') *c = ' ';
    sanitizeIps10Text(logbuf);
    lv_label_set_text(detailLog, logbuf);

    // Footer buttons by state.
    if (awaiting) {
        // Attention-only: the modal SHOWS the pending prompt (detailAction above)
        // but offers no on-device Approve/Deny — the user answers in the terminal.
        // A single amber "Close" mirrors the idle branch; detailBtnB is hidden.
        lv_obj_set_style_bg_color(detailBtnA, lv_color_hex(Theme::StatusAmber), 0);
        lv_label_set_text(detailBtnALabel, "Close");
        lv_obj_set_style_text_color(detailBtnALabel, lv_color_hex(0x1A1205), 0);
        lv_obj_add_flag(detailBtnB, LV_OBJ_FLAG_HIDDEN);
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
#if defined(BOARD_IPS10) && defined(BOARD_HAS_VOICE_CAPTURE)
// Short tap: toggle this session as the hold-to-talk target. Long press (the
// separate callback below) opens the detail overlay, so the two never collide:
// LVGL only fires SHORT_CLICKED when the press ended before the long-press
// threshold.
static void cellTapCb(lv_event_t* e) {
    int idx = (int)(intptr_t)lv_event_get_user_data(e);
    if (idx < 0 || idx >= MOSAIC_MAX) return;
    const CellMeta& cm = cellMetaData[idx];
    if (!cm.sid[0]) return;
    char msg[96];
    if (strcmp(voiceTargetSid, cm.sid) == 0) {
        voiceTargetSid[0] = '\0';
        voiceTargetName[0] = '\0';
        snprintf(msg, sizeof(msg), "Voice target: auto");
    } else {
        strncpy(voiceTargetSid, cm.sid, sizeof(voiceTargetSid) - 1);
        voiceTargetSid[sizeof(voiceTargetSid) - 1] = '\0';
        strncpy(voiceTargetName, cm.name, sizeof(voiceTargetName) - 1);
        voiceTargetName[sizeof(voiceTargetName) - 1] = '\0';
        snprintf(msg, sizeof(msg), "Voice target: %s", cm.name);
    }
    notify(msg);   // declared in hud_bar.h; cross-core-safe slot post
    // The selection outline is part of each cell's render signature, so the
    // next update() pass restyles exactly the affected cells.
}
static void cellLongPressCb(lv_event_t* e) {
    detailOpen((int)(intptr_t)lv_event_get_user_data(e));
}
#else
static void cellTapCb(lv_event_t* e) {
    detailOpen((int)(intptr_t)lv_event_get_user_data(e));
}
#endif
static void cellYesCb(lv_event_t* e) {
    int idx = (int)(intptr_t)lv_event_get_user_data(e);
    if (idx >= 0 && idx < MOSAIC_MAX) hudSendApprove(cellMetaData[idx].requestId, cellMetaData[idx].sid, true);
}
static void cellNoCb(lv_event_t* e) {
    int idx = (int)(intptr_t)lv_event_get_user_data(e);
    if (idx >= 0 && idx < MOSAIC_MAX) hudSendApprove(cellMetaData[idx].requestId, cellMetaData[idx].sid, false);
}

// ── top-bar usage gauges (compact 2-row blocks) ──
// One usage row: "5H ▓▓░ 62% 2h13m" — label · mini track+fill · percent/reset.
static lv_obj_t* makeUsageRow(lv_obj_t* parent, const char* lab, uint32_t labCol,
                              uint32_t fillCol, lv_obj_t** fillOut, lv_obj_t** pctOut) {
    lv_obj_t* row = lv_obj_create(parent);
    lv_obj_set_size(row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(row, 0, 0);
    lv_obj_set_style_pad_all(row, 0, 0);
    lv_obj_set_style_pad_column(row, 6, 0);
    lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    lv_obj_t* l = lv_label_create(row);
    lv_obj_set_style_text_font(l, &font_kr_12, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(labCol), 0);
    lv_label_set_text(l, lab);

    lv_obj_t* track = lv_obj_create(row);
    lv_obj_set_size(track, TB_BAR_W, 6);
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
    lv_obj_set_style_bg_color(fill, lv_color_hex(fillCol), 0);
    lv_obj_set_style_bg_opa(fill, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(fill, 0, 0);
    lv_obj_clear_flag(fill, LV_OBJ_FLAG_SCROLLABLE);
    *fillOut = fill;

    lv_obj_t* pct = lv_label_create(row);
    lv_obj_set_style_text_font(pct, &font_kr_12, 0);
    lv_obj_set_style_text_color(pct, lv_color_hex(0xE7EFE8), 0);
    lv_label_set_text(pct, "-");
    *pctOut = pct;
    return row;
}

// One agent usage block: a leading brand icon spanning a 2-row column (5H over
// 7D). Stacking the two windows vertically halves the horizontal footprint vs.
// the old single-row layout, so Claude + Codex + the Antigravity chip all fit
// without the rightmost item clipping past the bar's right padding.
static lv_obj_t* makeUsageBlock(lv_obj_t* parent, const lv_image_dsc_t* icon, uint32_t iconCol,
                                uint32_t labCol, uint32_t fillCol, lv_obj_t** icoOut,
                                lv_obj_t** f5, lv_obj_t** p5, lv_obj_t** f7, lv_obj_t** p7,
                                lv_obj_t** row5Out = nullptr, lv_obj_t** row7Out = nullptr) {
    lv_obj_t* block = lv_obj_create(parent);
    lv_obj_set_size(block, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(block, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(block, 0, 0);
    lv_obj_set_style_pad_all(block, 0, 0);
    lv_obj_set_style_pad_column(block, 6, 0);
    lv_obj_clear_flag(block, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(block, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(block, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    lv_obj_t* ic = lv_image_create(block);
    lv_image_set_src(ic, icon);
    lv_obj_set_style_image_recolor(ic, lv_color_hex(iconCol), 0);
    lv_image_set_scale(ic, 256 * 26 / 64);   // 64px mask → 26px (spans both rows)
    lv_obj_set_size(ic, 26, 26);
    lv_image_set_inner_align(ic, LV_IMAGE_ALIGN_CENTER);
    if (icoOut) *icoOut = ic;

    lv_obj_t* col = lv_obj_create(block);
    lv_obj_set_size(col, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(col, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(col, 0, 0);
    lv_obj_set_style_pad_all(col, 0, 0);
    lv_obj_set_style_pad_row(col, 2, 0);
    lv_obj_clear_flag(col, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(col, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);

    lv_obj_t* r5 = makeUsageRow(col, "5H", labCol, fillCol, f5, p5);
    lv_obj_t* r7 = makeUsageRow(col, "7D", labCol, fillCol, f7, p7);
    if (row5Out) *row5Out = r5;
    if (row7Out) *row7Out = r7;
    return block;
}
#endif // BOARD_IPS10

#if defined(BOARD_IPS10) && defined(BOARD_HAS_VOICE_CAPTURE)
// ── Push-to-talk ──────────────────────────────────────────────────────────────
// A dedicated hold target, unlike the knob's encoder press which is multiplexed
// with "go back" and therefore needs a 400 ms arm threshold. Here press means
// press: there is nothing else the control could mean.
//
// Target resolution: tap-selected card (`voiceTargetSid`) → daemon focus
// (`g_state.focusedSessionId`) → first live session. The tap selection is
// board-local by design (see voiceTargetSid); the button's sub-label always
// names the session the next hold will speak to, because a mic whose target is
// discovered only after release is a mic nobody trusts twice.
static lv_obj_t* voiceBtn = nullptr;
static lv_obj_t* voiceBtnLabel = nullptr;
static lv_obj_t* voiceBtnTarget = nullptr;   // sub-label: who hears the next hold
static lv_obj_t* voiceBanner = nullptr;
static lv_obj_t* voiceBannerLabel = nullptr;
static char voiceNotice[128] = {0};
static uint32_t voiceNoticeUntilMs = 0;
// While non-zero: an utterance is uploading/transcribing and the banner shows
// "Sending". Resolved by whatever arrives first (voice_result NOTICE, the
// spoken-reply SPEAKING state) or by this deadline — a board stuck on
// "Sending" forever was exactly the old undiagnosable failure mode.
static uint32_t voiceWaitingDeadlineMs = 0;

// Protocol::parseMessage() runs on CORE_NETWORK, while every LVGL call must
// stay on CORE_UI. Voice results and spoken-reply state arrive through the
// protocol path, so publish one fixed-size command here and consume it from
// voiceTick(). A single latest-state slot is sufficient: if BEGIN and END both
// arrive before one UI frame, showing the final state is the correct result.
// Static storage avoids a queue allocation in this hot, device-lifetime path.
enum class VoiceUiOp : uint8_t {
    NONE,
    LISTENING,
    WAITING,     // released: uploading + transcribing, outcome not yet known
    SPEAKING,
    NOTICE,
    HIDE,
};

struct VoiceUiCommand {
    VoiceUiOp op;
    char text[128];
};

static portMUX_TYPE voiceUiMux = portMUX_INITIALIZER_UNLOCKED;
static VoiceUiCommand pendingVoiceUi = {VoiceUiOp::NONE, {0}};

// Recent Q&A ring, rendered in the banner whenever it is otherwise idle —
// the empty space to the left of the talk button becomes a tiny transcript.
// Written from the network core (voice_result / audio_reply_ready), rendered
// by voiceTick() on the UI core; the same mux covers it.
struct VoiceQA { char q[72]; char a[96]; };
static VoiceQA voiceQA[2];
static uint8_t voiceQACount = 0;
static bool voiceQADirty = false;

static void voiceUiPost(VoiceUiOp op, const char* text) {
    VoiceUiCommand next = {op, {0}};
    snprintf(next.text, sizeof(next.text), "%s", text ? text : "");
    portENTER_CRITICAL(&voiceUiMux);
    pendingVoiceUi = next;
    portEXIT_CRITICAL(&voiceUiMux);
}

static void voiceBannerShow(const char* text, uint32_t colour) {
    if (!voiceBanner || !voiceBannerLabel) return;
    char safe[128];
    snprintf(safe, sizeof(safe), "%s", text ? text : "");
    Utf8::sanitizeLvglText(safe);
    Utf8::utf8TrimEnd(safe);
    lv_label_set_text(voiceBannerLabel, safe);
    lv_obj_set_style_border_color(voiceBanner, lv_color_hex(colour), 0);
    lv_obj_set_style_text_color(voiceBannerLabel, lv_color_hex(colour), 0);
    lv_obj_set_style_opa(voiceBanner, LV_OPA_COVER, 0);
}

// Idle banner = recent Q&A when there is any, else invisible. Keeps the
// status states (Listening/Sending/Speaking/notices) untouched — they always
// take the banner over and this view only returns once they clear.
static void voiceBannerIdle() {
    if (!voiceBanner || !voiceBannerLabel) return;
    VoiceQA snap[2];
    uint8_t count;
    portENTER_CRITICAL(&voiceUiMux);
    count = voiceQACount;
    for (uint8_t i = 0; i < count && i < 2; i++) snap[i] = voiceQA[i];
    voiceQADirty = false;
    portEXIT_CRITICAL(&voiceUiMux);
    if (count == 0) {
        lv_obj_set_style_opa(voiceBanner, LV_OPA_TRANSP, 0);
        return;
    }
    char text[240];
    size_t off = 0;
    // One pair fits the 76 px banner cleanly (Q line + A line); the second
    // ring slot is retention for a future taller layout.
    for (uint8_t i = 0; i < count && i < 1 && off < sizeof(text) - 8; i++) {
        int n = snprintf(text + off, sizeof(text) - off, "%sQ %s%s%s",
                         i > 0 ? "\n" : "", snap[i].q,
                         snap[i].a[0] ? "\nA " : "", snap[i].a);
        if (n < 0) break;
        off += (size_t)n;
        if (off >= sizeof(text)) { off = sizeof(text) - 1; break; }
    }
    text[sizeof(text) - 1] = '\0';
    Utf8::utf8TrimEnd(text);
    lv_label_set_text(voiceBannerLabel, text);
    lv_obj_set_style_border_color(voiceBanner, lv_color_hex(0x1B3F39), 0);
    lv_obj_set_style_text_color(voiceBannerLabel, lv_color_hex(0x8FA6A2), 0);
    lv_obj_set_style_opa(voiceBanner, LV_OPA_COVER, 0);
}

static void voiceBannerHide() {
    voiceBannerIdle();
}

// Which session does a press talk to?
//
// Ladder: the card the operator tapped (`voiceTargetSid`) → a general-purpose
// assistant session (OpenClaw / Hermes — see isGeneralAssistantSession) → the
// daemon's explicit user focus → the first live session. The tap selection
// wins because it is the only one the operator chose *on this panel*; it
// self-clears when its session dies, so a stale pick can never silently
// swallow dictation. Auto prefers the general assistant because dictation with
// no explicit pick is conversation, and a coding session treats it as a work
// order for its repo. The focus fallback exists because nobody sets a daemon
// focus from a wall panel, and keying off it alone made the button do nothing
// at all — pressed, returned early, no feedback.
static bool voiceResolveTarget(char* idOut, size_t idCap, char* labelOut, size_t labelCap) {
    bool found = false;
    lockState();
    if (voiceTargetSid[0]) {
        for (uint8_t i = 0; i < g_state.sessionCount && !found; i++) {
            const SessionInfo& si = g_state.sessions[i];
            if (!si.alive || strcmp(si.id, voiceTargetSid) != 0) continue;
            snprintf(idOut, idCap, "%s", si.id);
            snprintf(labelOut, labelCap, "%s", si.projectName[0] ? si.projectName : si.id);
            found = true;
        }
        if (!found) {
            // Session ended since it was picked — fall through to auto.
            voiceTargetSid[0] = '\0';
            voiceTargetName[0] = '\0';
        }
    }
    if (!found) {
        for (uint8_t i = 0; i < g_state.sessionCount && !found; i++) {
            const SessionInfo& si = g_state.sessions[i];
            if (!si.alive || !si.id[0]) continue;
            if (!isGeneralAssistantSession(si.agentType, si.projectName)) continue;
            snprintf(idOut, idCap, "%s", si.id);
            snprintf(labelOut, labelCap, "%s", si.projectName[0] ? si.projectName : si.id);
            found = true;
        }
    }
    if (!found && g_state.focusedSessionId[0]) {
        snprintf(idOut, idCap, "%s", g_state.focusedSessionId);
        snprintf(labelOut, labelCap, "%s",
                 g_state.projectName[0] ? g_state.projectName : g_state.focusedSessionId);
        found = true;
    }
    if (!found) {
        for (uint8_t i = 0; i < g_state.sessionCount && !found; i++) {
            const SessionInfo& si = g_state.sessions[i];
            if (!si.alive || !si.id[0]) continue;
            snprintf(idOut, idCap, "%s", si.id);
            snprintf(labelOut, labelCap, "%s", si.projectName[0] ? si.projectName : si.id);
            found = true;
        }
    }
    unlockState();
    return found;
}

static void voicePressCb(lv_event_t* e) {
    (void)e;
    Serial.println("[Voice] button PRESSED");
    if (!Audio::micReady()) {
        HUD::notify("Mic unavailable");
        return;
    }
    char target[32] = {0};
    char label[96] = {0};
    if (!voiceResolveTarget(target, sizeof(target), label, sizeof(label))) {
        HUD::notify("No active session to speak to");
        return;
    }
    Audio::micStart(target);
    if (!Audio::micCapturing()) {
        // micStart refused (codec init failure) — without this the button
        // shows Listening over a mic that is capturing nothing.
        HUD::notify("Mic init failed");
        return;
    }
    // Press feedback tick — a silent button reads as a dead one. AFTER
    // micStart on purpose: micStart's codec-ensure runs synchronously on this
    // thread, so the tone's playback task never races those ~40 I2C writes.
    // The mic picks up the tick's tail; the recognizer shrugs it off.
    Audio::playTone(1200, 25, 0.18f);
    HUD::setListening(label);
    lv_obj_set_style_bg_color(voiceBtn, lv_color_hex(Theme::StatusAmber), 0);
    lv_obj_set_style_text_color(voiceBtnLabel, lv_color_hex(0x0B1D1A), 0);
    lv_label_set_text(voiceBtnLabel, "Listening");
}

static void voiceReleaseCb(lv_event_t* e) {
    (void)e;
    Serial.println("[Voice] button RELEASED");
    if (!Audio::micCapturing()) return;
    Audio::micStop(false);
    // "Sent" blip — the audible counterpart of the Sending banner. Deferred
    // ~350 ms would avoid the capture tail, but micStop's TAIL_DRAIN already
    // covers the last word and the blip rides behind it harmlessly.
    Audio::playTone(880, 45, 0.22f);
    // Between release and voice_result there is an upload + a transcription —
    // seconds of real work. Show it, or every slow round trip reads as a
    // dropped one. Whatever arrives next (transcript, error, empty-capture
    // notice) replaces this state; a deadline in voiceTick() catches the case
    // where nothing ever arrives.
    voiceUiPost(VoiceUiOp::WAITING, "Sending...");
    lv_obj_set_style_bg_color(voiceBtn, lv_color_hex(0x1D4A42), 0);
    lv_obj_set_style_text_color(voiceBtnLabel, lv_color_hex(Theme::HUDText), 0);
    lv_label_set_text(voiceBtnLabel, "Hold to talk");
}

// Called from update(): a transient notice has to clear itself, and update() is
// the only thing already ticking on the LVGL thread.
static void voiceTick() {
    VoiceUiCommand command = {VoiceUiOp::NONE, {0}};
    portENTER_CRITICAL(&voiceUiMux);
    command = pendingVoiceUi;
    pendingVoiceUi.op = VoiceUiOp::NONE;
    portEXIT_CRITICAL(&voiceUiMux);

    if (command.op != VoiceUiOp::NONE) {
        Serial.printf("[VoiceUI] apply op=%u on core %d\n",
                      (unsigned)command.op, xPortGetCoreID());
    }
    static bool voiceBannerBusy = false;
    switch (command.op) {
        case VoiceUiOp::LISTENING:
            voiceNoticeUntilMs = 0;
            voiceWaitingDeadlineMs = 0;
            voiceBannerBusy = true;
            voiceBannerShow(command.text, Theme::StatusAmber);
            break;
        case VoiceUiOp::WAITING:
            voiceNoticeUntilMs = 0;
            // Upload (≤15 s HTTP timeout) + transcription; anything past this
            // deadline means no voice_result is coming.
            voiceWaitingDeadlineMs = millis() + 25000;
            voiceBannerBusy = true;
            voiceBannerShow(command.text, Theme::HUDText);
            break;
        case VoiceUiOp::SPEAKING:
            voiceNoticeUntilMs = 0;
            voiceWaitingDeadlineMs = 0;
            voiceBannerBusy = true;
            voiceBannerShow(command.text, Theme::StatusGreen);
            break;
        case VoiceUiOp::NOTICE:
            voiceWaitingDeadlineMs = 0;
            voiceBannerBusy = false;
            snprintf(voiceNotice, sizeof(voiceNotice), "%s", command.text);
            voiceNoticeUntilMs = millis() + 6000;
            voiceBannerShow(voiceNotice, Theme::HUDText);
            break;
        case VoiceUiOp::HIDE:
            voiceWaitingDeadlineMs = 0;
            voiceBannerBusy = false;
            if (voiceNoticeUntilMs == 0) voiceBannerHide();
            break;
        case VoiceUiOp::NONE:
            break;
    }

    // New Q&A content while the banner sits idle → refresh the transcript view.
    if (voiceQADirty && !voiceBannerBusy &&
        voiceNoticeUntilMs == 0 && voiceWaitingDeadlineMs == 0) {
        voiceBannerIdle();
    }

    if (voiceNoticeUntilMs && (int32_t)(millis() - voiceNoticeUntilMs) >= 0) {
        voiceNoticeUntilMs = 0;
        if (!Audio::micCapturing()) voiceBannerHide();
    }
    if (voiceWaitingDeadlineMs && (int32_t)(millis() - voiceWaitingDeadlineMs) >= 0) {
        voiceWaitingDeadlineMs = 0;
        snprintf(voiceNotice, sizeof(voiceNotice), "No response - check daemon");
        voiceNoticeUntilMs = millis() + 6000;
        voiceBannerShow(voiceNotice, Theme::StatusAmber);
    }

    // Keep the button's sub-label naming the session the NEXT hold will speak
    // to. Throttled: resolving takes the state lock, and the label only
    // changes when sessions/focus/tap-selection do.
    static uint32_t lastTargetPollMs = 0;
    static char lastTargetLabel[64] = {0};
    uint32_t now = millis();
    if (voiceBtnTarget && (uint32_t)(now - lastTargetPollMs) >= 500) {
        lastTargetPollMs = now;
        char id[32] = {0};
        char label[96] = {0};
        char line[64];
        if (voiceResolveTarget(id, sizeof(id), label, sizeof(label))) {
            Utf8::sanitizeLvglText(label);
            snprintf(line, sizeof(line), "%s%s", voiceTargetSid[0] ? "" : "auto: ", label);
            Utf8::utf8TrimEnd(line);
        } else {
            snprintf(line, sizeof(line), "no session");
        }
        if (strcmp(line, lastTargetLabel) != 0) {
            snprintf(lastTargetLabel, sizeof(lastTargetLabel), "%s", line);
            lv_label_set_text(voiceBtnTarget, line);
        }
    }
}

// `pane` is the cards column (panelLeft), a flex column whose cellsBox has
// flex_grow 1. Adding this row as a fixed-height sibling makes the treemap give
// up the space rather than sit underneath: floating it absolutely put the button
// on top of a live card, which the host simulator caught before any hardware did.
static void voiceCreate(lv_obj_t* pane) {
    lv_obj_t* row = lv_obj_create(pane);
    lv_obj_set_size(row, ips10SidebarW - 28, 96);
    lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(row, 0, 0);
    lv_obj_set_style_pad_all(row, 0, 0);
    lv_obj_set_style_pad_top(row, 8, 0);
    lv_obj_set_style_pad_column(row, 12, 0);
    lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(row, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    voiceBanner = lv_obj_create(row);
    lv_obj_set_height(voiceBanner, 76);
    lv_obj_set_flex_grow(voiceBanner, 1);
    lv_obj_set_style_bg_color(voiceBanner, lv_color_hex(0x0D2723), 0);
    lv_obj_set_style_bg_opa(voiceBanner, (lv_opa_t)235, 0);
    lv_obj_set_style_border_width(voiceBanner, 1, 0);
    lv_obj_set_style_radius(voiceBanner, 12, 0);
    lv_obj_set_style_pad_all(voiceBanner, 12, 0);
    lv_obj_clear_flag(voiceBanner, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(voiceBanner, LV_OBJ_FLAG_CLICKABLE);
    voiceBannerLabel = lv_label_create(voiceBanner);
    lv_label_set_long_mode(voiceBannerLabel, LV_LABEL_LONG_DOT);
    lv_obj_set_width(voiceBannerLabel, LV_PCT(100));
    lv_obj_set_style_text_font(voiceBannerLabel, &font_kr_16, 0);
    lv_label_set_text(voiceBannerLabel, "");
    // Hidden by opacity, not LV_OBJ_FLAG_HIDDEN: a hidden flex child collapses
    // and the button would slide left every time the banner appears.
    lv_obj_set_style_opa(voiceBanner, LV_OPA_TRANSP, 0);

    // Speaker volume — two compact steppers between the transcript and the
    // talk button. Direct Es8311 writes on the UI thread (same bus discipline
    // as the touch reads that share it), toast for feedback.
    auto mkVolBtn = [&](const char* txt, lv_event_cb_t cb) {
        lv_obj_t* b = lv_button_create(row);
        lv_obj_set_size(b, 48, 76);
        lv_obj_set_style_radius(b, 12, 0);
        lv_obj_set_style_bg_color(b, lv_color_hex(0x123B35), 0);
        lv_obj_set_style_bg_opa(b, LV_OPA_COVER, 0);
        lv_obj_set_style_border_color(b, lv_color_hex(0x1B3F39), 0);
        lv_obj_set_style_border_width(b, 1, 0);
        lv_obj_t* l = lv_label_create(b);
        lv_obj_set_style_text_font(l, &font_kr_20, 0);
        lv_obj_set_style_text_color(l, lv_color_hex(Theme::HUDText), 0);
        lv_label_set_text(l, txt);
        lv_obj_center(l);
        lv_obj_add_event_cb(b, cb, LV_EVENT_CLICKED, NULL);
        return b;
    };
    mkVolBtn(LV_SYMBOL_VOLUME_MID, [](lv_event_t*) {
#if defined(BOARD_SPK_CODEC_ES8311)
        int v = Es8311::volume() - 10;
        if (v < 20) v = 20;
        Es8311::setVolume(v);
        char msg[40];
        snprintf(msg, sizeof(msg), "Volume %d%%", v);
        HUD::notify(msg);
        Audio::playTone(880, 40, 0.2f);
#endif
    });
    mkVolBtn(LV_SYMBOL_VOLUME_MAX, [](lv_event_t*) {
#if defined(BOARD_SPK_CODEC_ES8311)
        int v = Es8311::volume() + 10;
        if (v > 100) v = 100;
        Es8311::setVolume(v);
        char msg[40];
        snprintf(msg, sizeof(msg), "Volume %d%%", v);
        HUD::notify(msg);
        Audio::playTone(880, 40, 0.2f);
#endif
    });

    voiceBtn = lv_button_create(row);
    lv_obj_set_size(voiceBtn, 168, 76);
    lv_obj_set_style_radius(voiceBtn, 16, 0);
    lv_obj_set_style_bg_color(voiceBtn, lv_color_hex(0x1D4A42), 0);
    lv_obj_set_style_bg_opa(voiceBtn, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(voiceBtn, lv_color_hex(Theme::StatusGreen), 0);
    lv_obj_set_style_border_width(voiceBtn, 2, 0);
    lv_obj_set_style_shadow_width(voiceBtn, 24, 0);
    lv_obj_set_style_shadow_opa(voiceBtn, (lv_opa_t)120, 0);
    lv_obj_set_style_shadow_color(voiceBtn, lv_color_hex(0x000000), 0);
    voiceBtnLabel = lv_label_create(voiceBtn);
    lv_label_set_text(voiceBtnLabel, "Hold to talk");
    lv_obj_set_style_text_font(voiceBtnLabel, &font_kr_20, 0);
    lv_obj_set_style_text_color(voiceBtnLabel, lv_color_hex(Theme::HUDText), 0);
    lv_obj_align(voiceBtnLabel, LV_ALIGN_TOP_MID, 0, 8);

    // Sub-label: the session the next hold speaks to (tap a card to change).
    voiceBtnTarget = lv_label_create(voiceBtn);
    lv_obj_set_style_text_font(voiceBtnTarget, &font_kr_12, 0);
    lv_obj_set_style_text_color(voiceBtnTarget, lv_color_hex(0x8FD8CE), 0);
    lv_label_set_long_mode(voiceBtnTarget, LV_LABEL_LONG_DOT);
    lv_obj_set_width(voiceBtnTarget, 148);
    lv_obj_set_style_text_align(voiceBtnTarget, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(voiceBtnTarget, "");
    lv_obj_align(voiceBtnTarget, LV_ALIGN_BOTTOM_MID, 0, -8);
    // PRESSED/RELEASED, not CLICKED: this is hold-to-talk, and RELEASED still
    // fires when the finger slides off, which is the behaviour we want — a
    // half-committed gesture should close the utterance, not strand it open.
    lv_obj_add_event_cb(voiceBtn, voicePressCb, LV_EVENT_PRESSED, NULL);
    lv_obj_add_event_cb(voiceBtn, voiceReleaseCb, LV_EVENT_RELEASED, NULL);
    lv_obj_add_event_cb(voiceBtn, voiceReleaseCb, LV_EVENT_PRESS_LOST, NULL);
}
#endif  // BOARD_IPS10 && BOARD_HAS_VOICE_CAPTURE

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
        lv_obj_set_style_pad_left(tb, 22, 0); lv_obj_set_style_pad_right(tb, 26, 0);
        lv_obj_set_style_pad_top(tb, 0, 0); lv_obj_set_style_pad_bottom(tb, 0, 0);
        lv_obj_set_style_pad_column(tb, 20, 0);   // generous gaps between brand · daemon · usage
        lv_obj_clear_flag(tb, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_clear_flag(tb, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_flex_flow(tb, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(tb, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

        // Brand: logo mark + wordmark kept tight together in their own container
        // (small gap), held apart from the daemon/usage groups by the top-level
        // pad_column. The mark's layout box is pinned to 30px — otherwise the flex
        // row reserves the full 64px source width, leaving a gap before the wordmark.
        lv_obj_t* brand = lv_obj_create(tb);
        lv_obj_set_size(brand, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_set_style_bg_opa(brand, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(brand, 0, 0);
        lv_obj_set_style_pad_all(brand, 0, 0);
        lv_obj_set_style_pad_column(brand, 9, 0);
        lv_obj_clear_flag(brand, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_flex_flow(brand, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(brand, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

        lv_obj_t* mk = lv_image_create(brand);
        lv_image_set_src(mk, &img_logo_64);
        lv_image_set_scale(mk, 256 * 30 / 64);   // 64→30px
        lv_obj_set_size(mk, 30, 30);
        lv_image_set_inner_align(mk, LV_IMAGE_ALIGN_CENTER);
        lblLogo = lv_label_create(brand);
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

        // Claude (cyan) + Codex (blue) usage as compact per-agent blocks: a brand
        // icon beside a 2-row column (5H over 7D). The Codex block hides when no
        // Codex limits are present. Glyphs must be built first.
        ips10InitGlyphs();
        makeUsageBlock(tb, &glyphOctopus, Theme::ClaudeBody, 0x5D7470, D1_OK,
                       nullptr, &tb5hFill, &tb5hPct, &tb7dFill, &tb7dPct);
        // The block hides as a whole when Codex reports nothing; each usage ROW
        // also hides individually so a post-5h-reset 7D-only state renders one
        // clean gauge instead of a dead "-" 5H row.
        tbCodexBlock = makeUsageBlock(tb, &glyphCodex, Theme::CloudBody, 0x7A80E8, D1_CODEX,
                                   &tbCodexIcon, &tbCx5hFill, &tbCx5hPct, &tbCx7dFill, &tbCx7dPct,
                                   &tbCx5hGrp, &tbCx7dGrp);
        lv_obj_add_flag(tbCodexBlock, LV_OBJ_FLAG_HIDDEN);

        // Antigravity chip — brand mark + plan name (no credit count: it's a raw
        // backend metering number). Hidden until usage_update carries a status.
        tbAgIcon = lv_image_create(tb);
        lv_image_set_src(tbAgIcon, &glyphAntigravityColor);
        lv_image_set_scale(tbAgIcon, 256 * 22 / 64);
        lv_obj_set_size(tbAgIcon, 22, 22);
        lv_image_set_inner_align(tbAgIcon, LV_IMAGE_ALIGN_CENTER);
        lv_obj_add_flag(tbAgIcon, LV_OBJ_FLAG_HIDDEN);

        tbAg = lv_label_create(tb);
        lv_obj_set_style_text_font(tbAg, &font_kr_12, 0);
        lv_obj_set_style_text_color(tbAg, lv_color_hex(Theme::AntigravityCyan), 0);
        lv_label_set_recolor(tbAg, true);
        lv_label_set_text(tbAg, "");
        lv_obj_add_flag(tbAg, LV_OBJ_FLAG_HIDDEN);
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
    lv_obj_add_flag(cellsBox, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scroll_dir(cellsBox, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(cellsBox, LV_SCROLLBAR_MODE_AUTO);
    // No flex layout → children are placed by absolute lv_obj_set_pos (the treemap).

    ips10InitGlyphs();   // build the A8 creature-mark descriptors once before the cells use them

    for (int i = 0; i < MOSAIC_MAX; i++) {
        cell[i] = lv_obj_create(cellsBox);
        lv_obj_set_size(cell[i], 80, 60);
        lv_obj_set_pos(cell[i], 0, 0);
        // D1 card: light card background for maximum readability (cards on a dark green deck)
        lv_obj_set_style_bg_color(cell[i], lv_color_hex(0xFFFFFF), 0);
        lv_obj_set_style_bg_grad_color(cell[i], lv_color_hex(0xF1F5F9), 0); // slate-100 gradient
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
#if defined(BOARD_IPS10) && defined(BOARD_HAS_VOICE_CAPTURE)
        // Voice builds: a short tap picks this session as the hold-to-talk
        // target (cyan outline + button sub-label), a long press opens the
        // detail overlay. This replaces the earlier "passive status tiles"
        // stance, which dated from when this panel's touch controller had
        // never reported a point — the mic gave the cards their first real
        // reason to be pressable. Approve/Deny stay separate child buttons and
        // do not bubble up here.
        lv_obj_add_flag(cell[i], LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_event_cb(cell[i], cellTapCb, LV_EVENT_SHORT_CLICKED, (void*)(intptr_t)i);
        lv_obj_add_event_cb(cell[i], cellLongPressCb, LV_EVENT_LONG_PRESSED, (void*)(intptr_t)i);
#else
        // Cells are PASSIVE status tiles: everything the user needs is shown inline as text
        // (name · state · tool · activity · meta) and awaiting cells expose explicit Approve/Deny
        // buttons. No tap-to-open detail overlay. Non-clickable so a phantom press does nothing.
        lv_obj_clear_flag(cell[i], LV_OBJ_FLAG_CLICKABLE);
        (void)cellTapCb;
#endif

        // Creature mark — top-right overlay, OUTSIDE the flex flow (IGNORE_LAYOUT)
        cellGlyph[i] = lv_image_create(cell[i]);
        lv_obj_add_flag(cellGlyph[i], LV_OBJ_FLAG_IGNORE_LAYOUT);
        lv_obj_add_flag(cellGlyph[i], LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_image_recolor_opa(cellGlyph[i], LV_OPA_COVER, 0);
        lv_obj_set_style_image_opa(cellGlyph[i], (lv_opa_t)235, 0);
        lv_obj_clear_flag(cellGlyph[i], LV_OBJ_FLAG_CLICKABLE);

        // Name line: ●agent-name (bold) + colored [STATE]
        cellName[i] = lv_label_create(cell[i]);
        lv_obj_set_style_text_color(cellName[i], lv_color_hex(0x0F172A), 0); // slate-900 (very dark)
        lv_obj_set_style_text_font(cellName[i], &font_kr_20, 0);
        lv_label_set_recolor(cellName[i], true);
        lv_label_set_long_mode(cellName[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(cellName[i], 60);
        lv_label_set_text(cellName[i], "");

        // State pill chip — short content-sized rounded label (NOT a nested flex row, so it
        // stays layout-cheap). bg/text colored per state at render time.
        cellPill[i] = lv_label_create(cell[i]);
        lv_obj_set_style_text_font(cellPill[i], &font_kr_16, 0);
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
        lv_obj_set_style_text_color(cellProj[i], lv_color_hex(0x475569), 0); // slate-600 (medium-dark)
        lv_obj_set_style_text_font(cellProj[i], &font_kr_16, 0);
        lv_label_set_long_mode(cellProj[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(cellProj[i], 60);
        lv_label_set_text(cellProj[i], "");

        // Child activity is a second axis: an idle parent can have live children.
        cellCoord[i] = lv_label_create(cell[i]);
        if (cellCoord[i]) {
        lv_obj_set_style_text_font(cellCoord[i], &font_kr_16, 0);
        lv_obj_set_style_text_color(cellCoord[i], lv_color_hex(Theme::HUDDim), 0);
        lv_obj_set_style_bg_color(cellCoord[i], lv_color_hex(Theme::HUDText), 0);
        lv_obj_set_style_bg_opa(cellCoord[i], LV_OPA_COVER, 0);
        lv_obj_set_style_radius(cellCoord[i], 6, 0);
        lv_label_set_long_mode(cellCoord[i], LV_LABEL_LONG_DOT);
        lv_label_set_text_static(cellCoord[i], cellCoordText[i]);
        } else {
            Serial.printf("[collaboration] census label %d allocation failed\n", i);
        }

        // Tool box: "▸ tool" in a bordered/filled box.
        cellTool[i] = lv_label_create(cell[i]);
        lv_obj_set_style_text_color(cellTool[i], lv_color_hex(Theme::HUDText), 0);
        lv_obj_set_style_text_font(cellTool[i], &font_kr_16, 0);
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

        // Body: the TIMELINE feed — newest milestone bright, older rows dimmed via recolor markup.
        cellBody[i] = lv_label_create(cell[i]);
        lv_obj_set_style_text_color(cellBody[i], lv_color_hex(0x1E293B), 0); // slate-800
        lv_obj_set_style_text_font(cellBody[i], &font_kr_16, 0);
        lv_obj_set_style_text_line_space(cellBody[i], 6, 0);
        lv_label_set_recolor(cellBody[i], true);
        lv_label_set_long_mode(cellBody[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(cellBody[i], 60);
        lv_label_set_text(cellBody[i], "");

        // Footer: model · elapsed (faint).
        cellMeta[i] = lv_label_create(cell[i]);
        lv_obj_set_width(cellMeta[i], 60);
        lv_obj_set_style_text_color(cellMeta[i], lv_color_hex(0x64748B), 0); // slate-500
        lv_obj_set_style_text_font(cellMeta[i], &lv_font_montserrat_12, 0);
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
        lv_obj_set_style_text_color(noLbl, lv_color_hex(0xFFFFFF), 0); // white text on dark green button
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

#if defined(BOARD_HAS_VOICE_CAPTURE)
    voiceCreate(panelLeft);
#endif

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
    lv_obj_set_size(panelRight, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
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
    lv_obj_set_size(panelRight, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
#if defined(BOARD_TTGO)
    lv_obj_align(panelRight, LV_ALIGN_TOP_RIGHT, -6, 6);
#else
    if (portrait) {
        // Portrait: below left panel, aligned to bottom-right
        lv_obj_align(panelRight, LV_ALIGN_BOTTOM_RIGHT, -8, -8);
    } else {
        lv_obj_align(panelRight, LV_ALIGN_TOP_RIGHT, -8, PANEL_TOP_Y);
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

    // Header (hidden per user request)
    lblTankHeader = lv_label_create(panelRight);
    lv_obj_set_style_text_color(lblTankHeader, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(lblTankHeader, &lv_font_montserrat_10, 0);
    lv_label_set_text(lblTankHeader, "");
    lv_obj_add_flag(lblTankHeader, LV_OBJ_FLAG_HIDDEN);
#endif

#if !defined(BOARD_IPS10)
    // Provider tank groups stack vertically in panelRight: Claude first, then Codex
    // (hidden until Codex data arrives), then the account chip. Each group is a
    // brand-labelled header over its 5h/7d water tanks, so multiple providers read
    // as one cohesive panel instead of tanks + loose text. Width is unchanged
    // (2 tanks wide); the panel just grows a block when a second provider is live.
    // IPS10 renders usage in its D1 topbar, so it builds none of this.
    claudeGroup = makeTankGroup(panelRight, "CLAUDE", Theme::ClaudeBody,
        gauge5hBox, gauge5hFill, gauge5hPct, gauge5hPeriod, gauge5hReset,
        gauge7dBox, gauge7dFill, gauge7dPct, gauge7dPeriod, gauge7dReset);
    codexGroup = makeTankGroup(panelRight, "CODEX", Theme::CloudBodyLight,
        gaugeCx5hBox, gaugeCx5hFill, gaugeCx5hPct, gaugeCx5hPeriod, gaugeCx5hReset,
        gaugeCx7dBox, gaugeCx7dFill, gaugeCx7dPct, gaugeCx7dPeriod, gaugeCx7dReset);
    lv_obj_add_flag(codexGroup, LV_OBJ_FLAG_HIDDEN);

    // Stale indicator (only shown when data is stale, hidden by default)
    lblStale = lv_label_create(panelRight);
    lv_obj_set_style_text_color(lblStale, lv_color_hex(Theme::StatusAmber), 0);
    lv_obj_set_style_text_font(lblStale, &lv_font_montserrat_10, 0);
    lv_label_set_text(lblStale, "");
    lv_obj_add_flag(lblStale, LV_OBJ_FLAG_HIDDEN);

    // Account chip: a subtle glass pill holding "AGY Pro ~8/1" + subscription
    // expiries. Hidden until data (so a Claude-only / Swift-daemon setup shows no
    // empty chip). Raw Antigravity credit count is never shown.
    acctChip = lv_obj_create(panelRight);
    lv_obj_set_size(acctChip, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_color(acctChip, lv_color_hex(0xFFFFFF), 0);
    lv_obj_set_style_bg_opa(acctChip, (lv_opa_t)18, 0);
    lv_obj_set_style_border_width(acctChip, 0, 0);
    lv_obj_set_style_radius(acctChip, 7, 0);
    lv_obj_set_style_pad_left(acctChip, 6, 0);
    lv_obj_set_style_pad_right(acctChip, 6, 0);
    lv_obj_set_style_pad_top(acctChip, 2, 0);
    lv_obj_set_style_pad_bottom(acctChip, 2, 0);
    lv_obj_clear_flag(acctChip, LV_OBJ_FLAG_SCROLLABLE);
    acctChipLabel = lv_label_create(acctChip);
    lv_obj_set_style_text_font(acctChipLabel, &lv_font_montserrat_10, 0);
    lv_label_set_recolor(acctChipLabel, true);
    lv_label_set_text(acctChipLabel, "");
    lv_obj_add_flag(acctChip, LV_OBJ_FLAG_HIDDEN);
#endif
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

#if defined(BOARD_IPS10)
// IPS10 D1 top-bar horizontal bar gauge. v < 0 → "-" + empty bar. baseColor is the
// brand fill (Claude cyan / Codex blue); shifts to attn at ≥85%. Reset countdown and
// the stale "!" marker are appended to the percent label (water-tank-gauge parity).
static void setTopbarGauge(lv_obj_t* fill, lv_obj_t* pct, float v,
                           const char* reset, bool stale, uint32_t baseColor) {
    if (fill) {
        int w = v >= 0.0f ? (int)(v / 100.0f * TB_BAR_W + 0.5f) : 0; if (w > TB_BAR_W) w = TB_BAR_W;
        lv_obj_set_width(fill, w);
        lv_obj_set_style_bg_color(fill, lv_color_hex(v >= 85.0f ? D1_ATTN : baseColor), 0);
    }
    if (!pct) return;
    char pb[28];
    if (v < 0.0f) snprintf(pb, sizeof(pb), "-");
    else if (reset && reset[0]) snprintf(pb, sizeof(pb), "%d%%%s %s", (int)(v + 0.5f), stale ? "!" : "", reset);
    else snprintf(pb, sizeof(pb), "%d%%%s", (int)(v + 0.5f), stale ? "!" : "");
    lv_label_set_text(pct, pb);
}
#endif

void update() {
#if defined(BOARD_IPS10) && defined(BOARD_HAS_VOICE_CAPTURE)
    voiceTick();
#endif
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
#if defined(BOARD_IPS10)
    float pcx5h = g_state.codexPrimaryPercent;
    float pcx7d = g_state.codexSecondaryPercent;
    char resetCx5h[20], resetCx7d[20];
    strncpy(resetCx5h, g_state.codexPrimaryReset, sizeof(resetCx5h) - 1);
    strncpy(resetCx7d, g_state.codexSecondaryReset, sizeof(resetCx7d) - 1);
    resetCx5h[sizeof(resetCx5h) - 1] = '\0';
    resetCx7d[sizeof(resetCx7d) - 1] = '\0';
    float agCredits = g_state.antigravityCredits;
    char agPlan[24];
    strncpy(agPlan, g_state.antigravityPlan, sizeof(agPlan) - 1);
    agPlan[sizeof(agPlan) - 1] = '\0';
#endif

#if !defined(BOARD_IPS10)
    // Codex windows + account-chip string for the TANK STATUS panel. Read straight
    // from g_state (all fields exist on every board). Built here under the lock;
    // rendered after unlockState() below.
    float cxP5h = g_state.codexPrimaryPercent;
    float cxP7d = g_state.codexSecondaryPercent;
    char cxReset5h[20], cxReset7d[20];
    strncpy(cxReset5h, g_state.codexPrimaryReset, sizeof(cxReset5h) - 1);   cxReset5h[sizeof(cxReset5h) - 1] = '\0';
    strncpy(cxReset7d, g_state.codexSecondaryReset, sizeof(cxReset7d) - 1); cxReset7d[sizeof(cxReset7d) - 1] = '\0';
    // Account chip: shortened Antigravity plan (gold) + subscription expiries (dim).
    char agyBuf[28]; agyBuf[0] = '\0';
    char subsBuf[96]; subsBuf[0] = '\0'; size_t subsPos = 0;
    for (uint8_t i = 0; i < g_state.subscriptionCount; i++) {
        const auto& sub = g_state.subscriptions[i];
        if (UsageFormat::isAntigravityPlanName(sub.name)) {
            UsageFormat::formatAgyPlan(sub.name, agyBuf, sizeof(agyBuf));
            if (sub.until[0]) {
                size_t l = strlen(agyBuf);
                snprintf(agyBuf + l, sizeof(agyBuf) - l, " %s", sub.until);
            }
        } else if (sub.until[0]) {
            // Non-Antigravity plan with an expiry → "<provider> ~M/D" (provider =
            // the first word of the plan name, e.g. "ChatGPT Plus" → "ChatGPT").
            char nm[16]; size_t k = 0;
            for (; sub.name[k] && sub.name[k] != ' ' && k < sizeof(nm) - 1; k++) nm[k] = sub.name[k];
            nm[k] = '\0';
            int w = snprintf(subsBuf + subsPos, sizeof(subsBuf) - subsPos, "%s%s %s",
                             subsPos ? "  " : "", nm, sub.until);
            if (w > 0) subsPos += (size_t)w;
        }
    }
    if (!agyBuf[0] && g_state.antigravityPlan[0]) {
        UsageFormat::formatAgyPlan(g_state.antigravityPlan, agyBuf, sizeof(agyBuf));
    }
    // Compose the recolored chip: Antigravity gold, subscription expiries dim.
    char chipBuf[160]; chipBuf[0] = '\0'; size_t cp = 0;
    if (agyBuf[0])  cp += (size_t)snprintf(chipBuf + cp, sizeof(chipBuf) - cp, "#F3D233 %s#", agyBuf);
    if (subsBuf[0]) cp += (size_t)snprintf(chipBuf + cp, sizeof(chipBuf) - cp, "%s#94A3B8 %s#", cp ? "  " : "", subsBuf);
#endif

#if !defined(BOARD_IPS10)
    // Copy session list for the compact legacy HUD. IPS10 renders the D1 mosaic
    // below, so avoid building the legacy text buffer on its UI stack.
    uint8_t sessionCount = hasData ? g_state.sessionCount : (uint8_t)0;
    SessionInfo sessions[10];
    memcpy(sessions, g_state.sessions, sizeof(sessions));
#endif

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
#if !defined(BOARD_IPS10)
    bool gateway = g_state.gatewayConnected;
#endif
    unlockState();

#if !defined(BOARD_IPS10)
    // === Left panel: session list ===
    char buf[400];
    size_t pos = 0;

    if (sessionCount > 0) {
        const uint8_t limit = sessionCount < 10 ? sessionCount : 10;
        uint8_t aliveCount = 0;
        for (uint8_t i = 0; i < limit; i++) if (sessions[i].alive) aliveCount++;

        bool shown[10] = {};
        uint8_t visible = 0;
        auto appendSession = [&](uint8_t i) {
            const uint32_t dotColor = agentDotColor(sessions[i].agentType);
            const uint32_t sColor = sessionStateColor(sessions[i].state);
            appendBounded(buf, sizeof(buf), pos,
                "#%06lX " LV_SYMBOL_BULLET "# %s  #%06lX " LV_SYMBOL_BULLET "#\n",
                (unsigned long)dotColor,
                sessions[i].projectName[0] ? sessions[i].projectName : sessions[i].id,
                (unsigned long)sColor);
            shown[i] = true;
            visible++;
        };

        if (aliveCount <= 6) {
            for (uint8_t i = 0; i < limit; i++) if (sessions[i].alive) appendSession(i);
        } else {
            // A bounded glance: input first, then active work, then enough quiet
            // context to reach five rows. The final row names every hidden state.
            for (uint8_t pass = 0; pass < 3 && visible < 5; pass++) {
                for (uint8_t i = 0; i < limit && visible < 5; i++) {
                    if (!sessions[i].alive || shown[i]) continue;
                    const bool input = strstr(sessions[i].state, "awaiting") != nullptr;
                    const bool working = strcmp(sessions[i].state, "processing") == 0;
                    if ((pass == 0 && input) || (pass == 1 && working) || pass == 2)
                        appendSession(i);
                }
            }

            uint8_t hiddenInput = 0, hiddenWork = 0, hiddenIdle = 0, hiddenReady = 0;
            for (uint8_t i = 0; i < limit; i++) {
                if (!sessions[i].alive || shown[i]) continue;
                if (strstr(sessions[i].state, "awaiting") != nullptr) hiddenInput++;
                else if (strcmp(sessions[i].state, "processing") == 0) hiddenWork++;
                else if (strcmp(sessions[i].state, "idle") == 0) hiddenIdle++;
                else hiddenReady++;
            }
            char hidden[96] = "";
            auto appendHidden = [&](uint8_t count, const char* label) {
                if (!count) return;
                size_t used = strlen(hidden);
                snprintf(hidden + used, sizeof(hidden) - used, "%s%d %s",
                         used ? " / " : "", count, label);
            };
            appendHidden(hiddenInput, "input");
            appendHidden(hiddenWork, "working");
            appendHidden(hiddenIdle, "idle");
            appendHidden(hiddenReady, "ready");
            if (hidden[0]) appendBounded(buf, sizeof(buf), pos, "#94A3B8 %s hidden#\n", hidden);
        }
    } else if (hasData) {
        // Fallback: show primary session info (only when real data received)
        uint32_t dotColor = agentDotColor(primaryAgent);
        uint32_t sColor = stateColor(primaryState);

        appendBounded(buf, sizeof(buf), pos,
            "#%06lX " LV_SYMBOL_BULLET "# %s  #%06lX " LV_SYMBOL_BULLET "#\n",
            (unsigned long)dotColor,
            primaryProject[0] ? primaryProject : "Agent",
            (unsigned long)sColor);
    } else {
        // No data yet — show connecting message
        appendBounded(buf, sizeof(buf), pos, "#808080 Connecting...#\n");
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
            appendBounded(buf, sizeof(buf), pos,
                "#%06lX " LV_SYMBOL_BULLET "# OpenClaw\n",
                (unsigned long)Theme::CrayfishShell);
        }
    }

    // Remove trailing newline
    if (pos > 0 && buf[pos - 1] == '\n') buf[pos - 1] = '\0';
    else buf[pos] = '\0';

    if (lblSessions) lv_label_set_text(lblSessions, buf);  // null on IPS10 (mosaic instead)
#endif

#if !defined(BOARD_IPS10)
    // === Right panel: per-provider water-tank groups ===
    // Claude group — updated + hidden as a unit when there's no Claude quota data
    // (a Codex-only user, or the App Store Swift daemon which can't read Claude
    // OAuth usage). Showing empty "--" tanks would read as broken.
    updateGauge(gauge5hFill, gauge5hPct, gauge5hReset, p5h, reset5h, usageStale);
    updateGauge(gauge7dFill, gauge7dPct, gauge7dReset, p7d, reset7d, usageStale);
    if (gauge5hBox) {
        if (p5h >= 0.0f) {
            lv_obj_clear_flag(lv_obj_get_parent(gauge5hBox), LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(lv_obj_get_parent(gauge5hBox), LV_OBJ_FLAG_HIDDEN);
        }
    }
    if (gauge7dBox) {
        if (p7d >= 0.0f) {
            lv_obj_clear_flag(lv_obj_get_parent(gauge7dBox), LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(lv_obj_get_parent(gauge7dBox), LV_OBJ_FLAG_HIDDEN);
        }
    }
    {
        bool showClaude = (p5h >= 0.0f || p7d >= 0.0f);
        if (claudeGroup) { showClaude ? lv_obj_clear_flag(claudeGroup, LV_OBJ_FLAG_HIDDEN) : lv_obj_add_flag(claudeGroup, LV_OBJ_FLAG_HIDDEN); }
    }

    // Codex group — same water-tank widget under a blue "● CODEX" header. Shown
    // whenever a Codex window is present, independent of Claude data.
    updateGauge(gaugeCx5hFill, gaugeCx5hPct, gaugeCx5hReset, cxP5h, cxReset5h, false);
    updateGauge(gaugeCx7dFill, gaugeCx7dPct, gaugeCx7dReset, cxP7d, cxReset7d, false);
    if (gaugeCx5hBox) {
        if (cxP5h >= 0.0f) {
            lv_obj_clear_flag(lv_obj_get_parent(gaugeCx5hBox), LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(lv_obj_get_parent(gaugeCx5hBox), LV_OBJ_FLAG_HIDDEN);
        }
    }
    if (gaugeCx7dBox) {
        if (cxP7d >= 0.0f) {
            lv_obj_clear_flag(lv_obj_get_parent(gaugeCx7dBox), LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(lv_obj_get_parent(gaugeCx7dBox), LV_OBJ_FLAG_HIDDEN);
        }
    }
    {
        bool showCodex = (cxP5h >= 0.0f || cxP7d >= 0.0f);
        if (codexGroup) { showCodex ? lv_obj_clear_flag(codexGroup, LV_OBJ_FLAG_HIDDEN) : lv_obj_add_flag(codexGroup, LV_OBJ_FLAG_HIDDEN); }
    }

    // Stale indicator (shown only when we have Claude data but it's stale)
    if (lblStale) {
        bool showStale = usageStale && (p5h >= 0.0f || p7d >= 0.0f);
        if (showStale) {
            lv_label_set_text(lblStale, "! stale");
            lv_obj_clear_flag(lblStale, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(lblStale, LV_OBJ_FLAG_HIDDEN);
        }
    }

    // Account chip (AGY plan + subscription expiries). Hidden when the daemon
    // supplies none (e.g. the App Store Swift daemon with no subscription data).
    if (acctChip) {
        if (chipBuf[0]) {
            lv_label_set_text(acctChipLabel, chipBuf);
            lv_obj_clear_flag(acctChip, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(acctChip, LV_OBJ_FLAG_HIDDEN);
        }
    }
#endif

#if defined(BOARD_IPS10)
    // === Living agent mosaic — one cell per agent, height fluidly tracks activity,
    //     each cell narrates inline what that agent is doing. ===
    if (cellsBox) {
        struct MCell { uint32_t accent; uint32_t stateCol; char name[40]; char agent[16]; char state[20];
                       char model[32]; char tool[40]; uint32_t elapsed;
                       char sid[32]; char requestId[40]; char question[160]; char body[240];
                       // Older per-session milestone rows (newest-first) for the
                       // card's TIMELINE feed — rendered dimmed under `body`,
                       // count gated by the cell height at label-set time.
                       char feed[3][120]; uint8_t feedCount;
                       char activity[80]; bool childrenKnown; uint16_t childrenActive; uint16_t childrenCompleted; };
        // static: ~10 × 1.2KB no longer fits comfortably on the LVGL task
        // stack; update() is only ever entered from the single UI task.
        static MCell mc[MOSAIC_MAX];
        int n = 0;

        lockState();
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
            mc[n].childrenKnown = si.childrenKnown;
            mc[n].childrenActive = si.childrenActive;
            mc[n].childrenCompleted = si.childrenCompleted;
            strncpy(mc[n].sid, si.id, sizeof(mc[n].sid) - 1); mc[n].sid[sizeof(mc[n].sid) - 1] = '\0';
            strncpy(mc[n].requestId, si.requestId, sizeof(mc[n].requestId) - 1); mc[n].requestId[sizeof(mc[n].requestId) - 1] = '\0';
            strncpy(mc[n].question, si.question, sizeof(mc[n].question) - 1); mc[n].question[sizeof(mc[n].question) - 1] = '\0';
            strncpy(mc[n].activity, si.activity, sizeof(mc[n].activity) - 1); mc[n].activity[sizeof(mc[n].activity) - 1] = '\0';
            // Card body = this session's latest MILESTONE line, TIMELINE-style
            // ("HH:MM task • text"). Primary source is the DAEMON-computed
            // lastEvent* fields on sessions_list — the daemon owns the full
            // timeline store, so this survives board reboots (the on-device
            // ring starts empty and only ever holds a 64-row window). The
            // on-device ring compose remains as a fallback for daemons that
            // don't send lastEvent* yet. Separator is U+2022 (LV_SYMBOL_BULLET):
            // montserrat has it; U+00B7 " · " is in NEITHER montserrat nor the
            // Noto KR fallback (한글 syllables only) → drew a tofu box.
            mc[n].body[0] = '\0';
            if (si.lastEventText[0]) {
                size_t off = 0;
                auto append = [&](const char* part, const char* suffix) {
                    if (!part || !part[0] || off >= sizeof(mc[n].body) - 1) return;
                    int nn = snprintf(mc[n].body + off, sizeof(mc[n].body) - off, "%s%s", part, suffix);
                    if (nn > 0) off += (size_t)nn;
                    if (off >= sizeof(mc[n].body)) off = sizeof(mc[n].body) - 1;
                };
                append(si.lastEventHm, "  ");
                append(si.lastEventTask, " " LV_SYMBOL_BULLET " ");
                append(si.lastEventText, "");
                Utf8::utf8TrimEnd(mc[n].body);   // snprintf byte cap can split a 한글 glyph
            }
            // Fallback: newest milestone row for this session from the on-device
            // ring. Milestone-only — per-tool rows ("Bash") are command spam at
            // glance distance, exactly the meaningless text this card replaced.
            for (uint8_t k = 0; k < g_state.timelineCount && !mc[n].body[0]; k++) {
                uint8_t bidx = (uint8_t)((g_state.timelineHead + g_state.timelineCount - 1 - k) % TIMELINE_MAX_ENTRIES);
                const TimelineEntry& te = g_state.timeline[bidx];
                if (strcmp(te.sessionId, si.id) != 0) continue;
                if (!te.raw[0] || te.raw[0] == '{' || te.raw[0] == '[') continue;
                // Turn rows only — task_start/task_end are data-only hierarchy
                // markers (one-row-per-task contract, shared/src/
                // timeline-task-display.ts): a reaper-synthesized
                // "Interrupted · ~6h" must never surface as a card's body line.
                bool milestone = strcmp(te.type, "chat_start") == 0 || strcmp(te.type, "chat_response") == 0 ||
                                 strcmp(te.type, "chat_end") == 0;
                if (!milestone) continue;
                size_t off = 0;
                if (te.hm[0]) {
                    int nn = snprintf(mc[n].body + off, sizeof(mc[n].body) - off, "%s  ", te.hm);
                    if (nn > 0) off += (size_t)nn;
                }
                if (te.taskId[0]) {  // resolve taskId → task header label (context chip)
                    for (uint8_t j = 0; j < g_state.timelineCount; j++) {
                        const TimelineEntry& tj = g_state.timeline[(g_state.timelineHead + j) % TIMELINE_MAX_ENTRIES];
                        if (strcmp(tj.type, "task_start") == 0 && strcmp(tj.taskId, te.taskId) == 0 && tj.raw[0]) {
                            // The task label is CONTEXT — cap it (UTF-8-safe) so the row's
                            // actual text always fits. Un-capped, a long task header filled
                            // the whole body and the card showed a cut-off header + nothing.
                            char task[48];
                            strncpy(task, tj.raw, sizeof(task) - 1); task[sizeof(task) - 1] = '\0';
                            Utf8::utf8TrimEnd(task);
                            int nn = snprintf(mc[n].body + off, sizeof(mc[n].body) - off, "%s " LV_SYMBOL_BULLET " ", task);
                            if (nn > 0) off += (size_t)nn;
                            if (off >= sizeof(mc[n].body)) off = sizeof(mc[n].body) - 1;
                            break;
                        }
                    }
                }
                if (off < sizeof(mc[n].body) - 1)
                    snprintf(mc[n].body + off, sizeof(mc[n].body) - off, "%s", te.raw);
                Utf8::utf8TrimEnd(mc[n].body);
                break;
            }
            // Older milestones → the card's dimmed TIMELINE feed rows (newest
            // first, "HH:MM  text"). Tall treemap cells were mostly empty deck;
            // per-session history is the valuable content to fill them with.
            mc[n].feedCount = 0;
            {
                bool skippedNewest = false;   // the row already surfaced as `body`
                for (uint8_t k = 0; k < g_state.timelineCount && mc[n].feedCount < 3; k++) {
                    uint8_t bidx = (uint8_t)((g_state.timelineHead + g_state.timelineCount - 1 - k) % TIMELINE_MAX_ENTRIES);
                    const TimelineEntry& te = g_state.timeline[bidx];
                    if (strcmp(te.sessionId, si.id) != 0) continue;
                    if (!te.raw[0] || te.raw[0] == '{' || te.raw[0] == '[') continue;
                    // Turn rows only (see the one-row-per-task note above).
                    bool milestone = strcmp(te.type, "chat_start") == 0 || strcmp(te.type, "chat_response") == 0 ||
                                     strcmp(te.type, "chat_end") == 0;
                    if (!milestone) continue;
                    if (!skippedNewest) {
                        skippedNewest = true;
                        // The newest ring milestone is (or duplicates) the body line.
                        if (mc[n].body[0]) continue;
                    }
                    char* row = mc[n].feed[mc[n].feedCount];
                    size_t off = 0;
                    if (te.hm[0]) {
                        int nn = snprintf(row, sizeof(mc[n].feed[0]), "%s  ", te.hm);
                        if (nn > 0) off = (size_t)nn;
                    }
                    if (off < sizeof(mc[n].feed[0]) - 1)
                        snprintf(row + off, sizeof(mc[n].feed[0]) - off, "%s", te.raw);
                    Utf8::utf8TrimEnd(row);
                    mc[n].feedCount++;
                }
            }
            n++;
        }
        bool hasOC = false;
        for (int i = 0; i < n; i++) if (strstr(mc[i].agent, "openclaw")) hasOC = true;
        if (g_state.gatewayConnected && !hasOC && n < MOSAIC_MAX) {
            mc[n].accent = Theme::CrayfishShell; mc[n].stateCol = Theme::StatusGreen;
            strcpy(mc[n].name, "OpenClaw"); strcpy(mc[n].agent, "openclaw");
            strcpy(mc[n].state, "idle"); mc[n].model[0] = '\0'; mc[n].tool[0] = '\0'; mc[n].elapsed = 0;
            mc[n].sid[0] = '\0'; mc[n].requestId[0] = '\0'; mc[n].question[0] = '\0'; mc[n].body[0] = '\0';
            mc[n].feedCount = 0; mc[n].activity[0] = '\0';
            mc[n].childrenKnown = false; mc[n].childrenActive = 0; mc[n].childrenCompleted = 0; n++;
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
            mc[0].sid[0] = '\0'; mc[0].requestId[0] = '\0'; mc[0].body[0] = '\0'; mc[0].feedCount = 0;
            mc[0].activity[0] = '\0';
            strncpy(mc[0].question, g_state.question, sizeof(mc[0].question) - 1); mc[0].question[sizeof(mc[0].question) - 1] = '\0';
            n = 1;
        }
        unlockState();

        for (int i = 0; i < n; i++) {  // protect recolor markup
            for (char* c = mc[i].name; *c; c++) if (*c == '#' || *c == '\n') *c = ' ';
            for (char* c = mc[i].tool; *c; c++) if (*c == '#' || *c == '\n') *c = ' ';
            for (char* c = mc[i].body; *c; c++) if (*c == '#' || *c == '\n') *c = ' ';
            for (char* c = mc[i].activity; *c; c++) if (*c == '#' || *c == '\n') *c = ' ';
            // question + feed ride the recolor-enabled body label now.
            for (char* c = mc[i].question; *c; c++) if (*c == '#' || *c == '\n') *c = ' ';
            for (uint8_t r = 0; r < mc[i].feedCount; r++)
                for (char* c = mc[i].feed[r]; *c; c++) if (*c == '#' || *c == '\n') *c = ' ';
        }

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
        // Top-bar usage gauges. Claude 5h/7d (cyan) always shown; Codex CX 5h/7d
        // (blue) appear only when limits exist; Antigravity credits as a text chip.
        // Percent + reset countdown + stale "!" mirror the plugin water-tank gauge.
        setTopbarGauge(tb5hFill, tb5hPct, p5h, reset5h, usageStale, D1_OK);
        setTopbarGauge(tb7dFill, tb7dPct, p7d, reset7d, usageStale, D1_OK);

        // Per-window visibility: after a Codex 5h reset the 5H window vanishes
        // entirely (the 7d window flips to the primary slot) — a "-" gauge next
        // to the live 7D read as breakage, so a missing window hides its whole
        // group instead.
        bool hasCodex = (pcx5h >= 0.0f || pcx7d >= 0.0f);
        if (tbCodexBlock) {
            if (hasCodex) lv_obj_clear_flag(tbCodexBlock, LV_OBJ_FLAG_HIDDEN);
            else          lv_obj_add_flag(tbCodexBlock, LV_OBJ_FLAG_HIDDEN);
        }
        if (tbCx5hGrp) {
            if (pcx5h >= 0.0f) lv_obj_clear_flag(tbCx5hGrp, LV_OBJ_FLAG_HIDDEN);
            else               lv_obj_add_flag(tbCx5hGrp, LV_OBJ_FLAG_HIDDEN);
        }
        if (tbCx7dGrp) {
            if (pcx7d >= 0.0f) lv_obj_clear_flag(tbCx7dGrp, LV_OBJ_FLAG_HIDDEN);
            else               lv_obj_add_flag(tbCx7dGrp, LV_OBJ_FLAG_HIDDEN);
        }
        if (hasCodex) {
            setTopbarGauge(tbCx5hFill, tbCx5hPct, pcx5h, resetCx5h, false, D1_CODEX);
            setTopbarGauge(tbCx7dFill, tbCx7dPct, pcx7d, resetCx7d, false, D1_CODEX);
        }

        if (tbAg) {
            // The raw credit count is backend metering with no user-facing meaning,
            // so the chip shows just the brand mark + the subscription plan name
            // (the icon already says "Antigravity" — no "AG" text prefix). Visible
            // whenever a plan or any antigravity status is present.
            bool hasAg = (agPlan[0] != '\0') || (agCredits >= 0.0f);
            if (hasAg) {
                if (agPlan[0]) {
                    char ab[40];
                    snprintf(ab, sizeof(ab), "#F3D233 %s#", agPlan);
                    lv_label_set_text(tbAg, ab);
                } else {
                    lv_label_set_text(tbAg, "");
                }
                if (tbAgIcon) lv_obj_clear_flag(tbAgIcon, LV_OBJ_FLAG_HIDDEN);
                lv_obj_clear_flag(tbAg, LV_OBJ_FLAG_HIDDEN);
            } else {
                if (tbAgIcon) lv_obj_add_flag(tbAgIcon, LV_OBJ_FLAG_HIDDEN);
                lv_obj_add_flag(tbAg, LV_OBJ_FLAG_HIDDEN);
            }
        }
        if (terrCount) {
            char tc[64]; snprintf(tc, sizeof(tc), "PROJECT ROOMS " LV_SYMBOL_BULLET " %d SESSIONS", n);
            lv_label_set_text(terrCount, tc);
        }

        // Use the KNOWN panel geometry, not lv_obj_get_content_width/height — those
        // return stale/partial values depending on layout timing, which made the
        // treemap fill only a small top-left corner of the (correctly-sized) region.
        int availW = ips10SidebarW - 30;                 // panel content width (− border/pad)
        int availH = lv_obj_get_content_height(cellsBox);
        if (availH < 320) availH = (g_screenH - 16) - 150;  // robust fallback (logo + usage bands)

        // Identity-sorted, equal-sized work cards. State changes never move a
        // session or imply work percentage. Overflow scrolls rather than shrinking
        // labels; the terrarium remains visible beside the bounded card region.
        int order[MOSAIC_MAX];
        for (int i = 0; i < n; i++) order[i] = i;
        for (int a = 0; a < n; a++)
            for (int b = a + 1; b < n; b++)
                if (strcmp(mc[order[b]].sid, mc[order[a]].sid) < 0) {
                    int tmp = order[a]; order[a] = order[b]; order[b] = tmp;
                }
        float tgtX[MOSAIC_MAX], tgtY[MOSAIC_MAX], tgtW[MOSAIC_MAX], tgtH[MOSAIC_MAX];
        for (int rank = 0; rank < n; rank++) {
            const auto rect = CollaborationLayout::cell(rank, n, availW, availH);
            const int i = order[rank];
            tgtX[i] = rect.x; tgtY[i] = rect.y; tgtW[i] = rect.width; tgtH[i] = rect.height;
        }

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
            if (detailCellIdx == i && strcmp(cm.sid, mc[i].sid) != 0) detailClose();
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
#if defined(BOARD_IPS10) && defined(BOARD_HAS_VOICE_CAPTURE)
            bool voiceSel = (voiceTargetSid[0] && mc[i].sid[0] &&
                             strcmp(voiceTargetSid, mc[i].sid) == 0);
#else
            const bool voiceSel = false;
#endif

            lv_obj_clear_flag(cell[i], LV_OBJ_FLAG_HIDDEN);
            lv_obj_set_pos(cell[i], px, py);     // LVGL no-ops these when unchanged (settled)
            lv_obj_set_size(cell[i], pw, ph);

            // Change signature (content + size + focus). Skip label churn when unchanged.
            uint32_t sig = 2166136261u;
            sig ^= (uint32_t)mc[i].childrenActive * 131u + (uint32_t)mc[i].childrenCompleted * 17u
                + (mc[i].childrenKnown ? 97u : 0u);
            for (const char* s = mc[i].sid; *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (const char* s = mc[i].state;    *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (const char* s = mc[i].name;     *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (const char* s = mc[i].tool;     *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (const char* s = mc[i].model;    *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (const char* s = mc[i].question; *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (const char* s = mc[i].body;     *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (const char* s = mc[i].activity; *s; s++) sig = sig * 31u + (uint8_t)*s;
            for (uint8_t r = 0; r < mc[i].feedCount; r++)
                for (const char* s = mc[i].feed[r]; *s; s++) sig = sig * 31u + (uint8_t)*s;
            sig ^= (uint32_t)mc[i].elapsed + (uint32_t)(pw * 131) + (uint32_t)(ph * 17)
                 + (linked ? 7u : 0u) + (voiceSel ? 13u : 0u);
            if (sig == cellSig[i]) continue;     // settled + unchanged → no LVGL work
            cellSig[i] = sig;

            // accent rail = STATE colour (data.js: the cell's --accent is the state, so awaiting
            // reads amber, working cyan, etc. at a glance); the agent identity is the glyph.
            // Focus just thickens the same rail.
            lv_obj_set_style_border_width(cell[i], linked ? 4 : 3, 0);
            lv_obj_set_style_border_color(cell[i], lv_color_hex(mc[i].stateCol), 0);
            // Voice target = cyan outline around the whole card, independent of
            // the state rail: the selection must stay visible while the state
            // colour changes underneath it.
            lv_obj_set_style_outline_width(cell[i], voiceSel ? 3 : 0, 0);
            lv_obj_set_style_outline_pad(cell[i], 2, 0);
            lv_obj_set_style_outline_color(cell[i], lv_color_hex(D1_OK), 0);

            int innerW = pw - 24; if (innerW < 24) innerW = 24;

            // Creature mark — top-right overlay, tinted to the agent accent, sized to the
            // cell (32–60px). Skipped on tiny cells and for unknown agents with no mask.
            const lv_image_dsc_t* gdsc = ips10AgentGlyph(mc[i].agent);
            int glyphSz = 0;
            // On narrow idle tiles the mark used to consume the name column and
            // split provider names mid-word. Text is the primary identity here;
            // the large decorative mark earns space only on genuinely wide cards.
            if (gdsc && pw >= 220 && ph >= 52) {
                const bool agGlyph = ips10IsAntigravityAgent(mc[i].agent);
                glyphSz = (pw < ph ? pw : ph) * 42 / 100;
                if (glyphSz < 32) glyphSz = 32;
                if (glyphSz > 60) glyphSz = 60;
                lv_image_set_src(cellGlyph[i], gdsc);
                if (agGlyph) {
                    lv_obj_set_style_image_recolor_opa(cellGlyph[i], LV_OPA_TRANSP, 0);
                } else {
                    lv_obj_set_style_image_recolor_opa(cellGlyph[i], LV_OPA_COVER, 0);
                    lv_obj_set_style_image_recolor(cellGlyph[i], lv_color_hex(mc[i].accent), 0);
                }
                lv_image_set_scale(cellGlyph[i], 256 * glyphSz / 64);   // 64px mask → glyphSz px
                lv_obj_align(cellGlyph[i], LV_ALIGN_TOP_RIGHT, -8, 6);
                lv_obj_clear_flag(cellGlyph[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellGlyph[i], LV_OBJ_FLAG_HIDDEN);
            }

            int nameW = innerW - (glyphSz ? glyphSz + 8 : 0); if (nameW < 24) nameW = 24;
            // A fixed one-line box lets LONG_DOT do its job. Without the height
            // constraint LVGL wrapped long provider names despite LONG_DOT.
            const bool compactName = pw < 220;
            lv_obj_set_style_text_font(cellName[i], compactName ? &font_kr_16 : &font_kr_20, 0);
            lv_obj_set_width(cellName[i], nameW);
            lv_obj_set_height(cellName[i], compactName ? 24 : 30);
            lv_obj_set_width(cellProj[i], innerW);
            lv_obj_set_width(cellTool[i], innerW);
            lv_obj_set_width(cellBody[i], innerW);
            lv_obj_set_width(cellMeta[i], innerW);

            // name line: ●agent-name — state now lives in the pill chip below.
            char nb[64];
            snprintf(nb, sizeof(nb), "#%06lX " LV_SYMBOL_BULLET "# %s",
                     (unsigned long)mc[i].accent, ips10AgentLabel(mc[i].agent));
            lv_label_set_text(cellName[i], nb);
            if (cellCoord[i]) {
            lv_obj_set_width(cellCoord[i], innerW);
            lv_obj_set_height(cellCoord[i], 24);
            char* coord = cellCoordText[i];
            if (mc[i].childrenKnown) {
                snprintf(coord, sizeof(cellCoordText[i]), LV_SYMBOL_SHUFFLE " 하위 %u 활동 / %u 종료", mc[i].childrenActive, mc[i].childrenCompleted);
            } else {
                snprintf(coord, sizeof(cellCoordText[i]), "하위 관계 미관측");
            }
            lv_label_set_text_static(cellCoord[i], coord);
            lv_obj_set_style_text_color(cellCoord[i], lv_color_hex(mc[i].childrenKnown && mc[i].childrenActive > 0
                ? Theme::DeepSea : Theme::HUDFaint), 0);
            lv_obj_set_style_bg_color(cellCoord[i], lv_color_hex(mc[i].childrenKnown && mc[i].childrenActive > 0
                ? D1_OK : Theme::HUDText), 0);
            }

            // state pill chip — bright states get dark text; the dim idle bg gets light text.
            if (ph >= 44) {
                char parentState[64];
                snprintf(parentState, sizeof(parentState), "주 에이전트 %s", ips10StatePill(mc[i].state));
                lv_label_set_text(cellPill[i], parentState);
                lv_obj_set_style_bg_color(cellPill[i], lv_color_hex(mc[i].stateCol), 0);
                lv_obj_set_style_text_color(cellPill[i],
                    lv_color_hex(idle ? 0x1E293B : 0x05140F), 0);
                lv_obj_set_style_bg_opa(cellPill[i], idle ? (lv_opa_t)90 : LV_OPA_COVER, 0);
                lv_obj_clear_flag(cellPill[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellPill[i], LV_OBJ_FLAG_HIDDEN);
            }

            // project (dim) — its own line under the name
            if (ph >= 56 && mc[i].name[0]) {
                char projBuf[64];
                const size_t sidLen = strlen(mc[i].sid);
                snprintf(projBuf, sizeof(projBuf), "%s " LV_SYMBOL_BULLET " %s", mc[i].name,
                         sidLen > 6 ? mc[i].sid + sidLen - 6 : mc[i].sid);
                sanitizeIps10Text(projBuf);
                lv_label_set_text(cellProj[i], projBuf);
                lv_obj_clear_flag(cellProj[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellProj[i], LV_OBJ_FLAG_HIDDEN);
            }

            // tool box (working/awaiting, when there's room)
            if (!idle && mc[i].tool[0] && ph >= 300) {
                char tb[64]; snprintf(tb, sizeof(tb), LV_SYMBOL_PLAY " %s", mc[i].tool);
                sanitizeIps10Text(tb);
                lv_label_set_text(cellTool[i], tb);
                lv_obj_clear_flag(cellTool[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellTool[i], LV_OBJ_FLAG_HIDDEN);
            }

            // body: awaiting → prompt; otherwise → this session's OWN latest
            // milestone line ("HH:MM task • text"), then its live activity
            // one-liner. STRICTLY per-session — the old global latest-action
            // fallback painted some OTHER session's row onto whichever working
            // card rendered first, which read as wrong/meaningless info.
            // Idle cards keep their milestone too (InkDeck parity: an idle
            // session showing "what it last did" beats a blank card).
            const char* body = "";
            if (awaiting && mc[i].question[0]) body = mc[i].question;
            else if (!idle && mc[i].activity[0]) body = mc[i].activity;
            else if (mc[i].body[0]) body = mc[i].body;
            if (body[0] && ph >= 104) {
                // TIMELINE feed: the newest line renders bright; up to
                // `feedCount` older rows follow dimmed (recolor markup), the
                // count gated by cell height so tall treemap cells spend their
                // former empty deck on per-session history.
                char full[900];
                size_t off = (size_t)snprintf(full, sizeof(full), "%s", body);
                if (off >= sizeof(full)) off = sizeof(full) - 1;
                int extraRows = ph >= 380 ? 3 : (ph >= 280 ? 2 : (ph >= 190 ? 1 : 0));
                // An awaiting card leads with the question — its milestone line
                // (mc.body) joins the dimmed history instead of vanishing, so
                // the tall amber tile still tells what the agent was doing.
                if (awaiting && body == mc[i].question && mc[i].body[0] && extraRows > 0
                    && off < sizeof(full) - 16) {
                    int nn = snprintf(full + off, sizeof(full) - off, "\n#64748b %s#", mc[i].body);
                    if (nn > 0) off += (size_t)nn;
                    if (off >= sizeof(full)) off = sizeof(full) - 1;
                    extraRows--;
                }
                if (extraRows > mc[i].feedCount) extraRows = mc[i].feedCount;
                for (int r = 0; r < extraRows && off < sizeof(full) - 16; r++) {
                    int nn = snprintf(full + off, sizeof(full) - off, "\n#64748b %s#", mc[i].feed[r]);
                    if (nn > 0) off += (size_t)nn;
                    if (off >= sizeof(full)) off = sizeof(full) - 1;
                }
                Utf8::utf8TrimEnd(full);   // byte cap can split a 한글 glyph
                sanitizeIps10Text(full);
                lv_label_set_text(cellBody[i], full);
                lv_obj_set_height(cellBody[i], ph >= 300 ? 80 : 40);
                lv_obj_clear_flag(cellBody[i], LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(cellBody[i], LV_OBJ_FLAG_HIDDEN);
            }

            // Attention-only: awaiting is a DISPLAY state now (parity with every
            // other board). The awaiting cell still swells + turns amber + shows
            // the prompt text as its own attention, but there are no on-device
            // Approve/Deny buttons — the user answers in the terminal/host. The
            // cellYes/cellNo objects stay created (layout invariants) but never
            // show. `showButtons` is kept so the footer keeps its space.
            const bool showButtons = false;
            lv_obj_add_flag(cellYes[i], LV_OBJ_FLAG_HIDDEN);
            lv_obj_add_flag(cellNo[i], LV_OBJ_FLAG_HIDDEN);

            // footer: model · elapsed (idle cards show just header + this). Hidden when
            // the inline buttons own the space.
            char el[12]; ips10FormatElapsed(mc[i].elapsed, el, sizeof(el));
            if (!showButtons && ph >= 300 && (mc[i].model[0] || el[0])) {
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
    bool showTankStatus = connected && (p5h >= 0.0f || p7d >= 0.0f
#if !defined(BOARD_IPS10)
        // A Codex-only user (or the Swift daemon, which has no Claude quota) still
        // gets the panel so its Codex tanks / account chip are visible.
        || cxP5h >= 0.0f || cxP7d >= 0.0f || chipBuf[0]
#endif
    );
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

#if defined(BOARD_IPS10) && defined(BOARD_HAS_VOICE_CAPTURE)
void setListening(const char* target) {
    char line[128];
    snprintf(line, sizeof(line), "Listening · %s", (target && target[0]) ? target : "(no session)");
    voiceUiPost(VoiceUiOp::LISTENING, line);
}

void clearListening() {
    voiceUiPost(VoiceUiOp::HIDE, nullptr);
}

void setSpeaking(const char* text) {
    char line[128];
    snprintf(line, sizeof(line), "Reply · %s", (text && text[0]) ? text : "(playing)");
    voiceUiPost(VoiceUiOp::SPEAKING, line);
}

void clearSpeaking() {
    voiceUiPost(VoiceUiOp::HIDE, nullptr);
}

void notify(const char* text) {
    voiceUiPost(VoiceUiOp::NOTICE, text);
}

void pushVoiceQuestion(const char* q) {
    if (!q || !q[0]) return;
    char safe[72];
    snprintf(safe, sizeof(safe), "%s", q);
    Utf8::sanitizeLvglText(safe);
    Utf8::utf8TrimEnd(safe);
    portENTER_CRITICAL(&voiceUiMux);
    voiceQA[1] = voiceQA[0];
    snprintf(voiceQA[0].q, sizeof(voiceQA[0].q), "%s", safe);
    voiceQA[0].a[0] = '\0';
    if (voiceQACount < 2) voiceQACount++;
    voiceQADirty = true;
    portEXIT_CRITICAL(&voiceUiMux);
}

void setVoiceAnswer(const char* a) {
    if (!a || !a[0]) return;
    char safe[96];
    snprintf(safe, sizeof(safe), "%s", a);
    Utf8::sanitizeLvglText(safe);
    Utf8::utf8TrimEnd(safe);
    portENTER_CRITICAL(&voiceUiMux);
    if (voiceQACount > 0) {
        snprintf(voiceQA[0].a, sizeof(voiceQA[0].a), "%s", safe);
        voiceQADirty = true;
    }
    portEXIT_CRITICAL(&voiceUiMux);
}
#endif

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
