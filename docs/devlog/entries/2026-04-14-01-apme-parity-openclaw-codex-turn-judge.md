# 2026-04-14 — APME parity: OpenClaw/Codex turn_judge 누락 수정

### 문제
2026-04-13 APME 범용화 이후에도 비-Claude 세션의 실시간 턴 평가가 안 돌고 있었다. `turns.task_category`, `turns.composite_score`는 NULL, `evals.layer='turn_judge'` 행은 OpenClaw/Codex/OpenCode 세션 ID로 조회하면 0건. Claude Code 세션만 제대로 기록됨.

### 해결
`bridge/src/index.ts`의 mid-session classify + turn enqueue 로직이 Claude PTY `spinner_stop` 핸들러 내부에만 인라인으로 존재했음. 공용 헬퍼 `classifyAndEnqueueTurn(apme, sid)`로 추출하고 세 경로에서 동일하게 호출:
1. Claude `spinner_stop` (기존 인라인 37줄 → helper 호출 1줄)
2. OpenClaw/OpenCode `chat_response` (timeline event, 신규)
3. Codex `spinner_stop` (PTY parser, 신규)

### 핵심 설계 결정
- **단일 헬퍼 공유**: agent-type 분기를 헬퍼 안에 넣지 않음. 분류 규칙(`classifyRun`)과 NON_CODE 카테고리 세트는 모든 에이전트에 동일 적용. 에이전트별 동작 차이가 필요해지면 그때 분기.
- **`chat_end` fallback 경로는 커버하지 않음**: `setLastClosedTurnResponse`는 이미 closed turn을 수정. helper는 `getActiveTurnId` 기준이라 조기 return됨. Claude도 `spinner_stop`을 놓치면 동일하게 daemon `closeRun`의 async 경로에 맡기므로 parity 유지.
- **Commit**: 23df3b44 `fix(apme): parity classify+turn_judge for OpenClaw/OpenCode/Codex`

---
