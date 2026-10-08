// Host assertions for the e-ink paint policies and their inputs: the EPD47
// masked differential and strip residue, the NM paint gate, the host clock
// behind "as of HH:MM", and serial-primary radio parking. Each header is the
// exact code the firmware runs.
#include <cassert>
#include <cstring>
#include <vector>

#include "net/radio_park_policy.h"
#include "ui/eink/epd47_diff.h"
#include "ui/eink/epd47_refresh_policy.h"
#include "ui/eink/nm_refresh_policy.h"
#include "util/host_clock.h"

namespace {

void epd47Residue() {
    using namespace AgentDeckEpd47;
    constexpr uint8_t BUDGET = 4;
    constexpr uint32_t AGE = 3600000;
    RefreshState state;
    assert(hardClearDue(state, true, 10, BUDGET, AGE));       // first frame
    recordHardClear(state, 10);
    assert(maxResidue(state) == 0 && state.lastHardClearMs == 10);

    // A clean panel never ages into a flash (the measured 48 wasted sweeps).
    assert(!hardClearDue(state, false, 10 + AGE * 5, BUDGET, AGE));

    // One strip rewritten four times is due; the rest of the panel is not charged.
    for (uint8_t i = 0; i < BUDGET; i++) {
        assert(!hardClearDue(state, false, 100, BUDGET, AGE));
        recordDifferential(state, 485, 505);   // strip 16 (rows 480-509) only
    }
    assert(state.residue[16] == BUDGET && state.residue[15] == 0 && state.residue[17] == 0);
    assert(hardClearDue(state, false, 100, BUDGET, AGE));
    assert(chooseErase(true) == Erase::ClearAll && chooseErase(false) == Erase::Differential);
    assert(state.lastHardClearMs == 10);  // differentials never postpone the clock
    recordHardClear(state, 200);
    assert(maxResidue(state) == 0 && state.differentialCount == 0);

    // Different strips spread the wear: four single rewrites in four strips
    // are not a sweep.
    recordDifferential(state, 0, 10);
    recordDifferential(state, 100, 110);
    recordDifferential(state, 200, 210);
    recordDifferential(state, 300, 310);
    assert(maxResidue(state) == 1);
    assert(!hardClearDue(state, false, 300, BUDGET, AGE));
    // ...but residue that sits past the age limit is cleaned.
    assert(hardClearDue(state, false, 200 + AGE + 1, BUDGET, AGE));
    // A band spanning strips charges every strip it crosses, clamped to the panel.
    recordHardClear(state, 0);
    recordDifferential(state, 25, 65);       // strips 0,1,2
    assert(state.residue[0] == 1 && state.residue[1] == 1 && state.residue[2] == 1 && state.residue[3] == 0);
    recordDifferential(state, 530, 9999);    // clamps to the last strip
    assert(state.residue[STRIPS - 1] == 1);
    recordDifferential(state, 10, 5);        // empty band: nothing driven, nothing aged
    assert(state.residue[0] == 1);

    // Unsigned age arithmetic survives millis() rollover.
    RefreshState wrap;
    recordHardClear(wrap, 0xFFFFFFFFu - 1000u);
    recordDifferential(wrap, 0, 0);
    assert(!hardClearDue(wrap, false, 500u, BUDGET, 2000u));
    assert(hardClearDue(wrap, false, 1500u, BUDGET, 2000u));

    // Post-touch sweep: only after the user stopped, and only when some region
    // was rewritten at least twice.
    RefreshState touch;
    recordDifferential(touch, 0, 539);
    assert(!postInteractionSweepDue(1000, touch, 20000, 12000));
    recordDifferential(touch, 0, 539);
    assert(!postInteractionSweepDue(1000, touch, 12000, 12000));
    assert(postInteractionSweepDue(1000, touch, 13001, 12000));
    assert(!postInteractionSweepDue(0, touch, 13001, 12000));
}

void epd47Diff() {
    using namespace AgentDeckEpd47;
    constexpr uint16_t ROW_BYTES = 8, ROWS = 6;
    std::vector<uint8_t> prev(ROW_BYTES * ROWS, 0xFF), cur(prev), out(prev.size(), 0x00);

    assert(changedRows(prev.data(), cur.data(), ROW_BYTES, ROWS).empty());

    // Row 2: low nibble black -> white (erase only). Row 4: high nibble white
    // -> grey 7 (draw only), low nibble unchanged ink.
    prev[2 * ROW_BYTES + 3] = 0xF0;   // pixel (6,2) black
    cur[2 * ROW_BYTES + 3] = 0xFF;
    prev[4 * ROW_BYTES + 0] = 0xF4;   // pixel (0,4) grey 4, pixel (1,4) white
    cur[4 * ROW_BYTES + 0] = 0x74;    // pixel (1,4) becomes grey 7
    const Band band = changedRows(prev.data(), cur.data(), ROW_BYTES, ROWS);
    assert(band.first == 2 && band.last == 4 && band.rows() == 3);

    // Erase image: old level only where a pixel changed; unchanged ink is paper.
    assert(buildMasked(prev.data(), cur.data(), out.data(), ROW_BYTES, band, true) == 2);
    assert(out[2 * ROW_BYTES + 3] == 0xF0);   // drive the black pixel out
    assert(out[4 * ROW_BYTES + 0] == 0xFF);   // grey 4 unchanged -> undriven; (1,4) was paper
    assert(out[3 * ROW_BYTES + 0] == 0xFF);   // untouched row in the band is paper
    assert(out[0] == 0x00 && out[5 * ROW_BYTES] == 0x00);   // outside the band: not written

    // Draw image: new level only where a pixel changed.
    buildMasked(prev.data(), cur.data(), out.data(), ROW_BYTES, band, false);
    assert(out[2 * ROW_BYTES + 3] == 0xFF);   // now paper: nothing to draw
    assert(out[4 * ROW_BYTES + 0] == 0x7F);   // only (1,4) gets grey 7; (0,4) left alone
    assert(maskedByte(0x12, 0x12, 0x12) == 0xFF);
    assert(maskedByte(0x12, 0x32, 0x32) == 0x3F);

    // A change in the last row only.
    std::vector<uint8_t> a(ROW_BYTES * ROWS, 0xFF), b(a);
    b[ROWS * ROW_BYTES - 1] = 0x0F;
    const Band tail = changedRows(a.data(), b.data(), ROW_BYTES, ROWS);
    assert(tail.first == ROWS - 1 && tail.last == ROWS - 1);
}

void epd47Bands() {
    using namespace AgentDeckEpd47;
    constexpr uint16_t ROW_BYTES = 4, ROWS = 200;
    std::vector<uint8_t> a(ROW_BYTES * ROWS, 0xFF), b(a);
    Band bands[3];
    assert(changedBands(a.data(), b.data(), ROW_BYTES, ROWS, bands, 3, 40) == 0);
    auto touch = [&](uint16_t row) { b[row * ROW_BYTES] = 0x00; };
    // A stamp at rows 5-8 and a change at 150-152: two short bands, not 5..152.
    for (uint16_t r = 5; r <= 8; r++) touch(r);
    for (uint16_t r = 150; r <= 152; r++) touch(r);
    assert(changedBands(a.data(), b.data(), ROW_BYTES, ROWS, bands, 3, 40) == 2);
    assert(bands[0].first == 5 && bands[0].last == 8);
    assert(bands[1].first == 150 && bands[1].last == 152);
    // Runs within the gap merge.
    touch(40);
    assert(changedBands(a.data(), b.data(), ROW_BYTES, ROWS, bands, 3, 40) == 2);
    assert(bands[0].first == 5 && bands[0].last == 40);
    // Out of slots: later runs fold into the last band, nothing is dropped.
    touch(100);
    touch(199);
    assert(changedBands(a.data(), b.data(), ROW_BYTES, ROWS, bands, 3, 40) == 3);
    assert(bands[2].first == 150 && bands[2].last == 199);
    assert(changedBands(a.data(), b.data(), ROW_BYTES, ROWS, bands, 2, 40) == 2);
    assert(bands[1].first == 100 && bands[1].last == 199);
    // Every changed row is inside some band.
    uint8_t n = changedBands(a.data(), b.data(), ROW_BYTES, ROWS, bands, 3, 40);
    for (uint16_t r = 0; r < ROWS; r++) {
        if (a[r * ROW_BYTES] == b[r * ROW_BYTES]) continue;
        bool covered = false;
        for (uint8_t i = 0; i < n; i++) covered |= r >= bands[i].first && r <= bands[i].last;
        assert(covered);
    }
}

void nmGate() {
    using namespace AgentDeckNm;
    GateInput in;
    in.sincePaintStartMs = 60000;
    in.sincePaintEndMs = 47000;
    // Routine churn waits for the ambient floor.
    assert(!shouldPaint(in));
    in.sincePaintStartMs = AMBIENT_FLOOR_MS;
    assert(shouldPaint(in));
    in.sincePaintStartMs = 60000;
    // The reader asked: now.
    in.userAction = true;
    in.sincePaintEndMs = 0;
    assert(shouldPaint(in));
    in.userAction = false;
    // A session newly needing the reader bypasses the floor, but not the gap
    // after the previous cycle ended (the measured back-to-back pairs).
    in.attentionRose = true;
    in.sincePaintEndMs = 500;
    assert(!shouldPaint(in));
    in.sincePaintEndMs = URGENT_GAP_MS;
    assert(shouldPaint(in));
    in.attentionRose = false;
    in.linkChanged = true;
    in.sincePaintEndMs = URGENT_GAP_MS - 1;
    assert(!shouldPaint(in));
    in.linkChanged = false;
    in.countSettled = true;
    in.sincePaintEndMs = URGENT_GAP_MS;
    assert(shouldPaint(in));
    GateInput first;
    first.firstPaint = true;
    first.sincePaintEndMs = 0;
    assert(shouldPaint(first));
}

void hostClock() {
    using HostClock::Clock;
    using HostClock::parseHm;
    assert(parseHm("00:00") == 0 && parseHm("23:59") == 23 * 60 + 59 && parseHm("09:05") == 545);
    assert(parseHm("24:00") == -1 && parseHm("12:60") == -1 && parseHm("1:05") == -1 &&
           parseHm("12:05:00") == -1 && parseHm("") == -1 && parseHm(nullptr) == -1);

    Clock c;
    c.clear();
    char out[8];
    assert(!c.known() && !c.formatNow(1000, out, sizeof(out)) && out[0] == '\0');
    c.observe("", 1000);       // absent: no information
    c.observe("25:00", 1000);  // malformed: no information
    assert(!c.known());

    c.observe("14:32", 10000);
    assert(c.formatNow(10000, out, sizeof(out)) && std::strcmp(out, "14:32") == 0);
    assert(c.minuteAt(10000 + 59999) == 14 * 60 + 32);
    assert(c.minuteAt(10000 + 60000) == 14 * 60 + 33);
    // The same minute again does not snap the estimate back...
    c.observe("14:32", 40000);
    assert(c.anchorMs == 10000);
    // ...a new minute re-anchors at the boundary.
    c.observe("14:33", 45000);
    assert(c.anchorMs == 45000 && c.minuteAt(45000) == 14 * 60 + 33);
    // Midnight wraps.
    c.observe("23:59", 100000);
    assert(c.formatNow(100000 + 60000, out, sizeof(out)) && std::strcmp(out, "00:00") == 0);
    // "since" is the last host contact, not now.
    assert(c.formatLastObserved(out, sizeof(out)) && std::strcmp(out, "23:59") == 0);
    c.observe(nullptr, 900000);
    assert(c.formatLastObserved(out, sizeof(out)) && std::strcmp(out, "23:59") == 0);
    assert(!Clock::format(5, out, 4));   // too small for "HH:MM"
}

void radioPark() {
    using namespace RadioPark;
    Input in;
    in.uptimeMs = 60000;
    // Serial primary: park once it has been stable for a few seconds.
    in.serialPrimary = true;
    in.serialStableMs = 1000;
    assert(decide(in) == Action::None);
    in.serialStableMs = PARK_AFTER_MS + 1;
    assert(decide(in) == Action::Park);
    // Already parked: nothing.
    in.parked = true;
    assert(decide(in) == Action::None);
    // The regression: something restarted WiFi behind the loop's back while
    // serial stayed primary. The real state says unparked, so it parks again.
    in.parked = false;
    assert(decide(in) == Action::Park);
    // Serial gone: restore immediately.
    in.serialPrimary = false;
    in.serialStableMs = 0;
    in.parked = true;
    assert(decide(in) == Action::Restore);
    // A deferred-join board waits out the boot grace for serial to speak.
    in.deferBootJoin = true;
    in.uptimeMs = BOOT_GRACE_MS - 1;
    assert(decide(in) == Action::None);
    in.uptimeMs = BOOT_GRACE_MS;
    assert(decide(in) == Action::Restore);
    // Never parked, no serial: leave WiFi alone.
    in.parked = false;
    assert(decide(in) == Action::None);
}

}  // namespace

int main() {
    epd47Residue();
    epd47Diff();
    epd47Bands();
    nmGate();
    hostClock();
    radioPark();
    return 0;
}
