#ifdef BOARD_LED8X32
#include "matrix_pages.h"
#include "matrix_font.h"
#include "config.h"
#include "state/agent_state.h"
#include "../../../boards/board_config.h"
#include "net/wifi_manager.h"
#include "net/serial_client.h"
#include "net/ws_client.h"
#include <WiFi.h>
#include <cmath>
#include <cstdio>

extern DashboardState g_state;
namespace Matrix { extern float smoothBrightness; }
using Matrix::smoothBrightness;

// ===== Helpers =====

// Is the display in low-brightness mode? (dark room)
static bool isDimMode() { return smoothBrightness < 40; }

// Forward declarations (definitions follow below)
static inline int xyToIdx(int x, int y);

static bool isCodexAgentType(const char* agentType) {
    return agentType &&
           (strcmp(agentType, "codex-cli") == 0 ||
            strcmp(agentType, "codex-app") == 0);
}

// Build a disconnect status line. Returns color for rendering.
// Called with state lock NOT held; reads g_state internally.
// Disconnect is a benign idle state, not an error — keep labels short and
// render in a cool neutral grey so the display doesn't demand attention.
static CRGB buildDisconnectMsg(char* out, size_t outSize) {
    bool wifiNow = Net::wifiConnected();
    bool serialNow = Net::serialConnected();

    lockState();
    uint32_t lastMs = g_state.lastMessageMs;
    unlockState();

    bool everGotData = (lastMs != 0);
    const CRGB grey = CRGB(40, 40, 45);  // cool neutral grey

    // Previously connected — daemon went away. Show OFFLINE regardless of
    // WiFi state (serial-only devices don't need WiFi to work).
    if (everGotData) {
        snprintf(out, outSize, "OFFLINE");
        return grey;
    }

    // Never connected: distinguish WiFi issue from bridge discovery.
    if (!wifiNow && !serialNow) {
        snprintf(out, outSize, "NO WIFI");
    } else {
        snprintf(out, outSize, "FINDING");
    }
    return grey;
}

// Render a static, centered disconnect label with a gentle breathing pulse.
// Disconnect is a benign idle state — the text stays put in a cool grey and
// simply brightens/dims on a slow 4s sine so the display stays unobtrusive.
static void renderDisconnectStatus(CRGB* leds, float animTime) {
    char msg[16];
    CRGB color = buildDisconnectMsg(msg, sizeof(msg));
    if (isDimMode()) {
        color = CRGB(color.r / 2, color.g / 2, color.b / 2);
    }

    // Breathe: 4s period (π/2 rad/s), 70%–100% amplitude.
    float breathe = 0.85f + 0.15f * sinf(animTime * 1.5708f);
    CRGB pulseColor = CRGB(
        (uint8_t)(color.r * breathe),
        (uint8_t)(color.g * breathe),
        (uint8_t)(color.b * breathe));

    int textW = MatrixFont::textWidth(msg);
    int x = (MATRIX_W - textW) / 2;
    MatrixFont::drawScrollText(leds, msg, x, 1, pulseColor, MATRIX_W, MATRIX_H);
}

static inline int xyToIdx(int x, int y) {
    if (x < 0 || x >= MATRIX_W || y < 0 || y >= MATRIX_H) return -1;
    return (y % 2 == 0) ? (y * MATRIX_W + x) : (y * MATRIX_W + (MATRIX_W - 1 - x));
}

static inline void setPixel(CRGB* leds, int x, int y, CRGB color) {
    int idx = xyToIdx(x, y);
    if (idx >= 0) leds[idx] = color;
}

// Battery-style gauge (no label, wider)
static void drawBatteryGauge(CRGB* leds, int x0, int y0, int w, int h, float percent) {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    float remaining = 100.0f - percent;

    CRGB border = CRGB(60, 60, 60);
    // Outline
    for (int x = x0; x < x0 + w; x++) {
        setPixel(leds, x, y0, border);
        setPixel(leds, x, y0 + h - 1, border);
    }
    for (int y = y0; y < y0 + h; y++) {
        setPixel(leds, x0, y, border);
        setPixel(leds, x0 + w - 1, y, border);
    }
    // Battery nub
    for (int y = y0 + 1; y < y0 + h - 1; y++) {
        setPixel(leds, x0 + w, y, CRGB(40, 40, 40));
    }

    // Fill (remaining = filled, used = empty)
    int innerW = w - 2;
    int fillPx = (int)(remaining / 100.0f * innerW);

    CRGB fillColor;
    if (remaining > 40)      fillColor = CRGB(0, 180, 0);
    else if (remaining > 20) fillColor = CRGB(180, 150, 0);
    else                     fillColor = CRGB(200, 0, 0);

    for (int x = 0; x < innerW; x++) {
        CRGB c = (x < fillPx) ? fillColor : CRGB(12, 12, 12);
        for (int y = y0 + 1; y < y0 + h - 1; y++) {
            setPixel(leds, x0 + 1 + x, y, c);
        }
    }
}

// Parse reset time string into total minutes
// "1h 23m" → 83, "2d 4h" → 3120, "45m" → 45
static int parseResetMinutes(const char* reset) {
    int total = 0;
    int num = 0;
    for (int i = 0; reset[i]; i++) {
        char c = reset[i];
        if (c >= '0' && c <= '9') {
            num = num * 10 + (c - '0');
        } else if (c == 'd' || c == 'D') {
            total += num * 24 * 60;
            num = 0;
        } else if (c == 'h' || c == 'H') {
            total += num * 60;
            num = 0;
        } else if (c == 'm' || c == 'M') {
            total += num;
            num = 0;
        }
    }
    return total + num;  // trailing number without unit = minutes
}

// Draw sprite
static void drawSprite(CRGB* leds, int x0, int y0, const uint8_t* sprite,
                       int w, int h, CRGB color) {
    for (int row = 0; row < h; row++) {
        for (int col = 0; col < w; col++) {
            if (sprite[row] & (1 << (w - 1 - col))) {
                setPixel(leds, x0 + col, y0 + row, color);
            }
        }
    }
}

static inline uint8_t clamp8(int v) { return v > 255 ? 255 : (uint8_t)v; }

// Accent color whose brightness is TIED to the body's brightness. A lit accent
// (eyes / marking / highlight) must never be brighter than what the dim body can
// support, or it floats as a lone dot / disembodied eyes when the creature is in
// an idle/dormant (near-black body) state. `hue` is the accent at full brightness;
// the result is that hue scaled to ~`boost`× the body's luminance (capped).
static CRGB accentScaled(CRGB hue, CRGB body, float boost) {
    uint8_t bodyMax = body.r;
    if (body.g > bodyMax) bodyMax = body.g;
    if (body.b > bodyMax) bodyMax = body.b;
    float s = (bodyMax / 255.0f) * boost;
    if (s > 1.0f) s = 1.0f;
    return CRGB(clamp8((int)(hue.r * s)), clamp8((int)(hue.g * s)), clamp8((int)(hue.b * s)));
}

// Draw a creature: flat body, then a LIT accent overlay (eyes / marking / core /
// head highlight). On a WS2812 matrix "dark" pixels are simply off (black), so
// detail must be conveyed with a brighter/contrasting LIT color, not dark pixels.
// `accent` may be nullptr to skip the overlay. Accent bits are a subset of body
// bits, so the accent never floats outside the silhouette.
static void drawCreature(CRGB* leds, int x0, int y0,
                         const uint8_t* body, const uint8_t* accent,
                         int w, int h, CRGB bodyColor, CRGB accentColor) {
    drawSprite(leds, x0, y0, body, w, h, bodyColor);
    if (accent) drawSprite(leds, x0, y0, accent, w, h, accentColor);
}

// Tiny state dot in bottom-right corner of USAGE page (row 7, col 31)
// Shows brightest active agent state so user can glance at activity without
// waiting for the AGENTS page.
static void drawStateDot(CRGB* leds, float animTime) {
    lockState();
    uint8_t sessionCount = g_state.sessionCount;
    // Find most active state among live non-daemon sessions
    enum { ST_NONE, ST_IDLE, ST_AWAITING, ST_PROCESSING } best = ST_NONE;
    for (int i = 0; i < sessionCount; i++) {
        if (!g_state.sessions[i].alive) continue;
        if (strcmp(g_state.sessions[i].agentType, "daemon") == 0) continue;
        if (strcmp(g_state.sessions[i].state, "processing") == 0) { best = ST_PROCESSING; break; }
        if (strstr(g_state.sessions[i].state, "awaiting")) { if (best < ST_AWAITING) best = ST_AWAITING; }
        else if (strcmp(g_state.sessions[i].state, "idle") == 0) { if (best < ST_IDLE) best = ST_IDLE; }
    }
    unlockState();

    CRGB c = CRGB::Black;
    switch (best) {
        case ST_PROCESSING: {
            float pulse = 0.5f + 0.5f * sinf(animTime * 8.0f);
            c = CRGB((uint8_t)(200 * pulse), (uint8_t)(120 * pulse), (uint8_t)(90 * pulse));
            break;
        }
        case ST_AWAITING: {
            float pulse = 0.5f + 0.5f * sinf(animTime * 3.0f);
            c = CRGB((uint8_t)(200 * pulse), (uint8_t)(140 * pulse), 0);
            break;
        }
        case ST_IDLE:
            c = CRGB(25, 15, 12);  // dim terracotta
            break;
        default:
            return;  // no sessions — no dot
    }
    setPixel(leds, 31, 7, c);
}

// ===== Creature sprites (5x6) — body bitmap + lit accent overlay =====
// Body is drawn in the agent's state color; the *_ACC overlay adds a lit detail
// (octopus head highlight, Codex ">_" marking, OpenCode bright core, crayfish
// teal eyes) in a brighter/contrasting color. See drawCreature().
static const uint8_t SPR_OCTOPUS[6] = {
    0b01110, 0b11111, 0b10101, 0b11111, 0b01110, 0b10101
};
static const uint8_t SPR_OCTOPUS_ACC[6] = {   // brighter head highlight
    0b01110, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000
};
static const uint8_t SPR_JELLYFISH[6] = {
    0b01110, 0b11111, 0b11111, 0b01110, 0b01010, 0b10001
};
static const uint8_t SPR_JELLYFISH_ACC[6] = { // ">_" prompt marking (light)
    0b00000, 0b00000, 0b00100, 0b00000, 0b00000, 0b00000
};
static const uint8_t SPR_OPENCODE[6] = {
    0b11111, 0b10001, 0b10101, 0b10001, 0b11111, 0b00000
};
static const uint8_t SPR_OPENCODE_ACC[6] = {  // bright nested-square core
    0b00000, 0b00000, 0b00100, 0b00000, 0b00000, 0b00000
};
static const uint8_t SPR_CRAYFISH[6] = {
    0b10001, 0b01110, 0b11111, 0b01110, 0b00100, 0b01010
};
static const uint8_t SPR_CRAYFISH_ACC[6] = {  // teal eyes (OpenClaw signature)
    0b00000, 0b01010, 0b00000, 0b00000, 0b00000, 0b00000
};

// Format reset time compact: "3h 22m" → "3H22", "2d 4h" → "2D4", "20m" → "20M"
// First unit letter kept, subsequent unit letters dropped to save width.
static int formatResetCompact(const char* reset, char* out, int maxLen) {
    int ri = 0;
    bool hasUnit = false;
    for (int i = 0; reset[i] && ri < maxLen - 1; i++) {
        char c = reset[i];
        if (c >= '0' && c <= '9') {
            out[ri++] = c;
        } else if (c == 'h' || c == 'H' || c == 'd' || c == 'D' ||
                   (c == 'm' && (reset[i+1] == 0 || reset[i+1] == ' '))) {
            if (!hasUnit) {
                out[ri++] = (c == 'm') ? 'M' : (c == 'h' || c == 'H') ? 'H' : 'D';
                hasUnit = true;
            }
            // subsequent unit letters are dropped
        }
        // skip spaces
    }
    out[ri] = '\0';
    return ri;
}

// Gauge color matching Pixoo palette
static CRGB gaugeColor(float percent, float animTime) {
    if (percent >= 90) {
        float pulse = 0.7f + 0.3f * sinf(animTime * 6.0f);
        return CRGB((uint8_t)(239 * pulse), (uint8_t)(68 * pulse), (uint8_t)(68 * pulse));
    }
    if (percent >= 70) return CRGB(245, 158, 11);   // Amber
    if (percent >= 50) return CRGB(0, 200, 180);     // Teal
    return CRGB(59, 130, 246);                        // Blue
}

// Full-screen gauge: percent number (gauge color, left) + reset time (gray, right)
static void drawFullScreenGauge(CRGB* leds, float percent,
                                 const char* resetStr, float animTime, int slideX) {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;

    CRGB fillColor = gaugeColor(percent, animTime);
    // Dimmed fill (20% brightness) — maximizes contrast for bright text on LED matrix
    CRGB dimFill = CRGB(fillColor.r / 5, fillColor.g / 5, fillColor.b / 5);

    // Fill entire screen: used portion = dimmed color, unused = near-black
    int fillPx = (int)(percent / 100.0f * MATRIX_W);
    for (int x = 0; x < MATRIX_W; x++) {
        int sx = x + slideX;
        if (sx < 0 || sx >= MATRIX_W) continue;
        CRGB c = (x < fillPx) ? dimFill : CRGB(4, 4, 6);
        for (int y = 0; y < MATRIX_H; y++) {
            setPixel(leds, sx, y, c);
        }
    }

    // Percentage in bright white — maximum contrast on both filled and empty areas
    char pctBuf[5];
    snprintf(pctBuf, sizeof(pctBuf), "%d%%", (int)(percent + 0.5f));
    bool dim = isDimMode();
    CRGB pctColor = CRGB(255, 255, 255);
    MatrixFont::drawScrollText(leds, pctBuf, 1 + slideX, 1, pctColor, MATRIX_W, MATRIX_H);

    // Reset time in muted gray (right-aligned)
    char timeBuf[8];
    if (formatResetCompact(resetStr, timeBuf, sizeof(timeBuf)) > 0) {
        int tw = MatrixFont::textWidth(timeBuf);
        CRGB timeColor = dim ? CRGB(0xA0, 0xA0, 0xA0) : CRGB(0x60, 0x70, 0x80);
        MatrixFont::drawScrollText(leds, timeBuf, MATRIX_W - tw - 1 + slideX, 1, timeColor, MATRIX_W, MATRIX_H);
    }
}

// ================================================================
// PAGE 1: USAGE — Full-screen 5H/7D with slide transition
// ================================================================
void MatrixPages::renderUsage(CRGB* leds, float animTime) {
    lockState();
    bool connected = g_state.wsConnected || Net::serialConnected();
    float pct5h = g_state.fiveHourPercent;
    float pct7d = g_state.sevenDayPercent;
    char reset5h[20], reset7d[20];
    strncpy(reset5h, g_state.fiveHourReset, sizeof(reset5h) - 1);
    reset5h[sizeof(reset5h) - 1] = '\0';
    strncpy(reset7d, g_state.sevenDayReset, sizeof(reset7d) - 1);
    reset7d[sizeof(reset7d) - 1] = '\0';
    unlockState();

    if (!connected) {
        renderDisconnectStatus(leds, animTime);
        return;
    }

    if (pct5h < 0) {
        CRGB dimColor = CRGB(30, 30, 40);
        MatrixFont::drawScrollText(leds, "---", 10, 2, dimColor, MATRIX_W, MATRIX_H);
        return;
    }

    // Cycle: 4s show 5H → 0.5s slide → 4s show 7D → 0.5s slide back
    float cycle = 9.0f;
    float phase = fmodf(animTime, cycle);

    if (phase < 4.0f) {
        drawFullScreenGauge(leds, pct5h, reset5h, animTime, 0);
    } else if (phase < 4.5f) {
        float t = (phase - 4.0f) / 0.5f;
        int offset = (int)(t * MATRIX_W);
        drawFullScreenGauge(leds, pct5h, reset5h, animTime, -offset);
        drawFullScreenGauge(leds, pct7d, reset7d, animTime, MATRIX_W - offset);
    } else if (phase < 8.5f) {
        drawFullScreenGauge(leds, pct7d, reset7d, animTime, 0);
    } else {
        float t = (phase - 8.5f) / 0.5f;
        int offset = (int)(t * MATRIX_W);
        drawFullScreenGauge(leds, pct7d, reset7d, animTime, -offset);
        drawFullScreenGauge(leds, pct5h, reset5h, animTime, MATRIX_W - offset);
    }

    // State dot overlay — shows agent activity on gauge page
    drawStateDot(leds, animTime);
}

// ================================================================
// PAGE 2: AGENTS — Crayfish fixed right + octopus scroll
// ================================================================
void MatrixPages::renderAgents(CRGB* leds, float animTime) {
    // Disconnect check first — never render stale creature/session sprites
    // when we've lost connection. The user explicitly wants a clear status
    // screen instead of last-known data.
    lockState();
    bool connectedFast = g_state.wsConnected || Net::serialConnected();
    unlockState();
    if (!connectedFast) {
        renderDisconnectStatus(leds, animTime);
        return;
    }

    lockState();
    bool connected = g_state.wsConnected || Net::serialConnected();
    uint8_t sessionCount = g_state.sessionCount;
    // Crayfish draws only when the Gateway is authenticated — reachability
    // alone (`gatewayConnable`) is not enough. Parity with terrarium renderer.
    bool gatewayConn = g_state.gatewayConnected;
    bool gatewayError = g_state.gatewayHasError;
    CrayfishState cfState = g_state.crayfishState;

    // Collect non-openclaw sessions with agent type
    enum AgentKind { AGENT_CLAUDE, AGENT_CODEX, AGENT_OPENCODE };
    struct AgentInfo {
        char state[20];
        AgentKind kind;
        int instanceIdx;
    };
    AgentInfo agents[6];
    int agentCount = 0;
    int claudeSeen = 0, codexSeen = 0, opencodeSeen = 0;
    bool openclawAlive = false;

    for (int i = 0; i < sessionCount && agentCount < 6; i++) {
        if (!g_state.sessions[i].alive) continue;
        if (strcmp(g_state.sessions[i].agentType, "openclaw") == 0) {
            openclawAlive = true;
            continue;
        }
        if (strcmp(g_state.sessions[i].agentType, "daemon") == 0) continue;
        strncpy(agents[agentCount].state, g_state.sessions[i].state, 19);
        agents[agentCount].state[19] = '\0';
        if (isCodexAgentType(g_state.sessions[i].agentType)) {
            agents[agentCount].kind = AGENT_CODEX;
            agents[agentCount].instanceIdx = codexSeen++;
        } else if (strcmp(g_state.sessions[i].agentType, "opencode") == 0) {
            agents[agentCount].kind = AGENT_OPENCODE;
            agents[agentCount].instanceIdx = opencodeSeen++;
        } else if (strcmp(g_state.sessions[i].agentType, "claude-code") == 0) {
            agents[agentCount].kind = AGENT_CLAUDE;
            agents[agentCount].instanceIdx = claudeSeen++;
        } else {
            continue;
        }
        agentCount++;
    }
    unlockState();

    // === Crayfish: fixed at right (x=27, y=1) ===
    // Authenticated Gateway → state-driven color. OpenClaw-session-alive-but-
    // Gateway-not-authenticated → dim "present but idle" glyph so the matrix
    // isn't blank during pairing handshakes, token-mismatch states, or the
    // brief reconnect window where `gatewayConnected` has dropped but the
    // openclaw session is still enumerated in sessions_list.
    bool drewCrayfish = false;
    if (connected && gatewayConn) {
        CRGB cfColor;
        if (gatewayError) {
            cfColor = CRGB(40, 40, 40);  // SICK: gray
        } else if (cfState == CrayfishState::ROUTING) {
            float pulse = 0.75f + 0.25f * sinf(animTime * 12.0f);
            cfColor = CRGB((uint8_t)(220 * pulse), (uint8_t)(40 * pulse), (uint8_t)(30 * pulse));
        } else if (cfState == CrayfishState::SITTING) {
            // Dark red pulse
            uint8_t r = 50 + (uint8_t)(30.0f * (0.5f + 0.5f * sinf(animTime * 1.5f)));
            cfColor = CRGB(r, 5, 5);
        } else {
            cfColor = CRGB(25, 5, 5);  // DORMANT: very dim red
        }
        // Teal eyes scaled to body brightness so dormant/sitting (near-black body)
        // doesn't leave the eyes floating. Skip entirely when SICK (gray reads "off").
        const uint8_t* cfAcc = gatewayError ? nullptr : SPR_CRAYFISH_ACC;
        drawCreature(leds, 27, 1, SPR_CRAYFISH, cfAcc, 5, 6, cfColor,
                     accentScaled(CRGB(0, 225, 200), cfColor, 1.5f));
        drewCrayfish = true;
    } else if (connected && openclawAlive) {
        // Gateway not authenticated yet (or reconnecting) but the OpenClaw
        // session is live — draw a very dim crayfish so the user sees
        // "OpenClaw is here, waiting" instead of a fully black matrix.
        CRGB pairBody = CRGB(12, 3, 3);
        drawCreature(leds, 27, 1, SPR_CRAYFISH, SPR_CRAYFISH_ACC, 5, 6,
                     pairBody, accentScaled(CRGB(0, 225, 200), pairBody, 1.5f));
        drewCrayfish = true;
    }

    // === Agents: left area (x 0 to cfX-2) ===
    int cfX = drewCrayfish ? 27 : 32;   // crayfish position (or off-screen)
    int agentMaxX = cfX - 7;            // rightmost sprite start (5px sprite + 2px gap)

    if (agentCount == 0) {
        if (!connected) {
            renderDisconnectStatus(leds, animTime);
            return;
        }
        // Only OpenClaw is alive — the crayfish glyph above is our signal.
        // Skip the idle octopus so we don't imply a phantom Claude session.
        // (Previously this `return` could land on a completely black matrix
        // when Gateway wasn't authenticated; the crayfish fallback above
        // guarantees at least one sprite is lit in that case.)
        if (openclawAlive) {
            return;
        }
        // No active agent sessions — show idle octopus with gentle breathing
        float breathe = 0.6f + 0.4f * sinf(animTime * 1.2f);
        int bobY = 1 + (int)(0.5f * sinf(animTime * 0.8f));
        CRGB idleColor = CRGB(
            (uint8_t)(80 * breathe), (uint8_t)(48 * breathe), (uint8_t)(36 * breathe));
        drawCreature(leds, 8, bobY, SPR_OCTOPUS, SPR_OCTOPUS_ACC, 5, 6,
                     idleColor, accentScaled(CRGB(235, 150, 110), idleColor, 1.5f));
        return;
    }

    // Per-agent-type color: Claude=terracotta, Codex=indigo, OpenCode=cyan
    auto agentColor = [&](const char* state, AgentKind kind, int instanceIdx) -> CRGB {
        CRGB baseColor;
        if (strcmp(state, "processing") == 0) {
            float pulse = 0.5f + 0.5f * sinf(animTime * 8.0f);
            switch (kind) {
                case AGENT_CODEX:
                    baseColor = CRGB(30 + (uint8_t)(70 * pulse), 30 + (uint8_t)(70 * pulse), 80 + (uint8_t)(160 * pulse));
                    break;
                case AGENT_OPENCODE:
                    baseColor = CRGB(0, 60 + (uint8_t)(140 * pulse), 80 + (uint8_t)(160 * pulse));
                    break;
                default: // AGENT_CLAUDE
                    baseColor = CRGB(50 + (uint8_t)(150 * pulse), 30 + (uint8_t)(90 * pulse), 22 + (uint8_t)(68 * pulse));
                    break;
            }
        }
        else if (strstr(state, "awaiting")) {
            float pulse = 0.3f + 0.7f * sinf(animTime * 3.0f);
            baseColor = CRGB((uint8_t)(200 * pulse), (uint8_t)(120 * pulse), 0);
        }
        else if (strcmp(state, "idle") == 0) {
            switch (kind) {
                case AGENT_CODEX:    baseColor = CRGB(30, 30, 80);  break;  // dim indigo
                case AGENT_OPENCODE: baseColor = CRGB(0, 40, 55);   break;  // dim cyan
                default:             baseColor = CRGB(80, 45, 35);  break;  // dim terracotta
            }
        }
        else {
            baseColor = CRGB(25, 25, 25);
        }
        if (instanceIdx > 0) {
            baseColor.r = (baseColor.r * (10 - instanceIdx * 2)) / 10;
            baseColor.g = (baseColor.g * (10 - instanceIdx * 2)) / 10;
            baseColor.b = (baseColor.b * (10 - instanceIdx * 2)) / 10;
        }
        return baseColor;
    };

    // Sprite selection per agent type
    auto agentSprite = [](AgentKind kind) -> const uint8_t* {
        switch (kind) {
            case AGENT_CODEX:    return SPR_JELLYFISH;
            case AGENT_OPENCODE: return SPR_OPENCODE;
            default:             return SPR_OCTOPUS;
        }
    };
    auto agentAccent = [](AgentKind kind) -> const uint8_t* {
        switch (kind) {
            case AGENT_CODEX:    return SPR_JELLYFISH_ACC;
            case AGENT_OPENCODE: return SPR_OPENCODE_ACC;
            default:             return SPR_OCTOPUS_ACC;
        }
    };
    // Lit accent color, brightness tied to the body so it never floats when dim.
    auto agentAccentColor = [](AgentKind kind, CRGB body) -> CRGB {
        switch (kind) {
            case AGENT_CODEX:    return accentScaled(CRGB(220, 225, 255), body, 1.4f); // ">_" marking
            case AGENT_OPENCODE: return accentScaled(CRGB(120, 230, 255), body, 1.5f); // bright core
            default:             return accentScaled(CRGB(235, 150, 110), body, 1.5f); // octopus head
        }
    };

    int visibleSlots = 3;
    int spacing = 7;  // 5px sprite + 2px gap

    if (agentCount <= visibleSlots) {
        for (int i = 0; i < agentCount; i++) {
            int x = 1 + i * spacing;
            int bobY = 1 + (int)(0.3f * sinf(animTime * 2.0f + i * 1.5f));
            CRGB bc = agentColor(agents[i].state, agents[i].kind, agents[i].instanceIdx);
            drawCreature(leds, x, bobY, agentSprite(agents[i].kind), agentAccent(agents[i].kind),
                         5, 6, bc, agentAccentColor(agents[i].kind, bc));
        }
    } else {
        // Ping-pong scroll: pause → slide right → pause → slide back left
        int maxScroll = (agentCount - visibleSlots) * spacing;
        float scrollDur = (agentCount - visibleSlots) * 2.0f;
        // pause(3s) → scroll right(dur) → pause(3s) → scroll back(dur)
        float cycleTime = 3.0f + scrollDur + 3.0f + scrollDur;
        float phase = fmodf(animTime, cycleTime);

        int scrollOffset = 0;
        if (phase < 3.0f) {
            scrollOffset = 0;  // pause at start
        } else if (phase < 3.0f + scrollDur) {
            float t = (phase - 3.0f) / scrollDur;
            // ease-in-out: smooth cubic
            t = t * t * (3.0f - 2.0f * t);
            scrollOffset = (int)(t * maxScroll);
        } else if (phase < 6.0f + scrollDur) {
            scrollOffset = maxScroll;  // pause at end
        } else {
            float t = (phase - 6.0f - scrollDur) / scrollDur;
            t = t * t * (3.0f - 2.0f * t);
            scrollOffset = maxScroll - (int)(t * maxScroll);
        }

        for (int i = 0; i < agentCount; i++) {
            int x = 1 + i * spacing - scrollOffset;
            if (x > agentMaxX || x < -5) continue;
            int bobY = 1 + (int)(0.3f * sinf(animTime * 2.0f + i * 1.2f));
            CRGB bc = agentColor(agents[i].state, agents[i].kind, agents[i].instanceIdx);
            drawCreature(leds, x, bobY, agentSprite(agents[i].kind), agentAccent(agents[i].kind),
                         5, 6, bc, agentAccentColor(agents[i].kind, bc));
        }
    }
}

// renderInfo removed — TC001 now only cycles USAGE + AGENTS
#if 0
void MatrixPages::renderInfo(CRGB* leds, float animTime) {
    lockState();

    // Collect all alive sessions (not daemon)
    struct SessionEntry {
        char project[40];
        char model[32];
    };
    SessionEntry entries[7];
    int entryCount = 0;

    // Add primary session
    if (g_state.projectName[0] || g_state.modelName[0]) {
        strncpy(entries[0].project, g_state.projectName[0] ? g_state.projectName : "---", 39);
        entries[0].project[39] = '\0';
        strncpy(entries[0].model, g_state.modelName[0] ? g_state.modelName : "---", 31);
        entries[0].model[31] = '\0';
        entryCount = 1;
    }

    // Add sibling sessions (from sessions_list)
    for (int i = 0; i < g_state.sessionCount && entryCount < 7; i++) {
        if (!g_state.sessions[i].alive) continue;
        if (strcmp(g_state.sessions[i].agentType, "daemon") == 0) continue;

        // Skip if same as primary (by project name)
        if (entryCount > 0 && strcmp(g_state.sessions[i].projectName, entries[0].project) == 0) continue;

        strncpy(entries[entryCount].project,
                g_state.sessions[i].projectName[0] ? g_state.sessions[i].projectName : "---", 39);
        entries[entryCount].project[39] = '\0';

        // Model: use session's modelName if available, else agentType fallback
        const char* modelName = g_state.sessions[i].modelName;
        const char* agentType = g_state.sessions[i].agentType;
        
        if (modelName[0] != '\0') {
            strncpy(entries[entryCount].model, modelName, 31);
        } else if (strcmp(agentType, "claude-code") == 0) {
            strncpy(entries[entryCount].model, g_state.modelName[0] ? g_state.modelName : "CLAUDE", 31);
        } else if (strcmp(agentType, "openclaw") == 0) {
            strncpy(entries[entryCount].model, "OPENCLAW", 31);
        } else if (isCodexAgentType(agentType)) {
            strncpy(entries[entryCount].model, "CODEX", 31);
        } else {
            strncpy(entries[entryCount].model, agentType, 31);
        }
        entries[entryCount].model[31] = '\0';
        entryCount++;
    }
    unlockState();

    if (entryCount == 0) {
        MatrixFont::drawScrollText(leds, "---", 12, 2, CRGB(40, 40, 40), MATRIX_W, MATRIX_H);
        return;
    }

    // Calculate per-entry display duration: full scroll time + 3s dwell
    float entryDurations[7];
    float totalDuration = 0;
    for (int i = 0; i < entryCount; i++) {
        int pLen = strlen(entries[i].project);
        int mLen = strlen(entries[i].model);
        int textW = pLen * 4 + 12 + mLen * 4;
        int scrollPixels = textW + MATRIX_W + 16;
        float scrollTime = (scrollPixels * (float)SCROLL_SPEED_MS) / 1000.0f;
        entryDurations[i] = scrollTime + 3.0f;  // 3s dwell after scroll completes
        if (entryDurations[i] < 8.0f) entryDurations[i] = 8.0f;  // minimum 8 seconds
        totalDuration += entryDurations[i];
    }

    // Find which entry we're on
    float phase = fmodf(animTime, totalDuration);
    int currentEntry = 0;
    float entryStart = 0;
    for (int i = 0; i < entryCount; i++) {
        if (phase < entryStart + entryDurations[i]) {
            currentEntry = i;
            break;
        }
        entryStart += entryDurations[i];
        if (i == entryCount - 1) currentEntry = i;
    }

    char project[40], model[32];
    strncpy(project, entries[currentEntry].project, 39); project[39] = '\0';
    strncpy(model, entries[currentEntry].model, 31); model[31] = '\0';

    for (char* p = project; *p; p++) *p = toupper(*p);
    for (char* p = model; *p; p++) *p = toupper(*p);

    int projLen = strlen(project);
    int modelLen = strlen(model);
    int sepW = 12;
    int totalW = projLen * 4 + sepW + modelLen * 4;
    if (totalW > 0) totalW -= 1;

    int y = 2;

    // Scroll within this entry's time window
    float localTime = phase - entryStart;
    int scrollCyclePx = totalW + MATRIX_W + 16;
    int scrollPx = ((int)(localTime * 1000) / (int)SCROLL_SPEED_MS);
    if (scrollPx > scrollCyclePx) scrollPx = scrollCyclePx;  // clamp, don't wrap
    int baseX = MATRIX_W - scrollPx;

    // Project (green)
    MatrixFont::drawScrollText(leds, project, baseX, y, CRGB(0, 200, 100), MATRIX_W, MATRIX_H);
    // Separator dot
    int sepX = baseX + projLen * 4 + 4;
    MatrixFont::drawChar(leds, sepX, y, '.', CRGB(60, 60, 60), MATRIX_W, MATRIX_H);
    // Model (cyan)
    int modelX = baseX + projLen * 4 + sepW;
    MatrixFont::drawScrollText(leds, model, modelX, y, CRGB(0, 200, 255), MATRIX_W, MATRIX_H);

    // Session indicator dots (row 7) if multiple entries
    if (entryCount > 1) {
        int dotStart = (MATRIX_W - entryCount * 3) / 2;
        for (int i = 0; i < entryCount; i++) {
            CRGB c = (i == currentEntry) ? CRGB(100, 100, 100) : CRGB(20, 20, 20);
            setPixel(leds, dotStart + i * 3, 7, c);
        }
    }
}
#endif // renderInfo disabled
#endif // BOARD_LED8X32
