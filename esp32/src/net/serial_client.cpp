#include "serial_client.h"
#include "protocol.h"
#include "wifi_manager.h"
#include "ws_client.h"
#include "../state/agent_state.h"
#include "../util/ota_capability.h"
#include "../util/reset_reason.h"
#if defined(BOARD_T_EMBED)
#include "../input/power_monitor.h"
#include "../input/ir_receiver.h"
#include "../input/nfc_reader.h"
#include "../audio/mic_capture.h"
#endif
#if defined(BOARD_T_DISPLAY_PRO)
#include "../input/touch_strip.h"
#include "../input/light_sensor.h"
#include "../input/power_monitor.h"
#include "../camera/photo_capture.h"
#endif
#if !defined(BOARD_LED8X32) && !defined(BOARD_INKDECK)
#include "../ui/screens/splash.h"
#endif
#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoJson.h>

// Line buffer for incoming serial JSON. InkDeck gets headroom: a whitelisted
// usage_update is ~1KB but a 10-session enriched sessions_list plus growth
// must never hit the silent "Buffer overflow — discard line" path again
// (an oversized line froze usage gauges on stale values for hours).
#if defined(BOARD_INKDECK)
static constexpr int SERIAL_BUF_SIZE = 8192;
#else
static constexpr int SERIAL_BUF_SIZE = 4096;
#endif
static char serialBuf[SERIAL_BUF_SIZE];
static int serialBufPos = 0;

// Connection tracking: consider "connected" if we got JSON within timeout
static constexpr uint32_t SERIAL_TIMEOUT_MS = 30000;  // USB host updates can be bursty during daemon startup
static uint32_t lastSerialJsonMs = 0;
static bool hasReceivedJson = false;

// Device info sent flag — send once on first serial activity
static bool deviceInfoSent = false;

namespace Net {

// Forward declaration
static void sendHeartbeatAck();

void serialWriteJsonLine(const char* buf) {
#if defined(BOARD_INKDECK) || defined(BOARD_T_DISPLAY_PRO)
    // HWCDC (USB-Serial/JTAG) on this core loses entire 64-byte FIFO blocks
    // when a write spans multiple blocks (measured: deterministic 64-byte
    // holes mid-line, 7/10 corrupt device_info replies). Pace one FIFO block
    // per drain so the newline-framed JSON the daemon parses arrives intact.
    // The T-Display-S3-Pro hits the same silicon path, harder: its 2.8 KB
    // base64 photo_chunk lines still lost ~2 lines per upload at the InkDeck
    // recipe (60 B / 300 µs) while daemon broadcasts streamed inbound — the
    // ack-only-keepalive note below already records that full-duplex raises
    // the drop odds. Sub-FIFO blocks with a longer settle survive it.
#if defined(BOARD_T_DISPLAY_PRO)
    constexpr size_t CHUNK = 48;
    constexpr uint32_t SETTLE_US = 500;
#else
    constexpr size_t CHUNK = 60;
    constexpr uint32_t SETTLE_US = 300;
#endif
    size_t len = strlen(buf);
    for (size_t off = 0; off < len; off += CHUNK) {
        size_t n = (len - off) < CHUNK ? (len - off) : CHUNK;
        Serial.write((const uint8_t*)buf + off, n);
        Serial.flush();
        delayMicroseconds(SETTLE_US);
    }
    Serial.write((const uint8_t*)"\n", 1);
    Serial.flush();
#else
    Serial.println(buf);
#endif
}

static void sendDeviceInfoSerial() {
    JsonDocument resp;
    resp["type"] = "device_info";

    #if defined(BOARD_LED8X32)
    resp["board"] = "ulanzi_tc001";
    #elif defined(BOARD_INKDECK)
    resp["board"] = "inkdeck";
    #elif defined(BOARD_TTGO)
    resp["board"] = "ttgo_t_display";
    #elif defined(BOARD_T_EMBED)
    resp["board"] = "t_embed";
    #elif defined(BOARD_T_DISPLAY_PRO)
    resp["board"] = "t_display_pro";
    #elif defined(BOARD_ESP32_C6_147)
    resp["board"] = "esp32_c6_147";
    #elif IS_ROUND
    resp["board"] = "round_amoled";
    #elif defined(BOARD_BOX_86) || defined(BOARD_86_BOX)
    resp["board"] = "86box";
    #elif defined(BOARD_IPS10)
    resp["board"] = "ips_10";
    #else
    resp["board"] = "ips_35";
    #endif

    resp["version"] = FIRMWARE_VERSION;
    resp["buildHash"] = GIT_SHA;
    resp["buildEpoch"] = (uint32_t)BUILD_EPOCH;
    resp["protocolRevision"] = PROTOCOL_REVISION;
    resp["wifiConfigured"] = wifiConfigured();
    resp["timelineCount"] = g_state.timelineCount;  // debug aid, keep in sync with protocol.cpp copy
    resp["sessionCount"] = g_state.sessionCount;
    resp["usageFiveH"] = (int)g_state.fiveHourPercent;
    {
        uint8_t processing = 0;
        for (uint8_t i = 0; i < g_state.sessionCount; i++)
            if (strcmp(g_state.sessions[i].state, "processing") == 0) processing++;
        resp["processingCount"] = processing;
    }
    resp["wifiConnected"] = wifiConnected();
    resp["wifiRadioParked"] = wifiRadioParked();
    resp["uptimeSec"] = millis() / 1000;
    {
        esp_reset_reason_t resetReason = esp_reset_reason();
        resp["resetReasonCode"] = (int)resetReason;
        resp["resetReason"] = Util::resetReasonName(resetReason);
    }
    if (wifiConnected()) {
        resp["ip"] = wifiLocalIP();
    }
#if defined(BOARD_T_EMBED)
    {
        // Battery telemetry (mirrors protocol.cpp sendDeviceInfo — keep the
        // two device_info ladders in lockstep).
        // Capability advertisement — only what this firmware actually exposes
        // today (grow as ir/subghz land).
        {
            JsonArray caps = resp["capabilities"].to<JsonArray>();
            if (Input::powerStatus().valid) caps.add("battery");
            // Advertise only what actually initialized — a capability the
            // daemon cannot use is worse than an absent one.
            if (Input::nfcReady()) caps.add("nfc");
            if (Audio::micReady()) caps.add("audio");
            if (Input::irReady()) caps.add("ir_rx");
        }
        Input::PowerStatus ps = Input::powerStatus();
        if (ps.valid) {
            resp["batteryPercent"] = ps.soc;
            resp["batteryCharging"] = ps.charging;
            resp["usbPowered"] = ps.usbPowered;
        } else {
            resp["batteryDiag"] = ps.gaugeErr;  // Wire error code — see power_monitor.h
        }
    }
#endif
#if defined(BOARD_T_DISPLAY_PRO)
    {
        // Remote peripheral diag — lets /devices answer "did touch/ALS init?"
        // without stealing the serial port.
        resp["touchReady"] = Input::touchReady();
        resp["touchDownSamples"] = Input::touchDownSamples();
        resp["touchGestures"] = Input::touchGestures();
        resp["touchLastX"] = Input::touchLastX();
        resp["touchLastY"] = Input::touchLastY();
        resp["touchMaxX"] = Input::touchMaxX();
        resp["touchMaxY"] = Input::touchMaxY();
        resp["alsReady"] = Input::lightReady();
        Input::PowerStatus ps = Input::powerStatus();
        // Mirrors protocol.cpp sendDeviceInfo — keep the two ladders in
        // lockstep. Camera advertises only when the shield probed at boot.
        if (ps.valid || Camera::present()) {
            JsonArray caps = resp["capabilities"].to<JsonArray>();
            if (ps.valid) caps.add("battery");
            if (Camera::present()) caps.add("camera");
        }
        if (ps.valid) {
            resp["batteryVoltageMv"] = ps.voltageMv;
            resp["batteryCharging"] = ps.charging;
            resp["usbPowered"] = ps.usbPowered;
        } else {
            resp["batteryDiag"] = ps.gaugeErr;
        }
    }
#endif
    OtaCapability::Info ota = OtaCapability::get();
    resp["otaSupported"] = ota.supported;
    resp["otaSlotCount"] = ota.slotCount;
    resp["otaSlotSize"] = ota.slotSize;
    resp["otaFreeSketchSpace"] = ota.freeSketchSpace;
    if (!ota.supported) resp["otaReason"] = ota.reason;

    // Mirrors protocol.cpp: sized for the fattest board's field set —
    // serializeJson truncates silently on overflow.
    char buf[896];
    serializeJson(resp, buf, sizeof(buf));
    serialWriteJsonLine(buf);
}

void serialInit() {
    // Serial is already initialized in setup() at 115200
    serialBufPos = 0;
    hasReceivedJson = false;
    deviceInfoSent = false;
    Serial.println("[Serial] JSON listener ready");
}

void serialLoop() {
    while (Serial.available()) {
        char c = Serial.read();

        if (c == '\n' || c == '\r') {
            if (serialBufPos > 0) {
                serialBuf[serialBufPos] = '\0';

                // Only parse lines that look like JSON objects
                if (serialBuf[0] == '{') {
                    Protocol::parseMessage(serialBuf, serialBufPos);
                    uint32_t nowMs = millis();
                    lastSerialJsonMs = nowMs;

                    lockState();
                    g_state.lastMessageMs = nowMs;
                    unlockState();

                    if (!hasReceivedJson) {
                        hasReceivedJson = true;
                        Serial.println("[Serial] First JSON received — bridge connected via USB");

                        lockState();
                        g_state.wsConnected = true;  // Reuse connection flag
                        unlockState();
                    }

                    // Send device info on first bridge JSON contact
                    if (!deviceInfoSent) {
                        deviceInfoSent = true;
                        sendDeviceInfoSerial();
                    }

                    // Ack ONLY keepalives — acking every inbound JSON meant the
                    // panel was almost always TRANSMITTING while the daemon's
                    // next line streamed in, and full-duplex TX raises the
                    // HWCDC inbound-drop odds (long sessions_list lines arrived
                    // truncated → IncompleteInput → empty session grid).
                    if (strstr(serialBuf, "\"keepalive\"") != nullptr) {
                        sendHeartbeatAck();
                    }
                }

                serialBufPos = 0;
            }
        } else {
            if (serialBufPos < SERIAL_BUF_SIZE - 1) {
                serialBuf[serialBufPos++] = c;
            } else {
                // Buffer overflow — discard line
                serialBufPos = 0;
            }
        }
    }

    // Detect serial disconnect (no JSON for timeout period)
    if (hasReceivedJson && (millis() - lastSerialJsonMs > SERIAL_TIMEOUT_MS)) {
        hasReceivedJson = false;
        deviceInfoSent = false;  // Re-send device info on reconnect
        Serial.println("[Serial] Bridge timeout — no JSON received");

        lockState();
        if (!Net::wsConnected()) {
            g_state.markBridgeDisconnected();
        }
        unlockState();
    }
}

static void sendHeartbeatAck() {
    JsonDocument resp;
    resp["type"] = "heartbeat_ack";
    resp["uptime"] = millis() / 1000;  // Uptime in seconds

    char buf[128];
    serializeJson(resp, buf, sizeof(buf));
    serialWriteJsonLine(buf);
}

bool serialConnected() {
    return hasReceivedJson && (millis() - lastSerialJsonMs < SERIAL_TIMEOUT_MS);
}

}  // namespace Net
