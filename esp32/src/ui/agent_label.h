// agent_label.h — on-device mirror of shared/src/timeline-label.ts
// `agentDisplayLabel`. The ONE place ESP32 turns an agentType id into a
// human-readable brand name, so the InkDeck ticker, IPS10 mosaic card, and any
// future timeline surface stop hand-rolling the same map. Keep in lockstep with
// the TS SSOT (shared/src/timeline-label.ts) and the Swift/Kotlin mirrors.
//
// Header-only + inline so every translation unit can include it without a
// link-time symbol. No dynamic allocation.
#pragma once
#include <string.h>

// claude-code → "Claude", codex-cli → "Codex CLI", etc. Returns "Agent" for
// null/empty/unknown so a row never renders an empty brand.
inline const char* agentDisplayLabel(const char* agentType) {
    if (!agentType || agentType[0] == '\0') return "Agent";
    if (strcmp(agentType, "claude-code") == 0) return "Claude";
    if (strcmp(agentType, "openclaw")    == 0) return "OpenClaw";
    if (strcmp(agentType, "codex-cli")   == 0) return "Codex CLI";
    if (strcmp(agentType, "codex-app")   == 0) return "Codex App";
    if (strcmp(agentType, "opencode")    == 0) return "OpenCode";
    if (strcmp(agentType, "antigravity") == 0) return "Antigravity";
    if (strcmp(agentType, "kiro-cli")    == 0) return "Kiro CLI";
    if (strcmp(agentType, "kiro-ide")    == 0) return "Kiro IDE";
    if (strcmp(agentType, "monitor")     == 0) return "Monitor";
    if (strcmp(agentType, "daemon")      == 0) return "Daemon";
    return agentType; // unknown but non-empty — show the raw id rather than "Agent"
}

// Compact brand for tight surfaces (LED matrix / narrow ticker): drops the
// CLI/App suffix. Mirrors `agentShortLabel` in the TS SSOT.
inline const char* agentShortLabel(const char* agentType) {
    if (agentType && (strcmp(agentType, "codex-cli") == 0 ||
                      strcmp(agentType, "codex-app") == 0)) return "Codex";
    if (agentType && (strcmp(agentType, "kiro-cli") == 0 ||
                      strcmp(agentType, "kiro-ide") == 0)) return "Kiro";
    return agentDisplayLabel(agentType);
}
