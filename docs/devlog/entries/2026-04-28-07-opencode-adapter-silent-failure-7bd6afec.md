# 2026-04-28 — OpenCode adapter silent-failure 가시화 (`7bd6afec`)

### 문제

사용자 보고: macOS Apple 대시보드에서 OpenCode 크리처가 보이지 않음. SessionListPanel + `agentdeck status` **양쪽 다** 비어 있음 → Terrarium 매핑 단계가 아니라 upstream 등록 단계 누락. 정적 분석으로 확인된 OpenCode 의 시스템 진입 경로는 단 한 가닥 (`agentdeck opencode` → DaemonWsClient → `session_push_register`) 뿐 — Claude Code 처럼 hook 자동발견 없음.

### 해결

두 단계 하드닝 — 사용자가 어디서 끊겼는지 stderr 로 즉시 보이게:

1. **`bridge/src/check-deps.ts:25-30`** — `AGENT_DEPS` 에 `opencode` 항목 추가. PATH 에 `opencode` 바이너리가 없으면 `[agentdeck] ERROR: opencode not found. Install: brew install sst/tap/opencode (or: npm i -g opencode-ai)` + `exit 1`. claude-code / codex-cli 와 parity.

2. **`bridge/src/adapters/opencode-adapter.ts`** — `connectToEmbeddedServer` 의 4 개 silent `return` 분기 (15s 폴링 timeout, `/global/health` 실패, session resolve 실패, SSE subscribe 실패) 를 `debug` 로깅에서 `stderrLog` 로 격상. PTY 절반은 살아있다는 사실을 메시지에 명시 ("TUI still works, state events missing") 해서 사용자가 재시작 vs 부분 모드 수용을 판단 가능.

### 핵심 설계 결정

- **App Store 모드는 OpenCode 미지원이 의도된 분리** — `docs/appstore-feature-matrix.md:47` 에 명시. OpenCode embedded server 가 random-port + no lock-file 이라 sandbox 에서 passive discovery 불가. App Store 단독 모드에서 OpenCode 크리처 부재 = bug 아님. 외부 Node CLI (`agentdeck daemon` + `agentdeck opencode`) 동시 운영해 `DaemonService.isUsingExternalDaemon=true` 일 때만 sibling 으로 흘러들어감. Apple 측 `OpenCodeCreature.swift` / `syncOpenCode` 등은 CLI-coexists 시나리오 전용 — dead code 아님.

- **Outer `.catch(stderrLog)` 신뢰 금지 패턴** — Codex stop-gate review 가 1차 fix (outer wrapper 만 격상) 가 무용함을 잡아냄. 이유: `connectToEmbeddedServer` 가 실패 시 throw 가 아니라 silent `return` → outer catch 미발화. 같은 패턴 다른 adapter 에도 있을 가능성 (codex-cli, openclaw) — 차후 audit 시 inner 분기까지 봐야.

- **세션이 안 보이면 Terrarium 부터 의심하지 말 것** — sessions_list 가 비어있으면 100% upstream (registration / discovery) 문제. SessionListPanel 와 `agentdeck status` 양쪽이 동시에 비어있다 = Node bridge 가 sessions.json 에 못 들어왔다 = bridge process 자체가 없거나 crash.

### 검증

- `pnpm vitest run bridge` 785/785 통과 (회귀 없음)
- `tsc --noEmit` 통과
- 사용자 진단 절차: `which opencode` → `agentdeck opencode --debug` → 별도 터미널에서 `agentdeck status`. 어느 줄에서 끊기는지가 root cause

---
