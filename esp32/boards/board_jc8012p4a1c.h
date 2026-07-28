#pragma once

// ===== JC8012P4A1C — 10.1" IPS 800x1280 (JD9365 MIPI-DSI + GSL3680 I2C Touch) =====
// MCU: ESP32-P4NRW32 (RISC-V Dual-Core 400MHz, 32MB PSRAM, 16MB Flash)
// Co-processor: ESP32-C6-MINI-1U-N4
// Manufacturer: Guition (Jingcai)

#define BOARD_DISPLAY_TYPE   DISPLAY_JD9365_MIPI_DSI

// Display Pins
#define BOARD_PIN_RST        27
#define BOARD_PIN_BL         23

// Touch: GSL3680 (I2C)
#define BOARD_TOUCH_TYPE     TOUCH_GSL3680
#define BOARD_TOUCH_ADDR     0x40
#define BOARD_PIN_TOUCH_SDA  7
#define BOARD_PIN_TOUCH_SCL  8
#define BOARD_PIN_TOUCH_INT  21
#define BOARD_PIN_TOUCH_RST  22

// Display settings
#define BOARD_ROTATION       0     // Portrait native: 800 x 1280
#define BOARD_INVERT         false
#define BOARD_NATIVE_W       800   // Panel native width
#define BOARD_NATIVE_H       1280  // Panel native height

// Audio: ES8311 codec CONFIRMED at I2C 0x18 on the touch bus (I2C_NUM_1,
// SDA 7 / SCL 8) — chip ID 0xFD/0xFE = 0x83/0x11, version 0x01, ACK 5/5,
// registers at reset defaults. Measured 2026-07-27 with UI::hwI2cProbe()
// ({"type":"i2c_diag"}); the same sweep also found unidentified devices at
// 0x32 and 0x36.
//
// BOARD_HAS_AUDIO gates the *mic* / wake-word path only, which is a separate
// question from playback — playback is live, see BOARD_HAS_SPEAKER below.
// Capture stays unbuilt: the vendor claims two microphones, nothing has
// verified them, and the codec's ADC half is unconfigured.
#define BOARD_HAS_AUDIO      0

// ---- Speaker playback via the ES8311 -------------------------------------
// Pins from the board's own ESP-IDF BSP (`bsp_jc8012p4a1c`,
// esp32_p4_function_ev_board.h: BSP_I2S_SCLK/MCLK/LCLK/DOUT/DSIN and
// BSP_POWER_AMP_IO), corroborated for the I2S quartet by two independent
// ESPHome community configs for this board.
//
// The first attempt guessed these from the Waveshare ESP32-P4-NANO reference
// layout. That got all four I2S pins right and the power amplifier wrong
// (53 instead of 20) — which is silent in exactly the way a correct build is:
// the codec ACKs its whole init sequence and I2S consumes every sample, with
// nothing driving the speaker. Do not re-derive these from another vendor's
// board.
#define BOARD_HAS_SPEAKER        1
#define BOARD_SPK_CODEC_ES8311   1
#define BOARD_ES8311_I2C_ADDR    0x18   // measured 2026-07-27 (0x19 was absent)
#define BOARD_PIN_SPK_MCLK       13
#define BOARD_PIN_SPK_BCLK       12
#define BOARD_PIN_SPK_LRCLK      10
#define BOARD_PIN_SPK_DIN         9     // ESP32 data out → codec DSDIN
#define BOARD_PIN_SPK_PA_EN      20     // power-amp enable
#define BOARD_PIN_MIC_DIN        11     // codec ASDOUT → ESP32; capture is not built yet
