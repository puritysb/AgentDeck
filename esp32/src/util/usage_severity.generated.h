// GENERATED from shared/src/usage-severity.ts and design token bindings. DO NOT EDIT.
#pragma once
#include <cmath>
#include <cstdint>
namespace UsageSeverity {
enum Level { Unknown, Normal, Warning, Critical };
inline Level level(float used) {
    if (!std::isfinite(used) || used < 0) return Unknown;
    if (used >= 90) return Critical;
    if (used >= 70) return Warning;
    return Normal;
}
inline uint32_t color(float used, bool onPaper = false) {
    static constexpr uint32_t bright[] = {0x7a8a9c, 0x52D988, 0xFFA93D, 0xFF6B6B};
    static constexpr uint32_t paper[] = {0x3d454e, 0x296c44, 0x7f541e, 0x7f3535};
    return (onPaper ? paper : bright)[level(used)];
}
}
