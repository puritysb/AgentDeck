#pragma once
#include "util/usage_severity.generated.h"
// One provider-grouped usage model for every ESP32 USAGE surface.
//
// Surfaces used to read g_state's quota fields directly, and drifted: some
// hid z.ai's MCP window, only IPS10 knew the Luna reserve, and plan names
// were squeezed into a single footer instead of the slot a missing window
// frees. This header owns those display rules once; renderers only lay out
// the groups they are given.
//
//   * A group exists when its provider has a window OR a reported plan —
//     hide-if-absent, never a "--" ghost.
//   * Claude: 5h / 7d.
//   * Codex: its two windows labelled by length. While an account window is
//     exhausted, what the account spends instead replaces both windows:
//     purchased credits (UsagePresentation::creditsActive — a positive
//     balance, never a "0") and/or the Luna reserve (lunaActive, read as
//     "% left"). Credits come FIRST: a surface that keeps one Codex reading
//     (rows[0], or a band that trims second rows) then shows what is actually
//     being spent, which is the shared precedence rule
//     (shared/src/usage-presentation.ts selectedCodexCredits).
//   * z.ai: 5h + the long window, labelled "MCP" when it meters tool calls.
//   * Antigravity: plan only (two-pool quota stays backend-only).
//   * `tier` / `until` carry the provider's plan so a surface can put it in
//     the slot a missing window leaves (e.g. a Codex plan without a 5h limit).
//
// Callers hold the state lock (or pass a snapshot copy).

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "../state/agent_state.h"
#include "usage_format.h"
#include "usage_presentation.generated.h"

namespace UsageRows {

enum Provider : uint8_t { CLAUDE = 0, CODEX = 1, ZAI = 2, ANTIGRAVITY = 3 };

struct Row {
    char label[8];   // "5h", "7d", "MCP", "Luna", "Credits"
    float used;      // 0-100 consumed (0 for a credits row — it has no cap)
    bool left;       // render as remaining ("% left") — the Luna reserve
    // A purchased-credit balance, not a percentage: surfaces print `value`
    // ("62.5K") instead of "N%" and draw no bar or severity ramp — the API
    // exposes no cap, so any fill would be invented.
    bool credits;
    char value[8];   // credits: formatted balance; otherwise ""
    char reset[20];  // relative countdown or "" (credits: when the plan window returns)
    // The value a surface prints and fills: remaining for `left`, else used.
    // A credits row has no percentage; 0 keeps a careless bar empty.
    int shown() const {
        if (credits) return 0;
        const float v = left ? 100.0f - used : used;
        return v < 0 ? 0 : v > 100 ? 100 : static_cast<int>(v + 0.5f);
    }
    // Whether this row is a percentage gauge a surface may fill.
    bool hasBar() const { return !credits; }
    // Near or at the limit; a remaining reserve uses the same consumed basis.
    // A credits row is only shown while a balance remains: never critical.
    bool critical() const { return !credits && UsageSeverity::level(used) == UsageSeverity::Critical; }
    // "62.5K" for credits, "68% left" / "94%" otherwise — the value text for
    // surfaces with room for the "left" suffix.
    void valueText(char* out, size_t outLen) const {
        if (credits) snprintf(out, outLen, "%s", value);
        else snprintf(out, outLen, left ? "%d%% left" : "%d%%", shown());
    }
};

struct Group {
    Provider provider;
    Row rows[2];
    uint8_t rowCount;
    char tier[24];   // "Max", "Pro", "Lite" — "" when unreported
    char until[12];  // "~7/28" — "" when unreported
    const char* name() const { return UsagePresentation::Providers[provider]; }
    // A plan is worth a slot when it says something: a tier or an expiry.
    bool hasPlan() const { return tier[0] != '\0' || until[0] != '\0'; }
};

static constexpr uint8_t MAX_GROUPS = 4;

inline void windowLabel(int minutes, const char* fallback, char* out, size_t outLen) {
    if (minutes > 0 && minutes % 1440 == 0) snprintf(out, outLen, "%dd", minutes / 1440);
    else if (minutes > 0 && minutes % 60 == 0) snprintf(out, outLen, "%dh", minutes / 60);
    else if (minutes > 0) snprintf(out, outLen, "%dm", minutes);
    else snprintf(out, outLen, "%s", fallback);
}

inline void addRow(Group& g, const char* label, float used, const char* reset, bool left = false) {
    if (used < 0.0f || g.rowCount >= 2) return;
    Row& r = g.rows[g.rowCount++];
    snprintf(r.label, sizeof(r.label), "%s", label);
    r.used = used;
    r.left = left;
    r.credits = false;
    r.value[0] = '\0';
    snprintf(r.reset, sizeof(r.reset), "%s", reset ? reset : "");
}

// Minutes in a storeResetTime countdown ("2d 4h", "3h 5m", "45m", "now");
// -1 when empty or unparseable. Lets the latest of two relative resets win
// without the ISO instants, which the serial payload never carries.
inline int resetMinutes(const char* reset) {
    if (!reset || !reset[0]) return -1;
    if (!strcmp(reset, "now")) return 0;
    int total = 0, n = 0;
    bool digits = false;
    for (const char* c = reset; *c; ++c) {
        if (*c >= '0' && *c <= '9') { n = n * 10 + (*c - '0'); digits = true; continue; }
        if (!digits) { if (*c == ' ') continue; return -1; }
        if (*c == 'd') total += n * 1440;
        else if (*c == 'h') total += n * 60;
        else if (*c == 'm') total += n;
        else return -1;
        n = 0; digits = false;
    }
    return digits ? -1 : total;
}

// Purchased credits while they replace an exhausted plan window. The reset is
// the LATEST exhausted window's: credits are spent until every exhausted
// window is back (selectedCodexCredits). Every ESP32 font (GFX FreeFonts,
// LVGL Montserrat subsets, the 3x5 matrix font) lacks U+221E, so an unlimited
// balance is spelled "UNL" here, once, instead of per renderer.
inline void addCreditsRow(Group& g, const DashboardState& s) {
    if (g.rowCount >= 2) return;
    Row& r = g.rows[g.rowCount++];
    snprintf(r.label, sizeof(r.label), "Credits");
    r.used = 0.0f;
    r.left = false;
    r.credits = true;
    if (std::isinf(s.codexCreditBalance)) snprintf(r.value, sizeof(r.value), "UNL");
    else UsagePresentation::formatCreditBalance(s.codexCreditBalance, r.value, sizeof(r.value));
    const char* reset = "";
    int latest = -1;
    if (s.codexPrimaryPercent >= 100 && resetMinutes(s.codexPrimaryReset) > latest) {
        latest = resetMinutes(s.codexPrimaryReset); reset = s.codexPrimaryReset;
    }
    if (s.codexSecondaryPercent >= 100 && resetMinutes(s.codexSecondaryReset) > latest) {
        reset = s.codexSecondaryReset;
    }
    snprintf(r.reset, sizeof(r.reset), "%s", reset);
}

inline bool codexCreditsActive(const DashboardState& s) {
    return UsagePresentation::creditsActive(s.codexPrimaryPercent, s.codexSecondaryPercent, s.codexCreditBalance);
}

// The credits text a Codex surface shows ("62.5K"), or "" when credits are not
// what the account is spending. Redraw signatures fold this in, so a balance
// that moves (or appears) repaints without hashing every float.
inline void codexCreditsKey(const DashboardState& s, char* out, size_t outLen) {
    if (!out || outLen == 0) return;
    out[0] = '\0';
    if (!codexCreditsActive(s)) return;
    if (std::isinf(s.codexCreditBalance)) snprintf(out, outLen, "UNL");
    else UsagePresentation::formatCreditBalance(s.codexCreditBalance, out, outLen);
}

inline void attachPlan(const DashboardState& s, Group& g) {
    g.tier[0] = g.until[0] = '\0';
    for (uint8_t i = 0; i < s.subscriptionCount && i < 4; ++i) {
        const auto& sub = s.subscriptions[i];
        if (UsagePresentation::subscriptionProvider(sub.name) != g.provider) continue;
        UsagePresentation::subscriptionTier(sub.name, g.tier, sizeof(g.tier));
        snprintf(g.until, sizeof(g.until), "%s", sub.until);
        return;
    }
    if (g.provider == ANTIGRAVITY && s.antigravityPlan[0])
        UsagePresentation::subscriptionTier(s.antigravityPlan, g.tier, sizeof(g.tier));
}

// Fill `out` (MAX_GROUPS) in the fixed Claude → Codex → z.ai → Antigravity
// order and return how many groups are present. `includeMcp=false` lets a
// surface too small for a second z.ai row drop only that window.
inline uint8_t build(const DashboardState& s, Group* out, bool includeMcp = true) {
    uint8_t n = 0;
    char label[8];
    for (uint8_t p = CLAUDE; p <= ANTIGRAVITY; ++p) {
        Group& g = out[n];
        memset(&g, 0, sizeof(g));
        g.provider = static_cast<Provider>(p);
        if (p == CLAUDE && !s.usageStale) {
            addRow(g, "5h", s.fiveHourPercent, s.fiveHourReset);
            addRow(g, "7d", s.sevenDayPercent, s.sevenDayReset);
        } else if (p == CODEX) {
            const bool credits = codexCreditsActive(s);
            const bool luna = UsagePresentation::lunaActive(s.codexPrimaryPercent, s.codexSecondaryPercent, s.codexLunaPercent);
            if (credits || luna) {
                if (credits) addCreditsRow(g, s);
                if (luna) addRow(g, "Luna", s.codexLunaPercent, s.codexLunaReset, true);
            } else {
                windowLabel(s.codexPrimaryMinutes, "Credits", label, sizeof(label));
                addRow(g, label, s.codexPrimaryPercent, s.codexPrimaryReset);
                windowLabel(s.codexSecondaryMinutes, "Credits", label, sizeof(label));
                addRow(g, label, s.codexSecondaryPercent, s.codexSecondaryReset);
            }
        } else if (p == ZAI) {
            addRow(g, "5h", s.zaiPrimaryPercent, s.zaiPrimaryReset);
            if (s.zaiSecondaryIsMcp) {
                if (includeMcp) addRow(g, "MCP", s.zaiSecondaryPercent, s.zaiSecondaryReset);
            } else {
                windowLabel(s.zaiSecondaryMinutes, "7d", label, sizeof(label));
                addRow(g, label, s.zaiSecondaryPercent, s.zaiSecondaryReset);
            }
        }
        attachPlan(s, g);
        if (g.rowCount || g.hasPlan()) ++n;
    }
    return n;
}

// A grid surface's cell: one window row, or (row < 0) the provider's plan
// tile placed in the slot a missing window leaves.
struct Tile { const Group* group; int8_t row; bool isPlan() const { return row < 0; } };

// Flatten groups into at most `cap` tiles in provider order. Every window
// comes first in priority; a plan tile joins a provider that shows fewer than
// two windows (or none), as long as the cap leaves room.
inline uint8_t tiles(const Group* groups, uint8_t count, Tile* out, uint8_t cap) {
    uint8_t windows = 0;
    for (uint8_t i = 0; i < count; ++i) windows += groups[i].rowCount;
    int plans = static_cast<int>(cap) - windows;
    uint8_t n = 0;
    for (uint8_t i = 0; i < count && n < cap; ++i) {
        const Group& g = groups[i];
        for (uint8_t r = 0; r < g.rowCount && n < cap; ++r) out[n++] = {&g, static_cast<int8_t>(r)};
        if (g.hasPlan() && g.rowCount < 2 && plans > 0 && n < cap) { out[n++] = {&g, -1}; --plans; }
    }
    return n;
}

// "Pro · ~7/28" / "Pro" / "~7/28" — the plan tile text. `sep` lets fonts
// without U+00B7 pass their own separator.
inline void planText(const Group& g, char* out, size_t outLen, const char* sep = " \xC2\xB7 ") {
    snprintf(out, outLen, "%s%s%s", g.tier, g.tier[0] && g.until[0] ? sep : "", g.until);
}

}  // namespace UsageRows
