#include "ui/widgets/glance_roster.h"
#include <algorithm>
#include <array>
#include <cassert>
int main() {
    struct Resident { bool error, input, working; int id; };
    std::array<Resident, 6> rows{{{false,false,false,0}, {false,false,true,1},
        {false,true,false,2}, {true,false,false,3}, {false,true,false,4}, {false,false,true,5}}};
    std::stable_sort(rows.begin(), rows.end(), [](const Resident& a, const Resident& b) {
        return GlanceRoster::priority(a.error,a.input,a.working) < GlanceRoster::priority(b.error,b.input,b.working);
    });
    const int expected[] = {3,2,4,1,5,0};
    for (unsigned i=0; i<rows.size(); ++i) assert(rows[i].id==expected[i]);
    assert(GlanceRoster::priority(true,true,true)==0);
}
