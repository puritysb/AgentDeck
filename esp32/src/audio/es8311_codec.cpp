#include "../../boards/board_config.h"   // defines BOARD_SPK_CODEC_ES8311

#if defined(BOARD_SPK_CODEC_ES8311)

#include "es8311_codec.h"
#include "../ui/display.h"          // UI::hwI2cReadReg8 / hwI2cWriteReg8

#include <Arduino.h>
#include <driver/gpio.h>

namespace Es8311 {
namespace {

// Register map subset — names follow Espressif's es8311_reg.h so the sequence
// below can be diffed against the upstream driver.
constexpr uint8_t REG00_RESET       = 0x00;
constexpr uint8_t REG01_CLK_MGR     = 0x01;
constexpr uint8_t REG02_CLK_MGR     = 0x02;
constexpr uint8_t REG03_CLK_MGR     = 0x03;
constexpr uint8_t REG04_CLK_MGR     = 0x04;
constexpr uint8_t REG05_CLK_MGR     = 0x05;
constexpr uint8_t REG06_CLK_MGR     = 0x06;
constexpr uint8_t REG07_CLK_MGR     = 0x07;
constexpr uint8_t REG08_CLK_MGR     = 0x08;
constexpr uint8_t REG09_SDPIN       = 0x09;
constexpr uint8_t REG0A_SDPOUT      = 0x0A;
constexpr uint8_t REG0B_SYSTEM      = 0x0B;
constexpr uint8_t REG0C_SYSTEM      = 0x0C;
constexpr uint8_t REG0D_SYSTEM      = 0x0D;
constexpr uint8_t REG0E_SYSTEM      = 0x0E;
constexpr uint8_t REG10_SYSTEM      = 0x10;
constexpr uint8_t REG11_SYSTEM      = 0x11;
constexpr uint8_t REG12_SYSTEM      = 0x12;
constexpr uint8_t REG13_SYSTEM      = 0x13;
constexpr uint8_t REG14_SYSTEM      = 0x14;
constexpr uint8_t REG15_ADC         = 0x15;
constexpr uint8_t REG16_ADC         = 0x16;
constexpr uint8_t REG17_ADC         = 0x17;
constexpr uint8_t REG1B_ADC         = 0x1B;
constexpr uint8_t REG1C_ADC         = 0x1C;
constexpr uint8_t REG31_DAC         = 0x31;
constexpr uint8_t REG32_DAC         = 0x32;
constexpr uint8_t REG37_DAC         = 0x37;
constexpr uint8_t REG44_GPIO        = 0x44;
constexpr uint8_t REG45_GP          = 0x45;
constexpr uint8_t REGFD_CHIP_ID1    = 0xFD;
constexpr uint8_t REGFE_CHIP_ID2    = 0xFE;
constexpr uint8_t REGFF_VERSION     = 0xFF;

constexpr uint8_t ADDR = BOARD_ES8311_I2C_ADDR;

bool s_ready = false;
// Survives begin(): the playback task re-inits the codec, and without a stored
// level that init would silently undo whatever the caller just set.
// -18 dB. Picked by ear on the ips10 amplifier (2026-07-28): 0 dB and above
// were reported painfully loud twice, while -18 dB was still clearly audible
// as the quietest of three verified steps.
int  s_volume = 70;
// REG16 takes a gain *enum*, 0..7 == 0/6/12/18/24/30/36/42 dB (upstream
// es8311_set_mic_gain writes the enum straight into the register). Note the
// open sequence above writes 0x24 into the same register — that is a clock/ramp
// value from upstream's open path, not a gain, and it must be overwritten after
// init or the PGA sits at an out-of-range word. Stored for the same reason as
// s_volume: begin() re-runs per utterance and would revert a late write.
int  s_micGain = 6;   // +36 dB — electret into an ES8311 needs most of the PGA

bool wr(uint8_t reg, uint8_t val) { return UI::hwI2cWriteReg8(ADDR, reg, val); }
bool rd(uint8_t reg, uint8_t* val) { return UI::hwI2cReadReg8(ADDR, reg, val); }

// Clock coefficients. Only the rows this firmware can actually ask for; the
// upstream table has ~90. Fields mirror upstream `coeff_div`.
struct Coeff {
    uint32_t mclk;
    uint32_t rate;
    uint8_t preDiv, preMulti, adcDiv, dacDiv, fsMode, lrckH, lrckL, bclkDiv, adcOsr, dacOsr;
};
constexpr Coeff kCoeff[] = {
    // MCLK = 256 x Fs, which is what ESP_I2S emits by default.
    { 4096000, 16000, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0xff, 0x04, 0x10, 0x20 },
    { 2048000,  8000, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0xff, 0x04, 0x10, 0x20 },
    {12288000, 48000, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0xff, 0x04, 0x10, 0x10 },
};

const Coeff* findCoeff(uint32_t mclk, uint32_t rate) {
    for (const Coeff& c : kCoeff) {
        if (c.mclk == mclk && c.rate == rate) return &c;
    }
    return nullptr;
}

void paEnable(bool on) {
#if BOARD_PIN_SPK_PA_EN >= 0
    gpio_set_level((gpio_num_t)BOARD_PIN_SPK_PA_EN, on ? 1 : 0);
#else
    (void)on;
#endif
}

void paSetup() {
#if BOARD_PIN_SPK_PA_EN >= 0
    gpio_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.pin_bit_mask = 1ULL << BOARD_PIN_SPK_PA_EN;
    cfg.mode = GPIO_MODE_OUTPUT;
    gpio_config(&cfg);
    paEnable(false);
#endif
}

// Sample-rate dependent clock registers (upstream es8311_config_sample_rate).
bool configSampleRate(uint32_t rate) {
    const uint32_t mclk = rate * 256u;
    const Coeff* c = findCoeff(mclk, rate);
    if (!c) {
        Serial.printf("[ES8311] no coefficient row for MCLK %lu / rate %lu\n",
                      (unsigned long)mclk, (unsigned long)rate);
        return false;
    }

    uint8_t v = 0;
    if (!rd(REG02_CLK_MGR, &v)) return false;
    v &= 0x07;
    v |= (uint8_t)((c->preDiv - 1) << 5);
    uint8_t multi = 0;
    switch (c->preMulti) {
        case 1: multi = 0; break;
        case 2: multi = 1; break;
        case 4: multi = 2; break;
        case 8: multi = 3; break;
        default: multi = 0; break;
    }
    v |= (uint8_t)(multi << 3);
    if (!wr(REG02_CLK_MGR, v)) return false;

    v = (uint8_t)(((c->adcDiv - 1) << 4) | (c->dacDiv - 1));
    if (!wr(REG05_CLK_MGR, v)) return false;

    if (!rd(REG03_CLK_MGR, &v)) return false;
    v = (uint8_t)((v & 0x80) | (c->fsMode << 6) | c->adcOsr);
    if (!wr(REG03_CLK_MGR, v)) return false;

    if (!rd(REG04_CLK_MGR, &v)) return false;
    v = (uint8_t)((v & 0x80) | c->dacOsr);
    if (!wr(REG04_CLK_MGR, v)) return false;

    if (!rd(REG07_CLK_MGR, &v)) return false;
    v = (uint8_t)((v & 0xC0) | c->lrckH);
    if (!wr(REG07_CLK_MGR, v)) return false;
    if (!wr(REG08_CLK_MGR, c->lrckL)) return false;

    if (!rd(REG06_CLK_MGR, &v)) return false;
    v &= 0xE0;
    v |= (c->bclkDiv < 19) ? (uint8_t)(c->bclkDiv - 1) : c->bclkDiv;
    if (!wr(REG06_CLK_MGR, v)) return false;

    return true;
}

}  // namespace

bool ready() { return s_ready; }

bool begin(uint32_t sampleRate) {
    s_ready = false;

    // Identity first. Writing a config sequence into whatever happens to ACK at
    // 0x18 is how you brick an unrelated part — 0x18 is also a common LIS3DH
    // and EEPROM address.
    uint8_t id1 = 0, id2 = 0, ver = 0;
    if (!rd(REGFD_CHIP_ID1, &id1) || !rd(REGFE_CHIP_ID2, &id2)) {
        Serial.println("[ES8311] no I2C answer at 0x18 — codec absent or bus busy");
        return false;
    }
    rd(REGFF_VERSION, &ver);
    if (id1 != 0x83 || id2 != 0x11) {
        Serial.printf("[ES8311] chip ID mismatch: FD=0x%02X FE=0x%02X (want 83/11) — refusing init\n",
                      id1, id2);
        return false;
    }

    paSetup();

    // --- open/init (upstream es8311_codec_open) ---
    // The doubled 0x44 write is upstream's I2C noise-immunity workaround.
    if (!wr(REG44_GPIO, 0x08) || !wr(REG44_GPIO, 0x08)) return false;
    if (!wr(REG01_CLK_MGR, 0x30)) return false;
    if (!wr(REG02_CLK_MGR, 0x00)) return false;
    if (!wr(REG03_CLK_MGR, 0x10)) return false;
    if (!wr(REG16_ADC,     0x24)) return false;
    if (!wr(REG04_CLK_MGR, 0x10)) return false;
    if (!wr(REG05_CLK_MGR, 0x00)) return false;
    if (!wr(REG0B_SYSTEM,  0x00)) return false;
    if (!wr(REG0C_SYSTEM,  0x00)) return false;
    if (!wr(REG10_SYSTEM,  0x1F)) return false;
    if (!wr(REG11_SYSTEM,  0x7F)) return false;
    if (!wr(REG00_RESET,   0x80)) return false;

    uint8_t v = 0;
    // Codec stays I2S slave — the ESP32 drives BCLK/LRCK.
    if (!rd(REG00_RESET, &v)) return false;
    v &= (uint8_t)~0x40;
    if (!wr(REG00_RESET, v)) return false;

    // Clock source = the MCLK pin (bit7 clear). Setting bit7 would derive the
    // codec clock from BCLK instead, which is the fallback if the MCLK pin in
    // the hypothesis map turns out to be wrong.
    if (!wr(REG01_CLK_MGR, 0x3F & (uint8_t)~0x80)) return false;

    if (!rd(REG06_CLK_MGR, &v)) return false;
    v &= (uint8_t)~0x20;                      // SCLK not inverted
    if (!wr(REG06_CLK_MGR, v)) return false;

    if (!wr(REG13_SYSTEM, 0x10)) return false;
    if (!wr(REG1B_ADC,    0x0A)) return false;
    if (!wr(REG1C_ADC,    0x6A)) return false;
    if (!wr(REG44_GPIO,   0x58)) return false;   // internal reference (ADCL + DACR)

    // --- format: I2S normal, 16-bit ---
    uint8_t dacIf = 0, adcIf = 0;
    if (!rd(REG09_SDPIN, &dacIf) || !rd(REG0A_SDPOUT, &adcIf)) return false;
    dacIf &= 0xFC; adcIf &= 0xFC;             // I2S normal
    dacIf |= 0x0C; adcIf |= 0x0C;             // 16-bit
    if (!wr(REG09_SDPIN, dacIf) || !wr(REG0A_SDPOUT, adcIf)) return false;

    if (!configSampleRate(sampleRate)) return false;

    // --- start DAC (upstream es8311_start) ---
    if (!rd(REG09_SDPIN, &dacIf) || !rd(REG0A_SDPOUT, &adcIf)) return false;
    dacIf &= 0xBF; adcIf &= 0xBF;
    if (!wr(REG09_SDPIN, dacIf) || !wr(REG0A_SDPOUT, adcIf)) return false;

    if (!wr(REG17_ADC,    0xBF)) return false;
    if (!wr(REG0E_SYSTEM, 0x02)) return false;
    if (!wr(REG12_SYSTEM, 0x00)) return false;   // enable DAC
    if (!wr(REG14_SYSTEM, 0x1A)) return false;
    if (!rd(REG14_SYSTEM, &v)) return false;
    v &= (uint8_t)~0x40;                          // analog mic, not DMIC
    if (!wr(REG14_SYSTEM, v)) return false;
    if (!wr(REG0D_SYSTEM, 0x01)) return false;
    if (!wr(REG15_ADC,    0x40)) return false;
    if (!wr(REG37_DAC,    0x08)) return false;
    if (!wr(REG45_GP,     0x00)) return false;

    // Unmute.
    if (!rd(REG31_DAC, &v)) return false;
    v &= 0x9F;
    if (!wr(REG31_DAC, v)) return false;

    setVolume(s_volume);
    setMicGain(s_micGain);
    paEnable(true);

    s_ready = true;
    Serial.printf("[ES8311] ready — 0x%02X ver 0x%02X, %lu Hz, MCLK %lu Hz "
                  "(pins MCLK %d / BCLK %d / LRCK %d / DOUT %d / PA %d)\n",
                  ADDR, ver, (unsigned long)sampleRate, (unsigned long)(sampleRate * 256u),
                  BOARD_PIN_SPK_MCLK, BOARD_PIN_SPK_BCLK, BOARD_PIN_SPK_LRCLK,
                  BOARD_PIN_SPK_DIN, BOARD_PIN_SPK_PA_EN);
    return true;
}

// REG32 is a dB scale, not a linear one: 0x00 = -95.5 dB, 0xFF = +32 dB, in
// 0.5 dB steps (upstream `vol_range`), so 0 dB lands at 0xBF. Mapping percent
// straight onto 0-255 — which is what the obvious implementation does, and what
// this one did first — puts 30% at -57 dB (silence) and 80% at +6.5 dB (far too
// loud), with almost nothing usable in between. Map percent onto -60..0 dB
// instead, so the whole knob is audible and 100% is unity rather than boost.
void setVolume(int percent) {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    s_volume = percent;
    const float db  = -60.0f + (float)percent * 0.6f;
    const int   reg = (int)((db + 95.5f) * 2.0f + 0.5f);
    wr(REG32_DAC, (uint8_t)(reg < 0 ? 0 : (reg > 255 ? 255 : reg)));
}

int volume() { return s_volume; }

void setMicGain(int step) {
    if (step < 0) step = 0;
    if (step > 7) step = 7;
    s_micGain = step;
    wr(REG16_ADC, (uint8_t)step);
}

int micGain() { return s_micGain; }

void stop() {
    paEnable(false);
    // Upstream es8311_suspend, trimmed to the DAC path.
    wr(REG32_DAC,    0x00);
    wr(REG17_ADC,    0x00);
    wr(REG0E_SYSTEM, 0xFF);
    wr(REG12_SYSTEM, 0x02);
    wr(REG14_SYSTEM, 0x00);
    wr(REG0D_SYSTEM, 0xFA);
    wr(REG15_ADC,    0x00);
    wr(REG02_CLK_MGR, 0x10);
    wr(REG00_RESET,  0x00);
    wr(REG00_RESET,  0x1F);
    wr(REG01_CLK_MGR, 0x30);
    wr(REG01_CLK_MGR, 0x00);
    wr(REG45_GP,     0x00);
    wr(REG0D_SYSTEM, 0xFC);
    wr(REG02_CLK_MGR, 0x00);
    s_ready = false;
}

}  // namespace Es8311

#endif  // BOARD_SPK_CODEC_ES8311
