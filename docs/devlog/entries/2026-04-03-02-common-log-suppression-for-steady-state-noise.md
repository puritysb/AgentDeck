# 2026-04-03 — Common Log Suppression for Steady-State Noise

### 문제
- Pixoo뿐 아니라 ESP32 serial, usage relay 같은 steady-state 경로도 반복 debug 로그가 많아 실제 장애 로그가 묻혔다.
- 정상 상태를 매번 출력하는 대신, 상태 변화와 반복 실패 요약이 더 중요했다.

### 해결
- `DaemonLogger.swift`
  - `throttledDebug(category:key:message:minInterval:)` 추가
  - `sampledDebug(category:key:every:message:)` 추가
- `ESP32Serial.swift`
  - 반복되는 open 실패 / read exit / incoming message type 로그를 suppression 정책으로 전환
  - serial open 성공은 debug가 아니라 명확한 상태 전이로 `info`로 남김
- `DaemonServer.swift`
  - usage relay 시작 / per-port relay / tier1 failure / tier3 fallback 로그를 샘플링 또는 throttling 적용

### 검증
- `pnpm --filter @agentdeck/bridge typecheck`
- 결과: 통과
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataLogPolicy build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`
