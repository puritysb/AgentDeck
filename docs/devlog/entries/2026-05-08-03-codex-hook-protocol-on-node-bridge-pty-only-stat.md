# 2026-05-08 — Codex hook protocol on Node bridge (PTY-only state machine retired)

### 문제

지난 세션의 작업 ("Codex timeline task unit alignment with APME turn",
2026-05-06) 은 `wireAgentApme` 의 Codex 세그먼트가 7개 상태 변수 · 5개
helper · 3개 timer 로 부풀어 7회 Codex review iteration 후에야 layered
correctness 도달했다. 본질은 PTY 신호의 모호성 (status line `›`, mid-tool
silence, stale frame, sub-second redraw) 을 단일 state machine 으로 보상
하느라 그런 것.

리서치 결과: **Apple Swift daemon 은 같은 문제를 hook 기반으로 깔끔하게
처리하고 있었다**. `apple/AgentDeck/Daemon/Core/CodexConfigInstaller.swift`
가 `~/.codex/config.toml` 에 `[features] codex_hooks = true` + 5개
lifecycle hook 표를 install. 그러나 **Node bridge (CLI) 측에는 동등 인프라
0건** — `bridge/`, `hooks/`, `setup/` 어디에도 `codex_hooks` 매치 없음.
Node CLI (`agentdeck codex`) 사용자에게는 PTY 출력만이 turn-boundary
신호여서 wireAgentApme 의 복잡한 state machine 이 필요했던 이유.

### 해결

**Node bridge 에 Codex hook 인프라 포팅 + state machine retire**.

**Phase A — Codex hook installer 포팅** (commit 7553e11c, ~650 LOC):
- `hooks/src/codex-mini-toml.ts` — `apple/AgentDeck/Daemon/Core/MiniToml.swift`
  의 lossless TOML 편집을 직접 포팅. `@iarna/toml` 같은 semantic parser
  쓰지 않음 — 사용자 TOML 의 key 순서/들여쓰기/blank line 을 normalize 해
  버리면 round-trip-preserves-user-config invariant 깨짐. fence sentinels
  byte-identical.
- `hooks/src/codex-install.ts` — install/uninstall/migrate. PORT-resolution
  shell snippet 은 `hooks/src/install.ts:buildHookCommand` 와 byte-identical
  (Apple/Node 두 daemon 이 같은 fence 를 toggle 가능). conflict gate (사용자
  authored `[features]` / `[hooks]` / `notify` / `[otel]` 외부 → install
  skip). Atomic write.
- Trigger 2 곳: `agentdeck codex` action lazy install + `agentdeck daemon
  install`. setup 패키지는 zero-runtime-deps inline 패턴 보존을 위해 skip
  — 사용자가 `agentdeck codex` 첫 실행 시 어차피 trigger.
- 29 unit tests (Apple `MiniTomlTests` + `CodexConfigInstallerTests` 1:1
  포팅 + round-trip preserve invariant pin).

**Phase B — Bridge hook 처리** (commit ed67a5ce, ~240 LOC):
- `bridge/src/state-machine.ts` 에 codex_* case 6개 추가 (session_start,
  user_prompt_submit, tool_start, tool_end, stop, turn_complete). Claude
  trigger 라벨 (`'session_start'` etc.) 재사용해 `shared/src/states.ts`
  transitions 테이블에 codex 접두사 안 추가.
- `bridge/src/apme/adapters/codex-hook.ts` — `claude-hook.ts` 의 mirror.
  `codex_user_prompt_submit → turn_start`, `_tool_start → tool_call`,
  `_tool_end → tool_result`, 나머지 raw_step. `/clear` 감지.
- `bridge/src/index.ts` hook branch 에서 `agentType === 'codex-cli'` 시
  `codexHookToSpans` 사용 (Claude 와 분기).
- 7 state-machine + 5 codex-hook span 테스트.

**Phase C — CodexTurnManager class 추출** (commit 39e169fc, +600/−280 LOC):
- `bridge/src/apme/adapters/codex-turn-manager.ts` 신규 class.
  `onHookEvent` (primary), `onParserEvent` (PTY fallback), `cleanup`.
- 30s `hookActive` freshness window — 최근 hook 이 fired 면 PTY parser idle/
  spinner_stop 신호 demoted (turn-boundary no-op). 그 윈도우 밖에서만
  legacy state machine 활성. Hook 이 발화 안 하는 사용자 (CLI 만 + hooks
  install 거부 또는 Codex Ink-TUI repaint glitch) 에 대비한 fallback 유지.
- Hook path 는 timeline-only — APME ingestion 은 index.ts hook adapter 가
  이미 codexHookToSpans 로 처리. 재 ingestion 하면 turn 이 닫혔다 다시
  열려 망가짐.
- `classifyAndEnqueueTurn` 을 `apme/classify-turn.ts` 로 추출 (codex-turn-
  manager 가 import 시 index.ts 와 circular dep 안 만들게).
- wireAgentApme 의 305-line Codex 세그먼트가 ~25 LOC 로 축소.
- 7 단위 테스트 (hook happy path, multi-turn fresh chat_starts, hook
  freshness window, long-bash with multiple tool pairs, PTY-only fallback
  3 cases).

**Stop-gate fixes (Codex review):**

**b2fc3bc5 — `codex_stop` 가 APME turn finalize 안 됨**:
- collector.closeTurn 이 private + UserPromptSubmit/closeRun 만 호출 →
  codex_stop 후 다음 prompt 까지 turn 의 `endedAt` null + tool_calls 미flush.
- `ApmeCollector.closeTurnForSession(sessionId)` public wrapper 추가,
  `CodexTurnManager.closeTurn` 마지막 (chat_response/classify 후) 에 호출.

**88ef6b23 — closeTurnForSession 이 turn_index sequence reset**:
- `collector.ingestHook` UPS 분기가 `sessionToTurn.get(sessionId)?.index`
  로 prevIndex 읽음. 내가 codex_stop 에서 sessionToTurn 비우니 다음 UPS
  시 prevIndex=-1 → turnIndex=0 으로 reset → 모든 후속 turn 의 index 가
  0 → tasks.firstTurnIndex/lastTurnIndex 부기 깨짐.
- sessionToTurn 비면 `sessionToLastTurnId` 로 fallback 해서 store 에서
  마지막 turn 의 turn_index 읽기. Claude/OpenCode 는 closeTurnForSession
  안 부르니 영향 없음.

### 핵심 설계 결정

- **Hook protocol 이 있으면 PTY parser 보다 항상 우선**. 모호성 없는 명시
  signal 이 추측보다 monotonically 안전. PTY 는 fallback (hook miss 18%
  케이스) 으로만 유지.
- **30s freshness window 로 mode 전환**. hook 이 한 번이라도 떴으면 30s 간
  hook-primary, 그 후 미수신이면 PTY-fallback 자동 재진입. 운영 환경에
  따라 (사용자 hooks install 안 함, Codex 버전 차이) 자동 적응.
- **fence sentinel + PORT-resolution shell snippet 을 Apple/Node 동일하게**.
  `~/.codex/config.toml` 을 두 daemon 이 toggle 해도 conflict 없음. hook
  command 가 매 호출 시점에 active daemon 자동 매칭.
- **Setup package 는 zero-runtime-deps 인라인 패턴 보존**. Codex install
  은 `agentdeck codex` 첫 실행 lazy trigger 로 충분 — setup 직후 사용자도
  결국 codex 명령 통해 trigger 받음.
- **`codex_stop` 는 turn 을 즉시 finalize**. Claude `Stop` 은 finalize 안
  하고 다음 UPS 에 prev close 하는데, Codex 의 codex_stop 이 더 강한
  "turn 끝" 의미라 즉시 finalize 가 맞음. 단, prevIndex 읽기 fallback 추가
  필요했음.

### 검증

- `pnpm test`: 1138 passing (기존 1086 + Phase A 29 + Phase B 12 + Phase C
  8 + finalization 1 + index regression 1 + 기존 테스트 추가 가산).
- `pnpm -r build` clean. typecheck clean.
- 수동 검증은 다음 세션에서 — 실제 `agentdeck codex` 세션을 띄워:
  - `~/.codex/config.toml` fence-block 자동 install 확인
  - Apple/Android tablet timeline 에서 multi-bash prompt 가 chat 카드 1개로
    표시되는지 (long bash > 15s 케이스 포함)
  - `apme.sqlite` 의 Codex run turns 가 monotonic turn_index, 정확한
    tool_calls, response, endedAt 채워져 있는지

### 회고

이번 작업은 두 세션에 걸친 7+5회 Codex review iteration 의 결과. 첫 세션
(2026-05-06) 의 PTY-only state machine fix 가 layered correctness 도달후,
이번 세션이 그 layering 을 hook 기반으로 retire 시켰다. 같은 영역의 review
가 반복해서 다른 layer 의 bug 를 짚는 패턴은 `feedback_codex_stoptime_iteration`
메모대로 — "이미 고쳤음" 으로 무시 금지. 매 commit 이 separate.

---
