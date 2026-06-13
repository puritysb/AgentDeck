#pragma once

// ===== Waveshare ESP32-C6-LCD-1.47" (ST7789 172x320 SPI) =====
// MCU: ESP32-C6 (RISC-V, single-core), no PSRAM
// Flash: 4MB
// Native USB CDC (no UART bridge chip) — Serial over /dev/cu.usbmodem*

#define BOARD_DISPLAY_TYPE   DISPLAY_ST7789_SPI

// Display SPI Pins
#define BOARD_PIN_SPI_MOSI   6
#define BOARD_PIN_SPI_SCLK   7
#define BOARD_PIN_SPI_CS     14
#define BOARD_PIN_SPI_DC     15
#define BOARD_PIN_SPI_RST    21
#define BOARD_PIN_BL         22

// BOOT button (GPIO9) — repurposed at runtime to toggle screen orientation
// (board has no touch). Active LOW, internal pull-up.
#define BOARD_PIN_BTN1       9

// Display settings
#define BOARD_ROTATION       0     // Portrait native: 172 x 320
#define BOARD_INVERT         true  // Invert required for ST7789
#define BOARD_NATIVE_W       172
#define BOARD_NATIVE_H       320

// System dimensions
#define SCREEN_W             172
#define SCREEN_H             320
