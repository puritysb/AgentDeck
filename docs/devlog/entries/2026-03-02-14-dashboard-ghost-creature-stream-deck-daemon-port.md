# 2026-03-02 — Dashboard ghost creature + Stream Deck daemon port collision

### 문제
1. **Ghost creature**: daemon만 실행 중 (sdc 세션 없음) Android Dashboard에 SLEEPING 옥토퍼스 1마리 표시. `TerrariumState`가 DISCONNECTED에서도 `agentType`이 null이면 primary agent를 추가, `MonitorScreen`의 `coerceAtLeast(1)` + `CreatureLayout`의 빈 리스트 fallback이 최소 1마리 강제
2. **SD+ 버튼 지연**: daemon 도입 후 버튼이 첫 번째 누름에 반응 안 함. `findLatestSessionPort()`가 daemon 세션을 필터링하지 않아 plugin이 daemon 포트로 연결 → daemon의 `onCommand()`가 대부분의 명령을 무시

### 해결
- **TerrariumState.kt**: `agentState != AgentState.DISCONNECTED` 가드 추가 — DISCONNECTED시 primary agent 목록 제외
- **MonitorScreen.kt**: `coerceAtLeast(1)` 제거 → agents 0이면 octopuses 0
- **CreatureLayout.kt**: `layoutOctopusesByProject()` 빈 agents → `emptyList()` 반환 (기존: 기본 슬롯 1개)
- **EinkRenderer.kt**: `agents.isEmpty()` 분기 추가로 octopus 그리기 스킵
- **plugin.ts**: `findLatestSessionPort()`에 `agentType !== 'daemon'` 필터 추가

### 교훈
- Daemon은 인프라 프로세스이지 코딩 에이전트가 아님 — `sessions.json`에 등록되더라도 플러그인/UI에서 interactive session으로 취급하면 안 됨
- "최소 1" 보장 로직은 크리처 시스템의 여러 레이어에 분산되어 있었음 (TerrariumState, MonitorScreen, CreatureLayout) → 한 곳만 고치면 다른 곳에서 다시 1마리가 생성됨. 전체 경로 추적 필요

---
