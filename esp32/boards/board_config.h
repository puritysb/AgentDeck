#pragma once

// Board-specific pin configurations
// Selected at compile time via -DBOARD_xxx build flags

#if defined(BOARD_IPS35) || defined(BOARD_IPS_35)
    #include "board_35_ips.h"
#elif defined(BOARD_BOX_86) || defined(BOARD_86_BOX)
    #include "board_86_box.h"
#elif defined(BOARD_AMOLED) || defined(BOARD_ROUND_AMOLED)
    #include "board_round_amoled.h"
#elif defined(BOARD_LED8X32) || defined(BOARD_ULANZI_TC001)
    #include "board_ulanzi_tc001.h"
#elif defined(BOARD_TTGO) || defined(BOARD_TTGO_T_DISPLAY)
    #include "board_ttgo_t_display.h"
#elif defined(BOARD_ESP32_C6_147)
    #include "board_esp32_c6_147.h"
#elif defined(BOARD_IPS10) || defined(BOARD_JC8012P4A1C)
    #include "board_jc8012p4a1c.h"
#elif defined(BOARD_INKDECK)
    #include "board_inkdeck.h"
#elif defined(BOARD_T_EMBED)
    #include "board_t_embed.h"
#elif defined(BOARD_T_DISPLAY_PRO)
    #include "board_t_display_pro.h"
#else
    #error "No board defined! Use -DBOARD_IPS35, -DBOARD_BOX_86, -DBOARD_AMOLED, -DBOARD_LED8X32, -DBOARD_TTGO, -DBOARD_ESP32_C6_147, or -DBOARD_IPS10"
#endif

/**
 * The board's wire name — the exact string the daemon keys every board-scoped
 * decision on (`device_info.board`, OTA target, per-board voice sink, the
 * `agentdeck devices` row).
 *
 * One definition, because there are now two producers of it. `device_info`
 * carries it after a socket is up; the WebSocket URL carries it *before* — so a
 * board the daemon refuses can still say what it is, which is the difference
 * between "some IP is hammering port 9120" and "the 86box needs its token
 * re-armed". A second #ifdef ladder is how the two would come to disagree, and
 * the wrong answer here silently mis-targets an OTA.
 */
inline const char* agentdeckBoardName() {
    #if defined(BOARD_LED8X32) || defined(BOARD_ULANZI_TC001)
        return "ulanzi_tc001";
    #elif defined(BOARD_INKDECK)
        return "inkdeck";
    #elif defined(BOARD_TTGO) || defined(BOARD_TTGO_T_DISPLAY)
        return "ttgo_t_display";
    #elif defined(BOARD_T_EMBED)
        return "t_embed";
    #elif defined(BOARD_T_DISPLAY_PRO)
        return "t_display_pro";
    #elif defined(BOARD_ESP32_C6_147)
        return "esp32_c6_147";
    #elif defined(BOARD_AMOLED) || defined(BOARD_ROUND_AMOLED)
        return "round_amoled";
    #elif defined(BOARD_BOX_86) || defined(BOARD_86_BOX)
        return "86box";
    #elif defined(BOARD_IPS10) || defined(BOARD_JC8012P4A1C)
        return "ips_10";
    #else
        return "ips_35";
    #endif
}
