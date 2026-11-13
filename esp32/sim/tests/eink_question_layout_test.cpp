#include <cassert>
#include "ui/eink/eink_question_layout.h"
#include "ui/eink/eink_dashboard_layout.h"

int main() {
    using AgentDeckEink::tallQuestionLayout;
    const auto board = AgentDeckEink::makeLayout({800, 480, 68, 0, 36, 28, 2, 4, 1, 2});
    assert(board.cardHeight == 204); // two usage providers and three recent events
    const auto shortCard = tallQuestionLayout(board.cardHeight, 3);
    assert(!shortCard.large && shortCard.lines == 1);
    const auto fullCard = tallQuestionLayout(350, 3);
    assert(fullCard.large && fullCard.lines == 6);
    // Every tall-card height and supported option count preserves all choices
    // above the model tag, including the 201px boundary of the tall branch.
    for (int h = 201; h <= 800; ++h) {
        for (uint8_t options = 0; options <= 3; ++options) {
            const auto q = tallQuestionLayout(h, options);
            assert(q.lines >= 1 && q.lines <= 6);
            const int last = options
                ? q.baseline + q.lines * q.lineHeight + (options - 1) * 20
                : q.baseline + (q.lines - 1) * q.lineHeight;
            assert(last <= h - 29);
        }
    }
}
