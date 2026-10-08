#include "strip_layout.h"

#if defined(BOARD_T_DISPLAY_PRO)

#include <string.h>
#if !defined(SIM_HOST)
#include <Arduino.h>
#include <Preferences.h>
#endif

namespace StripLayout {

static constexpr const char* NVS_NAMESPACE = "agentdeck";
static constexpr const char* NVS_KEY = "strip_layout";
static constexpr uint32_t RESTART_GRACE_MS = 1200;

static Setting s_setting = AUTO;
static bool s_camera = false;
static bool s_portrait = false;
// Written by the network task, consumed by the UI task. A single byte store
// is atomic on Xtensa; 0xFF = nothing pending.
static volatile uint8_t s_requested = 0xFF;
static bool s_restartScheduled = false;
static uint32_t s_restartAtMs = 0;

static bool resolve(Setting s, bool cameraPresent) {
    if (s == PORTRAIT) return true;
    if (s == LANDSCAPE) return false;
    return cameraPresent;
}

static Setting load() {
#if defined(SIM_HOST)
    return s_setting;
#else
    Preferences prefs;
    prefs.begin(NVS_NAMESPACE, true);
    uint8_t v = prefs.getUChar(NVS_KEY, AUTO);
    prefs.end();
    return v <= LANDSCAPE ? (Setting)v : AUTO;
#endif
}

static void save(Setting s) {
#if !defined(SIM_HOST)
    Preferences prefs;
    prefs.begin(NVS_NAMESPACE, false);
    prefs.putUChar(NVS_KEY, (uint8_t)s);
    prefs.end();
#endif
    s_setting = s;
}

void begin(bool cameraPresent) {
    s_camera = cameraPresent;
    s_setting = load();
    s_portrait = resolve(s_setting, cameraPresent);
}

void toggleAtBoot(bool cameraPresent) {
    s_camera = cameraPresent;
    const bool current = resolve(load(), cameraPresent);
    // Store the explicit opposite; AUTO is reachable from the daemon.
    save(current ? LANDSCAPE : PORTRAIT);
    s_portrait = !current;
}

Setting setting() { return s_setting; }
bool portrait() { return s_portrait; }

const char* settingName(Setting s) {
    return s == PORTRAIT ? "portrait" : s == LANDSCAPE ? "landscape" : "auto";
}

const char* layoutName(bool isPortrait) { return isPortrait ? "portrait" : "landscape"; }

bool parseSetting(const char* text, Setting* out) {
    if (!text || !out) return false;
    if (!strcmp(text, "auto")) { *out = AUTO; return true; }
    if (!strcmp(text, "portrait")) { *out = PORTRAIT; return true; }
    if (!strcmp(text, "landscape")) { *out = LANDSCAPE; return true; }
    return false;
}

void request(Setting s) {
    if (s <= LANDSCAPE) s_requested = (uint8_t)s;
}

bool poll(uint32_t nowMs, const char** restartingText) {
    if (restartingText) *restartingText = nullptr;
    const uint8_t req = s_requested;
    if (req != 0xFF) {
        s_requested = 0xFF;
        const Setting next = (Setting)req;
        const bool nextPortrait = resolve(next, s_camera);
        if (next != s_setting) save(next);
        if (nextPortrait != s_portrait && !s_restartScheduled) {
            s_restartScheduled = true;
            s_restartAtMs = nowMs + RESTART_GRACE_MS;
            if (restartingText) {
                *restartingText = nextPortrait ? "Rotating to portrait..." : "Rotating to landscape...";
            }
#if !defined(SIM_HOST)
            Serial.printf("[Layout] %s -> %s (setting %s), restarting\n",
                          layoutName(s_portrait), layoutName(nextPortrait), settingName(next));
#endif
        } else {
#if !defined(SIM_HOST)
            Serial.printf("[Layout] setting %s, layout stays %s\n",
                          settingName(next), layoutName(s_portrait));
#endif
        }
    }
    return s_restartScheduled && (int32_t)(nowMs - s_restartAtMs) >= 0;
}

}  // namespace StripLayout

#endif  // BOARD_T_DISPLAY_PRO
