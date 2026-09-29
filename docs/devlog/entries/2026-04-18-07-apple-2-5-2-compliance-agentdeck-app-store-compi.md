# 2026-04-18 — Apple 2.5.2 compliance (AGENTDECK_APP_STORE compile flag + subprocess strip)

### 동기
직전 커밋 `797b6186` 의 APP_REVIEW_NOTES.md 는 "subprocess 없음" 에 가깝게 설명했지만 실제 macOS 빌드는 여전히 (a) `copy-adb.sh` 가 `Contents/Helpers/{adb,node,agentdeck-d200h-helper}` + `Contents/Resources/agentdeck-runtime/bridge/dist/cli.js` 를 번들하고, (b) 9개 파일에 `Process()` 경로 (openclaw/whisper/network/security/sqlite3/env/sh) 가 잔존했다. Apple Review Guideline 2.5.2 는 self-contained 를 요구하고 외부 코드 실행/설치에 민감하므로 이 상태로는 rejection 리스크가 크다. 동시에 CLI/Homebrew 배포에서는 이 자산들이 정당한 기능이라 **컴파일 스위치로 분리** 하는 게 맞다.

### Stage 1 — `AGENTDECK_APP_STORE` 컴파일 플래그
- `project.yml` `AgentDeck_macOS.settings.base.SWIFT_ACTIVE_COMPILATION_CONDITIONS: AGENTDECK_APP_STORE` 추가. Debug/Release 둘 다 자동 적용.
- `apple/scripts/copy-adb.sh` 시작부 조건부 early-exit: `[[ "$SWIFT_ACTIVE_COMPILATION_CONDITIONS" == *AGENTDECK_APP_STORE* ]] && exit 0`. App Store 빌드에서 번들 자산 복사 skip.
- CLI/Homebrew 빌드는 `SWIFT_ACTIVE_COMPILATION_CONDITIONS=""` 로 override 해서 동일 스킴 재사용.

### Stage 2 — SessionLauncher 경로 축소
`#if !AGENTDECK_APP_STORE` 가드:
- `.bundledBridge` 케이스 resolution 블록 (기존 dead code — `findBundledNode()` 가 `Resources/node` 찾는데 `copy-adb.sh` 는 `Helpers/node` 에 배치함)
- `findBundledBridge()` / `findBundledNode()` — App Store 빌드에서 `return nil` 스텁으로 교체
- `TerminalApp.iterm` AppleScript 분기 (`openInITerm`)
- Terminal AppleScript fallback (`openInTerminalViaAppleScript`)
- AppleScript 경로 전부 제거됨 → NSAppleEventsUsageDescription 불필요 + Apple Events entitlement 불필요

### Stage 3 — 9개 파일 Process() 가드/교체
- `OpenClawAdapter.fetchModelCatalog` / `resolveOpenClawBin` / `openClawEnvironment`: 전부 `#if AGENTDECK_APP_STORE → return nil`
- `AdbModule.runProcess` / which-adb fallback: App Store 에서 `(nil, Data())` 반환
- `DaemonVoiceAssistant.transcribeViaCLI`: whisper-cli spawn compile-out
- `BridgeLogStream.start` + `resolveOpenClawBin`: openclaw logs follow 전면 skip
- `GatewayProbe.checkHealth`: openclaw doctor spawn 제거, TCP probe 만
- `WifiConfig.detectCurrentSSID` / `getKeychainPassword`: networksetup/security subprocess 제거 (ESP32ProvisionSheet 가 수동 입력으로 대체)
- `UsageAPIClient.getOAuthCredentials` / `sqliteValueViaShell`: `/usr/bin/security` + `/usr/bin/sqlite3` 제거
- `DaemonService.startBundledD200HHelper`: App Store 에서 명시적 early-return + user message ("bundled helper is CLI-only; use direct IOKit HID")
- `ESP32Serial.detectPorts`: `shellSync("ls /dev/cu.usb*")` 를 **무조건** `FileManager.contentsOfDirectory(atPath: "/dev")` 로 교체 (CLI 빌드에도 개선). `shellSync` 헬퍼 자체는 CLI 빌드 전용.

### Stage 5 — 신설 `apple/scripts/verify-appstore-archive.sh`
자동 검증 스크립트 신설. 5가지 invariant:
1. `Contents/Helpers/{adb,node,agentdeck-d200h-helper}` + `Contents/Resources/agentdeck-runtime` 부재
2. 메인 AgentDeck Mach-O 외 embedded executable 부재
3. 메인 바이너리 `strings` scan 에 `/usr/bin/env`, `/bin/sh`, `/usr/bin/security`, `/usr/bin/sqlite3` 부재
4. Info.plist `LSRequiresIPhoneOS` 부재 (macOS bundle 에 한정)
5. `codesign -d --entitlements :-` 출력에 `home-relative-path` 문자열 부재

플랫폼 자동 감지: `Contents/` 존재 → macOS / 없으면 iOS. iOS bundle 은 LSRequiresIPhoneOS 정상 허용하고 나머지 invariant 만 적용.

CI wiring: `.github/workflows/apple-release.yml` 의 macOS + iOS 양쪽 Archive 단계 직후 invocation.

### Stage 6 — APP_REVIEW_NOTES 재작성
- "Subprocess execution": 이 빌드가 `AGENTDECK_APP_STORE` 컴파일 조건으로 모든 `Process()` 지점을 compile-out 한다는 것과, 유일한 "launch program" 경로가 `NSWorkspace.open(URL)` on user-initiated `.command` 파일 (사용자가 Launch Session 클릭) 이라는 것을 정확히 기술.
- Claude Code 훅 명령의 `python3/curl` 은 **앱이 spawn 하는 게 아니고** Claude Code 자체 런타임이 사용자 터미널에서 실행함을 명확히.
- Codex/OpenCode Launch Session shortcut 은 companion CLI (`npx @agentdeck/setup`) 필요함을 honest 하게 공시.

### 실측 검증
```
xcodebuild -scheme AgentDeck_macOS -configuration Release → BUILD SUCCEEDED
note: AGENTDECK_APP_STORE build — skipping bundled adb/node/helper (Apple 2.5.2)
.app/Contents/Helpers/ → 디렉토리 자체 부재
strings Contents/MacOS/AgentDeck | grep '^/usr/bin/(env|security|sqlite3)|^/bin/sh' → 0건
verify-appstore-archive.sh .app → ✓ passes (macos)
```

### 후속 (Post-a2b2dbfe 마무리, 본 항목)
- `SessionLauncherTests.testFallsBackToBundledBridgeWhenInstalledBridgeMissing` 를 `#if !AGENTDECK_APP_STORE` 로 감싸 App Store 빌드에서 컴파일아웃 (호스트 앱 enum case 는 유지되나 함수 body 분기가 없어 모드 불일치). `AgentDeckTests_macOS` 타겟에도 동일 flag 추가해서 `#if` 평가가 일치하도록.
- `apple-release.yml` iOS archive 뒤에 verify-appstore-archive.sh 호출 단계 추가 (macOS 는 이미 있음).
- iOS Onboarding Pane 3 의 "Scan QR in Settings" 텍스트 → 직접 `QRScannerView` fullScreenCover 버튼으로 업그레이드 (첫 실행 페어링 경로 1단계 단축).

### 파일 변경 (a2b2dbfe 커밋)
- 수정: `project.yml`, `scripts/copy-adb.sh`, `SessionLauncher.swift`, `DaemonService.swift`, `UsageAPIClient.swift`, `ESP32Serial.swift`, `AdbModule.swift`, `WifiConfig.swift`, `OpenClawAdapter.swift`, `GatewayProbe.swift`, `BridgeLogStream.swift`, `DaemonVoiceAssistant.swift`, `APP_REVIEW_NOTES.md`, `apple-release.yml`
- 신설: `apple/scripts/verify-appstore-archive.sh`

### 주의 (후속 작업 위임 사항)
`OpenClawAdapter` / `GatewayProbe` / `BridgeLogStream` 의 App Store 빌드 현재 상태는 `return nil` 스텁. 이를 "Gateway-native operator client" 로 재활성화하는 작업은 **Codex 에게 별도 트랙으로 위임** (플랜 파일 Addendum v3 의 OpenClaw Gateway 재연동 스펙 참조). 해당 트랙이 랜딩되면 Settings 의 `openClawIntegrationRow` 카피도 "Unavailable" → "Pairing state" 로 전환 예정.

---
