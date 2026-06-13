#include "renderer.h"
#include "draw.h"
#include "water.h"
#include "terrain.h"
#include "kelp.h"
#include "octopus.h"
#include "cloud.h"
#include "opencode.h"
#include "crayfish.h"
#include "tetra.h"
#include "particles.h"
#include "bubbles.h"
#include "../../state/agent_state.h"
#include "../theme.h"
#include "config.h"

#include <lvgl.h>
#include <Arduino.h>
#include <cmath>
#include <algorithm>
using std::min;
using std::max;

static lv_obj_t* canvas = nullptr;
static lv_draw_buf_t draw_buf;
static uint16_t* canvas_buf = nullptr;
static float totalTime = 0;

// Sin lookup table for fast sin/cos
static float sinTable[SIN_TABLE_SIZE];
static bool sinTableInit = false;

float fastSin(float rad) {
    if (!sinTableInit) {
        for (int i = 0; i < SIN_TABLE_SIZE; i++) {
            sinTable[i] = sinf((float)i / SIN_TABLE_SIZE * 2.0f * M_PI);
        }
        sinTableInit = true;
    }
    float norm = fmodf(rad, 2.0f * M_PI);
    if (norm < 0) norm += 2.0f * M_PI;
    int idx = (int)(norm / (2.0f * M_PI) * SIN_TABLE_SIZE) % SIN_TABLE_SIZE;
    return sinTable[idx];
}

float fastCos(float rad) {
    return fastSin(rad + M_PI / 2.0f);
}

// RGB565 byte-swap for SWAPPED format (big-endian)
static inline uint16_t swap16(uint16_t v) {
    return (v >> 8) | (v << 8);
}

static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) {
    uint16_t c = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
#if defined(BOARD_RGB48)
    // LovyanGFX flush uses swap565_t* — canvas data must be pre-swapped
    return swap16(c);
#else
    // Arduino_GFX: canvas is RGB565, LVGL converts to SWAPPED during compositing
    return c;
#endif
}

static bool isCodexAgentType(const char* agentType) {
    return agentType &&
           (strcmp(agentType, "codex-cli") == 0 ||
            strcmp(agentType, "codex-app") == 0);
}

// Decode a pixel back to R/G/B (handles swap)
static inline void decodePixel(uint16_t px, uint8_t& r, uint8_t& g, uint8_t& b) {
#if defined(BOARD_RGB48)
    px = swap16(px);  // Canvas stores swapped — un-swap for decode
#endif
    r = ((px >> 11) & 0x1F) << 3;
    g = ((px >> 5) & 0x3F) << 2;
    b = (px & 0x1F) << 3;
}

#if defined(BOARD_TTGO)
static constexpr int canvasW = 135;
static constexpr int canvasH = 160;
static uint16_t ttgo_canvas_buf[canvasW * canvasH];
#elif defined(BOARD_ESP32_C6_147)
// Full-screen static canvas. Portrait (172×320) and landscape (320×172) have identical
// pixel counts, so one fixed buffer serves both orientations; canvasW/H follow g_screen
// so the terrarium fills the whole screen after an orientation toggle.
static uint16_t c6_canvas_buf[SCREEN_W * SCREEN_H];
#define canvasW g_screenW
#define canvasH g_screenH
#else
#define canvasW g_screenW
#define canvasH g_screenH
#endif

// Inline pixel setter for direct buffer manipulation
static inline void setPixel(int x, int y, uint16_t color) {
    if (x >= 0 && x < canvasW && y >= 0 && y < canvasH) {
        canvas_buf[y * canvasW + x] = color;
    }
}

static inline void setPixelAlpha(int x, int y, uint32_t color24, uint8_t alpha) {
    if (x < 0 || x >= canvasW || y < 0 || y >= canvasH || alpha == 0) return;
    uint16_t* px = &canvas_buf[y * canvasW + x];
    if (alpha >= 250) {
        *px = rgb565((color24 >> 16) & 0xFF, (color24 >> 8) & 0xFF, color24 & 0xFF);
        return;
    }
    // Alpha blend with existing pixel
    uint8_t bgr, bgg, bgb;
    decodePixel(*px, bgr, bgg, bgb);

    uint8_t fgr = (color24 >> 16) & 0xFF;
    uint8_t fgg = (color24 >> 8) & 0xFF;
    uint8_t fgb = color24 & 0xFF;

    uint8_t a = alpha;
    uint8_t ia = 255 - a;
    *px = rgb565((fgr * a + bgr * ia) >> 8, (fgg * a + bgg * ia) >> 8, (fgb * a + bgb * ia) >> 8);
}

// Draw filled rectangle
static void fillRect(int x, int y, int w, int h, uint16_t color) {
    for (int j = y; j < y + h; j++) {
        for (int i = x; i < x + w; i++) {
            setPixel(i, j, color);
        }
    }
}

// Draw filled circle
static void fillCircle(int cx, int cy, int r, uint32_t color24, uint8_t alpha) {
    int r2 = r * r;
    for (int dy = -r; dy <= r; dy++) {
        for (int dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy <= r2) {
                setPixelAlpha(cx + dx, cy + dy, color24, alpha);
            }
        }
    }
}

// Draw line (Bresenham)
static void drawLine(int x0, int y0, int x1, int y1, uint32_t color24, uint8_t alpha) {
    int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    while (true) {
        setPixelAlpha(x0, y0, color24, alpha);
        if (x0 == x1 && y0 == y1) break;
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

namespace Terrarium {

void init(lv_obj_t* parent) {
#if defined(BOARD_TTGO)
    canvas_buf = ttgo_canvas_buf;
#elif defined(BOARD_ESP32_C6_147)
    canvas_buf = c6_canvas_buf;
#else
    // Allocate canvas buffer in PSRAM or fallback to standard SRAM
    if (!canvas_buf) {
        canvas_buf = (uint16_t*)ps_malloc(g_screenW * g_screenH * sizeof(uint16_t));
        if (!canvas_buf) {
            Serial.println("[Terrarium] PSRAM alloc failed, trying SRAM...");
            canvas_buf = (uint16_t*)malloc(g_screenW * g_screenH * sizeof(uint16_t));
        }
        if (!canvas_buf) {
            Serial.println("[Terrarium] Heap allocation for canvas failed!");
            return;
        }
    }
#endif

#if defined(BOARD_RGB48)
    // LovyanGFX: canvas must match display format (swapped) — no LVGL conversion
    lv_color_format_t canvasFmt = LV_COLOR_FORMAT_RGB565_SWAPPED;
#else
    // Arduino_GFX: canvas in native RGB565, LVGL converts to SWAPPED on flush
    lv_color_format_t canvasFmt = LV_COLOR_FORMAT_RGB565;
#endif
    canvas = lv_canvas_create(parent);
    // Explicit stride = width * 2 bytes (no alignment padding).
    uint32_t canvasStride = canvasW * sizeof(uint16_t);
    lv_draw_buf_init(&draw_buf, canvasW, canvasH, canvasFmt,
                     canvasStride, canvas_buf, canvasW * canvasH * sizeof(uint16_t));
    lv_canvas_set_draw_buf(canvas, &draw_buf);
    lv_obj_align(canvas, LV_ALIGN_TOP_LEFT, 0, 0);

    // Init fast sin table
    fastSin(0);

    // Init sub-renderers
    Water::init();
    Terrain::init();
    Kelp::init();
    Octopus::init();
    Cloud::init();
    if (MAX_OPENCODE > 0) OpenCode::init();
    Crayfish::init();
    Particles::init();
    Tetra::init();
    Bubbles::init();

    Serial.printf("[Terrarium] Canvas %dx%d allocated (%d KB PSRAM)\n",
                  canvasW, canvasH, canvasW * canvasH * 2 / 1024);
}

void render(float dt) {
    if (!canvas_buf) return;

    totalTime += dt;

    // Read state snapshot
    lockState();
    bool hasData = g_state.dataReceived;
    CreatureState cState = g_state.creatureState;
    CrayfishState cfState = g_state.crayfishState;
    TetraState tState = g_state.tetraState;
    // Both "daemon" and "openclaw" agentType come from the daemon process.
    // When gateway is alive, daemon reports "openclaw" — but it's still the daemon
    // and still has sessions_list for per-session state mapping.
    bool isDaemon = hasData && (strcmp(g_state.agentType, "daemon") == 0 ||
                                 strcmp(g_state.agentType, "openclaw") == 0);
    bool isOctopusAgent = hasData &&
                          strcmp(g_state.agentType, "claude-code") == 0;
    bool isCloudAgent = hasData &&
                        isCodexAgentType(g_state.agentType);
    bool isOpenCodeAgent = hasData &&
                           strcmp(g_state.agentType, "opencode") == 0;
    uint8_t octCount = hasData ? g_state.octopusCount : 0;
    // Default to 1 octopus only for claude-code agents (before sessions_list arrives)
    if (octCount == 0 && isOctopusAgent) octCount = 1;
    uint8_t cloudCount = hasData ? g_state.cloudCount : 0;
    // Default to 1 cloud for Codex CLI/App agents (before sessions_list arrives)
    if (cloudCount == 0 && isCloudAgent) cloudCount = 1;
    uint8_t opencodeCount = hasData ? g_state.opencodeCount : 0;
    if (opencodeCount == 0 && isOpenCodeAgent) opencodeCount = 1;
    // Crayfish is drawn only when the OpenClaw Gateway is authenticated
    // (or an error is surfaced). Reachability alone — `gatewayAvailable`
    // — used to draw a cheerful crayfish even when the shared token was
    // missing, which made the board read as "OpenClaw wired up" when it
    // wasn't. Parity with the iOS/Android terrariums.
    bool showCrayfish = hasData && (g_state.gatewayConnected || g_state.gatewayHasError || g_state.crayfishCount > 0);

    // Per-creature state arrays
    CreatureState octStates[MAX_OCTOPUS];
    CreatureState cloudStates[(MAX_CLOUD > 0) ? MAX_CLOUD : 1];
    CreatureState opencodeStates[(MAX_OPENCODE > 0) ? MAX_OPENCODE : 1];

    // Helper lambda to map session state string to CreatureState
    auto mapSessionState = [](const char* stateStr) -> CreatureState {
        if (strcmp(stateStr, "processing") == 0) {
            return CreatureState::WORKING;
        } else if (strcmp(stateStr, "awaiting_permission") == 0 ||
                   strcmp(stateStr, "awaiting_option") == 0 ||
                   strcmp(stateStr, "awaiting_diff") == 0) {
            return CreatureState::ASKING;
        } else if (strcmp(stateStr, "idle") == 0) {
            return CreatureState::FLOATING;
        }
        return CreatureState::FLOATING;
    };

    if (isDaemon) {
        // Map sibling session states to creature states
        uint8_t octIdx = 0;
        uint8_t cloudIdx = 0;
        uint8_t ocIdx = 0;
        for (uint8_t s = 0; s < g_state.sessionCount; s++) {
            if (!g_state.sessions[s].alive) continue;

            if (strcmp(g_state.sessions[s].agentType, "claude-code") == 0 && octIdx < MAX_OCTOPUS) {
                octStates[octIdx] = mapSessionState(g_state.sessions[s].state);
                octIdx++;
            } else if (isCodexAgentType(g_state.sessions[s].agentType) && cloudIdx < MAX_CLOUD) {
                cloudStates[cloudIdx] = mapSessionState(g_state.sessions[s].state);
                cloudIdx++;
            } else if (MAX_OPENCODE > 0 && strcmp(g_state.sessions[s].agentType, "opencode") == 0 && ocIdx < MAX_OPENCODE) {
                opencodeStates[ocIdx] = mapSessionState(g_state.sessions[s].state);
                ocIdx++;
            }
        }
        // Fill remaining with daemon's own state
        for (; octIdx < MAX_OCTOPUS; octIdx++) {
            octStates[octIdx] = cState;
        }
        for (; cloudIdx < MAX_CLOUD; cloudIdx++) {
            cloudStates[cloudIdx] = cState;
        }
        for (; ocIdx < MAX_OPENCODE; ocIdx++) {
            opencodeStates[ocIdx] = cState;
        }
        // Also update the "overall" cState for particles/bubbles/tetra
        // Use the most active sibling state (across octopus + cloud)
        if (octCount > 0 || cloudCount > 0) {
            cState = CreatureState::FLOATING;
            for (uint8_t i = 0; i < octCount && i < MAX_OCTOPUS; i++) {
                if (octStates[i] == CreatureState::WORKING) { cState = CreatureState::WORKING; break; }
            }
            if (cState != CreatureState::WORKING) {
                for (uint8_t i = 0; i < cloudCount && i < MAX_CLOUD; i++) {
                    if (cloudStates[i] == CreatureState::WORKING) { cState = CreatureState::WORKING; break; }
                }
            }
        }
    } else {
        for (uint8_t i = 0; i < MAX_OCTOPUS; i++) {
            octStates[i] = cState;
        }
        for (uint8_t i = 0; i < MAX_CLOUD; i++) {
            cloudStates[i] = cState;
        }
        for (uint8_t i = 0; i < MAX_OPENCODE; i++) {
            opencodeStates[i] = cState;
        }
    }
    unlockState();

    // Render layers bottom-to-top (direct buffer writes)

    // 1. Water gradient background (fills entire buffer)
    Water::renderBackground(canvas_buf, canvasW, canvasH);

    // 2. Light rays from surface (subtle volumetric shafts)
    Water::renderLightRays(canvas_buf, canvasW, canvasH, totalTime);

    // 3. Sand + rocks (terrain)
    Terrain::render(canvas_buf, canvasW, canvasH);

    // 4. Caustic light patterns on sand
    Water::renderCaustics(canvas_buf, canvasW, canvasH, totalTime);

    // 5. Kelp (animated sway)
    Kelp::render(canvas_buf, canvasW, canvasH, totalTime);

    // 6. Crayfish (if visible)
    if (showCrayfish) {
        Crayfish::render(canvas_buf, canvasW, canvasH, totalTime, cfState);
    }

    // 7. Octopus(es) — per-instance state (daemon reports sibling states)
    for (uint8_t i = 0; i < octCount && i < MAX_OCTOPUS; i++) {
        Octopus::render(canvas_buf, canvasW, canvasH, totalTime, dt, octStates[i], i, octCount);
    }

    // 7b. Cloud(s) — Codex CLI creatures (per-instance state)
    for (uint8_t i = 0; i < cloudCount && i < MAX_CLOUD; i++) {
        Cloud::render(canvas_buf, canvasW, canvasH, totalTime, dt, cloudStates[i], i, cloudCount);
    }

    // 7c. OpenCode creatures
    for (uint8_t i = 0; i < opencodeCount && i < MAX_OPENCODE; i++) {
        OpenCode::render(canvas_buf, canvasW, canvasH, totalTime, dt, opencodeStates[i], i, opencodeCount);
    }

    // 8. Data particles (food crumbs from working agents)
    Particles::update(dt, totalTime, cState, octCount, cfState, showCrayfish, octStates);
    Particles::render(canvas_buf, canvasW, canvasH, totalTime);

    // 9. Neon tetra school (chases food particles)
    Tetra::update(dt, totalTime, tState, cState, octCount);
    Tetra::render(canvas_buf, canvasW, canvasH);

    // 10. Floating particles (plankton/dust)
    Water::renderParticles(canvas_buf, canvasW, canvasH, totalTime);

    // 11. Bubbles — pass octCount so exhale comes from all octopuses
    Bubbles::update(dt, totalTime, cState, octCount);
    Bubbles::render(canvas_buf, canvasW, canvasH);

    // 12. Water surface waves + sparkles
    Water::renderSurface(canvas_buf, canvasW, canvasH, totalTime);

#if IS_ROUND
    // 13. Circular mask — black out pixels outside the inscribed circle
    {
        const int cx = canvasW / 2;
        const int cy = canvasH / 2;
        const int r = min(canvasW, canvasH) / 2;
        const int r2 = r * r;
        for (int y = 0; y < canvasH; y++) {
            const int dy = y - cy;
            const int dy2 = dy * dy;
            for (int x = 0; x < canvasW; x++) {
                const int dx = x - cx;
                if (dx * dx + dy2 > r2) {
                    canvas_buf[y * canvasW + x] = 0;  // AMOLED: black = off
                }
            }
        }
    }
#endif

    // Invalidate LVGL canvas to trigger flush
    lv_obj_invalidate(canvas);
}

lv_obj_t* getCanvas() {
    return canvas;
}

}  // namespace Terrarium

// C-linkage accessor for sub-renderers that need LVGL canvas drawing
lv_obj_t* Terrarium_getCanvas() {
    return Terrarium::getCanvas();
}

// Expose drawing primitives for sub-renderers
namespace Draw {
    void pixel(int x, int y, uint16_t color) { setPixel(x, y, color); }
    void pixelA(int x, int y, uint32_t color24, uint8_t alpha) { setPixelAlpha(x, y, color24, alpha); }
    void rect(int x, int y, int w, int h, uint16_t color) { fillRect(x, y, w, h, color); }
    void circle(int cx, int cy, int r, uint32_t color24, uint8_t alpha) { fillCircle(cx, cy, r, color24, alpha); }
    void line(int x0, int y0, int x1, int y1, uint32_t color24, uint8_t alpha) { drawLine(x0, y0, x1, y1, color24, alpha); }
}
