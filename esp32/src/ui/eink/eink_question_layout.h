#pragma once

#include <stdint.h>

namespace AgentDeckEink {

struct QuestionLayout {
    bool large;
    int16_t baseline;
    int16_t lineHeight;
    uint8_t lines;
};

// TRMNL tall cards (>200 px), with at most three decision options. Keep the
// final baseline above the model tag. Values are stack-only; no allocation.
inline QuestionLayout tallQuestionLayout(int16_t height, uint8_t options) {
    QuestionLayout out{true, 118, 26, 1};
    const int optionTail = options > 0 ? (options - 1) * 20 : 0;
    auto capacity = [&]() {
        // The model baseline is h-10; leave 19px between baselines so the
        // preceding descenders cannot touch the model's ascenders.
        const int room = height - 29 - out.baseline - optionTail;
        return room / out.lineHeight + (options == 0 ? 1 : 0);
    };
    // A short tall card cannot hold even one large question line and all
    // options. Retain the body font there instead of dropping an option.
    if (capacity() < 1) out = QuestionLayout{false, 112, 20, 1};
    const int lines = capacity();
    out.lines = (uint8_t)(lines < 1 ? 1 : lines > 6 ? 6 : lines);
    return out;
}

}  // namespace AgentDeckEink
