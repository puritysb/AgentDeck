#pragma once

// ===== LilyGO T-Display-S3-Pro V1.1 (ST7796U 2.33" 480x222 + touch) =====
// MCU: ESP32-S3R8 (16MB QSPI flash, 8MB octal PSRAM)
// The "Tide Ticker": a wide always-on desk strip (usage gauges + session
// ticker). Pin map source: vendor examples/AdjustBacklight/utilities.h.
//
// V1.1 backlight is NOT PWM: a constant-current driver stepped by pulsing
// GPIO 48 (16 levels, AW9364-style). USING_DISPLAY_PRO_V1 must stay
// undefined for the on-hand V1.1 units — see docs/hardware-compatibility.md.

#define BOARD_DISPLAY_TYPE   DISPLAY_ST7796_SPI

// Display SPI pins (bus shared with microSD, CS 14 — not driven here)
#define BOARD_PIN_SPI_MOSI   17
#define BOARD_PIN_SPI_MISO   8
#define BOARD_PIN_SPI_SCLK   18
#define BOARD_PIN_SPI_CS     39
#define BOARD_PIN_SPI_DC     9
#define BOARD_PIN_SPI_RST    47
#define BOARD_PIN_BL         48

// Four physical buttons: RST is wired directly to reset; the three
// app-readable active-LOW controls are BOOT and the two halves of the rocker.
// BTN1 sits on GPIO0 (boot strap — runtime-safe).
#define BOARD_PIN_BTN1       0
#define BOARD_PIN_BTN2       12
#define BOARD_PIN_BTN3       16

// I2C bus (CST226SE touch 0x5A, LTR-553ALS light 0x23, SY6970 PMU 0x6A;
// the camera SCCB shares it — esp_camera reuses Wire's port, see photo_capture)
#define BOARD_PIN_I2C_SDA    5
#define BOARD_PIN_I2C_SCL    6
#define BOARD_PIN_TOUCH_RST  13
#define BOARD_PIN_TOUCH_INT  21

// Rear camera POGO shield (GC0308 on the on-hand unit; OV5640 drops into the
// same header). DVP parallel bus — pixel data never touches the I2C pins; only
// SCCB config does, and that runs through Wire's port at init. Pin map source:
// vendor examples/CameraShield/utilities.h. Probed at boot: the no-camera unit
// runs this same binary and simply never grows the CAM page.
#define BOARD_HAS_DVP_CAMERA 1
#define BOARD_CAM_PIN_PWDN   46
#define BOARD_CAM_PIN_RESET  (-1)
#define BOARD_CAM_PIN_XCLK   11
#define BOARD_CAM_PIN_PCLK   2
#define BOARD_CAM_PIN_VSYNC  7
#define BOARD_CAM_PIN_HREF   15
#define BOARD_CAM_PIN_Y2     45
#define BOARD_CAM_PIN_Y3     41
#define BOARD_CAM_PIN_Y4     40
#define BOARD_CAM_PIN_Y5     42
#define BOARD_CAM_PIN_Y6     1
#define BOARD_CAM_PIN_Y7     3
#define BOARD_CAM_PIN_Y8     10
#define BOARD_CAM_PIN_Y9     4
// White illumination LED on the shield (PWM-dimmed; full-on runs hot).
#define BOARD_CAM_PIN_LED    38

// Display settings — panel native 222x480 portrait; the ticker is
// landscape-only (rotation → 480x222).
#define BOARD_ROTATION       1
#define BOARD_INVERT         true
#define BOARD_NATIVE_W       222
#define BOARD_NATIVE_H       480
