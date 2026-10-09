#pragma once
#include "dot_surface_generated.h"
#include <stdint.h>
struct DotSurfaceState {
    bool configured = false;
    bool hosting = false;
    uint8_t code = 1;
    uint32_t receivedMs = 0;
    uint32_t validForMs = 0;
    bool custom = false;
    uint8_t rgba[DotSurfaceRules::glyphBytes] = {};
    char relation[DotSurfaceRules::relationBytes + 1] = {};
    uint8_t effectiveCode(uint32_t now) const {
        if (!hosting) return 1;
        if ((code == 2 || code == 3) && now - receivedMs >= validForMs) return 6;
        return code < 8 ? code : 7;
    }
};
static_assert(sizeof(DotSurfaceState) < 1280, "Dot companion owns one fixed bounded glyph; no render allocation");
