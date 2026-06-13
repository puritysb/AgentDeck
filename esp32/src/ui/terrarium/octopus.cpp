#include "octopus.h"
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

// Simulator SSOT: 12×8 Claude Code block glyph from claudecode-color.svg
// Flat terracotta glyph: rectangular body, eye cutouts, lower pegs.
// 0=empty, 1=body (all cells are body — no separate eye/arm/leg types for glyph)
static const uint8_t GRID[8][12] = {
    {0,0,1,1,1,1,1,1,1,1,0,0},
    {0,0,1,1,0,1,1,0,1,1,0,0},  // eye cutouts
    {1,1,1,1,0,1,1,0,1,1,1,1},
    {1,1,1,1,1,1,1,1,1,1,1,1},
    {1,1,1,1,1,1,1,1,1,1,1,1},
    {0,1,1,1,1,1,1,1,1,1,1,0},
    {0,0,1,0,1,0,0,1,0,1,0,0},  // lower pegs
    {0,0,1,0,1,0,0,1,0,1,0,0},
};
constexpr int GRID_COLS = 12;
constexpr int GRID_ROWS = 8;

// Per-instance jitter (seeded by index)
static float jitterX[MAX_OCTOPUS];
static float jitterY[MAX_OCTOPUS];
static float phaseOffset[MAX_OCTOPUS];

// Swimming state per instance
static float currentX[MAX_OCTOPUS];
static float currentY[MAX_OCTOPUS];
static float targetX[MAX_OCTOPUS];
static float targetY[MAX_OCTOPUS];
static float waypointTimer[MAX_OCTOPUS];
static float waypointInterval[MAX_OCTOPUS];
static CreatureState prevState[MAX_OCTOPUS];

// Simple PRNG for waypoint selection
static uint32_t swimRng = 54321;
static float swimRngFloat() {
    swimRng = swimRng * 1103515245 + 12345;
    return (float)((swimRng >> 16) & 0x7FFF) / 32767.0f;
}

namespace Octopus {

void init() {
    // Deterministic jitter per instance
    for (int i = 0; i < MAX_OCTOPUS; i++) {
        jitterX[i] = ((i * 7 + 3) % 11 - 5) * 0.006f;  // ±0.03
        jitterY[i] = ((i * 13 + 5) % 9 - 4) * 0.005f;
        phaseOffset[i] = i * 1.7f;
        currentX[i] = Layout::OctHomeX;
        currentY[i] = Layout::OctWorkingY;
        targetX[i] = currentX[i];
        targetY[i] = currentY[i];
        waypointTimer[i] = 0;
        waypointInterval[i] = 1.5f + i * 0.3f;
        prevState[i] = CreatureState::SLEEPING;
    }
}

void render(uint16_t* buf, int w, int h, float time, float dt,
            CreatureState state, uint8_t idx, uint8_t total) {

    // Dynamic scale: shrink creatures when many sessions
    float scaleFactor = (total >= 5) ? 0.60f : (total >= 4) ? 0.70f : (total >= 3) ? 0.85f : 1.0f;
    float bodyRadius = w * Layout::OctBodyRadiusFrac * scaleFactor;
    float glyphW = bodyRadius * 2.2f;
    float cellW = glyphW / GRID_COLS;
    float cellH = cellW;  // square cells for block glyph

    // Calculate home position — wider spread for more creatures
    float homeX;
    if (total <= 1) {
        homeX = Layout::OctHomeX;
    } else {
        float span = (total <= 2) ? 0.30f : (total <= 3) ? 0.40f : 0.50f;
        homeX = Layout::OctHomeX - span / 2 + span * idx / (total - 1);
    }
    homeX += jitterX[idx];

    float homeY;
    switch (state) {
        case CreatureState::SLEEPING:
            homeY = Layout::OctSleepY;
            break;
        case CreatureState::WORKING:
            homeY = Layout::OctWorkingY;
            break;
        default:
            homeY = Layout::OctStandingY;
            break;
    }
    // X-correlated depth offset
    homeY += (homeX - 0.3f) * 0.15f + jitterY[idx];

    // --- Swimming logic (WORKING state) ---
    bool justEnteredWorking = (state == CreatureState::WORKING && prevState[idx] != CreatureState::WORKING);
    prevState[idx] = state;

    float renderX, renderY;

    if (state == CreatureState::WORKING) {
        // Sin-based swimming: continuous smooth movement within swim bounds
        // Per-instance phase offset for independent movement
        float swimPhase = time * 0.4f + phaseOffset[idx];
        float wanderX = fastSin(swimPhase) * 0.12f;
        float wanderY = fastCos(swimPhase * 0.7f) * 0.08f;
        renderX = homeX + wanderX;
        renderY = homeY + wanderY;
        // Clamp to swim bounds
        if (renderX < Layout::OctSwimMinX) renderX = Layout::OctSwimMinX;
        if (renderX > Layout::OctSwimMaxX) renderX = Layout::OctSwimMaxX;
        if (renderY < Layout::OctSwimMinY) renderY = Layout::OctSwimMinY;
        if (renderY > Layout::OctSwimMaxY) renderY = Layout::OctSwimMaxY;
        // Track for particles/bubbles
        currentX[idx] = renderX;
        currentY[idx] = renderY;
    } else {
        renderX = homeX;
        renderY = homeY;
        currentX[idx] = homeX;
        currentY[idx] = homeY;
    }

    float t = time + phaseOffset[idx];

    // Animation offsets
    float breathBob = 0;
    float bodyAlpha = 1.0f;
    uint32_t bodyColor = Theme::ClaudeBody;

    switch (state) {
        case CreatureState::SLEEPING:
            bodyAlpha = 0.4f;
            break;
        case CreatureState::FLOATING:
            breathBob = fastSin(t * 0.9f) * h * 0.004f;
            break;
        case CreatureState::WORKING: {
            breathBob = fastSin(t * 2.3f) * h * 0.012f;
            float pulse = fastSin(t * 3.0f) * 0.5f + 0.5f;
            bodyColor = lerpColor(Theme::ClaudeBody, Theme::ClaudeBodyLight, pulse);
            break;
        }
        case CreatureState::ASKING:
            breathBob = fastSin(t * 0.9f) * h * 0.004f;
            break;
    }

    int cx = (int)(renderX * w);
    int cy = (int)(renderY * h + breathBob);
    uint8_t alpha = (uint8_t)(255 * bodyAlpha);

    int cW = max(1, (int)cellW);
    int cH = max(1, (int)cellH);
    int glyphPxW = GRID_COLS * cW;
    int glyphPxH = GRID_ROWS * cH;
    int startX = cx - glyphPxW / 2;
    int startY = cy - glyphPxH / 2;

    // Working sparkle behind body
    if (state == CreatureState::WORKING) {
        for (int i = 0; i < 6; i++) {
            float angle = t * 0.5f + i * (M_PI / 3.0f);
            int sx = cx + (int)(cosf(angle) * bodyRadius * 0.95f);
            int sy = cy + (int)(sinf(angle) * bodyRadius * 0.75f);
            Draw::line(cx, cy, sx, sy, Theme::ClaudeBodyLight, 56);
        }
    }

    // Render 12×8 block glyph
    for (int row = 0; row < GRID_ROWS; row++) {
        for (int col = 0; col < GRID_COLS; col++) {
            if (GRID[row][col] == 0) continue;
            int px = startX + col * cW;
            int py = startY + row * cH;
            for (int dy = 0; dy < cH; dy++) {
                for (int dx = 0; dx < cW; dx++) {
                    Draw::pixelA(px + dx, py + dy, bodyColor, alpha);
                }
            }
        }
    }

    // Speech bubble for ASKING state — positioned beside body (not above, to avoid name tag overlap)
    if (state == CreatureState::ASKING) {
        float bubblePulse = fastSin(t * 2.5f) * 0.08f + 1.0f;
        int bx = cx + (int)(bodyRadius * 1.2f);
        int by = cy;  // Body center height — clear of name tag above
        int br = (int)(bodyRadius * 0.6f * bubblePulse);

        Draw::circle(bx, by, br, 0xFFFFFF, 200);
        // "?" text — simple pixel art
        int qx = bx - 2, qy = by - 3;
        // Simplified "?" shape
        Draw::pixelA(qx + 1, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 3, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 3, qy + 1, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy + 2, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy + 4, Theme::DeepSea, 255);

        // Tail triangle — points from bubble to body right edge
        Draw::line(bx - br / 3, by + br / 2, cx + (int)(bodyRadius * 0.5f),
                   cy, 0xFFFFFF, 160);
    }

#if !defined(BOARD_TTGO) && !defined(BOARD_ESP32_C6_147)
    // Name tag with text (always shown)
    // Read session name from state — prefer sessionNames, fall back to projectName
    lockState();
    char name[32] = "";
    if (idx < g_state.octopusCount && g_state.sessionNames[idx][0]) {
        strncpy(name, g_state.sessionNames[idx], sizeof(name) - 1);
    } else if (g_state.projectName[0]) {
        strncpy(name, g_state.projectName, sizeof(name) - 1);
    } else {
        strncpy(name, "", sizeof(name) - 1);
    }
    name[sizeof(name) - 1] = '\0';
    unlockState();

    // Name tag — LVGL text rendering directly on canvas
    // Use LVGL's text width calculation (handles Korean + Latin mixed text)
    lv_point_t txtSize;
    lv_text_get_size(&txtSize, name, &font_kr_12, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    int textW = txtSize.x + (total >= 4 ? 8 : 12);  // Tighter padding when scaled down
    int tagH = 16;
    int tagX = cx - textW / 2;
    int tagY = startY - tagH - 4;

    // Background pill with rounded ends
    for (int dy = 0; dy < tagH; dy++) {
        for (int dx = 0; dx < textW; dx++) {
            // Simple rounded corners
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
                Draw::pixelA(tagX + dx, tagY + dy, Theme::ClaudeBodyDark, 180);
            }
        }
    }

    // Render text using LVGL canvas drawing — single line, no wrap
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

        // Wide area to prevent wrapping
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
    if (idx >= MAX_OCTOPUS) return Layout::OctHomeX;
    return currentX[idx];
}

float getY(uint8_t idx) {
    if (idx >= MAX_OCTOPUS) return Layout::OctStandingY;
    return currentY[idx];
}

}  // namespace Octopus
