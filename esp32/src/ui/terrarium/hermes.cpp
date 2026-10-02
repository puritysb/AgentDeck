// Hermes creature — the official Nous girl mark from design/brand/hermes.svg
// (the upstream white variant on these dark screens), swimming.
//
// A sibling of kiro.cpp: an alpha-mask mark, never a redrawn character. The
// aquarium mermaid is an Apple/Android 3D adaptation; at LCD sizes the
// canonical mark is the identity (issue #425 — do not invent a creature, do not
// borrow OpenClaw's art). It sways like something swimming, not drifting.
//
// Only `agentType == "hermes"` maps here: the observed Hermes Agent row.

#include "hermes.h"
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

constexpr uint8_t HERMES_ARR_SIZE = (MAX_HERMES > 0) ? MAX_HERMES : 1;

static float jitterX[HERMES_ARR_SIZE];
static float jitterY[HERMES_ARR_SIZE];
static float phaseOffset[HERMES_ARR_SIZE];
static float currentX[HERMES_ARR_SIZE];
static float currentY[HERMES_ARR_SIZE];

/** Bilinear-sampled alpha mask, filled with one colour — the Nous girl mark is
 *  monochrome upstream, so a flat fill is the faithful rendering. */
static void drawHermesMask(int x0, int y0, int dstW, int dstH, uint32_t color, uint8_t alpha) {
    if (dstW <= 0 || dstH <= 0 || alpha == 0) return;
    const float fx = (float)CreatureGlyphs::HERMES_W / dstW;
    const float fy = (float)CreatureGlyphs::HERMES_H / dstH;
    for (int py = 0; py < dstH; py++) {
        float sy = (py + 0.5f) * fy - 0.5f;
        int y1 = (int)floorf(sy);
        float wy = sy - y1;
        int ya = y1 < 0 ? 0 : (y1 >= CreatureGlyphs::HERMES_H ? CreatureGlyphs::HERMES_H - 1 : y1);
        int yb = (y1 + 1) < 0 ? 0 : ((y1 + 1) >= CreatureGlyphs::HERMES_H ? CreatureGlyphs::HERMES_H - 1 : y1 + 1);
        for (int px = 0; px < dstW; px++) {
            float sx = (px + 0.5f) * fx - 0.5f;
            int x1 = (int)floorf(sx);
            float wx = sx - x1;
            int xa = x1 < 0 ? 0 : (x1 >= CreatureGlyphs::HERMES_W ? CreatureGlyphs::HERMES_W - 1 : x1);
            int xb = (x1 + 1) < 0 ? 0 : ((x1 + 1) >= CreatureGlyphs::HERMES_W ? CreatureGlyphs::HERMES_W - 1 : x1 + 1);
            const uint8_t* mask = CreatureGlyphs::HERMES_A8;
            float a00 = mask[ya * CreatureGlyphs::HERMES_W + xa];
            float a10 = mask[ya * CreatureGlyphs::HERMES_W + xb];
            float a01 = mask[yb * CreatureGlyphs::HERMES_W + xa];
            float a11 = mask[yb * CreatureGlyphs::HERMES_W + xb];
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

namespace Hermes {

void init() {
    for (int i = 0; i < MAX_HERMES; i++) {
        jitterX[i] = ((i * 7 + 2) % 11 - 5) * 0.006f;
        jitterY[i] = ((i * 9 + 5) % 7 - 3) * 0.005f;
        phaseOffset[i] = i * 1.7f;
        currentX[i] = Layout::HermesHomeX;
        currentY[i] = Layout::HermesStandingY;
    }
}

void render(uint16_t* buf, int w, int h, float time, float dt,
            CreatureState state, uint8_t idx, uint8_t total) {
    (void)buf;
    (void)dt;
    if (idx >= MAX_HERMES) return;

    float scaleFactor = (total >= 4) ? 0.70f : (total >= 3) ? 0.84f : 1.0f;
    float span = (total <= 1) ? 0.0f : (total <= 2) ? 0.20f : 0.30f;

    // Same overlap cap as the other mark creatures: keep neighbour spacing at
    // ≥50% of the glyph box so a busy tank stays readable.
    if (total >= 2) {
        float spacing = span / (total - 1) - 0.04f;
        if (spacing < 0.0f) spacing = 0.0f;
        float capScale = spacing / (0.5f * Layout::HermesRadiusFrac * 2.7f);
        if (capScale < scaleFactor) scaleFactor = capScale;
        if (scaleFactor < 0.45f) scaleFactor = 0.45f;
    }

    float bodyRadius = w * Layout::HermesRadiusFrac * scaleFactor;

    float homeX;
    if (total <= 1) {
        homeX = Layout::HermesHomeX;
    } else {
        homeX = Layout::HermesHomeX - span / 2 + span * idx / (total - 1);
    }
    homeX += jitterX[idx];

    float homeY;
    switch (state) {
        case CreatureState::SLEEPING: homeY = Layout::HermesSleepY; break;
        case CreatureState::WORKING:  homeY = Layout::HermesWorkingY; break;
        case CreatureState::ASKING:
            homeY = (Layout::HermesStandingY + Layout::HermesWorkingY) * 0.5f;
            break;
        default: homeY = Layout::HermesStandingY; break;
    }
    homeY += jitterY[idx];

    float renderX = homeX;
    float renderY = homeY;
    float t = time + phaseOffset[idx];
    if (state == CreatureState::WORKING) {
        // A mermaid's swim: a wide horizontal sweep with a quicker vertical
        // undulation (no body to flex at mask resolution).
        renderX += fastSin(t * 0.34f) * 0.10f;
        renderY += fastSin(t * 0.68f) * 0.03f;
        if (renderX < Layout::HermesSwimMinX) renderX = Layout::HermesSwimMinX;
        if (renderX > Layout::HermesSwimMaxX) renderX = Layout::HermesSwimMaxX;
        if (renderY < Layout::HermesSwimMinY) renderY = Layout::HermesSwimMinY;
        if (renderY > Layout::HermesSwimMaxY) renderY = Layout::HermesSwimMaxY;
    }

    float breathBob = 0.0f;
    uint8_t alpha = 255;
    if (state == CreatureState::SLEEPING) {
        alpha = 120;                     // resting: dimmed, still recognizable
    } else if (state == CreatureState::FLOATING) {
        breathBob = fastSin(t * 0.6f) * h * 0.004f;
        alpha = 225;
    } else if (state == CreatureState::WORKING) {
        breathBob = fastSin(t * 1.8f) * h * 0.005f;
        float glow = fastSin(t * 2.1f) * 0.5f + 0.5f;
        Draw::circle((int)(renderX * w), (int)(renderY * h), (int)(bodyRadius * (1.12f + glow * 0.22f)),
                     Theme::HermesMark, (uint8_t)(16 + glow * 20));
    } else if (state == CreatureState::ASKING) {
        breathBob = fastSin(t * 0.9f) * h * 0.002f;
    }

    int cx = (int)(renderX * w);
    int cy = (int)(renderY * h + breathBob);
    currentX[idx] = renderX;
    currentY[idx] = renderY;

    int glyphBox = max(4, (int)(bodyRadius * 2.7f));
    drawHermesMask(cx - glyphBox / 2, cy - glyphBox / 2, glyphBox, glyphBox, Theme::HermesMark, alpha);

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
    if (idx < g_state.hermesCount && g_state.hermesNames[idx][0]) {
        strncpy(name, g_state.hermesNames[idx], sizeof(name) - 1);
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
                // The mark is white; a white tag would swallow the white text.
                Draw::pixelA(tagX + dx, tagY + dy, 0x1E2633, 190);
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
    if (idx >= MAX_HERMES) return Layout::HermesHomeX;
    return currentX[idx];
}

float getY(uint8_t idx) {
    if (idx >= MAX_HERMES) return Layout::HermesStandingY;
    return currentY[idx];
}

}  // namespace Hermes
