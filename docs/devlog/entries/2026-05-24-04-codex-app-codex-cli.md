# 2026-05-24 — Codex App / Codex CLI 세션 표시 분리

### 문제
- Codex App OTel만 들어온 세션이 `codex:otel-active` + `agentType=codex-cli` + 빈 `projectName`으로 생성되어 D200H/타임라인에서 `OPENCLAW_CODEX-CLI__`처럼 빈 프로젝트명으로 보였다.
- Codex CLI lifecycle hook 세션과 Codex App OTel 세션을 모두 `codex-cli`로 취급해 같은 프로젝트에서 두 종류가 동시에 살아 있어도 display folding이 하나로 합쳐질 수 있었다.

### 해결
- OTel 기반 Codex App 세션은 새 `agentType=codex-app`으로 생성하고, cwd가 아직 없을 때는 프로젝트명을 `Codex App`으로 채운다. 이후 cwd가 들어오면 실제 프로젝트명으로 승격한다.
- Codex CLI와 Codex App folding key를 `(agentType, projectName)`으로 맞춰 같은 `AgentDeck` 프로젝트라도 두 세션 종류가 별도 타일/creature로 보이게 했다.
- macOS, Android, Stream Deck/D200H, Pixoo, bridge/plugin/shared 렌더링 경로에 `codex-app` label/icon/color/rank를 추가했다.
- 검증: `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' -only-testing:AgentDeckTests_macOS/ProtocolTests -only-testing:AgentDeckTests_macOS/TerrariumCloudFoldTests`, `./gradlew :app:compileDebugKotlin`, `./gradlew :app:testDebugUnitTest`, `pnpm vitest run shared/src/__tests__/session-utils.test.ts`, `pnpm --filter @agentdeck/shared typecheck`, `pnpm --filter @agentdeck/shared build`, `pnpm --filter @agentdeck/plugin typecheck`, `pnpm --filter @agentdeck/bridge typecheck` 통과.

---
