#include "antigravity.h"
#include "draw.h"
#include "renderer.h"
#include "creature_glyphs_generated.h"
#include "terrarium_rules_generated.h"
#include "../theme.h"
#include "../display.h"
#include "config.h"
#include "../../state/agent_state.h"

#include <Arduino.h>
#include <lvgl.h>
#include <cmath>
#include <cstring>

constexpr uint8_t ANTIGRAVITY_ARR_SIZE = (MAX_ANTIGRAVITY > 0) ? MAX_ANTIGRAVITY : 1;

static float jitterX[ANTIGRAVITY_ARR_SIZE];
static float jitterY[ANTIGRAVITY_ARR_SIZE];
static float phaseOffset[ANTIGRAVITY_ARR_SIZE];
static float currentX[ANTIGRAVITY_ARR_SIZE];
static float currentY[ANTIGRAVITY_ARR_SIZE];

static uint32_t antigravityGradient(float x, float y) {
    // Normalized 0..1 inside the mark box. Warm apex, green/teal left, blue/purple right.
    if (y < 0.24f) {
        return (x < 0.56f) ? Theme::AntigravityYellow : Theme::AntigravityOrange;
    }
    if (x < 0.30f) {
        return (y < 0.62f) ? Theme::AntigravityGreen : Theme::AntigravityCyan;
    }
    if (x > 0.70f) {
        if (y < 0.44f) return Theme::AntigravityRed;
        return (y < 0.72f) ? Theme::AntigravityPurple : Theme::AntigravityBlue;
    }
    return (y < 0.58f) ? Theme::AntigravityCyan : Theme::AntigravityBlue;
}

static void drawAntigravityMask(int x0, int y0, int dstW, int dstH, uint8_t alpha) {
    if (dstW <= 0 || dstH <= 0 || alpha == 0) return;
    const float fx = (float)CreatureGlyphs::ANTIGRAVITY_W / dstW;
    const float fy = (float)CreatureGlyphs::ANTIGRAVITY_H / dstH;
    for (int py = 0; py < dstH; py++) {
        float sy = (py + 0.5f) * fy - 0.5f;
        int y1 = (int)floorf(sy);
        float wy = sy - y1;
        int ya = y1 < 0 ? 0 : (y1 >= CreatureGlyphs::ANTIGRAVITY_H ? CreatureGlyphs::ANTIGRAVITY_H - 1 : y1);
        int yb = (y1 + 1) < 0 ? 0 : ((y1 + 1) >= CreatureGlyphs::ANTIGRAVITY_H ? CreatureGlyphs::ANTIGRAVITY_H - 1 : y1 + 1);
        for (int px = 0; px < dstW; px++) {
            float sx = (px + 0.5f) * fx - 0.5f;
            int x1 = (int)floorf(sx);
            float wx = sx - x1;
            int xa = x1 < 0 ? 0 : (x1 >= CreatureGlyphs::ANTIGRAVITY_W ? CreatureGlyphs::ANTIGRAVITY_W - 1 : x1);
            int xb = (x1 + 1) < 0 ? 0 : ((x1 + 1) >= CreatureGlyphs::ANTIGRAVITY_W ? CreatureGlyphs::ANTIGRAVITY_W - 1 : x1 + 1);
            const uint8_t* mask = CreatureGlyphs::ANTIGRAVITY_A8;
            float a00 = mask[ya * CreatureGlyphs::ANTIGRAVITY_W + xa];
            float a10 = mask[ya * CreatureGlyphs::ANTIGRAVITY_W + xb];
            float a01 = mask[yb * CreatureGlyphs::ANTIGRAVITY_W + xa];
            float a11 = mask[yb * CreatureGlyphs::ANTIGRAVITY_W + xb];
            float top = a00 + (a10 - a00) * wx;
            float bot = a01 + (a11 - a01) * wx;
            int cov = (int)(top + (bot - top) * wy + 0.5f);
            if (cov <= 0) continue;
            uint8_t a = (uint8_t)((cov * alpha) / 255);
            if (!a) continue;
            uint32_t color = antigravityGradient((px + 0.5f) / dstW, (py + 0.5f) / dstH);
            Draw::pixelA(x0 + px, y0 + py, color, a);
        }
    }
}

namespace Antigravity {

void init() {
    for (int i = 0; i < MAX_ANTIGRAVITY; i++) {
        jitterX[i] = ((i * 11 + 3) % 13 - 6) * 0.006f;
        jitterY[i] = ((i * 5 + 4) % 9 - 4) * 0.005f;
        phaseOffset[i] = i * 2.1f;
        currentX[i] = Layout::AntigravityHomeX;
        currentY[i] = Layout::AntigravityWorkingY;
    }
}

void render(uint16_t* buf, int w, int h, float time, float dt,
            CreatureState state, uint8_t idx, uint8_t total) {
    (void)buf;
    (void)dt;
    if (idx >= MAX_ANTIGRAVITY) return;

    float scaleFactor = (total >= 4) ? 0.70f : (total >= 3) ? 0.84f : 1.0f;

    // Horizontal band the creatures spread across (fraction of width).
    float span = (total <= 1) ? 0.0f : (total <= 2) ? 0.22f : 0.34f;

    // Overlap cap: shrink further so neighbor center-spacing stays ≥ 50% of the
    // glyph width (≤50% overlap). Mark box ≈ bodyRadius*2.7 wide.
    if (total >= 2) {
        float spacing = span / (total - 1) - 0.04f;  // minus jitter squeeze margin
        if (spacing < 0.0f) spacing = 0.0f;
        float capScale = spacing / (0.5f * Layout::AntigravityRadiusFrac * 2.7f);
        if (capScale < scaleFactor) scaleFactor = capScale;
        if (scaleFactor < 0.45f) scaleFactor = 0.45f;
    }

    float bodyRadius = w * Layout::AntigravityRadiusFrac * scaleFactor;

    float homeX;
    if (total <= 1) {
        homeX = Layout::AntigravityHomeX;
    } else {
        homeX = Layout::AntigravityHomeX - span / 2 + span * idx / (total - 1);
    }
    homeX += jitterX[idx];
    // Sleeping Antigravity sinks to the floor (SleepY 0.67–0.74) at home
    // x 0.72–0.74 — exactly the crayfish's seat. Clamp the rest anchor clear
    // (cross-platform rule, shared/src/terrarium-rules.ts). Awake idle stays
    // a mid-water hover at its own home, matching the dashboard contract.
    if (state == CreatureState::SLEEPING && homeX > TerrariumRules::CrayfishClearMaxX) {
        homeX = TerrariumRules::CrayfishClearMaxX;
    }

    float homeY;
    switch (state) {
        case CreatureState::SLEEPING:
            homeY = Layout::AntigravitySleepY;
            break;
        case CreatureState::WORKING:
            homeY = Layout::AntigravityWorkingY;
            break;
        case CreatureState::ASKING:
            homeY = (Layout::AntigravityStandingY + Layout::AntigravityWorkingY) * 0.5f;
            break;
        default:
            homeY = Layout::AntigravityStandingY;
            break;
    }
    homeY += (homeX - 0.68f) * 0.08f + jitterY[idx];

    float renderX = homeX;
    float renderY = homeY;
    float t = time + phaseOffset[idx];
    if (state == CreatureState::WORKING) {
        renderX += fastSin(t * 0.34f) * 0.10f;
        renderY += fastCos(t * 0.22f) * 0.06f;
        if (renderX < Layout::AntigravitySwimMinX) renderX = Layout::AntigravitySwimMinX;
        if (renderX > Layout::AntigravitySwimMaxX) renderX = Layout::AntigravitySwimMaxX;
        if (renderY < Layout::AntigravitySwimMinY) renderY = Layout::AntigravitySwimMinY;
        if (renderY > Layout::AntigravitySwimMaxY) renderY = Layout::AntigravitySwimMaxY;
    }

    float breathBob = 0.0f;
    uint8_t alpha = 255;
    if (state == CreatureState::SLEEPING) {
        alpha = 120;
    } else if (state == CreatureState::FLOATING) {
        breathBob = fastSin(t * 0.7f) * h * 0.003f;
    } else if (state == CreatureState::WORKING) {
        breathBob = fastSin(t * 2.0f) * h * 0.006f;
        float glow = fastSin(t * 2.3f) * 0.5f + 0.5f;
        Draw::circle((int)(renderX * w), (int)(renderY * h), (int)(bodyRadius * (1.15f + glow * 0.25f)),
                     Theme::AntigravityCyan, (uint8_t)(18 + glow * 18));
    } else if (state == CreatureState::ASKING) {
        breathBob = fastSin(t * 0.9f) * h * 0.002f;
    }

    int cx = (int)(renderX * w);
    int cy = (int)(renderY * h + breathBob);
    currentX[idx] = renderX;
    currentY[idx] = renderY;

    int glyphBox = max(4, (int)(bodyRadius * 2.7f));
    drawAntigravityMask(cx - glyphBox / 2, cy - glyphBox / 2, glyphBox, glyphBox, alpha);

    if (state == CreatureState::ASKING) {
        int bx = cx + (int)(bodyRadius * 1.2f);
        int by = cy;
        int br = (int)(bodyRadius * 0.52f);
        Draw::circle(bx, by, br, 0xFFFFFF, 210);
        int qx = bx - 2, qy = by - 3;
        Draw::pixelA(qx + 1, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 3, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 3, qy + 1, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy + 2, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy + 4, Theme::DeepSea, 255);
        Draw::line(bx - br / 3, by + br / 2, cx + (int)(bodyRadius * 0.6f), cy, 0xFFFFFF, 160);
    }

#if !defined(BOARD_TTGO) && !defined(BOARD_ESP32_C6_147)
    lockState();
    char name[32] = "";
    if (idx < g_state.antigravityCount && g_state.antigravityNames[idx][0]) {
        strncpy(name, g_state.antigravityNames[idx], sizeof(name) - 1);
    } else if (g_state.projectName[0]) {
        strncpy(name, g_state.projectName, sizeof(name) - 1);
    }
    name[sizeof(name) - 1] = '\0';
    // Dense tank: idle tags collapse (shared rule, DESIGN.md §6.4).
    const bool showName = g_state.sessionCount < TerrariumRules::NativeLabelDenseResidentCount ||
                          state == CreatureState::WORKING || state == CreatureState::ASKING;
    unlockState();

    if (name[0] && showName) {
        lv_point_t txtSize;
        lv_text_get_size(&txtSize, name, &font_kr_12, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
        int textW = txtSize.x + (total >= 3 ? 8 : 12);
        int tagH = 16;
        int tagX = cx - textW / 2;
        int tagY = (cy - glyphBox / 2) - tagH - 4;
        for (int dy = 0; dy < tagH; dy++) {
            for (int dx = 0; dx < textW; dx++) {
                Draw::pixelA(tagX + dx, tagY + dy, Theme::AntigravityMark, 150);
            }
        }
        lv_obj_t* cvs = Terrarium::getCanvas();
        if (cvs) {
            lv_layer_t layer;
            lv_canvas_init_layer(cvs, &layer);
            lv_draw_label_dsc_t labelDsc;
            lv_draw_label_dsc_init(&labelDsc);
            labelDsc.color = lv_color_hex(Theme::HUDText);
            labelDsc.font = &font_kr_12;
            labelDsc.text = name;
            labelDsc.align = LV_TEXT_ALIGN_CENTER;
            lv_area_t labelArea;
            labelArea.x1 = tagX;
            labelArea.y1 = tagY + 1;
            labelArea.x2 = tagX + textW - 1;
            labelArea.y2 = tagY + tagH - 1;
            lv_draw_label(&layer, &labelDsc, &labelArea);
            lv_canvas_finish_layer(cvs, &layer);
        }
    }
#endif
}

float getX(uint8_t idx) {
    if (idx >= MAX_ANTIGRAVITY) return Layout::AntigravityHomeX;
    return currentX[idx];
}

float getY(uint8_t idx) {
    if (idx >= MAX_ANTIGRAVITY) return Layout::AntigravityStandingY;
    return currentY[idx];
}

}  // namespace Antigravity
