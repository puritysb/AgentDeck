#pragma once

#include "../../boards/board_config.h"   // defines BOARD_SPK_CODEC_ES8311

#if defined(BOARD_SPK_CODEC_ES8311)

#include <stdint.h>

/**
 * Minimal ES8311 bring-up for playback.
 *
 * Unlike the T-Embed's bare I2S amplifier — where `i2s.setPins()` is the whole
 * driver — the ES8311 is a codec: it needs an I2C register sequence, a master
 * clock, and a PA-enable line before a single sample means anything. This is
 * the DAC half only; the ADC (mic) side is out of scope until the analog side
 * is proven.
 *
 * Register sequence ported from Espressif's esp-adf / esp_codec_dev `es8311.c`.
 * I2C rides the panel's existing bus through `UI::hwI2cReadReg8/WriteReg8`, so
 * there is still exactly one I2C master on those pads.
 *
 * Fixed operating point, matching the daemon's voice-reply format: 16 kHz,
 * 16-bit, mono, MCLK = 256 x Fs = 4.096 MHz (the multiple ESP_I2S emits by
 * default), which selects the {4096000, 16000} coefficient row.
 */
namespace Es8311 {

/** Probe + full DAC init. Safe to call repeatedly; re-inits each time. */
bool begin(uint32_t sampleRate);

/** True once begin() has confirmed the chip ID and completed the sequence. */
bool ready();

/** Power the amplifier down and park the codec. */
void stop();

/**
 * 0-100, mapped onto -60..0 dB of the codec's DAC volume register.
 *
 * Takes effect immediately AND becomes the level begin() restores on its next
 * run. That matters: begin() executes on the playback task, so a caller that
 * sets a level and then starts playback is racing roughly 40 I2C transactions.
 * Storing the level removes the race instead of timing around it.
 */
void setVolume(int percent);

/** The level begin() will apply, without touching the codec now. */
int volume();

/**
 * Microphone PGA, as the codec's gain step 0..7 (== 0/6/12/18/24/30/36/42 dB).
 * Stored and re-applied by begin() for the same reason as the volume.
 */
void setMicGain(int step);
int micGain();

}  // namespace Es8311

#endif  // BOARD_SPK_CODEC_ES8311
