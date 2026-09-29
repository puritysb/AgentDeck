# 2026-04-22 — Swift daemon: APME task-unit evaluation mirror (App Store 경로)

### 문제

TS bridge 가 직전 커밋(`56ab762d`)에서 task-level eval 을 붙였지만 Swift daemon 엔 없어서 **App Store 앱만 돌리는 사용자(= CLI 미설치)는 새 기능을 못 받는 상태**. 사용자의 원래 질문은 "Claude Code recap 기능을 hook 으로 잡아 task-unit eval 하고 싶다"였고 조사 끝에:

1. recap 은 hook event 로 노출 안 됨 (공식 문서에 없음)
2. recap 자체가 task 완료 신호 아님 (75분 resume / 수동 `/recap`)
3. App Store sandbox 는 `~/.claude/projects/*.jsonl` transcript 까지 차단 (`claude-transcript-reader.ts:13-16` 주석)

→ recap 대신 **hook payload 만으로 자동 감지 가능한 `TodoWrite` all-completed + `/clear` + `session_end`** 를 task 경계 신호로 삼고, judge 가 task 요약을 직접 생성하는 쪽으로 선회.

### 해결

`bridge/src/apme/*` 와 동일한 계약을 Swift daemon 에 포팅:

- **`ApmeStore.swift`** — `tasks` 테이블 + `turns.task_id` / `evals.task_id` 컬럼 + migration. `task_rollup` rubric seed(axes: completion/coherence/efficiency + summary 요청). `ApmeTask` struct + 8개 DAO.
- **`ApmeCollector.swift`** — `ActiveTask`, `openTaskIfNone(runId:)` / `closeTask(boundarySignal:)`, `UserPromptSubmit` 에서 task 자동 open + `insertTurn` 에 `taskId` 연결, PostToolUse TodoWrite 의 `allTodosCompleted(data:)` 검사, session_end 에서 task 닫힘.
- **`ApmeRunner.swift`** — `enqueueTask(runId:taskId:category:boundarySignal:)` + `runTaskEval`. `buildTaskJudgePrompt` 는 최대 10 turn 을 `[Turn N] User: … / Agent: …` 형태로 프롬프트에 넣고 `task_rollup` rubric 적용. `parseJudgeJson` 에 `summary` 필드 추출 + RESERVED 에 포함(numeric axis 로 잘못 잡히지 않도록).
- **`DaemonServer.swift`** — `handleApmeResult` 에 task-level branch 추가: `★ task X%` timeline entry + `apme_eval` WS 브로드캐스트(기존 turn-level 브로드캐스트 재사용, taskEvals 목록 사용).

### 핵심 설계 결정

- **Claude Code built-in recap 에 의존 안 함**: recap 텍스트는 CLI 에선 transcript 파싱으로, App Store 에선 **judge 가 직접 생성**. 양쪽 빌드가 같은 UX 를 받고, Swift sandbox 가 `~/.claude/projects/` 를 차단한다는 제약을 우회한다.
- **Default judge backend 가 App Store 에선 `foundationModels`**(`ApmeSettings.swift:29`) — task rollup 도 Apple Intelligence on-device 로 실행. MLX 서버 안 띄운 사용자가 아무 추가 설치 없이 task-unit 점수/요약을 받음.
- **App Store invariants 전부 유지**: subprocess 없음, 외부 executable 없음, companion-install prompt 없음, home-relative-path entitlement 없음. `verify-appstore-archive.sh` 가 Release `.app` 에서 pass.
- **SourceKit isolation 이슈 주의**: 전 파일을 `#if os(macOS)` 로 감싼 Swift 파일들은 SourceKit 이 심볼을 못 찾는 false positive 발생. 빌드 타임(`xcodebuild build`) 에서 실제 타겟 compile 로 resolve. 에디터 경고만 보고 코드 수정하지 말 것.

### 검증

- `pnpm test` 967/967 (회귀 없음)
- `xcodebuild test -only-testing:…ApmeTaskBoundaryTests` 12/12 (XCTest: `allTodosCompleted` helper, task lifecycle 5개, parseJudgeJson summary 3개, rubric seed 1개)
- `xcodebuild build -configuration Release` SUCCEEDED
- `verify-appstore-archive.sh` passes on Release `.app`

---
