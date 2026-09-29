# 2026-05-06 — Dashboard TIMELINE lifecycle 단위 정리

### 문제

macOS Dashboard TIMELINE 이 작업 단위가 아니라 저수준 이벤트를 그대로 노출했다. Claude Code 는 응답
캡처가 비면 사용자가 입력한 `chat_start` 만 남았고, `chat_end` 는 UI 에서 일괄 숨겨 완료 row 가 사라졌다.
Codex 는 APME/session state 로는 들어오지만 timeline entry 를 만들지 않아 Dashboard TIMELINE 에 보이지
않았다. OpenClaw tool row 는 tool 이름/입출력 요약이 충분히 복원되지 않아 어떤 tool 이 실행됐는지
판단하기 어려웠다.

### 해결

- 공통 `TimelineEntry` 에 `runId`/`startedAt`/`endedAt` 을 추가했다. Bridge/Android/Swift store 의 upsert
  경로도 이 lifecycle field 를 보존한다.
- macOS TIMELINE 은 완료된 turn 의 `chat_start` 를 목록에서 숨기고, `chat_response` 가 있는 경우
  메타 `chat_end` 를 숨긴다. 완료 row 의 detail pane 에 START/END/DUR 를 표시한다.
- macOS TIMELINE row 에 `SessionCreatureIcon` 을 넣어 Claude/Codex/OpenClaw/OpenCode source 를
  project prefix 와 별도로 식별하게 했다.
- Codex CLI/OTel/hook 경로에서 `chat_start`/`tool_exec`/`chat_response`/`chat_end` timeline entry 를
  생성한다. 응답 텍스트가 없으면 완료 row 는 남기고, 응답이 잡히면 result row 를 우선 표시한다.
- OpenClaw Gateway `session.tool` payload 는 `name/tool/toolName` 과 nested payload 를 더 폭넓게 읽고,
  input/output/error 를 JSON compact detail 로 보여준다.
- APME `eval_result` row 에 task/turn/run 의 시작/완료 시각을 실어 평가 결과가 실제 작업 lifecycle 과
  연결되게 했다.

### 검증

- `pnpm --filter @agentdeck/shared typecheck` 성공.
- `pnpm --filter @agentdeck/shared build` 성공.
- `pnpm --filter @agentdeck/bridge typecheck` 성공.
- `pnpm vitest run bridge/src/__tests__/timeline-integration.test.ts` 성공.
- `./gradlew :app:compileDebugKotlin` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineTask CODE_SIGNING_ALLOWED=NO` 성공.
- `pnpm vitest run bridge/src/__tests__/apme-task-boundary.test.ts ...` 는 현재 로컬 native optional dependency
  `better-sqlite3` 초기화 실패로 실행되지 않았다. Swift XCTest 는 test runner 가 app launch 상태에서
  장시간 반환하지 않아 중단했다.
- `git diff --check` 성공.

---
