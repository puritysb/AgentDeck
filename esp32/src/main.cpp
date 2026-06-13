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
#include "state/agent_state.h"
#include "net/serial_client.h"
#include "net/wifi_manager.h"
#include "net/mdns_discovery.h"
#include "net/ws_client.h"

#ifdef BOARD_LED8X32
#include "ui/matrix/matrix_display.h"
#else
#include "ui/display.h"
#include "ui/screens/splash.h"
#include "ui/screens/aquarium.h"
#include "ui/screens/timeline_scr.h"
#include "ui/screens/settings.h"
#include "ui/screens/permission.h"
#endif

// ===== Global state =====
DashboardState g_state;
SemaphoreHandle_t g_stateMutex = nullptr;

#ifndef BOARD_LED8X32
// ===== Screen objects (LVGL boards only) =====
static lv_obj_t* scrSplash = nullptr;
static lv_obj_t* scrAquarium = nullptr;
static lv_obj_t* scrTimeline = nullptr;
static lv_obj_t* scrSettings = nullptr;

static enum {
    VIEW_SPLASH,
    VIEW_AQUARIUM,
    VIEW_TIMELINE,
    VIEW_SETTINGS
} currentView = VIEW_SPLASH;
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

    while (true) {
        // === Always poll serial (USB JSON from bridge) ===
        Net::serialLoop();

        // === WiFi portal (non-blocking, processes captive portal if active) ===
        Net::wifiLoop();

        // === Continuous mDNS discovery ===
        // Only perform mDNS polling if we are NOT connected. 
        // Constant mDNS querying while connected consumes CPU, Wi-Fi bandwidth,
        // and induces severe packet jitter/latency spikes on ESP32, leading to disconnects.
        if (Net::wifiConnected() && !Net::wsConnected() && Net::mdnsPoll(bridge)) {
            bool ipChanged = (strcmp(currentBridgeIp, bridge.ip) != 0) || (currentBridgePort != bridge.port);
            if (ipChanged || !Net::wsConnected()) {
                if (ipChanged) {
                    Serial.printf("[Net] Bridge (re)discovered via mDNS: %s:%d\n", bridge.ip, bridge.port);
                    strncpy(currentBridgeIp, bridge.ip, sizeof(currentBridgeIp) - 1);
                    currentBridgePort = bridge.port;
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
        if (!Net::wsConnected() && !Net::serialConnected() && Net::wifiConnected()) {
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
        Net::wsLoop();

        // Update combined connection status (serial OR wifi)
        bool conn = Net::serialConnected() || Net::wsConnected();
        lockState();
        g_state.wsConnected = conn;
        unlockState();

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

#ifndef BOARD_LED8X32
// ===== Settings long-press handler =====
static void onLongPress(lv_event_t* e) {
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
    Screens::splashSetStatus("Searching for bridges...");

    scrAquarium = Screens::aquariumCreate();
    Screens::permissionCreate(scrAquarium);
    scrTimeline = Screens::timelineCreate();
    scrSettings = Screens::settingsCreate();

    // Long press on aquarium → settings
    lv_obj_add_event_cb(lv_obj_get_child(scrAquarium, 0), onLongPress, LV_EVENT_LONG_PRESSED, NULL);

    // Swipe on settings → back
    lv_obj_add_event_cb(scrSettings, settingsGesture, LV_EVENT_GESTURE, NULL);

    Serial.println("[UI] Screens created, entering main loop");

    uint32_t lastFrameMs = millis();
    uint32_t splashStartMs = millis();
    bool wasTimelineView = false;
    bool everConnected = false;
    bool prevConnStatus = false;   // Track connection changes for status overlay
    bool prevWifiStatus = false;

#if defined(BOARD_ESP32_C6_147)
    // BOOT button (GPIO9) toggles orientation — this board has no touch
    pinMode(BOARD_PIN_BTN1, INPUT_PULLUP);
    bool btnPrev = true;           // idle = HIGH (pulled up)
    uint32_t btnLastMs = 0;
#endif

    while (true) {
        uint32_t now = millis();
        uint32_t dt_ms = now - lastFrameMs;
        float dt = dt_ms / 1000.0f;
        lastFrameMs = now;
        if (dt > 0.1f) dt = 0.1f;

#if defined(BOARD_ESP32_C6_147)
        // Poll BOOT button: falling edge (with debounce) flips orientation
        {
            bool btnNow = digitalRead(BOARD_PIN_BTN1);  // LOW = pressed
            if (btnPrev && !btnNow && (now - btnLastMs) > 250) {
                btnLastMs = now;
                lockState();
                g_state.pendingLandscape = !UI::isLandscape();
                g_state.orientationChanged = true;
                unlockState();
                Serial.println("[Button] BOOT pressed — toggling orientation");
            }
            btnPrev = btnNow;
        }
#endif

        // LVGL tick
        if (dt_ms > 0) lv_tick_inc(dt_ms);

        // Check orientation change request (from protocol or settings)
        lockState();
        bool orientChange = g_state.orientationChanged;
        bool newLandscape = g_state.pendingLandscape;
        if (orientChange) g_state.orientationChanged = false;
        unlockState();
        if (orientChange) {
            UI::setOrientation(newLandscape);
            // Recreate all screens with new dimensions
            scrSplash = Screens::splashCreate();
            scrAquarium = Screens::aquariumCreate();
            Screens::permissionCreate(scrAquarium);
            lv_obj_add_event_cb(lv_obj_get_child(scrAquarium, 0), onLongPress, LV_EVENT_LONG_PRESSED, NULL);
            scrTimeline = Screens::timelineCreate();
            scrSettings = Screens::settingsCreate();
            lv_obj_add_event_cb(scrSettings, settingsGesture, LV_EVENT_GESTURE, NULL);

            if (currentView == VIEW_SPLASH) {
                lv_screen_load(scrSplash);
            } else if (currentView == VIEW_TIMELINE) {
                lv_screen_load(scrTimeline);
            } else if (currentView == VIEW_SETTINGS) {
                lv_screen_load(scrSettings);
            } else {
                lv_screen_load(scrAquarium);
                currentView = VIEW_AQUARIUM;
            }
        }

        // Read view state
        lockState();
        bool connected = g_state.wsConnected || Net::serialConnected();
        bool wantTimeline = g_state.timelineView;
        unlockState();

        if (connected) everConnected = true;

        if (!connected && everConnected &&
            currentView != VIEW_AQUARIUM && currentView != VIEW_SPLASH) {
            lockState();
            g_state.timelineView = false;
            unlockState();
            lv_screen_load_anim(scrAquarium, LV_SCR_LOAD_ANIM_FADE_IN, 200, 0, false);
            currentView = VIEW_AQUARIUM;
            wasTimelineView = false;
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
                    Screens::splashSetStatus("Searching for bridges...");
                }
            }
        }

        // Aquarium ↔ Timeline swipe
        if (currentView == VIEW_AQUARIUM && wantTimeline && !wasTimelineView) {
            lv_screen_load_anim(scrTimeline, LV_SCR_LOAD_ANIM_MOVE_TOP, 200, 0, false);
            currentView = VIEW_TIMELINE;
        } else if (currentView == VIEW_TIMELINE && !wantTimeline && wasTimelineView) {
            lv_screen_load_anim(scrAquarium, LV_SCR_LOAD_ANIM_MOVE_BOTTOM, 200, 0, false);
            currentView = VIEW_AQUARIUM;
        }
        wasTimelineView = wantTimeline;

        // Update connection status overlay on aquarium
        // connected = serial OR websocket — either path is valid
        bool wifiNow = Net::wifiConnected();
        bool serialNow = Net::serialConnected();
        if (connected != prevConnStatus || wifiNow != prevWifiStatus) {
            prevConnStatus = connected;
            prevWifiStatus = wifiNow;
            if (currentView == VIEW_AQUARIUM || currentView == VIEW_TIMELINE) {
                if (connected) {
                    Screens::aquariumSetConnectionStatus(ConnOverlayStatus::HIDDEN);
                } else if (everConnected) {
                    // Was connected before — daemon went away (regardless of WiFi state)
                    Screens::aquariumSetConnectionStatus(ConnOverlayStatus::RECONNECTING);
                } else if (!wifiNow && !serialNow) {
                    Screens::aquariumSetConnectionStatus(ConnOverlayStatus::NO_WIFI);
                } else {
                    Screens::aquariumSetConnectionStatus(ConnOverlayStatus::SEARCHING);
                }
            }
        }

        // Update current view
        switch (currentView) {
            case VIEW_AQUARIUM:
                Screens::aquariumUpdate(dt);
                break;
            case VIEW_TIMELINE:
                Screens::timelineUpdate();
                break;
            case VIEW_SETTINGS:
                Screens::settingsUpdate();
                break;
            case VIEW_SPLASH:
                break;
        }

        // LVGL timer handler
        lv_timer_handler();

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
#else // BOARD_LED8X32
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
#endif // BOARD_LED8X32

// ===== Arduino setup =====
void setup() {
    Serial.setRxBufferSize(2048);  // Default 256 too small for large JSON messages
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
#elif defined(BOARD_IPS35)
        "IPS 3.5\"",
#elif defined(BOARD_RGB48)
        "86 Box 4\"",
#elif defined(BOARD_AMOLED)
        "AMOLED Round 1.8\"",
#else
        "Unknown",
#endif
#if defined(BOARD_LED8X32)
        SCREEN_W, SCREEN_H);
#else
        g_screenW, g_screenH);
#endif

#if !defined(BOARD_LED8X32) && !defined(BOARD_TTGO) && !defined(BOARD_ESP32_C6_147)
    // Init PSRAM
    if (psramFound()) {
        Serial.printf("PSRAM: %d KB free\n", ESP.getFreePsram() / 1024);
    } else {
        Serial.println("WARNING: No PSRAM found!");
    }
#else
    Serial.printf("Free heap: %d KB\n", ESP.getFreeHeap() / 1024);
#endif

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
