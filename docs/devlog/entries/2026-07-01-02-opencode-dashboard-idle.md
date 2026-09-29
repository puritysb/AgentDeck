# 2026-07-01 — OpenCode 세션이 활동 중에도 dashboard 에서 idle 로 고착

### 문제
사용자가 OpenCode(`agentdeck opencode`) 세션이 실제로 작업 중인데 dashboard 에 계속 idle 로 표시된다고 보고했다. 점검 결과 OpenCode 어댑터는 PTY 스피너 파싱을 의도적으로 끄고(`wireOutputParser`/`feedParser` no-op) run-state 를 SSE 이벤트로만 도출하는데, 공유 StateMachine 을 `IDLE → PROCESSING` 으로 옮기는 유일 트리거 `spinner_start` 를 내보내던 곳이 `session.status` 의 `status.type === 'busy'` 분기 하나뿐이었다. 현행 OpenCode 빌드는 작업을 `message.updated` / `message.part.updated` / `message.part.delta` 로 통지하고 종료를 `session.idle` 로 알리며 별도의 안정적인 `busy` 시작 이벤트를 보내지 않아, 한 턴 내내 IDLE 로 고착됐다. `tool_action` 파서 이벤트는 `currentTool` 만 세팅하고 상태 전이는 하지 않으므로 툴 이름은 떠도 라벨은 idle 인 상태가 가능했다. Claude/Codex 는 hook + PTY 스피너로 구동되어 정상이었다.

### 해결
- `bridge/src/adapters/opencode-adapter.ts` 에 `beginChatIfNeeded()` 헬퍼를 추출(턴당 1회 래치). `chat_start` 타임라인 + `spinner_start` 파서 이벤트를 발행.
- OpenCode 가 실제로 보내는 작업-시작 신호에서 호출: `handleSessionStatus` busy, `handlePartUpdated`, `handlePartDelta`, 그리고 생성 중인 assistant `message.updated`(`time.completed == null`).
- `finishChat()`(`session.idle`)가 `chatStarted` 를 리셋해 다음 턴 재무장.
- connect-time `listSessions` 가 갓 생성 세션을 놓쳐 `activeSessionID` 가 미해결이면 작업유발 이벤트의 sessionID 로 auto-track(이전에는 `sessionID !== activeSessionID` 가드가 전 이벤트를 silent drop). non-active 세션 part drop 시 진단 로그.
- 어댑터의 상태 도출 자체를 고친 것이라 dashboard/Stream Deck/devices/Apple 표면이 동시에 정상화됨(표면별 렌더 버그 아님).

### 핵심 설계 결정
- run-state 무장을 `session.status:busy` 단일 이벤트에 의존하지 않고, 버전에 관계없이 실제 도착하는 message/part/delta 신호에서 래치. 재발행되는 `spinner_start` 는 PROCESSING 에서 no-op 이고 PTY activity 가 stuck-timer 를 계속 리셋하므로 장기 턴도 중간에 idle 로 강등되지 않는다.

### 검증
- 신규 `bridge/src/__tests__/opencode-adapter-state.test.ts` 6 케이스(arm-once 래치, idle 리셋+재무장, auto-track, 생성중 vs 완료 message 무장, non-active 세션 drop).
- `pnpm build` 성공, `pnpm vitest run bridge/src/__tests__/` 1106/1106 성공.
