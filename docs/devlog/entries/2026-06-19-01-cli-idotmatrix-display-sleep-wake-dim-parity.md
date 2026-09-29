# 2026-06-19 — CLI iDotMatrix display sleep/wake dim parity 점검 및 수정

### 문제
macOS 모니터 sleep/wake 시 `display_state` 동기화 경로를 점검한 결과, Node CLI daemon의 Pixoo/D200H/ESP32/Stream Deck/Android 경로와 Swift in-process daemon의 Pixoo/D200H/ESP32/iDotMatrix 경로는 밝기 dim/restore를 처리했지만, **CLI-only iDotMatrix**는 Python BLE sync가 `/pixoo/frame?size=32`만 폴링하고 고정 brightness를 60초마다 재주장해 host display off/on을 반영하지 않았다.

### 해결
- Node daemon에 `GET /display-state`를 추가해 현재 `displayOn`과 `displaySleepDim` 설정(`enabled/mode/level`)을 JSON으로 노출.
- `bridge/src/idotmatrix/sync.py`가 `/display-state`를 폴링해 display off 시 `off=5%`(iDotMatrix 하드웨어 floor), `min=level%`, wake 시 설정 brightness로 복원하도록 수정.
- dimmed 상태에서는 BLE 프레임 업로드를 멈춰 Swift iDotMatrixModule의 `displayDimmed` guard와 동작을 맞춤.

### 핵심 설계 결정
- iDotMatrix는 BLE 밝기 명령 범위가 5~100이라 true-off 대신 5%를 practical off floor로 사용한다. 이는 Swift 네이티브 iDotMatrix 경로와 동일한 정책이다.
- `/display-state`가 없는 구형/session-only bridge에 붙은 수동 sync는 기존처럼 설정 brightness를 유지하도록 graceful fallback.

---
