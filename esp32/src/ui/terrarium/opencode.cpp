#include "opencode.h"
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
#include <cstring>
#include <cmath>

/**
 * OpenCode mark — the canonical vertical rectangular RING from opencode.svg
 * (outer 16×20, inner 8×12 hollow, evenodd), rasterized at build time into
 * CreatureGlyphs::OPENCODE_A8. Single light color, HOLLOW center (water shows
 * through) — replaces the old filled nested-square grid whose dark inner read
 * as a shadow.
 *
 * States map to Y positions like other creatures:
 *   SLEEPING  -> floor (dimmed)   FLOATING -> standing   WORKING -> near top   ASKING -> bubble
 */

// Minimum 1 to avoid zero-length arrays on boards with MAX_OPENCODE=0
constexpr uint8_t OPENCODE_ARR_SIZE = (MAX_OPENCODE > 0) ? MAX_OPENCODE : 1;

// Per-instance jitter (seeded by index)
static float jitterX[OPENCODE_ARR_SIZE];
static float jitterY[OPENCODE_ARR_SIZE];
static float phaseOffset[OPENCODE_ARR_SIZE];

// Position tracking per instance
static float currentX[OPENCODE_ARR_SIZE];
static float currentY[OPENCODE_ARR_SIZE];
static CreatureState prevState[OPENCODE_ARR_SIZE];

namespace OpenCode {

void init() {
    for (int i = 0; i < MAX_OPENCODE; i++) {
        jitterX[i] = ((i * 9 + 2) % 11 - 5) * 0.006f;
        jitterY[i] = ((i * 7 + 6) % 9 - 4) * 0.005f;
        phaseOffset[i] = i * 1.9f;
        currentX[i] = Layout::OpenCodeHomeX;
        currentY[i] = Layout::OpenCodeWorkingY;
        prevState[i] = CreatureState::SLEEPING;
    }
}

void render(uint16_t* buf, int w, int h, float time, float dt,
            CreatureState state, uint8_t idx, uint8_t total) {

    if (idx >= MAX_OPENCODE) return;

    // Dynamic scale: shrink when many instances
    float scaleFactor = (total >= 4) ? 0.70f : (total >= 3) ? 0.85f : 1.0f;

    // Horizontal band the creatures spread across (fraction of width).
    float span = (total <= 1) ? 0.0f : (total <= 2) ? 0.25f : 0.40f;

    // Overlap cap: shrink further so neighbor center-spacing stays ≥ 50% of the
    // glyph width (≤50% overlap). Mark box ≈ bodyRadius*2.6 wide.
    if (total >= 2) {
        float spacing = span / (total - 1) - 0.04f;  // minus jitter squeeze margin
        if (spacing < 0.0f) spacing = 0.0f;
        float capScale = spacing / (0.5f * Layout::OpenCodeRadiusFrac * 2.6f);
        if (capScale < scaleFactor) scaleFactor = capScale;
        if (scaleFactor < 0.45f) scaleFactor = 0.45f;
    }

    float bodyRadius = w * Layout::OpenCodeRadiusFrac * scaleFactor;

    // Calculate home position — wider spread for more creatures
    float homeX;
    if (total <= 1) {
        homeX = Layout::OpenCodeHomeX;
    } else {
        homeX = Layout::OpenCodeHomeX - span / 2 + span * idx / (total - 1);
    }
    homeX += jitterX[idx];
    // Resting states park on/near the floor — keep the anchor clear of the
    // crayfish's territory (cross-platform rule, shared/src/terrarium-rules.ts).
    if (state != CreatureState::WORKING && state != CreatureState::ASKING &&
        homeX > TerrariumRules::CrayfishClearMaxX) {
        homeX = TerrariumRules::CrayfishClearMaxX;
    }

    float homeY;
    switch (state) {
        case CreatureState::SLEEPING:
            homeY = Layout::OpenCodeSleepY;
            break;
        case CreatureState::WORKING:
            homeY = Layout::OpenCodeWorkingY;
            break;
        case CreatureState::ASKING:
            homeY = (Layout::OpenCodeStandingY + Layout::OpenCodeWorkingY) * 0.5f;
            break;
        default:
            homeY = Layout::OpenCodeStandingY;
            break;
    }
    // X-correlated depth offset
    homeY += (homeX - 0.65f) * 0.10f + jitterY[idx];

    prevState[idx] = state;

    float renderX, renderY;

    if (state == CreatureState::WORKING) {
        // Sin-based swimming within bounds
        float swimPhase = time * 0.30f + phaseOffset[idx];
        float wanderX = fastSin(swimPhase) * 0.10f;
        float wanderY = fastCos(swimPhase * 0.6f) * 0.06f;
        renderX = homeX + wanderX;
        renderY = homeY + wanderY;
        if (renderX < Layout::OpenCodeSwimMinX) renderX = Layout::OpenCodeSwimMinX;
        if (renderX > Layout::OpenCodeSwimMaxX) renderX = Layout::OpenCodeSwimMaxX;
        if (renderY < Layout::OpenCodeSwimMinY) renderY = Layout::OpenCodeSwimMinY;
        if (renderY > Layout::OpenCodeSwimMaxY) renderY = Layout::OpenCodeSwimMaxY;
        currentX[idx] = renderX;
        currentY[idx] = renderY;
    } else {
        renderX = homeX;
        renderY = homeY;
        currentX[idx] = homeX;
        currentY[idx] = homeY;
    }

    float t = time + phaseOffset[idx];

    // Animation parameters
    float breathBob = 0;
    float bodyAlpha = 1.0f;
    uint32_t frameColor = Theme::OpenCodeOuter;

    switch (state) {
        case CreatureState::SLEEPING:
            bodyAlpha = 0.4f;
            break;

        case CreatureState::FLOATING:
            breathBob = fastSin(t * 0.7f) * h * 0.003f;
            break;

        case CreatureState::WORKING: {
            // Bob animation: sin(t*2.0)*size*0.006
            breathBob = fastSin(t * 2.0f) * bodyRadius * 0.006f * h * 0.02f;
            // Pulse: outer frame brightens
            float pulse = fastSin(t * 2.5f) * 0.5f + 0.5f;
            frameColor = lerpColor(Theme::OpenCodeOuter, Theme::OpenCodePulse, pulse);
            break;
        }

        case CreatureState::ASKING:
            breathBob = fastSin(t * 0.8f) * h * 0.002f;
            break;
    }

    int cx = (int)(renderX * w);
    int cy = (int)(renderY * h + breathBob);
    uint8_t alpha = (uint8_t)(255 * bodyAlpha);

    // Working state: subtle outer glow behind body
    if (state == CreatureState::WORKING) {
        float glow = fastSin(t * 2.0f) * 0.5f + 0.5f;
        int glowR = (int)(bodyRadius * 1.3f + glow * bodyRadius * 0.2f);
        Draw::circle(cx, cy, glowR, Theme::OpenCodeOuter, (uint8_t)(glow * 20));
    }

    // Render the canonical hollow ring from the rasterized mask. The mark fills the
    // 24-unit viewBox box; map it into a square box so the mark reads at its true
    // 16:20 (slightly tall) proportion with a hollow, water-showing center.
    int glyphBox = max(2, (int)(bodyRadius * 2.6f));
    Draw::alphaMask(CreatureGlyphs::OPENCODE_A8, CreatureGlyphs::OPENCODE_W, CreatureGlyphs::OPENCODE_H,
                    cx - glyphBox / 2, cy - glyphBox / 2, glyphBox, glyphBox, frameColor, alpha);

    // Speech bubble for ASKING state
    if (state == CreatureState::ASKING) {
        float bubblePulse = fastSin(t * 2.5f) * 0.08f + 1.0f;
        int bx = cx + (int)(bodyRadius * 1.2f);
        int by = cy;
        int br = (int)(bodyRadius * 0.5f * bubblePulse);

        Draw::circle(bx, by, br, 0xFFFFFF, 200);
        // "?" text — simple pixel art
        int qx = bx - 2, qy = by - 3;
        Draw::pixelA(qx + 1, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 3, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 3, qy + 1, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy + 2, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy + 4, Theme::DeepSea, 255);

        // Tail pointing back to body
        Draw::line(bx - br / 3, by + br / 2, cx + (int)(bodyRadius * 0.6f),
                   cy, 0xFFFFFF, 160);
    }

#if !defined(BOARD_TTGO) && !defined(BOARD_ESP32_C6_147)
    // Name tag (same pattern as octopus/cloud)
    lockState();
    char name[32] = "";
    if (idx < g_state.opencodeCount && g_state.opencodeNames[idx][0]) {
        strncpy(name, g_state.opencodeNames[idx], sizeof(name) - 1);
    } else if (g_state.projectName[0]) {
        strncpy(name, g_state.projectName, sizeof(name) - 1);
    } else {
        strncpy(name, "", sizeof(name) - 1);
    }
    name[sizeof(name) - 1] = '\0';
    // Dense tank: idle tags collapse (shared rule, DESIGN.md §6.4).
    const bool showName = g_state.sessionCount < TerrariumRules::NativeLabelDenseResidentCount ||
                          state == CreatureState::WORKING || state == CreatureState::ASKING;
    unlockState();
    if (!showName) return;

    // Name tag — LVGL text rendering on canvas
    lv_point_t txtSize;
    lv_text_get_size(&txtSize, name, &font_kr_12, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    int textW = txtSize.x + (total >= 3 ? 8 : 12);
    int tagH = 16;
    int tagX = cx - textW / 2;
    int tagY = (cy - glyphBox / 2) - tagH - 4;

    // Background pill with rounded ends
    for (int dy = 0; dy < tagH; dy++) {
        for (int dx = 0; dx < textW; dx++) {
            int cornerR = 4;
            bool inCorner = false;
            if (dy < cornerR && dx < cornerR) {
                int d2 = (cornerR - dx) * (cornerR - dx) + (cornerR - dy) * (cornerR - dy);
                inCorner = d2 > cornerR * cornerR;
            } else if (dy < cornerR && dx >= textW - cornerR) {
                int d2 = (dx - textW + cornerR + 1) * (dx - textW + cornerR + 1) + (cornerR - dy) * (cornerR - dy);
                inCorner = d2 > cornerR * cornerR;
            } else if (dy >= tagH - cornerR && dx < cornerR) {
                int d2 = (cornerR - dx) * (cornerR - dx) + (dy - tagH + cornerR + 1) * (dy - tagH + cornerR + 1);
                inCorner = d2 > cornerR * cornerR;
            } else if (dy >= tagH - cornerR && dx >= textW - cornerR) {
                int d2 = (dx - textW + cornerR + 1) * (dx - textW + cornerR + 1) + (dy - tagH + cornerR + 1) * (dy - tagH + cornerR + 1);
                inCorner = d2 > cornerR * cornerR;
            }
            if (!inCorner) {
                Draw::pixelA(tagX + dx, tagY + dy, Theme::OpenCodeInner, 180);
            }
        }
    }

    // Render text using LVGL canvas
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
#endif
}

float getX(uint8_t idx) {
    if (idx >= MAX_OPENCODE) return Layout::OpenCodeHomeX;
    return currentX[idx];
}

float getY(uint8_t idx) {
    if (idx >= MAX_OPENCODE) return Layout::OpenCodeStandingY;
    return currentY[idx];
}

}  // namespace OpenCode
