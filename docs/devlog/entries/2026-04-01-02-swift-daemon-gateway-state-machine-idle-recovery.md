# 2026-04-01 — Swift Daemon Gateway State Machine Idle Recovery

### 문제
Swift daemon이 OpenClaw Gateway에 WebSocket 연결은 성공하지만 `/health`에서 `state: "disconnected"`로 표시됨. Gateway 프로세스는 정상 동작 중.

### 원인 분석
1. **핵심**: `handleGatewayEvent`의 `gateway_chat` 핸들러가 payload의 `state` 필드(delta/final/aborted/error)를 구분하지 않고 모든 chat 이벤트에 `spinner_start`만 트리거. Node.js bridge는 `final`/`aborted`/`error` 시 `idle` 이벤트를 emit하여 SM을 processing → idle로 복귀시킴.
2. **연쇄**: chat이 processing에 고착 → WS 일시 끊김 → probe가 disconnectGatewayAdapter() 호출 → SM: disconnected → 재연결 시 핸드셰이크 타이밍에 따라 idle 복구 실패 가능
3. **부수**: `onConnectionChanged(false)` 핸들러가 SM을 전환하지 않아 상태 불일치 발생. `gateway.connected`가 adapter 존재 여부만 체크하여 실제 WS 인증 상태 미반영.

### 해결
- chat state 분기: delta→processing, final/aborted/error→idle
- approval resolved 이벤트 전파 + SM 전환
- WS disconnect 시 SM → disconnected 전환 추가
- health의 gateway.connected를 실제 WS isConnected 상태 반영

### 핵심 설계 결정
- Swift daemon의 Gateway 이벤트 처리는 Node.js bridge의 `openclaw.ts` 어댑터 로직과 1:1 대응해야 함. SM 전환 누락 시 상태 드리프트가 누적되어 진단이 어려워짐.
- Actor의 `isConnectedSnapshot`을 async getter로 노출하여 health endpoint에서 안전하게 조회.

---
