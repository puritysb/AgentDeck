# 2026-05-11 — Codex lifecycle hook feature flag rename

### 문제

Codex CLI 가 `⚠ [features].codex_hooks is deprecated. Use [features].hooks instead.`
경고를 출력했다. 현재 사용자 `~/.codex/config.toml` 의 AgentDeck fenced block 과
AgentDeck 의 Codex observation installer(Node + Swift)가 모두 예전
`[features] codex_hooks = true` 키를 쓰고 있어 수동 수정 후에도 재설치 시 경고가
되살아날 수 있었다.

### 해결

- 사용자 `~/.codex/config.toml` 의 AgentDeck fenced block 을 `[features] hooks = true`
  로 즉시 마이그레이션했다.
- Node `hooks/src/codex-install.ts` 와 macOS `CodexConfigInstaller.swift` 가 새
  `hooks = true` feature flag 를 쓰도록 변경했다.
- Node/Swift 테스트 기대값과 App Review notes 의 Codex observation 설명을 새 키로
  갱신했다.
- OpenAI docs MCP 의 config reference 는 아직 `features.codex_hooks` 로 표시되어
  있었지만, 로컬 Codex CLI 의 deprecation warning 을 현재 런타임 기준으로 채택했다.

---
