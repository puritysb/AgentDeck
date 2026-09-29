# 2026-04-17 — App Store 출시 감사 + Rendering 모듈 부트스트랩

### 문제
macOS 앱을 App Store에 제출 가능한 상태로 끌어올리기 위한 전수 점검이 필요했다. 동시에 Stream Deck/ESP32/D200H 같은 하드웨어 없는 일반 사용자의 온보딩이 "No devices connected" 공백으로 시작하는 UX 문제도 해소 대상.

### 해결

**감사 리포트** (plan: `~/.claude/plans/agentdeck-parallel-muffin.md`):
- 네 영역 병렬 점검(앱스토어 적합성 / 메뉴바·설정 / 미구현 / 일반 사용자 온보딩) + creature-simulator 데모의 앱 내 통합 가능성.
- **5개 App Store blocker 식별**: (B1) `SessionLauncher.swift:345-352` Process() subprocess spawn, (B2) `AgentDeck.entitlements:17-23` home-relative 경로 exception, (B3) `HookInstaller.swift:17` Claude 훅 자동 설치, (B4) `Info.plist:32-34` + `entitlements:15-16` network.server + Bonjour, (B5) `Info.plist:25` macOS 타겟에 `LSRequiresIPhoneOS=true`.
- **B5 실측 재분류**: xcodebuild `ProcessInfoPlistFile` 단계가 "removing entry for 'LSRequiresIPhoneOS' - not supported on macOS" 로 자동 제거함을 확인 → 즉시 submission 차단 수준 아님, 명시성 개선은 여전히 권장.
- **온보딩 공백**: `ControlTowerPanel.swift:492-506` 빈 상태 배너, `MonitorScreen.swift` 빈 수족관, APME 발견성 저조, 세션 종료 후 리포트 자동 노출 없음, 브랜드 메시지("Stop Chatting. Start Steering.") 앱 내 전무.
- **결정**: Device Preview 는 **SwiftUI 네이티브 포팅** (WKWebView 임베드 반려 — iOS/iPadOS 공유 자산 확보 + App Review 리스크 최소화). Phase 0(샌드박스) + Phase 1(Preview) **병렬 실행**.

**Track B 부트스트랩** (commit 6eedbd8d):
- `apple/AgentDeck/Rendering/` 신규 그룹. `StateColors.swift` (shared/src/state-colors.ts canonical Swift 포트 + `Color(hex:)` 편의 extension), `SessionSlotRenderer.swift` (renderSessionSlot 의 SwiftUI 네이티브 이식 — 144×144, 그라디언트, inner panel, asking pulse glow, ACT 배지, working spinner, 3열 텍스트).
- 크로스플랫폼(`#if os(macOS)` 가드 없음) — iOS Preview Window 재사용 전제.
- Agent watermark 는 letter-in-circle placeholder — 향후 `shared/src/svg-renderers/agent-logos.ts` 포팅 시 교체.

**Track A 부트스트랩** (commit 6eedbd8d):
- `apple/AgentDeck/Resources/PrivacyInfo.xcprivacy` — NSPrivacyTracking=false + 3개 Required Reason API (UserDefaults CA92.1 / FileTimestamp DDA9.1 / SystemBootTime 35F9.1). `ProcessInfo.processInfo.systemUptime` (DaemonServer.swift:613), `FileManager.attributesOfItem` (DaemonVoiceAssistant.swift:174), UserDefaults 광범위 사용을 근거로 선언.
- macOS Debug 빌드 후 `.app/Contents/Resources/PrivacyInfo.xcprivacy` 번들 포함 확인.

**project.pbxproj 등록**: Rendering PBXGroup 신설, 3 PBXFileReference + 4 Sources PBXBuildFile (iOS+macOS 2쌍) + 2 Resources PBXBuildFile 추가. 이전 DeviceDiagnosticPanel 등록 패턴(e8b1e48e)과 동일.

### 핵심 설계 결정

1. **Device Preview = 네이티브 포팅**. WKWebView 로 기존 `tools/creature-simulator` 를 임베드하는 쉬운 길 대신 SwiftUI 네이티브 채택. 이유: (a) App Review 에서 "원격 콘텐츠 핵심 기능 의존" 리스크, (b) iOS/iPadOS 앱에서도 동일 Preview 재사용 (장기 자산), (c) 번들 크기 +780KB 회피.
2. **두 트랙 병렬**. 트랙 A(`apple/AgentDeck/Daemon/` + entitlements/Info.plist) 와 트랙 B(`apple/AgentDeck/Rendering/` + `UI/Preview/`) 는 파일 충돌 없음. Phase 0 완료 기다리지 않고 Preview 개발 진행.
3. **StateColors는 신설 단독 모듈**. 기존 5개 파일(StatusBadge, ControlTowerPanel, SessionListPanel, D200hHidModule, TerrariumConfig)의 인라인 팔레트는 그대로 둠 — 점진적 마이그레이션. 레거시 지우기는 Device Preview 완성 후.
4. **Privacy manifest 는 보수적 선언**. 실제로 접근하지 않는 카테고리까지 추가하는 것보다 확인된 세 가지만 선언, 추후 필요 시 확장. Required Reason reason 코드는 공식 문서 기준으로만 사용.

### 한계 / 추후 과제
- **#13 (신설)**: iOS AgentDeck_iOS 스킴이 `SettingsScreen.swift:618-633` 의 `ApmeJudgeFoundationModels`/`ApmeJudgeApi` 참조 때문에 선존재 빌드 실패 중 (내 작업 이전 상태). `#if os(macOS)` 가드 누락. 별개 이슈.
- Track A 핵심 blocker (#7 Group Container migration, #8 subprocess 제거, #9 hook opt-in) 미착수 — 다음 세션.
- Track B 렌더링 포팅 남은 항목: PixooRenderer 어댑터(#3 — 기존 `Daemon/Modules/PixooRenderer.swift` 1535 LOC 재사용 얇은 adapter 방식 채택 필요), TerrariumRenderer(#5), 14개 기기 View + DevicePreviewScreen(#6).
- agent-logos.ts 포팅은 별도 작업 — SessionSlotRenderer watermark placeholder 교체 시점.

---
