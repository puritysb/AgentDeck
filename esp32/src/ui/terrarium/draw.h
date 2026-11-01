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
// One contrast-safe attention grammar for every LCD species, including tiny panels.
inline void attention(int x, int y, int r, uint32_t fill, uint32_t ink) {
    r = max(4, r);
    circle(x, y, r, fill, 255);
    const int stroke = max(1, r / 3);
    for (int dx = 0; dx < stroke; ++dx) {
        line(x + dx - stroke/2, y-r/2, x + dx - stroke/2, y, ink, 255);
        pixelA(x + dx - stroke/2, y+r/2, ink, 255);
    }
}

// Filled nacre basin and a hinged fan. The closed shell retains
// volume instead of reading as an empty wire basket; no frame allocations.
inline void scallop(int x, int y, int r, float open, uint32_t color) {
    open = max(0.0f, min(1.0f, open));
    const int lift = (int)(r * (0.25f + open * 1.2f)) + 2;
    // A curved, filled fan rather than a trapezoid outlined like a basket.
    for (int dy = -lift; dy <= 0; ++dy) {
        const float t = float(dy) / max(1, lift);
        const int half = max(1, int(r * sqrtf(max(0.0f, 1-t*t))));
        line(x-half,y+dy,x+half,y+dy,color,165);
    }
    for (int rib=1;rib<6;++rib) {
        const float angle=M_PI*float(rib)/6;
        line(x,y,x+int(fastCos(angle)*r),y-int(fastSin(angle)*lift),color,100);
    }
    const int depth = max(2, r / 3 + 2);
    for (int dy = 0; dy <= depth; ++dy) {
        const float t = float(dy) / depth;
        const int half = int(r * sqrtf(max(0.0f, 1-t*t)));
        line(x-half,y+dy,x+half,y+dy,color,200);
    }
    line(x-r,y,x+r,y,color,240);
}



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
