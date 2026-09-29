# 2026-06-06 — Codex hook timeout 누적 방지

### 문제

Codex `PreToolUse`/`PostToolUse` hook 이 `hook timed out after 5s` 로 반복 실패하고, timeout 된 hook 의 `curl -d @-` 자식 프로세스가 남아 9120 연결을 누적 점유했다. 누적 후에는 `/health` 도 연결 timeout 이 발생하며 AgentDeck HTTP listener 가 포화 상태로 악화됐다.

### 원인

`~/.codex/config.toml` 에 설치되는 AgentDeck Codex lifecycle hook 은 health probe 에만 `--max-time 0.3` 을 걸고, 실제 `/hooks/codex_*` POST 에는 curl timeout 을 걸지 않았다. AgentDeck daemon 이 busy 하거나 9120 연결이 밀리면 Codex 는 hook wrapper 를 5초 뒤 timeout 처리하지만, 자식 `curl` 은 계속 남을 수 있었다.

### 수정

- `CodexConfigInstaller.swift` 와 `hooks/src/codex-install.ts` 의 Codex hook POST 명령에 `--connect-timeout 0.2 --max-time 0.8` 을 추가했다.
- Swift/TypeScript installer 테스트에 bounded curl invariant 를 추가해 무제한 POST 회귀를 막았다.

---
