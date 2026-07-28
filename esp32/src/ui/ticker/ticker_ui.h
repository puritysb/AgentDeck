#pragma once

// T-Display-S3-Pro "Focus Strip" — a 480x222 always-on desk strip.
// Pages: prioritized focus, Claude/Codex usage, and high-value session rows.
// Physical controls: split rocker = previous/next, BOOT = focus/select,
// RST = hardware recovery. Touch provides tabs, swipes and explicit actions.

#include "../../input/touch_strip.h"

namespace Ticker {

void create();
void update(float dt);

void nextPage();
void prevPage();
void primaryAction();
void buttonFeedback(uint8_t button);

void onTouch(const Input::TouchEvent& event);

/** Daemon's photo_result for a snap sent from the CAM page. */
void onPhotoResult(bool delivered, const char* detail);

}  // namespace Ticker
