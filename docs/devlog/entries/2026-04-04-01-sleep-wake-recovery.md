# 2026-04-04 — Sleep/Wake Recovery 개선

### 문제
Mac 화면 끄고 다시 켰을 때 여러 디바이스/클라이언트 복구 실패:
1. Apple/Android 대시보드에 5h !, 7d ! stale 표시 — usage 갱신 안 됨
2. D200H 울란지 기본 화면 — HID 연결 미복구
3. ESP32 3종 화면 꺼짐 — display_state 미전송
4. TC001 SEARCHING↔agent 깜빡임 — USB 불안정 + 모듈 wake 순차 블록

### 해결
1. **Usage fetch on wake**: Node.js + Swift 양쪽 wake handler에 4초 후 usage fetch 추가. `resetConsecutiveFailures()` 추가 — sleep 전 backoff이 wake 후까지 지속되는 문제 해결
2. **D200H IOHIDManager 전략 전환**: `unschedule/re-schedule`은 이미 매칭된 디바이스에 callback을 다시 발생시키지 않음 → `stop()+start()`로 IOHIDManager 완전 재생성. 미연결시 1회 retry
3. **display_state in initialStateProvider**: ESP32 serial reconnect 시 state_update + usage_update만 보내고 display_state 누락 → 추가
4. **ESP32 2초 USB 안정화 대기**: handleESP32Wake에서 stale 연결 닫고 즉시 re-poll → 2초 대기 후 re-poll
5. **ModuleManager.wakeAll() 병렬화**: `for await` → `withTaskGroup` — D200H의 8초 wake가 serial/pixoo를 블록하여 이중 연결 발생하는 문제 해결

### 핵심 설계 결정
- **IOKit matching callback**: `IOHIDManagerScheduleWithRunLoop` re-schedule로는 already-present 디바이스 callback이 재발생하지 않음. 반드시 IOHIDManager를 파괴하고 새로 생성해야 함
- **Module wake 병렬화**: 디바이스 모듈은 서로 독립적이므로 병렬 wake가 안전. D200H의 긴 wake 시간이 다른 모듈을 블록하는 것은 불필요한 지연
- **Usage backoff reset on wake**: sleep 시간은 항상 Retry-After 기간보다 길므로, wake 시 backoff 초기화가 안전
