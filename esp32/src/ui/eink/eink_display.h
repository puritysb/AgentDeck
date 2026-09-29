#pragma once

#include <stdint.h>

/**
 * TRMNL 7.5" — 7.5" 800×480 1-bit e-ink dashboard (Seeed TRMNL OG DIY Kit,
 * XIAO ESP32-S3 Plus + GDEY075T7/UC8179 panel).
 *
 * Direct-draw path (no LVGL): renders the session dashboard into the GxEPD2
 * framebuffer and refreshes the panel with fast partial updates (~0.3s),
 * inserting a full refresh every few partials to clear ghosting. Redraws are
 * content-hash gated — a static dashboard costs zero panel refreshes.
 */

namespace Eink {

void init();
void logRefreshCompletions();  // call only from the serial-owning network task
void update(float dt);   // button polling (KEY1/KEY2 → force full refresh)
void render();           // hash-gated draw + panel refresh (may block ~0.3-3s)
uint32_t repaintCount();       // actual panel refreshes since boot
uint32_t fullRefreshCount();   // full-window subset of repaintCount

}  // namespace Eink
