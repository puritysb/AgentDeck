# 2026-03-22 — Ulanzi TC001 LED Matrix 보드 추가

### 문제
새 ESP32 디바이스 Ulanzi TC001 추가. 기존 3대(ESP32-S3 + LCD/AMOLED)와 완전히 다른 하드웨어: ESP32 classic (D0WD), 8MB flash, no PSRAM, **WS2812B 8×32 LED matrix** (LCD 아님).

### 해결
1. **하드웨어 인식**: USB 연결 초기 미인식 → CH340 드라이버 설치 시도 중 USB 방향 바꿔 끼우니 인식됨. `esptool chip_id`로 ESP32-D0WD 확인
2. **팩토리 백업**: `esptool --no-stub read_flash` (115200 baud, ~10분 소요) → `esp32/backups/ulanzi-tc001-factory-8MB.bin`
3. **별도 렌더링 경로**: LVGL은 8×32에 사용 불가 → FastLED로 직접 픽셀 제어. `build_src_filter`로 LVGL 소스 제외 + `#ifdef BOARD_ULANZI_TC001`로 cpp guard
4. **4페이지 대시보드**: USAGE(gradient gauge bars), AGENTS(5×6 creature sprites), INFO(model+project), TIMELINE(scroll+density bar)
5. **밝기 튜닝**: 초기 렌더링 색상값이 낮아(~45/255) 밝은 방에서도 어둡게 보임 → 색상값 150-200 레벨로 올리고, auto-brightness 상한 80→200, ADC 매핑 범위 조정(300-2800)

### 교훈 / 핵심 설계 결정
- **WS2812B 밝기 = FastLED brightness × 렌더링 색상값**: brightness를 올려도 색상값이 낮으면 어두움. 양쪽 모두 높여야 함
- **8×32 해상도에서 텍스트보다 컬러가 효과적**: 3×5 폰트로 8자/줄 한계. 게이지 바 그라디언트, 상태별 색상, 스프라이트 아이콘이 더 직관적
- **ESP32 classic vs S3 격리**: `board = esp32dev` (not esp32-s3-devkitc-1), no PSRAM flag, no USB CDC, STACK_UI 4096 (vs 16384)
- **PIO upload hang 우회**: PlatformIO mirror(contabostorage) 접속 불가 시 `pio run -t upload`가 무한 재시도. `esptool.py` 직접 사용으로 우회
- **Serpentine wiring**: `idx = (y%2==0) ? y*32+x : y*32+(31-x)` — TC001 실기기에서 확인 완료

---
