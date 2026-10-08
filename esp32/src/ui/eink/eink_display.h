#pragma once

#include <stdint.h>

/**
 * TRMNL 7.5" — 7.5" 800×480 1-bit e-ink dashboard (Seeed TRMNL OG DIY Kit,
 * XIAO ESP32-S3 Plus + GDEY075T7/UC8179 panel).
 *
 * Direct-draw path (no LVGL): renders the session dashboard into the panel's
 * framebuffer and refreshes it with the board's cheapest safe waveform (TRMNL
 * partial ~0.3s, EPD47 masked differential, NM full tri-color only), with a
 * scheduled full refresh to clear ghosting. Redraws are content-hash gated and
 * a pixel-identical frame is never sent — a static dashboard costs nothing.
 */

namespace Eink {

void init();
void logRefreshCompletions();  // call only from the serial-owning network task
void update(float dt);   // button/touch polling (KEY1/KEY2 → force full refresh)
void render();           // hash-gated draw + panel refresh (may block ~0.3-13s)
// Input polling cadence for the UI task. Touch needs a short one — a tap is
// ~100 ms of contact — while button edges and paint gates are fine at 250 ms.
uint32_t inputPollMs();
bool renderPending();    // input asked for a frame; render without waiting
uint32_t repaintCount();       // actual panel refreshes since boot
uint32_t fullRefreshCount();   // full-window subset of repaintCount

}  // namespace Eink
