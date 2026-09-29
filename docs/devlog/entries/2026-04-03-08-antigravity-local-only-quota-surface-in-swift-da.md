# 2026-04-03 — Antigravity Local-Only Quota Surface in Swift Daemon + Dashboard Panels

### 문제
Antigravity 사용량은 외부 유틸리티(`antigravity-usage`)로는 확인할 수 있었지만, AgentDeck Dashboard 기본 기능으로는 보이지 않았다. 또한 cloud/API fallback 없이, Antigravity IDE가 이미 가진 로컬 상태만 이용해 가능한 경우에만 표시하고 싶었다.

### 해결
- `apple/AgentDeck/Daemon/Core/UsageAPIClient.swift`
  - Antigravity 로컬 DB `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`를 직접 읽는 local-only parser 추가
  - `antigravityAuthStatus`의 `userStatusProtoBinaryBase64`에서 `Google AI Pro/Ultra/...` 플랜 문자열 복구
  - `antigravityUnifiedStateSync.modelCredits` protobuf/base64 sentinel 값을 풀어 `availableCredits`, `minimumCreditAmountForUsage` 복구
- `apple/AgentDeck/Daemon/Server/DaemonServer.swift`
  - `state_update`와 `usage_update`에 `antigravityStatus`를 함께 실어 대시보드 초기 연결 시점에도 엔진 정보가 빠지지 않도록 연결
- `shared/src/protocol.ts`, `apple/AgentDeck/Model/Protocol.swift`, `android/.../Protocol.kt`
  - 공용 `AntigravityStatusInfo` 필드 추가
- `TankStatusPanel.swift`, `EnginePanel.kt`, `EinkStatusPanel.kt`, `EinkStatusCompact.kt`
  - 값이 실제로 있을 때만 `Antigravity`/`AG` 섹션 표시
  - 큰 화면은 `Google AI Pro · 1000 cr · min 50`, e-ink는 `Pro · 1000cr`처럼 더 압축된 표현 사용

### 핵심 설계 결정
- **fallback 없이 local-only**: Google Cloud API나 별도 로그인 경로는 붙이지 않고, Antigravity IDE가 이미 가진 로컬 상태가 있을 때만 표시
- **프로토콜은 optional 확장**: Node daemon이 아직 이 값을 생산하지 않아도, Swift daemon 경로에서만 우선 표시 가능하도록 optional 필드로 추가
- **구독 정보와 사용량 정보 분리**: `Subscriptions`와 별개로 `Antigravity` 섹션에서 플랜과 크레딧을 함께 보여 usage 성격을 더 명확히 함

### 검증
- `pnpm --filter @agentdeck/shared typecheck`
- `./gradlew :app:compileDebugKotlin`
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataAntigravity build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`
