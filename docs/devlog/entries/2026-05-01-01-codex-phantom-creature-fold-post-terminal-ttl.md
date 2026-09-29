# 2026-05-01 — Codex phantom-creature fold + post-terminal TTL

### 문제

CLI (Node `agentdeck` daemon) 이 동작하지 않고 macOS App Store 빌드의 in-process Swift daemon 만 떠있는 환경에서, Dashboard 의 Terrarium 에 실제 동작 중인 Codex 세션 수보다 훨씬 많은 Codex 크리처가 노출되고 일부는 `processing` 상태로 "행동" 중인 것처럼 보였다. 원인 조사:

- `~/.codex/session_index.jsonl` 144개 entry 중 114개가 `Codex Companion Task: <task> Run a stop-gate review...` — Claude Code 의 stop-gate / rescue workflow 가 자동 spawn 한 ephemeral Codex 작업 (4월 29일 하루 27건).
- Codex 는 turn 마다 새 thread_id 를 발급하고 daemon 은 hook (`codex_session_start`/`codex_user_prompt_submit`/...) 또는 OTel `/otel/v1/traces` 두 합성 경로로 thread_id 별 entry 를 만든다. 한번 합성된 entry 는 `pushedSessionStaleTTL = 180s` 동안 살아남아 짧은 ephemeral task 가 연속으로 돌면 4-5개가 동시에 가시화됐다.
- Swift daemon 로그 (2026-04-29 23:00–23:04, 4분 윈도우) 에서 4개 distinct codex thread id 합성 → 모두 180s TTL 만료로 evict 되는 패턴 그대로 잡힘.

### 해결 (3-layer)

1. **Render-time fold by `(agentType=codex-cli, projectName)`** (`apple/AgentDeck/Terrarium/TerrariumState.swift:182-280`): cloud creature 를 프로젝트 키로 그룹핑해 한 워크스페이스 내 ephemeral burst 를 sprite 1개로 collapse. `CloudCreatureState.groupSize` 필드 추가. 빈 projectName 은 `__id__\(id)` 폴백으로 thread 별 분리. 같은 fold 를 PixooRenderer (`syncCreatures`) 에도 적용. Octopus(Claude Code) / OpenCode 는 fold 안 함 (multi-instance 가 의도된 패턴).
2. **Post-terminal TTL 60s** (`apple/AgentDeck/Daemon/Server/DaemonServer.swift`): `lastTerminalCodexEventBySession` 추가. `codex_stop`/`codex_turn_complete`/OTel `turnEnd` 에서 stamp, 비종료에서 clear. `evictStaleHookSessions()` 가 이 stamp 가 60s 이전이면 추가로 evict. 180s 무-hook TTL 은 never-terminated zombie 안전망으로 유지.
3. **Resurrection 범위 좁힘** (`shouldSynthesizeUnknownHookSession`): codex 분기에서 `codex_tool_start` 부활 제거. 부활은 `codex_session_start` + `codex_user_prompt_submit` 로 한정. `codex_user_prompt_submit` 은 인터랙티브 다중 턴 Codex 가 post-terminal TTL 로 evict 된 뒤 사용자가 다음 프롬프트를 보낼 때 복귀하는 경로라 유지 (live process 인데 dashboard 에서 사라진 채로 못 돌아오는 사례 차단). `codex_tool_start` 는 mid-turn 시그널이라 이미 끝난 thread 의 leftover 가능성이 큼.

### 검증

- 회귀 가드: `apple/AgentDeckTests/TerrariumCloudFoldTests.swift` (7 tests) — fold by project, 다른 project 는 분리, 빈 project over-merge 방지, state precedence, primary+sibling fold, octopus 비-fold, resurrection predicate trade-off.
- `xcodebuild build -project AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS'` **BUILD SUCCEEDED**.
- `xcodebuild build-for-testing -scheme AgentDeck_macOS -derivedDataPath …` **TEST BUILD SUCCEEDED**.
- `pnpm test` 47파일 1061테스트 통과 (Node bridge 무영향).

### 후속 (out-of-scope)

- D200H 버튼 fold (focus_session 이 thread 단위라 별도 설계 필요).
- `bridge/src/passive-observer.ts` 의 Node CLI 경로 mirror.

---
