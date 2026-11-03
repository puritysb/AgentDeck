#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace MdnsPolicy {
// Full factory MAC avoids collisions between boards with equal low bytes.
inline bool hostname(char* out, std::size_t size, uint64_t mac) {
    mac &= UINT64_C(0xffffffffffff);
    if (!out || !size || !mac) return false;
    const int count = std::snprintf(out, size, "agentdeck-display-%012llx", static_cast<unsigned long long>(mac));
    return count > 0 && static_cast<std::size_t>(count) < size;
}
// Bounded stack policy; no allocation on PSRAM or no-PSRAM boards. Duplicate
// advertisements for one endpoint are one choice, regardless of reply order.
class Choice {
    struct Candidate {
        int index = -1;
        char ip[16] = {};
        uint16_t port = 0;
        bool ambiguous = false;
        void add(int i, const char* host, uint16_t p) {
            if (index < 0) { index = i; std::snprintf(ip, sizeof(ip), "%s", host); port = p; }
            else if (p != port || std::strcmp(ip, host) != 0) ambiguous = true;
        }
    } daemon, other;
    const char* preferred;
    uint16_t preferredPort;
    int match = -1;
public:
    Choice(const char* host, uint16_t port) : preferred(host), preferredPort(port) {}
    void consider(int index, const char* host, uint16_t port, bool isDaemon) {
        if (!host || !host[0] || std::strlen(host) >= sizeof(daemon.ip) || !port) return;
        if (preferred && preferred[0] && port == preferredPort && std::strcmp(host, preferred) == 0) { if (match < 0) match = index; }
        (isDaemon ? daemon : other).add(index, host, port);
    }
    int selected() const {
        if (preferred && preferred[0]) return match;
        const Candidate& candidate = daemon.index >= 0 ? daemon : other;
        return candidate.ambiguous ? -1 : candidate.index;
    }
};
}  // namespace MdnsPolicy
