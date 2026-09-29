# 2026-07-28 — Codex user hook을 config.toml 단일 표현으로 병합

Codex 0.141은 같은 config layer에 `hooks.json`과 inline `[hooks]`가 함께 있으면
둘을 병합하면서 시작 경고를 낸다. 로컬 구성은 workmux가
`~/.codex/hooks.json`, AgentDeck이 `~/.codex/config.toml`을 사용해 이 조건에
해당했다. workmux의 5개 lifecycle hook을 공식 `[[hooks.<Event>]]` 배열로
`config.toml`에 옮기고, 원본 JSON은
`hooks.json.pre-toml-consolidation-20260728`로 보존했다. `codex doctor`에서
`config.toml parse ok`와 중복 source 경고 제거를 확인했다.

재설치 내구성을 위해 Node/Swift `MiniToml`에 hook 충돌 판별을 분리했다.
공식 lifecycle array와 `[hooks.state]`는 보존·병합하고, 충돌 가능한 일반
`[hooks]`/`[hooks.*]` table만 계속 거부한다. 따라서 AgentDeck daemon이 managed
fence를 갱신해도 같은 TOML에 둔 workmux hook이 사라지지 않는다.

검증: hooks Vitest 41/41, hooks TypeScript compile, macOS 대상 XCTest
(`MiniTomlTests` + `CodexConfigInstallerTests`) 26/26, `git diff --check` 통과.

---
