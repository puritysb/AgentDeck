# 2026-06-06 — GLM/API-backed Claude Code 세션의 Claude quota 표시 차단

### 문제

Claude Code 를 Anthropic 공식 subscription 모델이 아니라 GLM 같은 API-backed 모델로 사용하는 경우에도, AgentDeck 이 `api.anthropic.com/api/oauth/usage` 에서 읽은 Claude OAuth 5h/7d quota 를 그대로 표시했다. 이 값은 현재 GLM/API 세션의 사용량이나 제한이 아니라 남아 있는 Claude 계정 quota 이므로, UI 에서는 정확한 정보처럼 보이는 잘못된 숫자였다.

### 수정

- `buildUsageEvent()` 에서 5h/7d/extra usage quota 는 subscription quota 가 적용되는 Claude 모델(alias: `claude`/`opus`/`sonnet`/`haiku`)일 때만 포함한다.
- 현재 모델명이 `glm-5.1` 등 Claude 계열이 아니면 OAuth 연결 상태는 유지하되, 5h/7d quota 필드는 이벤트에서 제거해 모든 downstream surface 가 자연스럽게 숨기도록 했다.
- `usage-event` 순수 단위 테스트를 추가해 GLM 모델에서는 quota 가 빠지고, `opus-4.6` 같은 Claude alias 에서는 기존처럼 표시되는지 검증한다.

### 검증

- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm vitest run bridge/src/__tests__/usage-event.test.ts`
- `pnpm --filter @agentdeck/bridge build`
- `pnpm vitest run bridge/src/__tests__/bridge-core.test.ts` 는 기존 WS/http lifecycle suite 가 출력 없이 hang 하여 중단하고, 위 순수 단위 테스트로 변경 범위를 검증했다.

---
