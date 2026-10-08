#pragma once
#include <string.h>

// Allocation-free glance policy shared by firmware surfaces. Processing never
// reads an earlier turn's milestone as current work; idle never claims completion.
namespace Companion {
template <typename Session> inline const char* glanceText(const Session& s) {
    if (strstr(s.state, "awaiting")) return s.question[0] ? s.question : "Needs your input";
    if (s.ciPhase && s.activity[0]) return s.activity;
    if (!strcmp(s.state, "processing")) {
        if (s.activity[0]) return s.activity;
        if (s.currentTool[0]) return s.currentTool;
        return "Working - waiting for details";
    }
    if (!strcmp(s.state, "error")) return s.activity[0] ? s.activity : "Check this session";
    return s.lastEventText[0] ? s.lastEventText : "Ready for the next task";
}
}
