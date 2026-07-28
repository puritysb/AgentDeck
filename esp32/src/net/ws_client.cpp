#include "ws_client.h"
#include "serial_client.h"
#include "wifi_manager.h"
#include "protocol.h"
#include "config.h"
// Board header, not just -D flags: BOARD_HAS_DVP_CAMERA lives in
// boards/board_t_display_pro.h. Without this include the photo upload
// compiled to its no-op stub on the very board that has the camera —
// every shutter press reported "no link".
#include "../../boards/board_config.h"
#include "../state/agent_state.h"
#if defined(BOARD_HAS_SPEAKER)
#include "../audio/speaker_playback.h"
#endif

#include <WiFi.h>
#include <WiFiClientSecure.h>
#if defined(BOARD_HAS_DVP_CAMERA)
#include <HTTPClient.h>
#endif
#include <WebSocketsClient.h>
#include <Arduino.h>
#include <mbedtls/base64.h>

static WebSocketsClient ws;
static bool connected = false;
static bool connecting = false;
static uint32_t reconnectMs = WS_RECONNECT_MIN_MS;
static uint32_t lastReconnectAttempt = 0;
static char savedIp[16] = {0};
static uint16_t savedPort = 0;
static char savedToken[40] = {0};

// ── outbound queue (UI core → network core) ──
// LVGL event callbacks run on CORE_UI; the WebSocket + serial transports are
// driven from CORE_NETWORK. arduinoWebSockets is not thread-safe, so UI-side
// senders enqueue here and the network task drains via pumpOutbound().
static constexpr int OUTBOX_MAX = 6;
static constexpr int OUTBOX_LEN = 200;
static char outbox[OUTBOX_MAX][OUTBOX_LEN];
static int outboxHead = 0;
static int outboxCount = 0;
static SemaphoreHandle_t outboxMutex = nullptr;

// ── binary audio ring (capture task → network core) ──
// 6 × 2 KB covers ~380 ms of 16 kHz mono PCM16 in flight, enough to ride out a
// WiFi hiccup without stalling the I2S reader.
//
// Board-guarded: 12 KB of DRAM is a rounding error on a PSRAM S3 and fatal on
// the TTGO, whose 46 KB canvas already crowds dram0_0_seg — allocating it there
// overflowed the segment by 13 KB and broke that board's build outright. Only a
// board with a microphone can ever fill this ring, so only such a board pays
// for it. Nothing gates ESP32 builds in CI, which is why the break stayed
// invisible until a full-fleet compile.
#if defined(BOARD_T_EMBED)
static constexpr int AUDIO_SLOTS = 6;
static constexpr size_t AUDIO_SLOT_BYTES = 2048;
static uint8_t audioRing[AUDIO_SLOTS][AUDIO_SLOT_BYTES];
static size_t audioLen[AUDIO_SLOTS] = {0};
static int audioHead = 0;
static int audioCount = 0;
static SemaphoreHandle_t audioMutex = nullptr;
#endif

// ── photo upload (UI shutter → network core) ──
// One JPEG at a time, heap-owned (frame2jpg allocates; on a PSRAM-enabled S3
// the blob lands in PSRAM, so no DRAM board-guard concern beyond the small
// state below). Board-guarded: only a camera board can ever start an upload.
#if defined(BOARD_HAS_DVP_CAMERA)
enum class PhotoPhase : uint8_t { IDLE, BEGIN, DATA, END };
static uint8_t* photoBuf = nullptr;
static size_t photoLen = 0;
static size_t photoOff = 0;
static char photoSession[36] = {0};
static int photoW = 0, photoH = 0;
// HTTP upload path (preferred when WiFi is up — see queuePhotoHttpUpload).
static bool photoHttpPending = false;
static char photoHttpIp[16] = {0};
static uint16_t photoHttpPort = 0;
static char photoHttpToken[40] = {0};
static PhotoPhase photoPhase = PhotoPhase::IDLE;
static bool photoViaWs = false;
static uint32_t photoStartMs = 0;
// Hard deadline: a wedged transport (the WS TX jam) must not hold the shutter
// hostage — after this the upload aborts and the next snap starts clean.
static constexpr uint32_t PHOTO_UPLOAD_DEADLINE_MS = 20000;
static SemaphoreHandle_t photoMutex = nullptr;
// Raw bytes per frame: 2048 on both transports — the size the voice path
// proved on this library (a first 4096 WS frame went out and the socket then
// went quiet, 2026-07-27). Serial additionally needs the base64 line to stay
// inside the 3 KB buffer.
static constexpr size_t PHOTO_WS_CHUNK = 2048;
static constexpr size_t PHOTO_SERIAL_CHUNK = 2048;
// Consecutive send failures tolerated before aborting the upload.
static constexpr int PHOTO_MAX_SEND_FAILURES = 25;
#endif

static void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
    switch (type) {
        case WStype_DISCONNECTED:
            Serial.println("[WS] Disconnected");
            connected = false;
            connecting = false;
            lockState();
            // Only mark disconnected if serial is also not connected
            // (serial data is authoritative — don't override it)
            if (!Net::serialConnected()) {
                g_state.markBridgeDisconnected();
            }
            unlockState();
            break;

        case WStype_CONNECTED:
            Serial.printf("[WS] Connected to %s:%d\n", savedIp, savedPort);
            connected = true;
            connecting = false;
            reconnectMs = WS_RECONNECT_MIN_MS;
            ws.setReconnectInterval(reconnectMs);
            lockState();
            g_state.wsConnected = true;
            g_state.lastMessageMs = millis();
            unlockState();
            // Request initial state + identify ourselves (device_info is
            // request-driven on serial, but nothing requests it over WS — a
            // WiFi-only board must announce or the daemon never learns its
            // board/buildHash).
            Net::wsSendCommand("query_usage");
            Protocol::announceDeviceInfo();
            break;

        case WStype_TEXT:
            Protocol::parseMessage((const char*)payload, length);
            lockState();
            g_state.lastMessageMs = millis();
            unlockState();
            break;

        case WStype_BIN:
#if defined(BOARD_HAS_SPEAKER)
            // Inbound binary is spoken-reply PCM, bracketed by
            // audio_play_begin/end. Dropped when the ring is full: a late frame
            // is worse than a gap, and blocking here would stall WS reads.
            Audio::playbackFeed(payload, length);
#endif
            lockState();
            g_state.lastMessageMs = millis();
            unlockState();
            break;

        case WStype_PING:
            // Library handles pong automatically
            break;

        case WStype_PONG:
            break;

        case WStype_ERROR:
            Serial.println("[WS] Error");
            break;

        default:
            break;
    }
}

namespace Net {

void wsInit() {
    if (!outboxMutex) outboxMutex = xSemaphoreCreateMutex();
#if defined(BOARD_T_EMBED)
    if (!audioMutex) audioMutex = xSemaphoreCreateMutex();
#endif
#if defined(BOARD_HAS_DVP_CAMERA)
    if (!photoMutex) photoMutex = xSemaphoreCreateMutex();
#endif
}

#if !defined(BOARD_HAS_DVP_CAMERA)
bool queuePhotoUpload(uint8_t*, size_t, const char*, int, int) { return false; }
bool queuePhotoHttpUpload(uint8_t*, size_t, const char*, int, int) { return false; }
bool photoUploadBusy() { return false; }
#else
bool queuePhotoUpload(uint8_t* jpeg, size_t len, const char* sessionId,
                      int width, int height) {
    if (!jpeg || len == 0 || !photoMutex) return false;
    bool queued = false;
    xSemaphoreTake(photoMutex, portMAX_DELAY);
    if (photoPhase == PhotoPhase::IDLE && (connected || Net::serialConnected())) {
        photoBuf = jpeg;
        photoLen = len;
        photoOff = 0;
        photoW = width;
        photoH = height;
        strncpy(photoSession, sessionId ? sessionId : "", sizeof(photoSession) - 1);
        photoSession[sizeof(photoSession) - 1] = '\0';
        // Latch the transport now: a link that flips mid-upload yields a
        // corrupt JPEG, so a dropped latch aborts instead of migrating.
        // Serial first, mirroring the fleet's single-path preference — and
        // empirically: this board's WS TX jammed after the first binary chunk
        // on consecutive uploads (socket closed ~13 s later), while the paced
        // serial line carries keepalives without a miss. The base64 cost is
        // irrelevant on native-USB CDC.
        photoViaWs = connected && !Net::serialConnected();
        photoStartMs = millis();
        photoPhase = PhotoPhase::BEGIN;
        queued = true;
    }
    xSemaphoreGive(photoMutex);
    return queued;
}

bool photoUploadBusy() {
    if (!photoMutex) return false;
    xSemaphoreTake(photoMutex, portMAX_DELAY);
    bool busy = photoPhase != PhotoPhase::IDLE || photoHttpPending;
    xSemaphoreGive(photoMutex);
    return busy;
}

bool queuePhotoHttpUpload(uint8_t* jpeg, size_t len, const char* sessionId,
                          int width, int height) {
    if (!jpeg || len == 0 || !photoMutex) return false;
    if (!Net::wifiConnected()) return false;
    // Endpoint: prefer the address this client actually connected to — a
    // board that just rebooted has a live WS long before g_state carries a
    // bridge endpoint, and the first snap must not silently fall back to the
    // lossy serial path.
    char ip[16] = {0};
    uint16_t port = 0;
    char token[40] = {0};
    if (savedIp[0] && savedPort != 0) {
        strncpy(ip, savedIp, sizeof(ip) - 1);
        port = savedPort;
        strncpy(token, savedToken, sizeof(token) - 1);
    } else {
        lockState();
        strncpy(ip, g_state.bridgeIp, sizeof(ip) - 1); ip[sizeof(ip) - 1] = '\0';
        port = g_state.bridgePort;
        strncpy(token, g_state.authToken, sizeof(token) - 1); token[sizeof(token) - 1] = '\0';
        unlockState();
    }
    if (!ip[0] || port == 0) {
        Serial.println("[Photo] no bridge endpoint for HTTP upload");
        return false;
    }

    bool taken = false;
    xSemaphoreTake(photoMutex, portMAX_DELAY);
    if (photoPhase == PhotoPhase::IDLE && !photoHttpPending) {
        photoBuf = jpeg;
        photoLen = len;
        photoW = width;
        photoH = height;
        strncpy(photoSession, sessionId ? sessionId : "", sizeof(photoSession) - 1);
        photoSession[sizeof(photoSession) - 1] = '\0';
        strncpy(photoHttpIp, ip, sizeof(photoHttpIp) - 1);
        photoHttpPort = port;
        strncpy(photoHttpToken, token, sizeof(photoHttpToken) - 1);
        photoHttpPending = true;
        photoStartMs = millis();
        taken = true;
    }
    xSemaphoreGive(photoMutex);
    return taken;
}

// Perform the pending HTTP upload on the network core. Blocking for the
// duration of the POST — acceptable there (the UI core keeps rendering) and
// far simpler than a chunk/ack state machine.
static void pumpPhotoHttp() {
    if (!photoMutex || !photoHttpPending) return;
    xSemaphoreTake(photoMutex, portMAX_DELAY);
    uint8_t* buf = photoBuf;
    size_t len = photoLen;
    char url[160];
    snprintf(url, sizeof(url),
             "http://%s:%u/esp32/photo?board=t_display_pro&sessionId=%s&w=%d&h=%d&token=%s",
             photoHttpIp, (unsigned)photoHttpPort, photoSession,
             photoW, photoH, photoHttpToken);
    xSemaphoreGive(photoMutex);
    if (!buf || len == 0) { photoHttpPending = false; return; }

    HTTPClient http;
    WiFiClient client;
    int code = -1;
    if (http.begin(client, url)) {
        http.setTimeout(15000);
        http.addHeader("Content-Type", "image/jpeg");
        code = http.POST(buf, len);
        http.end();
    }
    Serial.printf("[Photo] HTTP upload %u bytes -> %d\n", (unsigned)len, code);
    if (code != 200) {
        // The daemon never saw a complete image; say so on the transport it
        // does read, so the board is not left claiming success.
        char diag[120];
        snprintf(diag, sizeof(diag),
                 "{\"type\":\"photo_abort\",\"reason\":\"http_%d\",\"total\":%u}",
                 code, (unsigned)len);
        queueOutbound(diag);
    }
    xSemaphoreTake(photoMutex, portMAX_DELAY);
    free(photoBuf);
    photoBuf = nullptr;
    photoLen = 0;
    photoHttpPending = false;
    xSemaphoreGive(photoMutex);
}

// Drain one slice of the active photo upload on CORE_NETWORK. A few chunks per
// call keeps the WS client serviced (ping/pong) instead of blocking on a full
// blob write.
static void pumpPhoto() {
    if (!photoMutex) return;
    xSemaphoreTake(photoMutex, portMAX_DELAY);
    PhotoPhase phase = photoPhase;
    xSemaphoreGive(photoMutex);
    if (phase == PhotoPhase::IDLE) return;

    // Latched transport died mid-upload → abort and free (the daemon's
    // capture TTL sweeps the half-assembled remainder). The abort reason is
    // reported as a JSON diag frame so it lands in the daemon's log — a board
    // print never leaves the desk, which made the first WS stall (one frame
    // then silence) undiagnosable from the host side.
    bool transportUp = photoViaWs ? connected : Net::serialConnected();
    if ((uint32_t)(millis() - photoStartMs) > PHOTO_UPLOAD_DEADLINE_MS) {
        Serial.println("[Photo] upload deadline exceeded — aborted");
        char diag[120];
        snprintf(diag, sizeof(diag),
                 "{\"type\":\"photo_abort\",\"reason\":\"deadline\","
                 "\"viaWs\":%s,\"sent\":%u,\"total\":%u}",
                 photoViaWs ? "true" : "false",
                 (unsigned)photoOff, (unsigned)photoLen);
        queueOutbound(diag);
        xSemaphoreTake(photoMutex, portMAX_DELAY);
        free(photoBuf);
        photoBuf = nullptr;
        photoPhase = PhotoPhase::IDLE;
        xSemaphoreGive(photoMutex);
        return;
    }
    if (!transportUp) {
        Serial.println("[Photo] transport lost mid-upload — aborted");
        char diag[120];
        snprintf(diag, sizeof(diag),
                 "{\"type\":\"photo_abort\",\"reason\":\"transport_lost\","
                 "\"viaWs\":%s,\"sent\":%u,\"total\":%u}",
                 photoViaWs ? "true" : "false",
                 (unsigned)photoOff, (unsigned)photoLen);
        queueOutbound(diag);
        xSemaphoreTake(photoMutex, portMAX_DELAY);
        free(photoBuf);
        photoBuf = nullptr;
        photoPhase = PhotoPhase::IDLE;
        xSemaphoreGive(photoMutex);
        return;
    }

    if (phase == PhotoPhase::BEGIN) {
        char frame[200];
        // Only the strip defines BOARD_HAS_DVP_CAMERA today; if a second camera
        // board ever lands, lift the board string from the device_info ladder.
        snprintf(frame, sizeof(frame),
                 "{\"type\":\"photo_begin\",\"board\":\"t_display_pro\",\"format\":\"jpeg\","
                 "\"width\":%d,\"height\":%d,\"sessionId\":\"%s\"}",
                 photoW, photoH, photoSession);
        if (photoViaWs) ws.sendTXT(frame);
        else Net::serialWriteJsonLine(frame);
        photoPhase = PhotoPhase::DATA;
        return;
    }

    if (phase == PhotoPhase::DATA) {
        // One chunk per pump on both transports: serial pacing is a power
        // lesson (2.8 KB bursts helped collapse the rail), WS pacing keeps
        // the client library serviced between frames. Send failures do NOT
        // advance the cursor — a lost chunk is a corrupt JPEG.
        static int sendFailures = 0;
        int slices = 1;
        while (slices-- > 0 && photoOff < photoLen) {
            size_t chunk = photoViaWs ? PHOTO_WS_CHUNK : PHOTO_SERIAL_CHUNK;
            size_t n = photoLen - photoOff < chunk ? photoLen - photoOff : chunk;
            if (photoViaWs) {
                if (!ws.sendBIN(photoBuf + photoOff, n)) {
                    if (++sendFailures >= PHOTO_MAX_SEND_FAILURES) {
                        sendFailures = 0;
                        char diag[120];
                        snprintf(diag, sizeof(diag),
                                 "{\"type\":\"photo_abort\",\"reason\":\"ws_send_failed\","
                                 "\"sent\":%u,\"total\":%u}",
                                 (unsigned)photoOff, (unsigned)photoLen);
                        queueOutbound(diag);
                        xSemaphoreTake(photoMutex, portMAX_DELAY);
                        free(photoBuf);
                        photoBuf = nullptr;
                        photoPhase = PhotoPhase::IDLE;
                        xSemaphoreGive(photoMutex);
                    }
                    return;  // retry the same chunk next pump
                }
                sendFailures = 0;
            } else {
                // Serial is line-delimited JSON: base64 the slice, same as
                // audio_chunk. 2048 raw → 2732 b64 + envelope < 3 KB.
                static char line[3072];
                const char* prefix = "{\"type\":\"photo_chunk\",\"d\":\"";
                size_t pfx = strlen(prefix);
                memcpy(line, prefix, pfx);
                size_t wrote = 0;
                if (mbedtls_base64_encode((unsigned char*)line + pfx,
                                          sizeof(line) - pfx - 4, &wrote,
                                          photoBuf + photoOff, n) != 0) {
                    break;  // encode failure — retry next pump
                }
                line[pfx + wrote] = '"';
                line[pfx + wrote + 1] = '}';
                line[pfx + wrote + 2] = '\0';
                Net::serialWriteJsonLine(line);
                // Inter-line breather: the CDC FIFO is shared with inbound
                // daemon broadcasts, and back-to-back photo lines were the
                // remaining hole window after per-block pacing.
                vTaskDelay(pdMS_TO_TICKS(2));
            }
            photoOff += n;
        }
        if (photoOff >= photoLen) photoPhase = PhotoPhase::END;
        return;
    }

    // END: close the capture with the byte count so the daemon can reject a
    // frame-lossy assembly instead of prompting with a corrupt image.
    char frame[96];
    snprintf(frame, sizeof(frame),
             "{\"type\":\"photo_end\",\"bytes\":%u}", (unsigned)photoLen);
    if (photoViaWs) ws.sendTXT(frame);
    else Net::serialWriteJsonLine(frame);
    Serial.printf("[Photo] uploaded %u bytes (%s)\n",
                  (unsigned)photoLen, photoViaWs ? "ws" : "serial");
    xSemaphoreTake(photoMutex, portMAX_DELAY);
    free(photoBuf);
    photoBuf = nullptr;
    photoLen = photoOff = 0;
    photoPhase = PhotoPhase::IDLE;
    xSemaphoreGive(photoMutex);
}
#endif  // BOARD_HAS_DVP_CAMERA

#if !defined(BOARD_T_EMBED)
// Boards without a microphone keep the API but never carry the buffer.
bool queueAudioChunk(const uint8_t*, size_t) { return false; }
bool audioBacklogged() { return false; }
#else
bool queueAudioChunk(const uint8_t* data, size_t len) {
    if (!data || len == 0 || len > AUDIO_SLOT_BYTES || !audioMutex) return false;
    bool queued = false;
    xSemaphoreTake(audioMutex, portMAX_DELAY);
    if (audioCount < AUDIO_SLOTS) {
        int idx = (audioHead + audioCount) % AUDIO_SLOTS;
        memcpy(audioRing[idx], data, len);
        audioLen[idx] = len;
        audioCount++;
        queued = true;
    }
    xSemaphoreGive(audioMutex);
    return queued;
}

bool audioBacklogged() {
    if (!audioMutex) return false;
    xSemaphoreTake(audioMutex, portMAX_DELAY);
    bool any = audioCount > 0;
    xSemaphoreGive(audioMutex);
    return any;
}
#endif  // BOARD_T_EMBED

// Enqueue an outbound JSON command from any task (typically CORE_UI). Dropped if
// the small queue is full — interactive commands are user-paced, not bursty.
void queueOutbound(const char* json) {
    if (!json || !json[0] || !outboxMutex) return;
    xSemaphoreTake(outboxMutex, portMAX_DELAY);
    if (outboxCount < OUTBOX_MAX) {
        int idx = (outboxHead + outboxCount) % OUTBOX_MAX;
        strncpy(outbox[idx], json, OUTBOX_LEN - 1);
        outbox[idx][OUTBOX_LEN - 1] = '\0';
        outboxCount++;
    }
    xSemaphoreGive(outboxMutex);
}

// Drain the outbound queue on CORE_NETWORK. Sends over WS when connected, else
// over the serial bridge. Call once per network-task iteration.
void pumpOutbound() {
    if (!outboxMutex) return;
    while (true) {
        char line[OUTBOX_LEN];
        xSemaphoreTake(outboxMutex, portMAX_DELAY);
        if (outboxCount == 0) { xSemaphoreGive(outboxMutex); break; }
        strncpy(line, outbox[outboxHead], sizeof(line));
        line[sizeof(line) - 1] = '\0';
        outboxHead = (outboxHead + 1) % OUTBOX_MAX;
        outboxCount--;
        xSemaphoreGive(outboxMutex);
        if (connected) ws.sendTXT(line);
        else Net::serialWriteJsonLine(line);  // serial bridge consumes line-delimited JSON
    }

#if defined(BOARD_T_EMBED)
    // Binary audio frames — WS only. Dropped (not buffered) when the socket is
    // down: a voice utterance is worthless late, and holding it would stall
    // the capture task behind a dead link.
    while (audioMutex) {
        uint8_t frame[AUDIO_SLOT_BYTES];
        size_t len = 0;
        xSemaphoreTake(audioMutex, portMAX_DELAY);
        if (audioCount == 0) { xSemaphoreGive(audioMutex); break; }
        len = audioLen[audioHead];
        memcpy(frame, audioRing[audioHead], len);
        audioHead = (audioHead + 1) % AUDIO_SLOTS;
        audioCount--;
        xSemaphoreGive(audioMutex);
        if (len == 0) continue;
        if (connected) {
            ws.sendBIN(frame, len);
#if defined(BOARD_T_EMBED)
        } else if (Net::serialConnected()) {
            // USB-attached: the board's WiFi WS is parked, but the mic must not
            // go dead just because the user plugged in to charge. Serial is
            // line-delimited JSON, so the samples ride base64 — raw PCM would
            // tear the framing for every other reader of this port.
            //
            // Board-guarded because the 3 KB line buffer is DRAM: only the board
            // with a microphone can ever reach this branch, and the no-PSRAM
            // boards have no room to spare for a buffer they cannot use.
            static char line[3072];
            const char* prefix = "{\"type\":\"audio_chunk\",\"d\":\"";
            size_t pfx = strlen(prefix);
            memcpy(line, prefix, pfx);
            size_t wrote = 0;
            if (mbedtls_base64_encode((unsigned char*)line + pfx,
                                      sizeof(line) - pfx - 4, &wrote,
                                      frame, len) == 0) {
                line[pfx + wrote] = '"';
                line[pfx + wrote + 1] = '}';
                line[pfx + wrote + 2] = '\0';
                Net::serialWriteJsonLine(line);
            }
#endif  // BOARD_T_EMBED
        }
    }
#endif  // BOARD_T_EMBED

#if defined(BOARD_HAS_DVP_CAMERA)
    pumpPhotoHttp();
    pumpPhoto();
#endif
}

void wsConnect(const char* ip, uint16_t port, const char* token) {
    if (connected || connecting) {
        return;
    }
    connecting = true;

    // Disconnect any existing attempt before beginning a new one
    ws.disconnect();
    delay(10);

    strncpy(savedIp, ip, sizeof(savedIp) - 1);
    savedPort = port;
    strncpy(savedToken, token, sizeof(savedToken) - 1);

    // Build URL path with token
    char path[104];
    if (token[0] != '\0') {
        snprintf(path, sizeof(path), "/?token=%s&clientType=esp32", token);
    } else {
        strcpy(path, "/?clientType=esp32");
    }

    ws.begin(ip, port, path);
    ws.onEvent(onWsEvent);
    ws.setReconnectInterval(reconnectMs);
    ws.enableHeartbeat(WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS, 2);

    Serial.printf("[WS] Connecting to %s:%d\n", ip, port);
}

void wsDisconnect() {
    ws.disconnect();
    connected = false;
    connecting = false;
}

void wsLoop() {
    if (!WiFi.isConnected()) {
        if (connected || connecting) {
            ws.disconnect();
        }
        connected = false;
        connecting = false;
        return;
    }

    ws.loop();

    // Exponential backoff reconnection. The library's internal reconnect timer
    // is driven by setReconnectInterval(); we must push updated values into it
    // whenever our backoff grows, otherwise it sticks at whatever was set at
    // wsConnect() time.
    if (!connected && savedIp[0] != '\0') {
        uint32_t now = millis();
        if (now - lastReconnectAttempt > reconnectMs) {
            lastReconnectAttempt = now;
            uint32_t next = reconnectMs * 2;
            if (next > WS_RECONNECT_MAX_MS) next = WS_RECONNECT_MAX_MS;
            reconnectMs = next;
            ws.setReconnectInterval(reconnectMs);
        }
    }
}

uint32_t wsLastAttemptMs() {
    return lastReconnectAttempt;
}

uint32_t wsBackoffMs() {
    return reconnectMs;
}

bool wsConnected() {
    return connected;
}

bool wsConnecting() {
    return connecting;
}

void wsSend(const char* json) {
    if (connected) {
        ws.sendTXT(json);
    }
}

void wsSendCommand(const char* type) {
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"type\":\"%s\"}", type);
    wsSend(buf);
}

void wsSendRespond(const char* value) {
    char buf[128];
    snprintf(buf, sizeof(buf), "{\"type\":\"respond\",\"value\":\"%s\"}", value);
    wsSend(buf);
}

void wsSendSelectOption(uint8_t index) {
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"type\":\"select_option\",\"index\":%d}", index);
    wsSend(buf);
}

void wsSendInterrupt() {
    wsSendCommand("interrupt");
}

void wsSendEscape() {
    wsSendCommand("escape");
}

}  // namespace Net
