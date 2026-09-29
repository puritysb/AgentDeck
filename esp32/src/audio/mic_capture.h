#pragma once

#include <cstdint>

// Push-to-talk PDM microphone capture for the T-Embed knob.
//
// The board contributes a microphone and a button; every heavy stage (STT,
// agent, TTS) stays on the host. Audio streams out as raw PCM16 binary WS
// frames bracketed by JSON voice_begin / voice_end — the ~200 byte text
// outbox is explicitly not this path.

namespace Audio {

/** Prepare I2S PDM RX. Safe to call once at boot; capture stays idle. */
bool micInit();

bool micReady();

/** True while a push-to-talk capture is running. */
bool micCapturing();

/** Begin streaming. `sessionId` is the session the transcript will be sent to
 *  (the knob's focused session); it rides in the voice_begin frame. */
void micStart(const char* sessionId);

/** Pump one I2S read → binary WS frame. Call from the UI loop while capturing. */
void micPump();

/** Stop and emit voice_end. `cancel` discards the utterance host-side. */
void micStop(bool cancel);

/** Milliseconds captured in the current utterance (0 when idle). */
uint32_t micElapsedMs(uint32_t nowMs);

// IPS10 smart-speaker telemetry/control; implemented by its single audio owner.
#if defined(BOARD_IPS10)
const char* voiceState();
uint16_t micLevel();
struct MicFeedback { uint16_t level, noise, threshold, quietMs; bool speaking, heard; };
// A small observational snapshot; audio owner alone makes endpoint decisions.
MicFeedback micFeedback();
void micVoiceResult(bool delivered);
bool micReplyAllowed();
uint32_t micReplyGeneration();
#endif

}  // namespace Audio
