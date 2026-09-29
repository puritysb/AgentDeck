# 2026-04-26 — CLI passive observer: abtop 참고 개선 + App Store 경계 유지

### 문제

abtop 은 별도 daemon registration 없이도 이미 실행 중인 Claude/Codex 프로세스와 transcript/rollout JSONL 을 읽어 TUI 에 표시한다. AgentDeck 은 관리 세션(`sessions.json`) 중심이라 CLI 밖에서 시작된 세션은 놓치지만, 같은 방식을 App Store macOS 앱에 그대로 넣으면 `ps`/`lsof`/`/proc` 관찰과 외부 프로세스 열람이 App Review 2.5.2/4.2 경계를 흐린다.

### 해결

- `docs/appstore-feature-matrix.md` 에 `외부에서 이미 실행 중인 Claude/Codex 세션 passive discovery` 를 CLI-only 로 먼저 분류했다.
- Node daemon 전용 `PassiveSessionObserver` 를 추가했다.
  - Claude: `~/.claude/sessions/<pid>.json` + project transcript tail 을 읽어 model/state/current task/context/token 을 best-effort 로 요약한다.
  - Codex: `ps` + macOS `lsof -F pn` 또는 Linux `/proc/<pid>/fd` 로 rollout JSONL 을 찾아 session metadata/token/function call state 를 요약한다.
  - tool argument 는 짧게 표시하고 API token/Bearer/GitHub/Slack 계열 secret 은 redaction 한다.
  - AgentDeck 이 직접 관리하는 bridge child process 는 pid/ppid 기반으로 중복 제거한다.
- daemon `sessions_list` 에 관측 세션을 `controlMode: "observed"`, `port: 0` 으로 섞어 보낸다. TUI 는 observed 라벨과 current task 를 표시하되 숫자 hotkey/focus 대상에서는 제외한다.
- D200H 버튼 focus 목록에서도 `observed` / `port: 0` 세션을 제외해 제한된 하드웨어 슬롯이 제어 가능한 세션만 대상으로 삼도록 했다.
- shared protocol 의 optional session metadata 를 확장했고, 기존 `ClientRegisterCommand` block comment 를 generator 가 필드로 읽지 못하던 문제를 고쳐 generated command builders 를 source-of-truth 와 맞췄다.

### App Store 경계

- 새 passive discovery 는 `bridge/src/passive-observer.ts` 와 Node daemon 연결부에만 존재한다.
- `apple/` App Store 앱 소스에는 새 subprocess, shell, external CLI 호출 경로를 추가하지 않았다.
- App Store 단독 앱은 기존처럼 Claude hook / Codex lifecycle hooks 로 opt-in 된 세션만 표시하며, CLI companion 이 없을 때도 결함 UI 를 노출하지 않는 설계를 유지한다.

### 검증

- `pnpm --filter @agentdeck/shared typecheck` 성공
- `pnpm --filter @agentdeck/bridge typecheck` 성공
- `pnpm vitest run bridge/src/__tests__/passive-observer.test.ts bridge/src/__tests__/session-aggregator.test.ts bridge/src/__tests__/bridge-core-sessions.test.ts bridge/src/__tests__/tui-dashboard.test.ts bridge/src/__tests__/tui-renderer-snapshots.test.ts` 성공 (5 files / 49 tests)
- `git diff --check` 성공

---
