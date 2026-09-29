# 2026-07-14 — ESP32 host simulator: 하드웨어 없이 전 보드 화면 픽셀정확 렌더 (`esp32/sim/`)

### 문제
ESP32 보드 화면(LVGL terrarium+HUD, IPS10 office, TC001 matrix, InkDeck e-ink)을 실제 기기 없이 미리 볼 방법이 없었다. Swift Device Preview의 ESP32 타일은 펌웨어를 눈으로 재현한 손그림(T3 tier)이라 원본과 drift 위험이 상존했고, 펌웨어 렌더 로직 변경을 플래시 전에 검증할 수단이 없었다.

### 해결
`esp32/sim/` — standalone PlatformIO `platform=native` 프로젝트. 펌웨어 렌더 소스를 **verbatim 컴파일**(보드별 `BOARD_*`/`SCREEN_W/H` 그대로)해 headless 프레임버퍼에 그린 뒤 자체 PNG 인코더(stored DEFLATE+CRC32/Adler32, 무의존)로 덤프. "그 보드 펌웨어 − 하드웨어 I/O"라 픽셀정확. `pnpm esp32:sim` → 7보드 × 5씬(+matrix 2페이지) = 40 결정론적 PNG.
- **LCD 4보드**(box_86 480², ips35 480×320, amoled 360² round, ttgo 135×240) + **IPS10 태블릿**(1280×800 office+mosaic)은 실제 `Screens::aquariumCreate()` 보드별 빌더로 합성 — 손조립 아님.
- **TC001 matrix**(led8x32): LVGL-free CRGB 페이지 렌더러(usage/agents) ×16 업스케일.
- **InkDeck e-ink**(inkdeck 800×480): 실제 direct-draw GxEPD2 트리. 텍스트는 vendored upstream Adafruit GFX core+FreeFont(BSD, hardware-coupled SPITFT 제외)로 픽셀정확; `GxEPD2_BW` 셰임이 `Adafruit_GFX` 서브클래스로 drawPixel만 1-bit 버퍼로 뺌.
- 하드웨어 셰임(`sim/shims/`): Arduino/esp_heap_caps/freertos/FastLED/WiFi/Print/SPI/GxEPD2/U8g2/net — millis/Serial/heap/mutex/CRGB/GFX-Print/net-status만 스텁. 씬은 실제 `g_state`를 채워 session→creature/card 파생을 그대로 태움.

### 핵심 설계 결정 (재사용 교훈)
- **per-env 오브젝트 격리 필수**: 펌웨어 소스를 `build_src_filter`의 `../..` 경로로 직접 참조하면 오브젝트가 env 무관 shared `.pio/build/src/`에 떨어져 보드 `#if`(IS_ROUND/canvas swap/MAX_*)가 먼저 빌드된 env로 **동결**(round 마스크가 rect 보드로 샘). Fix=`src/{fw,mtx,eink}/`의 unity-include 래퍼(`#include "../../../src/..."`)로 sim src_dir 내부 컴파일 강제 → `.pio/build/<env>/` 격리. per-env `build_src_filter`로 표면 격리(fw=LCD, mtx=matrix, eink=e-ink).
- **LVGL stride 패딩 오버런**: width×2가 32배수 아닌 보드(360 amoled, 135 ttgo)는 tight 버퍼가 LVGL의 `LV_DRAW_BUF_STRIDE_ALIGN` 패딩과 안 맞아 heap 손상 크래시(stderr無). Fix=`lv_draw_buf_width_to_stride()`로 버퍼 잡고 flush에서 stride-aware 복사.
- **anon-namespace 전역은 별도 TU에서 extern 불가**: InkDeck `display`가 익명 네임스페이스 → SimEink 진입점을 eink wrapper TU 안(include 뒤)에 정의해야 접근.
- **logo asset은 `.c`로 컴파일**: C++ 래퍼로 include 시 `const lv_image_dsc_t`가 internal linkage → `img_logo_48` undefined.
- 상세 [[esp32-host-simulator]]. 문서 `esp32/sim/README.md` + `docs/esp32.md`.

### 검증
7 env(box_86/ips35/amoled/ttgo/ips10/led8x32/inkdeck) clean 빌드 + 40 PNG 렌더 성공, 시각 확인(터라리움 크리처·HUD 게이지·IPS10 office 그리드·TC001 스프라이트·InkDeck 대시보드). 동일 씬 2회 렌더 byte-identical(결정론). 커밋 `42e3f0c0`(터라리움 3보드) + `0301e43d`(전 표면).
