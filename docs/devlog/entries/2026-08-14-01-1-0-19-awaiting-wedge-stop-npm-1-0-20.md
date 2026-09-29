# 2026-08-14 — 1.0.19 AWAITING wedge·Stop 유실 회귀 수정 (npm 1.0.20 준비)

### 배경

- 1.0.19(#184)의 사후 적대적 리뷰에서 확정 회귀 2건을 찾았다. (1) AWAITING_* 탈출
  신호였던 parser `spinner_start`/`idle_detected`를 Claude/Codex 어댑터에서 제거하면서
  hook 기반 탈출 전이를 추가하지 않아, **키보드로 프롬프트에 답한 managed 세션이 영구
  amber awaiting**에 고착됐다 (`stop`은 `PROCESSING→IDLE`뿐, Stop 핸들러가 전이 전에
  question을 비워 "질문 없는 awaiting" 스냅샷까지 방송). (2) Claude Stop hook 유실 시
  복구(스피너+링버퍼 3경로)가 대체 없이 삭제돼 상태 5분 고착·타임라인 미폐쇄·APME 응답
  유실이 남았고, 1.0.19 노트에 Codex 쪽 감쇠만 명시됐다. 기존 테스트는
  `handleParserEvent('spinner_start')`를 직접 호출해 **도달 불가 경로를 green으로
  인증**하고 있었다.

### 변경

- `shared/src/states.ts`에 hook 탈출 전이 추가: `AWAITING_* → IDLE (stop)`,
  `AWAITING_* → PROCESSING (user_prompt_submit)`, `AWAITING_*/IDLE → PROCESSING
  (tool_activity)`. PreToolUse/PostToolUse(및 codex_tool_*)가 `tool_activity`로
  프롬프트 해제를 증명하되, **프롬프트 표시 직후 1.5s grace** 동안은 병렬 툴 완료나
  늦게 도착한 hook curl이 진짜 프롬프트를 지우지 못한다
  (`AWAITING_TOOL_DISMISS_GRACE_MS`). AWAITING 이탈 시 프롬프트 필드 클리어를
  `transition()`으로 중앙화 — 이탈 경로마다 수동 클리어가 갈라지던 것을 봉합.
- **missed-Stop watchdog** (`bridge/src/claude-turn-watchdog.ts`): 턴이 열린 채 hook
  채널이 10s+ 침묵하면 transcript JSONL tail을 프로브(mtime 게이트, 512KB cap)해
  마지막 message 레코드가 `assistant`+`stop_reason:"end_turn"`이고 timestamp가 턴
  시작 이후면 synthetic Stop을 어댑터 이벤트 파이프에 주입 — 상태머신·타임라인·APME가
  기존 Stop 경로로 일관되게 닫힌다. `tool_use`(권한/AskUserQuestion 대기)는 절대 완료로
  판정하지 않고, 늦은 실제 Stop은 `ccPendingCompletion`이 dedup. 판정 근거는 실제
  transcript 실측 (완결 턴의 tail = `end_turn`, `mode` 등 non-message 레코드는 스킵).
- **Codex hook-silence 경고** (`bridge/src/codex-hook-silence.ts`): hook과 notify가
  같은 curl/`AGENTDECK_PORT` 경로를 타므로 공동 실패 시 무신호였던 것을, "PTY는
  활동 중인데 codex_* 이벤트가 한 번도 안 옴"이 2분 지속되면 로그+타임라인 error
  행으로 1회 경고. `--no-codex-hooks` 옵트아웃은 경고하지 않음
  (`codexHooksExpected` 배선).
- `codex_stop`의 `message`→error 매핑 제거: 실측 codex_stop 311건(≤0.146.0)에
  `message`/`error` 키 모두 0회, `message`는 다른 이벤트에서 콘텐츠 키이므로 향후
  등장 시 전 턴이 "Error:"로 렌더되는 쪽이 비용이 크다. 명시적 `error`만 매핑.
- `compatibleCodex`(bridge/package.json)를 런타임이 실제로 읽도록 배선
  (`getCompatibleCodexRange`) — 하드코딩 리터럴과의 이중화 제거.
- 문서 잔존 드리프트 5건 정리: `docs/protocol.md` 상태머신 절(감지 표가 spinner/idle을
  상태 소스로 서술), `docs/apme.md`, `docs/apme-pipeline.md`(삭제된 Path A/B/C를 현행
  서술), `docs/why-apme.md`, `docs/roadmap.md` — hook-primary 구조와 watchdog 반영.
  `states.ts`/`state-machine.ts`의 낡은 주석도 함께 수정.

### 머지 전 적대적 리뷰 반영 (2차 커밋)

- 병렬 sibling 오해제: PostToolUse 해제는 in-flight 카운터(PreToolUse++/
  PostToolUse--)가 0일 때만 — gated tool 이 pending 인 동안 sibling 완료는 해제
  증거가 아니다. same-kind 프롬프트 재감지는 grace 를 갱신한다.
- 늦은 tool-end straggler 가 Stop 후 IDLE 을 5분 phantom PROCESSING 으로 재개방하던
  것 차단 (IDLE 복구는 tool START 만).
- 데몬 hub 의 전역 상태머신은 관측 세션 전부를 멀티플렉스하므로
  `toolActivityRecovery: false` — 남의 세션 tool hook 이 OpenClaw 승인 프롬프트를
  지우는 오염 차단. Swift 미러 테이블도 states.ts 와 동기화 (hub 드라이버는
  tool_activity 를 방출하지 않는다는 계약 주석 포함).
- watchdog: SessionEnd 가 `stopped` 를 영구 래치하던 것 수정 — `/clear` 가
  SessionEnd+SessionStart 를 쌍으로 발화하므로 래치는 첫 `/clear` 이후 복구를
  영원히 껐다. 영구 정지는 `core.onShutdown → stop()` 경로만.
- `readTurnEndProbe` 를 fd 기반 tail 읽기(256KB)로 교체 — 60MB transcript 를 5초
  폴마다 전체 slurp 하던 것 제거. codex_session_start 조기 유실로 인한 hook-silence
  오경보 수정 (adapter.start 전 조기 리스너). `compatibleCodex` 필드는 shape 검증
  (satisfiesRange 가 미지원 문법을 조용히 통과시키는 fail-open 차단).

### 검증

- 상태머신 hook-탈출 15케이스는 실경로(`handleHookEvent`)로 구동. watchdog 10케이스,
  transcript 프로브 6케이스, hook-silence 5케이스, codex_stop 매핑 2케이스 신규.
  전체 182 파일 2,945 테스트 green.
- Stop 유실이 현재도 실재함을 실측: 1.0.19 배포 후 Claude 턴 9개 중 2개 open 잔존,
  닫힌 7개 중 3개 response 없음 (apme.sqlite, Claude Code 2.1.231).
- codex_stop payload 실측 311건 (≤0.146.0): `message`/`error` 키 등장 0회.

---
