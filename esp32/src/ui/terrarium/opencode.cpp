#include "opencode.h"
#include "draw.h"
#include "renderer.h"
#include "../theme.h"
#include "../display.h"
#include "config.h"
#include "../../state/agent_state.h"
#include <Arduino.h>
#include <lvgl.h>
#include <cstring>
#include <cmath>

/**
 * OpenCode logo glyph — nested-square geometric mark.
 * From opencode-logo-dark.svg: bright outer frame, dark inner square.
 *
 * Cell values:
 *   0 = transparent (gap between frames)
 *   8 = outer frame (#F1ECEC)
 *   9 = inner square (#4B4646)
 *
 * States map to Y positions like other creatures:
 *   SLEEPING  -> floor (dimmed)
 *   FLOATING  -> standing (gentle bob)
 *   WORKING   -> near top (bob + pulse)
 *   ASKING    -> mid position (speech bubble "?")
 */
static const uint8_t OPENCODE_GRID[9][10] = {
    {8,8,8,8,8,8,8,8,8,8},
    {8,0,0,0,0,0,0,0,0,8},
    {8,0,9,9,9,9,9,9,0,8},
    {8,0,9,0,0,0,0,9,0,8},
    {8,0,9,0,0,0,0,9,0,8},
    {8,0,9,0,0,0,0,9,0,8},
    {8,0,9,9,9,9,9,9,0,8},
    {8,0,0,0,0,0,0,0,0,8},
    {8,8,8,8,8,8,8,8,8,8},
};

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
    float bodyRadius = w * Layout::OpenCodeRadiusFrac * scaleFactor;

    // Calculate home position — wider spread for more creatures
    float homeX;
    if (total <= 1) {
        homeX = Layout::OpenCodeHomeX;
    } else {
        float span = (total <= 2) ? 0.25f : 0.40f;
        homeX = Layout::OpenCodeHomeX - span / 2 + span * idx / (total - 1);
    }
    homeX += jitterX[idx];

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
    uint32_t outerColor = Theme::OpenCodeOuter;
    uint32_t innerColor = Theme::OpenCodeInner;

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
            outerColor = lerpColor(Theme::OpenCodeOuter, Theme::OpenCodePulse, pulse);
            break;
        }

        case CreatureState::ASKING:
            breathBob = fastSin(t * 0.8f) * h * 0.002f;
            break;
    }

    int cx = (int)(renderX * w);
    int cy = (int)(renderY * h + breathBob);
    uint8_t alpha = (uint8_t)(255 * bodyAlpha);

    // Pixel-fill lambda
    auto fillRectA = [&](int x, int y, int rw, int rh, uint32_t color24, uint8_t a) {
        for (int dy = 0; dy < rh; dy++) {
            for (int dx = 0; dx < rw; dx++) {
                Draw::pixelA(x + dx, y + dy, color24, a);
            }
        }
    };

    // Grid dimensions — square cells
    int glyphW = (int)(bodyRadius * 2.0f);
    int cellW = max(1, glyphW / 10);
    int cellH = cellW;
    int glyphX = cx - (10 * cellW) / 2;
    int glyphY = cy - (9 * cellH) / 2;

    // Working state: subtle outer glow behind body
    if (state == CreatureState::WORKING) {
        float glow = fastSin(t * 2.0f) * 0.5f + 0.5f;
        int glowR = (int)(bodyRadius * 1.3f + glow * bodyRadius * 0.2f);
        Draw::circle(cx, cy, glowR, Theme::OpenCodeOuter, (uint8_t)(glow * 20));
    }

    // Render grid
    for (int row = 0; row < 9; row++) {
        for (int col = 0; col < 10; col++) {
            uint8_t cell = OPENCODE_GRID[row][col];
            if (cell == 0) continue;
            uint32_t color = (cell == 8) ? outerColor : innerColor;
            fillRectA(glyphX + col * cellW, glyphY + row * cellH, cellW, cellH, color, alpha);
        }
    }

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
    unlockState();

    // Name tag — LVGL text rendering on canvas
    lv_point_t txtSize;
    lv_text_get_size(&txtSize, name, &font_kr_12, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    int textW = txtSize.x + (total >= 3 ? 8 : 12);
    int tagH = 16;
    int tagX = cx - textW / 2;
    int tagY = glyphY - tagH - 4;

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
