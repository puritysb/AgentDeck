// GENERATED from shared/src/session-state-presentation.ts and design/tokens.css bindings. DO NOT EDIT.
// Regenerate with `pnpm generate-session-state`.
#pragma once
#include <cstdint>
#include <cstring>
#include "../state/agent_state.h"

// Session state presentation — DESIGN.md §2.7. One tone, colour and word set
// per wire state on every surface. Only Awaiting may animate.
namespace SessionState {
enum Tone : uint8_t { Idle, Working, Awaiting, Offline };

inline Tone tone(AgentState state) {
    switch (state) {
        case AgentState::DISCONNECTED: return Offline;
        case AgentState::IDLE: return Idle;
        case AgentState::PROCESSING: return Working;
        case AgentState::AWAITING_PERMISSION: return Awaiting;
        case AgentState::AWAITING_OPTION: return Awaiting;
        case AgentState::AWAITING_DIFF: return Awaiting;
    }
    return Idle;
}

/** Missing → Offline; unknown non-empty → Idle (a live, quiet session). */
inline bool fromWire(const char* wire, AgentState& out) {
    if (std::strcmp(wire, "disconnected") == 0) { out = AgentState::DISCONNECTED; return true; }
    if (std::strcmp(wire, "idle") == 0) { out = AgentState::IDLE; return true; }
    if (std::strcmp(wire, "processing") == 0) { out = AgentState::PROCESSING; return true; }
    if (std::strcmp(wire, "awaiting_permission") == 0) { out = AgentState::AWAITING_PERMISSION; return true; }
    if (std::strcmp(wire, "awaiting_option") == 0) { out = AgentState::AWAITING_OPTION; return true; }
    if (std::strcmp(wire, "awaiting_diff") == 0) { out = AgentState::AWAITING_DIFF; return true; }
    return false;
}
inline Tone tone(const char* wire) {
    if (wire == nullptr || *wire == '\0') return Offline;
    AgentState state;
    return fromWire(wire, state) ? tone(state) : Idle;
}

inline uint32_t color(Tone t, bool onPaper = false) {
    static constexpr uint32_t bright[] = {0x9A9AA2, 0x3ED6E8, 0xFFA93D, 0x7A8A9C};
    static constexpr uint32_t paper[] = {0x4D4D51, 0x1F6B74, 0x7F541E, 0x3D454E};
    return (onPaper ? paper : bright)[t];
}
inline uint32_t color(AgentState state, bool onPaper = false) { return color(tone(state), onPaper); }
inline uint32_t color(const char* wire, bool onPaper = false) { return color(tone(wire), onPaper); }
inline bool pulses(Tone t) { return t == Awaiting; }

/** Sentence case, for rows with room to speak. */
inline const char* label(AgentState state) {
    switch (state) {
        case AgentState::DISCONNECTED: return "Offline";
        case AgentState::IDLE: return "Idle";
        case AgentState::PROCESSING: return "Working";
        case AgentState::AWAITING_PERMISSION: return "Needs approval";
        case AgentState::AWAITING_OPTION: return "Needs a choice";
        case AgentState::AWAITING_DIFF: return "Review diff";
    }
    return "Idle";
}
/** Uppercase pill text, at most 7 characters. */
inline const char* shortLabel(AgentState state) {
    switch (state) {
        case AgentState::DISCONNECTED: return "OFFLINE";
        case AgentState::IDLE: return "IDLE";
        case AgentState::PROCESSING: return "WORKING";
        case AgentState::AWAITING_PERMISSION: return "APPROVE";
        case AgentState::AWAITING_OPTION: return "CHOOSE";
        case AgentState::AWAITING_DIFF: return "REVIEW";
    }
    return "IDLE";
}
/** At most 4 characters. */
inline const char* tinyLabel(AgentState state) {
    switch (state) {
        case AgentState::DISCONNECTED: return "OFF";
        case AgentState::IDLE: return "IDLE";
        case AgentState::PROCESSING: return "WORK";
        case AgentState::AWAITING_PERMISSION: return "PERM";
        case AgentState::AWAITING_OPTION: return "OPT";
        case AgentState::AWAITING_DIFF: return "DIFF";
    }
    return "IDLE";
}
inline AgentState stateOrIdle(const char* wire) {
    if (wire == nullptr || *wire == '\0') return AgentState::DISCONNECTED;
    AgentState state;
    return fromWire(wire, state) ? state : AgentState::IDLE;
}
inline const char* label(const char* wire) { return label(stateOrIdle(wire)); }
inline const char* shortLabel(const char* wire) { return shortLabel(stateOrIdle(wire)); }
inline const char* tinyLabel(const char* wire) { return tinyLabel(stateOrIdle(wire)); }
}  // namespace SessionState
