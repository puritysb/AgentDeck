// Kiro creature — the ghost mark from design/brand/kiro.svg, drifting.
//
// Structurally a sibling of antigravity.cpp (both are alpha-mask marks rather
// than hand-drawn bodies), with two deliberate differences: the mark is filled
// with one brand colour instead of a gradient, and it drifts rather than swims,
// because it is a ghost.
//
// Both `kiro-cli` and `kiro-ide` map here: they are the same agent seen through
// two front ends, and giving them separate creatures would say otherwise.

#include "kiro.h"
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

constexpr uint8_t KIRO_ARR_SIZE = (MAX_KIRO > 0) ? MAX_KIRO : 1;

static float jitterX[KIRO_ARR_SIZE];
static float jitterY[KIRO_ARR_SIZE];
static float phaseOffset[KIRO_ARR_SIZE];
static float currentX[KIRO_ARR_SIZE];
static float currentY[KIRO_ARR_SIZE];

/** Bilinear-sampled alpha mask, filled with one colour.
 *  Same sampler as the antigravity mark; the colour is flat because the Kiro
 *  brand mark is a single-colour ghost and inventing a gradient would be
 *  redrawing someone else's mark. */
static void drawKiroMask(int x0, int y0, int dstW, int dstH, uint32_t color, uint8_t alpha) {
    if (dstW <= 0 || dstH <= 0 || alpha == 0) return;
    const float fx = (float)CreatureGlyphs::KIRO_W / dstW;
    const float fy = (float)CreatureGlyphs::KIRO_H / dstH;
    for (int py = 0; py < dstH; py++) {
        float sy = (py + 0.5f) * fy - 0.5f;
        int y1 = (int)floorf(sy);
        float wy = sy - y1;
        int ya = y1 < 0 ? 0 : (y1 >= CreatureGlyphs::KIRO_H ? CreatureGlyphs::KIRO_H - 1 : y1);
        int yb = (y1 + 1) < 0 ? 0 : ((y1 + 1) >= CreatureGlyphs::KIRO_H ? CreatureGlyphs::KIRO_H - 1 : y1 + 1);
        for (int px = 0; px < dstW; px++) {
            float sx = (px + 0.5f) * fx - 0.5f;
            int x1 = (int)floorf(sx);
            float wx = sx - x1;
            int xa = x1 < 0 ? 0 : (x1 >= CreatureGlyphs::KIRO_W ? CreatureGlyphs::KIRO_W - 1 : x1);
            int xb = (x1 + 1) < 0 ? 0 : ((x1 + 1) >= CreatureGlyphs::KIRO_W ? CreatureGlyphs::KIRO_W - 1 : x1 + 1);
            const uint8_t* mask = CreatureGlyphs::KIRO_A8;
            float a00 = mask[ya * CreatureGlyphs::KIRO_W + xa];
            float a10 = mask[ya * CreatureGlyphs::KIRO_W + xb];
            float a01 = mask[yb * CreatureGlyphs::KIRO_W + xa];
            float a11 = mask[yb * CreatureGlyphs::KIRO_W + xb];
            float top = a00 + (a10 - a00) * wx;
            float bot = a01 + (a11 - a01) * wx;
            int cov = (int)(top + (bot - top) * wy + 0.5f);
            if (cov <= 0) continue;
            uint8_t a = (uint8_t)((cov * alpha) / 255);
            if (!a) continue;
            Draw::pixelA(x0 + px, y0 + py, color, a);
        }
    }
}

namespace Kiro {

void init() {
    for (int i = 0; i < MAX_KIRO; i++) {
        jitterX[i] = ((i * 7 + 2) % 11 - 5) * 0.006f;
        jitterY[i] = ((i * 9 + 5) % 7 - 3) * 0.005f;
        phaseOffset[i] = i * 1.7f;
        currentX[i] = Layout::KiroHomeX;
        currentY[i] = Layout::KiroStandingY;
    }
}

void render(uint16_t* buf, int w, int h, float time, float dt,
            CreatureState state, uint8_t idx, uint8_t total) {
    (void)buf;
    (void)dt;
    if (idx >= MAX_KIRO) return;

    float scaleFactor = (total >= 4) ? 0.70f : (total >= 3) ? 0.84f : 1.0f;
    float span = (total <= 1) ? 0.0f : (total <= 2) ? 0.20f : 0.30f;

    // Same overlap cap as the other mark creatures: keep neighbour spacing at
    // ≥50% of the glyph box so a busy tank stays readable.
    if (total >= 2) {
        float spacing = span / (total - 1) - 0.04f;
        if (spacing < 0.0f) spacing = 0.0f;
        float capScale = spacing / (0.5f * Layout::KiroRadiusFrac * 2.7f);
        if (capScale < scaleFactor) scaleFactor = capScale;
        if (scaleFactor < 0.45f) scaleFactor = 0.45f;
    }

    float bodyRadius = w * Layout::KiroRadiusFrac * scaleFactor;

    float homeX;
    if (total <= 1) {
        homeX = Layout::KiroHomeX;
    } else {
        homeX = Layout::KiroHomeX - span / 2 + span * idx / (total - 1);
    }
    homeX += jitterX[idx];

    float homeY;
    switch (state) {
        case CreatureState::SLEEPING: homeY = Layout::KiroSleepY; break;
        case CreatureState::WORKING:  homeY = Layout::KiroWorkingY; break;
        case CreatureState::ASKING:
            homeY = (Layout::KiroStandingY + Layout::KiroWorkingY) * 0.5f;
            break;
        default: homeY = Layout::KiroStandingY; break;
    }
    homeY += jitterY[idx];

    float renderX = homeX;
    float renderY = homeY;
    float t = time + phaseOffset[idx];
    if (state == CreatureState::WORKING) {
        // Drift, not a swim: slower and wider than the other creatures, with no
        // body flex to animate.
        renderX += fastSin(t * 0.26f) * 0.09f;
        renderY += fastCos(t * 0.18f) * 0.07f;
        if (renderX < Layout::KiroSwimMinX) renderX = Layout::KiroSwimMinX;
        if (renderX > Layout::KiroSwimMaxX) renderX = Layout::KiroSwimMaxX;
        if (renderY < Layout::KiroSwimMinY) renderY = Layout::KiroSwimMinY;
        if (renderY > Layout::KiroSwimMaxY) renderY = Layout::KiroSwimMaxY;
    }

    float breathBob = 0.0f;
    uint8_t alpha = 255;
    if (state == CreatureState::SLEEPING) {
        alpha = 110;                     // a resting ghost fades rather than sinks out of sight
    } else if (state == CreatureState::FLOATING) {
        breathBob = fastSin(t * 0.6f) * h * 0.004f;
        alpha = 225;
    } else if (state == CreatureState::WORKING) {
        breathBob = fastSin(t * 1.8f) * h * 0.005f;
        float glow = fastSin(t * 2.1f) * 0.5f + 0.5f;
        Draw::circle((int)(renderX * w), (int)(renderY * h), (int)(bodyRadius * (1.12f + glow * 0.22f)),
                     Theme::KiroMark, (uint8_t)(16 + glow * 20));
    } else if (state == CreatureState::ASKING) {
        breathBob = fastSin(t * 0.9f) * h * 0.002f;
    }

    int cx = (int)(renderX * w);
    int cy = (int)(renderY * h + breathBob);
    currentX[idx] = renderX;
    currentY[idx] = renderY;

    int glyphBox = max(4, (int)(bodyRadius * 2.7f));
    drawKiroMask(cx - glyphBox / 2, cy - glyphBox / 2, glyphBox, glyphBox, Theme::KiroMark, alpha);

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
    if (idx < g_state.kiroCount && g_state.kiroNames[idx][0]) {
        strncpy(name, g_state.kiroNames[idx], sizeof(name) - 1);
    } else if (g_state.projectName[0]) {
        strncpy(name, g_state.projectName, sizeof(name) - 1);
    }
    name[sizeof(name) - 1] = '\0';
    unlockState();

    if (name[0]) {
        lv_point_t txtSize;
        lv_text_get_size(&txtSize, name, &font_kr_12, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
        int textW = txtSize.x + (total >= 3 ? 8 : 12);
        int tagH = 16;
        int tagX = cx - textW / 2;
        int tagY = (cy - glyphBox / 2) - tagH - 4;
        for (int dy = 0; dy < tagH; dy++) {
            for (int dx = 0; dx < textW; dx++) {
                Draw::pixelA(tagX + dx, tagY + dy, Theme::KiroMark, 150);
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
    if (idx >= MAX_KIRO) return Layout::KiroHomeX;
    return currentX[idx];
}

float getY(uint8_t idx) {
    if (idx >= MAX_KIRO) return Layout::KiroStandingY;
    return currentY[idx];
}

}  // namespace Kiro
