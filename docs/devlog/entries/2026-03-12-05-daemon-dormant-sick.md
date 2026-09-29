# 2026-03-12 — Daemon 가재 DORMANT/SICK 비정상 표시 수정

### 문제
Android Dashboard에서 OpenClaw Gateway 실행 중임에도 가재가 DORMANT(투명) 또는 SICK(기울기+탈색)으로 표시. 3가지 원인이 겹쳐 있었음:

1. **StateMachine 초기 state `DISCONNECTED` 미전환**: Daemon 모드에는 PTY가 없어 `SessionStart` hook이 안 들어옴 → Gateway 연결 후에도 state가 `DISCONNECTED` 유지 → Android에서 `agentType:"openclaw"` + `DISCONNECTED` → DORMANT
2. **초기 probe 후 broadcast 누락**: `probeGateway()` 완료 후 `cachedGatewayAvailable = true` 갱신만 하고 `state_changed` emit 안 함
3. **`openclaw doctor` timeout**: DOCTOR_TIMEOUT 5초인데 실제 실행 7초+ → timeout kill → `gatewayHasError: true` → 가재 SICK

### 해결
1. Gateway 연결(connection event `connected`) 시 StateMachine이 아직 DISCONNECTED이면 `handleHookEvent('SessionStart', {})` 호출 → IDLE 전환
2. 초기 `probeGateway().then()` 완료 후 `stateMachine.emit('state_changed', ...)` 추가 (daemon-server.ts + index.ts)
3. Adapter `.catch()` 에서도 state broadcast 추가 (adapter 실패해도 gatewayAvailable: true 전달)
4. DOCTOR_TIMEOUT 5s → 15s

### 교훈
- **Daemon 모드는 PTY 없이 StateMachine이 `DISCONNECTED`에 고착**: 외부 adapter 연결이 session lifecycle을 대체해야 함
- **`openclaw doctor`는 네트워크 체크 포함 7초+**: execFile timeout은 넉넉하게 (15초)
- **복합 디버깅**: DORMANT(state 문제) → 수정 후 SICK(health check 문제) → 수정 후에도 SICK(다른 bridge가 구 코드) — 3중 원인이 순차적으로 드러남
- **멀티 bridge 환경**: 태블릿이 daemon(9120)이 아닌 session bridge(9121-9123)에 mDNS로 연결될 수 있음 → 모든 bridge가 동일 코드로 실행되어야 일관된 상태 전달

---
