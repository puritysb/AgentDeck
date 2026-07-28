#include "photo_capture.h"
#include "../../boards/board_config.h"

#if defined(BOARD_T_DISPLAY_PRO) && defined(BOARD_HAS_DVP_CAMERA)

#include <Arduino.h>
#include <Wire.h>
#include <Preferences.h>
#include <esp_camera.h>
#include <img_converters.h>

// HVGA RGB565: the sensor's native-ish working size. 480 wide matches the
// panel exactly; the 2:1 downscaled viewfinder (240x160) shows the full frame.
static constexpr framesize_t FRAME_SIZE = FRAMESIZE_HVGA;  // 480x320
static constexpr int FRAME_W = 480;
static constexpr int FRAME_H = 320;
// frame2jpg quality (0-100, higher = better). 80 lands a GC0308 HVGA frame
// around 30-60 KB — seconds over either transport.
static constexpr int JPEG_QUALITY = 80;

static bool s_present = false;
static bool s_active = false;
static uint8_t s_lampDuty = 0;

// Driver bring-up shared by the boot probe and every CAM-page entry.
static esp_err_t startDriver() {
    // SCCB must ride the I2C port Wire already owns (touch + PMU + ALS live
    // there). Passing the pins instead would install a second driver on the
    // same GPIOs — the classic shared-bus fight the vendor example sidesteps
    // only by putting SCCB on the other controller.
    Wire.begin(BOARD_PIN_I2C_SDA, BOARD_PIN_I2C_SCL);  // idempotent

    camera_config_t cfg = {};
    cfg.ledc_channel = LEDC_CHANNEL_0;
    cfg.ledc_timer = LEDC_TIMER_0;
    cfg.pin_d0 = BOARD_CAM_PIN_Y2;
    cfg.pin_d1 = BOARD_CAM_PIN_Y3;
    cfg.pin_d2 = BOARD_CAM_PIN_Y4;
    cfg.pin_d3 = BOARD_CAM_PIN_Y5;
    cfg.pin_d4 = BOARD_CAM_PIN_Y6;
    cfg.pin_d5 = BOARD_CAM_PIN_Y7;
    cfg.pin_d6 = BOARD_CAM_PIN_Y8;
    cfg.pin_d7 = BOARD_CAM_PIN_Y9;
    cfg.pin_xclk = BOARD_CAM_PIN_XCLK;
    cfg.pin_pclk = BOARD_CAM_PIN_PCLK;
    cfg.pin_vsync = BOARD_CAM_PIN_VSYNC;
    cfg.pin_href = BOARD_CAM_PIN_HREF;
    cfg.pin_sccb_sda = -1;                 // reuse Wire's port, don't re-drive the pins
    cfg.pin_sccb_scl = -1;
    cfg.sccb_i2c_port = 0;                 // Arduino Wire = I2C port 0
    cfg.pin_pwdn = BOARD_CAM_PIN_PWDN;
    cfg.pin_reset = BOARD_CAM_PIN_RESET;
    cfg.xclk_freq_hz = 20000000;
    cfg.pixel_format = PIXFORMAT_RGB565;   // GC0308 has no JPEG engine
    cfg.frame_size = FRAME_SIZE;
    cfg.jpeg_quality = 12;                 // unused for RGB565, required field
    cfg.fb_count = 2;
    cfg.fb_location = CAMERA_FB_IN_PSRAM;
    cfg.grab_mode = CAMERA_GRAB_LATEST;    // viewfinder wants fresh, not queued

    esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) return err;
    sensor_t* s = esp_camera_sensor_get();
    if (s && s->id.PID == GC0308_PID) {
        s->set_vflip(s, 0);
        s->set_hmirror(s, 0);
    }
    return ESP_OK;
}

namespace Camera {

bool init() {
    // Probe only: bring the driver up to identify the sensor, then shut it
    // straight back down. Keeping the sensor + 20 MHz XCLK powered around the
    // clock tripped the brownout detector the moment WiFi TX started (the
    // "E BOD" reboot loop this replaced) — the camera draws power only while
    // the CAM page is open (acquire/release).
    esp_err_t err = startDriver();
    if (err != ESP_OK) {
        Serial.printf("[Camera] probe failed (0x%x) — no shield or bus fault; CAM page disabled\n", err);
        s_present = false;
        return false;
    }
    sensor_t* s = esp_camera_sensor_get();
    if (s) {
        camera_sensor_info_t* info = esp_camera_sensor_get_info(&s->id);
        Serial.printf("[Camera] ready: %s (PID 0x%x)\n",
                      info ? info->name : "unknown sensor", s->id.PID);
    }
    esp_camera_deinit();
    // Illumination LED parked off; PWM-attached so the CAM page can pulse it.
    ledcAttach(BOARD_CAM_PIN_LED, 1000, 8);
    ledcWrite(BOARD_CAM_PIN_LED, 0);
    s_present = true;
    return true;
}

bool present() { return s_present; }

bool acquire() {
    if (!s_present) return false;
    if (s_active) return true;
    esp_err_t err = startDriver();
    if (err != ESP_OK) {
        Serial.printf("[Camera] acquire failed (0x%x)\n", err);
        return false;
    }
    s_active = true;
    return true;
}

void release() {
    if (!s_active) return;
    setLamp(0);
    esp_camera_deinit();
    s_active = false;
}

bool active() { return s_active; }

bool grabPreview(uint16_t* dst, int dstW, int dstH) {
    if (!s_active || !dst) return false;
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) return false;
    if (fb->format != PIXFORMAT_RGB565 ||
        (int)fb->width < dstW * 2 || (int)fb->height < dstH * 2) {
        esp_camera_fb_return(fb);
        return false;
    }
    // 2:1 decimation, centered — the viewfinder is the whole frame, so what
    // the user framed is exactly what the daemon receives. Camera memory is
    // big-endian RGB565 (the frame2jpg converter's documented contract);
    // byte-swap to little-endian for the LV_COLOR_FORMAT_RGB565 canvas and
    // let LVGL's own dest-format conversion handle the swapped display.
    const uint16_t* src = (const uint16_t*)fb->buf;
    int x0 = ((int)fb->width - dstW * 2) / 2;
    int y0 = ((int)fb->height - dstH * 2) / 2;
    for (int y = 0; y < dstH; y++) {
        const uint16_t* row = src + (size_t)(y0 + y * 2) * fb->width + x0;
        uint16_t* out = dst + (size_t)y * dstW;
        for (int x = 0; x < dstW; x++) out[x] = __builtin_bswap16(row[x * 2]);
    }
    esp_camera_fb_return(fb);
    return true;
}

// Sensor-to-panel rotation for the portrait pose: 180°, established on
// hardware by cycling it on the viewfinder (2026-07-27). Not a guess and not
// a user setting — the shield's mounting is fixed, so this is a board fact.
static constexpr uint8_t CAM_PORTRAIT_ROT = 2;

uint8_t rotationIndex() { return CAM_PORTRAIT_ROT; }

// Upright frame dimensions for a rotation index.
static inline void uprightDims(int sw, int sh, uint8_t rot, int* uw, int* uh) {
    if (rot & 1) { *uw = sh; *uh = sw; }
    else         { *uw = sw; *uh = sh; }
}

// Map an upright-space coordinate back to the sensor buffer.
static inline void uprightToSrc(int ux, int uy, int sw, int sh, uint8_t rot,
                                int* sx, int* sy) {
    switch (rot & 3) {
        case 0:  *sx = ux;              *sy = uy;              break;
        case 1:  *sx = uy;              *sy = sh - 1 - ux;     break;  // 90° CW
        case 2:  *sx = sw - 1 - ux;     *sy = sh - 1 - uy;     break;
        default: *sx = sw - 1 - uy;     *sy = ux;              break;  // 270° CW
    }
}

bool grabPreviewPortrait(uint16_t* dst, int dstW, int dstH) {
    if (!s_active || !dst) return false;
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) return false;
    if (fb->format != PIXFORMAT_RGB565) { esp_camera_fb_return(fb); return false; }
    const uint16_t* src = (const uint16_t*)fb->buf;
    int sw = fb->width, sh = fb->height;
    uint8_t rot = rotationIndex();
    int uw, uh;
    uprightDims(sw, sh, rot, &uw, &uh);
    // Centre-crop the upright frame to the viewfinder's aspect, then sample.
    int cropW = uw, cropH = uh;
    if ((long)uw * dstH > (long)uh * dstW) cropW = (int)((long)uh * dstW / dstH);
    else                                   cropH = (int)((long)uw * dstH / dstW);
    int offX = (uw - cropW) / 2, offY = (uh - cropH) / 2;
    for (int y = 0; y < dstH; y++) {
        uint16_t* outRow = dst + (size_t)y * dstW;
        int uy = offY + (int)((long)y * cropH / dstH);
        for (int x = 0; x < dstW; x++) {
            int ux = offX + (int)((long)x * cropW / dstW);
            int sx, sy;
            uprightToSrc(ux, uy, sw, sh, rot, &sx, &sy);
            // bswap for the little-endian canvas (see grabPreview).
            outRow[x] = __builtin_bswap16(src[(size_t)sy * sw + sx]);
        }
    }
    esp_camera_fb_return(fb);
    return true;
}

bool captureJpegPortrait(uint8_t** out, size_t* outLen, int* width, int* height) {
    if (!s_active || !out || !outLen) return false;
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) return false;
    if (fb->format != PIXFORMAT_RGB565) { esp_camera_fb_return(fb); return false; }
    int sw = fb->width, sh = fb->height;
    uint8_t rot = rotationIndex();
    int dw, dh;
    uprightDims(sw, sh, rot, &dw, &dh);   // whole frame, no crop
    uint16_t* rotBuf = (uint16_t*)heap_caps_malloc((size_t)dw * dh * 2, MALLOC_CAP_SPIRAM);
    if (!rotBuf) { esp_camera_fb_return(fb); return false; }
    const uint16_t* src = (const uint16_t*)fb->buf;
    // Keep camera byte order — fmt2jpg's RGB565 contract is big-endian.
    for (int y = 0; y < dh; y++) {
        uint16_t* outRow = rotBuf + (size_t)y * dw;
        for (int x = 0; x < dw; x++) {
            int sx, sy;
            uprightToSrc(x, y, sw, sh, rot, &sx, &sy);
            outRow[x] = src[(size_t)sy * sw + sx];
        }
    }
    esp_camera_fb_return(fb);
    *out = nullptr;
    *outLen = 0;
    bool ok = fmt2jpg((uint8_t*)rotBuf, (size_t)dw * dh * 2, dw, dh,
                      PIXFORMAT_RGB565, JPEG_QUALITY, out, outLen);
    free(rotBuf);
    if (width) *width = dw;
    if (height) *height = dh;
    if (!ok || !*out || *outLen == 0) {
        Serial.println("[Camera] portrait JPEG encode failed");
        if (*out) { free(*out); *out = nullptr; }
        return false;
    }
    return true;
}

bool captureJpeg(uint8_t** out, size_t* outLen, int* width, int* height) {
    if (!s_active || !out || !outLen) return false;
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) return false;
    *out = nullptr;
    *outLen = 0;
    bool ok = frame2jpg(fb, JPEG_QUALITY, out, outLen);
    if (width) *width = fb->width;
    if (height) *height = fb->height;
    esp_camera_fb_return(fb);
    if (!ok || !*out || *outLen == 0) {
        Serial.println("[Camera] JPEG encode failed");
        if (*out) { free(*out); *out = nullptr; }
        return false;
    }
    return true;
}

void setLamp(uint8_t duty) {
    if (!s_present) return;
    if (duty > 0 && !s_active) return;  // lamp follows the camera session
    s_lampDuty = duty;
    ledcWrite(BOARD_CAM_PIN_LED, duty);
}

uint8_t lampDuty() { return s_lampDuty; }

}  // namespace Camera

#else  // stubs for boards without a DVP camera

namespace Camera {
bool init() { return false; }
bool present() { return false; }
bool acquire() { return false; }
void release() {}
bool active() { return false; }
bool grabPreview(uint16_t*, int, int) { return false; }
bool grabPreviewPortrait(uint16_t*, int, int) { return false; }
bool captureJpeg(uint8_t**, size_t*, int*, int*) { return false; }
bool captureJpegPortrait(uint8_t**, size_t*, int*, int*) { return false; }
uint8_t rotationIndex() { return 0; }
void setLamp(uint8_t) {}
uint8_t lampDuty() { return 0; }
}  // namespace Camera

#endif
