# 2026-04-12 — Usage Stale Fallback + Display-Wake Recovery

### 문제
1. **재시작 후 usage 빈 화면** — `fetchUsage()` 가 file cache stale + network fail 시 캐시 데이터를 버리고 nil 반환. backoff 겹치면 90초+ 동안 usage 없음.
2. **`!` 깜빡임** — `fetchUsageRelayed()` 실패 경로에서 매번 `apiUsageStale=true`. 2분 전 캐시여도 네트워크 한 번 실패하면 `!`.
3. **모니터 off→on 후 stale 상태** — `DisplayMonitor` wake 콜백이 `display_state` broadcast 만 수행. serial reconnect / 모듈 wake / state 재방송 없음. `kIOMessageSystemHasPoweredOn` 은 system sleep 에만 울림.
4. **serial errno=6 잔상** — 포트 재오픈 성공해도 `lastReadError` 가 `closeAllConnections()` 에서만 초기화.

### 해결
- `UsageAPIClient.fetchUsage()`: `staleFallback` 변수. 모든 `return nil` → `return staleFallback`.
- `DaemonServer.fetchUsageRelayed()`: 실패 경로의 `apiUsageStale = true` 2건 제거. 10분 TTL 만으로 stale 판단.
- `DaemonServer` display wake 콜백: `moduleManager.wakeAll()` + session prune + state broadcast 추가.
- `AgentStateHolder`: `NSWorkspace.screensDidWakeNotification` 구독 추가 (IOKit system-wake 와 병행).
- `ESP32Serial.openAndRegisterPort()`: `lastReadError = nil`.

### 핵심 설계 결정
- **stale ≠ unavailable**: 캐시 usage 는 네트워크 일시 장애와 무관하게 유효. `!` 는 10분+ 갱신 불가 시에만.
- **display sleep ≠ system sleep**: 모니터만 끄는 건 `kIOMessageSystemHasPoweredOn` 을 발생시키지 않음. `screensDidWakeNotification` (대시보드) + `DisplayMonitor` CoreGraphics 폴링 (데몬) 으로 각각 잡아야 함.

---
