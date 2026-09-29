#pragma once

// RockBase NM-EPD-420 — ESP32-S3 N16R8 + 4.2" 400x300 tri-color panel.
// Pin map is from the board schematic and the manufacturer's reference
// firmware (RockBase-iot/NM-EPD-420, 66727fcf). The standard, non-BW SKU uses
// the GDEY042Z98 black/white/red panel. Although the SSD1683 driver advertises
// a black-plane differential mode, both full-screen and bounded red-free trials
// produced a dark wash on the on-hand tri-color glass. AgentDeck therefore
// forbids refresh_bw() on this SKU and uses stock full-color updates only.

#define BOARD_NAME "NM-EPD-420 4.2 e-ink"

#define BOARD_PIN_EPD_SCK   2
#define BOARD_PIN_EPD_MOSI  1
#define BOARD_PIN_EPD_CS   46
#define BOARD_PIN_EPD_DC    4
#define BOARD_PIN_EPD_RST   5
#define BOARD_PIN_EPD_BUSY  6

// BOOT is an RTC GPIO and is the deep-sleep wake / primary-next control.
// USER is home outside DECISION and select/confirm while DECISION is visible.
#define BOARD_PIN_KEY1      0
#define BOARD_PIN_KEY2     45
#define BOARD_PIN_WAKE      0

// ---- ES8311 full-duplex codec + external PA -------------------------------
// Pins from the board schematic and the manufacturer's reference firmware. This
// board is the only e-ink surface in the fleet with a codec, and its audio was
// dark until 2026-08-30 for a reason that had nothing to do with the hardware:
// every e-ink env carried `-<audio/*>` in its build_src_filter, keyed on the
// DISPLAY technology while audio is an orthogonal axis. TRMNL 7.5" and EPD47 have
// no codec and keep the exclusion; this board does, so it does not.
//
// UNVERIFIED ON HARDWARE. The I2C address below is the ES8311 default and has
// not been probed on this unit, and no sound has been played through this path.
// Es8311::present() reads the chip-ID registers at playback init and gates the
// `audio_out` capability on the answer, so a wrong address degrades to "this
// board does not advertise a speaker" rather than to a device that claims one
// and is silent. Do not describe this as working until a unit has made a sound.
#define BOARD_PIN_I2C_SDA   39
#define BOARD_PIN_I2C_SCL   38

#define BOARD_HAS_SPEAKER        1
#define BOARD_SPK_CODEC_ES8311   1
#define BOARD_ES8311_I2C_ADDR    0x18   // default; NOT probed on this unit
#define BOARD_PIN_SPK_MCLK       21
#define BOARD_PIN_SPK_BCLK       15
#define BOARD_PIN_SPK_LRCLK      17
#define BOARD_PIN_SPK_DIN        18     // ESP32 data out -> codec DSDIN
#define BOARD_PIN_MIC_DIN        16     // codec ASDOUT -> ESP32
#define BOARD_PIN_SPK_PA_EN      41     // external power-amp enable
#define BOARD_PIN_CODEC_EN       44     // codec rail enable, held high while audio is up
// Unity (0 dB). The shared default of 70 is -18 dB, which measured inaudible on
// this board's Class-D stage; the vendor's own T4 codec test writes 0x32=0xD3
// (+10 dB) here. 100 is the loudest value the shared scale offers without
// boost — if that is still too quiet the scale needs a board dB offset, not a
// larger percent.
#define BOARD_SPK_DEFAULT_VOLUME 100
//
// Capture is deliberately NOT enabled yet, and the reason is UX rather than
// wiring: the codec is full-duplex, so the ADC needs no extra hardware, but
// every voice-capture consumer reports progress through the LVGL `HUD::` bar
// (protocol.cpp's voice_result / audio_play_* handlers), and an e-ink surface
// has no HUD and cannot animate a "listening" state at a useful frame rate.
// Wiring capture without that would mean holding BOOT and getting no feedback
// until the reply lands. docs/eink-surface-contract.md keeps the BOOT hold
// reserved for it; enabling it needs a paper-native capture indicator first.
// #define BOARD_HAS_VOICE_CAPTURE  1

#define BOARD_PIN_BATT_ADC   3
#define BOARD_PIN_BATT_EN   43
