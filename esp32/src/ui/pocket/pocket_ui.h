#pragma once

// T-Display-S3-Pro "Pocket" — the camera unit's portrait (222x480) phone-style
// UI, auto-selected at boot when the rear camera probes. The whole hardware
// stack is portrait-native (panel GRAM, CST226SE touch report, camera
// mounting), so this orientation needs no coordinate or image rotation fights:
// LVGL's pointer indev drives real widgets (momentum-scrolled session cards,
// tappable actions) instead of the landscape ticker's hand-rolled gestures.
//
// Tabs: SESSIONS (scrollable cards, tap = focus) · CAM (upright viewfinder,
// SNAP/LED, tap target line to cycle the receiving session) · USAGE (gauges).
// Physical controls: rocker = tab prev/next, BOOT = go to CAM / shutter.

namespace Pocket {

void create();
void update(float dt);

void nextTab();
void prevTab();
void primaryAction();

/** Daemon's photo_result for a snap sent from the CAM tab. */
void onPhotoResult(bool delivered, const char* detail);

}  // namespace Pocket
