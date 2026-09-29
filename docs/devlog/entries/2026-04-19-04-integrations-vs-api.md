# 2026-04-19 — Integrations 재정리 (계정 vs API 키 두 그룹)

### 문제
Settings → Integrations 가 5개 통합(Claude / Codex / OpenClaw / Antigravity / Anthropic Admin) 을 한 줄로 늘어놓아 "토큰 없이 동작하는 것" 과 "토큰 입력이 필요한 것" 의 차이가 사라져 있었다. OpenClaw 행은 7가지 `gatewayAuthStatus` 분기마다 다른 help text 를 노출했고, 토큰 입력 필드는 `shouldShowOpenClawGatewayTokenEditor` 라는 복합 조건으로 들쭉날쭉 보였다. Onboarding `IntegrationsPane` 과 dashboard `SetupNeededCard` 가 같은 통합을 서로 다른 문구로 3중 노출. Antigravity 는 SQLite `antigravityUnifiedStateSync.modelCredits` 키에서 잔여 크레딧을 뽑을 수 있는데도 plan name 만 표시.

### 해결
- **단일 카탈로그**: `apple/AgentDeck/UI/Settings/IntegrationsView.swift` 신설. `IntegrationCatalog` (5개 descriptor) + `IntegrationStatusEvaluator` (DashboardState → IntegrationStatus 매핑) + `IntegrationRow` (3가지 mode: settings / onboarding / setupCard) + `IntegrationsView` (두 그룹 컨테이너).
- **두 그룹 분리**: `IntegrationKind.accountLinked` (Claude / Codex / OpenClaw / Antigravity — CLI 로그인이나 Web UI 페어링으로 자동 감지) vs `IntegrationKind.apiKey` (Anthropic Admin — 사용자 명시 입력). 그룹 헤더에 한 줄 설명을 붙여 "여기는 토큰 안 넣어도 됨" / "여기만 키 입력" 을 즉시 구분.
- **OpenClaw 7→3 상태 머지**: `connected` / `awaiting`(approval_pending · pairing_required · gateway_reachable · gateway_token_missing) / `failed`(auth_failed · token_mismatch · device_auth_invalid · unsupported_protocol). 토큰 필드는 Advanced disclosure 안으로 숨김 — App Store 페어링은 Keychain Ed25519 device key 로 default 동작하므로 99% 사용자에게 토큰은 불필요.
- **Antigravity 크레딧 노출**: `bridge/src/antigravity-local.ts:parseModelCredits` 를 Swift 로 포팅 (`UsageAPIClient.parseAntigravityModelCredits` + 4개 protobuf 헬퍼). 행에 "Google AI Pro · 1000 cr" 형태로 표시. 프로토콜/state 필드(`availableCredits`, `minimumCreditAmountForUsage`)는 이미 end-to-end 로 wired 되어 있었고 Swift 측 reader 만 비어 있던 상태였음.
- **세 화면 통일**: SettingsScreen.servicesContent, OnboardingSheet.IntegrationsPane, SetupNeededCard.setupNeededItems 가 모두 같은 catalog/evaluator 를 참조. SettingsScreen 에서 ~184줄 (codexAuthRow / openClawIntegrationRow / openClawGatewayHelpText / status label·color helpers / shouldShowOpenClawGatewayTokenEditor / anthropicAdminApiRow / latestAdminApiUsageSummary / formatTokenCount) 제거.

### 핵심 설계 결정
- **OpenClaw 토큰은 옵션이지 default 가 아니다.** `OPENCLAW_GATEWAY_TOKEN` 은 Gateway 가 shared-token 모드로 띄워졌을 때만 필요하고 일반 페어링은 OpenClaw Web UI 의 device approval 로 진행된다 (`OpenClawAdapter.swift:489-593`). UI 가 토큰 필드를 일등 시민처럼 노출하면 사용자는 "토큰을 어디서 받지?" 로 막힘 → Advanced 로 격리.
- **카탈로그 vs Settings 의 역할 분리**: catalog 는 cross-platform 으로 platform-agnostic (`#if os(...)` 없음). 플랫폼/샌드박스 specific UI (Keychain SecureField, file picker) 는 SettingsScreen 의 `accountIntegrationSlot` / `apiKeyIntegrationSlot` builder slot 으로 주입.
- **`SetupItem` 데이터 모델 유지**: SetupNeededCard 의 amber pulse / "SETUP" 헤더 시각 언어는 dashboard context 에 맞춤이라 IntegrationRow.setupCard mode 와 별개로 둠. derivation 만 evaluator 로 위임.

### 검증
- `xcodebuild -scheme AgentDeck_macOS` (App Store 빌드 플래그 포함) — BUILD SUCCEEDED
- `xcodebuild -scheme AgentDeck_iOS` — BUILD SUCCEEDED
- 실기기 / 페어링 시나리오 검증은 다음 세션 또는 사용자 수동: (a) Web UI 승인 → "Connected", (b) Keychain 비우고 재페어링, (c) Antigravity 크레딧 표시.

---
