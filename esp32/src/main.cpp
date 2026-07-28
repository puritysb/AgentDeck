/**
 * AgentDeck ESP32 Display Client
 *
 * FreeRTOS dual-core architecture:
 *   Core 0: WiFi + mDNS + WebSocket (network task)
 *   Core 1: UI rendering (LVGL or LED matrix)
 *
 * LVGL boards (ESP32-S3): Splash → Aquarium ↔ Timeline, Settings
 * TC001 (ESP32 classic): 8x32 WS2812B LED matrix, page-based UI
 */

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include "config.h"
#include "../boards/board_config.h"
#include "util/memory.h"
#include "state/agent_state.h"
#include "net/serial_client.h"
#include "net/wifi_manager.h"
#include "net/mdns_discovery.h"
#include "net/ws_client.h"

#ifdef BOARD_LED8X32
#include "ui/matrix/matrix_display.h"
#elif defined(BOARD_INKDECK)
#include "ui/eink/eink_display.h"
#elif defined(BOARD_T_EMBED)
#include "ui/display.h"
#include "ui/knob/knob_ui.h"
#include "ui/knob/ring_leds.h"
#include "ui/knob/chime.h"
#include "audio/speaker_playback.h"
#include "input/encoder.h"
#include "input/power_monitor.h"
#include "input/nfc_reader.h"
#include "input/ir_receiver.h"
#include "audio/mic_capture.h"
#elif defined(BOARD_T_DISPLAY_PRO)
#include "ui/display.h"
#include "ui/ticker/ticker_ui.h"
#include "ui/pocket/pocket_ui.h"
#include "input/light_sensor.h"
#include "input/power_monitor.h"
#include "input/touch_strip.h"
#include "camera/photo_capture.h"
#else
#include "ui/display.h"
#include "ui/screens/splash.h"
#include "ui/screens/aquarium.h"
#include "ui/screens/settings.h"
#include "ui/screens/permission.h"
#endif

// ===== Global state =====
DashboardState g_state;
SemaphoreHandle_t g_stateMutex = nullptr;

#if !defined(BOARD_LED8X32) && !defined(BOARD_INKDECK) && !defined(BOARD_T_EMBED) && !defined(BOARD_T_DISPLAY_PRO)
// ===== Screen objects (LVGL boards only) =====
static lv_obj_t* scrSplash = nullptr;
static lv_obj_t* scrAquarium = nullptr;
static lv_obj_t* scrSettings = nullptr;

static enum {
    VIEW_SPLASH,
    VIEW_AQUARIUM,
    VIEW_SETTINGS
} currentView = VIEW_SPLASH;
#endif

#if defined(IPS10_PERF_HUD)
// Perf overlay shared state (worst frame over the last window + current frame), read by the topbar.
volatile uint32_t g_perfWorstUs = 0, g_perfWorstView = 0, g_perfWorstFlush = 0, g_perfWorstInner = 0;
#endif

// ===== Network task (Core 0) =====
static void networkTask(void* param) {
    Serial.printf("[Net] Task started on core %d\n", xPortGetCoreID());

    // 1. Serial JSON listener (always active — USB is always connected)
    Net::serialInit();

    // 2. Connect WiFi (non-blocking attempt)
    Net::wifiInit();

    // 3. Start mDNS discovery
    Net::mdnsInit();

    // 4. Init WebSocket
    Net::wsInit();

    Net::BridgeInfo bridge;
    char currentBridgeIp[16] = {0};  // IP we're currently trying to connect to
    uint16_t currentBridgePort = 0;
    uint32_t lastMdnsRefreshMs = 0;

#if defined(BOARD_T_DISPLAY_PRO)
    // Brownout ladder, stage 3 (stages 1-2 live in wifiInit/handleWifiProvision):
    // after a brownout reset, do not auto-join at all this boot — retrying is
    // what turned one dip into a self-sustaining reboot loop. A later explicit
    // wifi_provision over serial still works.
    const bool wifiJoinSuppressed = (esp_reset_reason() == ESP_RST_BROWNOUT);
    if (wifiJoinSuppressed) {
        Serial.println("[WiFi] Brownout reset — WiFi auto-join disabled this boot");
    }
    uint32_t lastDeferredJoinMs = 0;
#endif

#if defined(BOARD_IPS10)
    if (Net::wifiConnected()) {
        char savedBridgeIp[16] = {0};
        char savedToken[40] = {0};
        uint16_t savedBridgePort = 0;
        if (Net::wifiLoadProvisionedBridge(savedBridgeIp, sizeof(savedBridgeIp),
                                           &savedBridgePort, savedToken, sizeof(savedToken))) {
            Serial.printf("[Net] IPS10 saved bridge endpoint: %s:%d\n",
                          savedBridgeIp, savedBridgePort);
            strncpy(currentBridgeIp, savedBridgeIp, sizeof(currentBridgeIp) - 1);
            currentBridgePort = savedBridgePort;
            lockState();
            strncpy(g_state.bridgeIp, savedBridgeIp, sizeof(g_state.bridgeIp) - 1);
            g_state.bridgePort = savedBridgePort;
            strncpy(g_state.authToken, savedToken, sizeof(g_state.authToken) - 1);
            unlockState();
            Net::wsConnect(savedBridgeIp, savedBridgePort, savedToken);
        }
    }
#endif

    while (true) {
        // === Always poll serial (USB JSON from bridge) ===
        Net::serialLoop();

        // === WiFi portal (non-blocking, processes captive portal if active) ===
        Net::wifiLoop();

#if defined(BOARD_T_DISPLAY_PRO)
        // Deferred WiFi join — wifiInit left the radio off (joining during
        // boot bring-up browned out the camera unit; an idle-time join on the
        // same supply succeeds). After the 25 s grace the board goes dual-home
        // like the rest of the fleet: serial stays the primary state
        // transport, and the WS socket carries what HWCDC cannot — photo
        // blobs (64-byte FIFO holes tore ~half the base64 chunk lines) and
        // WiFi OTA.
        {
            uint32_t nowDj = millis();
            if (!wifiJoinSuppressed && nowDj > 25000 && !Net::wifiConnected() &&
                (lastDeferredJoinMs == 0 || (uint32_t)(nowDj - lastDeferredJoinMs) > 60000)) {
                lastDeferredJoinMs = nowDj;
                Net::wifiTryDeferredJoin();
            }
        }
#endif

#if defined(BOARD_IPS10)
        // On IPS10, stop C6 network traffic as soon as USB serial is active.
        // wifiSetRadioParked() deliberately keeps ESP-Hosted/SDIO initialized
        // on this board and only disassociates STA: a full WIFI_OFF teardown can
        // race an in-flight RX packet and assert inside the hosted SDIO driver.
        {
            bool serialPrimary = Net::serialConnected();
            bool radioParked = Net::wifiRadioParked();
            if (serialPrimary && !radioParked) {
                if (Net::wsConnected() || Net::wsConnecting()) Net::wsDisconnect();
                Net::wifiSetRadioParked(true);
                Serial.println("[WiFi] IPS10 STA quiesced - USB serial primary");
            } else if (!serialPrimary && radioParked) {
                Net::wifiSetRadioParked(false);
                Serial.println("[WiFi] IPS10 STA restored - serial inactive");
            }
        }
#endif

        // === Continuous mDNS discovery ===
        // Only perform mDNS polling if we are NOT connected. 
        // Constant mDNS querying while connected consumes CPU, Wi-Fi bandwidth,
        // and induces severe packet jitter/latency spikes on ESP32, leading to disconnects.
        // Keep WS available even when USB serial is attached. Serial remains
        // the primary state transport, but WiFi OTA needs an addressable WS
        // socket while boards are still on the bench.
        if (!Net::wifiRadioParked() && Net::wifiConnected() && !Net::wsConnected() && !Net::wsConnecting() && Net::mdnsPoll(bridge)) {
            bool ipChanged = (strcmp(currentBridgeIp, bridge.ip) != 0) || (currentBridgePort != bridge.port);
            if (ipChanged || !Net::wsConnected()) {
                if (ipChanged) {
                    Serial.printf("[Net] Bridge (re)discovered via mDNS: %s:%d\n", bridge.ip, bridge.port);
                    strncpy(currentBridgeIp, bridge.ip, sizeof(currentBridgeIp) - 1);
                    currentBridgePort = bridge.port;
                    // Self-heal the persisted endpoint: 67934f94 saved the bridge
                    // IP to NVS but never refreshed it, so a board whose daemon
                    // moved (DHCP drift, host IP change) reloads the STALE saved
                    // IP on every reboot and loops on "connection reset by peer".
                    // Persisting the freshly-discovered endpoint here lets the
                    // board recover across reboots. No-op on non-IPS10 boards.
                    Net::wifiSaveProvisionedBridge(bridge.ip, bridge.port, bridge.token);
                    // New endpoint: tear down old WS so wsConnect rebinds cleanly
                    if (Net::wsConnected()) Net::wsDisconnect();
                }
                lockState();
                strncpy(g_state.bridgeIp, bridge.ip, sizeof(g_state.bridgeIp) - 1);
                g_state.bridgePort = bridge.port;
                strncpy(g_state.authToken, bridge.token, sizeof(g_state.authToken) - 1);
                unlockState();

                static uint32_t lastConnectTimeMs = 0;
                uint32_t now = millis();
                if (!Net::wsConnecting() && (ipChanged || (now - lastConnectTimeMs > 10000))) {
                    lastConnectTimeMs = now;
                    Net::wsConnect(bridge.ip, bridge.port, bridge.token);
                }
            }
        }

        // === Long-disconnect recovery: kick mDNS cache when WS has been
        //     stuck at max backoff for >15s. This handles the case where the
        //     cached bridge IP is gone (daemon moved, mDNS advertiser is
        //     stale) and we need a fresh query to find the new endpoint. ===
        if (!Net::wifiRadioParked() && !Net::wsConnected() && Net::wifiConnected()) {
            uint32_t now = millis();
            uint32_t sinceLastAttempt = now - Net::wsLastAttemptMs();
            bool saturated = (Net::wsBackoffMs() >= WS_RECONNECT_MAX_MS);
            if (saturated && sinceLastAttempt > 15000 && (now - lastMdnsRefreshMs) > 20000) {
                Serial.println("[Net] Long disconnect — forcing mDNS refresh");
                Net::mdnsRefresh();
                lastMdnsRefreshMs = now;
            }
        }

        // Process WebSocket events
        if (!Net::wifiRadioParked()) {
            Net::wsLoop();
        }

        // Drain UI-queued outbound commands (approve/deny, option select) on this
        // network core — UI callbacks must not touch the WS client directly.
        Net::pumpOutbound();

        // Update combined connection status (serial OR wifi)
        bool conn = Net::serialConnected() || Net::wsConnected();
        lockState();
        g_state.wsConnected = conn;
        unlockState();

#if defined(BOARD_LED8X32)
        // TC001 display-noise mitigation (UNCHANGED — deliberately excluded from
        // the serial-primary radio parking below). WiFi interrupts starve
        // FastLED's RMT refill ISR and corrupt the WS2812 bitstream (random
        // bright/garbage pixels): the classic ESP32 has no RMT DMA and IDF5
        // dropped FastLED's anti-flicker builtin driver, so the RMT path is
        // ISR-bound. TC001 therefore keeps its WiFi radio on while connected and
        // only parks once WiFi is already down.
        {
            static bool radioParked = false;
            static uint32_t serialStableSince = 0;
            uint32_t nowMs = millis();
            bool shouldPark = Net::serialConnected() && !Net::wifiConnected();
            if (shouldPark) {
                if (serialStableSince == 0) serialStableSince = nowMs;
                if (!radioParked && (nowMs - serialStableSince) > 4000) {
                    Net::wifiSetRadioParked(true);
                    radioParked = true;
                    Serial.println("[WiFi] TC001 radio parked — WiFi down, serial transport");
                }
            } else {
                serialStableSince = 0;
                if (radioParked) {
                    Net::wifiSetRadioParked(false);
                    radioParked = false;
                    Serial.println("[WiFi] TC001 radio restored — serial dropped");
                }
            }
        }
#elif !defined(BOARD_IPS10)
        // Serial-primary WiFi radio parking (TTGO, InkDeck, and every other board
        // except TC001/LED8X32 above and IPS10 which parks via its own block).
        // When the daemon is actively driving this board over USB serial, serial
        // IS the transport and the 2.4GHz radio is dead weight:
        //   • A serial-connected board is flashed over serial, so it never needs
        //     WiFi OTA. WiFi-only boards keep serialConnected()==false, are never
        //     parked here, and their WiFi/OTA path is untouched.
        //   • Leaving the radio on only burns shared 2.4GHz airtime and worsens
        //     packet loss for the WiFi-only boards (86box/round_amoled) that
        //     depend on that band.
        // Park after serial has been stable a few seconds (debounce transient
        // JSON), and restore immediately when serial drops so WiFi + its OTA path
        // recover fast.
        {
            static bool radioParked = false;
            static uint32_t serialStableSince = 0;
            uint32_t nowMs = millis();
            bool shouldPark = Net::serialConnected();
            if (shouldPark) {
                if (serialStableSince == 0) serialStableSince = nowMs;
                if (!radioParked && (nowMs - serialStableSince) > 4000) {
                    if (Net::wsConnected() || Net::wsConnecting()) Net::wsDisconnect();
                    Net::wifiSetRadioParked(true);
                    radioParked = true;
                    Serial.println("[WiFi] radio parked — USB serial primary (freeing 2.4GHz airtime)");
                }
            } else {
                serialStableSince = 0;
                if (radioParked) {
                    Net::wifiSetRadioParked(false);
                    radioParked = false;
                    Serial.println("[WiFi] radio restored — serial dropped");
                }
            }
        }
#endif

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

#if defined(BOARD_T_DISPLAY_PRO)
// ===== UI task — Focus Strip (Core 1) =====
// 480x222 always-on strip: touch tabs/actions + 3 app-readable buttons,
// LTR-553 auto-dim composed with the host display-sleep contract.
static void tickerApplyBrightness(uint32_t now) {
    static int lastApplied = -1;
    int lux = Input::lightPollLux(now);
    int base = 255;
    if (lux >= 0) base = lux < 5 ? 60 : lux < 50 ? 140 : 255;

    lockState();
    bool hostOn = g_state.hostDisplayOn;
    bool dimEnabled = g_state.hostDimEnabled;
    uint8_t dimMode = g_state.hostDimMode;
    uint8_t dimLevel = g_state.hostDimLevel;
    unlockState();

    int target = base;
    if (!hostOn && dimEnabled) {
        target = (dimMode == 0) ? 0 : (dimLevel < base ? dimLevel : base);
    }
    if (target != lastApplied) {
        lastApplied = target;
        UI::setBrightness(target);
    }
}

static void uiTask(void* param) {
    Serial.printf("[UI] Ticker task started on core %d\n", xPortGetCoreID());

    // The camera probe decides the unit's role BEFORE the display comes up:
    // a shield present means this is the handheld Pocket unit (portrait
    // phone UI); absent means the desk-mounted landscape Focus Strip. The
    // probe manages Wire itself and deinits straight after (power fence).
    bool pocket = Camera::init();
    if (pocket) UI::requestPortrait();
    UI::displayInit();
    Input::lightInit();
    Input::touchInit();
    Input::powerInit();
    if (pocket) {
        Input::touchSetPortrait(true);  // LVGL indev consumes raw points
        Pocket::create();
    } else {
        Ticker::create();
    }

    pinMode(BOARD_PIN_BTN1, INPUT_PULLUP);
    pinMode(BOARD_PIN_BTN2, INPUT_PULLUP);
    pinMode(BOARD_PIN_BTN3, INPUT_PULLUP);
    bool btnPrev[3] = {true, true, true};
    uint32_t btnLastMs[3] = {0, 0, 0};
    const int btnPins[3] = {BOARD_PIN_BTN1, BOARD_PIN_BTN2, BOARD_PIN_BTN3};

    Serial.println("[UI] Ticker screen created, entering main loop");

    uint32_t lastFrameMs = millis();
    while (true) {
        uint32_t now = millis();
        uint32_t dt_ms = now - lastFrameMs;
        float dt = dt_ms / 1000.0f;
        lastFrameMs = now;
        if (dt > 0.1f) dt = 0.1f;
        if (dt_ms > 0) lv_tick_inc(dt_ms);

        // Four physical controls: RST is hard recovery; the three app-readable
        // inputs are BOOT (focus/select | camera/shutter) and the split rocker
        // (previous/next).
        for (int b = 0; b < 3; b++) {
            bool down = (digitalRead(btnPins[b]) == LOW);
            if (down && btnPrev[b] && (uint32_t)(now - btnLastMs[b]) > 220) {
                btnLastMs[b] = now;
                if (pocket) {
                    if (b == 0) Pocket::primaryAction();
                    else if (b == 1) Pocket::prevTab();
                    else Pocket::nextTab();
                } else {
                    Ticker::buttonFeedback((uint8_t)b);
                    if (b == 0) Ticker::primaryAction();
                    else if (b == 1) Ticker::prevPage();
                    else Ticker::nextPage();
                }
            }
            btnPrev[b] = !down;
        }

        lockState();
        g_state.applyPendingSessionClear(now);
        unlockState();

        if (!pocket) {
            // Landscape only: the gesture layer is the sole touch consumer
            // there. Pocket mode reads touch through the LVGL indev instead —
            // two pollers would fight over the controller's press state.
            Input::TouchEvent touch = Input::touchPoll(now);
            if (touch.gesture != Input::TouchGesture::NONE) Ticker::onTouch(touch);
        }

        Input::powerPoll(now);
        tickerApplyBrightness(now);
        if (pocket) Pocket::update(dt);
        else Ticker::update(dt);
        lv_timer_handler();

        {
            static uint32_t lastHeapLogMs = 0;
            if ((uint32_t)(now - lastHeapLogMs) >= 60000) {
                lastHeapLogMs = now;
                logHeap("focus-strip");
            }
        }

        uint32_t work = millis() - now;
        vTaskDelay(pdMS_TO_TICKS(work < RENDER_INTERVAL_MS ? (RENDER_INTERVAL_MS - work) : 1));
    }
}
#elif defined(BOARD_T_EMBED)
// ===== UI task — Companion Knob (Core 1) =====
// Encoder-driven two-level steering UI + WS2812 session ring. No touch, no
// terrarium — the knob render tree (ui/knob/) is the whole surface.

// Millis of the last physical interaction (encoder detent or key). Drives the
// battery pager's local idle policy.
static uint32_t s_lastInputMs = 0;

// Power/wake policy, two regimes:
//  - USB-powered (docked): follow the host display-sleep contract (off must be
//    dark, min must stay visible) — panel AND ring go dark with the host.
//  - Battery (pager): the host's display state is irrelevant (the host may be
//    across the house). Local idle policy instead: 60s with no input and
//    nothing awaiting → panel off, but the RING STAYS ARMED — the amber pulse
//    is the pager's whole point. Input or a new awaiting wakes the panel.
static void knobApplyPower(uint32_t now, bool anyAwaiting, bool* ringDark) {
    static int lastApplied = -1;
    Input::PowerStatus ps = Input::powerStatus();
    bool onBattery = ps.valid && !ps.usbPowered;

    lockState();
    bool hostOn = g_state.hostDisplayOn;
    bool dimEnabled = g_state.hostDimEnabled;
    uint8_t dimMode = g_state.hostDimMode;
    uint8_t dimLevel = g_state.hostDimLevel;
    uint8_t userLevel = g_state.userBrightness;
    unlockState();

    int target = userLevel;
    bool dark = false;
    if (onBattery) {
        bool idle = (uint32_t)(now - s_lastInputMs) > 60000 && !anyAwaiting;
        if (idle) target = 0;
    } else if (!hostOn && dimEnabled) {
        target = (dimMode == 0) ? 0 : dimLevel;
        dark = (dimMode == 0);
    }
    if (target != lastApplied) {
        lastApplied = target;
        UI::setBrightness(target);
    }
    *ringDark = dark;
}

static void uiTask(void* param) {
    Serial.printf("[UI] Knob task started on core %d\n", xPortGetCoreID());

    UI::displayInit();
    Input::encoderInit(BOARD_PIN_ENC_A, BOARD_PIN_ENC_B, BOARD_PIN_ENC_KEY);
    Input::powerInit();
    Input::nfcInit();
    Input::irInit();
    Audio::micInit();
    Audio::playbackInit();
    Ring::init();
    Knob::create();

    // The vendor header calls GPIO6 BOARD_USER_KEY, but this board exposes no
    // such button: measured on hardware, it never moves and the only physical
    // controls are the rotary encoder and RST. Nothing binds to it.

    Serial.println("[UI] Knob screen created, entering main loop");

    uint32_t lastFrameMs = millis();
    while (true) {
        uint32_t now = millis();
        uint32_t dt_ms = now - lastFrameMs;
        float dt = dt_ms / 1000.0f;
        lastFrameMs = now;
        if (dt > 0.1f) dt = 0.1f;
        if (dt_ms > 0) lv_tick_inc(dt_ms);

        // Encoder → knob grammar
        int detents = Input::encoderReadDelta();
        if (detents != 0) Knob::onRotate(detents);
        Input::KeyEvent key = Input::encoderPollKey(now);
        if (key != Input::KeyEvent::NONE) Knob::onKey(key);
        if (detents != 0 || key != Input::KeyEvent::NONE) s_lastInputMs = now;

        // Battery/charger poll (I2C, self-throttled to every ~5s)
        Input::powerPoll(now);

        // IR remote button → peripheral primitive. Any remote in the room
        // becomes an AgentDeck button once mapped in settings.json.
        {
            char proto[24], code[24];
            if (Input::irPoll(now, proto, sizeof(proto), code, sizeof(code))) {
                char evt[160];
                snprintf(evt, sizeof(evt),
                         "{\"type\":\"peripheral_event\",\"board\":\"t_embed\","
                         "\"kind\":\"ir_rx\",\"protocol\":\"%s\",\"code\":\"%s\"}",
                         proto, code);
                Net::queueOutbound(evt);
                char note[48];
                snprintf(note, sizeof(note), "IR %s %s", proto, code);
                Knob::notify(note);
            }
        }

        // NFC tag tap → peripheral primitive (daemon maps meaning via config)
        {
            char uid[24];
            if (Input::nfcPoll(now, uid, sizeof(uid))) {
                char evt[112];
                snprintf(evt, sizeof(evt),
                         "{\"type\":\"peripheral_event\",\"board\":\"t_embed\","
                         "\"kind\":\"nfc_tag\",\"uid\":\"%s\"}", uid);
                Net::queueOutbound(evt);
                char note[40];
                snprintf(note, sizeof(note), "NFC %s", uid);
                Knob::notify(note);
                s_lastInputMs = now;  // a tap is an interaction — wake the panel
            }
        }

        // Awaiting edge: alert per session, not on the aggregate boolean. With
        // the old anyAwaiting edge, session B could start waiting while A was
        // already waiting and the pager stayed silent.
        bool anyAwaiting = false;
        char awaitingIds[10][32] = {};
        uint8_t awaitingCount = 0;
        lockState();
        for (uint8_t i = 0; i < g_state.sessionCount; i++) {
            if (strstr(g_state.sessions[i].state, "awaiting") != nullptr) {
                anyAwaiting = true;
                if (awaitingCount < 10) {
                    strncpy(awaitingIds[awaitingCount], g_state.sessions[i].id,
                            sizeof(awaitingIds[awaitingCount]) - 1);
                    awaitingCount++;
                }
            }
        }
        bool connectedNow = g_state.wsConnected;
        unlockState();
        {
            static char prevAwaitingIds[10][32] = {};
            static uint8_t prevAwaitingCount = 0;
            bool newlyAwaiting = false;
            for (uint8_t i = 0; i < awaitingCount && !newlyAwaiting; i++) {
                bool seen = false;
                for (uint8_t j = 0; j < prevAwaitingCount; j++) {
                    if (strcmp(awaitingIds[i], prevAwaitingIds[j]) == 0) {
                        seen = true;
                        break;
                    }
                }
                newlyAwaiting = !seen;
            }
            if (newlyAwaiting && connectedNow) {
                Chime::playAttention();
                s_lastInputMs = now;  // wake the panel with the chime
            }
            memcpy(prevAwaitingIds, awaitingIds, sizeof(prevAwaitingIds));
            prevAwaitingCount = awaitingCount;
        }

        // Hold-to-talk on the ENCODER, not a side key: the CC1101 board has
        // no user-pressable button besides the encoder and RST, so the vendor
        // header's BOARD_USER_KEY is not a control we can offer. Holding at
        // the list level records; releasing sends. Inside a session the same
        // hold still means BACK, so talking never fights navigation.
        {
            uint32_t held = Input::encoderKeyHeldMs(now);
            bool wantTalk = Knob::atListLevel() && held >= 400;
            if (wantTalk && !Audio::micCapturing() && !Audio::micReady()) {
                // Visible failure beats a dead-feeling button.
                Knob::notify("mic unavailable");
            }
            if (wantTalk && !Audio::micCapturing() && Audio::micReady()) {
                Audio::micStart(Knob::focusedSessionId());
                // Name the target while recording: the list is a carousel, so
                // "who am I talking to" is exactly the session on screen.
                Knob::setListening(Knob::focusedSessionLabel());
            }
            if (held == 0 && Audio::micCapturing()) {
                Audio::micStop(false);
                Knob::clearListening();
                Knob::notify("sent to host");
            }
        }
        Audio::micPump();

        // Power off is a detail-menu item now (there is no side key to hold).
        if (Knob::consumePowerOffRequest()) {
            Serial.println("[Power] menu power-off");
            Serial.flush();
            UI::setBrightness(0);
            Ring::update(now, -1, false, true /* dark */);
            Input::powerOff();  // does not return
        }

        lockState();
        g_state.applyPendingSessionClear(now);
        bool connected = g_state.wsConnected || Net::serialConnected();
        unlockState();

        bool ringDark = false;
        knobApplyPower(now, anyAwaiting, &ringDark);

        Knob::update(dt);
        Ring::update(now, Knob::selectedSessionIdx(), connected, ringDark);

        // These views rebuild only on visible state changes, but rotary input can
        // still exercise LVGL's allocator heavily. Surface both total and largest
        // free blocks so hardware soak tests catch fragmentation, not just OOM.
        {
            static uint32_t lastHeapLogMs = 0;
            if ((uint32_t)(now - lastHeapLogMs) >= 60000) {
                lastHeapLogMs = now;
                logHeap("knob");
            }
        }

        lv_timer_handler();

        // Frame-pace ~30fps like the other small SPI panels.
        uint32_t work = millis() - now;
        vTaskDelay(pdMS_TO_TICKS(work < RENDER_INTERVAL_MS ? (RENDER_INTERVAL_MS - work) : 1));
    }
}
#elif !defined(BOARD_LED8X32) && !defined(BOARD_INKDECK)
// ===== Settings long-press handler =====
static void onLongPress(lv_event_t* e) {
#if defined(BOARD_IPS10)
    // IPS10 is a dedicated cards + office surface — no full-screen Settings/Timeline overlays
    // (they covered the whole panel and fired on stray long-press/swipe). Leave the main view up.
    return;
#endif
    if (currentView == VIEW_AQUARIUM) {
        lv_screen_load_anim(scrSettings, LV_SCR_LOAD_ANIM_FADE_IN, 200, 0, false);
        currentView = VIEW_SETTINGS;
    }
}

// ===== Settings gesture (swipe down = back to aquarium) =====
static void settingsGesture(lv_event_t* e) {
    lv_dir_t dir = lv_indev_get_gesture_dir(lv_indev_active());
    if (dir == LV_DIR_BOTTOM || dir == LV_DIR_TOP) {
        lv_screen_load_anim(scrAquarium, LV_SCR_LOAD_ANIM_FADE_IN, 200, 0, false);
        currentView = VIEW_AQUARIUM;
    }
}

// ===== UI task (Core 1) =====
static void uiTask(void* param) {
    Serial.printf("[UI] Task started on core %d\n", xPortGetCoreID());

    // Initialize display + LVGL
    UI::displayInit();

    // Create screens
    scrSplash = Screens::splashCreate();
    lv_screen_load(scrSplash);
    Screens::splashSetStatus("Searching for AgentDeck...");

    scrAquarium = Screens::aquariumCreate();
    Screens::permissionCreate(scrAquarium);
    scrSettings = Screens::settingsCreate();

    // Long press on aquarium → settings
    lv_obj_add_event_cb(lv_obj_get_child(scrAquarium, 0), onLongPress, LV_EVENT_LONG_PRESSED, NULL);

    // Swipe on settings → back
    lv_obj_add_event_cb(scrSettings, settingsGesture, LV_EVENT_GESTURE, NULL);

    Serial.println("[UI] Screens created, entering main loop");

    uint32_t lastFrameMs = millis();
    uint32_t splashStartMs = millis();
    bool everConnected = false;
    // Connection overlay is LEVEL-triggered: track the last status actually applied
    // to the scrim, not edges of the inputs. Edge-tracking left the recreated scrim
    // (on rotation) stuck at its hardcoded default — see the rotation block below,
    // which resets this to -1 to force a re-apply onto the freshly created scrim.
    int lastOverlayStatus = -1;    // -1 = none applied yet / force re-apply
    uint32_t lastConnectedMs = 0;  // For reconnect-scrim grace period

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    // Physical button cycles rotation 90° per press (small panels, no touch UI).
    // TTGO: BTN1 = GPIO35 (input-only, external pull-up). C6: BOOT = GPIO9.
#if defined(BOARD_TTGO)
    pinMode(BOARD_PIN_BTN1, INPUT);
#else
    pinMode(BOARD_PIN_BTN1, INPUT_PULLUP);
#endif
    bool btnPrev = true;           // idle = HIGH (pulled up)
    uint32_t btnLastMs = 0;
#endif
#if defined(BOARD_TTGO)
    uint32_t lastReassertMs = 0;   // 10s panel/backlight self-heal timer
#endif

    while (true) {
        uint32_t now = millis();
        uint32_t dt_ms = now - lastFrameMs;
        float dt = dt_ms / 1000.0f;
        lastFrameMs = now;
        if (dt > 0.1f) dt = 0.1f;

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
        // No-PSRAM boards: surface largest-free-block periodically so a slow
        // fragmentation creep over a long session is visible on serial.
        {
            static uint32_t lastHeapLogMs = 0;
            if (now - lastHeapLogMs >= 30000) {
                lastHeapLogMs = now;
                logHeap("tick");
            }
        }
#endif

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
        // Poll button: falling edge (with debounce) rotates the screen 90°
        {
            bool btnNow = digitalRead(BOARD_PIN_BTN1);  // LOW = pressed
            if (btnPrev && !btnNow && (now - btnLastMs) > 250) {
                btnLastMs = now;
                uint8_t nextRot = (UI::getRotationIndex() + 1) & 3;
                lockState();
                g_state.pendingRotation = (int8_t)nextRot;
                g_state.orientationChanged = true;
                unlockState();
                Serial.printf("[Button] Rotate 90° → index %d\n", nextRot);
            }
            btnPrev = btnNow;
        }
#endif

        // LVGL tick
        if (dt_ms > 0) lv_tick_inc(dt_ms);

        // Check orientation change request (from protocol, settings, or button)
        lockState();
        bool orientChange = g_state.orientationChanged;
        bool newLandscape = g_state.pendingLandscape;
        int8_t newRotation = g_state.pendingRotation;
        if (orientChange) {
            g_state.orientationChanged = false;
            g_state.pendingRotation = -1;
        }
        unlockState();
        if (orientChange) {
            if (newRotation >= 0) {
                UI::setRotationIndex((uint8_t)newRotation);  // 90° step (button)
            } else {
                UI::setOrientation(newLandscape);            // legacy bool (network)
            }
            // Hold onto the outgoing screens so we can delete them AFTER the new
            // active screen is loaded. The screen-create helpers do `lv_obj_create(NULL)`
            // and overwrite their module-static pointer without deleting the previous
            // screen, so each rotation used to LEAK five whole screen trees. On this
            // PSRAM-less ESP32 a second rotation then exhausted the heap mid-rebuild
            // (every JSON parse failing with NoMemory) and the device froze.
            lv_obj_t* oldSplash = scrSplash;
            lv_obj_t* oldAquarium = scrAquarium;
            lv_obj_t* oldSettings = scrSettings;

            // Recreate all screens with new dimensions
            scrSplash = Screens::splashCreate();
            scrAquarium = Screens::aquariumCreate();
            Screens::permissionCreate(scrAquarium);
            lv_obj_add_event_cb(lv_obj_get_child(scrAquarium, 0), onLongPress, LV_EVENT_LONG_PRESSED, NULL);
            scrSettings = Screens::settingsCreate();
            lv_obj_add_event_cb(scrSettings, settingsGesture, LV_EVENT_GESTURE, NULL);

            if (currentView == VIEW_SPLASH) {
                lv_screen_load(scrSplash);
            } else if (currentView == VIEW_SETTINGS) {
                lv_screen_load(scrSettings);
            } else {
                lv_screen_load(scrAquarium);
                currentView = VIEW_AQUARIUM;
            }

            // Now that a freshly created screen is the active one, the old screens
            // are detached and safe to delete (LVGL forbids deleting the active
            // screen — hence the order: create → load new → delete old). Deleting an
            // aquarium screen also tears down its child permission overlay and its
            // terrarium canvas object; the canvas's draw-buf is the shared static
            // buffer (not owned by the object), so the live screen keeps working.
            if (oldSplash) lv_obj_del(oldSplash);
            if (oldAquarium) lv_obj_del(oldAquarium);
            if (oldSettings) lv_obj_del(oldSettings);

            // The recreated aquarium has a brand-new connScrim at its hardcoded
            // default (HIDDEN). Force the connection-status block below to re-apply
            // the *actual* current status to it; otherwise the scrim's visibility
            // silently decouples from the real connection state on every rotation.
            lastOverlayStatus = -1;
        }

        // Read view state
        lockState();
        g_state.applyPendingSessionClear(now);
        bool connected = g_state.wsConnected || Net::serialConnected();
        unlockState();

        if (connected) {
            everConnected = true;
            lastConnectedMs = now;
        }

        // Grace period: brief transport blips (WS reconnect, serial hiccup) must not
        // flash the near-black reconnect scrim. Treat as still-connected for 5s.
        bool showConnected = connected ||
                             (everConnected && (now - lastConnectedMs) < 5000);

        if (!connected && everConnected &&
            currentView != VIEW_AQUARIUM && currentView != VIEW_SPLASH) {
            lv_screen_load_anim(scrAquarium, LV_SCR_LOAD_ANIM_FADE_IN, 200, 0, false);
            currentView = VIEW_AQUARIUM;
        }

        // Screen transitions
        if (currentView == VIEW_SPLASH) {
            if (connected) {
                // Connected — go to aquarium immediately
                lv_screen_load_anim(scrAquarium, LV_SCR_LOAD_ANIM_FADE_IN, 300, 0, false);
                currentView = VIEW_AQUARIUM;
            } else {
                // Not connected — remain on splash screen with status text
                if (!Net::wifiConnected() && !Net::serialConnected()) {
                    Screens::splashSetStatus("No WiFi");
                } else {
                    Screens::splashSetStatus("Searching for AgentDeck...");
                }
            }
        }

        // Update connection status overlay on aquarium (LEVEL-triggered).
        // connected = serial OR websocket — either path is valid. We compute the
        // *desired* overlay status every loop and apply it only when it differs
        // from what's currently on the scrim. This is recreation-safe (rotation
        // resets lastOverlayStatus) and self-healing (a scrim that ever diverges
        // from the real state is corrected on the next frame) — unlike the old
        // edge-triggered logic, which could leave the scrim stuck.
        bool wifiNow = Net::wifiConnected();
        bool serialNow = Net::serialConnected();
        ConnOverlayStatus desiredOverlay;
        if (showConnected) {
            desiredOverlay = ConnOverlayStatus::HIDDEN;
        } else if (everConnected) {
            // Was connected before — daemon went away (regardless of WiFi state)
            desiredOverlay = ConnOverlayStatus::RECONNECTING;
        } else if (!wifiNow && !serialNow) {
            desiredOverlay = ConnOverlayStatus::NO_WIFI;
        } else {
            desiredOverlay = ConnOverlayStatus::SEARCHING;
        }
        if (currentView == VIEW_AQUARIUM &&
            (int)desiredOverlay != lastOverlayStatus) {
            lastOverlayStatus = (int)desiredOverlay;
            Screens::aquariumSetConnectionStatus(desiredOverlay);
        }

        // Apply the host-display dim/restore every frame, independent of the active
        // view, so the panel sleeps with the Mac even on the timeline/detail screens.
        Screens::applyHostDimBrightness();

        // Update current view
        uint32_t tView0 = micros();
        switch (currentView) {
            case VIEW_AQUARIUM:
                Screens::aquariumUpdate(dt);
                break;
            case VIEW_SETTINGS:
                Screens::settingsUpdate();
                break;
            case VIEW_SPLASH:
                break;
        }
        uint32_t tView1 = micros();

#if defined(IPS10_PERF_HUD)
        { extern volatile uint32_t g_flushInnerUs; g_flushInnerUs = 0; }  // reset before frame
#endif
        // LVGL timer handler
        lv_timer_handler();

#if defined(IPS10_PERF_HUD)
        // On-screen perf overlay source: track the WORST single frame over a rolling ~1.5s window.
        // Splits app-render(view) / LVGL-render+flush(flush) / and the PPA+push portion(inner) so
        // we know if the flush cost is LVGL widget rendering or the rotation/push path.
        {
            uint32_t tF = micros();
            extern volatile uint32_t g_flushInnerUs;
            uint32_t vUs = tView1 - tView0, fUs = tF - tView1, iUs = g_flushInnerUs;
            extern volatile uint32_t g_perfWorstUs, g_perfWorstView, g_perfWorstFlush, g_perfWorstInner;
            static uint32_t winStart = 0, wU = 0, wV = 0, wF = 0, wI = 0;
            if (vUs + fUs > wU) { wU = vUs + fUs; wV = vUs; wF = fUs; wI = iUs; }
            if (now - winStart >= 1500) {
                g_perfWorstUs = wU; g_perfWorstView = wV; g_perfWorstFlush = wF; g_perfWorstInner = wI;
                wU = wV = wF = wI = 0; winStart = now;
            }
        }
#endif

#if defined(IPS10_PERF_PROFILE)
        // [PERF] frame profiler — avg FPS + render(view) vs flush(LVGL) split, every 2s.
        {
            uint32_t tFlush1 = micros();
            static uint32_t accView = 0, accFlush = 0, frames = 0, lastReport = 0;
            uint32_t vUs = tView1 - tView0, fUs = tFlush1 - tView1;
            // Immediately flag any single frame that stalls the loop (>25ms) — catches the
            // modal-close hitch. Splits app-render(view) vs LVGL-render+flush(flush) so we
            // know which side the bottleneck is on.
            if (vUs + fUs > 25000) {
                Serial.printf("[PROF] SLOW frame %lu us (view %lu | flush %lu)\n",
                              (unsigned long)(vUs + fUs), (unsigned long)vUs, (unsigned long)fUs);
            }
            accView += (tView1 - tView0);
            accFlush += (tFlush1 - tView1);
            frames++;
            if (now - lastReport >= 2000 && frames > 0) {
                float fps = frames * 1000.0f / (float)(now - lastReport);
                // Largest internal free block alongside fps — a shrinking freeblk
                // while fps holds steady is the fragmentation tell.
                size_t freeblk = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
                Serial.printf("[PERF] %.1f fps | view %lu us | flush %lu us | frame %lu us | freeblk %uKB\n",
                              fps, (unsigned long)(accView / frames),
                              (unsigned long)(accFlush / frames),
                              (unsigned long)((accView + accFlush) / frames),
                              (unsigned)(freeblk / 1024));
                accView = accFlush = frames = 0; lastReport = now;
            }
        }
#endif

#if defined(BOARD_TTGO)
        // Panel/backlight self-heal every 10s (DISPON + backlight duty re-assert)
        if (now - lastReassertMs > 10000) {
            lastReassertMs = now;
            UI::reassertPanel();
        }
#endif

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
        // Small SPI panels: frame-pace to a stable ~30fps. The terrarium fully
        // invalidates every frame, so an uncapped loop floods the no-DMA SPI bus and
        // causes intermittent tearing/flicker. Sleep the remainder of the frame budget.
        {
            uint32_t work = millis() - now;
            vTaskDelay(pdMS_TO_TICKS(work < RENDER_INTERVAL_MS ? (RENDER_INTERVAL_MS - work) : 1));
        }
#else
        // ~5ms yield for smooth animation (minimum 1 tick to prevent busy loops on 100Hz systems)
        uint32_t yield_ticks = pdMS_TO_TICKS(5);
        vTaskDelay(yield_ticks > 0 ? yield_ticks : 1);
#endif
    }
}
#elif defined(BOARD_LED8X32)
// ===== UI task — LED matrix (Core 1) =====
static void uiTask(void* param) {
    Serial.println("[UI] Matrix task started on core 1");
    Matrix::init();

    uint32_t lastFrameMs = millis();
    while (true) {
        uint32_t now = millis();
        float dt = (now - lastFrameMs) / 1000.0f;
        lastFrameMs = now;
        if (dt > 0.1f) dt = 0.1f;

        Matrix::update(dt);
        Matrix::render();

        vTaskDelay(pdMS_TO_TICKS(RENDER_INTERVAL_MS));
    }
}
#else // BOARD_INKDECK
// ===== UI task — e-ink dashboard (Core 1) =====
// Slow tick: render() is content-hash gated internally and a panel refresh
// blocks 0.3-3s, so there is nothing to gain from the 30fps LCD cadence.
static void uiTask(void* param) {
    Serial.println("[UI] InkDeck e-ink task started on core 1");
    Eink::init();

    uint32_t lastFrameMs = millis();
    while (true) {
        uint32_t now = millis();
        float dt = (now - lastFrameMs) / 1000.0f;
        lastFrameMs = now;

        Eink::update(dt);
        Eink::render();

        vTaskDelay(pdMS_TO_TICKS(250));
    }
}
#endif // board UI fork

// ===== Arduino setup =====
void setup() {
#if defined(BOARD_T_EMBED)
    // Latch the power rail FIRST — on battery the board browns out the moment
    // code runs unless PWR_EN is driven high (USB masks this).
    pinMode(BOARD_PIN_PWR_EN, OUTPUT);
    digitalWrite(BOARD_PIN_PWR_EN, HIGH);
#endif
#if defined(BOARD_INKDECK) || defined(BOARD_IPS10) || defined(BOARD_T_EMBED) || defined(BOARD_T_DISPLAY_PRO)
#if defined(BOARD_T_EMBED)
    // 16384 on the only board that receives *audio* over serial. A spoken reply
    // arrives at ~44 KB/s (base64 PCM), so an 8 KB ring covers only ~190 ms of
    // stall — and the network task does stall: while the WiFi radio is live,
    // arduinoWebSockets' reconnect blocks it on a TCP connect. Measured with a
    // 4.2 s reply: 26% of the audio survived with the radio up, 97% with it
    // parked (serial-primary, the real configuration), and whole lines vanish
    // silently because a line that does not start with '{' is discarded without
    // a parse error. Double the ring so the residual stall costs nothing.
    Serial.setRxBufferSize(16384);
#else
    // RX 8192 — a 10-session enriched sessions_list is ~2.2-3.5KB; the old
    // 2048 truncated it mid-line ([Protocol] JSON error: InvalidInput).
    Serial.setRxBufferSize(8192);
#endif
#if ARDUINO_USB_MODE == 1
    // HWCDC-only knobs (TinyUSB's USBCDC has neither): grow the 256-byte TX
    // ring and widen the give-up timeout — HWCDC drops whole 64-byte FIFO
    // blocks mid-line otherwise. InkDeck now ships TinyUSB (USB_MODE=0), so
    // this branch only matters if someone flips the mode back.
    Serial.setTxBufferSize(4096);
    Serial.setTxTimeoutMs(300);
#endif
#else
    Serial.setRxBufferSize(2048);  // Default 256 too small for large JSON messages
#endif
    Serial.begin(115200);
#if defined(BOARD_LED8X32)
    // Silence buzzer immediately (GPIO15 floats during boot → beep)
    pinMode(15, OUTPUT);
    digitalWrite(15, LOW);
    // CH340 UART: no CDC wait needed
    delay(200);
    Serial.println("\n=== AgentDeck Ulanzi TC001 LED Matrix ===");
#elif defined(BOARD_TTGO)
    // CH9102 UART: no CDC wait needed
    delay(200);
    Serial.println("\n=== AgentDeck TTGO T-Display ===");
#elif defined(BOARD_ESP32_C6_147)
    // Native USB CDC: wait for host connection (up to 3 seconds)
    for (int i = 0; i < 30 && !Serial; i++) delay(100);
    delay(200);
    Serial.println("\n=== AgentDeck ESP32-C6 1.47 ===");
#elif defined(BOARD_BOX_86) || defined(BOARD_86_BOX)
    // CH340 UART: no CDC wait needed
    delay(200);
    Serial.println("\n=== AgentDeck 86 Box 4\" ===");
#elif defined(BOARD_INKDECK)
    // Native USB CDC: wait for host connection (up to 3 seconds)
    for (int i = 0; i < 30 && !Serial; i++) delay(100);
    delay(200);
    Serial.println("\n=== AgentDeck InkDeck 7.5\" e-ink ===");
#elif defined(BOARD_T_EMBED)
    // Native USB CDC: wait for host connection (up to 3 seconds)
    for (int i = 0; i < 30 && !Serial; i++) delay(100);
    delay(200);
    Serial.println("\n=== AgentDeck T-Embed Companion Knob ===");
#elif defined(BOARD_T_DISPLAY_PRO)
    // Native USB CDC: wait for host connection (up to 3 seconds)
    for (int i = 0; i < 30 && !Serial; i++) delay(100);
    delay(200);
    Serial.println("\n=== AgentDeck T-Display-S3-Pro Focus Strip ===");
#else
    // Native USB CDC: wait for host connection (up to 3 seconds)
    for (int i = 0; i < 30 && !Serial; i++) delay(100);
    delay(200);
    Serial.println("\n=== AgentDeck ESP32-S3 Display ===");
#endif
    Serial.flush();
    Serial.printf("Board: %s  Screen: %dx%d\n",
#if defined(BOARD_LED8X32)
        "Ulanzi TC001",
#elif defined(BOARD_TTGO)
        "TTGO T-Display",
#elif defined(BOARD_ESP32_C6_147)
        "ESP32-C6 1.47\"",
#elif defined(BOARD_INKDECK)
        "InkDeck 7.5\" e-ink",
#elif defined(BOARD_T_EMBED)
        "T-Embed Knob",
#elif defined(BOARD_T_DISPLAY_PRO)
        "T-Display-S3-Pro Ticker",
#elif defined(BOARD_IPS35)
        "IPS 3.5\"",
#elif defined(BOARD_BOX_86) || defined(BOARD_86_BOX)
        "86 Box 4\"",
#elif defined(BOARD_AMOLED)
        "AMOLED Round 1.8\"",
#else
        "Unknown",
#endif
#if defined(BOARD_LED8X32) || defined(BOARD_INKDECK)
        SCREEN_W, SCREEN_H);
#else
        g_screenW, g_screenH);
#endif

#if !defined(BOARD_LED8X32) && !defined(BOARD_TTGO) && !defined(BOARD_ESP32_C6_147)
    // Init PSRAM
    if (!psramFound()) {
        Serial.println("WARNING: No PSRAM found!");
    }
#endif
    // Boot heap snapshot — free + largest-free-block (fragmentation signal).
    logHeap("boot");

    // Init state
    g_stateMutex = xSemaphoreCreateMutex();
    g_state.reset();

    // Launch tasks on separate cores
    xTaskCreatePinnedToCore(networkTask, "net", STACK_NETWORK, NULL, 1, NULL, CORE_NETWORK);
    xTaskCreatePinnedToCore(uiTask, "ui", STACK_UI, NULL, 2, NULL, CORE_UI);
}

void loop() {
    // Main loop unused — everything runs in FreeRTOS tasks
    vTaskDelay(portMAX_DELAY);
}
