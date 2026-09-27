#pragma once
#include <cassert>
#include <lvgl.h>
#include "ui/companion/interaction_state.h"

static bool visibleText(lv_obj_t* obj, const char* text) {
    if (lv_obj_has_flag(obj, LV_OBJ_FLAG_HIDDEN)) return false;
    if (lv_obj_check_type(obj, &lv_label_class) && strstr(lv_label_get_text(obj), text)) return true;
    for (uint32_t i = 0; i < lv_obj_get_child_count(obj); ++i)
        if (visibleText(lv_obj_get_child(obj, i), text)) return true;
    return false;
}
static bool verifyCompanionInteractions(const char* outdir) {
    auto tick = [] {
        SimDisplay::tick(33);
#if defined(BOARD_T_EMBED)
        Knob::update(.033f);
#else
        Ticker::update(.033f);
#endif
        SimDisplay::refresh();
    };
    auto shot = [&](const char* name) {
        const std::string path = std::string(outdir) + "/" + name + ".png";
        assert(SimPng::writeRgb565(path.c_str(), SimDisplay::framebuffer(), SimDisplay::width(), SimDisplay::height()));
    };
    SimScenes::apply("attention");
    g_state.sessions[2] = g_state.sessions[1]; g_state.sessionCount = 3;
    Companion::copy(g_state.sessions[2].id, "second-wait");
    Companion::copy(g_state.sessions[2].requestId, "request-two");
    Companion::copy(g_state.sessions[2].projectName, "Second project");
#if defined(BOARD_T_EMBED)
    tick(); assert(Knob::selectedSessionIdx() == 0); // full roster stays on the current assistant
    Knob::onRotate(3); tick(); // explicit waiting-requests shortcut
    Knob::onKey(Input::KeyEvent::SHORT_PRESS); tick();
    assert(Knob::selectedSessionIdx() == 1);
    assert(visibleText(lv_screen_active(), "NEEDS INPUT"));
    shot("knob-waiting");
    Knob::onRotate(1); tick(); assert(Knob::selectedSessionIdx() == 2);
    const auto swap = g_state.sessions[1]; g_state.sessions[1] = g_state.sessions[2]; g_state.sessions[2] = swap;
    tick(); assert(Knob::selectedSessionIdx() == 1); // selected ID survives reorder
    Knob::onRotate(1); tick(); assert(Knob::selectedSessionIdx() == -1); // All sessions shortcut
    Knob::onKey(Input::KeyEvent::SHORT_PRESS); tick(); assert(visibleText(lv_screen_active(), "ALL SESSIONS"));
    Knob::onRotate(3); tick(); Knob::onKey(Input::KeyEvent::SHORT_PRESS); tick();
    assert(Knob::selectedSessionIdx() == 2); // original request, FIFO order
    auto& request = g_state.sessions[2];
    request.optionCount = 2;
    Companion::copy(request.options[0].label, "Proceed with selected change"); request.options[0].index = 3;
    Companion::copy(request.options[1].label, "Keep the current configuration"); request.options[1].index = 7;
    Companion::copy(request.question, "어떤 설정으로 계속할까요? 프로젝트 구성을 선택해 주세요.");
    tick(); Knob::onKey(Input::KeyEvent::SHORT_PRESS); tick(); SimCommands::reset();
    Knob::onKey(Input::KeyEvent::SHORT_PRESS); assert(SimCommands::count() == 0); // no default affirmative
    Knob::onRotate(1); tick(); shot("knob-options");
    request.options[0].index = 4; // request changed after rendering, before click
    Knob::onKey(Input::KeyEvent::SHORT_PRESS); assert(SimCommands::count() == 0);
    tick(); Knob::onRotate(1); tick(); Knob::onKey(Input::KeyEvent::SHORT_PRESS);
    assert(strstr(SimCommands::last(), "\"index\":4") && strstr(SimCommands::last(), "\"question\":"));
    tick(); assert(visibleText(lv_screen_active(), "waiting for state update")); shot("knob-sent");
    Knob::onKey(Input::KeyEvent::SHORT_PRESS); tick(); Knob::onRotate(1); tick(); SimCommands::reset();
    Knob::onKey(Input::KeyEvent::SHORT_PRESS); assert(SimCommands::count() == 0); // pending duplicate refused
    g_state.wsConnected = false; tick(); Knob::onKey(Input::KeyEvent::SHORT_PRESS); assert(SimCommands::count() == 0);
    g_state.wsConnected = true; Companion::copy(request.state, "processing"); tick();
    assert(visibleText(lv_screen_active(), "State updated"));
#else
    // Start with one working project, then introduce competing waiting work.
    g_state.sessionCount = 1;
    auto& work = g_state.sessions[0];
    Companion::copy(work.state, "processing"); Companion::copy(work.projectName, "Pinned project");
    Companion::copy(work.activity, "Implementing the next change");
    Companion::copy(work.lastEventText, "The previous result stays readable");
    auto result = [&](const char* text) {
        TimelineEntry event{};
        Companion::copy(event.type, "chat_response");
        Companion::copy(event.sessionId, work.id);
        Companion::copy(event.raw, text);
        g_state.addTimelineEntry(event);
    };
    result("The previous result stays readable");
    tick(); assert(Ticker::isPinned()); // first focus is pinned automatically
    const std::string pinned = Ticker::displayedSessionId();
    g_state.sessionCount = 3;
    Companion::copy(work.lastEventText, "A newer result has arrived");
    result("A newer result has arrived");
    tick(); assert(pinned == Ticker::displayedSessionId());
    assert(visibleText(lv_screen_active(), "previous result"));
    assert(visibleText(lv_screen_active(), "NEW RESULT")); shot("ticker-pinned");
    Ticker::onTouch({Input::TouchGesture::TAP, 160, 180}); tick();
    assert(visibleText(lv_screen_active(), "newer result"));
    Ticker::onTouch({Input::TouchGesture::TAP, 280, 27}); tick();
    assert(Ticker::currentPage() == 2); tick(); assert(Ticker::currentPage() == 2); // no forced page theft
    shot("ticker-waiting");
    // Every row remains reachable when there are more than three requests.
    for (unsigned i = 3; i < 7; ++i) {
        g_state.sessions[i] = g_state.sessions[1];
        snprintf(g_state.sessions[i].id, sizeof(g_state.sessions[i].id), "wait-%u", i);
        snprintf(g_state.sessions[i].projectName, sizeof(g_state.sessions[i].projectName), "Waiting project %u", i);
    }
    g_state.sessionCount = 7; tick();
    Ticker::onTouch({Input::TouchGesture::TAP, 80, 198}); tick();
    assert(visibleText(lv_screen_active(), "4-6 / 6"));
    Ticker::onTouch({Input::TouchGesture::TAP, 140, 60}); tick();
    assert(!strcmp(Ticker::displayedSessionId(), "wait-4"));
    auto& gate = g_state.sessions[4]; gate.optionCount = 0;
    Companion::copy(gate.requestId, "request-current"); tick(); SimCommands::reset();
    Companion::copy(gate.requestId, "request-replaced");
    Ticker::onTouch({Input::TouchGesture::TAP, 410, 190}); assert(SimCommands::count() == 0);
    tick(); Ticker::onTouch({Input::TouchGesture::TAP, 410, 190});
    assert(strstr(SimCommands::last(), "request-replaced"));
    g_state.sessionCount = 1; tick();
    assert(!strcmp(Ticker::displayedSessionId(), "wait-4"));
    assert(visibleText(lv_screen_active(), "ENDED")); shot("ticker-ended");
    SimCommands::reset(); Ticker::onTouch({Input::TouchGesture::TAP, 410, 190}); assert(SimCommands::count() == 0);
#endif
    std::fprintf(stderr, "[sim] companion interaction checks: passed\n");
    return true;
}
