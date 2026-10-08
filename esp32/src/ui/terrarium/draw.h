#pragma once

#include <cstdint>
#include <cstddef>
#include <cmath>
#include <algorithm>

#ifndef M_PI
#define M_PI 3.14159265358979323846f
#endif

using std::min;
using std::max;

// Fast sin/cos using lookup table
float fastSin(float rad);
float fastCos(float rad);

namespace CreatureGlyphs { struct FeatureLayer; }

// Drawing primitives — direct pixel buffer writes (no LVGL overhead)
namespace Draw {

/** Set a single pixel (RGB565). */
void pixel(int x, int y, uint16_t color);

/** Set a pixel with 24-bit color and alpha blend. */
void pixelA(int x, int y, uint32_t color24, uint8_t alpha);

/** Filled rectangle (RGB565). */
void rect(int x, int y, int w, int h, uint16_t color);

/** Filled circle with alpha blend. */
void circle(int cx, int cy, int r, uint32_t color24, uint8_t alpha);

/** Line (Bresenham) with alpha blend. */
void line(int x0, int y0, int x1, int y1, uint32_t color24, uint8_t alpha);

/** Draw an 8-bit alpha coverage mask scaled into a dst box, tinted + alpha-modulated.
 *  Bilinear sampling. Used for rasterized creature silhouettes (creature_glyphs_generated.h). */
void alphaMask(const uint8_t* mask, int maskW, int maskH, int x0, int y0,
               int dstW, int dstH, uint32_t color24, uint8_t alpha);

/** Paint generated brand feature layers over a body in the same source coordinate box.
 *  Layer masks remain in flash; no render buffer/cache allocation. */
void featureLayers(const CreatureGlyphs::FeatureLayer* layers, size_t count, int maskW, int maskH,
                   int x0, int y0, int dstW, int dstH, uint8_t alpha);

/** alphaMask with a vertical color gradient (colorTop → colorBottom across dst height). */
void alphaMaskGradient(const uint8_t* mask, int maskW, int maskH, int x0, int y0,
                       int dstW, int dstH, uint32_t colorTop, uint32_t colorBottom, uint8_t alpha);

}  // namespace Draw

// Color conversion helpers
inline uint16_t toRGB565(uint32_t c24) {
    uint16_t c = (uint16_t)((((c24 >> 16) & 0xFF) >> 3) << 11 |
                            (((c24 >> 8) & 0xFF) >> 2) << 5 |
                            ((c24 & 0xFF) >> 3));
    return c;
}

inline uint32_t lerpColor(uint32_t a, uint32_t b, float t) {
    if (t <= 0) return a;
    if (t >= 1) return b;
    uint8_t ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
    uint8_t br = (b >> 16) & 0xFF, bg = (b >> 8) & 0xFF, bb = b & 0xFF;
    uint8_t r = ar + (int)((br - ar) * t);
    uint8_t g = ag + (int)((bg - ag) * t);
    uint8_t bv = ab + (int)((bb - ab) * t);
    return (r << 16) | (g << 8) | bv;
}
