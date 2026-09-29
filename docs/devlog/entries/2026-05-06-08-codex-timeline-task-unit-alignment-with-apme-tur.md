# 2026-05-06 — Codex timeline task unit alignment with APME turn

### 문제

Codex 세션의 timeline 이 한 user prompt 를 여러 chat 카드로 쪼개 표시했다.
원인은 `wireAgentApme` 가 `spinner_stop` 을 turn 종료 신호로 쓴 것 — Ink TUI 는
bash 가 실행되거나 상태 라인이 갱신될 때마다 spinner 를 멈춘다. 또한 Codex 의
도구 호출은 `tool_exec` 엔트리로 emit 되었으나 `timelineEntryToSpans` switch 의
default 로 떨어져 APME `tool_call` span 을 만들지 않았다 — eval 평가 단위와
사용자가 보는 timeline 단위가 단절돼 있었다.

### 해결

핵심 원리: 한 user prompt cycle = 한 `chat_start..chat_end` 쌍 = 한 APME turn.

**Parser** (`bridge/src/codex-output-parser.ts`):
- `idle` 이벤트에 `source: 'prompt' | 'timeout'` payload 부착. `prompt` 는
  `›\s` / 입력 prompt 가 실제로 보였다는 신호 (turn-end 후보), `timeout` 은
  spinner data 가 끊긴 합성 idle (대개 mid-tool 의 silence).
- `parseToolAction` 에 4초 dedup 추가 — Ink redraw 로 같은 명령이 여러
  chunk 에 매치돼 `tool_action` 이 폭발하던 문제 해소. turn 경계에서 reset.

**Bridge wiring** (`bridge/src/index.ts wireAgentApme`):
- spinner_start 에서 turn open, prompt-source idle 에서 turn close.
- 1.5s deferred close + spinner_start cancel 패턴 — 빠른 single-shot turn
  도 안 떨어뜨리고 status-line false-positive 도 막음.
- `codexInToolSilence` flag — timeout-idle 후 활성, spinner_start 시 해제.
  silence 동안 들어오는 prompt-idle 은 `codexPendingPromptIdle` 로 latch.
- `codexToolActiveSinceLastSpinner` — 이번 thinking segment 에 tool 이
  실제로 돌았는지 추적. timeout-idle 이 와도 이 flag 가 false 면
  end-of-thinking quiet 으로 보고 silence 진입 안 함.
- 15s `codexToolSilenceTimer` auto-clear — final response 가 spinner 재가동
  없이 끝나는 turn (예: tool 출력이 곧 응답) 에서 무한 차단 방지. 발화 시
  latched pending 을 즉시 close (deferred 아님 — 그새 next spinner_start 가
  cancel 할 수 있어).
- `codexPendingTailSnapshot` — latch 시점 PTY tail 을 snapshot. 후속 close
  (auto-clear timer / next spinner_start) 가 live ringbuffer 가 아닌 이
  snapshot 을 사용 → turn N+1 의 사용자 입력이 turn N 의 chat_response 로
  새지 않음.
- spinner_start with latched pending → 이전 turn 을 동기 close 후 새 turn
  시작 → "사용자가 다음 prompt 입력" 이 두 turn 의 merge 로 보이지 않게.

**APME adapter** (`bridge/src/apme/adapters/timeline.ts`):
- switch 에 `case 'tool_exec'` fallthrough 추가 → `tool_request` 와 동일하게
  `tool_call` span 생성. Codex 도구 호출이 `turns.tool_calls` 에 카운트됨.

### 핵심 설계 결정

- **`spinner_stop` 을 turn 신호로 쓰지 않는다**. Codex Ink TUI 는 bash/상태
  라인에 의해 spinner 가 자주 일시정지됨. 의미적으로 turn 종료가 아님.
- **`prompt`-source idle 만 turn-close 후보로 채택**. `timeout`-source idle
  은 mid-tool 의 spinner-silence 로 해석.
- **mid-tool stale idle 은 차단하되 영구 차단은 안 함**. 15s 안에 spinner
  재가동이 없으면 정말 turn 이 끝난 것으로 간주 (auto-clear).
- **사용자 다음 prompt 입력이 turn merge 를 일으키지 않게** spinner_start
  핸들러가 latched pending 을 동기 close 후 새 turn 개시.
- **PTY tail snapshot 은 latch 시점에 캡처** — close 가 늦게 일어나도
  contamination 없음.
- Trade-off: 단일 bash 가 15s 초과 + 그동안 stale `›` chunk 가 latch 를
  유발한 케이스에서 turn 이 split 될 수 있음. 일반 bash (<15s) 는 영향 없음.

### 회고: Codex stop-time review 의 가치

이 작업은 Codex review 가 한 회차에 하나씩 edge case 를 잡아 7회 iteration
했다 (idle guard → mid-tool close → status-line false positive → permanent
suppression → next-prompt drop → contamination → replay race). 각 회차마다
제안된 fix 가 다음 fix 의 race/edge 를 노출. 결과는 단일 PR 이지만
implementation 의 layered correctness (parser → state machine → snapshot →
race ordering) 는 review 없이는 도달하기 어려웠다. 같은 영역의 리뷰가
반복해서 다른 layer 의 bug 를 짚으면 — `feedback_codex_stoptime_iteration`
메모처럼 — "이미 고쳤음" 으로 무시 금지.

### 검증

- `pnpm -r build` 성공.
- `bridge` 패키지 `tsc --noEmit` clean.
- `npx vitest run -t "idle"` 48 passed; `-t "tool action"` 7 passed; `-t "spinner"` 36 passed; `-t "timelineEntryToSpans"` 7 passed.
- 추가된 테스트: codex-output-parser dedup 4 cases + idle source 단언 보강 + apme-telemetry-envelope `tool_exec → tool_call` 매핑 1 case.
- 수동 검증은 이번 세션에서 못 함 (Codex 실세션 필요): Apple/Android tablet timeline 에서 multi-bash prompt 가 chat 카드 1개로 표시되는지, `apme.sqlite` 의 Codex run turns.tool_calls > 0 인지.

---
