#include "ui/companion/session_glance.h"
#include "ui/companion/ci_companion.h"
#include <cassert>
#include <cstring>
struct Row { const char *state, *question, *activity, *currentTool, *lastEventText; unsigned char ciPhase = 0; };
int main() {
    Row row={"processing", "", "Running tests", "Bash", "Earlier task completed"};
    assert(!strcmp(Companion::glanceText(row), "Running tests"));
    row.activity=""; assert(!strcmp(Companion::glanceText(row), "Bash"));
    row.currentTool=""; assert(!strcmp(Companion::glanceText(row), "Working - waiting for details"));
    row.state="awaiting_permission";row.question="Allow this?";
    assert(!strcmp(Companion::glanceText(row), "Allow this?"));
    row.state="idle";assert(!strcmp(Companion::glanceText(row), "Earlier task completed"));
    row.lastEventText="";assert(!strcmp(Companion::glanceText(row), "Ready for the next task"));
    row.ciPhase=1;row.activity="CI wait";
    assert(!strcmp(Companion::glanceText(row), "CI wait"));
    row.state="awaiting_permission";row.question="Allow this?";
    assert(!strcmp(Companion::glanceText(row), "Allow this?"));
    row.ciPhase=0;
    // An error's supplied activity is its diagnostic; clear the prior CI
    // fixture before testing the no-diagnostic fallback.
    row.state="error";row.activity="Build failed";
    assert(!strcmp(Companion::glanceText(row), "Build failed"));
    row.activity="";
    assert(!strcmp(Companion::glanceText(row), "Check this session"));
    CiCompanion::Memo memo;
    const uint32_t key = CiCompanion::sessionHash("real-session");
    assert(CiCompanion::moving(CiWaitVisual::RUNNING));
    assert(!CiCompanion::moving(CiWaitVisual::PASSED));
    assert(!CiCompanion::moving(CiWaitVisual::FAILED));
    assert(CiCompanion::visible(memo, key, CiWaitVisual::RUNNING, 1));
    assert(CiCompanion::visible(memo, key, CiWaitVisual::PASSED, 2));
    const float stopped = memo.angle;
    assert(CiCompanion::visible(memo, key, CiWaitVisual::PASSED, 3));
    assert(memo.angle == stopped);
    assert(!CiCompanion::visible(memo, key, CiWaitVisual::PASSED, 7));
    assert(!CiCompanion::visible(memo, key, CiWaitVisual::NONE, 8));
    assert(!memo.occupied);
    assert(CiCompanion::visible(memo, key, CiWaitVisual::FAILED, 9));
    assert(CiCompanion::visible(memo, key, CiWaitVisual::QUEUED, 10));
    const float queued = memo.angle;
    assert(CiCompanion::visible(memo, key, CiWaitVisual::RUNNING, 10));
    assert(memo.angle == queued);
}
