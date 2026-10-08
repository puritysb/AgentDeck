#define BOARD_TTGO 1
#include "ui/companion/ci_companion.h"
#include <cassert>
#include <cmath>
int main() {
    using namespace CiCompanion;
    static_assert(sizeof(Memo[10]) == 160, "Keep ten CI owners without overflowing TTGO DRAM");
    Memo memo;
    const uint32_t key = sessionHash("actual/session");
    assert(visible(memo, key, CiWaitVisual::QUEUED, 100));
    const float seed = memo.angle;
    assert(visible(memo, key, CiWaitVisual::QUEUED, 101));
    assert(visible(memo, key, CiWaitVisual::RUNNING, 102));
    assert(fabsf(memo.angle - seed - 2 * TerrariumRules::CiCompanionRadiansPerSecond * TerrariumRules::CiCompanionQueuedSpeed) < 0.00001f);
    assert(visible(memo, key, CiWaitVisual::RUNNING, 103));
    assert(visible(memo, key, CiWaitVisual::UNKNOWN, 104));
    assert(visible(memo, key, CiWaitVisual::FAILED, 105));
    const float resultAngle = memo.angle;
    assert(visible(memo, key, CiWaitVisual::FAILED, 106));
    assert(memo.lastAt == 105 && memo.angle == resultAngle);
    assert(!visible(memo, key, CiWaitVisual::FAILED, 109));
    assert(!visible(memo, key, CiWaitVisual::FAILED, 170)); // repeated results never re-arm
    assert(visible(memo, key, CiWaitVisual::PASSED, 171)); // new verdict has its own bound
    assert(!visible(memo, key, CiWaitVisual::NONE, 172) && !memo.occupied);
    assert(visible(memo, key, CiWaitVisual::QUEUED, 200));
    assert(visible(memo, key, CiWaitVisual::QUEUED, 199)); // clock rollback re-seeds
    assert(fabsf(memo.angle - seed) < 0.00001f);
    assert(visible(memo, 0, CiWaitVisual::RUNNING, 201)); // zero is a valid owner hash
    assert(visible(memo, 0, CiWaitVisual::RUNNING, 202));
    assert(memo.occupied && memo.key == 0 && fabsf(memo.angle - TerrariumRules::CiCompanionRadiansPerSecond) < 0.00001f);
}
