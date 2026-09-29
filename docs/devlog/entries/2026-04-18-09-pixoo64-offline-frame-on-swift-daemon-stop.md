# 2026-04-18 — Pixoo64 OFFLINE frame on Swift daemon stop

### 문제
Swift 인프로세스 데몬이 종료되면 ESP32/D200H/CremaS 는 펌웨어/앱 쪽에서 "Waiting / Reconnecting" 화면으로 전환되지만, Pixoo64 는 stateless HTTP 디바이스라 누구도 프레임을 안 보내면 마지막 크리처 장면에 그대로 얼어붙는다. 사용자 입장에서는 데몬이 죽었는데도 크리처가 살아있는 듯 보여 혼란.

### 해결
Node 브리지의 `stopPixooBridge()` 패턴을 Swift 로 포팅:
- `PixooRenderer.renderDisconnectedFrame()` — 64×64 검정 + 중앙 `#555555` "OFFLINE". 필요한 A–Z 글리프 6자(O/F/F/L/I/N/E)만 `pixelFont` 에 추가, 신규 폰트 시스템 없음.
- `PixooModule.stop()` — render/probe task cancel + await 이후 `pushOfflineFrame()` 호출. 2초 전체 cap (deadline Task 로 `pushes.cancel()`). backoff 상태 device 는 제외.
- `PixooModule.pushFrame()` — `cachedState == "disconnected" && cachedAgentType == nil && cachedSessions.isEmpty` 일 때도 동일 프레임 사용. 앱 부팅 직후 세션 없는 구간의 "빈 수조" 가 아닌 중립 placeholder 표기.

### 핵심 설계 결정
- **크래시(SIGKILL) 시나리오는 스코프 밖** — Swift 쪽 정리 코드가 실행될 기회가 없음. 해결책은 firmware watchdog 이 필요하므로 별건으로 분리.
- **밝기 0 대신 "OFFLINE" 텍스트 선택** — 전원 고장 오해 방지 + Node 브리지 동작과 일관.
- **pushOfflineFrame 은 2s cap 강제** — `pushToDevice` 의 PicID 재동기화가 2번 HTTP 호출로 번질 수 있어(4s worst case) 데몬 shutdown 지연 방지를 위해 Task 레벨에서 cap.

---
