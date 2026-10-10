#if defined(BOARD_T_DISPLAY_PRO) || defined(BOARD_LILYGO_EPD47)

#include "touch_strip.h"
#include "../../boards/board_config.h"

#include <Arduino.h>
#include <Wire.h>
#if defined(BOARD_LILYGO_EPD47)
#include <touch.h>
#include <TouchDrvGT911.hpp>
#else
#include <TouchDrvCSTXXX.hpp>
#endif

#ifndef CST226SE_SLAVE_ADDRESS
#define CST226SE_SLAVE_ADDRESS 0x5A
#endif

#if defined(BOARD_LILYGO_EPD47)
static TouchClass s_legacyTouch;
static TouchDrvGT911 s_gtTouch;
enum class EpdTouchController : uint8_t { NONE = 0, GT911, LEGACY_5A };
static EpdTouchController s_epdController = EpdTouchController::NONE;
static uint8_t s_touchAddress = 0;
static uint8_t s_i2cDeviceCount = 0;
static bool s_rtcSeen = false;
#else
static TouchDrvCSTXXX s_touch;
#endif
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

static constexpr uint32_t TAP_MAX_MS =
#if defined(BOARD_LILYGO_EPD47)
    // The e-ink UI samples touch every 25 ms between paints, but a release
    // that lands during a 1-2 s panel update is only seen after it; keep the
    // window forgiving so a slow tap across a paint still counts.
    850;
#else
    450;
#endif
static constexpr uint32_t HOLD_MS = 700;
static constexpr int16_t SWIPE_MIN_PX = 55;

struct LandscapePoint {
    int16_t x;
    int16_t y;
};

// Map the controller's native 222x480 portrait coordinates into the current
// 480x222 Focus Strip rotation. Keeping this tied to BOARD_ROTATION prevents a
// display-only 180-degree change from silently reversing taps and swipes.
static constexpr LandscapePoint mapLandscapePoint(int16_t x, int16_t y) {
#if defined(BOARD_LILYGO_EPD47)
    // SensorLib first applies the vendor's native portrait->landscape mapping
    // (swap XY, mirror Y). The owned panel's framebuffer is then presented at
    // rotation 2, so touch must follow the same final 180-degree transform.
    return {(int16_t)(SCREEN_W - 1 - x), (int16_t)(SCREEN_H - 1 - y)};
#elif BOARD_ROTATION == 1
    return {y, (int16_t)(BOARD_NATIVE_W - 1 - x)};
#elif BOARD_ROTATION == 3
    return {(int16_t)(BOARD_NATIVE_H - 1 - y), x};
#else
#error "T-Display-S3-Pro Focus Strip requires landscape rotation 1 or 3"
#endif
}

#if BOARD_ROTATION == 3
static_assert(mapLandscapePoint(0, 0).x == BOARD_NATIVE_H - 1 &&
              mapLandscapePoint(0, 0).y == 0,
              "rotation-3 top-left touch mapping drifted");
static_assert(mapLandscapePoint(BOARD_NATIVE_W - 1, BOARD_NATIVE_H - 1).x == 0 &&
              mapLandscapePoint(BOARD_NATIVE_W - 1, BOARD_NATIVE_H - 1).y == BOARD_NATIVE_W - 1,
              "rotation-3 bottom-right touch mapping drifted");
#endif

namespace Input {

bool touchInit() {
#if defined(BOARD_LILYGO_EPD47)
    // EPD47 revisions exist with the current GT911 (0x14/0x5D), while the
    // pinned panel library still carries its older 0x5A D0-register driver.
    // Probe before constructing a live driver so a missing touch daughterboard
    // remains diagnosable without repeatedly allocating SensorLib state.
    Wire.begin(BOARD_PIN_I2C_SDA, BOARD_PIN_I2C_SCL);
    pinMode(BOARD_PIN_TOUCH_INT, OUTPUT);
    digitalWrite(BOARD_PIN_TOUCH_INT, HIGH);
    // The vendor requires a one-second settle after a sleep wake. Doing it on
    // every boot is harmless and also covers a controller that retained sleep
    // while the ESP32 itself reset.
    delay(1000);

    // Three bounded passes distinguish a slow wake from a missing controller.
    // No String/vector: this runs while internal RAM is under peak boot load.
    bool seen[0x78] = {false};
    for (uint8_t pass = 0; pass < 3; ++pass) {
        for (uint8_t address = 0x08; address < 0x78; ++address) {
            Wire.beginTransmission(address);
            if (Wire.endTransmission() == 0 && !seen[address]) {
                seen[address] = true;
                ++s_i2cDeviceCount;
                Serial.printf("[Touch] I2C device 0x%02x\n", address);
            }
        }
        if (seen[0x14] || seen[0x5D] || seen[TOUCH_SLAVE_ADDRESS]) break;
        delay(250);
    }
    if (!seen[0x14] && !seen[0x5D] && !seen[TOUCH_SLAVE_ADDRESS]) {
        // An ESP-only reset can leave a separately powered GT911 asleep while
        // INT remains passively high. Create the wake edge explicitly, then
        // perform one final address pass before declaring hardware absent.
        digitalWrite(BOARD_PIN_TOUCH_INT, LOW);
        delay(20);
        digitalWrite(BOARD_PIN_TOUCH_INT, HIGH);
        delay(100);
        for (uint8_t address = 0x08; address < 0x78; ++address) {
            Wire.beginTransmission(address);
            if (Wire.endTransmission() == 0 && !seen[address]) {
                seen[address] = true;
                ++s_i2cDeviceCount;
                Serial.printf("[Touch] I2C device after wake 0x%02x\n", address);
            }
        }
    }
    s_rtcSeen = seen[0x51];

    if (seen[0x14] || seen[0x5D]) {
        s_touchAddress = seen[0x14] ? 0x14 : 0x5D;
        s_gtTouch.setPins(BOARD_PIN_TOUCH_RST, BOARD_PIN_TOUCH_INT);
        s_enabled = s_gtTouch.begin(Wire, s_touchAddress,
                                    BOARD_PIN_I2C_SDA, BOARD_PIN_I2C_SCL);
        if (s_enabled) {
            s_gtTouch.setMaxCoordinates(SCREEN_W, SCREEN_H);
            s_gtTouch.setSwapXY(true);
            s_gtTouch.setMirrorXY(false, true);
            s_epdController = EpdTouchController::GT911;
            Serial.printf("[Touch] GT911 0x%02x ready\n", s_touchAddress);
        }
    } else if (seen[TOUCH_SLAVE_ADDRESS]) {
        s_touchAddress = TOUCH_SLAVE_ADDRESS;
        s_enabled = s_legacyTouch.begin(Wire, s_touchAddress);
        if (s_enabled) {
            s_epdController = EpdTouchController::LEGACY_5A;
            Serial.printf("[Touch] legacy 0x%02x controller ready\n", s_touchAddress);
        }
    }
    pinMode(BOARD_PIN_TOUCH_INT, INPUT_PULLUP);
    if (!s_enabled) {
        s_touchAddress = 0;
        Serial.printf("[Touch] no supported controller; bus devices=%u rtc=%u — touch disabled\n",
                      s_i2cDeviceCount, s_rtcSeen ? 1 : 0);
    }
#else
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
#endif
    return s_enabled;
}

bool touchReady() {
    return s_enabled;
}

uint8_t touchAddress() {
#if defined(BOARD_LILYGO_EPD47)
    return s_touchAddress;
#else
    return s_enabled ? CST226SE_SLAVE_ADDRESS : 0;
#endif
}

uint8_t touchI2cDeviceCount() {
#if defined(BOARD_LILYGO_EPD47)
    return s_i2cDeviceCount;
#else
    return 0;
#endif
}

bool touchRtcSeen() {
#if defined(BOARD_LILYGO_EPD47)
    return s_rtcSeen;
#else
    return false;
#endif
}

static bool s_portrait = false;
void touchSetPortrait(bool portrait) { s_portrait = portrait; }
bool touchPortrait() { return s_portrait; }

static bool readControllerPoint(int16_t* x, int16_t* y) {
    if (!x || !y) return false;
#if defined(BOARD_LILYGO_EPD47)
    if (s_epdController == EpdTouchController::GT911) {
        int16_t xs[5] = {0}, ys[5] = {0};
        uint8_t supported = s_gtTouch.getSupportTouchPoint();
        if (supported == 0 || supported > 5) supported = 1;
        if (s_gtTouch.getPoint(xs, ys, supported) <= 0) return false;
        *x = xs[0];
        *y = ys[0];
        return true;
    }
    if (s_epdController == EpdTouchController::LEGACY_5A) {
        if (s_legacyTouch.scanPoint() == 0) return false;
        uint16_t rawX = 0, rawY = 0;
        s_legacyTouch.getPoint(rawX, rawY, 0);
        *x = (int16_t)rawX;
        *y = (int16_t)rawY;
        return true;
    }
    return false;
#else
    int16_t xs[5] = {0}, ys[5] = {0};
    uint8_t supported = s_touch.getSupportTouchPoint();
    if (supported == 0 || supported > 5) supported = 1;
    if (s_touch.getPoint(xs, ys, supported) <= 0) return false;
    *x = xs[0];
    *y = ys[0];
    return true;
#endif
}

bool touchRawPoint(int16_t* x, int16_t* y) {
    if (!s_enabled || !x || !y) return false;
    int16_t rawX = 0, rawY = 0;
    if (!readControllerPoint(&rawX, &rawY)) return false;
    s_downSamples++;
    if (rawX > s_maxX) s_maxX = rawX;
    if (rawY > s_maxY) s_maxY = rawY;
#if defined(BOARD_LILYGO_EPD47)
    LandscapePoint mapped = mapLandscapePoint(rawX, rawY);
    rawX = mapped.x;
    rawY = mapped.y;
#endif
    // Native portrait report == rotation-0 display coords (the landscape
    // transform below is the rotation-1 mapping of this same space).
    *x = rawX;
    *y = rawY;
    s_lastGx = rawX;
    s_lastGy = rawY;
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
    int16_t rawX = 0, rawY = 0;
    bool down = readControllerPoint(&rawX, &rawY);
    if (down) {
        s_downSamples++;
        if (rawX > s_maxX) s_maxX = rawX;
        if (rawY > s_maxY) s_maxY = rawY;
        // The CST226SE reports panel-native portrait (222x480); map it through
        // the same landscape rotation as the panel. Without this, a display
        // flip leaves every hit region mirrored and reverses horizontal swipes.
        LandscapePoint mapped = mapLandscapePoint(rawX, rawY);
        rawX = mapped.x;
        rawY = mapped.y;
    }

    if (down && !prevDown) {
        prevDown = true;
        downSince = nowMs;
        holdFired = false;
        startX = lastX = rawX;
        startY = lastY = rawY;
        return event;
    }
    if (down && prevDown) {
        lastX = rawX;
        lastY = rawY;
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

#endif  // BOARD_T_DISPLAY_PRO || BOARD_LILYGO_EPD47
