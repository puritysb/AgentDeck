#pragma once

#include <lvgl.h>

enum class ConnOverlayStatus {
    HIDDEN,         // 연결됨 — 오버레이 숨김
    NO_WIFI,        // WiFi 미연결 (스피너 없음)
    SEARCHING,      // WiFi OK, 브리지 탐색 중
    PAIRING_REQUIRED, // A confirmed auth refusal; retries need trusted provisioning.
    RECONNECTING,   // 연결 끊김 후 재연결 중
};

namespace Screens {

/**
 * Create the aquarium (main) screen with terrarium + HUD.
 */
lv_obj_t* aquariumCreate();

/**
 * Called every frame (~30fps) to animate.
 */
void aquariumUpdate(float dt);

/**
 * Resolve the host-display dim instruction (off / min / restore) into a backlight
 * level and apply it. Called every frame from the main loop regardless of the
 * active view, so the panel sleeps with the Mac on the timeline/detail views too —
 * not only on the aquarium. No-op when the target equals the last applied level.
 */
void applyHostDimBrightness();

/**
 * Set connection overlay status (full-screen scrim with card).
 */
void aquariumSetConnectionStatus(ConnOverlayStatus status);

}  // namespace Screens
