#pragma once
#include "terrarium/creature_glyphs_generated.h"
#include <cstddef>
#include <cstring>

namespace CreatureGlyphs {
struct Selection { const uint8_t* alpha; const FeatureLayer* features; size_t featureCount; bool lightMonoBody = false; };
// Internal linkage keeps references to this translation unit's flash-backed masks.
// Unknown wire IDs have no creature; provider aliases are explicit rather than prefixes.
static inline Selection selectAgent(const char* agent) {
    if (!agent || !agent[0]) return {nullptr, nullptr, 0};
    if (!strcmp(agent, "claude-code") || !strcmp(agent, "claude"))
        return {OCTOPUS_A8, OCTOPUS_FEATURES, OCTOPUS_FEATURE_COUNT, OCTOPUS_MONO_LIGHT_BODY};
    if (!strcmp(agent, "codex-cli") || !strcmp(agent, "codex-app") || !strcmp(agent, "codex"))
        return {CODEX_A8, CODEX_FEATURES, CODEX_FEATURE_COUNT, CODEX_MONO_LIGHT_BODY};
    if (!strcmp(agent, "openclaw")) return {OPENCLAW_MARK_A8, OPENCLAW_MARK_FEATURES, OPENCLAW_MARK_FEATURE_COUNT, OPENCLAW_MARK_MONO_LIGHT_BODY};
    if (!strcmp(agent, "opencode")) return {OPENCODE_A8, OPENCODE_FEATURES, OPENCODE_FEATURE_COUNT};
    if (!strcmp(agent, "antigravity")) return {ANTIGRAVITY_A8, nullptr, 0};
    if (!strcmp(agent, "kiro-cli") || !strcmp(agent, "kiro-ide") || !strcmp(agent, "kiro")) return {KIRO_A8, nullptr, 0};
    if (!strcmp(agent, "hermes")) return {HERMES_A8, nullptr, 0};
    if (!strcmp(agent, "zai")) return {ZAI_A8, nullptr, 0};
    return {nullptr, nullptr, 0};
}
}
