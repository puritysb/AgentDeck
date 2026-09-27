#include "ui/companion/session_glance.h"
#include <cassert>
#include <cstring>
struct Row { const char *state, *question, *activity, *currentTool, *lastEventText; };
int main() {
    Row row={"processing", "", "Running tests", "Bash", "Earlier task completed"};
    assert(!strcmp(Companion::glanceText(row), "Running tests"));
    row.activity=""; assert(!strcmp(Companion::glanceText(row), "Bash"));
    row.currentTool=""; assert(!strcmp(Companion::glanceText(row), "Working - waiting for details"));
    row.state="awaiting_permission";row.question="Allow this?";
    assert(!strcmp(Companion::glanceText(row), "Allow this?"));
    row.state="idle";assert(!strcmp(Companion::glanceText(row), "Earlier task completed"));
    row.lastEventText="";assert(!strcmp(Companion::glanceText(row), "Ready for the next task"));
    row.state="error";assert(!strcmp(Companion::glanceText(row), "Check this session"));
}
