#pragma once

#include <lvgl.h>

/**
 * Montserrat 12 + Korean fallback (Noto Sans KR 12).
 * RAM copy of lv_font_montserrat_12 with fallback pointer set.
 * Use &font_kr_12 instead of &lv_font_montserrat_12 for labels
 * that may display Korean text (session names, timeline, etc.).
 * Initialized in displayInit().
 */
extern lv_font_t font_kr_12;
#if defined(BOARD_IPS10)
/** Larger Korean-safe faces (Latin at size, Korean via 12 px Noto fallback) for the IPS10 D1 detail overlay. */
extern lv_font_t font_kr_16;
extern lv_font_t font_kr_20;
#elif defined(BOARD_T_DISPLAY_PRO) || defined(BOARD_T_EMBED)
/** 16px Korean-safe face for the compact companion UIs (~1.5MB flash). */
extern lv_font_t font_kr_16;
#endif

namespace UI {

/**
 * Initialize display driver (LovyanGFX), LVGL, touch input.
 * Must be called from LVGL core (Core 1).
 */
void displayInit();

#if defined(BOARD_T_DISPLAY_PRO)
/** Choose the portrait (Pocket) orientation — call before displayInit(). */
void requestPortrait();
#endif

#if defined(BOARD_IPS10)
/**
 * Audio-codec hardware probe — hunts the ES8311 the vendor sheet claims.
 *
 * Read-only by construction: I2C address probes and register reads only, and
 * pin levels are sampled with gpio_get_level() so no pad is ever reconfigured.
 * Results go to Serial (this board parks its Wi-Fi STA whenever USB serial is
 * active, so a response frame would have no socket to leave by).
 *
 * With no arguments it sweeps the already-open touch bus (I2C_NUM_1, SDA 7 /
 * SCL 8). Pass a pin pair to additionally open a throwaway bus on I2C_NUM_0
 * and look for the codec there; that path is opt-in precisely because blind
 * pin sweeping is the one genuinely risky thing this probe could do.
 */
void hwI2cProbe(int sdaOverride = -1, int sclOverride = -1);

/** Dump registers 0x00–0x4A plus the ID/version trio of a confirmed device. */
void hwI2cDumpDevice(uint8_t addr);

/**
 * Single-register access on the panel's I2C bus, for peripherals that share it
 * with touch (the ES8311 codec at 0x18). Routed through here rather than
 * handing out the bus handle so `driver/i2c_master.h` stays out of every
 * consumer of this header — and so there is exactly one bus on those pads.
 */
bool hwI2cReadReg8(uint8_t addr, uint8_t reg, uint8_t* out);
bool hwI2cWriteReg8(uint8_t addr, uint8_t reg, uint8_t val);
#endif

/**
 * Get the main LVGL display pointer.
 */
lv_display_t* getDisplay();

/**
 * Set display backlight brightness (0-255).
 */
void setBrightness(int level);

/**
 * LVGL tick handler — call from timer ISR or task.
 */
void lvglTick();

/**
 * LVGL task handler — call from LVGL core loop.
 */
void lvglLoop();

/**
 * Switch display orientation at runtime (IPS 3.5" only).
 * Landscape = 480×320, Portrait = 320×480.
 * Updates g_screenW/g_screenH, hardware rotation, LVGL resolution, NVS.
 * Caller must recreate LVGL screens after calling this.
 */
void setOrientation(bool landscape);

/**
 * 90° rotation steps for small SPI panels (TTGO / C6): index 0-3.
 * 0 = upright portrait, 1 = landscape, 2 = flipped portrait, 3 = flipped landscape.
 * Persists to NVS. Caller must recreate LVGL screens after calling this.
 */
void setRotationIndex(uint8_t idx);
uint8_t getRotationIndex();

/**
 * Periodic panel self-heal (TTGO): re-assert DISPON + backlight duty.
 * No-op on other boards.
 */
void reassertPanel();

/**
 * Returns true if display is in landscape mode.
 */
bool isLandscape();

}  // namespace UI
