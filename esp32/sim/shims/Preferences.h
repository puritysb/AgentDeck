#pragma once
#include <cstdint>
#include <cstddef>

// Codec persistence test double; the rendering simulator uses sim_globals.
class Preferences {
public:
    static inline uint8_t stored = 255;
    static inline bool openOk = true, writeOk = true;
    static inline int writes = 0;
    bool begin(const char*, bool) { return openOk; }
    uint8_t getUChar(const char*, uint8_t fallback) { return stored == 255 ? fallback : stored; }
    size_t putUChar(const char*, uint8_t value) {
        ++writes;
        if (!writeOk) return 0;
        stored = value;
        return 1;
    }
    void end() {}
};
