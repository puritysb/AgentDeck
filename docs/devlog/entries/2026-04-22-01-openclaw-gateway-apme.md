# 2026-04-22 — OpenClaw Gateway 타임라인 × APME 연동 + 상태 정확도 수정

### 문제
1. OpenClaw 타임라인에 "Prompt sent" 플레이스홀더만 표시 (실제 텍스트 없음)
2. OpenClaw 활동 상태가 Claude Code와 교차 오염됨 (shared stateMachine)
3. APME 평가 파이프라인이 OpenClaw와 완전 단절
4. Gateway 연결 불안정 + 순간 끊김 시 "Not configured" 표시

### 해결

**상태 격리 (DaemonServer.swift)**
- `gatewaySessionState` / `gatewayCurrentTool` / `gatewayModelName` — gateway 전용 필드 추가
- `handleGatewayEvent()`에서 `stateMachine.transition()` 제거 → shared stateMachine은 Claude Code hooks만 담당
- `buildSessionsListEvent()`에서 gateway 세션이 gateway 전용 필드만 사용

**APME 연동**
- `apmeCollectorGateway` — Claude Code `apmeCollector`와 분리된 전용 인스턴스 (activeHookSession 충돌 방지)
- Gateway 연결 → `session_start`, 끊김 → `session_end`
- `session.message` role=user → `user_prompt_submit`, `chat` final → `setTurnResponse()` → 분류+평가 자동 트리거
- `session.tool` pending/complete → `tool_start`/`tool_end`

**타임라인 텍스트 캡처**
- `chat` delta `prompt` 필드 → `model_call` timeline 엔트리 (실제 프롬프트 텍스트)
- `chat` final `response` 필드 → `model_response` timeline 엔트리 (전체 응답)
- `sessions.messages.subscribe` 의존 제거 — `chat` 이벤트에서 직접 캡처
- `DaemonTimelineEntry.runId` 추가 — turn-level 그루핑 가능

**"Prompt sent" 억제 (AgentStateHolder.swift)**
- `gatewayConnected == true` 수신 시 즉시 `receivingBridgeTimeline = true` 설정
- StateTimelineGenerator 폴백이 gateway 연결 중 실행되지 않음

**Gateway 연결 안정성**
- `gatewayProbeFailCount` — 2회 연속 실패(≈10초) 후에만 disconnect 트리거
- "reconnecting" 상태 추가 — WebSocket 끊김 + TCP 살아있을 때 "Not configured" 대신 표시
- APME gateway 스펙 감사: `exec.approval.resolved` deny 처리, `session.tool` → gatewayCurrentTool, disconnect 시 state 리셋

### 핵심 설계 결정

**1. apmeCollectorGateway 분리**  
`ApmeCollector`는 `activeHookSession` 단일 상태 → Claude Code와 OpenClaw를 같은 collector에 넣으면 turn routing 충돌. 동일 `ApmeStore` + `ApmeRunner`를 공유하되 collector만 분리하여 평가 파이프라인은 하나로 유지.

**2. chat 이벤트가 타임라인의 신뢰할 수 있는 단일 소스**  
`sessions.messages.subscribe`는 연결 시 활성 세션이 없으면 subscription이 silent fail할 수 있음. `chat` delta `prompt` + `chat` final `response`는 구독 없이 항상 수신. `session.message`가 나중에 도착해도 5초 dedup으로 자동 처리.

**3. gateway probe hysteresis threshold = 2**  
단일 TCP 실패(5초 probe)로 즉시 disconnect하면 일시적 지연에도 "Not configured" 노출. 2회(≈10초) 연속 실패를 요구하면 adapter 내부 backoff reconnect가 처리하고 UI는 변화 없음.

**4. receivingBridgeTimeline 선제 설정**  
StateTimelineGenerator가 `timeline_event` 도착을 기다리다 state_update에 먼저 반응하는 레이스 제거. Gateway connected 상태가 확인되면 즉시 generator를 억제.

---
