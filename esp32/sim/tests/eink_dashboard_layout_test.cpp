#include <cassert>

#include "ui/eink/eink_dashboard_layout.h"
#include "ui/eink/epd47_page_policy.h"
#include "ui/eink/epd47_refresh_policy.h"

using AgentDeckEink::LayoutInput;
using AgentDeckEink::makeLayout;

int main() {
    using AgentDeckEpd47::Page;
    // Starting/stopping work never navigates the home, even under attention.
    for (uint8_t attention = 0; attention < 4; attention++) {
        for (uint8_t working = 0; working < 10; working++) {
            assert(AgentDeckEpd47::automaticPage(attention, working) == Page::Home);
        }
    }
    // EPD47 refresh policy. Differential frame replacements must accumulate
    // toward — never postpone — the next real pigment reset.
    using AgentDeckEpd47::Erase;
    {
        AgentDeckEpd47::RefreshState state;
        constexpr uint8_t EVERY = 4;
        constexpr uint32_t MAX_AGE = 600000;
        assert(AgentDeckEpd47::hardClearDue(state, true, 10, EVERY, MAX_AGE));
        AgentDeckEpd47::recordErase(state, Erase::ClearAll, 10);
        assert(state.differentialCount == 0);
        assert(state.lastHardClearMs == 10);

        for (uint8_t i = 0; i < EVERY; ++i) {
            AgentDeckEpd47::recordErase(state, Erase::Differential, 20 + i);
            if (i + 1 < EVERY)
                assert(!AgentDeckEpd47::hardClearDue(state, false, 100, EVERY, MAX_AGE));
        }
        assert(state.differentialCount == EVERY);
        assert(state.lastHardClearMs == 10);  // page/content changes never reset age
        assert(AgentDeckEpd47::hardClearDue(state, false, 100, EVERY, MAX_AGE));
        assert(AgentDeckEpd47::chooseErase(true) == Erase::ClearAll);
        assert(AgentDeckEpd47::chooseErase(false) == Erase::Differential);
    }
    {
        // A stream of page replacements cannot starve the ten-minute clear.
        AgentDeckEpd47::RefreshState state;
        AgentDeckEpd47::recordErase(state, Erase::ClearAll, 1000);
        AgentDeckEpd47::recordErase(state, Erase::Differential, 590000);
        assert(state.lastHardClearMs == 1000);
        assert(AgentDeckEpd47::hardClearDue(state, false, 601001, 255, 600000));
    }
    {
        // Unsigned age calculation remains correct across millis() rollover.
        AgentDeckEpd47::RefreshState state;
        state.lastHardClearMs = 0xFFFFFFFFu - 1000u;
        assert(!AgentDeckEpd47::hardClearDue(state, false, 500u, 4, 2000u));
        assert(AgentDeckEpd47::hardClearDue(state, false, 1500u, 4, 2000u));
    }

    const auto trmnl_75 = makeLayout(LayoutInput{800, 480, 68, 0, 28, 21, 2, 1, 6, 2});
    assert(!trmnl_75.portrait);
    assert(trmnl_75.columns == 3);
    assert(trmnl_75.rows == 2);
    assert(trmnl_75.capacity == 6);
    assert(trmnl_75.card(0).x == trmnl_75.cards.x);
    assert(trmnl_75.card(5).bottom() <= trmnl_75.cards.bottom());

    const auto x3 = makeLayout(LayoutInput{528, 792, 64, 52, 24, 20, 2, 0, 6, 5});
    assert(x3.portrait);
    assert(x3.columns == 1);
    assert(x3.rows >= 4);
    assert(x3.card(1).y > x3.card(0).y);
    assert(x3.cards.bottom() <= x3.usage.y);

    const auto x4 = makeLayout(LayoutInput{800, 480, 64, 44, 24, 20, 1, 0, 4, 2});
    assert(!x4.portrait);
    assert(x4.columns == 2);
    assert(x4.capacity == 4);
    assert(x4.controls.bottom() == 480);

    const auto empty = makeLayout(LayoutInput{528, 792, 64, 52, 24, 20, 0, 0, 0, 5});
    assert(empty.capacity >= 1);
    assert(empty.card(0).w > 0);
    assert(empty.card(1).empty());
    return 0;
}
