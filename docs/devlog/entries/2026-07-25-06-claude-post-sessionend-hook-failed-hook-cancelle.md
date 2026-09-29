# 2026-07-25 — Claude 훅 POST 타임아웃: `SessionEnd hook ... failed: Hook cancelled`

### 문제
`claude update` 종료 시 stderr 에 `SessionEnd hook [PORT="${AGENTDECK_PORT:-}" ...]
failed: Hook cancelled` 가 찍혔다. 설정 오류도, 데몬 부재도 아니다 — Claude Code
바이너리(2.1.220) 확인 결과 `Hook cancelled` 는 훅 프로세스가 `ABORT_ERR` 를 받은
경우에만 나오는 문자열이고, 종료 경로는 SessionEnd 훅 전체를
`AbortSignal.timeout(getSessionEndHookTimeoutMs())` 로 감싼다. 그 값은
`max(1500, min(설정된 hook timeout, 60000))` — 설정에 `timeout` 이 없으면
**1.5초 고정**(env `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` 로만 상향).

우리가 심는 fire-and-forget 훅 커맨드의 POST curl 에는 `--max-time` 도
`--connect-timeout` 도 없었다. 데몬이 **재시작 중**이면 소켓은 열려 있는데 응답이
없는 구간이 생기고(그날 병행 세션이 `daemon stop` → ESP32 pio upload →
`daemon start` 를 돌리는 중이었다), 포트 탐색 `/health` 프로브도
connect timeout 없이 0.3초를 먼저 버린 뒤 9120 으로 무조건 POST → 무한 대기 →
1.5초 예산 초과 → abort. 실측: 무응답 포트에 기존 커맨드는 3초 후에도 살아 있고,
패치본은 0.83초에 종료.

### 해결
fire-and-forget 이벤트(SessionStart/SessionEnd/PostToolUse/PostToolUseFailure/
Notification/UserPromptSubmit)의 POST 에 `--connect-timeout 0.2 --max-time 0.8`,
`/health` 프로브에 `--connect-timeout 0.2` 를 추가했다. Codex 설치기
(`hooks/src/codex-install.ts`, `CodexConfigInstaller.swift`)에는 이미 있던 값 —
Claude 경로만 빠져 있었다. byte-identical 불변식대로 **미러 4곳 전부**:

- `hooks/src/install.ts` (정본)
- `setup/src/setup.ts` (인라인 복제본)
- `bridge/src/hook-migration.ts` (레거시 복제본)
- `apple/AgentDeck/Daemon/Core/HookInstaller.swift` — **실제로 유저글로벌
  `~/.claude/settings.json` 을 쓰는 주체**

`PreToolUse`(`--max-time 60`, 디바이스 승인 롱폴)와 `Stop`(`--max-time 10`,
턴엔드 디렉티브 큐)은 request-response 라 그대로 뒀다.

### 핵심 설계 결정
- **fire-and-forget 훅은 반드시 bounded.** 응답(`{received:true}`)이 Claude 를
  조향하지 않는 이벤트에서 무한 대기는 이득이 0이고, 호스트 종료를 붙잡는
  손해만 있다. 호스트가 훅에 주는 예산(SessionEnd 1.5초)이 우리 타임아웃보다
  작을 수 있다는 전제를 커맨드 생성부 주석에 박아뒀다.
- `>/dev/null 2>&1` 로 응답 본문도 버린다 — Codex 경로와 동일. 조향 정보가 없는
  이벤트의 stdout 은 호스트에 노이즈일 뿐이다.
- 회귀 가드는 "타임아웃 플래그가 존재하는가"로 `hooks/src/__tests__/install.test.ts`
  에 넣었다. 커맨드 문자열 전체 비교는 미러 4곳을 동시에 깨뜨려서 부적합.

### 알려진 후속 (이번 커밋 범위 밖) — **둘 다 2026-07-26 항목에서 처리됨**
- **node 설치기 3곳이 모두 `~/.claude/settings.local.json` 에 쓴다.** Claude Code
  의 `localSettings` 는 `<git root|cwd>/.claude/settings.local.json` 이라
  홈이 프로젝트 루트가 아니면 **읽히지 않는다** — CLI 로만 설치한 사용자는 훅이
  죽은 파일에 들어간다(Swift 앱이 `settings.json` 에 깔아주는 환경에서만 동작).
  Swift 쪽은 이미 이 경로를 legacy 로 취급해 마이그레이션까지 갖고 있다
  (`HookInstaller.swift:61`) — node 쪽만 안 따라왔다.
- `bridge/src/hook-migration.ts` 의 로컬 `buildHookCommand` 에는 PreToolUse/Stop
  의 request-response 분기가 없다. 그 `applyHooks` 가 실효 파일에 돌면 두 훅을
  fire-and-forget 으로 강등시킨다. 지금은 위의 죽은 파일만 건드려서 무해.

---
