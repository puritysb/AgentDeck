#pragma once
#include "dot_surface_generated.h"
#include <stdint.h>
struct DotSurfaceState {
    bool configured = false;
    bool hosting = false;
    uint8_t code = 1;
    uint32_t receivedMs = 0;
    uint32_t validForMs = 0;
    // High-water report stamp survives compact-frame omissions.
    bool reportKnown = false;
    bool leaseSeen = false;
    uint64_t reportedAt = 0;
    bool custom = false;
    uint8_t rgba[DotSurfaceRules::glyphBytes] = {};
    char relation[DotSurfaceRules::relationBytes + 1] = {};
    void clear() {
        configured = false; hosting = false; code = 1;
        receivedMs = 0; validForMs = 0; reportKnown = false; leaseSeen = false; reportedAt = 0;
        custom = false; relation[0] = 0;
    }
    bool setActivity(bool live, uint8_t phase, bool known, uint64_t stamp, uint32_t budget, uint32_t now) {
        const bool work = phase == 2 || phase == 3;
        if (live && configured && reportKnown && known && stamp < reportedAt) return false;
        const bool same = configured && (!known || (reportKnown && stamp == reportedAt));
        if (live && same && (code == 4 || code == 5) && work) return false;
        if (budget > DotSurfaceRules::reportFreshMs) budget = DotSurfaceRules::reportFreshMs;
        if (!work || !live) budget = 0;
        // Replayed compact frames consume the existing lease, never renew it.
        if (same && (known || leaseSeen || code == 6)) {
            const uint32_t age = now - receivedMs;
            const uint32_t remaining = age < validForMs ? validForMs - age : 0;
            if (budget > remaining) budget = remaining;
        }
        configured = true; hosting = live; code = phase;
        if (known && (!reportKnown || stamp >= reportedAt)) { reportKnown = true; reportedAt = stamp; }
        if (work && live) leaseSeen = true;
        receivedMs = now; validForMs = budget;
        return true;
    }
    uint8_t effectiveCode(uint32_t now) const {
        if (!hosting) return 1;
        if ((code == 2 || code == 3) && now - receivedMs >= validForMs) return 6;
        return code < DotSurfaceRules::phaseCount ? code : 7;
    }
};
static_assert(sizeof(DotSurfaceState) < 1280, "Dot companion owns one fixed bounded glyph; no render allocation");
