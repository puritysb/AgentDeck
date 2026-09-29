# 2026-04-03 — CLI Daemon Parity for Engine Snapshot + Antigravity + MLX

### 문제
최근 엔진 상태 섹션(`OpenClaw / OLLAMA / MLX / Subscriptions / Antigravity`)과 MLX/Antigravity probe 보강은 주로 Swift daemon 경로에 먼저 반영돼 있었다. 그 결과 기존 Node CLI daemon은 같은 Dashboard를 띄워도 다음 차이가 남아 있었다.

- `usage_update`에 `modelCatalog`와 `antigravityStatus`가 빠져 초기 동기화가 약했음
- `state_update`에 `mlxModels`, `subscriptions`, `antigravityStatus`가 없어 Dashboard 섹션이 경로마다 다르게 채워졌음
- MLX probe가 `/v1/models`만 가정해, `/models`를 쓰는 로컬 MLX 서버를 빈 상태로 오인했음
- Antigravity 로컬 quota는 Swift daemon에서만 보이고 CLI daemon에서는 비어 있었음
- OpenClaw model catalog / Ollama / MLX 값이 바뀌어도 partial event만 보내 초기 화면이 엇갈릴 수 있었음

### 해결
- `bridge/src/mlx-probe.ts`
  - MLX probe를 `/v1/models` 우선, `/models` fallback으로 확장
- `bridge/src/antigravity-local.ts`
  - `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`를 직접 읽는 local-only Antigravity parser 추가
  - `planName`, `availableCredits`, `minimumCreditAmountForUsage` 추출
- `bridge/src/usage-event.ts`
  - `buildUsageEvent()`가 `modelCatalog`, `antigravityStatus`까지 포함하도록 확장
  - `buildSubscriptions()`를 공용 helper로 분리
- `bridge/src/bridge-core.ts`
  - `state_update`와 `usage_update` 양쪽에 공통 엔진 스냅샷이 실리도록 정리
  - `mlxModels`, `subscriptions`, `antigravityStatus`를 state payload에 포함
  - `cachedAntigravityStatus` 캐시 추가
  - `startOllamaProbe()` / `startMlxProbe()`가 값 변경 시 즉시 `state_changed`를 emit하도록 보강
  - `startAntigravityProbe()` 추가
- `bridge/src/index.ts`, `bridge/src/daemon-server.ts`
  - `model_catalog` 수신 시 partial `state_update` 대신 `core.buildStateEvent()` + `broadcastUsage()`로 full snapshot 재전송
  - CLI session / daemon startup 모두 `startAntigravityProbe()` 시작
- `bridge/src/types.ts`
  - protocol 타입은 `@agentdeck/shared/protocol`에서 직접 재수출하도록 정리해 workspace 타입 해석 안정화

### 핵심 설계 결정
- **Swift와 CLI daemon은 같은 엔진 상태 스냅샷 규약을 써야 한다.** 특정 UI가 어느 daemon에 붙느냐에 따라 `OpenClaw / MLX / Subscriptions / Antigravity` 표시가 달라지면 안 된다.
- **Antigravity는 local-only 유지**: cloud/API fallback 없이, 로컬 IDE가 저장한 상태가 있을 때만 표시한다.
- **probe 변화는 partial patch가 아니라 full snapshot으로 재브로드캐스트**: 초기 연결 이후에 들어온 model catalog / MLX / Antigravity 값도 Dashboard 전체가 일관되게 갱신되도록 맞췄다.

### 검증
- `pnpm --filter @agentdeck/shared typecheck`
- `pnpm --filter @agentdeck/shared build`
- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm --filter @agentdeck/bridge build`
- 결과: 모두 통과

---
