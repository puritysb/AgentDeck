#pragma once
#include <lvgl.h>
namespace IPS10Workspace {
// All widgets and bounded text stores live for the screen lifetime.
lv_obj_t* init(lv_obj_t* parent, const lv_image_dsc_t* (*glyph)(const char*));
void update();
// Network/audio tasks publish bounded text; only update() touches LVGL.
void voiceStarted(const char* target);
void voiceTranscript(const char* text);
void voiceAnswer(const char* text);
void voiceNotice(const char* text);
struct Diagnostics {
    uint32_t updates, lastUpdateUs, maxUpdateUs;
    uint16_t width, height;
    uint8_t sessions, visibleSessions, filter, eventCount, projects;
    bool connected, history, voiceOpen, overview, usageVisible, rosterRotating;
    uint8_t quotaWindows;
    uint16_t rosterTotal;
};
Diagnostics diagnostics();
const char* selectedSession();
}
