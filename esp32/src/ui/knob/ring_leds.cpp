#if defined(BOARD_T_EMBED)

#include "ring_leds.h"
#include "../../../boards/board_config.h"
#include "../../state/agent_state.h"
#include "../theme.h"
#include "../session_state.generated.h"

#include <Adafruit_NeoPixel.h>
#include <Arduino.h>
#include <math.h>

static Adafruit_NeoPixel s_ring(BOARD_WS2812_COUNT, BOARD_PIN_WS2812,
                                NEO_GRB + NEO_KHZ800);

// Base intensity — the ring is inches from the user's hand; full WS2812
// brightness is blinding and pointless.
static constexpr uint8_t BASE_SCALE = 40;    // /255
static constexpr uint8_t DIMMED_SCALE = 10;  // unselected sessions in detail

static uint32_t scaleColor(uint32_t rgb, uint8_t scale) {
    uint8_t r = (uint8_t)(((rgb >> 16) & 0xFF) * scale / 255);
    uint8_t g = (uint8_t)(((rgb >> 8) & 0xFF) * scale / 255);
    uint8_t b = (uint8_t)((rgb & 0xFF) * scale / 255);
    return Adafruit_NeoPixel::Color(r, g, b);
}

// Session state palette (DESIGN.md §2.7, generated); "error" keeps failure red.
static uint32_t stateColor(const char* state) {
    if (strcmp(state, "error") == 0) return Theme::StatusRed;
    return SessionState::color(state);
}

namespace Ring {

void init() {
    s_ring.begin();
    s_ring.clear();
    s_ring.show();
}

void update(uint32_t nowMs, int selectedIdx, bool connected, bool dark) {
    if (dark) {
        s_ring.clear();
        s_ring.show();
        return;
    }
    // Snapshot under lock — WS2812 show() must not run while holding the mutex.
    uint8_t count;
    char states[BOARD_WS2812_COUNT][20];
    lockState();
    count = g_state.sessionCount;
    if (count > BOARD_WS2812_COUNT) count = BOARD_WS2812_COUNT;
    for (uint8_t i = 0; i < count; i++) {
        strncpy(states[i], g_state.sessions[i].state, sizeof(states[i]) - 1);
        states[i][sizeof(states[i]) - 1] = '\0';
    }
    unlockState();

    // Amber pulse phase — the one permitted animation.
    float pulse = 0.55f + 0.45f * sinf((float)nowMs / 350.0f);

    s_ring.clear();
    if (!connected) {
        // Connectivity is informational, not attention: keep it static so
        // amber response-waits remain the ring's only animation.
        s_ring.setPixelColor(0, scaleColor(Theme::SessionOffline, DIMMED_SCALE));
    } else {
        for (uint8_t i = 0; i < count; i++) {
            uint32_t rgb = stateColor(states[i]);
            uint8_t scale = BASE_SCALE;
            if (selectedIdx >= 0) {
                scale = (i == (uint8_t)selectedIdx) ? BASE_SCALE : DIMMED_SCALE;
            }
            bool awaiting = strstr(states[i], "awaiting") != nullptr;
            if (awaiting) scale = (uint8_t)(scale * pulse) + 8;
            s_ring.setPixelColor(i, scaleColor(rgb, scale));
        }
    }
    s_ring.show();
}

}  // namespace Ring

#endif  // BOARD_T_EMBED
