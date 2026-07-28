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
