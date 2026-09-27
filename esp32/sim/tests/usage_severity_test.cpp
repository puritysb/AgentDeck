#include "util/usage_severity.generated.h"
#include <cassert>
#include <limits>
int main() {
    using namespace UsageSeverity;
    assert(level(-1) == Unknown);
    assert(level(std::numeric_limits<float>::quiet_NaN()) == Unknown);
    assert(level(0) == Normal);
    assert(level(69.9f) == Normal);
    assert(level(70) == Warning);
    assert(level(82) == Warning);
    assert(level(89.9f) == Warning);
    assert(level(90) == Critical);
    assert(level(100) == Critical);
    assert(color(82) == 0xFFA93D);
    assert(color(100 - 18) == color(82));
    assert(color(90) == 0xFF6B6B);
    assert(color(82, true) == 0x7f541e);
}
