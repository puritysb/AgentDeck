# 2026-06-06 — Codex session-end repo skill 추가

### 문제

Claude Code 의 `/session-end` 역할(세션 종료 전 공유 메모리 정리, clear/new 이후 작업 인계)을 Codex 환경에서 대체할 표면이 필요했다. Codex에는 같은 이름의 기본 slash command가 없고, custom prompts는 deprecated라 repo-shared workflow로 쓰기에는 부적합했다.

### 수정

- `.agents/skills/session-end/SKILL.md` 를 추가해 Codex repo skill로 세션 종료/인계 절차를 정의했다.
- handoff 출력 형식, `git status`/`git diff --stat` 기반 상태 확인, durable docs 업데이트 기준(`DEVELOPMENT_LOG.md` / `CLAUDE.md` / `AGENTS.md`)을 명시했다.
- `CLAUDE.md`의 Codex Development Surface에 `session-end` 사용 규칙을 추가했다.

### 검증

- Skill frontmatter와 파일 위치 확인.

---
