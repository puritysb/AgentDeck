# 2026-04-17 — App Store blocker 3종 해소 + Device Preview 네이티브 14기기

### 배경
오전 감사 리포트(`~/.claude/plans/agentdeck-parallel-muffin.md`)에서 App Store 심사 차단 5건 중 3건(#7 Group Container, #8 subprocess spawn, #9 HookInstaller 자동 설치)과 하드웨어 無 사용자 온보딩 공백을 해소하기 위한 Device Preview(3/5/6) 트랙을 병렬 실행.

### Track A — App Store blocker 해소

**#7 데이터를 App Group Container 로 이전 (완료)**
- 신규 `apple/AgentDeck/App/AgentDeckPaths.swift` — 단일 진입점. `containerURL(forSecurityApplicationGroupIdentifier: "group.bound.serendipity.agentdeck.dashboard")` → 서명 빌드에선 Group Container, 미서명(dev/xctest)에선 `~/.agentdeck/` fallback. `migrateLegacyDataIfNeeded()` 가 legacy `~/.agentdeck/` (getpwuid real-home)에서 Group Container 로 파일 단위 복사(덮어쓰지 않음).
- `AgentDeck.entitlements` — `temporary-exception.files.home-relative-path.read-write` 4개 경로 제거, `application-groups = ["group.bound.serendipity.agentdeck.dashboard"]` 추가. `project.yml` 도 동일 변경 + `xcodegen generate` 로 pbxproj 재생성.
- 경로 사용처 전수 변경: `AuthManager`, `Logger`, `LocalSessionDiscovery`, `BridgeDiscovery`, `SingletonGuard` (atexit/signal handler — `unlink` 그대로), `DaemonService` (SIGTERM/SIGINT 정리), `ApmeSettings`, `AppPreferences.writeApmeJudgeBackendToSettingsJson`. `ApmeStore` 는 `AuthManager.agentDeckDir` 경유라 자동 추종.
- `AgentDeckApp.init()` 에 `AgentDeckPaths.migrateLegacyDataIfNeeded()` 추가. best-effort — per-file 실패는 `NSLog` 만, 스타트업 블로킹 없음.
- `OpenClawAdapter` (`~/.openclaw/identity/*`), `UsageAPIClient` (`~/.codex/auth.json`), `AdbModule`/`BridgeLogStream` (외부 바이너리 탐색 fallback) 은 App Sandbox 에서 EPERM → 기존 graceful fallback 이 nil 반환. v1 출시 한계(External CLI integration disabled in App Store build)로 기록 — 릴리즈 노트 과제.

**#8 SessionLauncher Process() 스폰 제거 (완료, 에이전트 adcbc38b)**
- `shell("which", ...)` 헬퍼 + findInstalledBridge/findClaude 의 fallback 3곳 삭제. Hardcoded candidate path 리스트만 사용 — 실패 시 nil → `showClaudeInstallPrompt()` 기존 경로. `shellEscape` 는 AppleScript/`.command` 스크립트 경로 escaping 용으로 유지.
- 부수 수정: `resolveLaunchPlan` 의 claudeCode → plainClaude last-resort fallback 에 `daemonPrefix` 누락 → 기존 `SessionLauncherTests.testFallsBackToPlainClaudeAndPreservesProjectPath` 가 pre-existing FAIL 상태. 테스트 의도(HookInstaller 가 설치한 hook 이 여전히 daemon 에 도달해야 함)대로 코드 측 수정. 57 테스트 전부 passed.

**#9 HookInstaller opt-in 다이얼로그 (완료, 에이전트 a64bc0d3)**
- `AppPreferences` 에 `HookInstallConsent` enum (`unknown` / `accepted` / `declined`), `@Published hookInstallConsent`, `hooksInstalled`, `claudeSettingsBookmark`/`claudeSettingsPath` 추가. `storeClaudeSettingsBookmark` / `resolveClaudeSettingsURL` / `clearClaudeSettingsAccess` helper (security-scoped bookmark, Antigravity 패턴 미러).
- `HookInstaller.installIfNeeded()` 는 consent != `.accepted` 또는 bookmark 없으면 no-op + 로그. `promptAndInstall()` — NSAlert("무엇이 설치되는지" 안내) → NSOpenPanel(기본 `~/.claude/settings.local.json` 선택) → bookmark 저장 후 실제 쓰기. `uninstallAndRevoke()` = 기존 `uninstall()` + bookmark revoke + `.declined`.
- Settings 화면에 **Claude Code Hooks** GroupBox 추가: 상태 LED, 경로 표시, "Enable Claude Code Hooks…" + "Remove" 버튼. macOS 레이아웃 전체를 `ScrollView` 로 감싸 신설 섹션 스크롤 가능.
- 기존 `DaemonServer.startServices step11` 의 `HookInstaller.installIfNeeded()` 호출은 유지 — 내부에서 consent 체크로 조용히 no-op.

**#13 iOS 스킴 복구 (완료)**
- `SettingsScreen.swift:618-633` 의 `ApmeJudgeFoundationModels` / `ApmeJudgeApi` 참조를 `#if os(macOS)` 로 감쌌고, `.pickerStyle(.radioGroup)` 은 iOS 용 `.inline` 대체 추가. iOS 빌드 복구.

### Track B — Device Preview 네이티브 14기기 (완료)

**#3 PixooRenderer preview adapter (에이전트 a4e63378)**
- `apple/AgentDeck/Rendering/PixooPreview.swift` (~215 LOC, cross-platform).
- 재포팅 없음 — 기존 `PixooRenderer.render(dashboardState:)` (1535 LOC) 그대로 재사용. Preview config(agent/state/sessionCount/fiveHourPercent/gatewayAvailable) → `DashboardState` 합성 → 64×64 RGB24 Data → `CGImage` (nearest-neighbor) → SwiftUI `Image`. Fresh renderer per call 로 애니메이션 상태 결정론적.
- iOS fallback: 64×64 solid #20293A 채움.

**#5 TUITerrariumRenderer SwiftUI 포팅 (에이전트 aa33af04)**
- `apple/AgentDeck/Rendering/TUITerrariumRenderer.swift` (~340 LOC, cross-platform). `TerrariumPreviewConfig(agents, states, animationFrame, width=60, height=20)` → `TUITerrariumRenderer` View. 이름 충돌(`apple/AgentDeck/Terrarium/TerrariumRenderer.swift` 기존) 회피 위해 prefix `TUI`.
- 의도적 단순화: Braille 14×5 sprite → 3-char ASCII glyph (octopus `(o)`, cloud `<o>`, opencode `┈▢┈`, crayfish `λoλ`), Boids/Lissajous/random bubble → deterministic sin-based. 상태 팔레트 4 bucket (`idle/processing/awaiting/disconnected`), state→depth 매핑(0.30/0.50/0.82) 보존.

**#6 DevicePreviewScreen + 14 기기 + 메뉴바 진입 (에이전트 a42243b1)**
- `apple/AgentDeck/UI/Preview/` 신설. `DevicePreviewCatalog.swift` (115 LOC, `PreviewDevice` 15→14), `DevicePreviewScreen.swift` (198 LOC, `NavigationSplitView` macOS / 평면 iOS, Agent/State/Sessions picker, `TimelineView` 기반 `animationFrame`), `Devices/{DevicePreviewShared,DeskPreviews,WearableTabletPreviews,EinkEsp32Previews,MatrixTerminalPreviews}.swift` (총 ~840 LOC).
- 15→14 감량: Apple Watch 46mm/42mm 병합 (4mm 차이 시각 구분 불가).
- 최종 14: Desk 3(StreamDeck+, D200H key, D200H deck), Wearable 1, Tablet 2(iPad, Android), E-ink 2(mono/color), ESP32 4(86Box/IPS3.5L/IPS3.5P/Round), Matrix 1(Ulanzi), Terminal 1(Terrarium).
- `AgentDeckApp.swift` 에 `Window("Device Preview", id: "device-preview")` scene (macOS, 1100×760). `ControlTowerPanel.swift` 에 "Preview Devices" 버튼 + 빈 상태 카피 "No devices connected" → "Devices are optional — your agents work standalone. [View what devices add →]".
- `AppPreferences.hasSeenDevicePreview` @Published 추가.

### 검증
- `xcodebuild -scheme AgentDeck_macOS test -only-testing:AgentDeckTests_macOS` → **57 tests passed, TEST SUCCEEDED**. (Pre-existing `testFallsBackToPlainClaudeAndPreservesProjectPath` FAIL 을 SessionLauncher.swift 1줄 수정으로 복구 — 감지는 이번 감사 덕분.)
- `xcodebuild -scheme AgentDeck_macOS build` → BUILD SUCCEEDED.
- `xcodebuild -scheme AgentDeck_iOS -destination 'generic/platform=iOS' build` → BUILD SUCCEEDED.
- 런타임 확인은 App Store Connect 서명 후 다음 TestFlight 빌드에서 수행 예정(현 로컬 dev 빌드는 서명 X → Group Container API 가 nil → fallback 경로로 기존 동작 유지).

### 남은 블로커 (Phase 0 마무리)
- **#4 App Review Notes 작성**: "왜 로컬 서버(9120+)가 필요한가 — iOS/iPadOS Dashboard 앱이 동일 네트워크에서 접속" — 제출 직전 작성.
- **#B5 macOS 타겟 `LSRequiresIPhoneOS` 제거**: `Info.plist:25`. Xcode 가 macOS 타겟에서 자동 strip 한다는 기존 메모(`xcode-infoplist-auto-strip.md`) 확인 필요.
- **OpenClawAdapter / UsageAPIClient / AdbModule 외부 경로 접근**: sandbox 에서 graceful fallback 동작 확인(crash 없음)은 되어있으나, 각각 "feature unavailable in App Store build" UI 안내 추가 권장.
- **Onboarding Phase 2**: About 탭 브랜드 카피, D200H/ESP32 섹션 "Advanced" 그룹핑, APME 리포트 자동 노출 — 별도 트랙.

### Commit
- 본 작업 단일 커밋 권장 (Track A + Track B 병렬 검증 후 atomic). 파일 대상: `apple/AgentDeck.xcodeproj/project.pbxproj`, `apple/project.yml`, `apple/AgentDeck/App/*.swift`, `apple/AgentDeck/Daemon/{Core,Server,Apme,DaemonService}.swift` 일부, `apple/AgentDeck/Net/*.swift`, `apple/AgentDeck/Rendering/{PixooPreview,TUITerrariumRenderer}.swift`, `apple/AgentDeck/UI/{MenuBar,Settings,Preview/**}.swift`, `apple/AgentDeck/Resources/AgentDeck.entitlements`, `DEVELOPMENT_LOG.md`.

---
