#if defined(BOARD_T_DISPLAY_PRO)
#include "usage_panel.h"
#include <cstdio>
#include "../theme.h"

namespace UsagePanel {

uint32_t providerColor(UsageRows::Provider p) {
    switch (p) {
        case UsageRows::CLAUDE: return Theme::ClaudeBody;
        case UsageRows::CODEX:  return Theme::CloudBodyLight;
        case UsageRows::ZAI:    return Theme::ZaiBlue;
        default:                return Theme::AntigravityMark;
    }
}

static lv_obj_t* box(lv_obj_t* parent, int x, int y, int w, int h, uint32_t color, int radius) {
    lv_obj_t* o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_bg_color(o, lv_color_hex(color), 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(o, radius, 0);
    lv_obj_clear_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    return o;
}

static lv_obj_t* text(lv_obj_t* parent, const lv_font_t* font, uint32_t color, const char* s) {
    lv_obj_t* l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_label_set_text(l, s);
    return l;
}

// One slot: label ····· value / bar / caption.
static void slot(lv_obj_t* card, int x, int y, int w, int h, const char* label, const char* value,
                 int fill, uint32_t color, const char* caption, const Fonts& f) {
    lv_obj_t* l = text(card, f.small, Theme::HUDDim, label);
    lv_obj_set_pos(l, x, y);
    lv_obj_t* v = text(card, f.value, Theme::HUDText, value);
    lv_obj_set_width(v, w);
    lv_obj_set_style_text_align(v, LV_TEXT_ALIGN_RIGHT, 0);
    lv_obj_set_pos(v, x, y - 3);
    const int valueH = lv_font_get_line_height(f.value);
    int by = y + valueH;
    if (fill >= 0) {
        lv_obj_t* track = box(card, x, by, w, 6, Theme::ShallowWater, 3);
        if (fill > 0) box(track, 0, 0, fill * w / 100 < 6 ? 6 : fill * w / 100, 6, color, 3);
        by += 10;
    }
    if (caption[0] && by + lv_font_get_line_height(f.small) <= y + h + 2) {
        lv_obj_t* c = text(card, f.small, Theme::HUDFaint, caption);
        lv_label_set_long_mode(c, LV_LABEL_LONG_DOT);
        lv_obj_set_width(c, w);
        lv_obj_set_pos(c, x, by);
    }
}

void render(lv_obj_t* parent, int x, int y, int w, int h,
            const UsageRows::Group* groups, uint8_t count, bool columns, const Fonts& f) {
    if (!count) return;
    // Rows (not groups) set the stacked height so a plan-only card stays short.
    int units = 0;
    for (uint8_t i = 0; i < count; ++i) units += groups[i].rowCount < 2 && groups[i].hasPlan() ? groups[i].rowCount + 1 : groups[i].rowCount ? groups[i].rowCount : 1;
    const int gap = 6;
    const int headerH = lv_font_get_line_height(f.header) + 4;
    int cursor = columns ? x : y;
    for (uint8_t i = 0; i < count; ++i) {
        const auto& g = groups[i];
        const bool planSlot = g.hasPlan() && g.rowCount < 2;
        const int slots = g.rowCount + (planSlot ? 1 : 0);
        const int cw = columns ? (w - gap * (count - 1)) / count : w;
        const int ch = columns ? h
            : (h - gap * (count - 1) - headerH * count) * (slots ? slots : 1) / (units ? units : 1) + headerH;
        lv_obj_t* card = box(parent, columns ? cursor : x, columns ? y : cursor, cw, ch, Theme::MidWater, 8);
        cursor += (columns ? cw : ch) + gap;

        const uint32_t accent = providerColor(g.provider);
        box(card, 8, 6 + (headerH - 12) / 2, 8, 8, accent, LV_RADIUS_CIRCLE);
        lv_obj_t* name = text(card, f.header, Theme::HUDText, g.name());
        lv_obj_set_pos(name, 22, 4);
        if (!planSlot && g.hasPlan()) {
            // Both windows present: the tier rides the header instead.
            lv_obj_t* tier = text(card, f.small, Theme::HUDDim, g.tier);
            lv_obj_align(tier, LV_ALIGN_TOP_RIGHT, -8, 4 + (lv_font_get_line_height(f.header) - lv_font_get_line_height(f.small)) / 2);
        }
        if (!slots) continue;
        const int inner = cw - 16;
        const int slotH = (ch - headerH - 6) / slots;
        char value[12], caption[32];
        for (uint8_t s = 0; s < slots; ++s) {
            const int sy = headerH + 4 + s * slotH;
            if (s < g.rowCount) {
                const auto& r = g.rows[s];
                snprintf(value, sizeof(value), "%d%%", r.shown());
                if (r.reset[0]) snprintf(caption, sizeof(caption), "%s %s", r.left ? "Left, reset" : "Reset", r.reset);
                else snprintf(caption, sizeof(caption), "%s", r.left ? "Left" : "");
                slot(card, 8, sy, inner, slotH, r.label, value, r.shown(),
                     r.critical() ? Theme::StatusAmber : accent, caption, f);
            } else {
                if (g.until[0]) snprintf(caption, sizeof(caption), "Until %s", g.until); else caption[0] = '\0';
                slot(card, 8, sy, inner, slotH, "Plan", g.tier, -1, accent, caption, f);
            }
        }
    }
}

}  // namespace UsagePanel
#endif
