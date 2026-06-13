#include "cloud.h"
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
 * Cloud creature — represents Codex CLI agent.
 *
 * Body is 6 overlapping filled circles forming a cumulus cloud shape.
 * Interior shows ">_" terminal prompt text.
 * Color: indigo/blue (#5561E0) with lighter highlights.
 *
 * States map to Y positions the same as octopus:
 *   SLEEPING  → floor (dimmed, flat)
 *   FLOATING  → standing position (gentle bob)
 *   WORKING   → near top (swimming, pulsing glow)
 *   ASKING    → mid position (speech bubble "?")
 */

// Minimum 1 to avoid zero-length arrays on boards with MAX_CLOUD=0
constexpr uint8_t CLOUD_ARR_SIZE = (MAX_CLOUD > 0) ? MAX_CLOUD : 1;

// Per-instance jitter (seeded by index)
static float jitterX[CLOUD_ARR_SIZE];
static float jitterY[CLOUD_ARR_SIZE];
static float phaseOffset[CLOUD_ARR_SIZE];

// Swimming state per instance
static float currentX[CLOUD_ARR_SIZE];
static float currentY[CLOUD_ARR_SIZE];
static CreatureState prevState[CLOUD_ARR_SIZE];

namespace Cloud {

void init() {
    for (int i = 0; i < MAX_CLOUD; i++) {
        jitterX[i] = ((i * 5 + 7) % 11 - 5) * 0.006f;
        jitterY[i] = ((i * 11 + 3) % 9 - 4) * 0.005f;
        phaseOffset[i] = i * 2.1f;
        currentX[i] = Layout::CloudHomeX;
        currentY[i] = Layout::CloudWorkingY;
        prevState[i] = CreatureState::SLEEPING;
    }
}

void render(uint16_t* buf, int w, int h, float time, float dt,
            CreatureState state, uint8_t idx, uint8_t total) {

    if (idx >= MAX_CLOUD) return;

    // Dynamic scale: shrink when many instances
    float scaleFactor = (total >= 4) ? 0.70f : (total >= 3) ? 0.85f : 1.0f;
    float baseRadius = w * Layout::CloudRadiusFrac * scaleFactor;

    // Calculate home position — wider spread for more creatures
    float homeX;
    if (total <= 1) {
        homeX = Layout::CloudHomeX;
    } else {
        float span = (total <= 2) ? 0.25f : 0.40f;
        homeX = Layout::CloudHomeX - span / 2 + span * idx / (total - 1);
    }
    homeX += jitterX[idx];

    float homeY;
    switch (state) {
        case CreatureState::SLEEPING:
            homeY = Layout::CloudSleepY;
            break;
        case CreatureState::WORKING:
            homeY = Layout::CloudWorkingY;
            break;
        case CreatureState::ASKING:
            homeY = Layout::CloudStandingY;
            break;
        default:
            homeY = Layout::CloudStandingY;
            break;
    }
    // X-correlated depth offset
    homeY += (homeX - 0.5f) * 0.10f + jitterY[idx];

    prevState[idx] = state;

    float renderX, renderY;

    if (state == CreatureState::WORKING) {
        // Sin-based swimming within bounds
        float swimPhase = time * 0.35f + phaseOffset[idx];
        float wanderX = fastSin(swimPhase) * 0.10f;
        float wanderY = fastCos(swimPhase * 0.65f) * 0.07f;
        renderX = homeX + wanderX;
        renderY = homeY + wanderY;
        if (renderX < Layout::CloudSwimMinX) renderX = Layout::CloudSwimMinX;
        if (renderX > Layout::CloudSwimMaxX) renderX = Layout::CloudSwimMaxX;
        if (renderY < Layout::CloudSwimMinY) renderY = Layout::CloudSwimMinY;
        if (renderY > Layout::CloudSwimMaxY) renderY = Layout::CloudSwimMaxY;
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
    uint32_t bodyColor = Theme::CloudBody;

    switch (state) {
        case CreatureState::SLEEPING:
            bodyAlpha = 0.4f;
            break;

        case CreatureState::FLOATING:
            breathBob = fastSin(t * 0.7f) * h * 0.003f;
            break;

        case CreatureState::WORKING: {
            breathBob = fastSin(t * 2 * M_PI / 4.5f) * h * 0.012f;
            // Processing pulse
            float pulse = fastSin(t * 2.5f) * 0.5f + 0.5f;
            bodyColor = lerpColor(Theme::CloudBody, Theme::CloudBodyLight, pulse);
            break;
        }

        case CreatureState::ASKING:
            breathBob = fastSin(t * 0.8f) * h * 0.002f;
            break;
    }

    int cx = (int)(renderX * w);
    int cy = (int)(renderY * h + breathBob);
    uint8_t alpha = (uint8_t)(255 * bodyAlpha);

    // Working glow behind body
    if (state == CreatureState::WORKING) {
        float glow = fastSin(t * 2.0f) * 0.5f + 0.5f;
        int glowR = (int)(baseRadius * 1.6f + glow * baseRadius * 0.2f);
        Draw::circle(cx, cy, glowR, Theme::CloudBody, (uint8_t)(glow * 25));
    }

    // Render the same 6-lobe cloud silhouette used by Stream Deck, D200H,
    // Android, and Apple terrarium. The old TC001/ESP32 glyph was a pill
    // approximation, which made Codex read as a different character family.
    static const float LOBE_DX[6] = {-0.14f, 0.16f, 0.32f, 0.14f, -0.16f, -0.32f};
    static const float LOBE_DY[6] = {-0.30f, -0.26f, -0.02f, 0.26f, 0.26f, -0.02f};
    static const float LOBE_R[6]  = { 0.30f,  0.28f,  0.28f, 0.28f, 0.28f,  0.28f};
    float bodyW = baseRadius * 1.8f;
    for (int i = 0; i < 6; i++) {
        int lx = cx + (int)(LOBE_DX[i] * bodyW);
        int ly = cy + (int)(LOBE_DY[i] * bodyW);
        int lr = max(2, (int)(LOBE_R[i] * bodyW));
        uint32_t lobeColor = (LOBE_DY[i] < -0.1f)
            ? lerpColor(bodyColor, Theme::CloudBodyLight, 0.35f)
            : bodyColor;
        Draw::circle(lx, ly, lr, lobeColor, alpha);
    }
    Draw::circle(cx, cy, max(2, (int)(bodyW * 0.18f)), bodyColor, alpha);

    // >_ prompt overlay (larger, centered in body)
    if (state != CreatureState::SLEEPING) {
        uint32_t promptColor = Theme::CloudPrompt;
        uint8_t promptAlpha = (uint8_t)(alpha * 0.9f);
        int ps = max(1, (int)(bodyW * 0.045f));
        int step = ps * 3;
        int pox = cx - step * 2;
        int poy = cy - step / 2;
        auto px = [&](int x, int y) { Draw::pixelA(x, y, promptColor, promptAlpha); };
        // ">" : 3 rows
        for (int d = 0; d < ps; d++) {
            px(pox + d, poy + d);           // top-right diagonal
            px(pox + ps + d, poy + ps);     // middle
            px(pox + d, poy + ps * 2 - d);  // bottom-right diagonal
        }
        // "_" : underline
        bool showCursor = (state != CreatureState::WORKING) || fmodf(t, 1.0f) < 0.6f;
        if (showCursor) {
            for (int d = 0; d < ps * 2; d++) {
                px(pox + step + d, poy + ps * 2);
            }
        }
    }

    // Speech bubble for ASKING state
    if (state == CreatureState::ASKING) {
        float bubblePulse = fastSin(t * 2.5f) * 0.08f + 1.0f;
        int bx = cx + (int)(baseRadius * 1.4f);
        int by = cy;
        int br = (int)(baseRadius * 0.5f * bubblePulse);

        Draw::circle(bx, by, br, 0xFFFFFF, 200);
        // "?" text
        int qx = bx - 2, qy = by - 3;
        Draw::pixelA(qx + 1, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 3, qy, Theme::DeepSea, 255);
        Draw::pixelA(qx + 3, qy + 1, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy + 2, Theme::DeepSea, 255);
        Draw::pixelA(qx + 2, qy + 4, Theme::DeepSea, 255);

        // Tail pointing back to cloud
        Draw::line(bx - br / 3, by + br / 2, cx + (int)(baseRadius * 0.6f),
                   cy, 0xFFFFFF, 160);
    }

#if !defined(BOARD_TTGO) && !defined(BOARD_ESP32_C6_147)
    // Name tag (same pattern as octopus)
    lockState();
    char name[32] = "";
    if (idx < g_state.cloudCount && g_state.cloudNames[idx][0]) {
        strncpy(name, g_state.cloudNames[idx], sizeof(name) - 1);
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
    int tagY = cy - (int)(baseRadius * 1.1f) - tagH - 4;

    // Background pill
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
                Draw::pixelA(tagX + dx, tagY + dy, Theme::CloudBodyDark, 180);
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
    if (idx >= MAX_CLOUD) return Layout::CloudHomeX;
    return currentX[idx];
}

float getY(uint8_t idx) {
    if (idx >= MAX_CLOUD) return Layout::CloudStandingY;
    return currentY[idx];
}

}  // namespace Cloud
