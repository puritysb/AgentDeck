#if defined(BOARD_T_DISPLAY_PRO)

#include "touch_strip.h"
#include "../../boards/board_config.h"

#include <Arduino.h>
#include <Wire.h>
#include <TouchDrvCSTXXX.hpp>

#ifndef CST226SE_SLAVE_ADDRESS
#define CST226SE_SLAVE_ADDRESS 0x5A
#endif

static TouchDrvCSTXXX s_touch;
static bool s_enabled = false;
// Remote diagnosability (device_info): raw finger-down poll hits vs decoded
// gestures. "All touch dead" splits into chip-silent (samples 0) vs
// gesture-logic (samples grow, gestures 0) without stealing the serial port.
static uint32_t s_downSamples = 0;
static uint32_t s_gestures = 0;
// Coordinate-space forensics: last gesture position and the max raw values
// seen, so a mis-oriented controller is provable from /devices (a portrait
// 222x480 report against the landscape 480x222 UI scrambles every hit region).
static int16_t s_lastGx = -1, s_lastGy = -1;
static int16_t s_maxX = 0, s_maxY = 0;

static constexpr uint32_t TAP_MAX_MS = 450;
static constexpr uint32_t HOLD_MS = 700;
static constexpr int16_t SWIPE_MIN_PX = 55;

namespace Input {

bool touchInit() {
    s_touch.setPins(BOARD_PIN_TOUCH_RST, BOARD_PIN_TOUCH_INT);
    // The controller needs settle time after its reset pulse — retry the
    // probe instead of silently shipping a touchless strip.
    for (int attempt = 0; attempt < 3 && !s_enabled; attempt++) {
        if (attempt > 0) delay(150);
        s_enabled = s_touch.begin(Wire, CST226SE_SLAVE_ADDRESS,
                                  BOARD_PIN_I2C_SDA, BOARD_PIN_I2C_SCL);
    }
    if (!s_enabled) Serial.println("[Touch] CST226SE not answering — touch disabled");
    else Serial.println("[Touch] CST226SE ready");
    return s_enabled;
}

bool touchReady() {
    return s_enabled;
}

static bool s_portrait = false;
void touchSetPortrait(bool portrait) { s_portrait = portrait; }
bool touchPortrait() { return s_portrait; }

bool touchRawPoint(int16_t* x, int16_t* y) {
    if (!s_enabled || !x || !y) return false;
    int16_t xs[5] = {0}, ys[5] = {0};
    uint8_t supported = s_touch.getSupportTouchPoint();
    if (supported == 0 || supported > 5) supported = 1;
    if (s_touch.getPoint(xs, ys, supported) <= 0) return false;
    s_downSamples++;
    if (xs[0] > s_maxX) s_maxX = xs[0];
    if (ys[0] > s_maxY) s_maxY = ys[0];
    // Native portrait report == rotation-0 display coords (the landscape
    // transform below is the rotation-1 mapping of this same space).
    *x = xs[0];
    *y = ys[0];
    s_lastGx = xs[0];
    s_lastGy = ys[0];
    return true;
}

uint32_t touchDownSamples() { return s_downSamples; }
uint32_t touchGestures() { return s_gestures; }
int16_t touchLastX() { return s_lastGx; }
int16_t touchLastY() { return s_lastGy; }
int16_t touchMaxX() { return s_maxX; }
int16_t touchMaxY() { return s_maxY; }

TouchEvent touchPoll(uint32_t nowMs) {
    TouchEvent event = {TouchGesture::NONE, 0, 0};
    if (!s_enabled) return event;

    static bool prevDown = false;
    static uint32_t downSince = 0;
    static bool holdFired = false;
    static int16_t startX = 0, startY = 0, lastX = 0, lastY = 0;

    // Vendor-style read: full point array (some CSTXXX firmwares report 0
    // touched when asked for fewer slots than the chip supports).
    int16_t xs[5] = {0}, ys[5] = {0};
    uint8_t supported = s_touch.getSupportTouchPoint();
    if (supported == 0 || supported > 5) supported = 1;
    bool down = s_touch.getPoint(xs, ys, supported) > 0;
    if (down) {
        s_downSamples++;
        if (xs[0] > s_maxX) s_maxX = xs[0];
        if (ys[0] > s_maxY) s_maxY = ys[0];
        // The CST226SE reports panel-native portrait (222x480); the strip UI
        // is landscape 480x222 (rotation 1). Confirmed by corner forensics:
        // raw (184,16) was a landscape top-left tap, which matches exactly
        // one of the four canonical transforms. Without this, every hit
        // region misfired and horizontal swipes measured the wrong axis.
        int16_t rx = xs[0];
        xs[0] = ys[0];
        ys[0] = (int16_t)(BOARD_NATIVE_W - 1) - rx;
    }

    if (down && !prevDown) {
        prevDown = true;
        downSince = nowMs;
        holdFired = false;
        startX = lastX = xs[0];
        startY = lastY = ys[0];
        return event;
    }
    if (down && prevDown) {
        lastX = xs[0];
        lastY = ys[0];
        if (!holdFired && (uint32_t)(nowMs - downSince) >= HOLD_MS) {
            holdFired = true;
            event = {TouchGesture::HOLD, lastX, lastY};
            return event;
        }
        return event;
    }
    if (!down && prevDown) {
        prevDown = false;
        uint32_t held = nowMs - downSince;
        int16_t dx = lastX - startX;
        int16_t dy = lastY - startY;
        event.x = lastX;
        event.y = lastY;
        if (!holdFired && abs(dx) >= SWIPE_MIN_PX && abs(dx) > abs(dy)) {
            event.gesture = dx < 0 ? TouchGesture::SWIPE_LEFT : TouchGesture::SWIPE_RIGHT;
            s_gestures++;
            return event;
        }
        if (!holdFired && held >= 30 && held < TAP_MAX_MS) {
            event.gesture = TouchGesture::TAP;
            s_gestures++;
            s_lastGx = lastX;
            s_lastGy = lastY;
            return event;
        }
    }
    return event;
}

}  // namespace Input

#endif  // BOARD_T_DISPLAY_PRO
