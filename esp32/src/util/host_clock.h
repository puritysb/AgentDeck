#pragma once

#include <stdint.h>
#include <stdio.h>

// Host-local wall clock for boards that have no usable clock of their own.
//
// A board on USB serial parks its radio, so it never reaches NTP, and even an
// NTP-synced board runs on UTC while every time the reader sees elsewhere (the
// timeline's `localHm`) is host-local. The daemons therefore stamp their
// periodic `display_state` re-sync with `hostHm` ("HH:MM", host-local), and the
// board extrapolates between stamps with millis().
//
// The stamp is minute-truncated, so a fresh anchor can be up to 59 s early. The
// estimate is re-anchored only when the observed minute differs from the
// estimated one: with a stamp every 5 s (serial) or 15 s (WiFi) the minute
// boundary is caught within one interval, and between boundaries the estimate
// keeps advancing smoothly instead of snapping back to the truncated value.
//
// Data-only and allocation-free so host tests execute the exact rule the
// firmware runs.
namespace HostClock {

constexpr uint16_t MINUTES_PER_DAY = 24 * 60;

// Parses "HH:MM" (24h). Anything else is "no information": -1.
inline int16_t parseHm(const char* hm) {
    if (!hm) return -1;
    if (hm[0] < '0' || hm[0] > '9' || hm[1] < '0' || hm[1] > '9' || hm[2] != ':' ||
        hm[3] < '0' || hm[3] > '9' || hm[4] < '0' || hm[4] > '9' || hm[5] != '\0')
        return -1;
    const int h = (hm[0] - '0') * 10 + (hm[1] - '0');
    const int m = (hm[3] - '0') * 10 + (hm[4] - '0');
    if (h > 23 || m > 59) return -1;
    return (int16_t)(h * 60 + m);
}

// Trivial on purpose: it lives inside DashboardState, which reset()s itself
// with memset. Call clear() before first use.
struct Clock {
    int16_t anchorMinute;    // host-local minute of day at anchorMs; -1 = never seen
    uint32_t anchorMs;       // board millis() when anchorMinute was true
    uint32_t lastObservedMs; // board millis() of the latest accepted stamp

    void clear() { anchorMinute = -1; anchorMs = 0; lastObservedMs = 0; }
    bool known() const { return anchorMinute >= 0; }

    // Minute of day now, or -1 when the host has never told us.
    int16_t minuteAt(uint32_t nowMs) const {
        if (!known()) return -1;
        const uint32_t elapsedMin = (uint32_t)(nowMs - anchorMs) / 60000u;
        return (int16_t)((anchorMinute + elapsedMin) % MINUTES_PER_DAY);
    }

    // Absent or malformed stamps change nothing (retain-on-absent).
    void observe(const char* hm, uint32_t nowMs) {
        const int16_t minute = parseHm(hm);
        if (minute < 0) return;
        lastObservedMs = nowMs;
        if (minute != minuteAt(nowMs)) {
            anchorMinute = minute;
            anchorMs = nowMs;
        }
    }

    static bool format(int16_t minute, char* out, size_t outLen) {
        if (!out || outLen == 0) return false;
        out[0] = '\0';
        if (minute < 0 || outLen < 6) return false;
        snprintf(out, outLen, "%02u:%02u", (unsigned)(minute / 60), (unsigned)(minute % 60));
        return true;
    }

    // "HH:MM" now. Empty string when unknown — callers draw nothing.
    bool formatNow(uint32_t nowMs, char* out, size_t outLen) const {
        return format(minuteAt(nowMs), out, outLen);
    }

    // "HH:MM" of the last stamp the host sent: the moment the link was last
    // known alive. The OFFLINE face prints it as "since".
    bool formatLastObserved(char* out, size_t outLen) const {
        return format(known() ? minuteAt(lastObservedMs) : -1, out, outLen);
    }
};

}  // namespace HostClock
