#include "ttgo_state.h"
#include "../theme.h"
#include "../display.h"
#include "../../state/agent_state.h"
#include "../boards/board_config.h"
#include "config.h"
#include <cstring>
#include <cstdio>
#include <algorithm>
#include "net/serial_client.h"

using std::min;

// State widget objects
static lv_obj_t* widget = nullptr;
static lv_obj_t* lblState = nullptr;    // Agent state label
static lv_obj_t* lblProject = nullptr;   // Project name
static lv_obj_t* lblModel = nullptr;     // Model name

// Mini usage gauges
static lv_obj_t* lblUsage5h = nullptr;
static lv_obj_t* lblUsage7d = nullptr;

static bool visible = true;

#if defined(BOARD_TTGO)
static constexpr int TTGO_TERRARIUM_LONG_EDGE = 160;
static constexpr uint32_t TTGO_METRIC_BG = 0x2A1F14;

static lv_obj_t* createMetricPanel(lv_obj_t* parent, bool portrait, int screenW, int screenH) {
    lv_obj_t* panel = lv_obj_create(parent);
    if (portrait) {
        lv_obj_set_size(panel, screenW, screenH - TTGO_TERRARIUM_LONG_EDGE);
        lv_obj_set_pos(panel, 0, TTGO_TERRARIUM_LONG_EDGE);
    } else {
        lv_obj_set_size(panel, screenW - TTGO_TERRARIUM_LONG_EDGE, screenH);
        lv_obj_set_pos(panel, TTGO_TERRARIUM_LONG_EDGE, 0);
    }
    lv_obj_set_style_bg_color(panel, lv_color_hex(TTGO_METRIC_BG), 0);
    lv_obj_set_style_bg_opa(panel, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(panel, 0, 0);
    lv_obj_set_style_radius(panel, 0, 0);
    lv_obj_set_style_pad_all(panel, 0, 0);
    lv_obj_clear_flag(panel, LV_OBJ_FLAG_SCROLLABLE);
    return panel;
}
#endif

// Helper: get state color for agent state
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

// Helper: get state string
static const char* stateString(AgentState st) {
    switch (st) {
        case AgentState::DISCONNECTED:       return "DISCONN";
        case AgentState::IDLE:               return "IDLE";
        case AgentState::PROCESSING:         return "PROCESSING";
        case AgentState::AWAITING_PERMISSION:return "AWAITING";
        case AgentState::AWAITING_OPTION:    return "OPTIONS";
        case AgentState::AWAITING_DIFF:      return "DIFF";
        default:                             return "UNKNOWN";
    }
}

/** One provider per compact line when both Claude and Codex must share the two
 * usage rows. Absent windows are omitted instead of rendered as a phantom `--`. */
static void formatProviderUsage(char* out, size_t outSize, const char* provider,
                                float fiveHour, float sevenDay) {
    if (fiveHour >= 0.0f && sevenDay >= 0.0f) {
        snprintf(out, outSize, "%s 5:%d 7:%d%%", provider, (int)fiveHour, (int)sevenDay);
    } else if (fiveHour >= 0.0f) {
        snprintf(out, outSize, "%s 5h:%d%%", provider, (int)fiveHour);
    } else if (sevenDay >= 0.0f) {
        snprintf(out, outSize, "%s 7d:%d%%", provider, (int)sevenDay);
    } else {
        out[0] = '\0';
    }
}

static void setUsageLabel(lv_obj_t* label, const char* text) {
    if (text && text[0]) {
        lv_label_set_text(label, text);
        lv_obj_clear_flag(label, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(label, LV_OBJ_FLAG_HIDDEN);
    }
}

namespace TTGO {
namespace StateWidget {

lv_obj_t* create(lv_obj_t* parent) {
    const bool portrait = !UI::isLandscape();
    const int screenW = g_screenW;
    const int screenH = g_screenH;

    // Main widget container
    widget = lv_obj_create(parent);
    lv_obj_set_size(widget, screenW, screenH);
    lv_obj_set_pos(widget, 0, 0);
#if defined(BOARD_TTGO)
    lv_obj_set_style_bg_opa(widget, LV_OPA_TRANSP, 0);
#else
    lv_obj_set_style_bg_color(widget, lv_color_hex(0x000000), 0);
    lv_obj_set_style_bg_opa(widget, LV_OPA_50, 0);
#endif
    lv_obj_set_style_border_width(widget, 0, 0);
    lv_obj_set_style_pad_all(widget, 0, 0);
    lv_obj_clear_flag(widget, LV_OBJ_FLAG_SCROLLABLE);

#if defined(BOARD_TTGO)
    lv_obj_t* content = createMetricPanel(widget, portrait, screenW, screenH);
    const int contentW = portrait ? screenW : (screenW - TTGO_TERRARIUM_LONG_EDGE);
#else
    lv_obj_t* content = widget;
    const int contentW = screenW;
#endif

    if (portrait) {
        // ===== Portrait layout =====

        // Top section: State label
#if defined(BOARD_TTGO)
        lblState = lv_label_create(content);
        lv_obj_set_style_text_font(lblState, &lv_font_montserrat_12, 0);
        lv_obj_align(lblState, LV_ALIGN_TOP_MID, 0, 5);
#else
        lblState = lv_label_create(content);
        lv_obj_set_style_text_font(lblState, &lv_font_montserrat_14, 0);
        lv_obj_align(lblState, LV_ALIGN_TOP_MID, 0, 8);
#endif
        lv_obj_set_style_text_color(lblState, lv_color_hex(Theme::StatusGreen), 0);
        lv_label_set_text(lblState, "● IDLE");

        // Middle section: Project name (large, centered)
        lblProject = lv_label_create(content);
        lv_obj_set_style_text_font(lblProject, &font_kr_12, 0);
        lv_obj_set_style_text_color(lblProject, lv_color_hex(Theme::HUDText), 0);
        lv_obj_set_width(lblProject, contentW - 16);
        lv_obj_set_style_text_align(lblProject, LV_TEXT_ALIGN_CENTER, 0);
#if defined(BOARD_TTGO)
        lv_obj_align(lblProject, LV_ALIGN_TOP_MID, 0, 23);
#else
        lv_obj_align(lblProject, LV_ALIGN_TOP_MID, 0, 32);
#endif
        lv_label_set_long_mode(lblProject, LV_LABEL_LONG_DOT);
        lv_label_set_text(lblProject, "Connecting...");

        // Model name (medium, centered)
        lblModel = lv_label_create(content);
        lv_obj_set_style_text_font(lblModel, &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(lblModel, lv_color_hex(Theme::HUDDim), 0);
        lv_obj_set_style_text_align(lblModel, LV_TEXT_ALIGN_CENTER, 0);
#if defined(BOARD_TTGO)
        lv_obj_align(lblModel, LV_ALIGN_TOP_MID, 0, 42);
#else
        lv_obj_align(lblModel, LV_ALIGN_TOP_MID, 0, 54);
#endif
        lv_label_set_long_mode(lblModel, LV_LABEL_LONG_DOT);
        lv_obj_set_width(lblModel, contentW - 16);
        lv_label_set_text(lblModel, "");

        // Bottom section: Mini usage gauges
        // Simple text display: "5h: 47%" and "7d: 32%"
        lblUsage5h = lv_label_create(content);
        lv_obj_set_style_text_font(lblUsage5h, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(lblUsage5h, lv_color_hex(Theme::HUDDim), 0);
        lv_obj_align(lblUsage5h, LV_ALIGN_BOTTOM_LEFT, 8, -8);
        lv_label_set_text(lblUsage5h, "5h: --");

        lblUsage7d = lv_label_create(content);
        lv_obj_set_style_text_font(lblUsage7d, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(lblUsage7d, lv_color_hex(Theme::HUDDim), 0);
        lv_obj_align(lblUsage7d, LV_ALIGN_BOTTOM_RIGHT, -8, -8);
        lv_label_set_text(lblUsage7d, "7d: --");

    } else {
        // ===== Landscape layout =====

#if defined(BOARD_TTGO)
        lblState = lv_label_create(content);
        lv_obj_set_style_text_font(lblState, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(lblState, lv_color_hex(Theme::StatusGreen), 0);
        lv_obj_set_width(lblState, contentW - 8);
        lv_obj_align(lblState, LV_ALIGN_TOP_MID, 0, 8);
        lv_label_set_long_mode(lblState, LV_LABEL_LONG_DOT);
        lv_label_set_text(lblState, "● IDLE");

        lblProject = lv_label_create(content);
        lv_obj_set_style_text_font(lblProject, &font_kr_12, 0);
        lv_obj_set_style_text_color(lblProject, lv_color_hex(Theme::HUDText), 0);
        lv_obj_set_width(lblProject, contentW - 8);
        lv_obj_set_style_text_align(lblProject, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_align(lblProject, LV_ALIGN_TOP_MID, 0, 31);
        lv_label_set_long_mode(lblProject, LV_LABEL_LONG_DOT);
        lv_label_set_text(lblProject, "Connecting...");

        lblModel = lv_label_create(content);
        lv_obj_set_style_text_font(lblModel, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(lblModel, lv_color_hex(Theme::HUDDim), 0);
        lv_obj_set_style_text_align(lblModel, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_align(lblModel, LV_ALIGN_TOP_MID, 0, 53);
        lv_obj_set_width(lblModel, contentW - 8);
        lv_label_set_long_mode(lblModel, LV_LABEL_LONG_DOT);
        lv_label_set_text(lblModel, "");

        lblUsage5h = lv_label_create(content);
        lv_obj_set_style_text_font(lblUsage5h, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(lblUsage5h, lv_color_hex(Theme::HUDDim), 0);
        lv_obj_align(lblUsage5h, LV_ALIGN_BOTTOM_MID, 0, -22);
        lv_label_set_text(lblUsage5h, "5h: --");

        lblUsage7d = lv_label_create(content);
        lv_obj_set_style_text_font(lblUsage7d, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(lblUsage7d, lv_color_hex(Theme::HUDDim), 0);
        lv_obj_align(lblUsage7d, LV_ALIGN_BOTTOM_MID, 0, -6);
        lv_label_set_text(lblUsage7d, "7d: --");
#else
        // State + Project + Model on one line (with top breathing room)
        lblState = lv_label_create(content);
        lv_obj_set_style_text_font(lblState, &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(lblState, lv_color_hex(Theme::StatusGreen), 0);
        lv_obj_align(lblState, LV_ALIGN_TOP_LEFT, 8, 12);
        lv_label_set_text(lblState, "● IDLE");

        lblProject = lv_label_create(content);
        lv_obj_set_style_text_font(lblProject, &font_kr_12, 0);
        lv_obj_set_style_text_color(lblProject, lv_color_hex(Theme::HUDText), 0);
        lv_obj_set_width(lblProject, screenW / 2);
        lv_obj_set_style_text_align(lblProject, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_align(lblProject, LV_ALIGN_TOP_MID, 0, 12);
        lv_label_set_long_mode(lblProject, LV_LABEL_LONG_DOT);
        lv_label_set_text(lblProject, "Connecting...");

        lblModel = lv_label_create(content);
        lv_obj_set_style_text_font(lblModel, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(lblModel, lv_color_hex(Theme::HUDDim), 0);
        lv_obj_set_style_text_align(lblModel, LV_TEXT_ALIGN_RIGHT, 0);
        lv_obj_align(lblModel, LV_ALIGN_TOP_RIGHT, -8, 13);
        lv_obj_set_width(lblModel, 80);
        lv_label_set_long_mode(lblModel, LV_LABEL_LONG_DOT);
        lv_label_set_text(lblModel, "");

        // Usage gauges at bottom
        lblUsage5h = lv_label_create(content);
        lv_obj_set_style_text_font(lblUsage5h, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(lblUsage5h, lv_color_hex(Theme::HUDDim), 0);
        lv_obj_align(lblUsage5h, LV_ALIGN_BOTTOM_LEFT, 4, -4);
        lv_label_set_text(lblUsage5h, "5h: --");

        lblUsage7d = lv_label_create(content);
        lv_obj_set_style_text_font(lblUsage7d, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(lblUsage7d, lv_color_hex(Theme::HUDDim), 0);
        lv_obj_align(lblUsage7d, LV_ALIGN_BOTTOM_RIGHT, -4, -4);
        lv_label_set_text(lblUsage7d, "7d: --");
#endif
    }

    return widget;
}

void update() {
    if (!widget) return;

    lockState();
    bool hasData = g_state.dataReceived;
    AgentState state = g_state.state;
    char project[40], model[32];
    strncpy(project, g_state.projectName, sizeof(project) - 1);
    project[sizeof(project) - 1] = '\0';
    strncpy(model, g_state.modelName, sizeof(model) - 1);
    model[sizeof(model) - 1] = '\0';

    float p5h = g_state.fiveHourPercent;
    float p7d = g_state.sevenDayPercent;
    // Codex windows — on this 135px board there's no room for a third row, so the
    // two usage labels fall back to Codex when the user has no Claude quota (a
    // Codex-only user, or the App Store Swift daemon with no Claude 5h/7d). The
    // "CX" prefix disambiguates the provider.
    float cxP5h = g_state.codexPrimaryPercent;
    float cxP7d = g_state.codexSecondaryPercent;
    bool connected = hasData && (g_state.wsConnected || Net::serialConnected());
    unlockState();

    // Update state label with color
    const char* stateStr = stateString(state);
    char stateBuf[32];
    snprintf(stateBuf, sizeof(stateBuf), "● %s", stateStr);
    lv_label_set_text(lblState, stateBuf);
    lv_obj_set_style_text_color(lblState, lv_color_hex(stateColor(state)), 0);

    // Update project name
    if (project[0]) {
        lv_label_set_text(lblProject, project);
    } else {
        lv_label_set_text(lblProject, "AgentDeck");
    }

    // Update model name
    if (model[0]) {
        lv_label_set_text(lblModel, model);
    } else {
        lv_label_set_text(lblModel, "");
    }

    // Update the two compact usage rows. When both providers exist, each gets
    // one compressed line containing every present window. With one provider,
    // each window keeps its own more legible row. No absent window prints `--`.
    char first[24];
    char second[24];
    first[0] = '\0';
    second[0] = '\0';
    bool hasClaude = p5h >= 0.0f || p7d >= 0.0f;
    bool hasCodex = cxP5h >= 0.0f || cxP7d >= 0.0f;
    bool showTankStatus = connected && (hasClaude || hasCodex);
    if (showTankStatus) {
        if (hasClaude && hasCodex) {
            formatProviderUsage(first, sizeof(first), "CL", p5h, p7d);
            formatProviderUsage(second, sizeof(second), "CX", cxP5h, cxP7d);
        } else {
            const char* prefix = hasCodex ? "CX " : "";
            float u5 = hasCodex ? cxP5h : p5h;
            float u7 = hasCodex ? cxP7d : p7d;
            if (u5 >= 0.0f) snprintf(first, sizeof(first), "%s5h: %d%%", prefix, (int)u5);
            if (u7 >= 0.0f) snprintf(second, sizeof(second), "%s7d: %d%%", prefix, (int)u7);
        }
        setUsageLabel(lblUsage5h, first);
        setUsageLabel(lblUsage7d, second);
    } else {
        lv_obj_add_flag(lblUsage5h, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(lblUsage7d, LV_OBJ_FLAG_HIDDEN);
    }
}

void setVisible(bool v) {
    visible = v;
    if (widget) {
        if (v) {
            lv_obj_clear_flag(widget, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(widget, LV_OBJ_FLAG_HIDDEN);
        }
    }
}

bool isVisible() {
    return visible && widget && !lv_obj_has_flag(widget, LV_OBJ_FLAG_HIDDEN);
}

}  // namespace StateWidget
}  // namespace TTGO
