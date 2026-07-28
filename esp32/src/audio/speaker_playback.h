#pragma once

#include <cstddef>
#include <cstdint>

// Streamed PCM16 playback through the board's I2S amplifier — the daemon's
// spoken reply to something dictated here. Audio arrives as binary WebSocket
// frames bracketed by `audio_play_begin` / `audio_play_end`; this module owns a
// ring buffer between the network task (producer) and a playback task
// (consumer), because I2S writes block and must never stall WS reads.
//
// Deliberately mono 16 kHz PCM16 only: that is what the daemon synthesizes and
// what keeps a spoken answer inside a budget an ESP32 can actually drain.

namespace Audio {

/** Allocate the ring buffer (PSRAM when available). Safe to call repeatedly. */
bool playbackInit();

/** True once the buffer exists — gates the `audio_out` capability we advertise. */
bool playbackReady();

/** Start an utterance. Discards anything still queued from a previous one. */
void playbackBegin(uint32_t sampleRate);

/** Queue PCM bytes. Returns false when the ring is full (frame dropped). */
bool playbackFeed(const uint8_t* data, size_t len);

/** No more frames coming — play out what is buffered, then stop. */
void playbackEnd();

/** True while an utterance is queued or playing. */
bool playbackActive();

/** Abort immediately (link lost, user turned the knob away). */
void playbackStop();

#if defined(BOARD_PIN_MIC_DIN)
/**
 * Capture side of a full-duplex codec, reading from the same I2S instance the
 * playback path owns. It has to be the same instance: a second I2SClass on
 * these pins goes through perimanClearPinBus and tears playback down.
 *
 * captureRead() blocks until `len` bytes arrive (~32 ms per 1024) and returns 0
 * on error, so it belongs on a dedicated task — never on the LVGL thread.
 */
bool captureReady();
size_t captureRead(uint8_t* out, size_t len);
#endif

}  // namespace Audio
