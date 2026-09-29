#pragma once
// Host shim for <GxEPD2_BW.h>. The e-ink TRMNL 7.5" renders through a GxEPD2_BW
// display object, which is an Adafruit_GFX subclass: all the geometry + text
// primitives come from the *real* vendored Adafruit_GFX (pixel-exact), and this
// shim only supplies drawPixel (into a 1-bit host framebuffer) plus the e-ink
// lifecycle no-ops (init/refresh/power). Panel geometry is the env's SCREEN_W/H:
// TRMNL 7.5"'s real 800×480 UC8179 (GxEPD2_750_GDEY075T7) for the trmnl_75 env, and
// the XTeink panel sizes for the layout-preview envs — the responsive geometry
// SSOT (ui/eink/eink_dashboard_layout.h) is shared with that fork, so rendering
// it at their dimensions is what exercises its non-TRMNL 7.5" density bands.
#include "Adafruit_GFX.h"
#include <cstdlib>
#include <cstring>

#define GxEPD_BLACK 0x0000
#define GxEPD_WHITE 0xFFFF
// The NM preview draws through this shim too (the preview envs define
// BOARD_TRMNL_75 for the render tree while selecting the NM face). Without a
// third ink value the tri-color panel previews as monochrome and no red
// regression is visible in sim-out/.
#define GxEPD_RED   0xF800
// Ink codes stored in the host framebuffer.
static const uint8_t INK_RED = 16;

// Panel descriptor subset — only the geometry + a pin-taking constructor are used.
class GxEPD2_750_GDEY075T7 {
public:
  static const uint16_t WIDTH = SCREEN_W;
  static const uint16_t HEIGHT = SCREEN_H;
  bool hasFastPartialUpdate = true;   // capability flag the firmware reads
  GxEPD2_750_GDEY075T7(int8_t /*cs*/, int8_t /*dc*/, int8_t /*rst*/, int8_t /*busy*/) {}
};

template <typename Panel, uint16_t PageHeight>
class GxEPD2_BW : public Adafruit_GFX {
public:
  Panel epd2;   // panel driver instance (firmware reads its capability flags)
  explicit GxEPD2_BW(Panel p) : Adafruit_GFX(Panel::WIDTH, Panel::HEIGHT), epd2(p) {
    _pw = Panel::WIDTH; _ph = Panel::HEIGHT;
    _buf = static_cast<uint8_t*>(std::malloc((size_t)_pw * _ph));
    if (_buf) std::memset(_buf, 15, (size_t)_pw * _ph);   // 15 = white paper
  }

  // Adafruit_GFX primitives call this with rotation-frame coords; map to the
  // physical buffer. 0 = black ink, 1 = white paper.
  void drawPixel(int16_t x, int16_t y, uint16_t color) override {
    int16_t px = x, py = y;
    switch (getRotation()) {
      case 1: px = _pw - 1 - y; py = x;              break;
      case 2: px = _pw - 1 - x; py = _ph - 1 - y;    break;
      case 3: px = y;           py = _ph - 1 - x;    break;
      default: break;
    }
    if (px < 0 || px >= _pw || py < 0 || py >= _ph || !_buf) return;
    // Ink code: 0..15 = grayscale level (0 black, 15 paper), 16 = red.
    uint8_t ink;
    if (color == GxEPD_RED) {
      ink = INK_RED;
    } else {
      ink = (uint8_t)(((color >> 5) & 0x3F) >> 2);   // same decode as the firmware canvas
#if !defined(BOARD_SIM_EPD47)
      // Only the EPD47's ED047TC2 has intermediate levels. The 1-bit TRMNL 7.5"
      // glass and the tri-color NM glass render any shade as solid ink, so
      // quantise here rather than let the preview promise a grey the panel
      // cannot produce.
      ink = ink >= 8 ? 15 : 0;
#endif
    }
    _buf[(size_t)py * _pw + px] = ink;
  }

  // e-ink lifecycle — no-ops on host.
  void init(uint32_t = 0, bool = true, uint16_t = 2, bool = false) {}
  void setFullWindow() {}
  void setPartialWindow(int16_t, int16_t, int16_t, int16_t) {}
  void firstPage() {}
  bool nextPage() { return false; }   // single full-buffer pass
  void powerOff() {}
  void hibernate() {}

  // Host readback for the PNG writer.
  const uint8_t* hostBuffer() const { return _buf; }
  int16_t hostWidth() const { return _pw; }
  int16_t hostHeight() const { return _ph; }

private:
  uint8_t* _buf = nullptr;
  int16_t _pw = 0, _ph = 0;
};
