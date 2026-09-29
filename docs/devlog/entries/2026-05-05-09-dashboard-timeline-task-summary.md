# 2026-05-05 — Dashboard TIMELINE task summary 운영성 개선

### 문제

Dashboard TIMELINE 의 APME 평가 row 가 `★ task 85% [category]` 처럼 점수와 분류만 먼저 보여
운영자가 주변 시야에서 "어떤 작업이 끝났는지"를 바로 판단하기 어려웠다. 다중 세션 환경에서도 timeline
entry 에 project/session attribution 이 안정적으로 붙지 않아 AgentDeck/ViewTrans 같은 동시 세션을
TIMELINE 만 보고 구분하기 어려웠고, Android/e-ink 는 Claude Code 의 `chat_response` 뒤 `chat_end`
메타 row 를 그대로 보여 같은 턴이 중복 요약처럼 보일 수 있었다.

### 해결

- 공통 `TimelineEntry` 에 `projectName`/`sessionId` 를 추가하고, session timeline relay 와 bridge
  history/live broadcast 에서 누락된 attribution 을 보강했다.
- Node daemon 과 Swift in-process daemon 의 APME `eval_result` raw 를 `★ task 85% [debugging]
  <작업 요약>` 형태로 바꿨다. detail 에는 summary, axis score, done/missed, reasoning, project/prompt 를
  줄 단위로 넣어 compact row 와 detail pane 의 역할을 분리했다.
- Android tablet TIMELINE 과 e-ink TIMELINE/EventLog 가 project/source label 을 표시하고, Claude Code
  `chat_end` 메타 row 를 숨겨 iOS Dashboard 와 동일하게 한 턴이 한 줄 요약으로 읽히게 했다.
- timeline upsert 경로가 summary 만 교체할 때도 agent/project/session attribution 을 보존하도록
  Bridge/Android store 를 보강했다.

### 검증

- `pnpm --filter @agentdeck/shared typecheck` 성공.
- `pnpm --filter @agentdeck/shared build` 성공.
- `pnpm --filter @agentdeck/bridge typecheck` 성공.
- `pnpm vitest run bridge/src/__tests__/session-timeline-relay.test.ts bridge/src/__tests__/timeline-integration.test.ts` 성공.
- `./gradlew :app:compileDebugKotlin` 성공.
- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.state.TimelineStoreTest` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineTask CODE_SIGNING_ALLOWED=NO` 성공.
- `git diff --check` 성공.
