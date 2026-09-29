# 2026-06-07 — APME `_empty` run timeline 반복 노이즈 차단

### 문제

OpenClaw Gateway 연결 노이즈로 생성된 prompt/turn/step 없는 run 이 orphan cleanup 에서 `_empty` 로 닫힌 뒤에도, APME daemon 30초 loop 의 `listUnevaluatedRuns()` 후보에 계속 포함됐다. 이 run 은 outcome 계산상 `abandoned`, composite `0.2` 로 저장되어 `TIMELINE` 에 `★ run 20% [_empty] abandoned` 가 반복 append 됐다.

### 수정

- Node `bridge/src/apme/store.ts` 와 Swift `apple/AgentDeck/Daemon/Apme/ApmeStore.swift` 의 `listUnevaluatedRuns()` 에서 `task_category='_empty'` run 을 제외했다.
- Node `ApmeRunner.doDrain()` 이 layer1/layer2 모두 실행되지 않은 no-op run result 는 `onResult` listener 로 내보내지 않도록 방어했다.
- Node daemon run-level `onResult` branch 에도 eval row 가 0개인 no-op result 방어를 추가해 timeline append 를 건너뛰게 했다.
- 회귀 테스트: `_empty` run 이 unevaluated queue 에 들어가지 않는지, no-op run eval 이 `onResult` 를 호출하지 않는지 검증했다.

### 검증

- `pnpm vitest run bridge/src/__tests__/apme-collector.test.ts bridge/src/__tests__/apme-runner.test.ts`
- `pnpm --dir bridge build`
