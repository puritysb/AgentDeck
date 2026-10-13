#pragma once
#include <cmath>
#include <cstdio>
#include <cstring>

// TC001-only presentation: one window gets a 2s identity/usage introduction
// and a 4s stationary countdown. The outer page must allow both windows.
namespace MatrixReading {
constexpr float WindowSeconds = 6.0f;
constexpr float PairSeconds = 2.0f * WindowSeconds;
class Clock {
    float elapsed_ = 0;
public:
    float elapsed() const { return elapsed_; }
    void reset() { elapsed_ = 0; }
    bool advance(float dt, bool playing, float duration) {
        if (!playing || !std::isfinite(dt) || dt <= 0) return false;
        elapsed_ += dt;
        if (elapsed_ < duration) return false;
        reset();
        return true;
    }
};
inline bool second(float seconds, bool firstExists, bool secondExists) {
    return secondExists && (!firstExists || std::fmod(seconds, PairSeconds) >= WindowSeconds);
}
inline bool countdown(float seconds) { return std::fmod(seconds, WindowSeconds) >= 2.0f; }

// Relative reset strings only; do not turn unknown dates/words into numbers.
// Bounded parser and stack output: this runs every frame on a no-PSRAM board.
inline void resetText(const char* input, int maxChars, char (&out)[8]) {
    std::snprintf(out, sizeof(out), "--");
    if (!input || !*input) return;
    if (!std::strcmp(input, "now")) { std::snprintf(out, sizeof(out), "NOW"); return; }
    int total = 0, n = 0, lastScale = 1441;
    bool digits = false, any = false;
    for (const char* p = input; *p; ++p) {
        if (*p == ' ') { if (digits) return; continue; }
        if (*p >= '0' && *p <= '9') {
            n = n * 10 + (*p - '0');
            if (n > 999) return;
            digits = true; continue;
        }
        const int scale = (*p == 'd' || *p == 'D') ? 1440 :
                          (*p == 'h' || *p == 'H') ? 60 :
                          (*p == 'm' || *p == 'M') ? 1 : 0;
        if (!digits || !scale || scale >= lastScale) return;
        total += n * scale; lastScale = scale; n = 0; digits = false; any = true;
    }
    if (digits || !any) return;
    const int d = total / 1440, h = total / 60, m = total % 60;
    if (d) std::snprintf(out, sizeof(out), "%dD%dH", d, h % 24);
    else if (h) std::snprintf(out, sizeof(out), "%dH%dM", h, m);
    else std::snprintf(out, sizeof(out), "%dM", m);
    // A three-letter label (MCP) leaves less room. '+' explicitly preserves
    // the lower-bound meaning; never silently clip digits or imply precision.
    if (static_cast<int>(std::strlen(out)) > maxChars) {
        std::snprintf(out, sizeof(out), d ? "%dD+" : "%dH+", d ? d : h);
        if (static_cast<int>(std::strlen(out)) > maxChars)
            std::snprintf(out, sizeof(out), "--");
    }
}
}
