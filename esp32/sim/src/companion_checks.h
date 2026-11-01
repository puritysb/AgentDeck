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
static lv_obj_t* companionDotLabel(lv_obj_t* obj) {
    if(lv_obj_has_flag(obj,LV_OBJ_FLAG_HIDDEN))return nullptr;
    if(lv_obj_check_type(obj,&lv_label_class) && !strcmp(lv_label_get_text(obj),"Dot"))return obj;
    for(uint32_t i=0;i<lv_obj_get_child_count(obj);++i)
        if(auto* found=companionDotLabel(lv_obj_get_child(obj,i)))return found;
    return nullptr;
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
    request.answerable = false;
    Knob::onKey(Input::KeyEvent::SHORT_PRESS); assert(SimCommands::count() == 0);
    tick(); request.answerable = true; tick(); Knob::onRotate(1); tick();
    request.options[0].index = 4; // request changed after rendering, before click
    Knob::onKey(Input::KeyEvent::SHORT_PRESS); assert(SimCommands::count() == 0);
    tick(); Knob::onRotate(1); tick(); Knob::onKey(Input::KeyEvent::SHORT_PRESS);
    assert(strstr(SimCommands::last(), "\"index\":4") && strstr(SimCommands::last(), "\"question\":"));
    tick(); assert(visibleText(lv_screen_active(), "waiting for state update")); shot("knob-sent");
    Knob::onKey(Input::KeyEvent::SHORT_PRESS); tick(); Knob::onRotate(1); tick(); SimCommands::reset();
    Knob::onKey(Input::KeyEvent::SHORT_PRESS); assert(SimCommands::count() == 0); // pending duplicate refused
    Companion::copy(request.requestId, "native-knob-gate"); tick();
    Knob::onRotate(1); tick(); SimCommands::reset();
    assert(visibleText(lv_screen_active(), "Allow once"));
    Knob::onKey(Input::KeyEvent::SHORT_PRESS);
    assert(strstr(SimCommands::last(), "\"type\":\"permission_decision\"") && strstr(SimCommands::last(), "native-knob-gate"));
    SimCommands::reset();
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
    auto& gate = g_state.sessions[4]; gate.requestId[0] = '\0';
    Companion::copy(gate.promptType, "yes_no"); gate.optionCount = 2; tick(); SimCommands::reset();
    Ticker::onTouch({Input::TouchGesture::TAP, 410, 190}); assert(SimCommands::count() == 0);
    gate.optionCount = 0;
    Companion::copy(gate.requestId, "request-current"); tick(); SimCommands::reset();
    Companion::copy(gate.requestId, "request-replaced");
    Ticker::onTouch({Input::TouchGesture::TAP, 410, 190}); assert(SimCommands::count() == 0);
    gate.answerable = false; tick();
    Ticker::onTouch({Input::TouchGesture::TAP, 410, 190}); assert(SimCommands::count() == 0);
    gate.answerable = true;
    tick(); Ticker::onTouch({Input::TouchGesture::TAP, 410, 190});
    assert(strstr(SimCommands::last(), "request-replaced"));
    g_state.sessionCount = 1; tick();
    assert(!strcmp(Ticker::displayedSessionId(), "wait-4"));
    assert(visibleText(lv_screen_active(), "ENDED")); shot("ticker-ended");
    SimCommands::reset(); Ticker::onTouch({Input::TouchGesture::TAP, 410, 190}); assert(SimCommands::count() == 0);
#endif
    SimScenes::apply("dot:attention");tick();SimCommands::reset();
#if defined(BOARD_T_EMBED)
    Knob::onKey(Input::KeyEvent::LONG_PRESS);Knob::onKey(Input::KeyEvent::LONG_PRESS);tick();
    for(int i=0;i<3 && !visibleText(lv_screen_active(),"Dot");++i){Knob::onRotate(1);tick();}
    assert(Knob::selectedSessionIdx()==-1); // Dot never lights a real-session ring slot
    assert(visibleText(lv_screen_active(),"Dot"));
    assert(!Knob::focusedSessionId()[0]);shot("knob-dot-roster");
    Knob::onKey(Input::KeyEvent::SHORT_PRESS);tick();assert(SimCommands::count()==0);
#else
    Ticker::onTouch({Input::TouchGesture::TAP,200,27});tick(); // explicit All sessions tab
    assert(visibleText(lv_screen_active(),"Dot"));shot("ticker-dot-roster");
    auto* dotLabel=companionDotLabel(lv_screen_active());assert(dotLabel);
    lv_area_t area;lv_obj_get_coords(dotLabel,&area);
    Ticker::onTouch({Input::TouchGesture::TAP,static_cast<int16_t>((area.x1+area.x2)/2),static_cast<int16_t>((area.y1+area.y2)/2)});tick();
    assert(Ticker::currentPage()==2 && SimCommands::count()==0);
#endif
    assert(g_state.sessionCount==1);
    std::fprintf(stderr, "[sim] companion interaction checks: passed\n");
    return true;
}
