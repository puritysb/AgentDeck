# 2026-04-16 — Swift Pixoo module circuit breaker

### 문제
Pixoo 기기 무응답 시 Swift daemon이 333ms마다 2s timeout HTTP 요청을 무한 생성 → URLSession pool starvation → BridgeConnection WS ping cancelled → "bridge data stale" → reconnect loop → Timeline에 Connected/Disconnected 반복. Node.js bridge에는 circuit breaker가 있었으나 Swift daemon에는 없었음.

### 해결
Node.js bridge 패턴(`pixoo-client.ts:40-157`) 포팅: 6회 연속 실패 → exponential backoff (5s–60s cap), 별도 probe Task가 10초마다 `GetAllConf`로 복구 감지, 성공 시 PicID resync + channel 재설정 후 push 재개. `statusSnapshot()`에 per-device `online`/`backedOff`/`failures` 추가.

### 핵심 설계 결정
- Pixoo HTTP API에 reboot 명령이 없으므로, circuit breaker + probe가 최선의 자동 복구 전략
- Backoff 진입 시 사용자 안내 로그: `"Power-cycle the device if it doesn't recover."`
- probe 주기 10초 (Node.js의 5초보다 여유 — Swift는 per-request ephemeral session이라 리소스 비용 더 높음)

---
