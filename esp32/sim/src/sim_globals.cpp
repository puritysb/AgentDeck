// Host-side definitions for firmware globals that live in main.cpp / display.cpp
// on-device (which the sim does not compile), plus the Arduino shim's Serial and
// deterministic random() backing.
#include <Arduino.h>
#include <lvgl.h>
#include <FastLED.h>
#include <WiFi.h>
#include "config.h"
#include "state/agent_state.h"

// Korean-fallback label font. On-device (display.cpp) this is a RAM copy of
// lv_font_montserrat_12 with a Noto Sans KR fallback pointer; the sim bundles
// the same Noto KR faces (fonts/font_noto_kr_*.c) so 한글 labels render exactly
// as the panel does instead of degrading to .notdef boxes.
// Guarded out for the non-LVGL boards (inkdeck = Adafruit GFX direct-draw,
// led8x32 = raw matrix): their build filters exclude fonts/, so referencing the
// Noto face here is an undefined symbol at link.
#if !defined(BOARD_INKDECK) && !defined(BOARD_LED8X32)
extern "C" const lv_font_t font_noto_kr_12;
lv_font_t font_kr_12 = lv_font_montserrat_12;
// Which larger Korean-safe faces exist is a per-board contract declared in
// ui/display.h — mirror that condition exactly, or the board's UI references a
// face this file never defined (T-Embed/T-Display-Pro use font_kr_16 too).
#if defined(BOARD_IPS10) || defined(BOARD_T_EMBED) || defined(BOARD_T_DISPLAY_PRO)
// Latin renders from Montserrat at size; 한글 falls back to the 16px Noto face
// — same chain as the device (display.cpp).
extern "C" const lv_font_t font_noto_kr_16;
lv_font_t font_kr_16 = lv_font_montserrat_16;
#endif
#if defined(BOARD_IPS10)
lv_font_t font_kr_20 = lv_font_montserrat_20;
#endif
static struct KrFontInit {
    KrFontInit() {
        font_kr_12.fallback = &font_noto_kr_12;
#if defined(BOARD_IPS10) || defined(BOARD_T_EMBED) || defined(BOARD_T_DISPLAY_PRO)
        font_kr_16.fallback = &font_noto_kr_16;
#endif
#if defined(BOARD_IPS10)
        font_kr_20.fallback = &font_noto_kr_16;
#endif
    }
} s_krFontInit;
#endif

// Firmware state singletons (defined in main.cpp on-device).
DashboardState g_state;
SemaphoreHandle_t g_stateMutex = (SemaphoreHandle_t)1;

// Runtime screen dimensions (defined in display.cpp on-device). Seeded from the
// board's SCREEN_W/SCREEN_H build flags.
int16_t g_screenW = SCREEN_W;
int16_t g_screenH = SCREEN_H;

// Arduino shim backing.
unsigned long g_sim_millis = 0;
SimSerial Serial;

// Deterministic PRNG (xorshift32) so successive runs produce identical frames.
static uint32_t s_rng = 0x1234567u;
void randomSeed(unsigned long seed) { s_rng = seed ? (uint32_t)seed : 1u; }
static uint32_t rngNext() {
  s_rng ^= s_rng << 13; s_rng ^= s_rng >> 17; s_rng ^= s_rng << 5;
  return s_rng;
}
long arduino_random(long howbig) {
  if (howbig <= 0) return 0;
  return (long)(rngNext() % (uint32_t)howbig);
}
long arduino_random(long howsmall, long howbig) {
  if (howbig <= howsmall) return howsmall;
  return howsmall + arduino_random(howbig - howsmall);
}

// ── Net / device-status shims ────────────────────────────────────────────────
// Scenes render as an online device (serial + WiFi connected). Definitions back
// the sim/shims/net/*.h declarations.
namespace Net {
bool serialConnected() { return true; }
void serialWriteJsonLine(const char*) {}
bool wifiConnected() { return true; }
const char* wifiLocalIP() { return "192.168.1.42"; }
void queueOutbound(const char*) {}
}  // namespace Net

// ── Companion-board device state (T-Embed knob, T-Display-Pro strip) ─────────
// Those two UIs draw a live link chip and a battery cluster, so the sim has to
// answer for them the way an online, USB-powered unit would — otherwise the
// frame shows the disconnected/no-battery layout, which is not what the board
// looks like in use.
#if defined(BOARD_T_EMBED) || defined(BOARD_T_DISPLAY_PRO)
#include "net/ws_client.h"
#include "input/power_monitor.h"
namespace Net {
bool wsConnected() { return true; }
}  // namespace Net
namespace Input {
PowerStatus powerStatus() {
  PowerStatus s{};
  s.valid = true;
  s.soc = 82;
  s.voltageMv = 3980;
  s.usbPowered = true;
  s.charging = true;
  return s;
}
}  // namespace Input
#endif

// ── T-Display-S3-Pro camera shield (camera/photo_capture.cpp on-device) ─────
// The sim renders the bare unit — `present()` false, so the strip keeps its
// three pages and never grows CAM. A camera page here could only show a fake
// preview, which is exactly what this simulator exists to avoid.
#if defined(BOARD_T_DISPLAY_PRO)
#include "camera/photo_capture.h"
namespace Camera {
bool present() { return false; }
bool acquire() { return false; }
void release() {}
bool active() { return false; }
bool grabPreview(uint16_t*, int, int) { return false; }
bool captureJpeg(uint8_t**, size_t*, int*, int*) { return false; }
void setLamp(uint8_t) {}
uint8_t lampDuty() { return 0; }
}  // namespace Camera
namespace Net {
bool photoUploadBusy() { return false; }
bool queuePhotoUpload(uint8_t*, size_t, const char*, int, int) { return false; }
bool queuePhotoHttpUpload(uint8_t*, size_t, const char*, int, int) { return false; }
}  // namespace Net
#endif

// ── Audio shims (defined in audio/mic_capture.cpp on-device) ────────────────
// Mic-ready but never capturing: the PTT control renders in its resting state.
namespace Audio {
bool micInit() { return true; }
bool micReady() { return true; }
bool micCapturing() { return false; }
uint32_t micElapsedMs(uint32_t) { return 0; }
void micStart(const char*) {}
void micPump() {}
void micStop(bool) {}
// Press/sent feedback tone (audio/speaker_playback.cpp on-device). Silent here;
// it is referenced from the voice control's event callbacks, which the sim
// still has to link even though it never dispatches an input event.
void playTone(uint32_t, uint32_t, float) {}
}  // namespace Audio

// ── ES8311 codec shims (audio/es8311_codec.cpp on-device) ───────────────────
// The IPS10 voice banner's volume steppers read and write the codec level. The
// host has no codec, so keep a plain value: the control renders its real label
// instead of a placeholder.
#include "../../boards/board_config.h"   // defines BOARD_SPK_CODEC_ES8311
#if defined(BOARD_SPK_CODEC_ES8311)
namespace Es8311 {
static int s_volume = 70;
int volume() { return s_volume; }
void setVolume(int percent) {
  s_volume = percent < 0 ? 0 : (percent > 100 ? 100 : percent);
}
}  // namespace Es8311
#endif

// ── Display accessors (defined in display.cpp on-device) ─────────────────────
// The HUD queries orientation; the sim has no runtime rotation, so derive it
// from the compile-time screen dimensions.
namespace UI {
bool isLandscape() { return g_screenW >= g_screenH; }
void setBrightness(int) {}   // no backlight on host
}  // namespace UI

// ── TC001 matrix backing (defined in matrix_display.cpp on-device) ───────────
// The sim drives MatrixPages::render* directly, so it owns this global instead.
namespace Matrix { float smoothBrightness = 80.0f; }

// ── FastLED / WiFi shim instances ────────────────────────────────────────────
const CRGB CRGB::Black = CRGB(0, 0, 0);
SimFastLED FastLED;
SimWiFiClass WiFi;
