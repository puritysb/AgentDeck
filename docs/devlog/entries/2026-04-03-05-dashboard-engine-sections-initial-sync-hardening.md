# 2026-04-03 — Dashboard Engine Sections Initial Sync Hardening

### 문제
macOS Dashboard의 `OpenClaw / OLLAMA / MLX / Subscriptions` 섹션이 의도한 구조로 렌더되더라도, 초기 연결 시점에는 일부 섹션이 비어 보일 수 있었다. 원인은 엔진 상태가 서로 다른 이벤트 경로에 흩어져 있었기 때문이다.

- `modelCatalog`는 주로 `state_update`에만 실려 `OpenClaw` 섹션이 빈 채 남을 수 있었음
- `OLLAMA / MLX / Subscriptions`는 `usage_update` 중심이라 probe가 이미 끝났더라도 UI 반영이 늦을 수 있었음
- Gateway model catalog / Ollama / MLX probe 값이 바뀌어도 즉시 브로드캐스트되지 않는 경로가 있었음

### 해결
- `DaemonServer.swift`
  - `modelCatalog + ollamaStatus + mlxModels + subscriptions`를 공통 엔진 상태 스냅샷으로 묶어 `state_update`와 `usage_update` 양쪽에 모두 포함
  - Gateway `model_catalog` 수신 시 `broadcastStateUpdate()`와 함께 `broadcastUsage()`도 수행
  - sibling relay를 통한 model catalog merge 시에도 즉시 두 이벤트를 모두 재브로드캐스트
  - Gateway disconnect로 model catalog가 비워질 때도 상태/usage를 같이 갱신
  - Ollama / MLX probe 결과가 이전 값과 달라지면 즉시 상태/usage를 같이 브로드캐스트
- `Protocol.swift` / `shared/src/protocol.ts` / Android `Protocol.kt`
  - `UsageEvent`/`UsageUpdate`에 `modelCatalog` 추가
  - `StateUpdateEvent`/`StateUpdate`에 `mlxModels`, `subscriptions` 추가
- `AgentStateHolder.swift` / Android `AgentState.kt`
  - `state_update`와 `usage_update` 어느 쪽으로 오더라도 engine section 데이터가 상태에 반영되도록 처리

### 검증
- `pnpm --filter @agentdeck/shared typecheck`
- 결과: 통과
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataDashboardSync build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`
