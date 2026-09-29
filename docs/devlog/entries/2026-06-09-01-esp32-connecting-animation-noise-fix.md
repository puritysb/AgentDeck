# 2026-06-09 — ESP32 connecting animation noise fix

### 문제

TTGO, Round AMOLED, IPS 10", 86 Box, IPS 3.5"에 배포된 현재 펌웨어에서 연결 시도/재연결 상태의 애니메이션이 화면 깨짐 또는 노이즈처럼 보였다. 스크린샷 확인 결과 spinner 형태 자체보다 작은 LVGL 객체/텍스트와 부분 redraw가 패널별 flush 경로와 충돌하는 것으로 보여, 고위험 경로를 제거했다.

- 초기 splash 화면의 `lv_spinner` arc 애니메이션이 작은 영역을 고속 invalidate 한다.
- 재연결 overlay가 `aquariumUpdate()` 매 tick마다 full-screen scrim 배경색을 변경해 패널 전체 flush를 유발한다.

### 수정

- `esp32/src/ui/screens/splash.cpp`의 `lv_spinner`와 dot animation을 제거하고, 정적인 opaque splash (`AgentDeck` + `Connecting`)만 표시하도록 변경했다.
- `esp32/src/ui/screens/aquarium.cpp`의 full-screen background pulse와 reconnect indicator animation을 제거하고, 정적인 opaque overlay만 표시하도록 변경했다.
- `esp32/platformio.ini`의 `ips35`, `amoled`, `ips10`, `box_86` upload/monitor 포트를 2026-06-09 실제 성공 포트 매핑과 일치시켰다.

### 검증

- `pio run -d esp32 -e ttgo -e amoled -e ips10 -e box_86 -e ips35` 통과.
- 정적 연결 UI 펌웨어 업로드 성공: `ttgo` (`/dev/cu.wchusbserial58A90021441`), `amoled` (`/dev/cu.usbmodem2111201`), `box_86` (`/dev/cu.wchusbserial211340`), `ips35` (`/dev/cu.usbmodem21133201`).
- `ips10` 빌드는 통과했지만, 업로드 시점에 `/dev/cu.usbmodem101`가 macOS 포트/USB registry에서 감지되지 않아 업로드는 보류했다.

---
