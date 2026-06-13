#include "settings.h"
#include "../theme.h"
#include "../../net/wifi_manager.h"
#include "../../state/agent_state.h"
#include "../display.h"
#include "config.h"
#include <cstdio>
#include <Arduino.h>

static lv_obj_t* screen = nullptr;
static lv_obj_t* lblWifi = nullptr;
static lv_obj_t* lblBridge = nullptr;
static lv_obj_t* slider = nullptr;
static lv_obj_t* lblBrightVal = nullptr;

static void onWifiReset(lv_event_t* e) {
    Net::wifiReset();
}

static void onReboot(lv_event_t* e) {
    ESP.restart();
}

static void onBrightnessChange(lv_event_t* e) {
    int val = lv_slider_get_value(slider);
    UI::setBrightness(val);
    lockState();
    g_state.userBrightness = (uint8_t)val;
    unlockState();
    char buf[8];
    snprintf(buf, sizeof(buf), "%d%%", val * 100 / 255);
    lv_label_set_text(lblBrightVal, buf);
}

static void onBack(lv_event_t* e) {
    // Return to previous screen
    lockState();
    g_state.timelineView = false;
    unlockState();
}

namespace Screens {

lv_obj_t* settingsCreate() {
    screen = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(screen, lv_color_hex(Theme::DeepSea), 0);
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    lv_obj_add_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scroll_dir(screen, LV_DIR_VER);
#else
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
#endif
    lv_obj_set_flex_flow(screen, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_top(screen, 16, 0);
    lv_obj_set_style_pad_bottom(screen, 12, 0);
    lv_obj_set_style_pad_left(screen, 20, 0);
    lv_obj_set_style_pad_right(screen, 20, 0);
    lv_obj_set_style_pad_row(screen, 10, 0);

    // Title
    lv_obj_t* title = lv_label_create(screen);
    lv_obj_set_style_text_color(title, lv_color_hex(Theme::HUDText), 0);
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, 0);
    lv_label_set_text(title, "Settings");

    // --- Connection info ---
    lblWifi = lv_label_create(screen);
    lv_obj_set_style_text_color(lblWifi, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(lblWifi, &lv_font_montserrat_12, 0);
    lv_label_set_text(lblWifi, "WiFi: --");

    lblBridge = lv_label_create(screen);
    lv_obj_set_style_text_color(lblBridge, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(lblBridge, &lv_font_montserrat_12, 0);
    lv_label_set_text(lblBridge, "Bridge: --");

    // --- Brightness ---
    lv_obj_t* lblBright = lv_label_create(screen);
    lv_obj_set_style_text_color(lblBright, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(lblBright, &lv_font_montserrat_12, 0);
    lv_label_set_text(lblBright, "Brightness");

    // Slider row
    lv_obj_t* sliderRow = lv_obj_create(screen);
    lv_obj_set_size(sliderRow, g_screenW - 40, 30);
    lv_obj_set_style_bg_opa(sliderRow, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(sliderRow, 0, 0);
    lv_obj_set_style_pad_all(sliderRow, 0, 0);
    lv_obj_clear_flag(sliderRow, LV_OBJ_FLAG_SCROLLABLE);

    slider = lv_slider_create(sliderRow);
    lv_obj_set_width(slider, g_screenW - 100);
    lv_obj_align(slider, LV_ALIGN_LEFT_MID, 0, 0);
    lv_slider_set_range(slider, 10, 255);
    lv_slider_set_value(slider, 255, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(slider, lv_color_hex(0x1E293B), 0);
    lv_obj_set_style_bg_color(slider, lv_color_hex(Theme::StatusBlue), LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(slider, lv_color_hex(Theme::HUDText), LV_PART_KNOB);
    lv_obj_add_event_cb(slider, onBrightnessChange, LV_EVENT_VALUE_CHANGED, NULL);

    lblBrightVal = lv_label_create(sliderRow);
    lv_obj_set_style_text_color(lblBrightVal, lv_color_hex(Theme::HUDText), 0);
    lv_obj_set_style_text_font(lblBrightVal, &lv_font_montserrat_12, 0);
    lv_obj_align(lblBrightVal, LV_ALIGN_RIGHT_MID, 0, 0);
    lv_label_set_text(lblBrightVal, "100%");

    // --- Buttons ---
    // WiFi reset
    lv_obj_t* btnReset = lv_btn_create(screen);
    lv_obj_set_size(btnReset, g_screenW - 40, 38);
    lv_obj_set_style_bg_color(btnReset, lv_color_hex(0x7F1D1D), 0);
    lv_obj_set_style_radius(btnReset, 6, 0);
    lv_obj_add_event_cb(btnReset, onWifiReset, LV_EVENT_CLICKED, NULL);
    lv_obj_t* lblReset = lv_label_create(btnReset);
    lv_obj_set_style_text_color(lblReset, lv_color_hex(Theme::HUDText), 0);
    lv_obj_center(lblReset);
    lv_label_set_text(lblReset, "Reset WiFi & Restart");

    // Reboot
    lv_obj_t* btnReboot = lv_btn_create(screen);
    lv_obj_set_size(btnReboot, g_screenW - 40, 38);
    lv_obj_set_style_bg_color(btnReboot, lv_color_hex(0x1E293B), 0);
    lv_obj_set_style_radius(btnReboot, 6, 0);
    lv_obj_add_event_cb(btnReboot, onReboot, LV_EVENT_CLICKED, NULL);
    lv_obj_t* lblReboot = lv_label_create(btnReboot);
    lv_obj_set_style_text_color(lblReboot, lv_color_hex(Theme::HUDText), 0);
    lv_obj_center(lblReboot);
    lv_label_set_text(lblReboot, "Reboot");

    // Orientation toggle (IPS 3.5" / TTGO T-Display / ESP32-C6 1.47")
#if defined(BOARD_IPS35) || defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    lv_obj_t* btnOrient = lv_btn_create(screen);
    lv_obj_set_size(btnOrient, g_screenW - 40, 38);
    lv_obj_set_style_bg_color(btnOrient, lv_color_hex(0x1E3A5F), 0);
    lv_obj_set_style_radius(btnOrient, 6, 0);
    lv_obj_add_event_cb(btnOrient, [](lv_event_t* e) {
        lockState();
        g_state.pendingLandscape = !UI::isLandscape();
        g_state.orientationChanged = true;
        unlockState();
    }, LV_EVENT_CLICKED, NULL);
    lv_obj_t* lblOrient = lv_label_create(btnOrient);
    lv_obj_set_style_text_color(lblOrient, lv_color_hex(Theme::HUDText), 0);
    lv_obj_center(lblOrient);
    lv_label_set_text(lblOrient, UI::isLandscape() ? "Switch to Portrait" : "Switch to Landscape");
#endif

    // Version
    lv_obj_t* lblVer = lv_label_create(screen);
    lv_obj_set_style_text_color(lblVer, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(lblVer, &lv_font_montserrat_10, 0);
    lv_label_set_text_fmt(lblVer, "AgentDeck Display v%s", FIRMWARE_VERSION);

    return screen;
}

void settingsUpdate() {
    if (!lblWifi) return;

    char buf[64];
    if (Net::wifiConnected()) {
        snprintf(buf, sizeof(buf), "WiFi: %s", Net::wifiLocalIP());
    } else {
        snprintf(buf, sizeof(buf), "WiFi: Not connected");
    }
    lv_label_set_text(lblWifi, buf);

    lockState();
    if (g_state.wsConnected) {
        if (g_state.bridgeIp[0]) {
            snprintf(buf, sizeof(buf), "Bridge: %s:%d", g_state.bridgeIp, g_state.bridgePort);
        } else {
            snprintf(buf, sizeof(buf), "Bridge: USB Serial");
        }
    } else {
        snprintf(buf, sizeof(buf), "Bridge: Disconnected");
    }
    unlockState();
    lv_label_set_text(lblBridge, buf);
}

}  // namespace Screens
