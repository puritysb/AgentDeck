#pragma once

#include <stdint.h>
#include <string.h>

// EPD47 keeps the previous 4-bit frame in PSRAM so every admitted content
// change can erase exactly the ink it replaces. This data-only policy separates
// those quiet differential updates from the hard waveform that resets the
// pigment. Keeping the bookkeeping here lets host tests execute the exact rule
// used by the firmware without allocating or depending on the panel driver.
//
// Residue is tracked per horizontal strip, not per update. Until 2026-10-07
// every differential erased and redrew the WHOLE frame, so one counter was an
// honest proxy for "how many times has every inked pixel been cycled". The
// masked update (epd47_diff.h) drives only the pixels that changed, so a new
// work line in one row no longer ages the other 500 rows. A strip that has been
// rewritten `stripBudget` times since the last hard clear is what earns the
// next flash — the rest of the panel is not charged for it.
namespace AgentDeckEpd47 {

constexpr uint16_t PANEL_ROWS = 540;
constexpr uint16_t STRIP_ROWS = 30;
constexpr uint8_t STRIPS = PANEL_ROWS / STRIP_ROWS;
static_assert(STRIPS * STRIP_ROWS == PANEL_ROWS, "strips must tile the panel");

enum class Erase : uint8_t {
    Differential = 0,  // drive only the changed pixels: old ink out, new ink in
    ClearAll,          // hard anti-ghost sweep of the complete panel
};

struct RefreshState {
    uint8_t residue[STRIPS] = {};   // differential rewrites per strip since the last hard clear
    uint32_t lastHardClearMs = 0;
    uint16_t differentialCount = 0; // telemetry only; the policy reads residue
};

inline bool isHardClear(Erase erase) {
    return erase == Erase::ClearAll;
}

inline uint8_t maxResidue(const RefreshState& state) {
    uint8_t m = 0;
    for (uint8_t i = 0; i < STRIPS; i++) if (state.residue[i] > m) m = state.residue[i];
    return m;
}

// A hard clear is due on the first frame, when any strip has been rewritten
// `stripBudget` times, or when residue has sat longer than `maxAgeMs`. A clean
// panel never ages into a flash: until 2026-10-07 the age rule fired on a panel
// with nothing to clear (48 measured flashes in ten days, each the first change
// after a quiet ten minutes).
inline bool hardClearDue(const RefreshState& state, bool firstDraw, uint32_t nowMs,
                         uint8_t stripBudget, uint32_t maxAgeMs) {
    if (firstDraw) return true;
    const uint8_t worst = maxResidue(state);
    return worst >= stripBudget ||
           (worst > 0 && (uint32_t)(nowMs - state.lastHardClearMs) > maxAgeMs);
}

inline Erase chooseErase(bool hardClear) {
    return hardClear ? Erase::ClearAll : Erase::Differential;
}

// A touch session runs on quiet differential updates by design — flashing
// mid-interaction is what the retained frame exists to prevent — but page swaps
// rewrite most of the panel, so a tap-there-and-back session leaves residue on
// every strip it crossed. Once the user has stopped touching for `quietMs`, one
// hard sweep restores a crisp panel at the moment its flash costs the least
// attention. A session that left at most one rewrite anywhere is not worth it.
inline bool postInteractionSweepDue(uint32_t lastInteractionMs, const RefreshState& state,
                                    uint32_t nowMs, uint32_t quietMs, uint8_t minResidue = 2) {
    return lastInteractionMs != 0 && maxResidue(state) >= minResidue &&
           (uint32_t)(nowMs - lastInteractionMs) > quietMs;
}

inline void recordHardClear(RefreshState& state, uint32_t nowMs) {
    memset(state.residue, 0, sizeof(state.residue));
    state.differentialCount = 0;
    state.lastHardClearMs = nowMs;
}

// Rows are physical panel rows, inclusive. An empty band (first > last) is a
// no-op: nothing was driven, so nothing aged.
inline void recordDifferential(RefreshState& state, uint16_t firstRow, uint16_t lastRow) {
    if (firstRow > lastRow || firstRow >= PANEL_ROWS) return;
    if (lastRow >= PANEL_ROWS) lastRow = PANEL_ROWS - 1;
    for (uint8_t s = (uint8_t)(firstRow / STRIP_ROWS); s <= lastRow / STRIP_ROWS; s++)
        if (state.residue[s] != UINT8_MAX) state.residue[s]++;
    if (state.differentialCount != UINT16_MAX) state.differentialCount++;
}

}  // namespace AgentDeckEpd47
