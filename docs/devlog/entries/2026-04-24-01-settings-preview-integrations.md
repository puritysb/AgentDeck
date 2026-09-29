# 2026-04-24 — Settings/Preview 창 크롬 일관화 + Integrations 브랜드 아이콘

### 문제

사용자가 스크린샷으로 세 가지를 차례로 지적:

1. **메뉴바 팝업의 Claude 상태가 "Not connected" 로 표시** — Dashboard 는 녹색인데 메뉴바만 경고. App Store sandbox 에서 `~/.claude/` OAuth 토큰을 못 읽어 `oauthConnected == false` 가 고정인데, `MenuBarTopologyList.claudeStatus` 는 oauth 단독 게이트라 hook 으로 잘 흘러오는 세션도 warn 으로 잡음. Dashboard `TopologyRail` 와 Settings `IntegrationStatusEvaluator` 는 이미 `hooks || oauth` 로 수정돼 있었으나 메뉴바만 drift.
2. **Settings, Device Preview, Launch Session, Pair iPad 팝업들의 룩앤필이 ControlTowerPanel 과 따로 놀음** — 사이드바 material 이 밝은 system vibrancy, 타이틀바가 본문 다크와 이질적.
3. **Settings 창만 유독 이상** — 사이드바 토글이 타이틀바로 못 올라가고 "Essentials" 위에 드리프트, Advanced 섹션은 기본 접힘, Integrations 아이콘이 SF Symbols (`bolt.fill`, `person.badge.key` 등) 라 "서비스 느낌" 없음.

### 해결

**1. 메뉴바 Claude 상태 정합**
- `apple/AgentDeck/UI/Settings/IntegrationsView.swift` 에 `ProviderRailEvaluator` 신설 (`claude`, `openClaw` 두 정적 메서드). `(LEDStatus, subtitle)` 페어 반환. `hooks || oauth` formula 단일화 + OpenClaw 의 `gatewayAuthStatus` 매핑 (`reconnecting`/`device_auth_invalid`/`gateway_reachable` 추가) 을 한 군데로 모음.
- `TopologyRail.claudeRow / openClawRow` 와 `MenuBarTopologyList.claudeRow / openClawRow` 가 동일 evaluator 호출. rail-only 서피스 (model catalog, rate chips, consumer creature dots) 는 local 유지.
- `MenuBarTopologyList` 에 `@EnvironmentObject preferences` 추가, 기존 로컬 `RailStatus` enum 은 삭제하고 공용 `LEDStatus` 로 통합. `LEDStatus.isFilled` 계산 프로퍼티를 `TopologyRail.swift` 에 추가해 메뉴바의 filled/outline 구분 유지.
- `apple/AgentDeckTests/ProviderRailEvaluatorTests.swift` 17 case — Claude hooks-only / oauth-only / both / neither × OpenClaw 각 auth status → LED/subtitle 매핑 회귀 가드.

**2. 팝업 창 아쿠아리움 표면 통일**
- `apple/AgentDeck/UI/Shared/AquariumSurface.swift` 신설. `aquariumGradient` (deepSea→midWater) 상수 + `AquariumSurfaceModifier` (gradient background + `.foregroundStyle(TerrariumHUD.text)` + `.preferredColorScheme(.dark)`). 서브 modifier `WindowTitlebarBackground` 는 `if #available(macOS 15, *) { .containerBackground(aquariumGradient, for: .window) }` 로 macOS 15+ 에서 타이틀바까지 확장. macOS 14 은 no-op fallback.
- `HUDFont` (sectionHeader/title/body/caption/mono/monoSmall) + `HUDSectionHeader` 헬퍼 노출.
- `LaunchSessionDialog`, `QRPairingWindow`, `ESP32ProvisionSheet`, `PixooSheet`, `DevicePreviewScreen` 모두 `.aquariumSurface()` 적용. DevicePreview NavigationSplitView sidebar 는 `.scrollContentBackground(.hidden)` + 각 row `.listRowBackground(Color.clear)` 로 system sidebar vibrancy 를 뚫음.

**3. Settings scene → Window 마이그레이션**
- SwiftUI `Settings {}` 는 toolbar band 를 안 그려서 NavigationSplitView auto sidebar-toggle 이 sidebar 헤더로 내려옴 (사용자가 "이상하게 붙어있다" 라고 지적한 그 증상). `apple/AgentDeck/App/AgentDeckApp.swift` 에서 `Window("AgentDeck Settings", id: "settings")` + `.commands { CommandGroup(replacing: .appSettings) { Button("Settings…") { openWindow(id: "settings") }.keyboardShortcut(",", modifiers: .command) } }` 로 전환. cmd+, 와 `App → Settings…` 메뉴는 명시 연결.
- 4곳 `SettingsLink` 를 `Button { openWindow(id: "settings") }` 로 교체: `ControlTowerPanel` (rateLimitsEmptyState + settingsPillButton), `SetupNeededCard.openSettingsButton`, `MonitorScreen.settingsGearButton` + `openSettings()`. `#available(macOS 14.0, *)` availability 분기 + `showPreferencesWindow:` / `showSettingsWindow:` selector fallback 일괄 제거.
- `SettingsScreen.macOSSettings` 에 `.aquariumSurface()` 추가, `advancedExpanded = true` 기본값으로 변경 (사용자 요청). sidebar List 동일한 `.scrollContentBackground(.hidden)` + `.listRowBackground(Color.clear)` 적용.

**4. Integrations 브랜드 아이콘**
- `IntegrationDescriptor` 에 `iconAssetName: String?` + `iconTint: Color?` 선택 필드 추가, 생성자는 default 값으로 호환. `IntegrationRow` 에 `integrationIcon(size:fallbackTint:overrideTint:)` 헬퍼 신설 — asset 있으면 `Image(assetName).renderingMode(.template)` + tint, 없으면 SF Symbol fallback. settings / onboarding / setupCard 세 body 모두 이 헬퍼 사용.
- Claude Code → `CreatureClaudeCode` + `TerrariumHUD.claudeBody` (terracotta)
- Codex (ChatGPT) → 처음엔 `CreatureCodex` 로 바꿨다가 사용자 요청으로 `BrandOpenAI` 로 재변경. `assets/logos/openai.svg` 를 `apple/AgentDeck/Resources/Assets.xcassets/BrandOpenAI.imageset/` 으로 번들 + template rendering intent. tint 는 near-white.
- OpenClaw Gateway → `CreatureOpenClaw` + crayfish red
- Anthropic Admin API → `assets/logos/claude.svg` 를 `BrandAnthropic.imageset/` 으로 번들 + claude body tint
- Antigravity → 공식 브랜드 SVG 가 번들 가능 상태가 아니라 `atom` SF Symbol 유지

**5. ESP32 / Ulanzi TC001 프리뷰 실제 firmware 시각 시그니처 반영**
- `apple/AgentDeck/UI/Preview/Devices/EinkEsp32Previews.swift` 의 ESP32 4종 (86Box / IPS 3.5" Landscape / Portrait / Round AMOLED 1.6") 을 공용 `Esp32TerrariumScene` 로 재작성. deepSea→midWater→shallowWater 수중 그라데이션 + 수면 caustic 하이라이트 + 배경 swimming creature + 하단 HUD bar (AgentDeck 로고 + tetra-neon 언더라인 + 세션 라인 + 5h/7d water-fill 게이지) — `esp32/src/ui/widgets/hud_bar.cpp` 의 `createGauge` 시각 레이아웃 복제. 기존의 큰 중앙 크리처 / watch tick 12개 (Round) / "AGENTDECK" 헤더 (Portrait) 삭제.
- `apple/AgentDeck/UI/Preview/Devices/MatrixTerminalPreviews.swift` 의 `UlanziMatrixPreview` 는 기존 "Pixoo 렌더러 crop" 대신 실제 `matrix_pages.cpp` 의 AGENTS 페이지 재현 — 8×32 LED 을 Canvas 로 직접 그림. 5×6 sprite (`SPR_OCTOPUS`/`SPR_OPENCODE`/`SPR_JELLYFISH` 비트마스크 그대로 포팅) + 3×5 마이크로폰트 "Nx" 라벨 + 우측 column 의 세션별 state LED.
- `EinkEsp32Previews` 의 E-ink Mono/Color 와 `WearableTabletPreviews` 의 Apple Watch / iPad / Android Tablet 도 같은 아쿠아리움 그라데이션 + GeometryReader 로 배경 creature 배치로 폴리싱 (session 후반 사용자 hand edit 포함).

**6. Antigravity 데이터베이스 피커 기본 경로**
- `apple/AgentDeck/App/AppPreferences.swift` 에 `defaultAntigravityDirectoryURL()` 추가. NSOpenPanel 열 때 `~/Library/Application Support/Antigravity/User/globalStorage` 등을 순차 검사해서 첫 존재하는 디렉토리로 자동 이동 + `showsHiddenFiles = true`.

### 핵심 설계 결정

- **`ProviderRailEvaluator` 와 `IntegrationStatusEvaluator` 는 별개 evaluator** — Settings 의 `IntegrationStatus` 는 5-way (`connected/awaiting/failed/notConfigured/unsupported`), rail 은 4-way (`.ok/.warn/.error/.dim`) + compact subtitle. 억지로 합치면 호출부가 복잡해져서 각 용도별로 나눠둠. Non-Goals 로 명시.
- **`Settings {}` 대신 `Window(id: "settings")`** — macOS 표준 Preferences 창의 이점 (System Settings 와 일관된 chrome) 을 포기하는 대신 NavigationSplitView sidebar toggle 을 Device Preview 와 같은 위치에 띄우는 시각 일관성을 택함. cmd+, / `App → Settings…` / `SettingsLink` 대체 경로는 수동 연결. 이 선택이 깨지면 menuBar pill / gear / SetupCard "Open Settings" 버튼도 같이 깨지므로 테스트 때 함께 확인.
- **Integrations 아이콘은 asset-first, SF Symbol fallback** — `iconAssetName` 필드는 optional 로 두고 기존 `iconSystemName` 을 보존. 새 서비스 추가 시 asset 없으면 즉시 SF Symbol 로 돌아가 compile 안 깨짐. template rendering + tint 파라미터로 브랜드 색 제어.
- **ESP32 프리뷰는 firmware 코드를 Swift 포팅하지 않음** — LVGL → SwiftUI 정확 포팅은 scope 이 너무 큼. 대신 "시각 시그니처" (수중 그라데이션 + HUD bar 배치 + 게이지 형태) 만 복제. 사용자가 실제 디바이스 접근 시 "같은 아티팩트" 로 인식되는 수준이 목표.
- **Ulanzi TC001 은 LED 비트맵 정확 포팅** — 스프라이트가 5×6 = 30비트 수준이라 Canvas 로 직접 `setPixel` 흉내내는 게 Pixoo crop 보다 훨씬 정확하고 작업량도 적음. `matrix_pages.cpp` 의 `SPR_OCTOPUS` 등 바이트 배열을 그대로 복사해 사용.
- **타이틀바 통일은 macOS 15 gating** — `.containerBackground(for: .window)` 가 macOS 15+ 라 `#available` 로 감쌌고 14 는 fallback. 배포 타겟은 14 유지. 14 유저가 일부 있다면 타이틀바가 여전히 light vibrancy.

### 후속

- 현재 미커밋 상태 — session-end 시 전체 commit 예정
- `BrandOpenAI`/`BrandAnthropic` 외 `BrandAntigravity` asset 은 공식 SVG 확보 시 추가 (현재 `atom` SF Symbol)
- macOS 14 이하 배포 지원 여부는 미결 — 장차 15 로 끌어올리면 `WindowTitlebarBackground` 의 `#available` 분기 제거 가능

---
