#include "aquarium.h"
#include <Arduino.h>
#include "../terrarium/renderer.h"
#include "../terrarium/office.h"
#include "../widgets/hud_bar.h"
#include "../display.h"
#include "../theme.h"
#include "../assets/logo.h"
#include "../../state/agent_state.h"
#include "config.h"
#if defined(BOARD_TTGO)
#include "../widgets/ttgo_usage.h"
#endif

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

static void screenTouchEvent(lv_event_t* e) {
    if (lv_event_get_code(e) == LV_EVENT_SHORT_CLICKED) {
#if !defined(BOARD_IPS10)
        // Tap → toggle HUD visibility. Small round/TTGO panels hide the HUD to reveal
        // the full terrarium.
        HUD::setVisible(!HUD::isVisible());
#endif
        // IPS10 tablet layout: the cards pane is a permanent side-by-side surface, not a
        // toggleable overlay — a tap on the left terrarium must NOT blank the right cards.
        // (Tapping a card still opens its modal via the cell's own handler.)
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

    // Create the living scene. IPS10 uses the sprite/dirty-rect "office" (cheap on the big
    // panel — only moving agents flush); other boards keep the per-pixel aquarium terrarium.
#if defined(BOARD_IPS10)
    // IPS10 workspace owns the whole display; no decorative office behind it.
#else
    Terrarium::init(screen);
#endif

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    // Compact panels: simplified overlay (state + activity switching)
    TTGO::Overlay::init(screen);
#if defined(BOARD_TTGO)
    TTGO::Usage::create(screen);
    if (TTGO::Usage::active()) {
        lv_obj_add_flag(Terrarium::getCanvas(), LV_OBJ_FLAG_HIDDEN);
        TTGO::Overlay::setVisible(false);
    }
#endif
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
    int cardW;
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    cardW = g_screenW - 16;
    if (cardW > 260) cardW = 260;
#elif IS_ROUND
    cardW = 220;
#else
    cardW = 260;
#endif
    lv_obj_set_width(connCard, cardW);
    lv_obj_set_height(connCard, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_color(connCard, lv_color_hex(0x111827), 0);
    lv_obj_set_style_bg_opa(connCard, 255, 0);
    lv_obj_set_style_radius(connCard, 12, 0);
    lv_obj_set_style_border_color(connCard, lv_color_hex(0x38BDF8), 0); // cyan/sky glow border
    lv_obj_set_style_border_width(connCard, 1, 0);
    lv_obj_set_style_border_opa(connCard, 60, 0);

    bool useRowLayout = (g_screenH < 150);
    if (useRowLayout) {
        lv_obj_set_style_pad_ver(connCard, 10, 0);
        lv_obj_set_style_pad_hor(connCard, 12, 0);
        lv_obj_set_style_pad_row(connCard, 12, 0); // Spacing between logo and text column
        lv_obj_set_flex_flow(connCard, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(connCard, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    } else {
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
        lv_obj_set_style_pad_ver(connCard, 12, 0);
        lv_obj_set_style_pad_hor(connCard, 12, 0);
        lv_obj_set_style_pad_row(connCard, 8, 0);
#else
        lv_obj_set_style_pad_ver(connCard, 22, 0);
        lv_obj_set_style_pad_hor(connCard, 16, 0);
        lv_obj_set_style_pad_row(connCard, 10, 0);
#endif
        lv_obj_set_flex_flow(connCard, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(connCard, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    }

    lv_obj_align(connCard, LV_ALIGN_CENTER, 0, 0);
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

    // Text column (only nested inside card if in row layout mode)
    lv_obj_t* textCol = connCard;
    if (useRowLayout) {
        textCol = lv_obj_create(connCard);
        lv_obj_set_size(textCol, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_set_style_bg_opa(textCol, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(textCol, 0, 0);
        lv_obj_set_style_pad_all(textCol, 0, 0);
        lv_obj_set_style_pad_row(textCol, 2, 0); // Tight spacing between Title & Status
        lv_obj_set_flex_flow(textCol, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(textCol, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
        lv_obj_clear_flag(textCol, LV_OBJ_FLAG_SCROLLABLE);
    }

    const lv_font_t* titleFont = &lv_font_montserrat_20;
    const lv_font_t* statusFont = &lv_font_montserrat_16;
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    if (g_screenH < 150) {
        titleFont = &lv_font_montserrat_14;
        statusFont = &lv_font_montserrat_12;
    } else {
        titleFont = &lv_font_montserrat_16;
        statusFont = &lv_font_montserrat_12;
    }
#endif

    // Title "AgentDeck"
    connTitleLabel = lv_label_create(textCol);
    lv_obj_set_style_text_color(connTitleLabel, lv_color_hex(Theme::HUDText), 0);
    lv_obj_set_style_text_font(connTitleLabel, titleFont, 0);
    lv_label_set_text(connTitleLabel, "AgentDeck");

    // Status text
    connStatusLabel = lv_label_create(textCol);
    lv_obj_set_style_text_color(connStatusLabel, lv_color_hex(Theme::HUDDim), 0);
    lv_obj_set_style_text_font(connStatusLabel, statusFont, 0);
    lv_label_set_text(connStatusLabel, "");

    // Tap detection: toggle HUD visibility.
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

void applyHostDimBrightness() {
    // Host display sleep → dim/restore ESP32 backlight, honoring the host's
    // dim instruction (enabled / off vs min / level). Driven every frame from the
    // main loop so it applies on every view (aquarium, timeline, detail), not just
    // the aquarium — otherwise the panel stays lit when the Mac sleeps while the
    // user left it on the timeline/detail screen.
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
}

void aquariumUpdate(float dt) {
    // Render terrarium frame only when connection overlay is hidden to save CPU/SPI bandwidth
    bool scrimHidden = true;
    if (connScrim) {
        scrimHidden = lv_obj_has_flag(connScrim, LV_OBJ_FLAG_HIDDEN);
    }

#if defined(IPS10_PERF_FORCE_RENDER)
    scrimHidden = true;  // TEMP: force render while disconnected so [PERF] can be read on serial
#endif
    bool renderScene = scrimHidden;
#if defined(BOARD_TTGO)
    // Usage mode is a quiet, opaque dashboard: no scene rendering/SPI animation.
    const bool usageOnly = TTGO::Usage::active();
    if (usageOnly) lv_obj_add_flag(Terrarium::getCanvas(), LV_OBJ_FLAG_HIDDEN);
    else lv_obj_clear_flag(Terrarium::getCanvas(), LV_OBJ_FLAG_HIDDEN);
    TTGO::Overlay::setVisible(!usageOnly && scrimHidden);
    TTGO::Usage::update();
    renderScene = renderScene && !usageOnly;
#endif
    if (renderScene) {
#if defined(BOARD_IPS10)
        // Workspace updates bounded LVGL widgets in HUD::update().
#else
        Terrarium::render(dt);
#endif
    }

#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147)
    // Compact panels: update simplified overlay
#if defined(BOARD_TTGO)
    if (!usageOnly)
#endif
    TTGO::Overlay::update();
#else
    // Update HUD data
    HUD::update();
#endif
}

void aquariumSetConnectionStatus(ConnOverlayStatus status) {
#if defined(BOARD_IPS10)
    // The workspace retains inspectable last-known work with an offline banner.
    // Do not cover the whole working surface during a temporary reconnect.
    return;
#endif
    if (!connScrim || !connStatusLabel) return;

    // Diagnostic: scrim transitions are the prime suspect for "black screen"
    // reports on small panels (scrim bg 0x070B13 reads as black)
    Serial.printf("[Conn] overlay status=%d\n", (int)status);

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
        // Labels follow the connection-state lexicon (shared/src/connection-status.ts):
        // never-connected discovery reads "Searching...", a lost link reads
        // "Reconnecting..." — the two phases must stay distinguishable.
        case ConnOverlayStatus::SEARCHING:
            lv_label_set_text(connStatusLabel, "Searching...");
            break;
        case ConnOverlayStatus::RECONNECTING:
            lv_label_set_text(connStatusLabel, "Reconnecting...");
            break;
        default:
            break;
    }
}

}  // namespace Screens
