#include "../src/ui/widgets/collaboration_layout.h"
#include <cassert>
#include <cstdio>
#include <initializer_list>

int main() {
    using CollaborationLayout::cell;
    for (int count = 1; count <= 10; ++count) {
        for (int width : {342, 814}) {
            for (int i = 0; i < count; ++i) {
                const auto r = cell(i, count, width, 630);
                assert(r.width >= 300 && r.height >= 216);
                assert(r.x >= 0 && r.x + r.width <= width);
                for (int j = 0; j < i; ++j) {
                    const auto s = cell(j, count, width, 630);
                    assert(r.x >= s.x + s.width || s.x >= r.x + r.width ||
                           r.y >= s.y + s.height || s.y >= r.y + r.height);
                }
            }
        }
    }
    puts("IPS10 collaboration geometry: 1–10 sessions, portrait/landscape PASS");
}
