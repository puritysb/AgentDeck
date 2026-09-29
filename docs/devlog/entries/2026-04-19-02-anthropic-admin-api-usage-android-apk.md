# 2026-04-19 — Anthropic Admin API usage + Android APK 재배포

### 문제
이전 세션에서 확정된 "App Store 빌드에서 Claude quota 못 읽는" 제약(Anthropic Feb 2026 정책)의 보조 기능. Admin API key 보유 유저는 구독 quota 대신 org-wide API 토큰 소비를 볼 수 있어야 함 — 소수 타겟이지만 sanctioned path. 또한 이번 세션 변경사항(gatewayConnected 게이팅)이 실기기에 반영 안 된 상태였음.

### 해결
**Android APK 재배포** — Pantone6 (`AA007422R24C1300039`) + Lenovo (`HVA095B4`). Debug 키스토어로는 signature mismatch → `./gradlew assembleRelease` 로 재빌드 후 `adb install -r` 양쪽 **Success**. CremaS 는 USB 미연결로 별건.

**Anthropic Admin API 기능**:
- `apple/AgentDeck/Daemon/Core/AnthropicAdminApiClient.swift` 신규 — Keychain store (service `bound.serendipity.agentdeck.dashboard.anthropic.admin-api-key`) + async `fetchUsage()`. `/v1/organizations/usage_report/messages` 를 1d 버킷 `group_by=model` 로 호출해 today/month TokenCounts (input/output/cacheRead/cacheCreation) + top-3 모델 집계
- `AgentState.swift` / `Protocol.swift`: `adminApiKeyPresent`, today/month 4종 필드, `adminApiTopModels: [AdminApiModelUsage]`, `adminApiFetchedAt`, `adminApiStale` 추가. WS broadcast 경유
- `DaemonServer.swift`: 10분 간격 polling (유저가 key 저장한 경우에만). `cachedAdminApiUsage` + `refreshAdminApiUsage()` + `buildUsageEvent` 에 직렬화
- `SettingsScreen.swift`: Services 섹션에 `anthropicAdminApiRow` — SecureField (Keychain 저장) + Save/Clear + 현재 값 요약. OpenClaw 토큰 패턴 재사용
- `ControlTowerPanel.swift`: RATE LIMITS 아래에 `anthropicApiUsageSection` — Today/30d 별 in/out/cache 토큰 + 상위 모델 2개. `adminApiKeyPresent == true` 일 때만 렌더, 구독 유저는 보이지 않음

**Non-App-Store fallback**: `currentKey()` 가 `ANTHROPIC_ADMIN_API_KEY` env var 지원 — CLI/dev 빌드는 Settings 안 건드리고 opt-in 가능.

### 검증
- `xcodebuild -scheme AgentDeck_macOS / AgentDeck_iOS build` — 양쪽 SUCCEEDED
- Android 2 대 APK 설치 성공
- Admin API 실제 호출은 유저가 key 저장 후 daemon 재시작해서 확인 필요 (수동 검증)

### 핵심 설계 결정
- **Admin API 는 별도 tier** — RATE LIMITS (Pro/Max quota) 와 시각적으로 분리. 같은 유저가 동시에 둘 다 볼 수 있음 (구독 + API key 병용 케이스)
- **Non-Keychain fallback** — env var 로도 접근 가능해야 CLI 유저도 혜택. Keychain 을 강제하지 않음
- **Polling 은 key 있을 때만** — 네트워크/배터리 절약. 5분 Anthropic 데이터 지연도 명시해서 "Awaiting first fetch" 상태 정상 표시
- **Top models 는 2개만 표시** — 카드 공간 제약. 3개 저장은 하되 렌더는 2개
- **Android 빌드는 항상 release** — debug 키스토어 signature 가 기존 설치와 다름. 재배포 시 assembleRelease 필수. 다음 세션에도 해당

---
