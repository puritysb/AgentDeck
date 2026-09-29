# 2026-09-04 — Swift gradeability 생성 미러와 subagent census→sample→rollup/Graph 완결

전날 남긴 TODO를 코드·실물 DB·양 데몬 경로로 다시 점검했다. Swift task judge는 실제로
사용자 prompt까지 "작업 텍스트"로 세던 옛 any-text 게이트를 유지하고 있었고, subagent hook은
Node `SubagentTimelineTracker`/Swift `handleSubagentTimelineHook`에서 일반 APME보다 먼저 반환되어
`SampleModelConfig.subagents` writer가 생길 수 없는 구조였다. Swift가 번들한 대시보드는 Graph
탭을 노출하지만 `/apme/graph` route도 없었다.

- `task-gradeability.ts`에서 `TaskGradeabilityRules.generated.swift`를 생성하도록 기존 generator를
  확장하고 `shared/task-gradeability-vectors.json`을 Node/Swift가 함께 리플레이한다. Swift
  `ApmeRunner`가 judge enqueue 전 동일한 `no_reply`/`aborted_only`/`trivial` 게이트와
  `notes_json.notGradeable` 스탬프를 적용한다.
- 양 census가 start/completion의 id·표시명·duration·summary만 활성 부모 task로 handoff한다.
  `sample_events.kind='subagent'`와 `model_config.subagents`를 함께 쓰고, 뒤의 모델/usage 갱신은
  JSON header를 병합한다. 부모 task가 없으면 최근 세션을 추측하지 않는다.
- 양 task-rollup prompt가 typed trajectory를 읽고, Node/Swift `/apme/graph`가 한 child node와
  `delegated` edge를 만든다. Swift에는 App Store-safe read-only `ApmeGraphProjection`과 route를
  추가했다. 대시보드 색/edge와 생성 HTML도 동기화했다.

라이브: checkout daemon build `cbf78061aa2e` 재시작에서 13 open run을 재수화하고 agent record로
3 turn을 즉시 닫았다. MLX는 다시 ready(모델 endpoint 30ms, probe 1.165s)라 22시 UTC에 6 task를
판정했고 30일 pending은 301→250, 전체 judged는 808(30일 595)이 됐다. commit `5ad609cf` 뒤
codex closed 표본은 stop 4/4 응답 보유; 새 next_prompt 표본과 재시작 후 2시간 reaper 표본은
아직 없어 그 두 분기는 회귀 테스트 판정만 유지한다. 반면 P5는 실제 다른 Claude 세션의 child
completion이 sample/model_config에 기록되고 live `/apme/graph` node+edge로 노출되는 것까지 확인.

게이트: bridge/shared tsc, vitest 252 files / 3,867 tests, generator `--check`, docs check,
macOS `ApmeTaskBoundaryTests` 62/62. Xcode 절차는 `.agents/workflows/apple-xcode-debug.md`를 따랐다.

---
