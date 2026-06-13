#ifdef BOARD_LED8X32
#include "matrix_display.h"
#include "matrix_pages.h"
#include "matrix_buttons.h"
#include "config.h"
#include "state/agent_state.h"
#include "../../../boards/board_config.h"
#include <Arduino.h>
#include <FastLED.h>
#include "net/serial_client.h"

extern DashboardState g_state;

namespace Matrix {

static CRGB leds[MATRIX_LEDS];
// Boot onto AGENTS, not USAGE. USAGE is gated by `hasUsageData()` below — an
// empty USAGE page shows "---" which is awkward for the user's first glance.
// Once usage data arrives, `autoCycle` will rotate to USAGE naturally.
static Page currentPage = Page::AGENTS;
static float animTime = 0.0f;
static bool autoCycle = true;
static float pageCycleTimer = 0.0f;

/// True when the daemon has pushed at least one rate-limit sample. Sentinel
/// `-1.0f` on `fiveHourPercent` means "no data" — when that's the case we
/// refuse to navigate to the USAGE page so the matrix stays on a useful
/// screen instead of displaying dashes.
static bool hasUsageData() {
    lockState();
    bool connected = g_state.wsConnected || Net::serialConnected();
    bool has = connected && (g_state.fiveHourPercent >= 0.0f || g_state.sevenDayPercent >= 0.0f);
    unlockState();
    return has;
}

/// Advance `currentPage` to the next non-empty page. With only USAGE +
/// AGENTS, this is "skip USAGE when empty, otherwise alternate". Extended
/// to safely handle future pages by looping until a renderable page is
/// found, capped by PAGE_COUNT iterations to avoid infinite loops.
static Page skipEmpty(Page p) {
    const uint8_t count = static_cast<uint8_t>(Page::PAGE_COUNT);
    for (uint8_t i = 0; i < count; i++) {
        if (p == Page::USAGE && !hasUsageData()) {
            p = static_cast<Page>((static_cast<uint8_t>(p) + 1) % count);
            continue;
        }
        return p;
    }
    return p;
}
float smoothBrightness = MATRIX_BRIGHTNESS_DEF;  // non-static: accessed by matrix_pages

void init() {
    FastLED.addLeds<WS2812B, BOARD_PIN_LED_DATA, GRB>(leds, MATRIX_LEDS);
    FastLED.setBrightness(MATRIX_BRIGHTNESS_DEF);
    // Disable FastLED temporal dithering. Dithering toggles low bits across frames
    // to fake intermediate brightness, but that requires a very high, steady refresh
    // rate. At ~30fps with a continuously LDR-adjusted brightness (<255), it shows up
    // as visible shimmer/noise on dim pixels. Off = stable pixels (imperceptible color
    // loss at brightness <=120 on an 8x32 matrix).
    FastLED.setDither(DISABLE_DITHER);
    FastLED.setMaxRefreshRate(30);
    fill_solid(leds, MATRIX_LEDS, CRGB::Black);
    FastLED.show();
    MatrixButtons::init();
    pinMode(BOARD_PIN_LIGHT_SENSOR, INPUT);
    Serial.println("[Matrix] LED matrix initialized (32x8, 256 LEDs)");
}

void nextPage() {
    const uint8_t count = static_cast<uint8_t>(Page::PAGE_COUNT);
    Page next = static_cast<Page>((static_cast<uint8_t>(currentPage) + 1) % count);
    currentPage = skipEmpty(next);
    pageCycleTimer = 0.0f;
    MatrixButtons::beep(30);
}

void prevPage() {
    const uint8_t count = static_cast<uint8_t>(Page::PAGE_COUNT);
    Page prev = static_cast<Page>((static_cast<uint8_t>(currentPage) + count - 1) % count);
    currentPage = skipEmpty(prev);
    pageCycleTimer = 0.0f;
    MatrixButtons::beep(30);
}

void actionPress() {
    autoCycle = !autoCycle;
    MatrixButtons::beep(autoCycle ? 30 : 80);
}

static void updateBrightness() {
    // Median-of-5 on the raw LDR before mapping — a single noisy ADC spike
    // otherwise propagates through the EMA into a visible brightness flicker.
    static int ldrBuf[5] = {0};
    static uint8_t ldrIdx = 0;
    static bool ldrFilled = false;
    ldrBuf[ldrIdx] = analogRead(BOARD_PIN_LIGHT_SENSOR);
    ldrIdx = (ldrIdx + 1) % 5;
    if (ldrIdx == 0) ldrFilled = true;
    int sorted[5];
    int n = ldrFilled ? 5 : ldrIdx;  // before the ring fills, median over what we have
    if (n == 0) n = 1;
    for (int i = 0; i < n; i++) sorted[i] = ldrBuf[i];
    for (int i = 1; i < n; i++) {    // insertion sort (n<=5)
        int v = sorted[i], j = i - 1;
        while (j >= 0 && sorted[j] > v) { sorted[j + 1] = sorted[j]; j--; }
        sorted[j + 1] = v;
    }
    int raw = sorted[n / 2];

    static uint32_t lastDebugMs = 0;
    uint32_t now = millis();
    if (now - lastDebugMs >= 5000) {
        lastDebugMs = now;
        Serial.printf("[Matrix] LDR raw=%d brightness=%.0f\n", raw, smoothBrightness);
    }
    float target = (float)map(constrain(raw, 300, 2800), 300, 2800,
                              MATRIX_BRIGHTNESS_MIN, MATRIX_BRIGHTNESS_MAX);
    smoothBrightness = smoothBrightness * 0.85f + target * 0.15f;
    // Re-apply every cycle (cheap — setBrightness only sets a scale, show() pushes).
    // Unconditional so it also restores after the display-off dim override in render().
    // The median filter above keeps the value stable, so no flicker without dithering.
    FastLED.setBrightness((uint8_t)(smoothBrightness + 0.5f));
}

void update(float dt) {
    animTime += dt;
    uint32_t nowMs = millis();

    MatrixButtons::update(nowMs);

    auto leftPress = MatrixButtons::getPress(MatrixButtons::Button::LEFT);
    auto midPress  = MatrixButtons::getPress(MatrixButtons::Button::MID);
    auto rightPress = MatrixButtons::getPress(MatrixButtons::Button::RIGHT);

    if (leftPress == MatrixButtons::Press::SHORT) prevPage();
    if (rightPress == MatrixButtons::Press::SHORT) nextPage();
    if (midPress == MatrixButtons::Press::SHORT) actionPress();
    if (midPress == MatrixButtons::Press::LONG) {
        autoCycle = !autoCycle;
        MatrixButtons::beep(autoCycle ? 30 : 80);
    }

    if (autoCycle) {
        pageCycleTimer += dt;
        if (pageCycleTimer >= PAGE_AUTO_CYCLE_MS / 1000.0f) {
            pageCycleTimer = 0.0f;
            const uint8_t count = static_cast<uint8_t>(Page::PAGE_COUNT);
            Page next = static_cast<Page>((static_cast<uint8_t>(currentPage) + 1) % count);
            currentPage = skipEmpty(next);
        }
    }

    static uint32_t lastBrightnessMs = 0;
    if (nowMs - lastBrightnessMs >= 500) {
        lastBrightnessMs = nowMs;
        updateBrightness();
    }
}

void render() {
    fill_solid(leds, MATRIX_LEDS, CRGB::Black);

    switch (currentPage) {
        case Page::USAGE:  MatrixPages::renderUsage(leds, animTime);  break;
        case Page::AGENTS: MatrixPages::renderAgents(leds, animTime); break;
        default: break;
    }

    lockState();
    bool displayOn = g_state.hostDisplayOn;
    bool dimEnabled = g_state.hostDimEnabled;
    uint8_t dimMode = g_state.hostDimMode;
    uint8_t dimLevel = g_state.hostDimLevel;
    unlockState();
    if (!displayOn && dimEnabled) {
        if (dimMode == 1) {
            // Minimum brightness — keep the frame, drop the driver brightness.
            // The next render resets brightness, so this auto-restores on wake.
            FastLED.setBrightness(dimLevel);
        } else {
            fill_solid(leds, MATRIX_LEDS, CRGB::Black);  // full-off
        }
    }

    FastLED.show();
}

} // namespace Matrix
#endif // BOARD_LED8X32
