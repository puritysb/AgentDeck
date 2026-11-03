#pragma once

#include <cstddef>
#include <cstdint>

namespace Net {

/**
 * Initialize WebSocket client (does not connect yet).
 */
void wsInit();

/**
 * Connect to bridge WebSocket.
 * @param ip   Bridge IP address
 * @param port Bridge port
 * @param token Auth token (empty string for local)
 */
void wsConnect(const char* ip, uint16_t port, const char* token);

/**
 * Disconnect from bridge.
 */
void wsDisconnect();

/**
 * Process WebSocket events. Call from network task loop.
 */
void wsLoop();

/**
 * Check if WebSocket is connected.
 */
bool wsConnected();

/**
 * Check if WebSocket is currently connecting.
 */
bool wsConnecting();

/** A trusted serial/paired-channel credential receipt permits another attempt. */
void wsAuthenticationProvisioned();
/** Missing/unreadable credential binding requires explicit trusted recovery. */
void wsRequirePairing();

/**
 * Send a JSON command to the bridge.
 * @param json Null-terminated JSON string
 */
void wsSend(const char* json);

/**
 * Thread-safe: enqueue an outbound JSON command from any task (e.g. CORE_UI LVGL
 * callbacks). Drained on CORE_NETWORK by pumpOutbound(). Use this instead of
 * wsSend() from the UI task — arduinoWebSockets is not thread-safe.
 */
void queueOutbound(const char* json);

/**
 * Size (including NUL) of one queued outbound frame.
 *
 * `queueOutbound` hard-truncates past this, and a JSON frame cut mid-string is
 * unparseable — the daemon drops it with no diagnostic on either side. So a
 * sender carrying variable-length text must compose against THIS cap, not a
 * guessed local buffer size. Sized to hold a `select_option` naming the
 * question it answers: ~94 bytes of envelope + a 31-byte session id + the
 * device's 160-byte copy of the question, escaped.
 */
constexpr size_t OUTBOUND_MAX_LEN = 320;

/**
 * Drain the outbound queue (WS if connected, else serial). Call from the network task loop.
 */
void pumpOutbound();

/**
 * Enqueue a PCM16 audio chunk for binary WS delivery (voice capture). Called
 * from the capture task; drained by pumpOutbound() on the network core because
 * arduinoWebSockets is not thread-safe. Returns false when the ring is full —
 * the caller should drop the chunk rather than block the I2S read loop.
 *
 * Audio only ever goes over WiFi WS: the serial line is text/JSON framed and
 * would corrupt on raw PCM.
 */
bool queueAudioChunk(const uint8_t* data, size_t len);

/** True while queued audio is still waiting to go out. */
bool audioBacklogged();

/**
 * Upload one whole captured utterance as a single HTTP POST to the daemon
 * (`POST /esp32/voice`, raw PCM16LE body). Preferred whenever WiFi is up, for
 * the same reason as the photo path: live streaming lost audio on both of this
 * board's transports (serial too slow, hosted-C6 WS stalls overflowed the DRAM
 * ring), while TCP handles ordering and retransmit. Does NOT take ownership —
 * the capture module keeps the buffer and must not start a new utterance while
 * voiceUploadBusy(). Returns false when an upload is already pending or no
 * bridge endpoint is known.
 */
bool queueVoiceHttpUpload(const uint8_t* pcm, size_t len, const char* board,
                          const char* sessionId, uint32_t sampleRate,
                          uint32_t durationMs);

/** True from queueVoiceHttpUpload() until the POST completes or fails. */
bool voiceUploadBusy();

/**
 * Fetch a spoken reply the daemon has staged (`GET /esp32/voice-reply`) into
 * PSRAM and play it locally. The push alternative — WS binary streaming — is
 * what this replaces on the hosted-C6 board: sustained inbound frames both
 * stuttered (RX jitter against a thin realtime-paced ring) and could exhaust
 * the hosted RX pool, which asserts and reboots the board
 * (`sdio_push_data_to_queue (pkt_rxbuff)`, observed twice on 2026-07-31
 * during reply playback). A pull download is paced by this board's own reads
 * via TCP flow control, and playback then runs entirely from memory.
 * Returns false when a download/playback is already in progress.
 */
bool queueVoiceReplyDownload(uint32_t expectedBytes, uint32_t sampleRate);

/**
 * Upload a captured JPEG as a single HTTP POST to the daemon
 * (`POST /esp32/photo`). Preferred whenever WiFi is up: TCP handles ordering
 * and retransmit, so neither the CDC's 64-byte FIFO holes nor the WS client's
 * TX jam can corrupt the image. Takes ownership of `jpeg`. Returns false
 * (without taking ownership) when there is no WiFi/bridge endpoint.
 */
bool queuePhotoHttpUpload(uint8_t* jpeg, size_t len, const char* sessionId,
                          int width, int height);

/**
 * Hand a captured JPEG to the network task for upload, bracketed by
 * photo_begin/photo_end. Takes ownership of `jpeg` (malloc'd by frame2jpg) —
 * freed after the last chunk or on abort. The transport is latched at
 * photo_begin: WS binary frames when connected, else base64 `photo_chunk`
 * lines over serial (line-delimited JSON, same reasoning as audio_chunk).
 * Returns false (without taking ownership) when an upload is already active
 * or no transport is up.
 */
bool queuePhotoUpload(uint8_t* jpeg, size_t len, const char* sessionId,
                      int width, int height);

/** True while a photo upload is in flight. */
bool photoUploadBusy();

/**
 * Send a typed command with no extra fields.
 */
void wsSendCommand(const char* type);

/**
 * Send respond command.
 */
void wsSendRespond(const char* value);

/**
 * Send select_option command.
 */
void wsSendSelectOption(uint8_t index);

/**
 * Send interrupt command.
 */
void wsSendInterrupt();

/**
 * Send escape command.
 */
void wsSendEscape();

/**
 * Timestamp (millis) of last reconnect attempt. Zero if never attempted.
 */
uint32_t wsLastAttemptMs();

/**
 * Current exponential backoff interval (capped at WS_RECONNECT_MAX_MS).
 */
uint32_t wsBackoffMs();

}  // namespace Net
