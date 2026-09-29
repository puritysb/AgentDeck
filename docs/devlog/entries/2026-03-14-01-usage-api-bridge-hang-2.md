# 2026-03-14 — Usage API 파싱 실패 + Bridge 종료 hang (2차)

### 문제
1. **Usage LIMITS 미표시**: `usage-cache.json`에 `inferredBillingType: "subscription"`이지만 `fiveHourPercent: null`. API 응답의 `five_hour` 객체는 존재하나 `utilization` 필드가 없거나 구조 변경됨. 429 과다 발생 (bridge 60s + daemon 60s + plugin 60s + Claude Code 자체)
2. **Bridge 종료 hang (2차)**: 이전 세션에서 `adapter.on('exit')` → `shutdown()` 호출 추가했지만, `hookServer.close()`가 열린 SSE/HTTP 연결 대기로 여전히 hang

### 해결
1. **Usage 파싱 resilient**: `parseUtilization()` / `parseResetsAt()` 헬퍼 — `utilization`/`percentage`/`percent`/`usage` + `resets_at`/`resetsAt`/`reset_at`/`expires_at` 다중 필드명 탐색. Raw 응답을 `~/.agentdeck/usage-raw-debug.json`에 덤프하여 실제 구조 확인 가능
2. **429 감소**: 폴 인터벌 60s → 120s, cache TTL 60s → 120s, Retry-After 헤더 존중
3. **종료 hang 해결**: `hookServer.close()` 전에 `server.closeAllConnections()` 호출, stdin `pause()` + `removeAllListeners()`, `BridgeCore.shutdown()` — shutdown callbacks에 2초 budget 후 즉시 `process.exit(0)`

### 교훈 / 핵심 설계 결정
- **API 응답 방어적 파싱**: 외부 API 필드명은 언제든 바뀔 수 있음. 여러 가능한 필드명을 탐색하고 raw 응답 덤프를 항상 남길 것
- **HTTP server.close() 교착**: `server.close()` 콜백은 모든 활성 연결이 닫힐 때까지 호출 안 됨. SSE 같은 장기 연결이 있으면 영원히 대기. 반드시 `closeAllConnections()` 선행 필요
- **다중 폴러 429**: 같은 OAuth 토큰으로 bridge+daemon+plugin이 각자 폴링하면 429 폭발. 공유 파일 캐시(120s TTL)로 실제 API 호출 최소화

---
