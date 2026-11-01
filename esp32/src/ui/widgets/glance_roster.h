#pragma once
#include <cstdint>

namespace GlanceRoster {
// Stable arrival order within each urgency tier; no animation or heap state.
constexpr uint8_t priority(bool error, bool input, bool working) {
    return error ? 0 : input ? 1 : working ? 2 : 3;
}
}
