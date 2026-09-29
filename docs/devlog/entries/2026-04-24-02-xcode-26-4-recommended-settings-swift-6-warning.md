# 2026-04-24 — Xcode 26.4 recommended settings + Swift 6 warning cleanup

### 문제

Xcode 26.4.1 환경에서 Apple 타깃을 열면 두 축의 경고가 동시에 발생했다.

1. **Update to recommended settings** — `apple/AgentDeck.xcodeproj` 가 여전히 `LastUpgradeCheck = 1600` 상태라 현재 Xcode 버전 기준 추천 설정 배지가 남음.
2. **Swift 6 actor/deprecation warnings** — `AppPreferences`, `HookInstaller`, `ESP32ProvisionSheet`, `ESP32Serial`, `GatewayFrame`, `DevicePreviewScreen` 중심으로 main actor 격리, deprecated AppKit API, legacy `Hashable.hashValue`, 불필요한 `nonisolated(unsafe)` 경고가 누적. 실제 빌드를 돌려 보니 `QRScannerView`, `DisplaySyncService`, `AuthManager`, `D200hHidModule`, `CloudCreature` 에도 추가 경고가 surfaced 됨.

### 해결

- `apple/project.yml` 의 `xcodeVersion` 을 `16.0` → `26.4` 로 올리고 `xcodegen generate` 로 `project.pbxproj` 재생성. 결과적으로 `LastUpgradeCheck = 2640` 으로 갱신돼 추천 설정 경고 제거.
- `AppPreferences.chooseAntigravityDatabase()` 를 `@MainActor` 로 고정하고 `NSOpenPanel.allowedFileTypes` 를 `allowedContentTypes` 기반 UTType 해석으로 교체. `shared` singleton 의 `nonisolated(unsafe)` 도 제거.
- `HookInstaller.promptAndInstall()` 의 JSON 파일 picker 도 `allowedContentTypes = [.json]` 으로 교체.
- `ESP32ProvisionSheet` 는 GCD background closure 대신 `Task.detached` + main-actor 복귀 패턴으로 재작성. 포트 탐색/serial write helper 를 `nonisolated` static 으로 내려 Swift 6 concurrent-capture 경고 제거.
- `ESP32Serial` 의 `NSLock` 상수에서 불필요한 `nonisolated(unsafe)` 제거.
- generated `GatewayFrame.JSONNull` 에 `hash(into:)` 구현 추가.
- `DevicePreviewScreen` 의 deprecated `.onChange(of:perform:)` 클로저를 2-parameter 시그니처로 전환.
- 빌드 중 추가로 surfaced 된 경고도 함께 정리:
  - `QRScannerView` → `@preconcurrency import AVFoundation`
  - `DisplaySyncService` → `UIScreen.main.brightness` 접근을 main actor helper 로 수렴
  - `AuthManager` → `String(cString:)` deprecated 경로를 UTF-8 decode helper 로 교체
  - `D200hHidModule` → `CFRunLoop` capture 를 local var 대신 `RunLoopBox` reference 로 전달
  - `CloudCreature` → 미사용 bounding-rect locals 삭제

### 검증

- `xcodegen generate` 성공
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataRecommendedSettings build CODE_SIGNING_ALLOWED=NO` 성공
- XcodeBuildMCP `build_sim` for `AgentDeck_iOS` 성공
- 남은 출력은 소스 경고가 아니라 Xcode build-system note 두 개뿐:
  - `App Store Helper Guard` script phase always-runs note
  - `appintentsmetadataprocessor` 의 "No AppIntents.framework dependency found" informational warning

---
