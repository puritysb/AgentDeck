# 2026-03-16 — Display Sleep/Wake 전 기기 밝기 동기화

### 문제
Mac 모니터 sleep 감지(`DisplayMonitor` → `display_state` 이벤트)가 Android만 처리 중. Pixoo64 LED, Stream Deck+, Apple app도 모니터 꺼짐 시 화면을 끄거나 어둡게 해야 함.

### 해결
1. **Shared**: `DISPLAY_FORWARDED_EVENTS`에 `display_state` 추가 → ESP32 `SERIAL_FORWARDED_EVENTS`에도 자동 전파
2. **Pixoo64**: `setBrightness(ip, 0)` + 2FPS 스트림 타이머 정지 (HTTP 요청 절약 → 안정성↑). Wake 시 원래 밝기 복원 + 100ms 후 스트림 재개. `doStreamPush()` guard 추가
3. **SD+ Plugin**: `FORWARDED_EVENTS`에 추가. `displayDimmed` 플래그 + `dimAllActions()` (전체 버튼/LCD에 검정 SVG). `broadcastStateUpdate()` guard로 dimmed 중 렌더 스킵. Wake 시 `broadcastStateUpdate()` 호출로 전체 재렌더
4. **Apple iOS**: `DisplaySyncService` — `UIScreen.main.brightness` save/0/restore. 백그라운드 진입 시 pending 큐잉, foreground 복귀 시 적용. Disconnect 시 safety restore. Settings 토글 추가
5. **ESP32**: 이벤트는 자동 전달되지만 펌웨어 핸들러는 별도 작업

### 교훈 / 핵심 설계 결정
- **Pixoo 스트림 일시정지**: 밝기 0만으로는 부족 — HTTP push 계속하면 디바이스 부하. `clearInterval` + wake 시 `setInterval` 재시작이 깔끔
- **SD+ SDK에 `setBrightness` API 없음**: 하드웨어 밝기 제어 불가 → visual dimming (검정 이미지 일괄 설정)으로 대체
- **iOS 백그라운드 `UIScreen.brightness` 불가**: foreground 복귀 시 queued dim 적용 패턴 필요

---
