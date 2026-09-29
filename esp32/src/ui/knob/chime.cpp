// board_config.h first: BOARD_HAS_SPEAKER comes from a board header, not from
// a -D build flag, so the guard below cannot see it until this is included.
#include "../../../boards/board_config.h"

// T-Embed pager, and the paper surface with a codec (NM-EPD-420): a panel
// whose repaint takes ~10 s cannot flash, so the ear is its fastest signal.
#if defined(BOARD_T_EMBED) || (defined(BOARD_EINK_SURFACE) && defined(BOARD_HAS_SPEAKER))

#include "chime.h"
#include "../../audio/speaker_playback.h"

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <math.h>

static volatile bool s_playing = false;

static void feedTone(float freqHz, uint32_t ms, uint16_t amplitude) {
    constexpr uint32_t RATE = 16000;
    const uint32_t total = RATE * ms / 1000;
    int16_t buf[256];
    uint32_t written = 0;
    float phase = 0.0f;
    const float step = 2.0f * (float)M_PI * freqHz / RATE;
    while (written < total) {
        uint32_t n = total - written;
        if (n > 256) n = 256;
        for (uint32_t i = 0; i < n; i++) {
            // Short attack/decay ramp so the note doesn't click.
            uint32_t idx = written + i;
            float env = 1.0f;
            if (idx < 320) env = idx / 320.0f;
            else if (total - idx < 320) env = (total - idx) / 320.0f;
            buf[i] = (int16_t)(sinf(phase) * amplitude * env);
            phase += step;
            if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
        }
        if (!Audio::playbackFeed((const uint8_t*)buf, n * sizeof(int16_t))) break;
        written += n;
    }
}

static void chimeTask(void* param) {
    (void)param;
    // The streamed speaker transport owns T-Embed's I2S channel for the whole
    // boot. Creating another I2SClass here tears that owner down (or claims the
    // S3's last controller while the PDM mic owns the other one), leaving the
    // amplifier clocking garbage after an OpenClaw attention edge. Feed the
    // generated notes through the one shared owner instead.
    if (!Audio::playbackActive()) {
        Audio::playbackBegin(16000);
        if (Audio::playbackActive()) {
            // Two-note rising chime, quiet enough for a desk (amp ≈ 18% FS).
            feedTone(880.0f, 110, 6000);
            feedTone(1318.5f, 140, 6000);
            Audio::playbackEnd();
        }
    }
    s_playing = false;
    vTaskDelete(nullptr);
}

namespace Chime {

void playAttention() {
    // A board whose codec never answered has nothing to play through.
    if (!Audio::speakerAudible()) return;
    if (s_playing || Audio::playbackActive()) return;  // coalesce; never interrupt speech
    s_playing = true;
    if (xTaskCreate(chimeTask, "chime", 4096, nullptr, 1, nullptr) != pdPASS) {
        s_playing = false;
    }
}

}  // namespace Chime

#endif  // BOARD_T_EMBED || paper surface with a speaker
