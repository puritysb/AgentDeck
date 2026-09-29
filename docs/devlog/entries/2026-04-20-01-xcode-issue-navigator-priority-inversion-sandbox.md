# 2026-04-20 — Xcode issue-navigator: priority inversion, sandboxing, iOS build error

### 문제
세 가지 Xcode Issue Navigator 경고/에러가 동시에 발생.

1. **Hang Risk**: `D200hHidModule.swift:85` — "User-initiated quality-of-service class waiting on a lower QoS thread running at Utility." `HIDRunLoopThread.init()`이 `.utility` QoS thread를 만들고 MainActor-inherited UserInitiated context에서 `ready.wait()`로 블록.
2. **Update to recommended settings**: `ENABLE_USER_SCRIPT_SANDBOXING`이 project.pbxproj에 없어 Xcode 16이 경고.
3. **iOS build error**: `DevicePreviewScreen.swift:37` — `DaemonService`가 `#if os(macOS)` 전체를 감싸고 있는데 iOS 컴파일 시 `@EnvironmentObject` 선언이 플랫폼 가드 없이 노출.

### 해결
1. `HIDRunLoopThread.thread.qualityOfService = .utility` → `.userInitiated`. HID 입력은 사용자 상호작용 직접 응답이므로 `.userInitiated`가 맞고, 이로써 wait 호출자와 QoS 레벨이 일치해 priority inversion 해소.
2. `project.yml`에 `ENABLE_USER_SCRIPT_SANDBOXING: NO` 추가 후 `xcodegen generate`. `copy-adb.sh` build phase가 sandbox 외부 경로에 접근하므로 NO가 정확하고, 명시적 선언으로 Xcode 경고 제거. 이 설정은 **빌드 타임 전용**이며 앱 런타임 sandbox나 App Store 심사에 영향 없음.
3. `DevicePreviewScreen.swift`의 `@EnvironmentObject var daemonService: DaemonService`, `visibleDevices` computed property, `.onChange(of: daemonService.isUsingExternalDaemon)` 세 곳 모두 `#if os(macOS)` 가드 추가. iOS에서는 `visibleDevices`가 `requiresDesktopBridge`를 필터링한 목록만 반환.

### 핵심 설계 결정
- `ENABLE_USER_SCRIPT_SANDBOXING` = build-time setting, App Store entitlements와 무관. 향후 이 설정에 대한 "앱스토어 심사 통과?" 질문이 나오면: 영향 없음 확인.
- `HIDRunLoopThread` QoS: D200H HID 이벤트 처리는 사용자 입력에 직접 응답하므로 `.userInitiated`가 의미상으로도 정확.

---
