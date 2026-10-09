#pragma once
#include <lvgl.h>
#include <Arduino.h>
#include "../../state/agent_state.h"
#include "../product_palette.generated.h"
namespace DotCompanion {
/// LVGL owns the two small widgets; ~2.4 KiB fixed image/state storage, reused forever.
struct Badge {
    lv_obj_t* panel = nullptr;
    lv_obj_t* image = nullptr;
    lv_obj_t* label = nullptr;
    lv_image_dsc_t descriptor = {};
    DotSurfaceState snapshot;
    uint32_t pixels[DotSurfaceRules::glyphSize * DotSurfaceRules::glyphSize] = {};
    char text[32] = {};
    void create(lv_obj_t* parent, const lv_font_t* font) {
        panel = lv_obj_create(parent);
        if (!panel) { Serial.println("[Dot] badge allocation failed"); return; }
        lv_obj_set_size(panel, 104, 18);
        lv_obj_set_style_bg_opa(panel, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(panel, 0, 0);
        lv_obj_set_style_pad_all(panel, 0, 0);
        lv_obj_remove_flag(panel, LV_OBJ_FLAG_SCROLLABLE);
        // Inert information absorbs a tap; no callback can become a session command.
        lv_obj_add_flag(panel, LV_OBJ_FLAG_CLICKABLE);
        image = lv_image_create(panel); label = lv_label_create(panel);
        if (!image || !label) { Serial.println("[Dot] badge child allocation failed"); lv_obj_add_flag(panel, LV_OBJ_FLAG_HIDDEN); return; }
        descriptor.header.magic = LV_IMAGE_HEADER_MAGIC;
        descriptor.header.cf = LV_COLOR_FORMAT_ARGB8888;
        descriptor.header.w = descriptor.header.h = DotSurfaceRules::glyphSize;
        descriptor.header.stride = DotSurfaceRules::glyphSize * sizeof(uint32_t);
        descriptor.data_size = sizeof(pixels); descriptor.data = reinterpret_cast<const uint8_t*>(pixels);
        lv_image_set_src(image, &descriptor);
        lv_obj_set_pos(label, 19, 1);
        lv_label_set_text_static(label, text);
        lv_obj_set_style_text_font(label, font, 0);
        lv_obj_add_flag(panel, LV_OBJ_FLAG_HIDDEN);
    }
    bool update(bool allowed, int x, int y) {
        if (!panel || !image || !label) return false;
        bool urgent = false;
        lockState();
        if (g_state.dot) snapshot = *g_state.dot; else snapshot.configured = false;
        allowed = allowed && g_state.wsConnected;
        for (uint8_t i = 0; i < g_state.sessionCount; ++i)
            if (g_state.sessions[i].alive && !strncmp(g_state.sessions[i].state, "awaiting", 8)) urgent = true;
        unlockState();
        if (!allowed || urgent || !snapshot.configured) { lv_obj_add_flag(panel, LV_OBJ_FLAG_HIDDEN); return false; }
        const uint8_t code = snapshot.effectiveCode(millis());
        const uint32_t tint = code == 2 ? ProductPalette::UiCyan : code == 3 ? ProductPalette::UiAttn
            : code == 4 ? ProductPalette::UiOk : code == 5 ? ProductPalette::UiError : ProductPalette::UiIdle;
        const uint8_t* rgba = snapshot.custom ? snapshot.rgba : DotSurfaceRules::defaultRgba;
        bool changed = false;
        for (size_t i = 0; i < sizeof(pixels) / sizeof(pixels[0]); ++i) {
            const uint32_t value = (uint32_t(rgba[i*4+3]) << 24) | (uint32_t(rgba[i*4]) << 16)
                | (uint32_t(rgba[i*4+1]) << 8) | rgba[i*4+2];
            changed |= pixels[i] != value; pixels[i] = value;
        }
        if (changed) lv_obj_invalidate(image);
        snprintf(text, sizeof(text), "D %s", DotSurfaceRules::labels[code]);
        lv_obj_set_style_text_color(label, lv_color_hex(tint), 0);
        lv_obj_invalidate(label);
        lv_obj_set_pos(panel, x, y); lv_obj_remove_flag(panel, LV_OBJ_FLAG_HIDDEN);
        return true;
    }
};
}
