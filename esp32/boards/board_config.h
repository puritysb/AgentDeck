#pragma once

// Board-specific pin configurations
// Selected at compile time via -DBOARD_xxx build flags

#if defined(BOARD_IPS35) || defined(BOARD_IPS_35)
    #include "board_35_ips.h"
#elif defined(BOARD_RGB48) || defined(BOARD_BOX_86) || defined(BOARD_86_BOX)
    #include "board_86_box.h"
#elif defined(BOARD_AMOLED) || defined(BOARD_ROUND_AMOLED)
    #include "board_round_amoled.h"
#elif defined(BOARD_IDOTMATRIX)
    #include "board_idotmatrix_s3.h"
#elif defined(BOARD_LED8X32) || defined(BOARD_ULANZI_TC001)
    #include "board_ulanzi_tc001.h"
#elif defined(BOARD_TTGO) || defined(BOARD_TTGO_T_DISPLAY)
    #include "board_ttgo_t_display.h"
#elif defined(BOARD_ESP32_C6_147)
    #include "board_esp32_c6_147.h"
#elif defined(BOARD_IPS10) || defined(BOARD_JC8012P4A1C)
    #include "board_jc8012p4a1c.h"
#else
    #error "No board defined! Use -DBOARD_IPS35, -DBOARD_RGB48, -DBOARD_AMOLED, -DBOARD_LED8X32, -DBOARD_TTGO, -DBOARD_ESP32_C6_147, or -DBOARD_IPS10"
#endif
