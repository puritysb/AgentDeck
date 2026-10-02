#include "util/usage_rows.h"
#include <cassert>
#include <cmath>

// formatCreditBalance vectors — hand-copied from shared/credit-balance-vectors.json
// ("format"), since these assert() mains carry no JSON parser. Keep in step.
static void creditFormatVectors() {
    struct V { double balance; const char* text; };
    static const V vectors[] = {
        {0, "0"}, {-1, "0"}, {0.5, "0.5"}, {7.49, "7.4"}, {9.99, "9.9"}, {10, "10"},
        {950.9, "950"}, {999.99, "999"}, {1000, "1K"}, {1250, "1.2K"}, {62500, "62.5K"},
        {99999, "99.9K"}, {100000, "100K"}, {125000, "125K"}, {999999, "999K"},
        {1000000, "1M"}, {1250000, "1.2M"}, {250000000, "250M"}, {INFINITY, "\xE2\x88\x9E"},
    };
    char out[16];
    for (const V& v : vectors) {
        UsagePresentation::formatCreditBalance(v.balance, out, sizeof(out));
        assert(!strcmp(out, v.text));
    }
    // ... and the "active" vectors.
    assert(UsagePresentation::creditsActive(100, -1, 62500));
    assert(UsagePresentation::creditsActive(-1, 100, 1));
    assert(UsagePresentation::creditsActive(99, 100, 0.5));
    assert(!UsagePresentation::creditsActive(100, 100, 0));
    assert(!UsagePresentation::creditsActive(100, -1, -1));
    assert(!UsagePresentation::creditsActive(99, 99, 62500));
    assert(!UsagePresentation::creditsActive(-1, -1, 62500));
    assert(UsagePresentation::creditsActive(100, -1, INFINITY));
}

static void creditRows() {
    DashboardState s{};
    s.reset();
    UsageRows::Group groups[UsageRows::MAX_GROUPS];
    // The measured Pro shape: weekly at 94% with 62,500 purchased credits.
    s.codexPrimaryPercent = 94; s.codexPrimaryMinutes = 10080;
    strcpy(s.codexPrimaryReset, "2d 4h");
    s.codexCreditBalance = 62500;
    assert(UsageRows::build(s, groups) == 1);
    assert(groups[0].rowCount == 1 && !groups[0].rows[0].credits);
    // Exhausted: credits replace the windows, as text, with no bar.
    s.codexPrimaryPercent = 100;
    UsageRows::build(s, groups);
    const UsageRows::Row& cr = groups[0].rows[0];
    assert(groups[0].rowCount == 1 && cr.credits && !cr.hasBar() && !cr.critical());
    assert(!strcmp(cr.label, "Credits") && !strcmp(cr.value, "62.5K") && cr.shown() == 0);
    assert(!strcmp(cr.reset, "2d 4h"));
    char text[16]; cr.valueText(text, sizeof(text));
    assert(!strcmp(text, "62.5K"));
    // Both pools: credits first (what is being spent), then the Luna reserve.
    s.codexLunaPercent = 32; strcpy(s.codexLunaReset, "4h 50m");
    UsageRows::build(s, groups);
    assert(groups[0].rowCount == 2 && groups[0].rows[0].credits && groups[0].rows[1].left);
    assert(groups[0].rows[1].shown() == 68);
    groups[0].rows[1].valueText(text, sizeof(text));
    assert(!strcmp(text, "68% left"));
    // A zero balance is not spent: nothing but Luna.
    s.codexCreditBalance = 0;
    UsageRows::build(s, groups);
    assert(groups[0].rowCount == 1 && groups[0].rows[0].left);
    // Zero balance, no reserve: the exhausted window itself stays.
    s.codexLunaPercent = -1;
    UsageRows::build(s, groups);
    assert(groups[0].rowCount == 1 && !groups[0].rows[0].credits && groups[0].rows[0].shown() == 100);
    // The LATEST exhausted reset ends credit spending; unlimited is font-safe.
    s.codexCreditBalance = INFINITY;
    s.codexSecondaryPercent = 100; s.codexSecondaryMinutes = 300;
    strcpy(s.codexSecondaryReset, "3h 5m");
    UsageRows::build(s, groups);
    assert(!strcmp(groups[0].rows[0].value, "UNL") && !strcmp(groups[0].rows[0].reset, "2d 4h"));
    strcpy(s.codexPrimaryReset, "45m");
    UsageRows::build(s, groups);
    assert(!strcmp(groups[0].rows[0].reset, "3h 5m"));
    assert(UsageRows::resetMinutes("2d 4h") == 3120 && UsageRows::resetMinutes("now") == 0);
    assert(UsageRows::resetMinutes("") == -1 && UsageRows::resetMinutes("~7/28") == -1);
}

int main() {
    creditFormatVectors();
    creditRows();
    DashboardState s{};
    s.reset();
    UsageRows::Group groups[UsageRows::MAX_GROUPS];
    assert(UsageRows::build(s, groups) == 0);
    s.subscriptionCount = 1;
    strcpy(s.subscriptions[0].name, "Claude");
    assert(UsageRows::build(s, groups) == 0); // provider alone is not a plan
    strcpy(s.subscriptions[0].name, "ChatGPT Pro");
    strcpy(s.subscriptions[0].until, "~10/10");
    s.codexSecondaryPercent = 83;
    s.codexSecondaryMinutes = 10080;
    assert(UsageRows::build(s, groups) == 1);
    assert(groups[0].rowCount == 1 && groups[0].hasPlan());
    assert(!strcmp(groups[0].rows[0].label, "7d"));
    UsageRows::Tile tiles[6];
    assert(UsageRows::tiles(groups, 1, tiles, 6) == 2);
    assert(!tiles[0].isPlan() && tiles[1].isPlan());
    s.codexSecondaryMinutes = 0;
    UsageRows::build(s, groups);
    assert(!strcmp(groups[0].rows[0].label, "Credits"));
    s.codexLunaPercent = 75;
    UsageRows::build(s, groups);
    assert(!groups[0].rows[0].left); // reserve alone does not activate
    s.codexSecondaryPercent = 100;
    UsageRows::build(s, groups);
    assert(groups[0].rowCount == 1 && groups[0].rows[0].left);
    assert(groups[0].rows[0].shown() == 25);
    s.codexLunaPercent = 100;
    s.zaiSecondaryPercent = 100;
    s.zaiSecondaryIsMcp = true;
    assert(UsageRows::build(s, groups) == 2);
    assert(groups[0].rows[0].shown() == 0 && groups[0].rows[0].critical());
    assert(!strcmp(groups[1].rows[0].label, "MCP"));
    s.codexSecondaryPercent = 0;
    UsageRows::build(s, groups);
    assert(!groups[0].rows[0].left && groups[0].rows[0].shown() == 0);
}
