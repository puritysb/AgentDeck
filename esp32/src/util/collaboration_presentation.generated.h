// GENERATED from shared/src/collaboration-presentation.ts. DO NOT EDIT.
#pragma once
namespace CollaborationPresentation {
static constexpr const char* Heading = "Collaboration";
static constexpr const char* Scope = "Live session census";
static constexpr const char* Labels[] = {"Subagents active","Done this wave","Spawned running","Jobs waited on"};
inline int phase(bool attention, bool working, int children, int spawned, int jobs) { return attention ? 0 : working ? 1 : children > 0 || spawned > 0 || jobs > 0 ? 2 : 3; }
}
