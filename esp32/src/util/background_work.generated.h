// GENERATED from shared/src/background-work-presentation.ts. DO NOT EDIT.
#pragma once
#include <stdio.h>
namespace BackgroundWork {
static constexpr int MaxCount = 4096;
static constexpr int MaxDots = 3;
static constexpr int OrbitMs = 4800;
static constexpr int FinishMs = 1500;
inline int count(int value) { return value >= 0 && value <= MaxCount ? value : -1; }
inline void label(int value, int standby, char* out, size_t size) {
    if (count(value) <= 0 && count(standby) > 0) snprintf(out, size, "STBY %d", standby);
    else if (count(value) < 0) { if(size) out[0] = 0; }
    else if(value == 0) snprintf(out, size, "BG DONE");
    else snprintf(out, size, "BG %d", value);
}
inline void label(int value, char* out, size_t size) { label(value, -1, out, size); }
}
