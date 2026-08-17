#include "renderer.h"
#include "draw.h"
#include "water.h"
#include "terrain.h"
#include "kelp.h"
#include "octopus.h"
#include "cloud.h"
#include "opencode.h"
#include "antigravity.h"
#include "kiro.h"
#include "crayfish.h"
#include "tetra.h"
#include "particles.h"
#include "bubbles.h"
#include "../../state/agent_state.h"
#include "../../util/memory.h"
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
#if defined(BOARD_IPS10)
// Cached static base = water-gradient background + sand/rocks terrain. These two passes are
// static (no animation) yet the most expensive per frame (~456K px combined). Render once →
// memcpy every frame instead of recomputing. See render() for the reorder rationale.
static uint16_t* baseCache = nullptr;
static bool baseCacheDirty = true;
#endif
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
    // Arduino_GFX: canvas is RGB565, LVGL converts to SWAPPED during compositing
    return c;
}

static bool isCodexAgentType(const char* agentType) {
    return agentType &&
           (strcmp(agentType, "codex-cli") == 0 ||
            strcmp(agentType, "codex-app") == 0);
}

// Decode a pixel back to R/G/B (handles swap)
static inline void decodePixel(uint16_t px, uint8_t& r, uint8_t& g, uint8_t& b) {
    r = ((px >> 11) & 0x1F) << 3;
    g = ((px >> 5) & 0x3F) << 2;
    b = (px & 0x1F) << 3;
}

#if defined(BOARD_TTGO)
static constexpr int TTGO_PANEL_SHORT_EDGE = 135;  // true panel short edge (canvas HEIGHT in landscape)
// LVGL requires the canvas draw-buf stride to be 32-byte aligned (LV_DRAW_BUF_STRIDE_ALIGN).
// The stride is canvasW*2, so the canvas WIDTH must be a multiple of 16 px. In landscape the
// width is the 160 px long edge (320 B, already aligned), but in portrait the width is the
// 135 px short edge → 270 B, which is NOT aligned. An unaligned canvas stride renders as a
// solid black band on LVGL's blit path (the exact "portrait black, landscape fine" symptom).
// Pad the portrait canvas width up to 144 (next multiple of 16 → 288 B stride); the extra
// 9 px sit off the right screen edge and are clipped. Whether LVGL honors our explicit stride
// or recomputes the aligned one, both now equal 288, so there is no pitch mismatch.
static constexpr int TTGO_PANEL_SHORT_EDGE_W = 144;  // portrait canvas WIDTH, padded for aligned stride
static constexpr int TTGO_TERRARIUM_LONG_EDGE = 160;
static uint16_t ttgo_canvas_buf[TTGO_PANEL_SHORT_EDGE_W * TTGO_TERRARIUM_LONG_EDGE];  // 144*160, fits both orientations
#define canvasW ((g_screenW > g_screenH) ? TTGO_TERRARIUM_LONG_EDGE : TTGO_PANEL_SHORT_EDGE_W)
#define canvasH ((g_screenW > g_screenH) ? TTGO_PANEL_SHORT_EDGE : TTGO_TERRARIUM_LONG_EDGE)
#elif defined(BOARD_ESP32_C6_147)
// Full-screen static canvas. Portrait (172×320) and landscape (320×172) have identical
// pixel counts, so one fixed buffer serves both orientations; canvasW/H follow g_screen
// so the terrarium fills the whole screen after an orientation toggle.
static uint16_t c6_canvas_buf[SCREEN_W * SCREEN_H];
#define canvasW g_screenW
#define canvasH g_screenH
#elif defined(BOARD_IPS10)
// Tablet layout: terrarium occupies the LEFT region; the HUD sidebar (logo/sessions/
// usage/timeline) overlays the right. Shrinking the canvas width keeps creatures —
// positioned by fraction of canvas width — clear of the sidebar automatically.
static constexpr int IPS10_TERRARIUM_W = 408;  // 800 − ~372px treemap sidebar − margins
#define canvasW IPS10_TERRARIUM_W
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

// Draw an 8-bit alpha coverage mask (e.g. a rasterized creature silhouette) scaled
// into a destination box, tinted with color24 and modulated by a global alpha.
// Bilinear sampling so the single high-res master downsizes/upsizes smoothly.
static void fillAlphaMask(const uint8_t* mask, int maskW, int maskH,
                          int x0, int y0, int dstW, int dstH,
                          uint32_t color24, uint8_t alpha) {
    if (!mask || dstW <= 0 || dstH <= 0 || alpha == 0) return;
    const float fx = (float)maskW / dstW;
    const float fy = (float)maskH / dstH;
    for (int py = 0; py < dstH; py++) {
        // Map dst pixel center back into mask space, then clamp for bilinear taps.
        float sy = (py + 0.5f) * fy - 0.5f;
        int y1 = (int)floorf(sy);
        float wy = sy - y1;
        int ya = y1 < 0 ? 0 : (y1 >= maskH ? maskH - 1 : y1);
        int yb = (y1 + 1) < 0 ? 0 : ((y1 + 1) >= maskH ? maskH - 1 : y1 + 1);
        for (int px = 0; px < dstW; px++) {
            float sx = (px + 0.5f) * fx - 0.5f;
            int x1 = (int)floorf(sx);
            float wx = sx - x1;
            int xa = x1 < 0 ? 0 : (x1 >= maskW ? maskW - 1 : x1);
            int xb = (x1 + 1) < 0 ? 0 : ((x1 + 1) >= maskW ? maskW - 1 : x1 + 1);
            float a00 = mask[ya * maskW + xa], a10 = mask[ya * maskW + xb];
            float a01 = mask[yb * maskW + xa], a11 = mask[yb * maskW + xb];
            float top = a00 + (a10 - a00) * wx;
            float bot = a01 + (a11 - a01) * wx;
            int cov = (int)(top + (bot - top) * wy + 0.5f);
            if (cov <= 0) continue;
            uint8_t a = (uint8_t)((cov * alpha) / 255);
            if (a) setPixelAlpha(x0 + px, y0 + py, color24, a);
        }
    }
}

// Alpha-mask draw with a vertical color gradient (top → bottom), e.g. the crayfish
// shell shading. Same bilinear coverage sampling as fillAlphaMask.
static void fillAlphaMaskGradient(const uint8_t* mask, int maskW, int maskH,
                                  int x0, int y0, int dstW, int dstH,
                                  uint32_t colorTop, uint32_t colorBottom, uint8_t alpha) {
    if (!mask || dstW <= 0 || dstH <= 0 || alpha == 0) return;
    const float fx = (float)maskW / dstW;
    const float fy = (float)maskH / dstH;
    for (int py = 0; py < dstH; py++) {
        uint32_t rowColor = lerpColor(colorTop, colorBottom, (py + 0.5f) / dstH);
        float sy = (py + 0.5f) * fy - 0.5f;
        int y1 = (int)floorf(sy);
        float wy = sy - y1;
        int ya = y1 < 0 ? 0 : (y1 >= maskH ? maskH - 1 : y1);
        int yb = (y1 + 1) < 0 ? 0 : ((y1 + 1) >= maskH ? maskH - 1 : y1 + 1);
        for (int px = 0; px < dstW; px++) {
            float sx = (px + 0.5f) * fx - 0.5f;
            int x1 = (int)floorf(sx);
            float wx = sx - x1;
            int xa = x1 < 0 ? 0 : (x1 >= maskW ? maskW - 1 : x1);
            int xb = (x1 + 1) < 0 ? 0 : ((x1 + 1) >= maskW ? maskW - 1 : x1 + 1);
            float a00 = mask[ya * maskW + xa], a10 = mask[ya * maskW + xb];
            float a01 = mask[yb * maskW + xa], a11 = mask[yb * maskW + xb];
            float top = a00 + (a10 - a00) * wx;
            float bot = a01 + (a11 - a01) * wx;
            int cov = (int)(top + (bot - top) * wy + 0.5f);
            if (cov <= 0) continue;
            uint8_t a = (uint8_t)((cov * alpha) / 255);
            if (a) setPixelAlpha(x0 + px, y0 + py, rowColor, a);
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

// Decorative parent/child topology. Fixed arithmetic only: no heap allocation
// or growable container in the render loop (important on TTGO/C6 boards).
static void drawSubagentOrbit(float x, float y, uint8_t activeCount, float time) {
    if (activeCount == 0) return;
    const int cx = (int)(x * canvasW);
    const int cy = (int)(y * canvasH);
    // Cast BOTH: canvasW/canvasH are per-board macros, int constants on TTGO and
    // IPS10 but int16_t globals on the C6, so casting only one side leaves
    // min(int16_t&, int) with no viable overload there.
    const int minDim = min((int)canvasW, (int)canvasH);
    const int rx = max(10, (int)(minDim * 0.105f));
    const int ry = max(4, (int)(rx * 0.38f));
    // Fixed tilt coefficients avoid extra libm state/code on DRAM-tight TTGO.
    constexpr float tiltCos = 0.96105546f;
    constexpr float tiltSin = -0.27635565f;
    constexpr uint32_t cyan = 0x00E5FF;

    // Dotted, tilted Saturn ring.
    for (uint8_t step = 0; step < 40; step += 2) {
        float angle = (float)step / 40.0f * 2.0f * M_PI;
        float localX = fastCos(angle) * rx;
        float localY = fastSin(angle) * ry;
        int px = cx + (int)(localX * tiltCos - localY * tiltSin);
        int py = cy + (int)(localX * tiltSin + localY * tiltCos);
        setPixelAlpha(px, py, cyan, 105);
    }

    uint8_t visible = activeCount < 3 ? activeCount : 3;
    for (uint8_t i = 0; i < visible; i++) {
        float angle = time * 0.72f + (float)i * 2.0f * M_PI / visible;
        float localX = fastCos(angle) * rx;
        float localY = fastSin(angle) * ry;
        int sx = cx + (int)(localX * tiltCos - localY * tiltSin);
        int sy = cy + (int)(localX * tiltSin + localY * tiltCos);
        drawLine(cx, cy, sx, sy, cyan, 34);
        int nodeRadius = (i == 2 && activeCount > 3) ? 3 : 2;
        fillCircle(sx, sy, nodeRadius, cyan, 235);
        if (i == 2 && activeCount > 3) {
            // Tiny '+' overflow mark; detailed count remains in Timeline.
            drawLine(sx + 4, sy, sx + 8, sy, cyan, 210);
            drawLine(sx + 6, sy - 2, sx + 6, sy + 2, cyan, 210);
        }
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

#if defined(BOARD_IPS10)
    // Static-base cache (bg + terrain). Same geometry as the live canvas.
    if (!baseCache) {
        baseCache = (uint16_t*)ps_malloc((size_t)canvasW * canvasH * sizeof(uint16_t));
        if (!baseCache) Serial.println("[Terrarium] baseCache alloc failed — per-frame bg+terrain");
    }
    baseCacheDirty = true;   // (re)build on next render (orientation change re-inits)
#endif

    // Arduino_GFX: canvas in native RGB565, LVGL converts to SWAPPED on flush
    lv_color_format_t canvasFmt = LV_COLOR_FORMAT_RGB565;
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
    if (MAX_ANTIGRAVITY > 0) Antigravity::init();
    if (MAX_KIRO > 0) Kiro::init();
    Crayfish::init();
    Particles::init();
    Tetra::init();
    Bubbles::init();

    Serial.printf("[Terrarium] Canvas %dx%d allocated (%d KB PSRAM)\n",
                  canvasW, canvasH, canvasW * canvasH * 2 / 1024);
    logHeap("post-terrarium");
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
    bool isAntigravityAgent = hasData &&
                              strcmp(g_state.agentType, "antigravity") == 0;
    uint8_t octCount = hasData ? g_state.octopusCount : 0;
    // Default to 1 octopus only for claude-code agents (before sessions_list arrives)
    if (octCount == 0 && isOctopusAgent) octCount = 1;
    uint8_t cloudCount = hasData ? g_state.cloudCount : 0;
    // Default to 1 cloud for Codex CLI/App agents (before sessions_list arrives)
    if (cloudCount == 0 && isCloudAgent) cloudCount = 1;
    uint8_t opencodeCount = hasData ? g_state.opencodeCount : 0;
    if (opencodeCount == 0 && isOpenCodeAgent) opencodeCount = 1;
    uint8_t antigravityCount = hasData ? g_state.antigravityCount : 0;
    if (antigravityCount == 0 && isAntigravityAgent) antigravityCount = 1;
    // Both Kiro front ends share one creature — see kiro.cpp.
    bool isKiroAgent = hasData && strncmp(g_state.agentType, "kiro", 4) == 0;
    uint8_t kiroCount = hasData ? g_state.kiroCount : 0;
    if (kiroCount == 0 && isKiroAgent) kiroCount = 1;
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
    CreatureState antigravityStates[(MAX_ANTIGRAVITY > 0) ? MAX_ANTIGRAVITY : 1];
    CreatureState kiroStates[(MAX_KIRO > 0) ? MAX_KIRO : 1];
    uint8_t octSubagents[(MAX_OCTOPUS > 0) ? MAX_OCTOPUS : 1] = {};
    uint8_t cloudSubagents[(MAX_CLOUD > 0) ? MAX_CLOUD : 1] = {};
    uint8_t opencodeSubagents[(MAX_OPENCODE > 0) ? MAX_OPENCODE : 1] = {};
    uint8_t antigravitySubagents[(MAX_ANTIGRAVITY > 0) ? MAX_ANTIGRAVITY : 1] = {};
    uint8_t kiroSubagents[(MAX_KIRO > 0) ? MAX_KIRO : 1] = {};

    // Preserve the session ordering used by the creature-state mapper.
    uint8_t octActivityIdx = 0, cloudActivityIdx = 0;
    uint8_t openCodeActivityIdx = 0, antigravityActivityIdx = 0, kiroActivityIdx = 0;
    for (uint8_t s = 0; s < g_state.sessionCount; s++) {
        const SessionInfo& session = g_state.sessions[s];
        if (!session.alive) continue;
        uint8_t active = g_state.activeSubagentsForSession(session.id);
        if (strcmp(session.agentType, "claude-code") == 0 &&
            octActivityIdx < MAX_OCTOPUS) {
            octSubagents[octActivityIdx++] = active;
        } else if (isCodexAgentType(session.agentType) &&
                   cloudActivityIdx < MAX_CLOUD) {
            cloudSubagents[cloudActivityIdx++] = active;
        } else if (strcmp(session.agentType, "opencode") == 0 &&
                   openCodeActivityIdx < MAX_OPENCODE) {
            opencodeSubagents[openCodeActivityIdx++] = active;
        } else if (strcmp(session.agentType, "antigravity") == 0 &&
                   antigravityActivityIdx < MAX_ANTIGRAVITY) {
            antigravitySubagents[antigravityActivityIdx++] = active;
        } else if (strncmp(session.agentType, "kiro", 4) == 0 &&
                   kiroActivityIdx < MAX_KIRO) {
            kiroSubagents[kiroActivityIdx++] = active;
        }
    }

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
        uint8_t agIdx = 0;
        uint8_t kiIdx = 0;
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
            } else if (MAX_ANTIGRAVITY > 0 && strcmp(g_state.sessions[s].agentType, "antigravity") == 0 && agIdx < MAX_ANTIGRAVITY) {
                antigravityStates[agIdx] = mapSessionState(g_state.sessions[s].state);
                agIdx++;
            } else if (MAX_KIRO > 0 && strncmp(g_state.sessions[s].agentType, "kiro", 4) == 0 && kiIdx < MAX_KIRO) {
                kiroStates[kiIdx] = mapSessionState(g_state.sessions[s].state);
                kiIdx++;
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
        for (; agIdx < MAX_ANTIGRAVITY; agIdx++) {
            antigravityStates[agIdx] = cState;
        }
        for (; kiIdx < MAX_KIRO; kiIdx++) {
            kiroStates[kiIdx] = cState;
        }
        // Also update the "overall" cState for particles/bubbles/tetra
        // Use the most active sibling state (across octopus + cloud)
        if (octCount > 0 || cloudCount > 0 || opencodeCount > 0 || antigravityCount > 0 || kiroCount > 0) {
            cState = CreatureState::FLOATING;
            for (uint8_t i = 0; i < octCount && i < MAX_OCTOPUS; i++) {
                if (octStates[i] == CreatureState::WORKING) { cState = CreatureState::WORKING; break; }
            }
            if (cState != CreatureState::WORKING) {
                for (uint8_t i = 0; i < cloudCount && i < MAX_CLOUD; i++) {
                    if (cloudStates[i] == CreatureState::WORKING) { cState = CreatureState::WORKING; break; }
                }
            }
            if (cState != CreatureState::WORKING) {
                for (uint8_t i = 0; i < opencodeCount && i < MAX_OPENCODE; i++) {
                    if (opencodeStates[i] == CreatureState::WORKING) { cState = CreatureState::WORKING; break; }
                }
            }
            if (cState != CreatureState::WORKING) {
                for (uint8_t i = 0; i < antigravityCount && i < MAX_ANTIGRAVITY; i++) {
                    if (antigravityStates[i] == CreatureState::WORKING) { cState = CreatureState::WORKING; break; }
                }
            }
            if (cState != CreatureState::WORKING) {
                for (uint8_t i = 0; i < kiroCount && i < MAX_KIRO; i++) {
                    if (kiroStates[i] == CreatureState::WORKING) { cState = CreatureState::WORKING; break; }
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
        for (uint8_t i = 0; i < MAX_ANTIGRAVITY; i++) {
            antigravityStates[i] = cState;
        }
        for (uint8_t i = 0; i < MAX_KIRO; i++) {
            kiroStates[i] = cState;
        }
    }
    unlockState();

    // Render layers bottom-to-top (direct buffer writes)
#if defined(IPS10_PERF_PROFILE)
    static uint32_t pBg=0,pRay=0,pTer=0,pCau=0,pKelp=0,pN=0,pLast=0; uint32_t _t;
#define PROF(acc) do{ acc += micros()-_t; _t=micros(); }while(0)
    _t = micros();
#else
#define PROF(acc) do{}while(0)
#endif

#if defined(BOARD_IPS10)
    if (baseCache) {
        // Static base = bg + terrain, rendered ONCE then memcpy'd each frame. Light rays
        // (water band) and caustics (sand-top band) are reordered AFTER terrain here, but
        // their y-ranges are disjoint so the composite is pixel-identical to the original
        // bg→ray→terrain→caustic order — at a fraction of the per-frame cost.
        if (baseCacheDirty) {
            Water::renderBackground(baseCache, canvasW, canvasH);
            Terrain::render(baseCache, canvasW, canvasH);
            baseCacheDirty = false;
        }
        memcpy(canvas_buf, baseCache, (size_t)canvasW * canvasH * sizeof(uint16_t));
        PROF(pBg);
        Water::renderLightRays(canvas_buf, canvasW, canvasH, totalTime);
        PROF(pRay);
        Water::renderCaustics(canvas_buf, canvasW, canvasH, totalTime);
        PROF(pCau);
    } else
#endif
    {
        // 1. Water gradient background (fills entire buffer)
        Water::renderBackground(canvas_buf, canvasW, canvasH);
        PROF(pBg);

        // 2. Light rays from surface (subtle volumetric shafts)
        Water::renderLightRays(canvas_buf, canvasW, canvasH, totalTime);
        PROF(pRay);

        // 3. Sand + rocks (terrain)
        Terrain::render(canvas_buf, canvasW, canvasH);
        PROF(pTer);

        // 4. Caustic light patterns on sand
        Water::renderCaustics(canvas_buf, canvasW, canvasH, totalTime);
        PROF(pCau);
    }

    // 5. Kelp (animated sway)
    Kelp::render(canvas_buf, canvasW, canvasH, totalTime);
    PROF(pKelp);
#if defined(IPS10_PERF_PROFILE)
    pN++;
    if (millis() - pLast >= 2000 && pN > 0) {
        Serial.printf("[PROF] bg %lu | ray %lu | terrain %lu | caustics %lu | kelp %lu us/frame (n=%lu)\n",
            (unsigned long)(pBg/pN),(unsigned long)(pRay/pN),(unsigned long)(pTer/pN),
            (unsigned long)(pCau/pN),(unsigned long)(pKelp/pN),(unsigned long)pN);
        pBg=pRay=pTer=pCau=pKelp=pN=0; pLast=millis();
    }
#endif

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

    // 7d. Antigravity creatures
    for (uint8_t i = 0; i < antigravityCount && i < MAX_ANTIGRAVITY; i++) {
        Antigravity::render(canvas_buf, canvasW, canvasH, totalTime, dt, antigravityStates[i], i, antigravityCount);
    }

    // 7e. Kiro creatures
    for (uint8_t i = 0; i < kiroCount && i < MAX_KIRO; i++) {
        Kiro::render(canvas_buf, canvasW, canvasH, totalTime, dt, kiroStates[i], i, kiroCount);
    }

    // Parent-linked orbit accents sit above the creature layer but remain
    // decorative; the underlying session is still the only interaction target.
    for (uint8_t i = 0; i < octCount && i < MAX_OCTOPUS; i++) {
        drawSubagentOrbit(Octopus::getX(i), Octopus::getY(i), octSubagents[i], totalTime);
    }
    for (uint8_t i = 0; i < cloudCount && i < MAX_CLOUD; i++) {
        drawSubagentOrbit(Cloud::getX(i), Cloud::getY(i), cloudSubagents[i], totalTime);
    }
    for (uint8_t i = 0; i < opencodeCount && i < MAX_OPENCODE; i++) {
        drawSubagentOrbit(OpenCode::getX(i), OpenCode::getY(i), opencodeSubagents[i], totalTime);
    }
    for (uint8_t i = 0; i < antigravityCount && i < MAX_ANTIGRAVITY; i++) {
        drawSubagentOrbit(
            Antigravity::getX(i),
            Antigravity::getY(i),
            antigravitySubagents[i],
            totalTime
        );
    }
    for (uint8_t i = 0; i < kiroCount && i < MAX_KIRO; i++) {
        drawSubagentOrbit(Kiro::getX(i), Kiro::getY(i), kiroSubagents[i], totalTime);
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
    void alphaMask(const uint8_t* mask, int maskW, int maskH, int x0, int y0,
                   int dstW, int dstH, uint32_t color24, uint8_t alpha) {
        fillAlphaMask(mask, maskW, maskH, x0, y0, dstW, dstH, color24, alpha);
    }
    void alphaMaskGradient(const uint8_t* mask, int maskW, int maskH, int x0, int y0,
                           int dstW, int dstH, uint32_t colorTop, uint32_t colorBottom, uint8_t alpha) {
        fillAlphaMaskGradient(mask, maskW, maskH, x0, y0, dstW, dstH, colorTop, colorBottom, alpha);
    }
}
