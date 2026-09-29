# 2026-05-06 — Dashboard orientation parity for iOS/Android/e-ink

### 문제

Android tablet Dashboard 가 시스템 회전 잠금이나 저장된 orientation preference 상태에 따라
portrait/landscape 전환을 앱 안에서 회복하기 어려웠다. e-ink 는 별도 화면처럼 보이지 않도록
iOS/Android Dashboard 의 조작 의미를 유지해야 하지만, orientation 제어와 Settings 표시 여부가
표면별로 다른 규칙을 갖고 있었다.

### 해결

- Android 공통 `DashboardOrientation` 계약을 추가했다. e-ink 기본값은 landscape 고정, 일반 tablet 기본값은
  Auto 로 두고, 이전 `UNSPECIFIED` 저장값도 Auto 로 해석한다.
- Android tablet Dashboard 하단에 rotate control 을 추가했다. 이 버튼은 `Settings button` 표시 여부와
  독립적으로 남아 시스템 회전 잠금 상태에서도 portrait/landscape pinning 을 전환할 수 있다.
- Android tablet Settings 에 Orientation card 를 추가해 Auto / Portrait / Landscape 를 e-ink Settings 와
  같은 의미로 제공한다.
- e-ink landscape panel / portrait header / Settings 가 같은 orientation helper 를 사용하도록 정리했다.
- iOS Dashboard 의 rotate control 도 Settings button 표시 여부와 독립적으로 노출되게 했다.
- `docs/appstore-feature-matrix.md` 와 `docs/android-ui.md` 에 adaptive orientation / panel parity 계약을
  반영했다.

### 검증

- `./gradlew :app:compileDebugKotlin` 성공.
- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.data.DashboardOrientationTest` 성공.
- `./gradlew :app:testDebugUnitTest` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_iOS -configuration Debug -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4),OS=18.6' -derivedDataPath /tmp/AgentDeckDerivedDataOrientation CODE_SIGNING_ALLOWED=NO` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataOrientationMac CODE_SIGNING_ALLOWED=NO` 성공.
- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`.
- `git diff --check` 성공.

---
