#include "ui/widgets/ttgo_usage_layout.h"
#include <cassert>
#include <limits>

int main() {
    using namespace TTGO::Usage;
    assert(hasWindow(0)); assert(hasWindow(100)); assert(!hasWindow(-1));
    assert(!hasWindow(std::numeric_limits<float>::quiet_NaN()));
    assert(!hasWindow(std::numeric_limits<float>::infinity()));
    assert(boundedPercent(120) == 100);
    for (int rotation = 0; rotation < 4; ++rotation) {
        const int w = rotation % 2 ? 240 : 135, h = rotation % 2 ? 135 : 240;
        for (int count = 1; count <= 6; ++count) {
            for (int i = 0; i < count; ++i) {
                auto a = cardRect(w, h, count, i);
                assert(a.x >= 0 && a.y >= 18 && a.x + a.w <= w && a.y + a.h <= h - 14);
                assert(a.w >= 110 && a.h >= 30);
                for (int j = 0; j < i; ++j) {
                    auto b = cardRect(w, h, count, j);
                    assert(a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h);
                }
            }
        }
    }
}
