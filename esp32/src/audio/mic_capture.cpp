// board_config.h before the guard: BOARD_HAS_VOICE_CAPTURE is a board-header
// macro, not a -D flag.
#include "../../boards/board_config.h"

#if defined(BOARD_HAS_VOICE_CAPTURE) && !defined(BOARD_IPS10)

#include "mic_capture.h"
#include "../net/ws_client.h"

#include <Arduino.h>
#if defined(BOARD_PIN_MIC_DATA)
#include <ESP_I2S.h>
#else
// Codec boards capture through the same full-duplex I2S the speaker owns.
#include "speaker_playback.h"
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#if defined(BOARD_SPK_CODEC_ES8311)
#include "es8311_codec.h"
#endif
#if defined(BOARD_VOICE_HTTP_UPLOAD)
#include <esp_heap_caps.h>
#include "../net/wifi_manager.h"   // Net::wifiConnected — the HTTP-mode gate
// Local outcome banners for cases the daemon never learns about (empty
// utterance, refused upload). Cross-core-safe: HUD entry points publish a
// fixed-size slot that HUD::update() applies on the LVGL core.
#include "../ui/widgets/hud_bar.h"
#endif
#endif

// The daemon keys the utterance by board, so this must match device_info.
#if defined(BOARD_T_EMBED)
#define MIC_BOARD_NAME "t_embed"
#elif defined(BOARD_IPS10)
#define MIC_BOARD_NAME "ips_10"
#else
#error "BOARD_HAS_VOICE_CAPTURE set but no board name for voice_begin"
#endif

static constexpr uint32_t SAMPLE_RATE = 16000;   // what Apple's recognizer wants
static constexpr size_t READ_SAMPLES = 512;      // 1 KB per frame, ~32 ms
static constexpr uint32_t MAX_UTTERANCE_MS = 30000;

// After the user lets go, keep reading long enough to collect what the I2S DMA
// already holds. Releasing and stopping in the same instant clipped the last
// syllable off every utterance ("안녕하세요" reached the recognizer as "안녕하세").
static constexpr uint32_t TAIL_DRAIN_MS = 300;
// Don't wait forever for the ring to flush if the link is wedged — closing the
// utterance late is better than never closing it.
static constexpr uint32_t END_FLUSH_TIMEOUT_MS = 3000;

#if defined(BOARD_PIN_MIC_DATA)
static I2SClass s_i2s;
#endif
static bool s_ready = false;
static bool s_capturing = false;
static uint32_t s_startedMs = 0;
static int16_t s_buf[READ_SAMPLES];
// Closing state: capture has stopped but voice_end must not be sent yet.
static bool s_closing = false;
static bool s_closingCancel = false;
static uint32_t s_closingSinceMs = 0;
static uint32_t s_closingDurationMs = 0;
static uint32_t s_capturedBytes = 0;
static uint32_t s_queuedBytes = 0;
static uint32_t s_droppedFrames = 0;

#if defined(BOARD_VOICE_HTTP_UPLOAD)
// Whole-utterance PSRAM buffer for the HTTP upload path. Streaming the PCM
// live was tried twice and lost audio both times: 115200-baud serial tops out
// at ~11 KB/s against the 32 KB/s capture rate, and the hosted-C6 WebSocket
// stalled long enough to overflow the 6-slot DRAM ring (89 of 191 frames
// dropped on a 6 s utterance, 2026-07-30). Transcription only starts at
// utterance end anyway, so buffering everything and POSTing once — the same
// move that fixed the camera (photo → HTTP, c7ee9ee9) — costs nothing but
// PSRAM this board has to spare.
static constexpr size_t UTTER_BUF_BYTES = SAMPLE_RATE * 2u * (MAX_UTTERANCE_MS / 1000u);
static uint8_t* s_utterBuf = nullptr;
static size_t s_utterLen = 0;
static bool s_httpActive = false;      // this utterance rides HTTP, not WS/serial
static char s_session[40] = {0};
#endif

// The only board-dependent part of capture. Everything below — tail drain,
// backlog ordering, runaway guard — is shared, and deliberately so: those rules
// were each paid for by a bug.
static size_t micReadFrame() {
#if defined(BOARD_PIN_MIC_DATA)
    return s_i2s.readBytes((char*)s_buf, sizeof(s_buf));
#else
    return Audio::captureRead((uint8_t*)s_buf, sizeof(s_buf));
#endif
}

static void micQueueFrame(size_t got) {
    if (got == 0) return;
    s_capturedBytes += got;
#if defined(BOARD_VOICE_HTTP_UPLOAD)
    if (s_httpActive) {
        // Sized to the runaway cap, so this only trips on the tail-drain frames
        // of a maximum-length utterance.
        if (s_utterLen + got <= UTTER_BUF_BYTES) {
            memcpy(s_utterBuf + s_utterLen, s_buf, got);
            s_utterLen += got;
            s_queuedBytes += got;
        } else {
            s_droppedFrames++;
        }
        return;
    }
#endif
    if (Net::queueAudioChunk((const uint8_t*)s_buf, got)) {
        s_queuedBytes += got;
    } else {
        s_droppedFrames++;
    }
}

#if !defined(BOARD_PIN_MIC_DATA)
// Codec boards pump from their own task. micReadFrame() blocks ~32 ms per
// frame, and on ips10 the only other candidate thread drives LVGL with a 24 ms
// input timer — pumping there would visibly stall touch for the whole hold.
static TaskHandle_t s_pumpTask = nullptr;
static void micPumpTask(void*) {
    while (Audio::micCapturing()) {
        Audio::micPump();
        vTaskDelay(pdMS_TO_TICKS(2));
    }
    s_pumpTask = nullptr;
    vTaskDelete(nullptr);
}
#endif

namespace Audio {

bool micInit() {
#if defined(BOARD_PIN_MIC_DATA)
    // PDM RX shares no pins with the speaker's STD TX, but both grab an I2S
    // peripheral — the S3 has two, so capture and the chime can coexist.
    s_i2s.setPinsPdmRx(BOARD_PIN_MIC_CLK, BOARD_PIN_MIC_DATA);
    s_ready = s_i2s.begin(I2S_MODE_PDM_RX, SAMPLE_RATE,
                          I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
    if (!s_ready) Serial.println("[Mic] PDM RX init failed — push-to-talk disabled");
    else Serial.println("[Mic] PDM RX ready (16 kHz mono)");
#else
    // Nothing to open: the RX half came up with the speaker's channel, early in
    // boot, which is the only moment this board has the internal DMA memory for
    // it. If that failed, capture is simply unavailable.
    s_ready = playbackInit() && captureReady();
    Serial.println(s_ready ? "[Mic] codec ADC ready (16 kHz mono, shared I2S)"
                           : "[Mic] shared I2S unavailable — push-to-talk disabled");
#endif
#if defined(BOARD_VOICE_HTTP_UPLOAD)
    if (s_ready && !s_utterBuf) {
        // PSRAM only: 960 KB of internal RAM does not exist on any board, and
        // a DRAM fallback here would quietly starve LVGL + ESP-Hosted.
        s_utterBuf = (uint8_t*)heap_caps_malloc(UTTER_BUF_BYTES, MALLOC_CAP_SPIRAM);
        Serial.printf("[Mic] HTTP utterance buffer %s (%u KB PSRAM)\n",
                      s_utterBuf ? "ready" : "unavailable — will stream instead",
                      (unsigned)(UTTER_BUF_BYTES / 1024));
    }
#endif
    return s_ready;
}

bool micReady() { return s_ready; }
bool micCapturing() { return s_capturing || s_closing; }

uint32_t micElapsedMs(uint32_t nowMs) {
    return s_capturing ? (uint32_t)(nowMs - s_startedMs) : 0;
}

void micStart(const char* sessionId) {
    if (!s_ready || s_capturing) return;
#if !defined(BOARD_PIN_MIC_DATA) && defined(BOARD_SPK_CODEC_ES8311)
    // The codec ADC only runs once begin() has programmed it — on a cold boot
    // that never played audio, capture otherwise reads pure silence, which
    // reached the recognizer as "No speech detected". mic_test knew to do this;
    // push-to-talk didn't. begin() needs MCLK already up, which micInit's
    // playbackInit guaranteed. ~40 I2C writes, once per boot.
    if (!Es8311::ready() && !Es8311::begin(SAMPLE_RATE)) {
        Serial.println("[Mic] ES8311 init failed — capture would be silence");
        return;
    }
#endif
    s_closing = false;
    s_capturing = true;
    s_startedMs = millis();
    s_capturedBytes = 0;
    s_queuedBytes = 0;
    s_droppedFrames = 0;
#if defined(BOARD_VOICE_HTTP_UPLOAD)
    s_utterLen = 0;
    snprintf(s_session, sizeof(s_session), "%s", sessionId ? sessionId : "");
    // Per-utterance decision, not a build-time one: WiFi can be down, the
    // buffer can have failed to allocate, and the previous upload can still be
    // in flight. Any of those falls back to the live-streaming path.
    s_httpActive = s_utterBuf != nullptr && Net::wifiConnected() && !Net::voiceUploadBusy();
    if (s_httpActive) {
        Serial.println("[Mic] capture start (HTTP buffered)");
    } else
#endif
    {
        char frame[160];
        snprintf(frame, sizeof(frame),
                 "{\"type\":\"voice_begin\",\"board\":\"" MIC_BOARD_NAME "\",\"format\":\"pcm16\","
                 "\"sampleRate\":%lu,\"sessionId\":\"%s\"}",
                 (unsigned long)SAMPLE_RATE, sessionId ? sessionId : "");
        Net::queueOutbound(frame);
        Serial.println("[Mic] capture start");
    }
#if !defined(BOARD_PIN_MIC_DATA)
    if (!s_pumpTask) {
        xTaskCreate(micPumpTask, "mic_pump", 4096, nullptr, 3, &s_pumpTask);
    }
#endif
}

void micPump() {
    if (s_closing) {
        uint32_t since = millis() - s_closingSinceMs;
        // Phase 1: keep draining the mic so the tail of the last word is kept.
        if (since < TAIL_DRAIN_MS) {
            size_t got = micReadFrame();
            micQueueFrame(got);
            return;
        }
#if defined(BOARD_VOICE_HTTP_UPLOAD)
        if (s_httpActive) {
            // Whole utterance is in PSRAM; hand it to the network core for one
            // POST. No voice_end frame — the HTTP body is the utterance.
            s_closing = false;
            if (s_closingCancel || s_utterLen == 0) {
                Serial.printf("[Mic] capture discarded (%s)\n",
                              s_closingCancel ? "cancelled" : "empty");
                if (!s_closingCancel) HUD::notify("Heard nothing");
                return;
            }
            if (!Net::queueVoiceHttpUpload(s_utterBuf, s_utterLen, MIC_BOARD_NAME,
                                           s_session, SAMPLE_RATE, s_closingDurationMs)) {
                Serial.println("[Mic] HTTP voice upload refused — utterance dropped");
                HUD::notify("Voice upload busy — try again");
            }
            Serial.printf("[Mic] capture stop (%lums, %lu bytes -> HTTP)\n",
                          (unsigned long)s_closingDurationMs, (unsigned long)s_utterLen);
            return;
        }
#endif
        // Phase 2: voice_end must not overtake the audio still in flight.
        // pumpOutbound() drains the JSON outbox BEFORE the PCM ring, so an
        // end frame queued while frames are pending reaches the daemon first
        // and the utterance is finalized without its tail.
        if (Net::audioBacklogged() && since < END_FLUSH_TIMEOUT_MS) return;
        char frame[160];
        snprintf(frame, sizeof(frame),
                 "{\"type\":\"voice_end\",\"durationMs\":%lu,\"cancel\":%s,"
                 "\"capturedBytes\":%lu,\"queuedBytes\":%lu,\"droppedFrames\":%lu}",
                 (unsigned long)s_closingDurationMs, s_closingCancel ? "true" : "false",
                 (unsigned long)s_capturedBytes, (unsigned long)s_queuedBytes,
                 (unsigned long)s_droppedFrames);
        Net::queueOutbound(frame);
        Serial.printf("[Mic] capture stop (%lums%s, tail %lums, %lu/%lu bytes, %lu dropped)\n",
                      (unsigned long)s_closingDurationMs,
                      s_closingCancel ? ", cancelled" : "", (unsigned long)since,
                      (unsigned long)s_queuedBytes, (unsigned long)s_capturedBytes,
                      (unsigned long)s_droppedFrames);
        s_closing = false;
        return;
    }
    if (!s_capturing) return;
    // Runaway guard: a stuck button must not stream forever.
    if (millis() - s_startedMs > MAX_UTTERANCE_MS) {
        micStop(false);
        return;
    }
    size_t got = micReadFrame();
    if (got == 0) return;
    // A full ring means the link cannot keep up; drop this frame rather than
    // block — late audio is worthless and stalling here would also stall the UI.
    micQueueFrame(got);
}

void micStop(bool cancel) {
    if (!s_capturing) return;
    s_capturing = false;
    // Enter the closing state instead of ending here: micPump() drains the tail
    // and only then queues voice_end. See TAIL_DRAIN_MS.
    s_closing = true;
    s_closingCancel = cancel;
    s_closingSinceMs = millis();
    s_closingDurationMs = millis() - s_startedMs;
}

}  // namespace Audio

#endif  // BOARD_HAS_VOICE_CAPTURE
