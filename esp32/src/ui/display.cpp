#include "display.h"
#include "config.h"
#include "../boards/board_config.h"
#include "fonts/font_noto_kr_12.h"
#if defined(BOARD_IPS10) || defined(BOARD_T_DISPLAY_PRO) || defined(BOARD_T_EMBED)
#include "fonts/font_noto_kr_16.h"
#endif
#if defined(BOARD_T_DISPLAY_PRO)
#include "../input/touch_strip.h"
#endif

#include <lvgl.h>
#include <Arduino.h>
#include <Preferences.h>

// Runtime screen dimensions (initialized to build-flag defaults)
int16_t g_screenW = SCREEN_W;
int16_t g_screenH = SCREEN_H;

#if !defined(BOARD_AMOLED) && !defined(BOARD_IPS35) && !defined(BOARD_IPS10)
#include <LovyanGFX.hpp>
#endif

// Platform-specific includes for ESP32-S3 Bus_RGB / Panel_RGB
#if defined(BOARD_BOX_86) || defined(BOARD_86_BOX)
#include <lgfx/v1/platforms/esp32s3/Bus_RGB.hpp>
#include <lgfx/v1/platforms/esp32s3/Panel_RGB.hpp>
#endif


// ============================================================
// Board-specific display driver
// ============================================================

#if defined(BOARD_BOX_86) || defined(BOARD_86_BOX)
// ===== ESP32-S3-4848S040: ST7701 RGB 16-bit parallel =====
// Verified pin map from factory firmware backup.
// ST7701 init via 3-wire SPI, display via RGB parallel bus.
class LGFX : public lgfx::LGFX_Device {
public:
    lgfx::Bus_RGB        _bus_instance;
    lgfx::Panel_ST7701_guition_esp32_4848S040 _panel_instance;
    lgfx::Light_PWM      _light_instance;
    lgfx::Touch_GT911    _touch_instance;

    LGFX() {
        // RGB parallel bus configuration
        {
            auto cfg = _bus_instance.config();
            cfg.freq_write = 10000000;  // 10MHz — balanced for ST7701 RGB parallel stability
            cfg.panel = &_panel_instance;  // CRITICAL: Bus_RGB needs panel pointer

            cfg.pin_pclk    = BOARD_PIN_PCLK;   // 21
            cfg.pin_vsync   = BOARD_PIN_VSYNC;  // 17
            cfg.pin_hsync   = BOARD_PIN_HSYNC;  // 16
            cfg.pin_henable = BOARD_PIN_DE;      // 18

            // RGB565 data pins
            cfg.pin_d0  = BOARD_PIN_B0;   // 4
            cfg.pin_d1  = BOARD_PIN_B1;   // 5
            cfg.pin_d2  = BOARD_PIN_B2;   // 6
            cfg.pin_d3  = BOARD_PIN_B3;   // 7
            cfg.pin_d4  = BOARD_PIN_B4;   // 15
            cfg.pin_d5  = BOARD_PIN_G0;   // 8
            cfg.pin_d6  = BOARD_PIN_G1;   // 20
            cfg.pin_d7  = BOARD_PIN_G2;   // 3
            cfg.pin_d8  = BOARD_PIN_G3;   // 46
            cfg.pin_d9  = BOARD_PIN_G4;   // 9
            cfg.pin_d10 = BOARD_PIN_G5;   // 10
            cfg.pin_d11 = BOARD_PIN_R0;   // 11
            cfg.pin_d12 = BOARD_PIN_R1;   // 12
            cfg.pin_d13 = BOARD_PIN_R2;   // 13
            cfg.pin_d14 = BOARD_PIN_R3;   // 14
            cfg.pin_d15 = BOARD_PIN_R4;   // 0

            cfg.hsync_pulse_width  = 8;
            cfg.hsync_back_porch   = 60;  // Increased from 50 (more stable)
            cfg.hsync_front_porch  = 10;
            cfg.hsync_polarity     = 0;

            cfg.vsync_pulse_width  = 8;
            cfg.vsync_back_porch   = 30;  // Increased from 20 (more stable)
            cfg.vsync_front_porch  = 10;
            cfg.vsync_polarity     = 0;

            cfg.pclk_active_neg    = 0;
            cfg.de_idle_high       = 1;
            cfg.pclk_idle_high     = 0;

            _bus_instance.config(cfg);
        }
        _panel_instance.setBus(&_bus_instance);

        // Panel configuration
        {
            auto cfg = _panel_instance.config();
            cfg.memory_width  = 480;
            cfg.memory_height = 480;
            cfg.panel_width   = 480;
            cfg.panel_height  = 480;
            cfg.offset_x      = 0;
            cfg.offset_y      = 0;
            _panel_instance.config(cfg);
        }

        // ST7701 init via 3-wire SPI
        {
            auto cfg = _panel_instance.config_detail();
            cfg.pin_cs   = BOARD_PIN_3WIRE_CS;    // 39
            cfg.pin_sclk = BOARD_PIN_3WIRE_CLK;   // 48
            cfg.pin_mosi = BOARD_PIN_3WIRE_MOSI;  // 47
            _panel_instance.config_detail(cfg);
        }

        // Backlight
        {
            auto cfg = _light_instance.config();
            cfg.pin_bl = BOARD_PIN_BL;  // 38
            cfg.invert = false;
            cfg.freq   = 12000;
            cfg.pwm_channel = 0;
            _light_instance.config(cfg);
            _panel_instance.setLight(&_light_instance);
        }

        // Touch: GT911 I2C
        {
            auto cfg = _touch_instance.config();
            cfg.i2c_port = 0;
            cfg.i2c_addr = BOARD_TOUCH_ADDR;      // 0x5D
            cfg.pin_sda  = BOARD_PIN_TOUCH_SDA;    // 19
            cfg.pin_scl  = BOARD_PIN_TOUCH_SCL;    // 45
            cfg.pin_int  = BOARD_PIN_TOUCH_INT;     // -1
            cfg.pin_rst  = BOARD_PIN_TOUCH_RST;     // -1
            cfg.x_min = 0;
            cfg.x_max = 479;
            cfg.y_min = 0;
            cfg.y_max = 479;
            _touch_instance.config(cfg);
            _panel_instance.setTouch(&_touch_instance);
        }

        setPanel(&_panel_instance);
    }
};

#elif defined(BOARD_ESP32_C6_147)
// ===== Waveshare ESP32-C6-LCD-1.47": ST7789 172x320 SPI =====
class LGFX : public lgfx::LGFX_Device {
public:
    lgfx::Bus_SPI        _bus_instance;
    lgfx::Panel_ST7789   _panel_instance;
    lgfx::Light_PWM      _light_instance;

    LGFX() {
        // SPI bus configuration
        {
            auto cfg = _bus_instance.config();
            cfg.spi_host = SPI2_HOST;  // ESP32-C6: general-purpose SPI2 (no VSPI/HSPI)
            cfg.dma_channel = 0;       // Disable DMA for stability on C6 RISC-V
            cfg.freq_write = 40000000; // 40MHz
            cfg.freq_read  = 16000000;
            cfg.pin_sclk = BOARD_PIN_SPI_SCLK;
            cfg.pin_mosi = BOARD_PIN_SPI_MOSI;
            cfg.pin_miso = -1;
            cfg.pin_dc   = BOARD_PIN_SPI_DC;
            _bus_instance.config(cfg);
        }
        _panel_instance.setBus(&_bus_instance);

        // Panel configuration
        {
            auto cfg = _panel_instance.config();
            cfg.pin_cs           = BOARD_PIN_SPI_CS;
            cfg.pin_rst          = BOARD_PIN_SPI_RST;
            cfg.pin_busy         = -1;
            cfg.memory_width     = 240;
            cfg.memory_height    = 320;
            cfg.panel_width      = 172;
            cfg.panel_height     = 320;
            cfg.offset_x         = 34;  // 172-wide window centered in 240-wide GRAM: (240-172)/2
            cfg.offset_y         = 0;
            cfg.offset_rotation  = 0;
            cfg.dummy_read_bits  = 8;
            cfg.readable         = false;
            cfg.invert           = BOARD_INVERT;
            cfg.rgb_order        = false; // BGR order
            _panel_instance.config(cfg);
        }

        // Backlight configuration
        {
            auto cfg = _light_instance.config();
            cfg.pin_bl = BOARD_PIN_BL;
            cfg.invert = false;
            cfg.freq   = 12000;
            cfg.pwm_channel = 0;
            _light_instance.config(cfg);
            _panel_instance.setLight(&_light_instance);
        }

        setPanel(&_panel_instance);
    }
};

#elif defined(BOARD_TTGO)
// ===== TTGO T-Display: ST7789 1.14" 135x240 SPI =====
// Backlight: LovyanGFX Light_PWM is the SINGLE owner of GPIO4. setBrightness()
// and reassertPanel() both go through tft.setBrightness() — never raw Arduino
// ledc (mixing the two left the backlight dark).
class LGFX : public lgfx::LGFX_Device {
public:
    lgfx::Bus_SPI        _bus_instance;
    lgfx::Panel_ST7789   _panel_instance;
    lgfx::Light_PWM      _light_instance;

    LGFX() {
        // SPI bus configuration
        {
            auto cfg = _bus_instance.config();
            cfg.spi_host = VSPI_HOST;  // VSPI on ESP32 classic
            cfg.dma_channel = 0;       // Disable DMA to bypass Core 3.x DMA issues on ESP32 classic
            cfg.freq_write = 20000000; // 20MHz — stable for TTGO ST7789 (40MHz caused flicker/black screen)
            cfg.freq_read  = 16000000;
            cfg.pin_sclk = BOARD_PIN_SPI_SCLK;
            cfg.pin_mosi = BOARD_PIN_SPI_MOSI;
            cfg.pin_miso = -1;
            cfg.pin_dc   = BOARD_PIN_SPI_DC;
            _bus_instance.config(cfg);
        }
        _panel_instance.setBus(&_bus_instance);

        // Panel configuration
        {
            auto cfg = _panel_instance.config();
            cfg.pin_cs           = BOARD_PIN_SPI_CS;
            cfg.pin_rst          = BOARD_PIN_SPI_RST;
            cfg.pin_busy         = -1;
            cfg.memory_width     = 240;
            cfg.memory_height    = 320;
            cfg.panel_width      = 135;
            cfg.panel_height     = 240;
            cfg.offset_x         = 52;
            cfg.offset_y         = 40;
            cfg.offset_rotation  = 0;  // TTGO: use setRotation() for runtime control
            cfg.dummy_read_bits  = 8;
            cfg.readable         = false;
            cfg.invert           = BOARD_INVERT;
            cfg.rgb_order        = false; // BGR order
            _panel_instance.config(cfg);
        }

        // Backlight configuration (LovyanGFX Light_PWM — single owner of GPIO4)
        {
            auto cfg = _light_instance.config();
            cfg.pin_bl = BOARD_PIN_BL;
            cfg.invert = false;
            cfg.freq   = 12000;
            cfg.pwm_channel = 0;
            _light_instance.config(cfg);
            _panel_instance.setLight(&_light_instance);
        }

        setPanel(&_panel_instance);
    }
};

#elif defined(BOARD_T_EMBED)
// ===== LilyGO T-Embed CC1101: ST7789 1.9" 170x320 SPI (S3) =====
// The SPI bus is shared with CC1101 (CS 12) and microSD (CS 13); the display
// is the only device this firmware drives, write-only (no MISO claimed).
// RST is not wired (-1) — the panel resets with the chip.
class LGFX : public lgfx::LGFX_Device {
public:
    lgfx::Bus_SPI        _bus_instance;
    lgfx::Panel_ST7789   _panel_instance;
    lgfx::Light_PWM      _light_instance;

    LGFX() {
        // SPI bus configuration
        {
            auto cfg = _bus_instance.config();
            cfg.spi_host = SPI2_HOST;  // ESP32-S3 general-purpose FSPI
            cfg.dma_channel = 0;       // bring-up conservative: no DMA (mirrors C6/TTGO)
            cfg.freq_write = 40000000;
            cfg.freq_read  = 16000000;
            cfg.pin_sclk = BOARD_PIN_SPI_SCLK;
            cfg.pin_mosi = BOARD_PIN_SPI_MOSI;
            cfg.pin_miso = -1;
            cfg.pin_dc   = BOARD_PIN_SPI_DC;
            _bus_instance.config(cfg);
        }
        _panel_instance.setBus(&_bus_instance);

        // Panel configuration
        {
            auto cfg = _panel_instance.config();
            cfg.pin_cs           = BOARD_PIN_SPI_CS;
            cfg.pin_rst          = BOARD_PIN_SPI_RST;   // -1
            cfg.pin_busy         = -1;
            cfg.memory_width     = 240;
            cfg.memory_height    = 320;
            cfg.panel_width      = 170;
            cfg.panel_height     = 320;
            cfg.offset_x         = 35;  // 170-wide window centered in 240-wide GRAM
            cfg.offset_y         = 0;
            cfg.offset_rotation  = 0;
            cfg.dummy_read_bits  = 8;
            cfg.readable         = false;
            cfg.invert           = BOARD_INVERT;
            cfg.rgb_order        = false; // BGR order
            _panel_instance.config(cfg);
        }

        // Backlight (Light_PWM single owner of GPIO21)
        {
            auto cfg = _light_instance.config();
            cfg.pin_bl = BOARD_PIN_BL;
            cfg.invert = false;
            cfg.freq   = 12000;
            cfg.pwm_channel = 0;
            _light_instance.config(cfg);
            _panel_instance.setLight(&_light_instance);
        }

        setPanel(&_panel_instance);
    }
};

#elif defined(BOARD_T_DISPLAY_PRO)
// ===== LilyGO T-Display-S3-Pro: ST7796U 222x480 SPI (S3) =====
// No Light_PWM: the V1.1 backlight is a pulse-stepped constant-current driver
// (16 levels on GPIO 48) — see tdisplayProSetBacklightLevel below.
class LGFX : public lgfx::LGFX_Device {
public:
    lgfx::Bus_SPI        _bus_instance;
    lgfx::Panel_ST7796   _panel_instance;

    LGFX() {
        {
            auto cfg = _bus_instance.config();
            cfg.spi_host = SPI2_HOST;
            cfg.dma_channel = 0;       // bring-up conservative: no DMA
            cfg.freq_write = 40000000;
            cfg.freq_read  = 16000000;
            cfg.pin_sclk = BOARD_PIN_SPI_SCLK;
            cfg.pin_mosi = BOARD_PIN_SPI_MOSI;
            cfg.pin_miso = -1;
            cfg.pin_dc   = BOARD_PIN_SPI_DC;
            _bus_instance.config(cfg);
        }
        _panel_instance.setBus(&_bus_instance);

        {
            auto cfg = _panel_instance.config();
            cfg.pin_cs           = BOARD_PIN_SPI_CS;
            cfg.pin_rst          = BOARD_PIN_SPI_RST;
            cfg.pin_busy         = -1;
            cfg.memory_width     = 320;   // ST7796 GRAM
            cfg.memory_height    = 480;
            cfg.panel_width      = 222;
            cfg.panel_height     = 480;
            cfg.offset_x         = 49;    // (320-222)/2 — verify on hardware
            cfg.offset_y         = 0;
            cfg.offset_rotation  = 0;
            cfg.dummy_read_bits  = 8;
            cfg.readable         = false;
            cfg.invert           = BOARD_INVERT;
            cfg.rgb_order        = false;
            _panel_instance.config(cfg);
        }

        setPanel(&_panel_instance);
    }
};

#elif defined(BOARD_IPS35)
// ===== JC3248W535: AXS15231B QSPI =====
// Requires Arduino_Canvas wrapper — direct QSPI writes produce black screen.
// Canvas buffers in PSRAM (~307KB), flush() sends to display.

#include <Arduino_GFX_Library.h>
#include <Wire.h>

static Arduino_DataBus* gfx_bus = nullptr;
static Arduino_GFX* gfx_raw = nullptr;       // Underlying AXS15231B display
static Arduino_Canvas* gfx_canvas = nullptr;  // Canvas wrapper (used for drawing)
static Arduino_GFX* gfx = nullptr;            // Points to gfx_canvas

// AXS15231B integrated touch read via I2C (addr 0x3B)
// Uses 11-byte command preamble protocol (NOT register addressing like CST816S)
static bool touch_read_axs15231b(uint16_t* x, uint16_t* y) {
    static const uint8_t read_cmd[] = {
        0xB5, 0xAB, 0xA5, 0x5A, 0x00, 0x00, 0x00, 0x08,
        0x00, 0x00, 0x00
    };

    Wire.beginTransmission(BOARD_TOUCH_ADDR);  // 0x3B
    Wire.write(read_cmd, sizeof(read_cmd));
    if (Wire.endTransmission() != 0) return false;  // Full stop (NOT repeated start)

    if (Wire.requestFrom((uint8_t)BOARD_TOUCH_ADDR, (uint8_t)8) != 8) return false;
    uint8_t buf[8];
    for (int i = 0; i < 8; i++) buf[i] = Wire.read();

    // buf[0] = gesture, buf[1] = num_touches
    if (buf[0] != 0 || buf[1] == 0) return false;  // No valid touch

    uint16_t raw_x = ((buf[2] & 0x0F) << 8) | buf[3];
    uint16_t raw_y = ((buf[4] & 0x0F) << 8) | buf[5];
    // Orientation-aware coordinate transform
    if (g_screenW > g_screenH) {
        // Landscape: swap and mirror
        *x = raw_y;
        *y = BOARD_NATIVE_W - 1 - raw_x;
    } else {
        // Portrait: native orientation
        *x = raw_x;
        *y = raw_y;
    }
    return true;
}

#elif defined(BOARD_AMOLED)
// ===== JC3636W518: ST77916 QSPI AMOLED =====
// Custom init: st77916_150 base + COLMOD 0x55 fix + gamma WRITE_C8_BYTES fix + OTP cal
// Panel is 1.5" variant (not 1.8") — uses different GIP/power values than default 180 init.

#include <Arduino_GFX_Library.h>
#include <Wire.h>

static const uint8_t st77916_jc3636w518_init[] = {
    BEGIN_WRITE,
    // Command set preamble (150 variant)
    WRITE_C8_D8, 0xF0, 0x28,
    WRITE_C8_D8, 0xF2, 0x28,
    WRITE_C8_D8, 0x73, 0xF0,
    WRITE_C8_D8, 0x7C, 0xD1,
    WRITE_C8_D8, 0x83, 0xE0,
    WRITE_C8_D8, 0x84, 0x61,
    WRITE_C8_D8, 0xF2, 0x82,
    WRITE_C8_D8, 0xF0, 0x00,
    WRITE_C8_D8, 0xF0, 0x01,
    WRITE_C8_D8, 0xF1, 0x01,
    // Power registers (150 variant)
    WRITE_C8_D8, 0xB0, 0x69, WRITE_C8_D8, 0xB1, 0x4A,
    WRITE_C8_D8, 0xB2, 0x2F, WRITE_C8_D8, 0xB3, 0x01,
    WRITE_C8_D8, 0xB4, 0x69, WRITE_C8_D8, 0xB5, 0x45,
    WRITE_C8_D8, 0xB6, 0xAB, WRITE_C8_D8, 0xB7, 0x41,
    WRITE_C8_D8, 0xB8, 0x86, WRITE_C8_D8, 0xB9, 0x15,
    WRITE_C8_D8, 0xBA, 0x00, WRITE_C8_D8, 0xBB, 0x08,
    WRITE_C8_D8, 0xBC, 0x08, WRITE_C8_D8, 0xBD, 0x00,
    WRITE_C8_D8, 0xBE, 0x00, WRITE_C8_D8, 0xBF, 0x07,
    // Frame rate
    WRITE_C8_D8, 0xC0, 0x80, WRITE_C8_D8, 0xC1, 0x10,
    WRITE_C8_D8, 0xC2, 0x37, WRITE_C8_D8, 0xC3, 0x80,
    WRITE_C8_D8, 0xC4, 0x10, WRITE_C8_D8, 0xC5, 0x37,
    // Power control
    WRITE_C8_D8, 0xC6, 0xA9, WRITE_C8_D8, 0xC7, 0x41,
    WRITE_C8_D8, 0xC8, 0x01, WRITE_C8_D8, 0xC9, 0xA9,
    WRITE_C8_D8, 0xCA, 0x41, WRITE_C8_D8, 0xCB, 0x01,
    WRITE_C8_D8, 0xCC, 0x7F, WRITE_C8_D8, 0xCD, 0x7F,
    WRITE_C8_D8, 0xCE, 0xFF,
    // Resolution
    WRITE_C8_D8, 0xD0, 0x91, WRITE_C8_D8, 0xD1, 0x68,
    WRITE_C8_D8, 0xD2, 0x68,
    WRITE_C8_D16, 0xF5, 0x00, 0xA5,
    WRITE_C8_D8, 0xF1, 0x10,
    WRITE_C8_D8, 0xF0, 0x00,
    // Gamma — WRITE_C8_BYTES sends via 0x02 (correct register, not RAMWRC)
    WRITE_C8_D8, 0xF0, 0x02,
    WRITE_C8_BYTES, 0xE0, 14,
    0xF0, 0x10, 0x18, 0x0D, 0x0C, 0x38, 0x3E, 0x44,
    0x51, 0x39, 0x15, 0x15, 0x30, 0x34,
    WRITE_C8_BYTES, 0xE1, 14,
    0xF0, 0x0F, 0x17, 0x0D, 0x0B, 0x07, 0x3E, 0x33,
    0x51, 0x39, 0x15, 0x15, 0x30, 0x34,
    WRITE_C8_D8, 0xF0, 0x10,
    // GIP (150 variant)
    WRITE_C8_D8, 0xF3, 0x10,
    WRITE_C8_D8, 0xE0, 0x08, WRITE_C8_D8, 0xE1, 0x00,
    WRITE_C8_D8, 0xE2, 0x00, WRITE_C8_D8, 0xE3, 0x00,
    WRITE_C8_D8, 0xE4, 0xE0, WRITE_C8_D8, 0xE5, 0x06,
    WRITE_C8_D8, 0xE6, 0x21, WRITE_C8_D8, 0xE7, 0x03,
    WRITE_C8_D8, 0xE8, 0x05, WRITE_C8_D8, 0xE9, 0x02,
    WRITE_C8_D8, 0xEA, 0xE9, WRITE_C8_D8, 0xEB, 0x00,
    WRITE_C8_D8, 0xEC, 0x00, WRITE_C8_D8, 0xED, 0x14,
    WRITE_C8_D8, 0xEE, 0xFF, WRITE_C8_D8, 0xEF, 0x00,
    WRITE_C8_D8, 0xF8, 0xFF, WRITE_C8_D8, 0xF9, 0x00,
    WRITE_C8_D8, 0xFA, 0x00, WRITE_C8_D8, 0xFB, 0x30,
    WRITE_C8_D8, 0xFC, 0x00, WRITE_C8_D8, 0xFD, 0x00,
    WRITE_C8_D8, 0xFE, 0x00, WRITE_C8_D8, 0xFF, 0x00,
    // Channel config
    WRITE_C8_D8, 0x60, 0x40, WRITE_C8_D8, 0x61, 0x05,
    WRITE_C8_D8, 0x62, 0x00, WRITE_C8_D8, 0x63, 0x42,
    WRITE_C8_D8, 0x64, 0xDA, WRITE_C8_D8, 0x65, 0x00,
    WRITE_C8_D8, 0x66, 0x00, WRITE_C8_D8, 0x67, 0x00,
    WRITE_C8_D8, 0x68, 0x00, WRITE_C8_D8, 0x69, 0x00,
    WRITE_C8_D8, 0x6A, 0x00, WRITE_C8_D8, 0x6B, 0x00,
    WRITE_C8_D8, 0x70, 0x40, WRITE_C8_D8, 0x71, 0x04,
    WRITE_C8_D8, 0x72, 0x00, WRITE_C8_D8, 0x73, 0x42,
    WRITE_C8_D8, 0x74, 0xD9, WRITE_C8_D8, 0x75, 0x00,
    WRITE_C8_D8, 0x76, 0x00, WRITE_C8_D8, 0x77, 0x00,
    WRITE_C8_D8, 0x78, 0x00, WRITE_C8_D8, 0x79, 0x00,
    WRITE_C8_D8, 0x7A, 0x00, WRITE_C8_D8, 0x7B, 0x00,
    // Gate driver (0x48 base)
    WRITE_C8_D8, 0x80, 0x48, WRITE_C8_D8, 0x81, 0x00,
    WRITE_C8_D8, 0x82, 0x07, WRITE_C8_D8, 0x83, 0x02,
    WRITE_C8_D8, 0x84, 0xD7, WRITE_C8_D8, 0x85, 0x04,
    WRITE_C8_D8, 0x86, 0x00, WRITE_C8_D8, 0x87, 0x00,
    WRITE_C8_D8, 0x88, 0x48, WRITE_C8_D8, 0x89, 0x00,
    WRITE_C8_D8, 0x8A, 0x09, WRITE_C8_D8, 0x8B, 0x02,
    WRITE_C8_D8, 0x8C, 0xD9, WRITE_C8_D8, 0x8D, 0x04,
    WRITE_C8_D8, 0x8E, 0x00, WRITE_C8_D8, 0x8F, 0x00,
    WRITE_C8_D8, 0x90, 0x48, WRITE_C8_D8, 0x91, 0x00,
    WRITE_C8_D8, 0x92, 0x0B, WRITE_C8_D8, 0x93, 0x02,
    WRITE_C8_D8, 0x94, 0xDB, WRITE_C8_D8, 0x95, 0x04,
    WRITE_C8_D8, 0x96, 0x00, WRITE_C8_D8, 0x97, 0x00,
    WRITE_C8_D8, 0x98, 0x48, WRITE_C8_D8, 0x99, 0x00,
    WRITE_C8_D8, 0x9A, 0x0D, WRITE_C8_D8, 0x9B, 0x02,
    WRITE_C8_D8, 0x9C, 0xDD, WRITE_C8_D8, 0x9D, 0x04,
    WRITE_C8_D8, 0x9E, 0x00, WRITE_C8_D8, 0x9F, 0x00,
    WRITE_C8_D8, 0xA0, 0x48, WRITE_C8_D8, 0xA1, 0x00,
    WRITE_C8_D8, 0xA2, 0x06, WRITE_C8_D8, 0xA3, 0x02,
    WRITE_C8_D8, 0xA4, 0xD6, WRITE_C8_D8, 0xA5, 0x04,
    WRITE_C8_D8, 0xA6, 0x00, WRITE_C8_D8, 0xA7, 0x00,
    WRITE_C8_D8, 0xA8, 0x48, WRITE_C8_D8, 0xA9, 0x00,
    WRITE_C8_D8, 0xAA, 0x08, WRITE_C8_D8, 0xAB, 0x02,
    WRITE_C8_D8, 0xAC, 0xD8, WRITE_C8_D8, 0xAD, 0x04,
    WRITE_C8_D8, 0xAE, 0x00, WRITE_C8_D8, 0xAF, 0x00,
    WRITE_C8_D8, 0xB0, 0x48, WRITE_C8_D8, 0xB1, 0x00,
    WRITE_C8_D8, 0xB2, 0x0A, WRITE_C8_D8, 0xB3, 0x02,
    WRITE_C8_D8, 0xB4, 0xDA, WRITE_C8_D8, 0xB5, 0x04,
    WRITE_C8_D8, 0xB6, 0x00, WRITE_C8_D8, 0xB7, 0x00,
    WRITE_C8_D8, 0xB8, 0x48, WRITE_C8_D8, 0xB9, 0x00,
    WRITE_C8_D8, 0xBA, 0x0C, WRITE_C8_D8, 0xBB, 0x02,
    WRITE_C8_D8, 0xBC, 0xDC, WRITE_C8_D8, 0xBD, 0x04,
    WRITE_C8_D8, 0xBE, 0x00, WRITE_C8_D8, 0xBF, 0x00,
    // Gate mapping
    WRITE_C8_D8, 0xC0, 0x10, WRITE_C8_D8, 0xC1, 0x47,
    WRITE_C8_D8, 0xC2, 0x56, WRITE_C8_D8, 0xC3, 0x65,
    WRITE_C8_D8, 0xC4, 0x74, WRITE_C8_D8, 0xC5, 0x88,
    WRITE_C8_D8, 0xC6, 0x99, WRITE_C8_D8, 0xC7, 0x01,
    WRITE_C8_D8, 0xC8, 0xBB, WRITE_C8_D8, 0xC9, 0xAA,
    WRITE_C8_D8, 0xD0, 0x10, WRITE_C8_D8, 0xD1, 0x47,
    WRITE_C8_D8, 0xD2, 0x56, WRITE_C8_D8, 0xD3, 0x65,
    WRITE_C8_D8, 0xD4, 0x74, WRITE_C8_D8, 0xD5, 0x88,
    WRITE_C8_D8, 0xD6, 0x99, WRITE_C8_D8, 0xD7, 0x01,
    WRITE_C8_D8, 0xD8, 0xBB, WRITE_C8_D8, 0xD9, 0xAA,
    // Exit GIP
    WRITE_C8_D8, 0xF3, 0x01,
    WRITE_C8_D8, 0xF0, 0x00,
    // OTP calibration (factory trim)
    WRITE_C8_D8, 0xF0, 0x01,
    WRITE_C8_D8, 0xF1, 0x01,
    WRITE_C8_D8, 0xA0, 0x0B,
    WRITE_C8_D8, 0xA3, 0x2A, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2B, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2C, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2D, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2E, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x2F, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x30, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x31, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x32, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA3, 0x33, WRITE_C8_D8, 0xA5, 0xC3,
    END_WRITE, DELAY, 1, BEGIN_WRITE,
    WRITE_C8_D8, 0xA0, 0x09,
    WRITE_C8_D8, 0xF1, 0x10,
    WRITE_C8_D8, 0xF0, 0x00,
    // CASET/RASET + RAM clear
    WRITE_C8_BYTES, 0x2A, 4, 0x00, 0x00, 0x01, 0x67,
    WRITE_C8_BYTES, 0x2B, 4, 0x01, 0x68, 0x01, 0x68,
    WRITE_C8_D8, 0x4D, 0x00, WRITE_C8_D8, 0x4E, 0x00,
    WRITE_C8_D8, 0x4F, 0x00, WRITE_C8_D8, 0x4C, 0x01,
    END_WRITE, DELAY, 10, BEGIN_WRITE,
    WRITE_C8_D8, 0x4C, 0x00,
    WRITE_C8_BYTES, 0x2A, 4, 0x00, 0x00, 0x01, 0x67,
    WRITE_C8_BYTES, 0x2B, 4, 0x00, 0x00, 0x01, 0x67,
    // Display on
    WRITE_C8_D8, 0x3A, 0x55,  // COLMOD RGB565
    WRITE_COMMAND_8, 0x21,     // INVON
    WRITE_COMMAND_8, 0x11,     // SLPOUT
    END_WRITE,
    DELAY, 120,
    BEGIN_WRITE,
    WRITE_COMMAND_8, 0x29,     // DISPON
    WRITE_COMMAND_8, 0x2C,     // RAMWR
    END_WRITE,
};

static Arduino_DataBus* gfx_bus = nullptr;
static Arduino_GFX* gfx = nullptr;

// CST816S touch read via Wire I2C
static bool touch_read_cst816s(uint16_t* x, uint16_t* y) {
    Wire.beginTransmission(BOARD_TOUCH_ADDR);
    Wire.write(0x01);  // Num touch points register
    Wire.endTransmission(false);
    if (Wire.requestFrom((uint8_t)BOARD_TOUCH_ADDR, (uint8_t)6) < 6) return false;
    uint8_t buf[6];
    for (int i = 0; i < 6; i++) buf[i] = Wire.read();
    if (buf[0] == 0) return false;
    *x = ((buf[2] & 0x0F) << 8) | buf[3];
    *y = ((buf[4] & 0x0F) << 8) | buf[5];
    return true;
}

#elif defined(BOARD_IPS10)
// ===== JC8012P4A1C: JD9365 MIPI-DSI 800x1280 + GSL3680 I2C Touch =====
#include "lcd/jd9365_lcd.h"
#include "touch/esp_lcd_touch.h"
#include "touch/esp_lcd_gsl3680.h"
#include <driver/i2c_master.h>
#include <driver/gpio.h>           // gpio_get_level() — read pad state without reconfiguring it
#include <esp_log.h>               // silence the i2c.master NACK warnings during a sweep
#include "../audio/speaker_playback.h"   // claim I2S DMA before the LVGL buffer
#include "driver/ppa.h"            // ESP32-P4 2D Pixel-Processing Accelerator (HW rotate)
#include "esp_heap_caps.h"
#include "esp_memory_utils.h"      // esp_ptr_internal() — verify LVGL buffer is internal SRAM

static jd9365_lcd* jc_tft = nullptr;
static esp_lcd_touch_handle_t tp_handle = nullptr;
static i2c_master_bus_handle_t i2c_handle = nullptr;
static uint16_t* rotated_buf = nullptr;
static ppa_client_handle_t ppaClient = nullptr;   // null → fall back to CPU transpose
static size_t rotBufSizeG = 0;
#if defined(IPS10_PERF_HUD)
volatile uint32_t g_flushInnerUs = 0;   // accumulated PPA+push time within the current frame
volatile uint32_t g_bufInternal = 0;    // 1 = LVGL draw buffer is in internal SRAM, 0 = PSRAM
#endif

static bool touch_read_gsl3680(uint16_t* x, uint16_t* y) {
    if (!tp_handle) return false;
    esp_lcd_touch_read_data(tp_handle);
    uint8_t cnt = 0;
    bool touched = esp_lcd_touch_get_coordinates(tp_handle, x, y, NULL, &cnt, 1);
    return touched && cnt > 0;
}

// ===== Audio-codec hardware probe (ES8311 hunt) =====
// The vendor sheet claims 2 mics + a speaker behind an ES8311 on this panel,
// but nothing in this repo has ever measured it — board_jc8012p4a1c.h carries
// a bare comment and BOARD_HAS_AUDIO 0. This probe answers "is it there, on
// which bus, at which address" and captures enough context in the same round
// trip (full hit list, register dump, pin levels) that the follow-up playback
// work does not need a second hardware session. That is the 2026-03-21 lesson
// from the mic investigation: a probe that answers only yes/no costs you
// another trip.
//
// Read-only by construction. Address probes and register reads only — never a
// codec register write, and pin levels come from gpio_get_level() so no pad is
// reconfigured. pinMode() on a pin already routed to a peripheral output can
// silently break the panel or the C6 link.
//
// Note this does NOT use Arduino Wire, unlike protocol.cpp's touch_diag. On
// this board the touch bus is an ESP-IDF i2c_master bus (see displayInit
// below); putting the legacy Arduino I2C driver on the same two pads is the
// single most damaging thing this file could do.

// ESP-Hosted SDIO pins for the P4↔C6 Wi-Fi link, read out of the Arduino core's
// esp32p4/sdkconfig (CONFIG_ESP_HOSTED_SDIO_PIN_*). Disturbing this transport
// trips the sdio_rx_get_buffer asserts documented in net/wifi_manager.cpp, so a
// second-bus probe must never be pointed at these.
static const int kHostedSdioPins[] = { 14, 15, 16, 17, 18, 19, 54 };

// I2S/codec pins on the Waveshare ESP32-P4-NANO reference design. HYPOTHESIS
// ONLY — borrowed from a different vendor's board. Guition may differ entirely;
// these are sampled and printed so the operator can eyeball a match, never
// driven.
static const struct { int pin; const char* role; } kCodecPinHypothesis[] = {
    { 13, "MCLK?" }, { 12, "BCLK?" }, { 10, "LRCK?" },
    {  9, "DOUT?" }, { 11, "DIN?"  }, { 53, "PA_EN?" },
};

static const char* i2cAddrNote(uint8_t addr) {
    switch (addr) {
        case BOARD_TOUCH_ADDR: return "GSL3680 touch (this board)";
        case 0x18: case 0x19:  return "ES8311 candidate (also LIS3DH accel / EEPROM)";
        case 0x30: case 0x3C:  return "camera SCCB / OLED common";
        case 0x36:             return "camera SCCB / MAX17048 fuel gauge common";
        case 0x41: case 0x43:  return "ES7210 mic ADC on other designs";
        default:               return "unknown";
    }
}

static bool i2cIsHostedSdioPin(int pin) {
    for (size_t i = 0; i < sizeof(kHostedSdioPins) / sizeof(kHostedSdioPins[0]); i++) {
        if (kHostedSdioPins[i] == pin) return true;
    }
    return false;
}

// One-shot register read. Adds and removes a device handle each call — slow,
// but this is a diagnostic and it keeps the bus free for the touch driver.
static bool i2cReadReg(i2c_master_bus_handle_t bus, uint8_t addr, uint8_t reg, uint8_t* out) {
    i2c_device_config_t dc;
    memset(&dc, 0, sizeof(dc));
    dc.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    dc.device_address  = addr;
    dc.scl_speed_hz    = 100000;   // match the touch bus — 400 kHz risked noise here
    i2c_master_dev_handle_t dev = nullptr;
    if (i2c_master_bus_add_device(bus, &dc, &dev) != ESP_OK) return false;
    esp_err_t err = i2c_master_transmit_receive(dev, &reg, 1, out, 1, 50);
    i2c_master_bus_rm_device(dev);
    return err == ESP_OK;
}

// ES8311 identity: registers 0xFD/0xFE must read 0x83/0x11 (the check the Linux
// es8311 codec driver performs). An ACK alone proves nothing — 0x18/0x19 are
// also LIS3DH and common EEPROM addresses.
static bool es8311Identify(i2c_master_bus_handle_t bus, uint8_t addr) {
    uint8_t id1 = 0, id2 = 0, ver = 0;
    bool r1 = i2cReadReg(bus, addr, 0xFD, &id1);
    bool r2 = i2cReadReg(bus, addr, 0xFE, &id2);
    bool r3 = i2cReadReg(bus, addr, 0xFF, &ver);
    Serial.printf("[I2CDiag]   0x%02X ID regs: FD=%s%02X FE=%s%02X FF=%s%02X (expect FD=83 FE=11)\n",
                  addr,
                  r1 ? "0x" : "ERR:", id1,
                  r2 ? "0x" : "ERR:", id2,
                  r3 ? "0x" : "ERR:", ver);
    if (r1 && r2 && id1 == 0x83 && id2 == 0x11) {
        Serial.printf("[I2CDiag]   => ES8311 CONFIRMED at 0x%02X (version 0x%02X)\n", addr, ver);
        return true;
    }
    if (r1 && r2 && ((id1 == 0x00 && id2 == 0x00) || (id1 == 0xFF && id2 == 0xFF))) {
        Serial.println("[I2CDiag]   => address ACKs but ID reads are dead (00/FF): device present "
                       "with clock or reset line not asserted, OR a different part entirely");
        return false;
    }
    Serial.println("[I2CDiag]   => NOT an ES8311 (ID mismatch)");
    return false;
}

// Sweep 0x08-0x77. The touch controller is skipped rather than probed: an
// address probe mid-run can confuse the GSL3680.
static void i2cSweepBus(i2c_master_bus_handle_t bus, const char* label, bool skipTouch) {
    Serial.printf("[I2CDiag] --- sweep %s ---\n", label);
    // i2c_master_probe logs a warning on every NACK; with CORE_DEBUG_LEVEL=3
    // that buries the result under ~110 lines.
    esp_log_level_set("i2c.master", ESP_LOG_NONE);
    int hits = 0;
    for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
        if (skipTouch && addr == BOARD_TOUCH_ADDR) {
            Serial.printf("[I2CDiag]   0x%02X SKIPPED — %s\n", addr, i2cAddrNote(addr));
            continue;
        }
        if (i2c_master_probe(bus, addr, 50) == ESP_OK) {
            hits++;
            Serial.printf("[I2CDiag]   0x%02X ACK — %s\n", addr, i2cAddrNote(addr));
        }
        vTaskDelay(1);   // do not starve the touch reads sharing this bus
    }
    esp_log_level_set("i2c.master", (esp_log_level_t)CORE_DEBUG_LEVEL);
    Serial.printf("[I2CDiag] --- %s: %d device(s) beyond touch ---\n", label, hits);
}

// Repeat the codec-address probe to separate a real device from bus noise.
// 5/5 is a device; anything in between belongs in the "inconclusive" bucket.
static void i2cCodecAddrStability(i2c_master_bus_handle_t bus) {
    esp_log_level_set("i2c.master", ESP_LOG_NONE);
    for (uint8_t addr = 0x18; addr <= 0x19; addr++) {
        int ok = 0;
        for (int i = 0; i < 5; i++) {
            if (i2c_master_probe(bus, addr, 50) == ESP_OK) ok++;
            vTaskDelay(2);
        }
        Serial.printf("[I2CDiag]   0x%02X stability: %d/5 %s\n", addr, ok,
                      ok == 5 ? "(stable — real device)"
                              : ok == 0 ? "(absent)" : "(UNSTABLE — noise or missing pullups)");
    }
    esp_log_level_set("i2c.master", (esp_log_level_t)CORE_DEBUG_LEVEL);
}

static void i2cPinCensus() {
    Serial.println("[I2CDiag] --- candidate pin levels (read-only; HYPOTHESIS map from "
                   "Waveshare ESP32-P4-NANO, NOT confirmed for Guition) ---");
    for (size_t i = 0; i < sizeof(kCodecPinHypothesis) / sizeof(kCodecPinHypothesis[0]); i++) {
        int pin = kCodecPinHypothesis[i].pin;
        Serial.printf("[I2CDiag]   GPIO %-2d %-7s level=%d\n",
                      pin, kCodecPinHypothesis[i].role, gpio_get_level((gpio_num_t)pin));
    }
}

#else
#error "No board defined — cannot configure display"
#endif

// ============================================================
// Common LVGL integration
// ============================================================

#if !defined(BOARD_AMOLED) && !defined(BOARD_IPS35) && !defined(BOARD_IPS10)
static LGFX tft;

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
// Rotation index 0-3 in 90° steps: 0 = upright portrait, 1 = landscape,
// 2 = flipped portrait, 3 = flipped landscape.
// C6 panel is mounted 180° from the ST7789 default scan direction → hw offset +2.
static uint8_t g_rotIndex = 0;
#if defined(BOARD_ESP32_C6_147)
static inline uint8_t hwRotation(uint8_t idx) { return (idx + 2) & 3; }
#else
static inline uint8_t hwRotation(uint8_t idx) { return idx & 3; }
#endif
#endif
#if defined(BOARD_TTGO)
// Last brightness applied — re-asserted periodically to self-heal stuck backlight
static int s_lastBrightness = 255;
#endif
#endif
static lv_display_t* disp = nullptr;

// Montserrat 12 + Korean fallback (initialized in displayInit)
lv_font_t font_kr_12;
#if defined(BOARD_IPS10)
// Larger Korean-safe faces for the IPS10 D1 detail overlay (Latin at the larger
// size, Korean glyphs via the 12 px Noto fallback — readable, never tofu).
lv_font_t font_kr_16;
lv_font_t font_kr_20;
#elif defined(BOARD_T_DISPLAY_PRO) || defined(BOARD_T_EMBED)
lv_font_t font_kr_16;
#endif

static size_t rgb565StrideBytes(uint32_t width) {
    return ((width * sizeof(uint16_t)) + 31u) & ~31u;
}

// LVGL flush callback
static void disp_flush(lv_display_t* display, const lv_area_t* area, uint8_t* px_map) {
    uint32_t w = (area->x2 - area->x1 + 1);
    uint32_t h = (area->y2 - area->y1 + 1);

    // Retrieve the actual active draw buffer's stride directly from LVGL
    lv_draw_buf_t* draw_buf = lv_display_get_buf_active(display);
    uint32_t stride_pixels = w;
    if (draw_buf) {
        stride_pixels = draw_buf->header.stride / sizeof(uint16_t);
    }


#if defined(BOARD_IPS35)
    // AXS15231B via Canvas: draw partial area to buffer, flush only on last area (handle stride alignment)
    if (stride_pixels == w) {
        gfx->draw16bitBeRGBBitmap(area->x1, area->y1, (uint16_t*)px_map, w, h);
    } else {
        uint16_t* src = (uint16_t*)px_map;
        for (uint32_t y = 0; y < h; y++) {
            gfx->draw16bitBeRGBBitmap(area->x1, area->y1 + y, &src[y * stride_pixels], w, 1);
        }
    }
    if (lv_display_flush_is_last(display)) {
        gfx_canvas->flush();
    }
#elif defined(BOARD_AMOLED)
    // ST77916 QSPI: direct draw (no Canvas needed)
    if (stride_pixels == w) {
        gfx->draw16bitBeRGBBitmap(area->x1, area->y1, (uint16_t*)px_map, w, h);
    } else {
        // Draw line by line to handle stride padding correctly
        uint16_t* src = (uint16_t*)px_map;
        for (uint32_t y = 0; y < h; y++) {
            gfx->draw16bitBeRGBBitmap(area->x1, area->y1 + y, &src[y * stride_pixels], w, 1);
        }
    }
#elif defined(BOARD_IPS10)
    // JD9365 MIPI-DSI. We manually transpose the 1280x800 logical landscape map
    // into the physical 800x1280 portrait panel (rotation 270).
#if defined(IPS10_PERF_HUD)
    uint32_t _fs = micros();
#endif
    if (rotated_buf && ppaClient) {
        // HARDWARE rotation: PPA does the 90° CCW transpose of the w×h flush block into
        // rotated_buf via 2D-DMA — no per-pixel CPU work. Mapping verified equal to the CPU
        // transpose: dst(i,j)=src(j,w-1-i), which is exactly a 90° CCW rotation. Pixels are
        // moved intact (RGB565→RGB565, no swap) so the byte-swapped LVGL data is preserved.
        ppa_srm_oper_config_t op = {};
        op.in.buffer = px_map;
        op.in.pic_w = stride_pixels;
        op.in.pic_h = h;
        op.in.block_w = w;
        op.in.block_h = h;
        op.in.srm_cm = PPA_SRM_COLOR_MODE_RGB565;
        op.out.buffer = rotated_buf;
        op.out.buffer_size = rotBufSizeG;
        op.out.pic_w = h;        // rotated width  = source height
        op.out.pic_h = w;        // rotated height = source width
        op.out.srm_cm = PPA_SRM_COLOR_MODE_RGB565;
        op.rotation_angle = PPA_SRM_ROTATION_ANGLE_90;   // 90° CCW
        op.scale_x = 1.0f; op.scale_y = 1.0f;
        op.mode = PPA_TRANS_MODE_BLOCKING;
        if (ppa_do_scale_rotate_mirror(ppaClient, &op) == ESP_OK) {
            uint32_t x_native = area->y1;
            uint32_t y_native = BOARD_NATIVE_H - area->x2 - 1;
            jc_tft->draw16bitbergbbitmap(x_native, y_native, h, w, rotated_buf);
        }
    } else if (rotated_buf) {
        uint16_t* src = (uint16_t*)px_map;
        // CPU tiled transpose fallback (when PPA is unavailable).
        const uint32_t T = 32;
        for (uint32_t rb = 0; rb < h; rb += T) {
            uint32_t rEnd = rb + T < h ? rb + T : h;
            for (uint32_t cb = 0; cb < w; cb += T) {
                uint32_t cEnd = cb + T < w ? cb + T : w;
                for (uint32_t r = rb; r < rEnd; r++) {
                    const uint16_t* srow = src + r * stride_pixels;
                    for (uint32_t c = cb; c < cEnd; c++) rotated_buf[(w - 1 - c) * h + r] = srow[c];
                }
            }
        }
        uint32_t x_native = area->y1;
        uint32_t y_native = BOARD_NATIVE_H - area->x2 - 1;
        jc_tft->draw16bitbergbbitmap(x_native, y_native, h, w, rotated_buf);
    } else {
        if (stride_pixels == w) {
            jc_tft->draw16bitbergbbitmap(area->x1, area->y1, w, h, (uint16_t*)px_map);
        } else {
            uint16_t* src = (uint16_t*)px_map;
            for (uint32_t y = 0; y < h; y++) {
                jc_tft->draw16bitbergbbitmap(area->x1, area->y1 + y, w, 1, &src[y * stride_pixels]);
            }
        }
    }
#if defined(IPS10_PERF_HUD)
    g_flushInnerUs += (micros() - _fs);
#endif
#else
    tft.startWrite();
    if (stride_pixels == w) {
        // swap565_t tells LovyanGFX data is already byte-swapped (big-endian RGB565
        // from LVGL RGB565_SWAPPED). Without this cast, writePixels interprets data
        // as native little-endian and double-swaps, causing color corruption.
        tft.pushImage(area->x1, area->y1, w, h, (lgfx::swap565_t*)px_map);
    } else {
        // Draw line by line to handle stride padding correctly
        uint16_t* src = (uint16_t*)px_map;
        for (uint32_t y = 0; y < h; y++) {
            tft.pushImage(area->x1, area->y1 + y, w, 1, (lgfx::swap565_t*)&src[y * stride_pixels]);
        }
    }
    tft.endWrite();
#endif

    lv_display_flush_ready(display);
}

// LVGL touch read callback
static void touch_read(lv_indev_t* indev, lv_indev_data_t* data) {
    uint16_t x, y;
#if defined(BOARD_T_DISPLAY_PRO)
    // Pocket (portrait) mode drives LVGL widgets directly — raw CST226SE
    // points are rotation-0 display coords. Landscape keeps the ticker's own
    // gesture layer as the sole consumer (two pollers fight over press state),
    // so this indev stays silent there.
    int16_t px = 0, py = 0;
    bool pocketDown = Input::touchPortrait() && Input::touchRawPoint(&px, &py);
    x = (uint16_t)px;
    y = (uint16_t)py;
    if (pocketDown) {
#elif defined(BOARD_AMOLED)
    if (touch_read_cst816s(&x, &y)) {
#elif defined(BOARD_IPS35)
    if (touch_read_axs15231b(&x, &y)) {
#elif defined(BOARD_IPS10)
    if (touch_read_gsl3680(&x, &y)) {
        // Map physical coordinate (x_phys, y_phys) to logical (x_log, y_log)
        // for 270-degree landscape: x_log = BOARD_NATIVE_H - 1 - y_phys, y_log = x_phys
        uint16_t temp_x = x;
        uint16_t temp_y = y;
        x = BOARD_NATIVE_H - 1 - temp_y;
        y = temp_x;
#else
    if (tft.getTouch(&x, &y)) {
#endif
        data->point.x = x;
        data->point.y = y;
        data->state = LV_INDEV_STATE_PRESSED;
    } else {
        data->state = LV_INDEV_STATE_RELEASED;
    }
}

#if defined(BOARD_T_DISPLAY_PRO)
// Portrait request latch — must be set before displayInit() (the camera
// probe that decides the unit's role runs first in the UI task).
static bool s_stripPortrait = false;
#endif

namespace UI {

#if defined(BOARD_T_DISPLAY_PRO)
void requestPortrait() { s_stripPortrait = true; }
#endif

#if defined(BOARD_IPS10)
bool hwI2cReadReg8(uint8_t addr, uint8_t reg, uint8_t* out) {
    if (!i2c_handle || !out) return false;
    return i2cReadReg(i2c_handle, addr, reg, out);
}

bool hwI2cWriteReg8(uint8_t addr, uint8_t reg, uint8_t val) {
    if (!i2c_handle) return false;
    i2c_device_config_t dc;
    memset(&dc, 0, sizeof(dc));
    dc.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    dc.device_address  = addr;
    dc.scl_speed_hz    = 100000;
    i2c_master_dev_handle_t dev = nullptr;
    if (i2c_master_bus_add_device(i2c_handle, &dc, &dev) != ESP_OK) return false;
    const uint8_t payload[2] = { reg, val };
    esp_err_t err = i2c_master_transmit(dev, payload, sizeof(payload), 50);
    i2c_master_bus_rm_device(dev);
    return err == ESP_OK;
}

void hwI2cDumpDevice(uint8_t addr) {
    if (!i2c_handle) { Serial.println("[I2CDiag] touch I2C bus not initialised"); return; }
    Serial.printf("[I2CDiag] --- register dump 0x%02X (read-only) ---\n", addr);
    for (uint8_t reg = 0x00; reg <= 0x4A; reg++) {
        uint8_t v = 0;
        if (reg % 8 == 0) Serial.printf("[I2CDiag]   %02X:", reg);
        if (i2cReadReg(i2c_handle, addr, reg, &v)) Serial.printf(" %02X", v);
        else                                       Serial.print(" --");
        if (reg % 8 == 7) Serial.println();
    }
    Serial.println();
    uint8_t id1 = 0, id2 = 0, ver = 0;
    i2cReadReg(i2c_handle, addr, 0xFD, &id1);
    i2cReadReg(i2c_handle, addr, 0xFE, &id2);
    i2cReadReg(i2c_handle, addr, 0xFF, &ver);
    Serial.printf("[I2CDiag]   FD=%02X FE=%02X FF=%02X\n", id1, id2, ver);
}

void hwI2cProbe(int sdaOverride, int sclOverride) {
    // The boot probe runs on the uiTask while an i2c_diag command arrives on the
    // networkTask. The IDF bus mutex keeps the transfers correct, but the two
    // Serial streams interleave and shred the transcript — which is the whole
    // artifact this probe exists to produce. One at a time.
    static volatile bool busy = false;
    if (busy) {
        Serial.println("[I2CDiag] probe already running — ignoring this request");
        return;
    }
    busy = true;

    Serial.println("[I2CDiag] ===== ips10 audio-codec probe =====");

    if (!i2c_handle) {
        Serial.println("[I2CDiag] touch I2C bus not initialised — nothing to sweep");
    } else {
        i2cSweepBus(i2c_handle, "I2C_NUM_1 (touch bus, SDA 7 / SCL 8)", true);
        i2cCodecAddrStability(i2c_handle);
        for (uint8_t addr = 0x18; addr <= 0x19; addr++) {
            if (i2c_master_probe(i2c_handle, addr, 50) != ESP_OK) continue;
            if (es8311Identify(i2c_handle, addr)) hwI2cDumpDevice(addr);
        }
    }

    i2cPinCensus();

    // Stage 2 — a second bus, only when the operator names the pins. Never an
    // automatic pin sweep.
    if (sdaOverride >= 0 && sclOverride >= 0) {
        if (i2cIsHostedSdioPin(sdaOverride) || i2cIsHostedSdioPin(sclOverride)) {
            Serial.printf("[I2CDiag] REFUSED: GPIO %d/%d overlaps the P4<->C6 ESP-Hosted SDIO link "
                          "(14,15,16,17,18,19,54) — probing it would drop Wi-Fi\n",
                          sdaOverride, sclOverride);
        } else {
            Serial.printf("[I2CDiag] --- stage 2: throwaway bus on I2C_NUM_0, SDA %d / SCL %d ---\n",
                          sdaOverride, sclOverride);
            i2c_master_bus_config_t bc;
            memset(&bc, 0, sizeof(bc));
            bc.clk_source = I2C_CLK_SRC_DEFAULT;
            bc.i2c_port   = I2C_NUM_0;
            bc.sda_io_num = (gpio_num_t)sdaOverride;
            bc.scl_io_num = (gpio_num_t)sclOverride;
            bc.flags.enable_internal_pullup = 1;
            i2c_master_bus_handle_t alt = nullptr;
            if (i2c_new_master_bus(&bc, &alt) != ESP_OK) {
                Serial.println("[I2CDiag]   bus init FAILED on those pins");
            } else {
                i2cSweepBus(alt, "I2C_NUM_0 (candidate)", false);
                for (uint8_t addr = 0x18; addr <= 0x19; addr++) {
                    if (i2c_master_probe(alt, addr, 50) == ESP_OK) es8311Identify(alt, addr);
                }
                i2c_del_master_bus(alt);
                Serial.println("[I2CDiag]   candidate bus released");
            }
        }
    } else {
        Serial.println("[I2CDiag] stage 2 not run — send {\"type\":\"i2c_diag\",\"sda\":N,\"scl\":N} "
                       "to probe a second bus");
    }

    Serial.println("[I2CDiag] ===== probe complete =====");
    busy = false;
}
#endif  // BOARD_IPS10

void displayInit() {
#if defined(BOARD_AMOLED)
    // === ST77916 QSPI AMOLED init via Arduino_GFX ===

    // Wait for USB CDC Serial to enumerate (native JTAG USB)
    delay(2000);
    Serial.println("[Display] === Round AMOLED ST77916 via Arduino_GFX ===");

    // AMOLED power enable
    pinMode(BOARD_PIN_BL, OUTPUT);
    digitalWrite(BOARD_PIN_BL, HIGH);
    delay(200);

    // Create Arduino_GFX QSPI bus and ST77916 display
    gfx_bus = new Arduino_ESP32QSPI(
        BOARD_PIN_QSPI_CS, BOARD_PIN_QSPI_CLK,
        BOARD_PIN_QSPI_D0, BOARD_PIN_QSPI_D1,
        BOARD_PIN_QSPI_D2, BOARD_PIN_QSPI_D3);
    gfx = new Arduino_ST77916(
        gfx_bus, BOARD_PIN_RST, 0 /* rotation */, true /* IPS */,
        360, 360, 0, 0, 0, 0,
        st77916_jc3636w518_init, sizeof(st77916_jc3636w518_init));

    if (!gfx_bus || !gfx) {
        Serial.println("[Display] OOM allocating ST77916 driver — aborting init");
        return;
    }

    if (!gfx->begin(40000000)) {  // 40MHz QSPI clock
        Serial.println("[Display] gfx->begin() FAILED!");
    } else {
        Serial.println("[Display] gfx->begin() OK");
    }
    gfx->fillScreen(RGB565_BLACK);

    // Init touch I2C
    pinMode(BOARD_PIN_TOUCH_RST, OUTPUT);
    digitalWrite(BOARD_PIN_TOUCH_RST, LOW);
    delay(10);
    digitalWrite(BOARD_PIN_TOUCH_RST, HIGH);
    delay(50);
    Wire.begin(BOARD_PIN_TOUCH_SDA, BOARD_PIN_TOUCH_SCL);
    Serial.println("[Display] Touch CST816S initialized");

#elif defined(BOARD_IPS35)
    // === AXS15231B QSPI IPS init via Arduino_GFX ===

    // Wait for USB CDC Serial to enumerate (native JTAG USB)
    delay(2000);
    Serial.println("[Display] === IPS 3.5\" AXS15231B via Arduino_GFX ===");

    // Backlight ON (PWM capable but start with full brightness)
    pinMode(BOARD_PIN_BL, OUTPUT);
    digitalWrite(BOARD_PIN_BL, HIGH);
    delay(100);

    // Create QSPI bus → AXS15231B display → Canvas wrapper
    gfx_bus = new Arduino_ESP32QSPI(
        BOARD_PIN_QSPI_CS, BOARD_PIN_QSPI_CLK,
        BOARD_PIN_QSPI_D0, BOARD_PIN_QSPI_D1,
        BOARD_PIN_QSPI_D2, BOARD_PIN_QSPI_D3);
    gfx_raw = new Arduino_AXS15231B(gfx_bus, GFX_NOT_DEFINED /* RST */,
        0 /* rotation */, false /* IPS */, 320, 480,
        0, 0, 0, 0,
        axs15231b_320480_type1_init_operations,
        sizeof(axs15231b_320480_type1_init_operations));
    gfx_canvas = new Arduino_Canvas(320, 480, gfx_raw);
    gfx = gfx_canvas;  // All drawing goes through Canvas

    if (!gfx_bus || !gfx_raw || !gfx_canvas) {
        Serial.println("[Display] OOM allocating AXS15231B driver/canvas — aborting init");
        return;
    }

    if (!gfx->begin()) {  // Default 32MHz QSPI
        Serial.println("[Display] gfx->begin() FAILED!");
    } else {
        Serial.println("[Display] gfx->begin() OK");
    }
    // Read saved orientation from NVS (default: landscape)
    {
        Preferences prefs;
        prefs.begin("agentdeck", true);
        bool landscape = prefs.getBool("landscape", true);
        prefs.end();
        if (landscape) {
            gfx->setRotation(1);
            g_screenW = SCREEN_W;
            g_screenH = SCREEN_H;
        } else {
            gfx->setRotation(0);
            g_screenW = SCREEN_H;
            g_screenH = SCREEN_W;
        }
    }
    gfx->fillScreen(RGB565_BLACK);
    gfx_canvas->flush();
    Serial.println("[Display] Canvas initialized and flushed");

    // Touch I2C init (AXS15231B integrated touch)
    pinMode(BOARD_PIN_TOUCH_INT, INPUT_PULLUP);
    pinMode(BOARD_PIN_TOUCH_RST, OUTPUT);
    digitalWrite(BOARD_PIN_TOUCH_RST, LOW);
    delay(10);
    digitalWrite(BOARD_PIN_TOUCH_RST, HIGH);
    delay(50);
    Wire.begin(BOARD_PIN_TOUCH_SDA, BOARD_PIN_TOUCH_SCL, 400000);
    Serial.println("[Display] Touch AXS15231B initialized");

#elif defined(BOARD_IPS10)
    // Wait for USB CDC Serial to enumerate (native JTAG USB)
    delay(2000);
    Serial.println("[Display] === IPS 10.1\" JD9365 MIPI-DSI via esp_lcd ===");

    // Initialize display
    jc_tft = new jd9365_lcd(BOARD_PIN_RST);
    if (!jc_tft) {
        Serial.println("[Display] OOM allocating JD9365 driver — aborting init");
        return;
    }
    jc_tft->begin();

    // Allocate software transposition buffer.
    // Max width of logical area is 1280 (BOARD_NATIVE_H).
    // Max height of logical area is 40.
    // Size = 1280 * 40 * sizeof(uint16_t) = 102400 bytes.
    {
        size_t rotBufSize = BOARD_NATIVE_H * 40 * sizeof(uint16_t);
        rotBufSizeG = rotBufSize;
        // 64-byte (L1 cache line) aligned — required when the PPA writes into this buffer.
        rotated_buf = (uint16_t*)heap_caps_aligned_alloc(64, rotBufSize, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
        if (!rotated_buf) {
            rotated_buf = (uint16_t*)heap_caps_aligned_alloc(64, rotBufSize, MALLOC_CAP_SPIRAM);
        }
        if (!rotated_buf) {
            Serial.println("[Display] Failed to allocate rotated_buf!");
        } else {
            Serial.println("[Display] Allocated rotated_buf successfully");
        }
    }

    // Register a PPA SRM client to do the 90° flush rotation in hardware (2D-DMA) instead of a
    // per-pixel CPU transpose. This frees the CPU during every flush → the main loop stays
    // responsive (snappy touch) and rich animation can run at full framerate. If registration
    // fails, ppaClient stays null and disp_flush() falls back to the CPU transpose.
    {
        ppa_client_config_t pc = {};
        pc.oper_type = PPA_OPERATION_SRM;
        pc.max_pending_trans_num = 1;
        pc.data_burst_length = PPA_DATA_BURST_LENGTH_128;
        if (ppa_register_client(&pc, &ppaClient) != ESP_OK) {
            ppaClient = nullptr;
            Serial.println("[Display] PPA register failed — using CPU transpose");
        } else {
            Serial.println("[Display] PPA SRM client ready (HW flush rotation)");
        }
    }


    // Init touch I2C
    i2c_master_bus_config_t i2c_bus_conf;
    memset(&i2c_bus_conf, 0, sizeof(i2c_bus_conf));
    i2c_bus_conf.clk_source = I2C_CLK_SRC_DEFAULT;
    i2c_bus_conf.i2c_port = I2C_NUM_1;
    i2c_bus_conf.sda_io_num = (gpio_num_t)BOARD_PIN_TOUCH_SDA;
    i2c_bus_conf.scl_io_num = (gpio_num_t)BOARD_PIN_TOUCH_SCL;
    i2c_bus_conf.flags.enable_internal_pullup = 1;
    if (i2c_new_master_bus(&i2c_bus_conf, &i2c_handle) == ESP_OK) {
        esp_lcd_panel_io_handle_t tp_io_handle = NULL;
        esp_lcd_panel_io_i2c_config_t tp_io_config = ESP_LCD_TOUCH_IO_I2C_GSL3680_CONFIG();
        tp_io_config.scl_speed_hz = 100000;   // 100 kHz — 400 kHz risked I2C noise → phantom touches
        if (esp_lcd_new_panel_io_i2c(i2c_handle, &tp_io_config, &tp_io_handle) == ESP_OK) {
            esp_lcd_touch_config_t tp_cfg;
            memset(&tp_cfg, 0, sizeof(tp_cfg));
            tp_cfg.x_max = BOARD_NATIVE_W;
            tp_cfg.y_max = BOARD_NATIVE_H;
            tp_cfg.rst_gpio_num = (gpio_num_t)BOARD_PIN_TOUCH_RST;
            tp_cfg.int_gpio_num = (gpio_num_t)BOARD_PIN_TOUCH_INT;
            tp_cfg.levels.reset = 0;
            tp_cfg.levels.interrupt = 0;
            tp_cfg.flags.swap_xy = 0;
            tp_cfg.flags.mirror_x = 0;
            tp_cfg.flags.mirror_y = 1;
            esp_lcd_touch_new_i2c_gsl3680(tp_io_handle, &tp_cfg, &tp_handle);
            Serial.println("[Display] Touch GSL3680 initialized");
        } else {
            Serial.println("[Display] Touch IO init FAILED!");
        }
    } else {
        Serial.println("[Display] I2C bus init FAILED!");
    }

    // Audio-codec probe. Runs here, on the uiTask before touch polling starts,
    // so it never contends with touch_read_gsl3680() on the same bus. Costs a
    // few hundred ms of boot (112 addresses, each yielding a tick to keep the
    // bus free). Serial is the only channel that can carry the result:
    // attaching USB parks the Wi-Fi STA (net/wifi_manager.cpp), so there is no
    // socket open at this point in boot.
    hwI2cProbe();

    // Claim the speaker's I2S DMA here, before the LVGL draw buffer takes 60 KB
    // of internal RAM just below. Late allocation loses that race once WiFi is
    // also up — see speaker_playback.cpp.
    Audio::playbackInit();

    g_screenW = BOARD_NATIVE_H;
    g_screenH = BOARD_NATIVE_W;

#else
    // LovyanGFX path (BOX_86, TTGO T-Display, etc.)
    Serial.println("[Display] Calling tft.init()...");
    tft.init();
    Serial.println("[Display] tft.init() complete");

#if defined(BOARD_T_DISPLAY_PRO)
    // Pulse-dimmed backlight (no Light_PWM): raise EN → driver powers on at
    // full; setBrightness() steps levels from there.
    pinMode(BOARD_PIN_BL, OUTPUT);
    digitalWrite(BOARD_PIN_BL, HIGH);
#endif

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    // ST7789 SPI: Test panel rendering directly to check hardware/SPI alignment
    Serial.println("[Display] ===== TTGO PANEL TEST START =====");
    tft.setRotation(0); // Test portrait
    tft.fillScreen(0xF800); // Red
    delay(1000);
    tft.fillScreen(0x07E0); // Green
    delay(1000);
    tft.fillScreen(0x001F); // Blue
    delay(1000);
    tft.fillScreen(0x0000); // Black
    Serial.println("[Display] ===== TTGO PANEL TEST END =====");
#endif

#if defined(BOARD_BOX_86) || defined(BOARD_86_BOX)
    // 86box: Test panel rendering with colored screens to diagnose black screen issue
    Serial.println("[Display] ===== PANEL TEST START =====");
    Serial.printf("[Display] Screen size: %dx%d\n", tft.width(), tft.height());
    Serial.printf("[Display] Color format: %s\n",
                  tft.getColorDepth() == 16 ? "RGB565" : "Other");

    // Red screen test
    Serial.println("[Display] Filling RED...");
    tft.fillScreen(0xF800);  // RGB565 red
    delay(1000);

    // Green screen test
    Serial.println("[Display] Filling GREEN...");
    tft.fillScreen(0x07E0);  // RGB565 green
    delay(1000);

    // Blue screen test
    Serial.println("[Display] Filling BLUE...");
    tft.fillScreen(0x001F);  // RGB565 blue
    delay(1000);

    // White screen test
    Serial.println("[Display] Filling WHITE...");
    tft.fillScreen(0xFFFF);  // RGB565 white
    delay(1000);

    // Clear to black
    Serial.println("[Display] Clearing to BLACK...");
    tft.fillScreen(0x0000);
    Serial.println("[Display] ===== PANEL TEST END =====");
#endif
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    // Read saved rotation index from NVS (0-3, 90° steps).
    // Defaults: TTGO upright portrait (0), C6 landscape (1).
    {
        Preferences prefs;
        prefs.begin("agentdeck", true);
#if defined(BOARD_ESP32_C6_147)
        uint8_t defRot = 1;
#else
        // Legacy migration: older firmware stored a bool "landscape"
        uint8_t defRot = prefs.getBool("landscape", false) ? 1 : 0;
#endif
        uint8_t rot = prefs.getUChar("rot", defRot) & 3;
        prefs.end();
        g_rotIndex = rot;
        bool landscape = rot & 1;
        g_screenW = landscape ? SCREEN_H : SCREEN_W;
        g_screenH = landscape ? SCREEN_W : SCREEN_H;
        tft.setRotation(hwRotation(rot));
        Serial.printf("[Display] Rotation index %d (%dx%d)\n", rot, g_screenW, g_screenH);
    }
#elif defined(BOARD_T_DISPLAY_PRO)
    // Pocket mode (camera unit): the whole hardware stack is portrait-native
    // — panel GRAM, touch report, camera mounting — so the phone-style UI
    // runs rotation 0 at 222x480. The no-camera unit keeps the landscape
    // Focus Strip. Chosen before displayInit via UI::requestPortrait().
    if (s_stripPortrait) {
        tft.setRotation(0);
        g_screenW = BOARD_NATIVE_W;   // 222
        g_screenH = BOARD_NATIVE_H;   // 480
        Serial.println("[Display] Strip portrait (Pocket) orientation");
    } else {
        tft.setRotation(BOARD_ROTATION);
    }
#else
    tft.setRotation(BOARD_ROTATION);
#endif
    tft.setBrightness(255);
#endif

    lv_init();

    // Korean font fallback: create a RAM copy of montserrat_12 with fallback pointer set.
    // Can't modify the built-in font directly (it's in flash .rodata).
    // Instead, each UI file that needs Korean should use &font_kr_12 from display.h.
    font_kr_12 = lv_font_montserrat_12;  // Copy struct to RAM
    font_kr_12.fallback = &font_noto_kr_12;  // Set Korean fallback
#if defined(BOARD_IPS10)
    // 16/20px faces fall back to the 16px Noto KR face (IPS10 carries it —
    // ~1.5MB flash) so Korean card/summary text is legible on the 10" panel
    // instead of dropping to the 12px face beside 16–20px Latin.
    font_kr_16 = lv_font_montserrat_16; font_kr_16.fallback = &font_noto_kr_16;
    font_kr_20 = lv_font_montserrat_20; font_kr_20.fallback = &font_noto_kr_16;
#elif defined(BOARD_T_DISPLAY_PRO) || defined(BOARD_T_EMBED)
    // Companion surfaces are read from farther away than the older small HUDs;
    // keep Korean primary text at the same 16px tier as Latin.
    font_kr_16 = lv_font_montserrat_16; font_kr_16.fallback = &font_noto_kr_16;
#endif

#if defined(BOARD_IPS10)
    // Create logical landscape display directly (1280x800) and perform software transposition in disp_flush
    disp = lv_display_create(BOARD_NATIVE_H, BOARD_NATIVE_W);
    lv_display_set_flush_cb(disp, disp_flush);
#else
    disp = lv_display_create(g_screenW, g_screenH);
    lv_display_set_flush_cb(disp, disp_flush);
#endif

    // SPI/QSPI panels: partial render with DMA-capable buffers, big-endian RGB565.
    // TTGO has no PSRAM and very tight DMA-capable heap, so keep its LVGL
    // draw buffers smaller than the larger SPI/QSPI panels.
#if defined(BOARD_TTGO)
    static constexpr size_t BUF_LINES = 20;
#elif defined(BOARD_IPS10)
    // IPS10 draw buffers live in INTERNAL SRAM (fast per-pixel render). Keep them small so the
    // two buffers (1280×N×2) + rotated_buf (102KB internal) + runtime all fit without OOM —
    // 40 lines (204KB) crashed; 24 lines ≈ 122KB fits internal and keeps the flush-slice count
    // (and per-slice widget-tree traversal) lower than 16 lines did. PPA rotates each slice cheaply.
    static constexpr size_t BUF_LINES = 24;
#else
    static constexpr size_t BUF_LINES = 40;
#endif
#if defined(BOARD_IPS10)
    size_t logicalWidth = BOARD_NATIVE_H;
#else
    size_t logicalWidth = g_screenW;
#endif
    size_t strideBytes = rgb565StrideBytes(logicalWidth);
    size_t bufPixels = logicalWidth * BUF_LINES;
    size_t bufSize = strideBytes * BUF_LINES;
    Serial.printf("[Display] Buffer alloc: %zu logical pixels, %zu bytes (%d lines, stride=%zu)\n",
                  bufPixels, bufSize, BUF_LINES, strideBytes);
    // DMA-capable aligned buffers (Arduino_GFX pattern).
    // IPS10: force INTERNAL SRAM. On the P4, MALLOC_CAP_DMA alone is satisfied by PSRAM, and a
    // PSRAM LVGL draw buffer makes every per-pixel widget render a slow PSRAM write (~30× internal)
    // — that was the cards-render bottleneck (f-bucket 180–360ms). Internal keeps render fast;
    // PPA still rotates it in HW (~13ms). Falls back to PSRAM only if internal can't satisfy.
    uint32_t bufCaps = MALLOC_CAP_DMA;
#if defined(BOARD_IPS10)
    bufCaps |= MALLOC_CAP_INTERNAL;
#endif
    uint16_t* buf1 = (uint16_t*)heap_caps_aligned_alloc(16, bufSize, bufCaps);
    uint16_t* buf2 = (uint16_t*)heap_caps_aligned_alloc(16, bufSize, bufCaps);
    if (!buf1 || !buf2) {
        // Fallback to PSRAM
        if (buf1) free(buf1);
        if (buf2) free(buf2);
        buf1 = (uint16_t*)ps_malloc(bufSize);
        buf2 = (uint16_t*)ps_malloc(bufSize);
        Serial.println("[Display] DMA alloc failed, using PSRAM");
    }
    if (!buf1 || !buf2) {
        Serial.println("[Display] Buffer alloc failed!");
        return;
    }
#if defined(IPS10_PERF_HUD)
    g_bufInternal = esp_ptr_internal(buf1) ? 1 : 0;
#endif
    lv_display_set_buffers(disp, buf1, buf2, bufSize,
                           LV_DISPLAY_RENDER_MODE_PARTIAL);
#if defined(BOARD_IPS10)
    lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565);
    Serial.printf("[Display] LVGL initialized %dx%d (RGB565 native)\n", g_screenW, g_screenH);
#else
    lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565_SWAPPED);
    Serial.printf("[Display] LVGL initialized %dx%d (RGB565 swapped)\n", g_screenW, g_screenH);
#endif

    lv_indev_t* indev = lv_indev_create();
    lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(indev, touch_read);
#if defined(BOARD_IPS10)
    // The GSL3680 reports jittery coordinates (it also logs intermittent i2c tx failures),
    // so a finger that physically stays put still wanders several px between press and
    // release. With LVGL's default ~10px scroll limit that wander is read as a drag → the
    // tap is consumed as a (no-op) scroll and CLICKED/SHORT_CLICKED never fires, so cards
    // and the modal-close scrim "don't react" even though the touch point tracks fine.
    // Widen the limit so small jitter is still treated as a click. 8012px-wide panel → 40px
    // is well within a single card/target.
    lv_indev_set_scroll_limit(indev, 40);
    // Poll the GSL3680 every ~24 ms (between LVGL's 33 ms default and the 12 ms that over-sampled
    // touch-down transients into phantom presses). Rendering is now cheap (internal-SRAM buffers +
    // PPA), so the loop stays responsive without aggressive polling.
    lv_timer_t* readTimer = lv_indev_get_read_timer(indev);
    if (readTimer) lv_timer_set_period(readTimer, 24);
#endif
}

lv_display_t* getDisplay() {
    return disp;
}

#if defined(BOARD_T_DISPLAY_PRO)
// V1.1 backlight: AW9364-style stepped constant-current driver. Each fast
// LOW→HIGH pulse on GPIO 48 steps one of 16 levels DOWN (wrapping); 0 = hold
// LOW ≥3ms to power off. Verbatim port of the vendor AdjustBacklight.ino
// algorithm (the vendor platformio.ini comment transposes V1.0/V1.1 — the
// #ifdef branches are authoritative; on-hand units are V1.1).
static void tdisplayProSetBacklightLevel(uint8_t value) {
    static uint8_t s_level = 0;
    constexpr uint8_t STEPS = 16;
    if (value > STEPS) value = STEPS;
    if (value == 0) {
        digitalWrite(BOARD_PIN_BL, LOW);
        delay(3);
        s_level = 0;
        return;
    }
    if (s_level == 0) {
        digitalWrite(BOARD_PIN_BL, HIGH);
        s_level = STEPS;
        delayMicroseconds(30);
    }
    int from = STEPS - s_level;
    int to = STEPS - value;
    int num = (STEPS + to - from) % STEPS;
    for (int i = 0; i < num; i++) {
        digitalWrite(BOARD_PIN_BL, LOW);
        digitalWrite(BOARD_PIN_BL, HIGH);
    }
    s_level = value;
}
#endif

void setBrightness(int level) {
    if (level < 0) level = 0;
    if (level > 255) level = 255;
#if defined(BOARD_T_DISPLAY_PRO)
    tdisplayProSetBacklightLevel(level == 0 ? 0 : (uint8_t)(1 + (level * 15) / 255));
#elif defined(BOARD_AMOLED)
    // AMOLED: simple on/off via BL pin (no PWM)
    digitalWrite(BOARD_PIN_BL, level > 0 ? HIGH : LOW);
#elif defined(BOARD_IPS35)
    // AXS15231B: PWM backlight
    analogWrite(BOARD_PIN_BL, level);
#elif defined(BOARD_IPS10)
    // JD9365 backlight on GPIO23. analogWrite() drives it via LEDC PWM so the host's
    // "min" dim level (e.g. 25/255) actually dims the panel instead of snapping to
    // full-on; level 0 → fully off. (The JD9365 driver only init'd it as a binary
    // GPIO; analogWrite re-attaches the pin to a LEDC channel on first call.)
    analogWrite(BOARD_PIN_BL, level);
#elif defined(BOARD_TTGO)
    // TTGO: LovyanGFX Light_PWM owns GPIO4 (single owner). s_lastBrightness lets
    // reassertPanel() re-apply duty to self-heal a stuck backlight after sleep.
    s_lastBrightness = level;
    Serial.printf("[BL] %d\n", level);
    tft.setBrightness(level);
#else
    tft.setBrightness(level);
#endif
}

void lvglTick() {
    lv_tick_inc(LVGL_TICK_MS);
}

void lvglLoop() {
    lv_timer_handler();
}

bool isLandscape() {
#if defined(BOARD_IPS35) || defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147) || defined(BOARD_IPS10)
    return g_screenW > g_screenH;
#else
    return true;
#endif
}

void setRotationIndex(uint8_t idx) {
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    idx &= 3;
    if (idx == g_rotIndex) return;
    g_rotIndex = idx;

    bool landscape = idx & 1;
    g_screenW = landscape ? SCREEN_H : SCREEN_W;
    g_screenH = landscape ? SCREEN_W : SCREEN_H;
    tft.setRotation(hwRotation(idx));
    lv_display_set_resolution(disp, g_screenW, g_screenH);

    Serial.printf("[Display] Rotation: %d (%dx%d)\n", idx, g_screenW, g_screenH);

    Preferences prefs;
    prefs.begin("agentdeck", false);
    prefs.putUChar("rot", g_rotIndex);
    prefs.end();
#else
    (void)idx;
#endif
}

uint8_t getRotationIndex() {
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    return g_rotIndex;
#else
    return 0;
#endif
}

void setOrientation(bool landscape) {
#if defined(BOARD_IPS35)
    bool currentLandscape = g_screenW > g_screenH;
    if (landscape == currentLandscape) return;

    // IPS35: SCREEN_W is the landscape (wide) dimension
    g_screenW = landscape ? SCREEN_W : SCREEN_H;
    g_screenH = landscape ? SCREEN_H : SCREEN_W;
    gfx->setRotation(landscape ? 1 : 0);
    lv_display_set_resolution(disp, g_screenW, g_screenH);

    Serial.printf("[Display] Orientation: %s (%dx%d)\n",
                  landscape ? "landscape" : "portrait", g_screenW, g_screenH);

    Preferences prefs;
    prefs.begin("agentdeck", false);
    prefs.putBool("landscape", landscape);
    prefs.end();
#elif defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    // Legacy bool API (network set_orientation) → rotation index
    setRotationIndex(landscape ? 1 : 0);
#else
    (void)landscape;
#endif
}

void reassertPanel() {
#if defined(BOARD_TTGO)
    // Self-heal for intermittent black screen: re-issue DISPON (no-op when the
    // panel is already on; recovers a panel glitched into display-off) and
    // re-apply backlight duty (recovers a stale ledc channel). Called from the
    // UI task every ~10s — same task as LVGL flushes, so no SPI contention.
    tft.startWrite();
    tft.writeCommand(0x29);  // DISPON
    tft.endWrite();
    tft.setBrightness(s_lastBrightness);  // re-apply duty (self-heal stuck backlight)
#endif
}

}  // namespace UI
