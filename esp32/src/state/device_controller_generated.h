// GENERATED FILE — DO NOT EDIT. Source: shared/src/device-controller.ts
// Regenerate: node scripts/generate-device-controller-rules.mjs
#pragma once
#include <cstring>
namespace DeviceController {
static constexpr unsigned questionBytes = 159;
static constexpr unsigned requestBytes = 39;
static constexpr unsigned optionLabelBytes = 63;
static constexpr unsigned maxOptions = 6;
inline bool input(bool alive, bool managed, bool observed, const char* agent) {
    return alive && (managed || !std::strcmp(agent, "openclaw") || (observed && (!std::strcmp(agent, "claude-code") || !std::strcmp(agent, "opencode"))));
}
inline bool answer(bool alive, bool awaiting, bool known, bool replyable, bool managed, unsigned options, bool request, bool requestNeedsChannel) {
    return alive && awaiting && ((request && (!requestNeedsChannel || replyable)) || ((known ? replyable : managed) && options > 0));
}
}
