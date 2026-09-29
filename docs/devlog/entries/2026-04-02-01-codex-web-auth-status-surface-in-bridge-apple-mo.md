# 2026-04-02 — Codex Web Auth Status Surface in Bridge + Apple Monitor

### 문제
Codex / ChatGPT 웹 인증으로 Codex를 쓰는 경우, 공식 OpenAI usage/cost API는 web auth token을 받지 않아 실시간 리밋 게이지를 직접 표시할 수 없었다. 대신 앱에서는 해당 계정이 실제로 연결돼 있는지, 어떤 플랜인지조차 보이지 않았다.

### 해결
- `bridge/src/codex-auth.ts`: `~/.codex/auth.json`을 읽어 `auth_mode`, `last_refresh`, JWT payload의 `chatgpt_plan_type`, `chatgpt_account_id`, `chatgpt_subscription_active_until`을 추출
- `shared/src/protocol.ts` / `bridge/src/usage-event.ts`: `usage_update`에 `codexAuthMode`, `codexWebAuthConnected`, `codexPlanType`, `codexAccountId`, `codexSubscriptionActiveUntil`, `codexLastRefreshAt` 필드 추가
- `bridge/src/bridge-core.ts`: usage broadcast 시 Codex web-auth 메타데이터를 함께 실어 나르도록 연결
- `apple/AgentDeck/Model/*.swift`, `AgentStateHolder.swift`: 새 usage 필드를 상태에 반영
- `TankStatusPanel.swift`: `Codex Web` 연결 점, `Plan`, `Until` 표시 추가

### 핵심 설계 결정
- **실시간 usage와 web-auth 상태를 분리**: ChatGPT/Codex web auth는 공식 usage endpoint를 호출할 수 없으므로, 리밋 수치가 아니라 계정 상태를 따로 노출
- **JWT payload best-effort 파싱**: auth.json top-level 값이 비어 있어도 access/id token payload에서 plan/account/subscription 메타데이터를 복구

### 검증
- `pnpm --filter @agentdeck/plugin typecheck`
- 결과: 통과
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS ...`
- 결과: Swift 쪽 신규 필드 컴파일은 진행됐고, 최종 실패는 DerivedData dependency file 생성 환경 문제

### 후속 수정
- `~/.codex/auth.json`의 `chatgpt_plan_type`, `chatgpt_subscription_active_until`, `chatgpt_account_id`는 JWT payload 최상위가 아니라 `https://api.openai.com/auth` namespace 안에 들어 있었다.
- `bridge/src/codex-auth.ts`와 `apple/AgentDeck/Daemon/Core/UsageAPIClient.swift`가 이 중첩 claim을 읽지 못해, 실제 Plus/Pro 계정이어도 UI에서 plan/until이 비어 보일 수 있었다.
- 중첩 namespace 파싱을 추가해 `ChatGPT Plus/Pro`와 `Until`이 정상적으로 복구되도록 수정했다.

### 추가 검증
- `pnpm --filter @agentdeck/shared typecheck`
- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm --filter @agentdeck/plugin typecheck`
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataVerify build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`

### UI 재구성 후속
- `TankStatusPanel.swift`를 `OpenClaw / OLLAMA / MLX / Subscriptions` 섹션 구조로 재구성
- `ChatGPT Plus · 2026-04-19`처럼 플랜과 만료일을 한 줄로 표시하도록 변경
- `OAuth` 점 라벨은 제거하고, 구독형 인증 서비스는 `subscriptions` 배열로 별도 노출
- `MLX`는 `http://127.0.0.1:8800/v1/models` probe를 추가해 모델 목록을 수집
- `Ollama`는 `/api/ps` 기준으로 현재 실제 구동중인 모델 목록을 우선 노출
- Android monitor / e-ink status panel도 같은 섹션 구조로 맞춤

### 비고
- Claude 쪽은 현재 daemon이 정확한 플랜명(`Claude Max`)을 항상 보장하지 못해 우선 `Claude Subscription`으로 노출
- ChatGPT는 web auth JWT의 OpenAI auth namespace에서 정확한 plan/until을 복구

---
