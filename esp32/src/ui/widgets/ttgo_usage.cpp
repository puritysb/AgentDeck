#include "ttgo_usage.h"
#if defined(BOARD_TTGO)
#include "ttgo_usage_layout.h"
#include "../display.h"
#include "../theme.h"
#include "../../state/agent_state.h"
#include "../../util/usage_rows.h"
#include <cctype>
#include <cstdio>
#include <cstring>

LV_FONT_DECLARE(font_ttgo_plex_12);
LV_FONT_DECLARE(font_ttgo_plex_28);

namespace TTGO { namespace Usage {
static bool selected = true;
static lv_obj_t* root;
static lv_obj_t* empty;
struct Card { lv_obj_t *panel, *title, *value, *reset, *bar; };
// Six bounded cards are allocated by LVGL once per screen lifetime — the
// shared UsageRows tiles (Claude / Codex or its Luna reserve / z.ai incl. MCP,
// plus a provider's plan in the slot a missing window leaves). Labels own
// their text and are rewritten only when a value changes: the no-PSRAM TTGO
// has ~16 bytes of static DRAM headroom, so per-card copies do not fit.
static constexpr uint8_t CARD_CAP = 6;
static Card cards[CARD_CAP];
static uint32_t previousShape = UINT32_MAX;

bool active() { return selected; }
void toggle() { selected = !selected; }

static lv_obj_t* label(lv_obj_t* parent, const lv_font_t* font, uint32_t color) {
    auto* obj = lv_label_create(parent);
    lv_obj_set_style_text_font(obj, font, 0);
    lv_obj_set_style_text_color(obj, lv_color_hex(color), 0);
    lv_label_set_long_mode(obj, LV_LABEL_LONG_CLIP);
    return obj;
}
static void text(lv_obj_t* obj, const char* value) {
    if (strcmp(lv_label_get_text(obj), value) == 0) return;
    lv_label_set_text(obj, value);
}
void create(lv_obj_t* parent) {
    previousShape = UINT32_MAX;
    root = lv_obj_create(parent);
    lv_obj_set_size(root, g_screenW, g_screenH);
    lv_obj_set_pos(root, 0, 0);
    lv_obj_set_style_bg_color(root, lv_color_hex(Theme::DeepSea), 0);
    lv_obj_set_style_bg_opa(root, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    lv_obj_set_style_radius(root, 0, 0);
    lv_obj_set_style_pad_all(root, 0, 0);
    lv_obj_clear_flag(root, LV_OBJ_FLAG_SCROLLABLE);
    auto* heading = label(root, &font_ttgo_plex_12, Theme::HUDDim);
    lv_label_set_text_static(heading, UsagePresentation::Heading);
    lv_obj_align(heading, LV_ALIGN_TOP_LEFT, 6, 3);
    auto* hint = label(root, &font_ttgo_plex_12, Theme::HUDFaint);
    lv_label_set_text_static(hint, "MODE   /   ROTATE");
    lv_obj_align(hint, LV_ALIGN_BOTTOM_MID, 0, -3);
    empty = label(root, &font_ttgo_plex_12, Theme::HUDDim);
    lv_label_set_text_static(empty, "No usage data\nWaiting for limits");
    lv_obj_set_style_text_align(empty, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_center(empty);
    for (auto& c : cards) {
        c.panel = lv_obj_create(root);
        lv_obj_set_style_bg_color(c.panel, lv_color_hex(Theme::MidWater), 0);
        lv_obj_set_style_bg_opa(c.panel, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(c.panel, 0, 0);
        lv_obj_set_style_radius(c.panel, 4, 0);
        lv_obj_set_style_pad_all(c.panel, 0, 0);
        lv_obj_clear_flag(c.panel, LV_OBJ_FLAG_SCROLLABLE);
        c.title = label(c.panel, &font_ttgo_plex_12, Theme::HUDText);
        c.value = label(c.panel, &font_ttgo_plex_28, Theme::HUDText);
        c.reset = label(c.panel, &font_ttgo_plex_12, Theme::HUDDim);
        // Start empty: text() skips unchanged values, so an empty first value
        // would otherwise leave LVGL's "Text" placeholder.
        lv_label_set_text(c.title, "");
        lv_label_set_text(c.value, "");
        lv_label_set_text(c.reset, "");
        c.bar = lv_bar_create(c.panel);
        lv_bar_set_range(c.bar, 0, 100);
        lv_obj_set_style_bg_color(c.bar, lv_color_hex(Theme::ShallowWater), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(c.bar, LV_OPA_COVER, LV_PART_MAIN);
        lv_obj_set_style_bg_opa(c.bar, LV_OPA_30, LV_PART_INDICATOR);
        // Square-ended fill inside the card's own radius — the default pill
        // radius turned a partial fill into a floating blob.
        lv_obj_set_style_radius(c.bar, 4, LV_PART_MAIN);
        lv_obj_set_style_radius(c.bar, 4, LV_PART_INDICATOR);
        lv_obj_move_to_index(c.bar, 0);
        lv_obj_add_flag(c.panel, LV_OBJ_FLAG_HIDDEN);
    }
    if (!selected) lv_obj_add_flag(root, LV_OBJ_FLAG_HIDDEN);
}
static uint32_t providerColor(UsageRows::Provider p) {
    switch (p) {
        case UsageRows::CLAUDE: return Theme::ClaudeBody;
        case UsageRows::CODEX:  return Theme::CloudBody;
        case UsageRows::ZAI:    return Theme::ZaiBlue;
        default:                return Theme::AntigravityMark;
    }
}

void update() {
    if (!root) return;
    if (!selected) { lv_obj_add_flag(root, LV_OBJ_FLAG_HIDDEN); return; }
    lv_obj_clear_flag(root, LV_OBJ_FLAG_HIDDEN);
    // Bounded snapshot (a few hundred bytes); never the whole dashboard.
    UsageRows::Group groups[UsageRows::MAX_GROUPS];
    lockState();
    const uint8_t groupCount = UsageRows::build(g_state, groups);
    unlockState();
    UsageRows::Tile tiles[CARD_CAP];
    const uint8_t count = UsageRows::tiles(groups, groupCount, tiles, CARD_CAP);
    if (count) lv_obj_add_flag(empty, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_clear_flag(empty, LV_OBJ_FLAG_HIDDEN);
    // Geometry depends only on the tile count and which tiles are plans.
    uint32_t shape = count;
    for (uint8_t i = 0; i < count; ++i) shape |= (tiles[i].isPlan() ? 1u : 0u) << (8 + i);
    for (uint8_t slot = 0; slot < count; ++slot) {
        auto& c = cards[slot];
        const auto& tile = tiles[slot];
        const auto& g = *tile.group;
        if (shape != previousShape) {
            const auto r = cardRect(g_screenW, g_screenH, count, slot);
            lv_obj_set_pos(c.panel, r.x, r.y); lv_obj_set_size(c.panel, r.w, r.h);
            const bool compact = r.h < 66;
            // The 28px face carries digits and % only; a plan tier uses 12px.
            lv_obj_set_style_text_font(c.value, compact || tile.isPlan() ? &font_ttgo_plex_12 : &font_ttgo_plex_28, 0);
            lv_obj_align(c.title, LV_ALIGN_TOP_LEFT, 5, 3);
            lv_obj_align(c.value, compact ? LV_ALIGN_TOP_RIGHT : LV_ALIGN_CENTER, compact ? -5 : 0, compact ? 3 : -2);
            lv_obj_set_width(c.reset, r.w - 10);
            lv_obj_align(c.reset, LV_ALIGN_BOTTOM_LEFT, 5, -3);
            lv_obj_set_size(c.bar, r.w, r.h);
            lv_obj_align(c.bar, LV_ALIGN_CENTER, 0, 0);
            lv_obj_clear_flag(c.panel, LV_OBJ_FLAG_HIDDEN);
        }
        char buf[28];
        int n = snprintf(buf, sizeof(buf), "%s ", g.name());
        for (int k = 0; k < n; ++k) buf[k] = static_cast<char>(toupper(static_cast<unsigned char>(buf[k])));
        if (tile.isPlan()) {
            snprintf(buf + n, sizeof(buf) - n, "PLAN");
            text(c.title, buf);
            text(c.value, g.tier[0] ? g.tier : "Active");
            if (g.until[0]) snprintf(buf, sizeof(buf), "Until %s", g.until); else buf[0] = '\0';
            text(c.reset, buf);
            lv_bar_set_value(c.bar, 0, LV_ANIM_OFF);
        } else {
            const auto& row = g.rows[tile.row];
            snprintf(buf + n, sizeof(buf) - n, "%s", row.label);
            for (int k = n; buf[k]; ++k) buf[k] = static_cast<char>(toupper(static_cast<unsigned char>(buf[k])));
            text(c.title, buf);
            snprintf(buf, sizeof(buf), "%d%%", row.shown()); text(c.value, buf);
            // A reserve reads as what is left; its caption says so.
            if (row.reset[0]) snprintf(buf, sizeof(buf), "%s %s", row.left ? "Left, reset" : "Reset", row.reset);
            else snprintf(buf, sizeof(buf), "%s", row.left ? "Left" : "");
            text(c.reset, buf);
            lv_obj_set_style_bg_color(c.bar, lv_color_hex(row.critical() ? Theme::StatusAmber : providerColor(g.provider)), LV_PART_INDICATOR);
            lv_bar_set_value(c.bar, row.shown(), LV_ANIM_OFF);
        }
    }
    for (uint8_t slot = count; slot < CARD_CAP; ++slot) lv_obj_add_flag(cards[slot].panel, LV_OBJ_FLAG_HIDDEN);
    previousShape = shape;
}
} }
#endif
