#include "splash.h"
#include "../theme.h"
#include "../assets/logo.h"
#include "config.h"
#include <cstring>

static lv_obj_t* screen = nullptr;
static lv_obj_t* imgLogo = nullptr;
static lv_obj_t* lblTitle = nullptr;
static lv_obj_t* lblStatus = nullptr;
static lv_obj_t* lblWifiStatus = nullptr;

static const char* compactStatus(const char* text) {
    if (!text) return "Connecting";
    if (strstr(text, "No WiFi")) return "No WiFi";
    return "Connecting";
}

static void set_logo_opa_cb(void* var, int32_t val) {
    lv_obj_set_style_image_opa((lv_obj_t*)var, val, 0);
}

namespace Screens {

lv_obj_t* splashCreate() {
    screen = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x163B5C), 0);  // ShallowWater — brighter
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);

    // Brand icon — AD shield logo
    imgLogo = lv_image_create(screen);
    lv_image_set_src(imgLogo, &img_logo_48);
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    lv_obj_align(imgLogo, LV_ALIGN_CENTER, 0, -40);
#else
    lv_obj_align(imgLogo, LV_ALIGN_CENTER, 0, -55);
#endif

    // Logo breathing glow animation
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, imgLogo);
    lv_anim_set_exec_cb(&a, set_logo_opa_cb);
    lv_anim_set_values(&a, 100, 255);
    lv_anim_set_duration(&a, 1500);
    lv_anim_set_reverse_duration(&a, 1500);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
    lv_anim_start(&a);

    // Title
    lblTitle = lv_label_create(screen);
    lv_obj_set_style_text_color(lblTitle, lv_color_hex(Theme::HUDText), 0);
    lv_obj_set_style_text_font(lblTitle, &lv_font_montserrat_20, 0);
    lv_label_set_text(lblTitle, "AgentDeck");
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    lv_obj_align(lblTitle, LV_ALIGN_CENTER, 0, -18);
#else
    lv_obj_align(lblTitle, LV_ALIGN_CENTER, 0, -25);
#endif

    // Status text
    lblStatus = lv_label_create(screen);
    lv_obj_set_style_text_color(lblStatus, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(lblStatus, &lv_font_montserrat_16, 0);
    lv_label_set_text(lblStatus, "Connecting");
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    lv_obj_align(lblStatus, LV_ALIGN_CENTER, 0, 18);
#else
    lv_obj_align(lblStatus, LV_ALIGN_CENTER, 0, 32);
#endif

    // WiFi provisioning sub-status is intentionally hidden on the connecting
    // screen. Tiny rapidly-changing text was unreadable on several panels.
    lblWifiStatus = lv_label_create(screen);
    lv_obj_set_style_text_color(lblWifiStatus, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(lblWifiStatus, &lv_font_montserrat_10, 0);
    lv_label_set_text(lblWifiStatus, "");
    lv_obj_add_flag(lblWifiStatus, LV_OBJ_FLAG_HIDDEN);

    return screen;
}

void splashSetStatus(const char* text) {
    if (lblStatus) {
        lv_label_set_text(lblStatus, compactStatus(text));
    }
}

void splashSetWifiStatus(const char* text) {
    if (lblWifiStatus) {
        lv_label_set_text(lblWifiStatus, "");
    }
}

}  // namespace Screens
