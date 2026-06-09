#include "hud_bar.h"
#include "../theme.h"
#include "../display.h"
#include "../../state/agent_state.h"
#include "config.h"
#include "net/serial_client.h"

// === Left panel: AgentDeck logo + session list ===
static lv_obj_t* panelLeft = nullptr;
static lv_obj_t* lblLogo = nullptr;
static lv_obj_t* logoLine = nullptr;   // accent underline
static lv_obj_t* lblSessions = nullptr;

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

void init(lv_obj_t* parent) {
#if IS_ROUND
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
    SessionInfo sessions[6];
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
        for (uint8_t i = 0; i < sessionCount && i < 6; i++) {
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

    lv_label_set_text(lblSessions, buf);

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

    bool connected = hasData && (g_state.wsConnected || Net::serialConnected());
    bool showTankStatus = connected && (p5h >= 0.0f || p7d >= 0.0f);
    if (firstUpdate || showTankStatus != lastShowTankStatus) {
        firstUpdate = false;
        lastShowTankStatus = showTankStatus;

        if (showTankStatus) {
            if (panelRight && visible) {
                lv_obj_clear_flag(panelRight, LV_OBJ_FLAG_HIDDEN);
            }
#if !IS_ROUND
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
#if !IS_ROUND
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
