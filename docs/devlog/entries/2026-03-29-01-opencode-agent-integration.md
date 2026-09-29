# 2026-03-29 — OpenCode Agent Integration

### 문제
AgentDeck이 Claude Code와 Codex CLI만 지원. OpenCode (Go 기반 코딩 에이전트) 추가 필요.

### 해결
OpenCode가 구조화된 HTTP API + SSE 이벤트를 제공한다는 것을 발견 (`opencode serve`, `GET /global/event`). 처음에는 API-only(non-PTY) 방식으로 구현했으나, 사용자가 TUI에서 직접 작업하길 원해 **PTY + SSE 하이브리드** 방식으로 전환.

**최종 구조**: `OpenCodeAdapter extends PtyAdapter`
- PTY: `opencode --port XXXX` — 사용자가 TUI에서 직접 코딩
- SSE: 내장 서버의 `/global/event`에 연결 — 구조화된 이벤트 수신
- TUI 파싱 불필요 — SSE가 상태/도구/토큰/모델 정보를 모두 제공

### 핵심 설계 결정
1. **SSE 이벤트가 TUI 파싱을 완전 대체**: Codex CLI는 TUI 출력을 regex로 파싱(CodexOutputParser)하지만 OpenCode는 SSE 이벤트가 있어 `wireOutputParser()`와 `feedParser()`가 no-op. 더 안정적이고 유지보수 용이
2. **내장 서버 포트**: `opencode --port XXXX`로 실행하면 TUI와 HTTP 서버가 동시에 뜸. 어댑터가 랜덤 포트(14096+) 할당
3. **세션 자동 추적**: SSE의 `session.status` 이벤트에서 첫 번째 세션을 자동으로 추적
4. **OpenCode API 검증**: `opencode serve` + curl로 직접 검증. SSE 이벤트 타입: `session.status` (busy/idle), `message.part.updated` (tool/text/step-finish), `message.updated` (model/tokens/cost), `permission.requested`
5. **setPtyMode 분기**: `hasTerminal` 기반으로 변경 — non-PTY 어댑터(Monitor, OpenClaw)에서 stderr 로그가 숨겨지는 버그 수정

### 파일
- `bridge/src/opencode-client.ts` — HTTP API 클라이언트 + SSE EventSource
- `bridge/src/adapters/opencode-adapter.ts` — PtyAdapter + SSE 하이브리드
- `bridge/src/__tests__/opencode-client.test.ts` — 클라이언트 단위 테스트 (13개)
- `shared/src/adapter.ts` — `'opencode'` AgentType + OPENCODE_CAPABILITIES
- `bridge/src/cli.ts` — `agentdeck opencode` CLI 커맨드

---
