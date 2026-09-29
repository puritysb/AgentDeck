#include "ui/companion/interaction_state.h"
#include <cassert>
struct Session {
    char id[32]{}, requestId[40]{}, question[160]{}, promptType[20]{}, state[20]{};
    struct Option { char label[64]{}; unsigned char index{}, recommended{}; } options[6];
    unsigned optionCount{};
};
int main() {
    Session sessions[3]{};
    for (unsigned i = 0; i < 3; ++i) {
        sessions[i].id[0] = 'a' + i;
        Companion::copy(sessions[i].state, "awaiting_option");
    }
    Companion::WaitingQueue<3> queue;
    queue.refresh(sessions, 2); assert(queue.count == 2 && queue.index("b") == 1);
    Session reordered[] = {sessions[1], sessions[0], sessions[2]};
    queue.refresh(reordered, 3); assert(queue.index("a") == 0 && queue.index("c") == 2);
    Companion::copy(reordered[1].state, "processing");
    queue.refresh(reordered, 3); assert(queue.count == 2 && queue.index("b") == 0);
    auto& s = sessions[0];
    Companion::copy(s.question, "어떤 파일을 수정할까요?");
    s.optionCount = 2;
    Companion::copy(s.options[0].label, "First");
    Companion::copy(s.options[1].label, "Second"); s.options[1].index = 1;
    Companion::Request<6> displayed; displayed.capture(s); assert(displayed.matches(s));
    s.options[0].index = 2; assert(!displayed.matches(s)); s.options[0].index = 0;
    Companion::copy(s.options[0].label, "Changed"); assert(!displayed.matches(s));
    displayed.capture(s);
    Companion::PendingReply<6> pending; pending.begin(displayed, 100);
    using R = Companion::Receipt;
    assert(pending.observe<Session>(nullptr, true, 200) == R::Waiting);
    assert(pending.observe(&s, false, 300) == R::Waiting);
    Companion::copy(s.state, "processing");
    assert(pending.observe(&s, true, 400) == R::StateUpdated);
    pending.begin(displayed, 100); Companion::copy(s.state, "awaiting_option");
    Companion::copy(s.requestId, "replacement");
    assert(pending.observe(&s, true, 400) == R::RequestChanged);
    pending.begin(displayed, 0xfffffff0u);
    assert(pending.observe<Session>(nullptr, false, 15000) == R::Unconfirmed);
}
