# 2026-06-06 — Codex 개발 표면 정비 (AGENTS 컨텍스트, repo skills, setup/CLI)

### 문제

AgentDeck는 Codex 세션/훅 지원을 이미 갖고 있었지만, 개발 지침과 자동화 표면은 Claude Code 중심으로 남아 있었다. `AGENTS.md`가 매 작업마다 800KB 이상인 `DEVELOPMENT_LOG.md` 전체 읽기를 요구했고, `.claude/skills`에 있는 AgentDeck 전용 skill들은 `.gitignore` 대상이라 Codex repo skill로 자동 발견되지 않았다. 또한 setup 경로가 Claude CLI를 필수로 요구하고, `agentdeck codex`는 lifecycle hook 설치 결과를 로그로 노출하지 않아 Codex 관찰이 꺼진 상태를 알아차리기 어려웠다.

### 수정

- `AGENTS.md`의 컨텍스트 규칙을 `CLAUDE.md` 우선 + `DEVELOPMENT_LOG.md` 최신/관련 항목 검색 방식으로 변경했다.
- `.agents/skills/`에 Codex repo skills를 추가했다: `agentdeck-workflows`, `agentdeck-deploy`, `sdc-diagnose`.
- `setup/src/setup.ts`와 `scripts/install.sh`를 Claude 또는 Codex CLI 중 하나만 있어도 setup이 진행되도록 수정하고, Codex 사용 안내를 추가했다.
- 로컬 `scripts/install.sh`는 Codex CLI가 있을 때 `hooks/dist/install.js`의 `installCodexHooksIfNeeded()`를 호출해 Codex observation hook을 설치한다.
- `agentdeck codex`가 `~/.codex/config.toml` hook 설치/skip/failure 결과를 stderr에 출력하도록 변경했다.

### 검증

- `pnpm --filter @agentdeck/setup build`
- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm --filter @agentdeck/hooks build`

---
