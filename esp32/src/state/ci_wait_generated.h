// GENERATED from shared/src/ci-wait.ts. No heap or mutable storage.
#pragma once
#include <stdint.h>
#include <string.h>
namespace CiWaitVisual {
static constexpr unsigned long CYCLE_MS = 6000;
static constexpr unsigned long SHOW_AFTER_MS = 3000;
static constexpr uint32_t HELPER_COLOR = 0xE2E8F0;
static constexpr uint8_t NONE = 0;
static constexpr uint8_t UNKNOWN = 1;
static constexpr uint8_t QUEUED = 2;
static constexpr uint8_t RUNNING = 3;
static constexpr uint8_t PASSED = 4;
static constexpr uint8_t FAILED = 5;
static constexpr uint8_t GITHUB[8] = {60, 126, 195, 195, 195, 231, 70, 36};
static constexpr uint8_t GITHUB_ALPHA_SIZE = 24;
static constexpr uint8_t GITHUB_ALPHA[GITHUB_ALPHA_SIZE * GITHUB_ALPHA_SIZE] = {0, 0, 0, 0, 0, 0, 0, 27, 106, 183, 216, 244, 243, 215, 179, 102, 23, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 19, 136, 248, 255, 255, 255, 255, 255, 255, 255, 255, 250, 153, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 59, 233, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 235, 62, 0, 0, 0, 0, 0, 0, 0, 85, 249, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 248, 80, 0, 0, 0, 0, 0, 50, 245, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 246, 52, 0, 0, 0, 8, 224, 255, 255, 255, 23, 47, 163, 242, 194, 171, 171, 192, 239, 158, 46, 26, 255, 255, 255, 219, 6, 0, 0, 114, 255, 255, 255, 245, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1, 251, 255, 255, 255, 109, 0, 2, 230, 255, 255, 255, 255, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22, 255, 255, 255, 255, 227, 1, 58, 255, 255, 255, 255, 207, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 207, 255, 255, 255, 255, 54, 127, 255, 255, 255, 255, 93, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 92, 255, 255, 255, 255, 123, 157, 255, 255, 255, 255, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 255, 255, 255, 255, 154, 180, 255, 255, 255, 255, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16, 255, 255, 255, 255, 180, 174, 255, 255, 255, 255, 51, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 53, 255, 255, 255, 255, 173, 153, 255, 255, 255, 255, 142, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 146, 255, 255, 255, 255, 150, 99, 255, 255, 255, 255, 248, 55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 61, 250, 255, 255, 255, 255, 97, 31, 253, 255, 255, 255, 255, 240, 86, 0, 0, 0, 0, 0, 0, 0, 1, 97, 244, 255, 255, 255, 255, 253, 31, 0, 183, 255, 191, 39, 151, 255, 255, 211, 128, 6, 0, 0, 8, 136, 220, 255, 255, 255, 255, 255, 255, 181, 0, 0, 56, 253, 255, 168, 1, 155, 255, 246, 82, 0, 0, 0, 0, 116, 255, 255, 255, 255, 255, 255, 254, 56, 0, 0, 0, 149, 255, 255, 58, 2, 59, 30, 0, 0, 0, 0, 0, 17, 254, 255, 255, 255, 255, 255, 151, 0, 0, 0, 0, 6, 193, 255, 222, 38, 0, 0, 0, 0, 0, 0, 0, 0, 239, 255, 255, 255, 255, 196, 7, 0, 0, 0, 0, 0, 12, 182, 255, 250, 204, 215, 16, 0, 0, 0, 0, 0, 236, 255, 255, 255, 188, 14, 0, 0, 0, 0, 0, 0, 0, 3, 116, 246, 255, 255, 16, 0, 0, 0, 0, 0, 235, 255, 249, 126, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 23, 130, 153, 1, 0, 0, 0, 0, 0, 133, 141, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
inline uint8_t phase(const char* value) {
    if (value && !strcmp(value, "unknown")) return 1;
    if (value && !strcmp(value, "queued")) return 2;
    if (value && !strcmp(value, "running")) return 3;
    if (value && !strcmp(value, "passed")) return 4;
    if (value && !strcmp(value, "failed")) return 5;
    return UNKNOWN;
}
inline uint8_t compactPhase(const char* value, bool agentWaiting) {
    const uint8_t id = phase(value);
    return id == PASSED || id == FAILED || agentWaiting ? id : NONE;
}
template<typename Wait> inline uint8_t fromJsonWait(const Wait& wait) {
    return compactPhase(wait["phase"] | "unknown",
        wait["agentWaiting"].template is<bool>() && wait["agentWaiting"].template as<bool>());
}
}
