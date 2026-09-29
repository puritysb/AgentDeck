#pragma once

// TRMNL 7.5" — Seeed TRMNL 7.5" OG DIY Kit
// XIAO ESP32-S3 (chip is 16MB-flash "Plus" grade per esptool flash_id, 8MB octal
// PSRAM) + 7.5" 800×480 1-bit e-ink panel (Good Display GDEY075T7, UC8179 driver)
// on the kit's EE04 driver board. Pin map per the Seeed ESPHome cookbook,
// cross-checked with usetrmnl/trmnl-firmware include/config.h (VBAT/battery pins agree).
//
// Flash layout caveat: the seeed_xiao_esp32s3 BSP is 8MB (default_8MB.csv /
// upload.flash_size=8MB) and bakes an 8MB flash-size field into the 2nd-stage
// bootloader. [env:trmnl_75] in platformio.ini MUST keep flash_size + partitions
// at 8MB — a 16MB partition table is rejected ("exceeds flash chip size 0x800000")
// and boot-loops. The chip being physically 16MB does not help here.
//
// No BOOT(GPIO0) button is exposed on this kit (only RST + KEY1=GPIO2 /
// KEY2=GPIO3 / KEY3=GPIO5). ROM download mode cannot be entered via buttons —
// flash by catching the USB-Serial/JTAG boot window after an RST (see
// DEVELOPMENT_LOG 2026-07-04 "TRMNL 7.5" 최초 실기 플래시").

#define BOARD_NAME "TRMNL 7.5 e-ink"

// E-paper SPI (hardware FSPI on the XIAO S3)
#define BOARD_PIN_EPD_SCK   7
#define BOARD_PIN_EPD_MOSI  9
#define BOARD_PIN_EPD_CS    44
#define BOARD_PIN_EPD_DC    10
#define BOARD_PIN_EPD_RST   38
#define BOARD_PIN_EPD_BUSY  4

// Front keys (INPUT_PULLUP, active low)
#define BOARD_PIN_KEY1      2
#define BOARD_PIN_KEY2      3

// Battery telemetry (unused — TRMNL 7.5" runs USB-powered)
#define BOARD_PIN_VBAT_EN   6
#define BOARD_PIN_VBAT_ADC  1
