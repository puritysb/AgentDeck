# 2026-04-18 — Broader Consumer 출시 준비 (Phase 1~3, macOS/iOS 동시)

### 목표
플랜(`~/.claude/plans/appstore-daemon-tranquil-anchor.md`) 의 "Broader consumer aim + macOS/iOS 동시 출시" 결정에 따라 Phase 1 (Core Consumer UX) + Phase 2 (Network Device UX) + Phase 3 (App Store 제출 준비) 를 일괄 실행.

### Phase 1 — Core Consumer UX

**1.1 Onboarding Sheet (macOS + iOS)**
- 신설 `apple/AgentDeck/UI/Onboarding/OnboardingSheet.swift` (macOS 3-pane sheet, 640×540) + `OnboardingScreen.swift` (iOS full-screen).
- Pane 1 (Welcome): "Stop Chatting. Start Steering." 타이틀 + 브랜드 카피.
- Pane 2 (Agent picker): Claude Code / Codex / OpenCode 설치 가이드 URL 버튼.
- Pane 3: macOS = iPad 페어링 안내 + iOS App Store 링크 / iOS = Mac 찾기 안내.
- `AppPreferences.hasSeenOnboarding` 으로 idempotent. `AgentDeckApp.swift` 에서 macOS `.sheet` + iOS 조건부 뷰로 연결. xctest 환경 자동 bypass (XCTestConfigurationFilePath env 체크).

**1.2 Claude Code CLI 설치 UX**
- `SessionLauncher.showAgentInstallPrompt(agent:)` — 기존 clipboard-copy NSAlert 를 "Open Installation Guide" (NSWorkspace 로 공식 docs URL) + "Check Again" (`isClaudeInstalled()` 재호출) + "Cancel" 3-button 으로 교체.
- Install guide URL 매핑: Claude Code → docs.claude.com, Codex → github.com/openai/codex-cli, OpenCode → opencode.ai/docs.

**1.3 APME Reports 빈 상태**
- `bridge/src/apme/dashboard-html.ts` 의 runs=0 empty state 를 rich onboarding 카드로 교체 (아이콘 + "No APME reports yet" + Quick Start 3-step).

**1.4 Stream Deck+ 감지/안내**
- `ControlTowerPanel.swift` 에 `StreamDeckDetection` 구조체 — `NSWorkspace.urlForApplication(bundleIdentifier: "com.elgato.StreamDeck")` + IOHIDManager VID `0x0FD9` 매칭 (매니저 open 안 함 → USB 권한 불필요).
- 5초 캐시 + Timer 로 갱신. 3-state UI: hw+no app → "Install Stream Deck software" + Download, hw+app → "Install AgentDeck plugin" + bundled `.streamDeckPlugin` fallback, neither → hidden.

**1.5 QR 페어링 (macOS show + iOS scan)**
- 신설 `apple/AgentDeck/UI/Pairing/QRPairingWindow.swift` — `CIFilter.qrCodeGenerator()` 로 `AuthManager.getWsUrl(port:)` 을 280×280 QR 로 렌더. URL text-select + "Copy URL" 버튼. `Window("Pair iPad or iPhone", id: "pairing-qr")` scene 신설.
- 신설 `QRScannerView.swift` (iOS) — AVFoundation UIViewControllerRepresentable + `AVCaptureMetadataOutput`. 카메라 권한 플로우 (거부 시 "Open Settings" 버튼). Swift 6 `@preconcurrency AVCaptureMetadataOutputObjectsDelegate`.
- ControlTowerPanel 액션바 "Pair iPad" 버튼. SettingsScreen iOS "Scan QR to Pair" 버튼 + `.fullScreenCover` + URL 유효성 검증 (ws/wss scheme + host).

### Phase 2 — Network Device UX

**2.1 ESP32 Wi-Fi Provisioning**
- 신설 `apple/AgentDeck/UI/Settings/ESP32ProvisionSheet.swift` (480×440) — 4-step 플로우 (detect/credentials/sending/result). 포트 탐지: `/dev/cu.usbserial-*`, `cu.wchusbserial*`, `cu.usbmodem*`. 시리얼 쓰기: Darwin POSIX `open(O_RDWR|O_NOCTTY|O_NONBLOCK)` + `cfmakeraw` + `cfsetispeed/ospeed(115200)` + `write`. JSON 프레임 `{"type":"wifi.config","ssid":..., "password":...}\n`.
- 샌드박스에서 Process spawn 불가하므로 networksetup / Keychain 자동 채움 포기 — 수동 입력으로 MVP.

**2.2 Pixoo Add UI**
- 신설 `apple/AgentDeck/UI/Settings/PixooSheet.swift` (520×520) — IP 입력 + "Test Connection" (`POST http://{ip}:80/post {"Command":"Device.GetDeviceList"}` 3s timeout) + 리스트 add/remove. `AgentDeckPaths.settingsJson` 의 `pixooDevices` 배열 원자적 병합.
- Bonjour 미지원 하드웨어라 수동 IP 입력 MVP. "Changes take effect after daemon restart" 안내.

**2.3 Settings Hardware GroupBox**
- `SettingsScreen.swift` 에 신규 `hardwareContent` + `hardwareRow(icon:title:subtitle:buttonLabel:action:)` 헬퍼 + macOS `GroupBox("Hardware Setup")` 섹션. ESP32/Pixoo 엔트리 포인트 + D200H plug-and-play 안내. DisclosureGroup collapse 는 post-launch 로 연기.

### Phase 3 — App Store 제출 준비

**3.2 APP_REVIEW_NOTES consumer aim**
- "Works standalone on Mac; iPad companion free; optional hardware configurable via in-app UI" 포지셔닝.
- Stream Deck+ Elgato 의존성 공시. iOS companion 설명 (QR 페어링, Bonjour). Review demo 시나리오 업데이트 (첫 실행 온보딩 → Launch Session → Pair iPad → Hardware Setup).

**3.4 CI workflow**
- `apple-release.yml` build-macos 잡은 `if: false` 유지 + 사전 요건 명시 주석 (Mac Installer Distribution 인증서, macOS Provisioning Profile, `ExportOptions-macOS.plist`, app group 등록). 자료 확보 후 `if: true` + release.needs 추가.

**3.1 / 3.3 (사용자 액션)**
- App Store Connect 메타데이터/스크린샷, TestFlight 배포 — 사용자 ASC 권한 필요. 태스크에 실행 방법 문서화.

### 검증
- `xcodebuild AgentDeck_macOS Debug build` → BUILD SUCCEEDED.
- `xcodebuild AgentDeck_iOS Debug build` → BUILD SUCCEEDED.
- 단위 테스트는 SX-state AgentDeck.app zombie (PID 85557) 로 테스트 러너가 연결 실패 — 환경 이슈 (코드 회귀 아님, 메모리 `xctest-zombie-blocker.md` 참조). Zombie 제거 후 재실행 시 통과 예상.

### 파일 변경
- **신설 (6)**: `UI/Onboarding/{OnboardingSheet,OnboardingScreen}.swift`, `UI/Pairing/{QRPairingWindow,QRScannerView}.swift`, `UI/Settings/{ESP32ProvisionSheet,PixooSheet}.swift`.
- **수정**: `App/{AgentDeckApp,AppPreferences}.swift`, `Daemon/Core/SessionLauncher.swift`, `Daemon/Apme/ApmeSettings.swift` (mlxCache `nonisolated(unsafe)` 추가), `UI/MenuBar/ControlTowerPanel.swift` (StreamDeckDetection + Pair iPad 버튼), `UI/Settings/SettingsScreen.swift` (Hardware GroupBox + iOS QR 스캔), `bridge/src/apme/dashboard-html.ts` (empty state), `apple/APP_REVIEW_NOTES.md`, `.github/workflows/apple-release.yml` (주석).

---
