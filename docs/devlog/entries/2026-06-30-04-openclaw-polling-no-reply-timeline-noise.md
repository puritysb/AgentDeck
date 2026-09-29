# 2026-06-30 — OpenClaw polling NO_REPLY timeline noise 필터 패리티

### 문제
OpenClaw cron/polling 흐름이 "Still translating", "No action needed", `NO_REPLY` 같은 상태 확인 응답을 `chat_response`/automated `chat_start`로 남겨 Android/Apple/shared device timeline에 사용자 작업처럼 보일 수 있었다. 반대로 LINE/userId 알림 실패 같은 실제 조치 필요 신호는 숨기면 안 된다.

### 해결
- shared `timeline.ts`, Swift `DaemonTimelineStore`, Android `TimelineDisplay.kt`에 `isOpenClawLowSignalResponse` 필터를 추가.
- polling/no-op 응답과 automated polling start는 storage/display low-signal로 제거.
- LINE notification/userId/target ID 실패·미설정·pending 신호는 예외로 유지.
- shared, Swift XCTest, Android unit test에 polling drop / notification failure keep 회귀 케이스 추가.

### 검증
- `pnpm build` 성공.
- Android `:app:testDebugUnitTest` 성공.
- macOS `AgentDeck_macOS` build 성공.

---
