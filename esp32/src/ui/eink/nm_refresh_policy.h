#pragma once

#include <stdint.h>

// RockBase NM-EPD-420 paint gate. Every admitted NM repaint is a complete
// tri-color cycle (13.36 s measured, n=584), so the gate decides whether a
// changed frame is worth one.
//
// - A user action paints now: the reader is waiting for it.
// - Routine content churn waits for the ambient floor.
// - An urgent transition (link up/down, a new face, someone newly needing the
//   reader, a count change that held for the settle window) bypasses the floor
//   but not a short gap after the previous cycle ENDED. Before this gap the
//   panel measured 14 back-to-back cycles in ten days (27 s of continuous
//   flashing): a second session starting to wait during the first cycle
//   triggered another immediately. The speaker chime already announced it, so
//   coalescing it into one later cycle costs nothing.
//
// Data-only so host tests execute the exact rule the firmware runs.
namespace AgentDeckNm {

constexpr uint32_t AMBIENT_FLOOR_MS = 15UL * 60UL * 1000UL;
constexpr uint32_t URGENT_GAP_MS = 30UL * 1000UL;
constexpr uint32_t COUNT_SETTLE_MS = 90UL * 1000UL;

struct GateInput {
    bool userAction = false;      // key press: the reader asked for this frame
    bool firstPaint = false;
    bool linkChanged = false;     // daemon link appeared or vanished
    bool faceChanged = false;     // arbitration picked a different face
    bool attentionRose = false;   // more sessions need the reader than painted
    bool countSettled = false;    // a changed count held for COUNT_SETTLE_MS
    uint32_t sincePaintStartMs = UINT32_MAX;  // since the previous cycle began
    uint32_t sincePaintEndMs = UINT32_MAX;    // since the previous cycle finished
};

inline bool urgent(const GateInput& in) {
    return in.linkChanged || in.faceChanged || in.attentionRose || in.countSettled;
}

inline bool shouldPaint(const GateInput& in, uint32_t ambientMs = AMBIENT_FLOOR_MS,
                        uint32_t urgentGapMs = URGENT_GAP_MS) {
    if (in.userAction || in.firstPaint) return true;
    if (urgent(in)) return in.sincePaintEndMs >= urgentGapMs;
    return in.sincePaintStartMs >= ambientMs;
}

}  // namespace AgentDeckNm
