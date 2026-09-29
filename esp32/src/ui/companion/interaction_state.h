#pragma once
#include <cstdint>
#include <cstring>

// Bounded, allocation-free state shared by the two interactive LCD boards.
namespace Companion {
template<unsigned N> inline void copy(char (&dst)[N], const char* src) {
    std::strncpy(dst, src, N - 1); dst[N - 1] = 0;
}
inline bool awaiting(const char* state) { return std::strstr(state, "awaiting") != nullptr; }

// Exact displayed request, not a hash: even a reordered/renamed option must
// invalidate the cursor. Raw question bytes also become the wire echo.
template<unsigned OptionCap> struct Request {
    char id[32]{}, requestId[40]{}, question[160]{}, promptType[20]{}, state[20]{};
    struct Option { char label[64]{}; uint8_t index{}, recommended{}; } options[OptionCap];
    unsigned count{};
    template<class S> void capture(const S& s) {
        copy(id, s.id); copy(requestId, s.requestId); copy(question, s.question);
        copy(promptType, s.promptType); copy(state, s.state);
        count = s.optionCount < OptionCap ? s.optionCount : OptionCap;
        for (unsigned i = 0; i < count; ++i) {
            copy(options[i].label, s.options[i].label);
            options[i].index = s.options[i].index;
            options[i].recommended = s.options[i].recommended;
        }
    }
    template<class S> bool matches(const S& s) const {
        if (std::strcmp(id, s.id) || std::strcmp(requestId, s.requestId) ||
            std::strcmp(question, s.question) || std::strcmp(promptType, s.promptType) ||
            std::strcmp(state, s.state) || count != s.optionCount) return false;
        for (unsigned i = 0; i < count; ++i)
            if (std::strcmp(options[i].label, s.options[i].label) ||
                options[i].index != s.options[i].index ||
                options[i].recommended != s.options[i].recommended) return false;
        return true;
    }
};

// Preserve arrival order across roster reorder; transient transport gaps are
// not resolutions. The caller passes only authoritative connected rosters.
template<unsigned Capacity> struct WaitingQueue {
    char ids[Capacity][32]{};
    unsigned count{};
    int index(const char* id) const {
        for (unsigned i = 0; i < count; ++i) if (!std::strcmp(ids[i], id)) return i;
        return -1;
    }
    template<class S> void refresh(const S* sessions, unsigned n) {
        unsigned keep = 0;
        for (unsigned i = 0; i < count; ++i)
            for (unsigned j = 0; j < n; ++j)
                if (!std::strcmp(ids[i], sessions[j].id) && awaiting(sessions[j].state)) {
                    if (keep != i) copy(ids[keep], ids[i]);
                    ++keep; break;
                }
        count = keep;
        for (unsigned i = 0; i < n && count < Capacity; ++i)
            if (sessions[i].id[0] && awaiting(sessions[i].state) && index(sessions[i].id) < 0)
                copy(ids[count++], sessions[i].id);
    }
};

enum class Receipt { None, Waiting, StateUpdated, RequestChanged, Unconfirmed };
template<unsigned OptionCap> struct PendingReply {
    Request<OptionCap> request;
    bool active{};
    uint32_t sentAt{};
    void begin(const Request<OptionCap>& shown, uint32_t now) { request = shown; sentAt = now; active = true; }
    template<class S> Receipt observe(const S* s, bool connected, uint32_t now) {
        if (!active) return Receipt::None;
        // Absence is not an acknowledgement: a reconnect can briefly empty the roster.
        if (connected && s) {
            if (!awaiting(s->state)) { active = false; return Receipt::StateUpdated; }
            if (!request.matches(*s)) { active = false; return Receipt::RequestChanged; }
        }
        if (uint32_t(now - sentAt) >= 15000) { active = false; return Receipt::Unconfirmed; }
        return Receipt::Waiting;
    }
};

// Non-security rendering signature. Command validation uses exact Request above.
inline uint32_t textHash(const char* s, uint32_t seed = 2166136261u) {
    while (*s) { seed ^= uint8_t(*s++); seed *= 16777619u; }
    return seed;
}
}
