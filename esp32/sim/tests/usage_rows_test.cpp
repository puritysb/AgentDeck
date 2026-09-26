#include "util/usage_rows.h"
#include <cassert>

int main() {
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
