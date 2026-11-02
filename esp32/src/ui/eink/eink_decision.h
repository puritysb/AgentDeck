#pragma once
#include "ui/companion/interaction_state.h"
#include "util/json.h"
#include <cstdio>

namespace AgentDeckEink {
// Fixed storage copied with each render snapshot, never allocated in a render
// loop. Three choices fit this surface; larger prompts remain observation-only.
struct Decision {
    Companion::Request<3> request;
    bool ready{};

    template<class S> void capture(const S& session) {
        request.capture(session);
        ready = session.alive && session.answerable && Companion::awaiting(session.state)
            && session.id[0] && (session.requestId[0] || (session.question[0] && session.optionCount > 0 && session.optionCount <= 3));
        if (session.requestId[0]) {
            request.count = 2;
            Companion::copy(request.options[0].label, "Allow");
            Companion::copy(request.options[1].label, "Deny");
            request.options[0].index = 0; request.options[1].index = 1;
        }
    }

    bool matches(const Decision& other) const {
        const auto& a = request; const auto& b = other.request;
        if (!ready || !other.ready || std::strcmp(a.id,b.id) || std::strcmp(a.requestId,b.requestId)
            || std::strcmp(a.question,b.question) || std::strcmp(a.promptType,b.promptType)
            || std::strcmp(a.state,b.state) || a.count != b.count) return false;
        for (unsigned i = 0; i < a.count; ++i)
            if (std::strcmp(a.options[i].label,b.options[i].label) || a.options[i].index != b.options[i].index)
                return false;
        return true;
    }
};

template<class S> inline void captureFirstDecision(Decision& out, const S* sessions, unsigned count) {
    out.ready = false;
    out.request.count = 0;
    out.request.id[0] = out.request.requestId[0] = out.request.question[0] = 0;
    for (unsigned i = 0; i < count; ++i) {
        if (!Companion::awaiting(sessions[i].state)) continue;
        out.capture(sessions[i]);
        return;
    }
}

inline bool append(char* out, size_t cap, const char* text) {
    const size_t used = std::strlen(out), n = std::strlen(text);
    if (used + n >= cap) return false;
    std::memcpy(out + used, text, n + 1); return true;
}

// Only an exactly displayed request may generate a reply. Never enqueue a
// truncated JSON frame or discard an original option index/question identity.
inline bool decisionCommand(const Decision& shown, const Decision& current, unsigned selection,
                            char* out, size_t cap) {
    if (!out || !cap) return false;
    out[0] = 0;
    if (!shown.matches(current) || selection >= shown.request.count) return false;
    const auto& r = shown.request;
    const bool permission = r.requestId[0] != 0;
    const char* prefix = permission ? "{\"type\":\"permission_decision\",\"requestId\":\""
                                    : "{\"type\":\"select_option\",\"sessionId\":\"";
    bool ok = append(out,cap,prefix) && Json::escapeAppend(out,cap,permission ? r.requestId : r.id);
    if (permission) {
        ok = ok && append(out,cap,selection == 0 ? "\",\"decision\":\"allow\"}" : "\",\"decision\":\"deny\"}");
    } else {
        char field[40];
        std::snprintf(field,sizeof(field),"\",\"index\":%u,\"question\":\"",unsigned(r.options[selection].index));
        ok = ok && r.question[0] && append(out,cap,field) && Json::escapeAppend(out,cap,r.question)
            && append(out,cap,"\"}");
    }
    if (!ok) out[0] = 0;
    return ok;
}
}
