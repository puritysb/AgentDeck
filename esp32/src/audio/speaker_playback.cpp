// board_config.h first: BOARD_HAS_SPEAKER comes from a board header, not from
// a -D build flag, so the guard below cannot see it until this is included.
#include "../../boards/board_config.h"

#if defined(BOARD_HAS_SPEAKER)

#include "speaker_playback.h"
#include "pcm_write.h"
#if defined(BOARD_SPK_CODEC_ES8311)
#include "es8311_codec.h"
#endif

#include <Arduino.h>
#include <ESP_I2S.h>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

// 64 KB = 2 s of 16 kHz mono PCM16. The daemon paces frames at playback speed,
// so this only has to absorb WiFi jitter, not a whole reply — a reply can run
// tens of seconds and will never fit in RAM.
static constexpr size_t RING_BYTES = 64 * 1024;
// Below this the playback task waits instead of writing, so a hiccup becomes a
// short pause rather than a burst of silence mid-word.
static constexpr size_t PREBUFFER_BYTES = 8 * 1024;
// Give up if the daemon goes quiet mid-utterance: without this the task would
// hold I2S open forever after a dropped link.
static constexpr uint32_t STARVE_TIMEOUT_MS = 8000;

static uint8_t* s_ring = nullptr;
static volatile size_t s_head = 0;   // read cursor
static volatile size_t s_tail = 0;   // write cursor
static SemaphoreHandle_t s_mutex = nullptr;
static volatile bool s_streaming = false;   // daemon still sending
static volatile bool s_playing = false;     // task alive
static volatile bool s_abort = false;
static uint32_t s_sampleRate = 16000;
// Utterance accounting. Without it a silent speaker is indistinguishable from
// audio that never arrived, which is exactly the ambiguity that made the mic
// side hard to debug.
static volatile uint32_t s_fedBytes = 0;
static volatile uint32_t s_playedBytes = 0;
static volatile uint32_t s_droppedFrames = 0;

static size_t ringAvailable() {
    size_t head = s_head, tail = s_tail;
    return (tail >= head) ? (tail - head) : (RING_BYTES - head + tail);
}

static size_t ringFree() {
    // Keep one byte unused so full and empty stay distinguishable.
    return RING_BYTES - ringAvailable() - 1;
}

static size_t ringRead(uint8_t* out, size_t want) {
    size_t avail = ringAvailable();
    if (want > avail) want = avail;
    size_t head = s_head;
    for (size_t i = 0; i < want; i++) {
        out[i] = s_ring[head];
        head = (head + 1) % RING_BYTES;
    }
    s_head = head;
    return want;
}

// The I2S channel is opened once and kept. It used to be a stack object in the
// playback task, begun and ended per utterance — which leaks the channel: the
// Arduino wrapper's end() bails out before i2s_del_channel() if the preceding
// i2s_channel_disable() errors, so the second utterance dies on
// "i2s_new_channel(): no available channel found" and the board goes silent
// until reboot. Measured on ips10 (2026-07-28); t_embed runs the same code and
// carried the same latent bug.
static I2SClass s_i2s;
static bool s_i2sOpen = false;
static uint32_t s_i2sRate = 0;

// Returns false if the channel could not be opened. Re-opens only when the
// sample rate actually changes.
static bool ensureI2sOpen(uint32_t rate) {
    if (s_i2sOpen && s_i2sRate == rate) return true;
    if (s_i2sOpen) {
        s_i2s.end();
        s_i2sOpen = false;
    }
#if defined(BOARD_PIN_SPK_MCLK)
    // Codec boards need a master clock; a bare I2S amplifier does not.
    // When the codec also feeds a microphone back, name its data-in pin here:
    // one i2s_new_channel() then yields tx+rx on the same controller, sharing
    // BCLK/WS. That matters more than it looks — it means the capture DMA is
    // claimed at this same early, pre-LVGL, pre-WiFi moment rather than in a
    // late allocation that would repeat the ESP_ERR_NO_MEM failure.
#if defined(BOARD_PIN_MIC_DIN)
    s_i2s.setPins(BOARD_PIN_SPK_BCLK, BOARD_PIN_SPK_LRCLK, BOARD_PIN_SPK_DIN,
                  BOARD_PIN_MIC_DIN, BOARD_PIN_SPK_MCLK);
#else
    s_i2s.setPins(BOARD_PIN_SPK_BCLK, BOARD_PIN_SPK_LRCLK, BOARD_PIN_SPK_DIN, -1,
                  BOARD_PIN_SPK_MCLK);
#endif
#else
    s_i2s.setPins(BOARD_PIN_SPK_BCLK, BOARD_PIN_SPK_LRCLK, BOARD_PIN_SPK_DIN, -1, -1);
#endif
    if (!s_i2s.begin(I2S_MODE_STD, rate,
                     I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
        // "no available channel found" means a channel is allocated that this
        // module does not believe it owns. end() is the only way back, and it
        // is exactly the call whose failure created the leak — so try it, then
        // retry once, and report both attempts rather than guessing.
        Serial.printf("[Speaker] I2S begin failed (open=%d rate=%lu->%lu) — releasing and retrying\n",
                      (int)s_i2sOpen, (unsigned long)s_i2sRate, (unsigned long)rate);
        s_i2s.end();
        delay(20);
        if (!s_i2s.begin(I2S_MODE_STD, rate,
                         I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
            Serial.println("[Speaker] I2S begin failed again — no playback");
            return false;
        }
        Serial.println("[Speaker] I2S recovered on retry");
    }
    s_i2sOpen = true;
    s_i2sRate = rate;
    return true;
}

static void playbackTask(void* param) {
    (void)param;
    if (!ensureI2sOpen((uint32_t)s_sampleRate)) {
        s_playing = false;
        s_streaming = false;
        vTaskDelete(nullptr);
        return;
    }

#if defined(BOARD_SPK_CODEC_ES8311)
    // Codec init must follow the I2S clock coming up: the ES8311 locks to MCLK,
    // so the clock has to already be running when its clock-manager registers
    // are programmed. IPS10 keeps its shared mic/playback codec live;
    // other boards retain the per-utterance initialization path.
    // Failure is not fatal here: I2S keeps streaming into a silent codec, and
    // the log line is what tells the two apart.
#if defined(BOARD_IPS10)
    // Continuous microphone capture already owns a live ADC/DAC. Resetting
    // this codec per reply toggled PA and consumed the first spoken samples
    // during its analogue startup. Reconfigure only after stop/rate change.
    const bool codecOk = Es8311::ensure((uint32_t)s_sampleRate);
#else
    const bool codecOk = Es8311::begin((uint32_t)s_sampleRate);
#endif
    if (!codecOk) {
        Serial.println("[Speaker] ES8311 init failed — samples will go nowhere");
    } else {
        Es8311::dumpRegs("after init, before samples");
    }
#endif

    // Wait for the prebuffer (or for the utterance to prove itself short).
    uint32_t waitStart = millis();
    while (!s_abort && s_streaming && ringAvailable() < PREBUFFER_BYTES &&
           (millis() - waitStart) < 1500) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }

    uint8_t chunk[1024];
    auto writePcm = [](const uint8_t* data, size_t len) { return s_i2s.write(data, len); };
    auto aborted = []() { return s_abort; };
#if defined(BOARD_IPS10)
    // Reuse the playback task's existing stack buffer, no extra allocation.
    // Clock 80 ms of zero PCM before touching the ring: DAC/PA startup or
    // auto-mute release may consume silence, never the first speech samples.
    memset(chunk, 0, sizeof(chunk));
    size_t primed = 0;
    const size_t primeBytes = size_t(s_sampleRate) * 2 * 80 / 1000;
    while (!s_abort && primed < primeBytes) {
        const size_t remaining = primeBytes - primed;
        const size_t want = remaining < sizeof(chunk) ? remaining : sizeof(chunk);
        const size_t sent = Audio::writePcmFully(chunk, want, writePcm, aborted);
        primed += sent;
        if (sent != want) { s_abort = true; break; }
    }
    Serial.printf("[Speaker] primed %u/%u silent bytes before PCM\n", unsigned(primed), unsigned(primeBytes));
#endif
    uint32_t lastDataMs = millis();
    while (!s_abort) {
        size_t got = 0;
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        got = ringRead(chunk, sizeof(chunk));
        xSemaphoreGive(s_mutex);

        if (got > 0) {
            const size_t sent = Audio::writePcmFully(chunk, got, writePcm, aborted);
            s_playedBytes += sent;
            if (sent != got) {
                Serial.printf("[Speaker] incomplete I2S write %u/%u — stopping\n", unsigned(sent), unsigned(got));
                s_abort = true;
                break;
            }
            lastDataMs = millis();
            continue;
        }
        // Ring empty: done if the daemon finished, otherwise wait for more.
        if (!s_streaming) break;
        if ((millis() - lastDataMs) > STARVE_TIMEOUT_MS) {
            Serial.println("[Speaker] starved — ending playback");
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }

    // Deliberately NOT i2s.end() — see ensureI2sOpen(). The channel stays open
    // for the next utterance; with nothing written it clocks out silence.
    Serial.printf("[Speaker] played %lu/%lu bytes (%.1fs), %lu frames dropped%s\n",
                  (unsigned long)s_playedBytes, (unsigned long)s_fedBytes,
                  (double)s_playedBytes / 2.0 / (double)s_sampleRate,
                  (unsigned long)s_droppedFrames,
                  s_abort ? ", aborted" : "");
    s_playing = false;
    s_streaming = false;
    s_abort = false;
    vTaskDelete(nullptr);
}

namespace Audio {

bool playbackInit() {
    if (s_ring) return true;
    if (!s_mutex) s_mutex = xSemaphoreCreateMutex();
    if (!s_mutex) return false;
    // PSRAM first: 64 KB of internal RAM is too much to hold hostage for audio
    // on a board that also runs LVGL.
    s_ring = (uint8_t*)heap_caps_malloc(RING_BYTES, MALLOC_CAP_SPIRAM);
    if (!s_ring) s_ring = (uint8_t*)malloc(RING_BYTES);
    if (!s_ring) {
        Serial.println("[Speaker] ring allocation failed — playback disabled");
        return false;
    }
    // Claim the I2S channel now rather than at first utterance. Its DMA
    // descriptors must live in internal DMA-capable RAM, and on ips10 that pool
    // is contended: the LVGL draw buffer is forced internal and ESP-Hosted WiFi
    // feeds from the same heap. Allocating late failed with ESP_ERR_NO_MEM once
    // WiFi was up — and took the SDIO driver down with it
    // (assert sdio_rx_get_buffer). A few KB held from boot costs far less than
    // a board that can only speak while its radio is parked.
    Serial.printf("[Speaker] internal heap before I2S: %u KB free\n",
                  (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024));
    if (!ensureI2sOpen(16000)) {
        Serial.println("[Speaker] I2S channel unavailable at init — playback will retry per utterance");
    }
    Serial.printf("[Speaker] playback ready (%u KB ring, internal heap %u KB)\n",
                  (unsigned)(RING_BYTES / 1024),
                  (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024));
#if defined(BOARD_SPK_CODEC_ES8311)
    // Probe now so `audio_out` is answerable from the first device_info rather
    // than only after an utterance has already been attempted and lost.
    Es8311::present();
#endif
    return true;
}

bool playbackReady() { return s_ring != nullptr; }

bool speakerAudible() {
    if (s_ring == nullptr) return false;
#if defined(BOARD_SPK_CODEC_ES8311)
    return Es8311::present();
#else
    // Boards driving an amplifier directly off I2S have nothing to interrogate;
    // a ready transport is the whole answer there.
    return true;
#endif
}

void playbackBegin(uint32_t sampleRate) {
    if (!playbackInit()) return;
    if (s_playing) playbackStop();
    // Wait out the previous task so two I2S TX channels never overlap.
    uint32_t start = millis();
    while (s_playing && (millis() - start) < 500) delay(5);

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_head = 0;
    s_tail = 0;
    xSemaphoreGive(s_mutex);
    s_sampleRate = (sampleRate >= 8000 && sampleRate <= 48000) ? sampleRate : 16000;
    s_abort = false;
    s_fedBytes = 0;
    s_playedBytes = 0;
    s_droppedFrames = 0;
    s_streaming = true;
    s_playing = true;
    if (xTaskCreate(playbackTask, "spk_play", 4096, nullptr, 2, nullptr) != pdPASS) {
        Serial.println("[Speaker] task spawn failed");
        s_playing = false;
        s_streaming = false;
    }
}

bool playbackFeed(const uint8_t* data, size_t len) {
    if (!s_ring || !data || len == 0 || !s_streaming) return false;
    bool ok = false;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (ringFree() >= len) {
        size_t tail = s_tail;
        for (size_t i = 0; i < len; i++) {
            s_ring[tail] = data[i];
            tail = (tail + 1) % RING_BYTES;
        }
        s_tail = tail;
        s_fedBytes += len;
        ok = true;
    } else {
        s_droppedFrames++;
    }
    xSemaphoreGive(s_mutex);
    return ok;
}

void playbackEnd() {
    // Leave s_playing alone: the task drains the ring, then exits on its own.
    s_streaming = false;
}

bool playbackActive() { return s_playing || s_streaming; }

// Short UI tone (press tick / sent blip), generated in place — no asset, no
// allocation. Runs through the normal playback path, so it also serves as the
// codec warm-up on boards where the first press otherwise pays Es8311::begin.
// No-op while a real reply is active: feedback must never eat an answer.
void playTone(uint32_t freqHz, uint32_t ms, float amplitude) {
    if (playbackActive()) return;
    playbackBegin(16000);
    if (!s_playing) return;
    const uint32_t total = 16000u * ms / 1000u;
    int16_t buf[256];
    const float amp = amplitude * 32767.0f;
    uint32_t n = 0;
    while (n < total) {
        uint32_t chunk = total - n;
        if (chunk > 256) chunk = 256;
        for (uint32_t i = 0; i < chunk; i++) {
            float t = (float)(n + i);
            // Linear fade-out over the last quarter avoids a click at the end.
            float env = 1.0f;
            float tail = (float)total * 0.75f;
            if (t > tail) env = 1.0f - (t - tail) / ((float)total - tail);
            buf[i] = (int16_t)(amp * env * sinf(2.0f * (float)M_PI * (float)freqHz * t / 16000.0f));
        }
        // Ring is 64 KB and the tone is ≤ a few KB — feed never fails here.
        playbackFeed((const uint8_t*)buf, chunk * 2);
        n += chunk;
    }
    playbackEnd();
}

#if defined(BOARD_PIN_MIC_DIN)
bool captureReady() { return s_i2sOpen; }

size_t captureRead(uint8_t* out, size_t len) {
    if (!s_i2sOpen || !out || len == 0) return 0;
    // Blocks until `len` bytes arrive (~32 ms per 1024) and returns 0 on error,
    // so never call this from the LVGL task — its input device polls at 24 ms.
    return s_i2s.readBytes((char*)out, len);
}
#endif

void playbackStop() {
    s_abort = true;
    s_streaming = false;
}

}  // namespace Audio

#endif  // BOARD_HAS_SPEAKER
