#pragma once
#include <stdint.h>

// GLANCE is a stable home. Details are entered only by deliberate input;
// processing/idle counts never navigate or cause a full-page replacement.
namespace AgentDeckEpd47 {
enum class Page : uint8_t { Focus = 0, Queue = 1, Limits = 2, Home = 3 };
inline Page automaticPage(uint8_t attentionCount, uint8_t processingCount) {
    (void)attentionCount;
    (void)processingCount;
    return Page::Home;
}
inline const char* pageName(Page page) {
    switch (page) {
        case Page::Focus: return "WORK";
        case Page::Queue: return "ALL WORK";
        case Page::Limits: return "USAGE";
        default: return "HOME";
    }
}
}  // namespace AgentDeckEpd47
