#pragma once

// ===== iDotMatrix 32x32 - ESP32-S3 WS2812B LED Matrix =====
// Chip: ESP32-S3 (dual-core, PSRAM)
// USB: Native USB OTG (ARDUINO_USB_CDC_ON_BOOT=1)
// MAC: D0:CF:13:1E:0B:64
//
// This board is a 32x32 LED matrix display compatible with iDotMatrix app.
// Uses WS2812B addressable LEDs driven by single GPIO + RMT controller.

// Display: WS2812B 32x32 addressable LED matrix (1024 LEDs)
#define BOARD_DISPLAY_TYPE   DISPLAY_WS2812B_MATRIX
#define BOARD_PIN_LED_DATA   16    // GPIO16 - another common LED data pin
#define MATRIX_W             32
#define MATRIX_H             32
#define MATRIX_LEDS          1024

// Buttons (active LOW, internal pull-up)
// NOTE: Actual GPIO pins may vary - adjust after hardware inspection
#define BOARD_PIN_BTN_LEFT   0     // BOOT button (GPIO0 - built-in)
#define BOARD_PIN_BTN_MID    35    // Adjust based on actual hardware
#define BOARD_PIN_BTN_RIGHT  36    // Adjust based on actual hardware

// Buzzer (may not exist on all iDotMatrix devices)
#define BOARD_PIN_BUZZER     37    // Adjust based on actual hardware

// Light sensor (optional - may not exist on iDotMatrix)
#define BOARD_PIN_LIGHT_SENSOR 4    // ADC1_CH0 - ambient light (LDR)
