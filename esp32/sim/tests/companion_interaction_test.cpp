#include "ui/companion/interaction_state.h"
#include "state/device_controller_generated.h"
#include "ui/eink/eink_decision.h"
#include "net/ws_client.h"
#include <cassert>
struct Session {
    char id[32]{}, requestId[40]{}, question[160]{}, promptType[20]{}, state[20]{};
    struct Option { char label[64]{}; unsigned char index{}, recommended{}; } options[6];
    unsigned optionCount{};
    bool answerable{};
    bool alive{true};
};
int main() {
    assert(!DeviceController::answer(true, true, false, false, false, 0, false, false));
    assert(!DeviceController::answer(true, true, true, false, false, 2, false, false));
    assert(DeviceController::answer(true, true, false, false, true, 2, false, false));
    assert(DeviceController::answer(true, true, true, false, false, 0, true, false));
    assert(!DeviceController::answer(true, true, true, false, false, 2, true, true));
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
    s.answerable = true; assert(!displayed.matches(s)); s.answerable = false;
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

    // E-ink replies carry the displayed session's original option index and
    // raw question, not the unrelated globally focused session's choices.
    s.answerable = true; s.requestId[0] = 0;
    Companion::copy(s.question, "Which \"path\"?\n다음");
    s.options[1].index = 4;
    AgentDeckEink::Decision shown; shown.capture(s);
    auto current = shown;
    char command[Net::OUTBOUND_MAX_LEN];
    assert(AgentDeckEink::decisionCommand(shown,current,1,command,sizeof(command)));
    assert(std::strstr(command,"\"index\":4"));
    assert(std::strstr(command,"\"sessionId\":\"a\""));
    assert(std::strstr(command,"\"question\":\"Which \\\"path\\\"?\\n다음\""));
    Companion::copy(current.request.question,"Replacement");
    assert(!AgentDeckEink::decisionCommand(shown,current,1,command,sizeof(command)));
    assert(!command[0]);
    current = shown; current.request.options[1].index = 2;
    assert(!AgentDeckEink::decisionCommand(shown,current,1,command,sizeof(command)));
    current = shown;
    assert(!AgentDeckEink::decisionCommand(shown,current,1,command,24));
    assert(!command[0]);
    s.optionCount = 4; current.capture(s);
    assert(!current.ready); // no hidden fourth choice
    s.optionCount = 2; s.answerable = false; current.capture(s);
    assert(!current.ready);
    s.answerable = true; Companion::copy(s.requestId,"gate-one");
    shown.capture(s); current = shown;
    assert(AgentDeckEink::decisionCommand(shown,current,1,command,sizeof(command)));
    assert(std::strstr(command,"\"requestId\":\"gate-one\""));
    assert(std::strstr(command,"\"decision\":\"deny\""));
    Companion::copy(current.request.requestId,"gate-two");
    assert(!AgentDeckEink::decisionCommand(shown,current,0,command,sizeof(command)));
    s.requestId[0] = 0;
    AgentDeckEink::captureFirstDecision(shown,sessions,2);
    assert(!std::strcmp(shown.request.id,"a"));
    assert(shown.request.options[1].index == 4);
    Companion::copy(s.state,"processing");
    AgentDeckEink::captureFirstDecision(shown,sessions,2);
    assert(!std::strcmp(shown.request.id,"b"));
    AgentDeckEink::captureFirstDecision(shown,sessions,0);
    assert(!shown.ready);
}
