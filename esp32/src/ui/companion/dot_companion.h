#pragma once
#include "../../state/dot_state.h"
namespace DotCompanion {
template<class Pixel>
void glyph(const DotSurfaceState& dot, int x, int y, int size, Pixel pixel) {
    if (!dot.configured || size <= 0) return;
    const bool tinyDefault = !dot.custom && size == DotSurfaceRules::matrixGlyphSize;
    const int source = tinyDefault ? DotSurfaceRules::matrixGlyphSize : DotSurfaceRules::glyphSize;
    for (int dy = 0; dy < size; ++dy) for (int dx = 0; dx < size; ++dx) {
        const int i = ((dy * source / size) * source + dx * source / size) * 4;
        const uint8_t* rgba = dot.custom ? dot.rgba : tinyDefault ? DotSurfaceRules::matrixRgba : DotSurfaceRules::defaultRgba;
        if (rgba[i + 3]) pixel(x + dx, y + dy, rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
    }
}
template<class Pixel>
void mono(const DotSurfaceState& dot, int x, int y, int size, Pixel pixel) {
    if (!dot.configured || size <= 0) return;
    const int source = DotSurfaceRules::glyphSize;
    const uint8_t* rgba = dot.custom ? dot.rgba : DotSurfaceRules::defaultRgba;
    for (int dy = 0; dy < size; ++dy) for (int dx = 0; dx < size; ++dx) {
        const int sx = dx * source / size, sy = dy * source / size;
        const int i = (sy * source + sx) * 4;
        if (rgba[i + 3] < 128) continue;
        const bool edge = sx == 0 || sy == 0 || sx == source - 1 || sy == source - 1
            || rgba[i - 4 + 3] < 128 || rgba[i + 4 + 3] < 128 || rgba[i - source * 4 + 3] < 128 || rgba[i + source * 4 + 3] < 128;
        pixel(x + dx, y + dy, edge || uint16_t(rgba[i]) + rgba[i + 1] + rgba[i + 2] < 384);
    }
}
}
