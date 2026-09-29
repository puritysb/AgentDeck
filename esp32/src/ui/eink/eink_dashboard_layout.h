#pragma once

// AgentDeck ESP32 e-ink dashboard geometry SSOT.
//
// This header intentionally depends only on <stdint.h>. TRMNL 7.5" (GxEPD2) and
// the downstream XTeink X3/X4 CrossPoint fork (GfxRenderer) consume the exact
// same file, while keeping their panel drivers and text engines independent.
// The mirror is updated by scripts/sync-xteink-eink-dashboard.sh.
//
// Memory discipline: all values are returned by value, there are no virtuals,
// containers, strings, or heap allocations. A Layout is 62 bytes worst case.

#include <stdint.h>
#include <string.h>

namespace AgentDeckEink {

struct Rect {
    int16_t x;
    int16_t y;
    int16_t w;
    int16_t h;

    int16_t right() const { return (int16_t)(x + w); }
    int16_t bottom() const { return (int16_t)(y + h); }
    bool empty() const { return w <= 0 || h <= 0; }
};

// Density comes from the SHORT edge alone. Orientation is the independent
// `Layout::portrait` field, so a panel can be Compact in either orientation —
// do not read these bands as landscape/portrait classes.
enum class Density : uint8_t {
    Compact,   // short edge < 520px  — TRMNL 7.5" 800x480, XTeink X4 480x800
    Regular,   // short edge 520..759 — XTeink X3 528x792
    Spacious,  // short edge >= 760px — future large e-ink panels
};

enum class StatusKind : uint8_t {
    Offline,
    Idle,
    Processing,
    Attention,
};

inline StatusKind classifyStatus(const char* state) {
    if (!state || !state[0]) return StatusKind::Offline;
    if (strncmp(state, "awaiting", 8) == 0) return StatusKind::Attention;
    if (strcmp(state, "processing") == 0) return StatusKind::Processing;
    if (strcmp(state, "idle") == 0) return StatusKind::Idle;
    return StatusKind::Offline;
}

struct LayoutInput {
    int16_t width;
    int16_t height;
    int16_t headerHeight;       // includes the header divider
    int16_t controlsHeight;     // physical-button hint bar; 0 on TRMNL 7.5"
    int16_t usageRowHeight;
    int16_t activityRowHeight;
    uint8_t usageRows;
    uint8_t activityRows;
    uint8_t sessionCount;
    uint8_t maxCardRows;        // 2 landscape, up to 5 portrait
};

struct Layout {
    int16_t width;
    int16_t height;
    int16_t pad;
    int16_t gap;
    int16_t cardGap;
    int16_t cardWidth;
    int16_t cardHeight;
    uint8_t columns;
    uint8_t rows;
    uint8_t capacity;
    Density density;
    bool portrait;
    Rect header;
    Rect cards;
    Rect usage;
    Rect activity;
    Rect controls;

    Rect card(uint8_t index) const {
        if (index >= capacity || columns == 0) return Rect{0, 0, 0, 0};
        const int16_t col = (int16_t)(index % columns);
        const int16_t row = (int16_t)(index / columns);
        return Rect{
            (int16_t)(cards.x + col * (cardWidth + cardGap)),
            (int16_t)(cards.y + row * (cardHeight + cardGap)),
            cardWidth,
            cardHeight,
        };
    }
};

inline int16_t clamp16(int value, int lo, int hi) {
    if (value < lo) return (int16_t)lo;
    if (value > hi) return (int16_t)hi;
    return (int16_t)value;
}

inline Layout makeLayout(const LayoutInput& in) {
    Layout out{};
    out.width = in.width > 0 ? in.width : 1;
    out.height = in.height > 0 ? in.height : 1;
    out.portrait = out.height > out.width;
    const int16_t shortEdge = out.width < out.height ? out.width : out.height;
    out.density = shortEdge < 520 ? Density::Compact
                                  : (shortEdge < 760 ? Density::Regular : Density::Spacious);
    out.pad = clamp16(shortEdge / 40, 12, 24);
    out.gap = clamp16(shortEdge / 64, 8, 16);
    out.cardGap = clamp16(shortEdge / 48, 10, 18);

    const int16_t headerH = clamp16(in.headerHeight, 44, out.height / 4);
    const int16_t controlsH = clamp16(in.controlsHeight, 0, out.height / 4);
    const int16_t usageH = in.usageRows == 0
        ? 0
        : (int16_t)(out.gap + in.usageRows * in.usageRowHeight);
    const int16_t activityH = in.activityRows == 0
        ? 0
        : (int16_t)(in.activityRows * in.activityRowHeight + out.gap / 2);

    out.header = Rect{0, 0, out.width, headerH};
    out.controls = Rect{0, (int16_t)(out.height - controlsH), out.width, controlsH};
    out.activity = Rect{out.pad, (int16_t)(out.controls.y - activityH),
                        (int16_t)(out.width - out.pad * 2), activityH};
    out.usage = Rect{0, (int16_t)(out.activity.y - usageH), out.width, usageH};

    const int16_t cardsTop = (int16_t)(out.header.bottom() + out.gap);
    int16_t cardsBottom = out.usage.empty() ? out.activity.y : out.usage.y;
    cardsBottom = (int16_t)(cardsBottom - out.gap / 2);
    if (cardsBottom < cardsTop) cardsBottom = cardsTop;
    out.cards = Rect{out.pad, cardsTop, (int16_t)(out.width - out.pad * 2),
                     (int16_t)(cardsBottom - cardsTop)};

    // Paper cards should remain readable, not merely numerous. Portrait readers
    // use one wide column; short landscape panels use two. A future >=1200px
    // landscape panel may use three without any renderer changes.
    out.columns = out.portrait ? 1
        : ((out.width >= 1180 || (out.width >= 720 && in.sessionCount >= 5)) ? 3 : 2);
    if (in.sessionCount > 0 && in.sessionCount < out.columns) out.columns = in.sessionCount;
    if (out.columns == 0) out.columns = 1;

    const int16_t minCardH = out.portrait ? 96
        : (out.density == Density::Compact ? 104 : 112);
    int possibleRows = (out.cards.h + out.cardGap) / (minCardH + out.cardGap);
    if (possibleRows < 1) possibleRows = 1;
    const int maxRows = in.maxCardRows > 0 ? in.maxCardRows : 1;
    if (possibleRows > maxRows) possibleRows = maxRows;
    int neededRows = in.sessionCount == 0 ? 1 :
        (in.sessionCount + out.columns - 1) / out.columns;
    if (neededRows < possibleRows) possibleRows = neededRows;
    if (possibleRows < 1) possibleRows = 1;
    out.rows = (uint8_t)possibleRows;
    out.capacity = (uint8_t)(out.columns * out.rows);

    out.cardWidth = (int16_t)((out.cards.w - (out.columns - 1) * out.cardGap) / out.columns);
    out.cardHeight = (int16_t)((out.cards.h - (out.rows - 1) * out.cardGap) / out.rows);
    return out;
}

}  // namespace AgentDeckEink
