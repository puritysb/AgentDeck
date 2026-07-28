#pragma once

// ===== LilyGO T-Embed CC1101 (ST7789 1.9" 320x170 + rotary encoder) =====
// MCU: ESP32-S3-WROOM-1 (N16R8: 16MB QSPI flash, 8MB octal PSRAM)
// The "Companion Knob": the fleet's only rotary-encoder input device.
// Pin map source: vendor README + examples/utilities.h
// (Xinyuan-LilyGO/T-Embed-CC1101). SPI bus is SHARED between the display,
// the CC1101 radio (CS 12) and the microSD slot (CS 13) — the display is the
// only SPI device this firmware drives, but never repurpose pins 9/10/11.

#define BOARD_DISPLAY_TYPE   DISPLAY_ST7789_SPI

// Power latch — must be driven HIGH early in setup() or the board browns out
// the moment it runs from battery (USB masks this).
#define BOARD_PIN_PWR_EN     15

// Display SPI pins (ST7789, RST not wired)
#define BOARD_PIN_SPI_MOSI   9
#define BOARD_PIN_SPI_MISO   10
#define BOARD_PIN_SPI_SCLK   11
#define BOARD_PIN_SPI_CS     41
#define BOARD_PIN_SPI_DC     16
#define BOARD_PIN_SPI_RST    -1
#define BOARD_PIN_BL         21

// Rotary encoder (quadrature) + center key. The key sits on GPIO0 (boot
// strap): safe at runtime, but a press held through reset enters download
// mode — that is a feature, not a bug.
#define BOARD_PIN_ENC_A      4
#define BOARD_PIN_ENC_B      5
#define BOARD_PIN_ENC_KEY    0

// Side user key (below the encoder on the vendor case)
#define BOARD_PIN_USER_KEY   6

// WS2812 ring around the knob
#define BOARD_PIN_WS2812     14
#define BOARD_WS2812_COUNT   8

// I2C (PN532 0x24, BQ27220 fuel gauge 0x55, BQ25896 charger 0x6B)
#define BOARD_PIN_I2C_SDA    8
#define BOARD_PIN_I2C_SCL    18

// PN532 NFC (I2C 0x24) auxiliary pins
#define BOARD_PIN_NFC_IRQ    17
#define BOARD_PIN_NFC_RST    45

// IR transceiver — EN must be driven HIGH before the receiver sees anything
#define BOARD_PIN_IR_EN      2
#define BOARD_PIN_IR_RX      1

// PDM microphone (vendor: BOARD_MIC_DATA / BOARD_MIC_CLK)
#define BOARD_PIN_MIC_DATA   42
#define BOARD_PIN_MIC_CLK    39

// Speaker I2S (vendor "voice" pins; mic is a separate PDM pair 42/39).
// A bare I2S amplifier — no codec, so no I2C init and no MCLK.
#define BOARD_HAS_SPEAKER    1
#define BOARD_PIN_SPK_BCLK   46
#define BOARD_PIN_SPK_LRCLK  40
#define BOARD_PIN_SPK_DIN    7

// Display settings — panel native is 170x320 portrait; the device is used
// landscape-only (rotation 1 → 320x170), so no runtime rotation machinery.
#define BOARD_ROTATION       3     // landscape, knob on the right, pins down
#define BOARD_INVERT         true  // ST7789 IPS panel
#define BOARD_NATIVE_W       170
#define BOARD_NATIVE_H       320
