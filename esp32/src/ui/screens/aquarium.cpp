#include "aquarium.h"
#include "../terrarium/renderer.h"
#include "../widgets/hud_bar.h"
#include "../display.h"
#include "../theme.h"
#include "../assets/logo.h"
#include "../../state/agent_state.h"
#include "config.h"

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
#include "ttgo_overlay.h"
#endif

static lv_obj_t* screen = nullptr;
static lv_obj_t* connScrim = nullptr;
static lv_obj_t* connCard = nullptr;
static lv_obj_t* connLogoImg = nullptr;
static lv_obj_t* connTitleLabel = nullptr;
static lv_obj_t* connStatusLabel = nullptr;
// Last backlight value pushed to UI::setBrightness. Seeded to the boot-default
// full brightness so the first awake frame is a no-op (matches prior behavior),
// while any later change (sleep, dim-level edit, user brightness) re-applies.
static uint8_t lastAppliedBrightness = 255;

#if defined(BOARD_IPS35)
static lv_obj_t* btnRotate = nullptr;
static lv_obj_t* lblRotate = nullptr;
#endif

// Manual swipe detection — LVGL gesture events unreliable on some touch drivers (GT911)
static lv_point_t touchStart;
static bool tracking = false;
static constexpr int SWIPE_THRESHOLD = 40;  // minimum pixels for swipe

static void gestureEvent(lv_event_t* e) {
    lv_dir_t dir = lv_indev_get_gesture_dir(lv_indev_active());
    if (dir == LV_DIR_TOP) {
        lockState();
        g_state.timelineView = true;
        unlockState();
    }
}

static void screenTouchEvent(lv_event_t* e) {
    lv_event_code_t code = lv_event_get_code(e);

    if (code == LV_EVENT_PRESSED) {
        lv_indev_t* indev = lv_indev_active();
        if (indev) {
            lv_indev_get_point(indev, &touchStart);
            tracking = true;
        }
    } else if (code == LV_EVENT_RELEASED && tracking) {
        tracking = false;
        lv_point_t touchEnd;
        lv_indev_t* indev = lv_indev_active();
        if (indev) {
            lv_indev_get_point(indev, &touchEnd);
            int dy = touchEnd.y - touchStart.y;
            int dx = touchEnd.x - touchStart.x;
            int absDy = (dy < 0) ? -dy : dy;
            int absDx = (dx < 0) ? -dx : dx;
            if (absDy > SWIPE_THRESHOLD && absDy > absDx) {
                if (dy < 0) {
                    // Swipe up → timeline
                    lockState();
                    g_state.timelineView = true;
                    unlockState();
                }
            }
        }
    } else if (code == LV_EVENT_SHORT_CLICKED) {
        // Tap → toggle HUD visibility (only if no swipe detected)
        HUD::setVisible(!HUD::isVisible());
    }
}

static void set_card_border_opa_cb(void* var, int32_t val) {
    lv_obj_set_style_border_opa((lv_obj_t*)var, val, 0);
}

namespace Screens {

lv_obj_t* aquariumCreate() {
    screen = lv_obj_create(NULL);
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x2A1F14), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
#else
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x000000), 0);
#endif
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);

    // Create terrarium canvas (full screen)
    Terrarium::init(screen);

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    // Compact panels: simplified overlay (state + activity switching)
    TTGO::Overlay::init(screen);
#else
    // Create HUD overlay
    HUD::init(screen);
#endif

    // Connection overlay — full-screen scrim + centered card (Android/Apple style)
    connScrim = lv_obj_create(screen);
    lv_obj_set_size(connScrim, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_color(connScrim, lv_color_hex(0x070B13), 0);
    lv_obj_set_style_bg_opa(connScrim, 255, 0);   // Always 100% opaque to prevent blending with garbage background memory
    lv_obj_set_style_border_width(connScrim, 0, 0);
    lv_obj_set_style_radius(connScrim, 0, 0);
    lv_obj_set_style_pad_all(connScrim, 0, 0);
    lv_obj_align(connScrim, LV_ALIGN_CENTER, 0, 0);
    lv_obj_add_flag(connScrim, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(connScrim, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_flag(connScrim, LV_OBJ_FLAG_EVENT_BUBBLE);
    lv_obj_clear_flag(connScrim, LV_OBJ_FLAG_SCROLLABLE);

    // Card container (centered in scrim)
    connCard = lv_obj_create(connScrim);
#if defined(BOARD_TTGO)
    lv_obj_set_width(connCard, 200);
#elif defined(BOARD_ESP32_C6_147)
    lv_obj_set_width(connCard, 160);  // fit within 172px panel width
#elif IS_ROUND
    lv_obj_set_width(connCard, 220);
#else
    lv_obj_set_width(connCard, 260);
#endif
    lv_obj_set_height(connCard, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_color(connCard, lv_color_hex(0x111827), 0);
    lv_obj_set_style_bg_opa(connCard, 255, 0);
    lv_obj_set_style_radius(connCard, 12, 0);
    lv_obj_set_style_border_color(connCard, lv_color_hex(0x38BDF8), 0); // cyan/sky glow border
    lv_obj_set_style_border_width(connCard, 1, 0);
    lv_obj_set_style_border_opa(connCard, 60, 0);
    lv_obj_set_style_pad_ver(connCard, 22, 0);
    lv_obj_set_style_pad_hor(connCard, 16, 0);
    lv_obj_set_style_pad_row(connCard, 10, 0);
    lv_obj_align(connCard, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_flex_flow(connCard, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(connCard, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_clear_flag(connCard, LV_OBJ_FLAG_SCROLLABLE);

    // Card border glow breathing animation
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, connCard);
    lv_anim_set_exec_cb(&a, set_card_border_opa_cb);
    lv_anim_set_values(&a, 40, 180);
    lv_anim_set_duration(&a, 1500);
    lv_anim_set_reverse_duration(&a, 1500);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
    lv_anim_start(&a);

    // Brand logo — AD shield icon
    connLogoImg = lv_image_create(connCard);
    lv_image_set_src(connLogoImg, &img_logo_48);

    // Title "AgentDeck"
    connTitleLabel = lv_label_create(connCard);
    lv_obj_set_style_text_color(connTitleLabel, lv_color_hex(Theme::HUDText), 0);
    lv_obj_set_style_text_font(connTitleLabel, &lv_font_montserrat_20, 0);
    lv_label_set_text(connTitleLabel, "AgentDeck");

    // Status text
    connStatusLabel = lv_label_create(connCard);
    lv_obj_set_style_text_color(connStatusLabel, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(connStatusLabel, &lv_font_montserrat_16, 0);
    lv_label_set_text(connStatusLabel, "");

    // Swipe + tap detection: manual tracking as fallback for LVGL gesture
    lv_obj_add_event_cb(screen, gestureEvent, LV_EVENT_GESTURE, NULL);
    lv_obj_add_event_cb(screen, screenTouchEvent, LV_EVENT_PRESSED, NULL);
    lv_obj_add_event_cb(screen, screenTouchEvent, LV_EVENT_RELEASED, NULL);
    lv_obj_add_event_cb(screen, screenTouchEvent, LV_EVENT_SHORT_CLICKED, NULL);

#if defined(BOARD_IPS35)
    // Rotation button — bottom-right corner, small and unobtrusive
    btnRotate = lv_btn_create(screen);
    lv_obj_set_size(btnRotate, 36, 36);
    lv_obj_align(btnRotate, LV_ALIGN_BOTTOM_LEFT, 8, -8);
    lv_obj_set_style_bg_color(btnRotate, lv_color_hex(0x000000), 0);
    lv_obj_set_style_bg_opa(btnRotate, LV_OPA_50, 0);
    lv_obj_set_style_border_width(btnRotate, 1, 0);
    lv_obj_set_style_border_color(btnRotate, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_border_opa(btnRotate, LV_OPA_40, 0);
    lv_obj_set_style_radius(btnRotate, 8, 0);
    lv_obj_set_style_shadow_width(btnRotate, 0, 0);
    lv_obj_set_style_pad_all(btnRotate, 0, 0);
    lv_obj_add_event_cb(btnRotate, [](lv_event_t* e) {
        lockState();
        g_state.pendingLandscape = !UI::isLandscape();
        g_state.orientationChanged = true;
        unlockState();
    }, LV_EVENT_CLICKED, NULL);

    // Rotation icon: ↻ symbol
    lblRotate = lv_label_create(btnRotate);
    lv_obj_set_style_text_color(lblRotate, lv_color_hex(Theme::HUDText), 0);
    lv_obj_set_style_text_font(lblRotate, &lv_font_montserrat_20, 0);
    lv_label_set_text(lblRotate, LV_SYMBOL_REFRESH);
    lv_obj_center(lblRotate);
#endif

    return screen;
}

void aquariumUpdate(float dt) {
    // Host display sleep → dim/restore ESP32 backlight, honoring the host's
    // dim instruction (enabled / off vs min / level).
    lockState();
    bool displayOn = g_state.hostDisplayOn;
    uint8_t userBright = g_state.userBrightness;
    bool dimEnabled = g_state.hostDimEnabled;
    uint8_t dimMode = g_state.hostDimMode;
    uint8_t dimLevel = g_state.hostDimLevel;
    unlockState();

    // Resolve target backlight. Awake (or dimming disabled) → user brightness;
    // asleep → min level or full-off.
    uint8_t target;
    if (displayOn || !dimEnabled) {
        target = userBright;
    } else if (dimMode == 1) {
        target = dimLevel;  // minimum brightness
    } else {
        target = 0;         // full-off
    }

    // Compare against the last applied value (not just displayOn) so a live
    // dim-level change while the host stays asleep re-applies immediately.
    if (target != lastAppliedBrightness) {
        lastAppliedBrightness = target;
        UI::setBrightness(target);
    }

    // Render terrarium frame only when connection overlay is hidden to save CPU/SPI bandwidth
    bool scrimHidden = true;
    if (connScrim) {
        scrimHidden = lv_obj_has_flag(connScrim, LV_OBJ_FLAG_HIDDEN);
    }

    if (scrimHidden) {
        Terrarium::render(dt);
    }

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    // Compact panels: update simplified overlay
    TTGO::Overlay::update();
#else
    // Update HUD data
    HUD::update();
#endif
}

void aquariumSetConnectionStatus(ConnOverlayStatus status) {
    if (!connScrim || !connStatusLabel) return;

    if (status == ConnOverlayStatus::HIDDEN) {
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
        TTGO::Overlay::setVisible(true);
#endif
        lv_obj_add_flag(connScrim, LV_OBJ_FLAG_HIDDEN);
        return;
    }

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    TTGO::Overlay::setVisible(false);
#endif

    // Show scrim
    lv_obj_clear_flag(connScrim, LV_OBJ_FLAG_HIDDEN);

    switch (status) {
        case ConnOverlayStatus::NO_WIFI:
            lv_label_set_text(connStatusLabel, "No WiFi");
            break;
        case ConnOverlayStatus::SEARCHING:
            lv_label_set_text(connStatusLabel, "Connecting");
            break;
        case ConnOverlayStatus::RECONNECTING:
            lv_label_set_text(connStatusLabel, "Connecting");
            break;
        default:
            break;
    }
}

}  // namespace Screens
