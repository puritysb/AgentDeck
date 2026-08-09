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
#if defined(BOARD_VOICE_HTTP_UPLOAD)
// Upload-failure banner (cross-core-safe slot post; see hud_bar.h). The
// upload itself is a hand-paced raw socket, not HTTPClient — see
// pumpVoiceHttp for why that matters on this board.
#include "../ui/widgets/hud_bar.h"
#include <esp_heap_caps.h>
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
static constexpr int OUTBOX_LEN = (int)Net::OUTBOUND_MAX_LEN;
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
#if defined(BOARD_HAS_VOICE_CAPTURE)
static constexpr int AUDIO_SLOTS = 6;
static constexpr size_t AUDIO_SLOT_BYTES = 2048;
static uint8_t audioRing[AUDIO_SLOTS][AUDIO_SLOT_BYTES];
static size_t audioLen[AUDIO_SLOTS] = {0};
static int audioHead = 0;
static int audioCount = 0;
static SemaphoreHandle_t audioMutex = nullptr;
#endif

// ── voice utterance HTTP upload (capture task → network core) ──
// One whole utterance per POST, same shape as the photo path below and for the
// same reason: this board's live-streaming transports both lost audio. The
// capture module owns the PSRAM buffer; this holds only a borrowed pointer
// between queueVoiceHttpUpload() and the blocking POST in pumpVoiceHttp().
#if defined(BOARD_VOICE_HTTP_UPLOAD)
static const uint8_t* voiceHttpBuf = nullptr;
static size_t voiceHttpLen = 0;
static char voiceHttpBoard[16] = {0};
static char voiceHttpSession[40] = {0};
static uint32_t voiceHttpRate = 16000;
static uint32_t voiceHttpMs = 0;
static volatile bool voiceHttpPending = false;
static char voiceHttpIp[16] = {0};
static uint16_t voiceHttpPort = 0;
static char voiceHttpToken[40] = {0};
static SemaphoreHandle_t voiceHttpMutex = nullptr;
// Connect-retry + self-heal state. The hosted-C6 STA wedges when the daemon
// restarts under it: the old WebSocket stays half-open and NEW TCP connects
// fail while the STA still reports "connected" (http_-1 at 23:17 and 23:49 on
// 2026-07-30/31, both minutes after a daemon restart; a board reboot was the
// only cure). So a failed connect is retried across pump passes, and after two
// failures the radio is bounced (park→unpark → STA rejoin), which rebuilds the
// hosted data path without rebooting the board. The utterance stays buffered
// in PSRAM the whole time.
static uint8_t voiceHttpAttempts = 0;
static uint32_t voiceHttpFirstTryMs = 0;
static bool voiceHttpRejoinKicked = false;
static constexpr uint32_t VOICE_HTTP_DEADLINE_MS = 30000;

// ── spoken-reply HTTP pull (network core → PSRAM → local playback) ──
// See queueVoiceReplyDownload in ws_client.h for why this replaces WS binary
// streaming on this board. The buffer is PSRAM and reused per reply.
// 4 MB ≈ 131 s of 16 kHz PCM16. The daemon caps spoken replies at 700 chars,
// and a 576-char Korean answer measured 2.65 MB — the original 2 MB cap
// silently refused it and the user heard nothing.
static constexpr size_t REPLY_BUF_MAX = 4 * 1024 * 1024;
static uint8_t* replyBuf = nullptr;
static size_t replyLen = 0;
static uint32_t replyRate = 16000;
static uint32_t replyExpectedBytes = 0;
static volatile bool replyDownloadPending = false;
static volatile bool replyFeeding = false;
// How much of replyBuf the download loop already fed into the playback ring —
// the feed task resumes from here rather than restarting the utterance.
static size_t replyFedOffset = 0;

// Feed the remaining downloaded PCM into the playback ring at the ring's own
// pace. Dedicated task: the network core must not block for the length of an
// utterance, and the LVGL core must never touch blocking audio I/O. Playback
// itself was already started by the download loop (streaming start), so this
// only continues the feed.
static void replyFeedTask(void*) {
    size_t off = replyFedOffset;
    while (off < replyLen) {
        size_t chunk = replyLen - off;
        if (chunk > 2048) chunk = 2048;
        if (Audio::playbackFeed(replyBuf + off, chunk)) {
            off += chunk;
        } else {
            // Ring full (normal steady state) or playback aborted.
            if (!Audio::playbackActive()) break;
            vTaskDelay(pdMS_TO_TICKS(15));
        }
    }
    Audio::playbackEnd();
    Serial.printf("[VoiceReply] fed %u/%u bytes to playback\n",
                  (unsigned)off, (unsigned)replyLen);
    replyFeeding = false;
#if defined(BOARD_IPS10)
    HUD::clearSpeaking();
#endif
    vTaskDelete(nullptr);
}
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
#if defined(BOARD_HAS_VOICE_CAPTURE)
    if (!audioMutex) audioMutex = xSemaphoreCreateMutex();
#endif
#if defined(BOARD_HAS_DVP_CAMERA)
    if (!photoMutex) photoMutex = xSemaphoreCreateMutex();
#endif
#if defined(BOARD_VOICE_HTTP_UPLOAD)
    if (!voiceHttpMutex) voiceHttpMutex = xSemaphoreCreateMutex();
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

#if !defined(BOARD_HAS_VOICE_CAPTURE)
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
#endif  // BOARD_HAS_VOICE_CAPTURE

#if !defined(BOARD_VOICE_HTTP_UPLOAD)
// Boards without the HTTP voice path keep the API but always refuse, which
// routes the capture module down its live-streaming branch.
bool queueVoiceHttpUpload(const uint8_t*, size_t, const char*, const char*,
                          uint32_t, uint32_t) { return false; }
bool voiceUploadBusy() { return false; }
bool queueVoiceReplyDownload(uint32_t, uint32_t) { return false; }
#else
bool queueVoiceReplyDownload(uint32_t expectedBytes, uint32_t sampleRate) {
    if (expectedBytes == 0 || expectedBytes > REPLY_BUF_MAX) return false;
    if (!Net::wifiConnected()) return false;
    if (replyDownloadPending) return false;   // mid-transfer — let it finish
    if (replyFeeding) {
        // A newer answer preempts the one still playing: the user asked a new
        // question and the old audio is now just in the way. playbackStop()
        // makes the feed task exit; give it a moment, then proceed.
        Audio::playbackStop();
        for (int i = 0; i < 40 && replyFeeding; i++) vTaskDelay(pdMS_TO_TICKS(10));
        if (replyFeeding) return false;
    }
    if (!replyBuf) {
        replyBuf = (uint8_t*)heap_caps_malloc(REPLY_BUF_MAX, MALLOC_CAP_SPIRAM);
        if (!replyBuf) {
            Serial.println("[VoiceReply] PSRAM buffer alloc failed");
            return false;
        }
    }
    replyExpectedBytes = expectedBytes;
    replyRate = (sampleRate >= 8000 && sampleRate <= 48000) ? sampleRate : 16000;
    replyDownloadPending = true;
    return true;
}

// Download the staged reply on the network core. Paced small reads: TCP flow
// control means the daemon can only send what this loop consumes, which is
// the whole point — the hosted RX path never sees an unpaced burst.
static void pumpVoiceReplyDownload() {
    if (!replyDownloadPending) return;
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
    if (!ip[0] || port == 0) { replyDownloadPending = false; return; }

    WiFiClient client;
    bool ok = false;
    if (client.connect(ip, port, 3000)) {
        char hdr[240];
        int hlen = snprintf(hdr, sizeof(hdr),
                 "GET /esp32/voice-reply?board=ips_10&token=%s HTTP/1.1\r\n"
                 "Host: %s:%u\r\nConnection: close\r\n\r\n",
                 token, ip, (unsigned)port);
        client.write((const uint8_t*)hdr, (size_t)hlen);
        // Skip the response headers: read up to the blank line, byte-wise —
        // slow but the header is ~150 bytes and this runs once per reply.
        uint32_t hdrStart = millis();
        int state = 0;   // counts the \r\n\r\n sequence
        bool status200 = false;
        char line[96]; size_t li = 0;
        while (state < 4 && client.connected() && (uint32_t)(millis() - hdrStart) < 8000) {
            int c = client.read();
            if (c < 0) { vTaskDelay(pdMS_TO_TICKS(5)); continue; }
            if (li < sizeof(line) - 1 && c != '\r' && c != '\n') line[li++] = (char)c;
            if (c == '\n' || c == '\r') {
                if (li > 0) {
                    line[li] = '\0';
                    if (strncmp(line, "HTTP/1.1 200", 12) == 0) status200 = true;
                    li = 0;
                }
            }
            state = (c == '\r' && (state == 0 || state == 2)) ? state + 1
                  : (c == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
        }
        if (status200 && state == 4) {
            size_t off = 0;
            size_t fed = 0;
            bool playbackStarted = false;
            uint32_t lastDataMs = millis();
            while (off < replyExpectedBytes &&
                   (uint32_t)(millis() - lastDataMs) < 8000) {
                size_t want = replyExpectedBytes - off;
                if (want > 2048) want = 2048;
                int got = client.read(replyBuf + off, want);
                if (got > 0) {
                    off += (size_t)got;
                    lastDataMs = millis();
                } else if (!client.connected()) {
                    break;
                } else {
                    vTaskDelay(pdMS_TO_TICKS(5));
                }
                // Streaming start: begin playback as soon as one second of
                // audio is down and keep feeding while downloading. The
                // download outruns playback ~25:1, so waiting for the whole
                // body just added N seconds of silence — a 2 MB answer took
                // 15+ s to make its first sound, which read as "no playback".
                if (!playbackStarted && off >= 32000) {
                    Audio::playbackBegin(replyRate);
                    playbackStarted = true;
                }
                if (playbackStarted && fed < off) {
                    size_t chunk = off - fed;
                    if (chunk > 2048) chunk = 2048;
                    if (Audio::playbackFeed(replyBuf + fed, chunk)) fed += chunk;
                }
            }
            replyLen = off;
            replyFedOffset = fed;
            ok = (off == replyExpectedBytes);
            if (ok && !playbackStarted) {
                // Short reply — never crossed the streaming threshold.
                Audio::playbackBegin(replyRate);
            }
        }
        client.stop();
    }
    replyDownloadPending = false;
    Serial.printf("[VoiceReply] download %s (%u/%u bytes, %u fed inline)\n",
                  ok ? "complete" : "FAILED",
                  (unsigned)replyLen, (unsigned)replyExpectedBytes,
                  (unsigned)replyFedOffset);
    if (ok && replyLen > 0) {
        replyFeeding = true;
        if (xTaskCreate(replyFeedTask, "reply_feed", 4096, nullptr, 2, nullptr) != pdPASS) {
            replyFeeding = false;
#if defined(BOARD_IPS10)
            HUD::notify("Reply playback task failed");
#endif
        }
    } else {
        // A streaming start may have partial audio in flight — cut it rather
        // than let it starve out over 8 s.
        Audio::playbackStop();
#if defined(BOARD_IPS10)
        HUD::notify("Reply download failed");
        HUD::clearSpeaking();
#endif
    }
}
#endif  // !BOARD_VOICE_HTTP_UPLOAD (stubs) / implementation

#if defined(BOARD_VOICE_HTTP_UPLOAD)
bool queueVoiceHttpUpload(const uint8_t* pcm, size_t len, const char* board,
                          const char* sessionId, uint32_t sampleRate,
                          uint32_t durationMs) {
    if (!pcm || len == 0 || !voiceHttpMutex) return false;
    if (!Net::wifiConnected()) return false;
    // Endpoint: prefer the address this client actually connected to — same
    // rationale as the photo path (a fresh boot has a live WS before g_state
    // carries a bridge endpoint).
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
        Serial.println("[Voice] no bridge endpoint for HTTP upload");
        return false;
    }

    bool taken = false;
    xSemaphoreTake(voiceHttpMutex, portMAX_DELAY);
    if (!voiceHttpPending) {
        voiceHttpBuf = pcm;
        voiceHttpLen = len;
        strncpy(voiceHttpBoard, board ? board : "esp32", sizeof(voiceHttpBoard) - 1);
        voiceHttpBoard[sizeof(voiceHttpBoard) - 1] = '\0';
        strncpy(voiceHttpSession, sessionId ? sessionId : "", sizeof(voiceHttpSession) - 1);
        voiceHttpSession[sizeof(voiceHttpSession) - 1] = '\0';
        voiceHttpRate = sampleRate;
        voiceHttpMs = durationMs;
        strncpy(voiceHttpIp, ip, sizeof(voiceHttpIp) - 1);
        voiceHttpPort = port;
        strncpy(voiceHttpToken, token, sizeof(voiceHttpToken) - 1);
        voiceHttpAttempts = 0;
        voiceHttpFirstTryMs = 0;
        voiceHttpRejoinKicked = false;
        voiceHttpPending = true;
        taken = true;
    }
    xSemaphoreGive(voiceHttpMutex);
    return taken;
}

bool voiceUploadBusy() { return voiceHttpPending; }

// Perform the pending POST on the network core. Blocking for the duration —
// same trade as the photo path: the UI core keeps rendering, and a state
// machine buys nothing for a body this small (≤960 KB, typically ~100-200 KB).
//
// Hand-rolled rather than HTTPClient, and that is load-bearing: HTTPClient's
// POST hands the whole body to one WiFiClient::write(), and on the P4 the
// resulting segment burst exhausted ESP-Hosted's TX buffer pool — the hosted
// glue ASSERTS instead of returning an error (`transport_drv_sta_tx
// (copy_buff)`) and reboots the board. Measured on the very first real
// utterance, 2026-07-31. Writing ≤1 KB per iteration with a small yield keeps
// only a couple of TCP segments outstanding, which the SDIO link drains
// comfortably; ~1 KB / 4 ms ≈ 250 KB/s still uploads a 6 s utterance in
// under a second.
static void pumpVoiceHttp() {
    if (!voiceHttpMutex || !voiceHttpPending) return;
    xSemaphoreTake(voiceHttpMutex, portMAX_DELAY);
    const uint8_t* buf = voiceHttpBuf;
    size_t len = voiceHttpLen;
    char ip[16];
    uint16_t port = voiceHttpPort;
    char path[220];
    strncpy(ip, voiceHttpIp, sizeof(ip) - 1); ip[sizeof(ip) - 1] = '\0';
    snprintf(path, sizeof(path),
             "/esp32/voice?board=%s&sessionId=%s&rate=%lu&ms=%lu&token=%s",
             voiceHttpBoard, voiceHttpSession,
             (unsigned long)voiceHttpRate, (unsigned long)voiceHttpMs, voiceHttpToken);
    xSemaphoreGive(voiceHttpMutex);
    if (!buf || len == 0) { voiceHttpPending = false; return; }

    // Multi-pass retry with a radio bounce: one pump pass makes ONE quick
    // connect attempt (3 s cap) so the network core keeps servicing serial/WS
    // between tries; the utterance stays latched in PSRAM until the deadline.
    uint32_t now = millis();
    if (voiceHttpFirstTryMs == 0) voiceHttpFirstTryMs = now;
    if ((uint32_t)(now - voiceHttpFirstTryMs) > VOICE_HTTP_DEADLINE_MS) {
        Serial.println("[Voice] upload deadline exceeded — giving up");
        HUD::notify("Voice upload failed - network wedged");
        char diag[120];
        snprintf(diag, sizeof(diag),
                 "{\"type\":\"voice_abort\",\"reason\":\"deadline_%u_tries\",\"total\":%u}",
                 (unsigned)voiceHttpAttempts, (unsigned)len);
        queueOutbound(diag);
        xSemaphoreTake(voiceHttpMutex, portMAX_DELAY);
        voiceHttpBuf = nullptr;
        voiceHttpLen = 0;
        voiceHttpPending = false;
        xSemaphoreGive(voiceHttpMutex);
        return;
    }
    if (!Net::wifiConnected()) return;   // rejoin in progress — try next pass

    // The hosted transport allocates its TX copies from internal heap and
    // aborts the whole board when that fails. Better to refuse one utterance
    // than to reboot mid-shift.
    size_t freeInternal = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    Serial.printf("[Voice] HTTP upload attempt %u: %u bytes, internal heap %u KB\n",
                  (unsigned)(voiceHttpAttempts + 1), (unsigned)len,
                  (unsigned)(freeInternal / 1024));
    int code = -1;
    if (freeInternal < 60 * 1024) {
        Serial.println("[Voice] internal heap too low for WiFi TX — refusing upload");
        code = -3;
    } else {
        WiFiClient client;
        if (client.connect(ip, port, 3000)) {
            char hdr[360];
            int hlen = snprintf(hdr, sizeof(hdr),
                     "POST %s HTTP/1.1\r\nHost: %s:%u\r\n"
                     "Content-Type: application/octet-stream\r\n"
                     "Content-Length: %u\r\nConnection: close\r\n\r\n",
                     path, ip, (unsigned)port, (unsigned)len);
            client.write((const uint8_t*)hdr, (size_t)hlen);
            size_t off = 0;
            uint32_t startMs = millis();
            while (off < len && client.connected() &&
                   (uint32_t)(millis() - startMs) < 20000) {
                size_t chunk = len - off;
                if (chunk > 1024) chunk = 1024;
                size_t wrote = client.write(buf + off, chunk);
                if (wrote == 0) { vTaskDelay(pdMS_TO_TICKS(20)); continue; }
                off += wrote;
                vTaskDelay(pdMS_TO_TICKS(4));   // pace the hosted SDIO TX path
            }
            if (off == len) {
                // "HTTP/1.1 200 OK" — enough of the status line to judge.
                char status[16] = {0};
                size_t got = 0;
                uint32_t waitMs = millis();
                while (got < sizeof(status) - 1 &&
                       (uint32_t)(millis() - waitMs) < 15000 && client.connected()) {
                    int avail = client.available();
                    if (avail <= 0) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
                    int r = client.read((uint8_t*)status + got, sizeof(status) - 1 - got);
                    if (r > 0) got += (size_t)r;
                }
                if (got >= 12 && strncmp(status, "HTTP/1.1 ", 9) == 0) {
                    code = atoi(status + 9);
                }
            } else {
                code = -2;   // body send stalled/aborted
            }
            client.stop();
        } else {
            // Connect refused/timed out — the wedge signature. Keep the
            // utterance and retry next pass; after two failures bounce the
            // radio so the hosted STA rebuilds its data path.
            voiceHttpAttempts++;
            Serial.printf("[Voice] connect failed (attempt %u)\n", (unsigned)voiceHttpAttempts);
            if (voiceHttpAttempts >= 2 && !voiceHttpRejoinKicked) {
                voiceHttpRejoinKicked = true;
                Serial.println("[Voice] bouncing STA to un-wedge hosted link");
                HUD::notify("Network wedged - rejoining WiFi...");
                Net::wifiSetRadioParked(true);
                Net::wifiSetRadioParked(false);
            }
            vTaskDelay(pdMS_TO_TICKS(200));
            return;   // still pending; deadline above bounds the whole affair
        }
    }
    Serial.printf("[Voice] HTTP upload %u bytes -> %d (attempt %u)\n",
                  (unsigned)len, code, (unsigned)(voiceHttpAttempts + 1));
    if (code != 200) {
        // The daemon never got the utterance, so no voice_result is coming —
        // report locally AND on the transport the daemon does read.
        char note[64];
        snprintf(note, sizeof(note), "Voice upload failed (http %d)", code);
        HUD::notify(note);
        char diag[120];
        snprintf(diag, sizeof(diag),
                 "{\"type\":\"voice_abort\",\"reason\":\"http_%d\",\"total\":%u}",
                 code, (unsigned)len);
        queueOutbound(diag);
    }
    xSemaphoreTake(voiceHttpMutex, portMAX_DELAY);
    voiceHttpBuf = nullptr;
    voiceHttpLen = 0;
    voiceHttpPending = false;
    xSemaphoreGive(voiceHttpMutex);
}
#endif  // BOARD_VOICE_HTTP_UPLOAD

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

#if defined(BOARD_HAS_VOICE_CAPTURE)
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
#if defined(BOARD_HAS_VOICE_CAPTURE)
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
#endif  // BOARD_HAS_VOICE_CAPTURE
        }
    }
#endif  // BOARD_HAS_VOICE_CAPTURE

#if defined(BOARD_HAS_DVP_CAMERA)
    pumpPhotoHttp();
    pumpPhoto();
#endif
#if defined(BOARD_VOICE_HTTP_UPLOAD)
    pumpVoiceHttp();
    pumpVoiceReplyDownload();
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

    // Build URL path with token.
    //
    // `board` rides along so a board the daemon REFUSES can still say what it
    // is. device_info only arrives after a socket is accepted, so a board with a
    // stale credential is anonymous in the one situation where knowing which
    // board it is, is the whole diagnosis — an untagged 4001 loop cost a day of
    // cross-referencing ARP against the WiFi registry. Sized for the longest
    // board name plus a 32-char token with room to spare; snprintf in both
    // branches so it stays that way.
    char path[128];
    if (token[0] != '\0') {
        snprintf(path, sizeof(path), "/?token=%s&clientType=esp32&board=%s", token, agentdeckBoardName());
    } else {
        snprintf(path, sizeof(path), "/?clientType=esp32&board=%s", agentdeckBoardName());
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
