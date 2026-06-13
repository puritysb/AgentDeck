#pragma once

#include <cstdint>

// ===== Screen dimensions (set by build flags) =====
#ifndef SCREEN_W
#define SCREEN_W 480
#endif
#ifndef SCREEN_H
#define SCREEN_H 320
#endif

// Runtime screen dimensions (mutable for orientation switching)
// Initialized to SCREEN_W/SCREEN_H; portrait mode swaps them.
extern int16_t g_screenW;
extern int16_t g_screenH;

// ===== Network =====
constexpr uint16_t BRIDGE_DEFAULT_PORT = 9120;
constexpr uint16_t BRIDGE_PORT_MAX     = 9139;
constexpr const char* MDNS_SERVICE     = "_agentdeck";
constexpr const char* MDNS_PROTO       = "_tcp";
constexpr const char* AP_SSID          = "AgentDeck-Setup";
constexpr const char* FIRMWARE_VERSION = "0.1.1";
constexpr uint8_t PROTOCOL_REVISION    = 2;

// ===== WebSocket =====
constexpr uint32_t WS_RECONNECT_MIN_MS  = 1000;
constexpr uint32_t WS_RECONNECT_MAX_MS  = 8000;
constexpr uint32_t WS_PING_INTERVAL_MS  = 15000;
constexpr uint32_t WS_PONG_TIMEOUT_MS   = 30000;

// ===== LVGL =====
#ifndef BOARD_LED8X32
constexpr uint32_t LVGL_TICK_MS        = 5;
constexpr uint32_t LVGL_TIMER_MS       = 5;
#endif
constexpr uint32_t RENDER_INTERVAL_MS  = 33;  // ~30fps

// ===== Terrarium =====
#if defined(BOARD_LED8X32)
constexpr uint8_t  MAX_OCTOPUS         = 1;
constexpr uint8_t  MAX_CLOUD           = 0;
constexpr uint8_t  MAX_OPENCODE        = 0;
constexpr uint8_t  MAX_TETRA           = 0;
constexpr uint8_t  MAX_BUBBLES         = 0;
constexpr uint8_t  MAX_FOOD_CRUMBS     = 0;
constexpr uint8_t  KELP_COUNT          = 0;
constexpr uint8_t  WAVE_SEGMENTS       = 0;
#elif defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
constexpr uint8_t  MAX_OCTOPUS         = 2;
constexpr uint8_t  MAX_CLOUD           = 1;
constexpr uint8_t  MAX_OPENCODE        = 1;
constexpr uint8_t  MAX_TETRA           = 1;   // trimmed for calmer motion on small SPI panels
constexpr uint8_t  MAX_BUBBLES         = 3;   // trimmed (was 6) — less constant motion
constexpr uint8_t  MAX_FOOD_CRUMBS     = 3;
constexpr uint8_t  KELP_COUNT          = 1;
constexpr uint8_t  WAVE_SEGMENTS       = 8;
#elif defined(BOARD_IPS10)
constexpr uint8_t  MAX_OCTOPUS         = 8;
constexpr uint8_t  MAX_CLOUD           = 6;
constexpr uint8_t  MAX_OPENCODE        = 6;
constexpr uint8_t  MAX_TETRA           = 8;
constexpr uint8_t  MAX_BUBBLES         = 30;
constexpr uint8_t  MAX_FOOD_CRUMBS     = 15;
constexpr uint8_t  KELP_COUNT          = 4;
constexpr uint8_t  WAVE_SEGMENTS       = 24;
#elif IS_ROUND
constexpr uint8_t  MAX_OCTOPUS         = 4;
constexpr uint8_t  MAX_CLOUD           = 2;
constexpr uint8_t  MAX_OPENCODE        = 2;
constexpr uint8_t  MAX_TETRA           = 4;
constexpr uint8_t  MAX_BUBBLES         = 12;
constexpr uint8_t  MAX_FOOD_CRUMBS     = 6;
constexpr uint8_t  KELP_COUNT          = 2;
constexpr uint8_t  WAVE_SEGMENTS       = 14;
#else
constexpr uint8_t  MAX_OCTOPUS         = 6;
constexpr uint8_t  MAX_CLOUD           = 4;
constexpr uint8_t  MAX_OPENCODE        = 4;
constexpr uint8_t  MAX_TETRA           = 6;
constexpr uint8_t  MAX_BUBBLES         = 20;
constexpr uint8_t  MAX_FOOD_CRUMBS     = 10;
constexpr uint8_t  KELP_COUNT          = 3;
constexpr uint8_t  WAVE_SEGMENTS       = 20;
#endif

// ===== Timeline =====
#if defined(BOARD_LED8X32)
constexpr uint8_t  TIMELINE_MAX_ENTRIES = 32;
#elif defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
constexpr uint8_t  TIMELINE_MAX_ENTRIES = 4;
#else
constexpr uint8_t  TIMELINE_MAX_ENTRIES = 64;
#endif

// ===== Sin/Cos lookup table =====
constexpr uint16_t SIN_TABLE_SIZE      = 256;

// ===== FreeRTOS =====
constexpr uint8_t  CORE_NETWORK        = 0;
#if defined(BOARD_ESP32_C6_147)
constexpr uint8_t  CORE_UI             = 0;  // ESP32-C6 is single-core — core 1 is invalid
#else
constexpr uint8_t  CORE_UI             = 1;
#endif
constexpr uint32_t STACK_NETWORK       = 8192;
#if defined(BOARD_LED8X32)
constexpr uint32_t STACK_UI            = 4096;
#elif defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
constexpr uint32_t STACK_UI            = 8192;
#elif defined(BOARD_IPS10)
constexpr uint32_t STACK_UI            = 32768;
#else
constexpr uint32_t STACK_UI            = 16384;
#endif

// ===== HUD =====
#ifndef BOARD_LED8X32
constexpr uint8_t  HUD_BAR_HEIGHT      = 24;
#endif

// ===== Matrix (TC001) =====
#if defined(BOARD_LED8X32)
constexpr uint8_t  MATRIX_BRIGHTNESS_MIN = 3;
constexpr uint8_t  MATRIX_BRIGHTNESS_MAX = 120;   // WS2812B max 255, capped for power stability
constexpr uint8_t  MATRIX_BRIGHTNESS_DEF = 60;
constexpr uint32_t PAGE_AUTO_CYCLE_MS    = 8000;   // 8s per page (2 pages)
constexpr uint32_t SCROLL_SPEED_MS       = 90;    // slower scroll
constexpr uint8_t  FONT_CHAR_W           = 4;   // 3px glyph + 1px gap
constexpr uint8_t  FONT_CHAR_H           = 5;
#endif
