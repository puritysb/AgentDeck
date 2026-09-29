// TC001 8×32 LED-matrix render path. The matrix renderer is LVGL-free: it draws
// into a CRGB[] buffer via MatrixPages::renderUsage/renderAgents (the same
// functions matrix_display.cpp calls on-device). The sim calls them directly
// into its own buffer, maps the serpentine LED layout to an image, upscales, and
// dumps PNG. Board-gated so LCD envs compile this to nothing.
#include "../sim.h"

#ifdef BOARD_LED8X32
#include <Arduino.h>
#include <FastLED.h>
#include "config.h"
#include "state/agent_state.h"
#include "../../../src/ui/matrix/matrix_pages.h"
#include "../../../boards/board_config.h"   // MATRIX_W / MATRIX_H
#include <cstdlib>
#include <cstring>

extern unsigned long g_sim_millis;

namespace {
// Serpentine LED index for (x,y) — matches matrix_pages.cpp xyToIdx / matrix_font.
int xyToIdx(int x, int y) {
  return (y % 2 == 0) ? (y * MATRIX_W + x) : (y * MATRIX_W + (MATRIX_W - 1 - x));
}
}  // namespace

bool SimMatrix::renderToPng(const char* scene, const char* page, int frames,
                            int scale, const char* path) {
  if (!SimScenes::apply(scene)) return false;
  if (scale < 1) scale = 1;

  static CRGB leds[MATRIX_W * MATRIX_H];
  const float dt = 0.033f;
  g_sim_millis = 0;
  float animTime = 0.0f;
  for (int i = 0; i < frames; i++) {
    g_sim_millis += 33;
    animTime += dt;
    fill_solid(leds, MATRIX_W * MATRIX_H, CRGB::Black);
    if (std::strcmp(page, "agents") == 0) MatrixPages::renderAgents(leds, animTime);
    else if (std::strcmp(page, "codex") == 0) MatrixPages::renderCodex(leds, animTime);
    else if (std::strcmp(page, "zai") == 0) MatrixPages::renderZai(leds, animTime);
    else MatrixPages::renderUsage(leds, animTime);
  }

  // Map serpentine CRGB buffer → upscaled RGB565 image (nearest-neighbor).
  const int W = MATRIX_W * scale, H = MATRIX_H * scale;
  uint16_t* img = static_cast<uint16_t*>(std::malloc((size_t)W * H * sizeof(uint16_t)));
  if (!img) return false;
  for (int y = 0; y < MATRIX_H; y++) {
    for (int x = 0; x < MATRIX_W; x++) {
      const CRGB& c = leds[xyToIdx(x, y)];
      uint16_t px = (uint16_t)(((c.r & 0xF8) << 8) | ((c.g & 0xFC) << 3) | (c.b >> 3));
      for (int sy = 0; sy < scale; sy++)
        for (int sx = 0; sx < scale; sx++)
          img[(size_t)(y * scale + sy) * W + (x * scale + sx)] = px;
    }
  }
  bool ok = SimPng::writeRgb565(path, img, W, H);
  std::free(img);
  return ok;
}
#endif  // BOARD_LED8X32
