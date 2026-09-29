# 2026-04-03 — Usage 5H Oscillation Fix (Dual Broadcast Path)

### 문제
클라이언트(Android/Apple/TUI)에서 5H rate limit 퍼센트가 두 값 사이를 왔다갔다하는 현상. 예: 5%↔22% oscillation.

### 원인
Swift/Node.js daemon이 `usage_update`를 **두 경로**로 클라이언트에 전송:
1. **SessionFocusRelay**: bridge의 WS `usage_update` pass-through (5s tick, TS `adjustUsagePercent` 이미 적용)
2. **Daemon 자체 `broadcastUsage()`**: HTTP `/usage` relay로 raw 데이터 fetch → Swift/TS `adjustUsagePercent` 적용 (60s poll + 5s tick)

Bridge API poll(90s)과 daemon HTTP relay(60s) 주기가 다르고, API 슬라이딩 윈도우 값이 시간에 따라 변하므로, relay와 daemon 자체 broadcast가 다른 값을 가짐. 또한 HTTP relay 실패 시 stale 캐시를 broadcast하여 차이 확대.

### 해결
SessionFocusRelay가 `usage_update`를 수신하면 daemon의 `cachedApiUsage`를 동기화:
- `onUsageRelayed` 콜백으로 fiveHourPercent/sevenDayPercent를 relay 값으로 덮어씀
- `apiUsagePreAdjusted` 플래그: relay에서 온 값은 이미 adjusted이므로 daemon `buildUsageEvent()`에서 `adjustUsagePercent()` 스킵
- `fetchUsageRelayed()` 성공 시 플래그 리셋 (raw 데이터이므로 adjustment 필요)

### 핵심 설계 결정
- **Single source of truth**: relay가 bridge의 최신 값을 daemon cache에 반영 → daemon tick도 동일 값 broadcast
- **Pre-adjusted 플래그**: 이중 adjustment 방지. TS와 Swift의 `adjustUsagePercent` 차이(grace period 등) 영향 제거
- **양쪽 daemon 수정**: Swift(`DaemonServer.swift` + `SessionFocusRelay.swift`)와 Node.js(`daemon-server.ts` + `bridge-core.ts` + `usage-event.ts`) 모두 동일 패턴 적용

---
