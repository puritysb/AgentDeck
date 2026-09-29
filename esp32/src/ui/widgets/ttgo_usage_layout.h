#pragma once
#include <cmath>

namespace TTGO { namespace Usage {
struct Rect { int x, y, w, h; };
inline bool hasWindow(float percent) { return std::isfinite(percent) && percent >= 0; }
inline int boundedPercent(float percent) { return percent > 100 ? 100 : static_cast<int>(percent); }
// All present windows fit simultaneously; no paging or telemetry-driven mode changes.
inline Rect cardRect(int width, int height, int count, int index) {
    const int cols = width > height && count > 1 ? 2 : 1;
    const int rows = (count + cols - 1) / cols;
    const int w = (width - 12 - (cols - 1) * 4) / cols;
    const int h = (height - 34 - (rows - 1) * 4) / rows;
    return {6 + (index % cols) * (w + 4), 18 + (index / cols) * (h + 4), w, h};
}
} }
