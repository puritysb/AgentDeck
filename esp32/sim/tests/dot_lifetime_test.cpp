#include <assert.h>
#include "state/dot_state.h"

int main() {
    DotSurfaceState dot;
    const uint32_t lease = DotSurfaceRules::reportFreshMs;
    assert(dot.setActivity(true, 2, true, 1000, lease, 0));
    assert(dot.effectiveCode(0) == 2);
    assert(dot.setActivity(true, 2, true, 1000, lease, lease / 2));
    assert(dot.effectiveCode(lease) == 6);
    assert(dot.setActivity(true, 2, true, 1000, lease, lease + 1));
    assert(dot.effectiveCode(lease + 1) == 6);
    assert(dot.setActivity(true, 2, true, 2000, lease, lease + 2));
    assert(dot.effectiveCode(lease + 2) == 2);
    assert(dot.setActivity(true, 4, true, 2001, 0, lease + 3));
    assert(!dot.setActivity(true, 2, true, 2000, lease, lease + 4));
    assert(!dot.setActivity(true, 2, true, 2001, lease, lease + 4));
    assert(dot.effectiveCode(lease + 4) == 4);
    dot.clear();
    assert(!dot.configured);
    // Older minimum compact frames lack a timestamp, but still have a bounded lease.
    assert(dot.setActivity(true, 2, false, 0, lease, 0));
    assert(dot.setActivity(true, 2, false, 0, lease, lease / 2));
    assert(dot.effectiveCode(lease) == 6);
    // Losing a timestamp in a minimum compact frame cannot renew an existing report.
    dot.clear();
    assert(dot.setActivity(true, 2, true, 4000, lease, 0));
    assert(dot.setActivity(true, 2, false, 0, lease, lease / 2));
    assert(dot.effectiveCode(lease) == 6);
    assert(dot.setActivity(true, 0, false, 0, 0, lease));
    assert(dot.setActivity(true, 2, true, 4000, lease, lease + 1));
    assert(dot.effectiveCode(lease + 1) == 6);
    // Stopped hosting wins even over a back-dated frame; its cached work cannot resume.
    dot.clear();
    assert(dot.setActivity(true, 2, true, 5000, lease, 0));
    assert(dot.setActivity(false, 1, true, 4999, 0, 1));
    assert(dot.effectiveCode(1) == 1);
    assert(dot.setActivity(true, 2, true, 5000, lease, 2));
    assert(dot.effectiveCode(2) == 6);
    dot.clear();
    assert(dot.setActivity(true, 2, false, 0, lease, 0));
    assert(dot.setActivity(false, 1, false, 0, 0, 1));
    assert(dot.setActivity(true, 2, false, 0, lease, 2));
    assert(dot.effectiveCode(2) == 6);
    // Unsigned subtraction preserves the budget across millis() wrap.
    dot.clear();
    const uint32_t start = UINT32_MAX - 20;
    assert(dot.setActivity(true, 3, true, 3000, 40, start));
    assert(dot.effectiveCode(start + 39) == 3);
    assert(dot.effectiveCode(start + 40) == 6);
}
