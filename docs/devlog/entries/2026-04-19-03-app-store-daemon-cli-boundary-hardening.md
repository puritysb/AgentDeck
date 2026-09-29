# 2026-04-19 — App Store daemon/CLI boundary hardening

### 문제
App Store 앱 + CLI daemon + 다른 기기 연동은 런타임상 대부분 동작했지만, 심사 기준으로 보면 경계가 흐렸다. App Store 빌드가 `.command` 스크립트를 만들어 Terminal/CLI를 실행하는 경로, "CLI 설치"로 읽히는 quota 안내, OpenClaw 승인 CLI 명령 안내, Node daemon의 `gatewayConnected`/`moduleHealth` 누락이 동시에 존재했다. Apple Review Guideline 2.5.2/4.2.3 관점에서는 앱이 companion executable 설치/실행을 기능 경로처럼 보이면 리젝 리스크가 있다.

### 해결
- **App Store Launch Session hardening**: `SessionLauncher` 는 `AGENTDECK_APP_STORE` 빌드에서 shell script / Terminal launch 를 만들지 않고 안내 알림만 표시. Claude Code는 사용자가 Terminal에서 직접 실행하고 AgentDeck는 opt-in hooks 로 감지한다. Codex/OpenCode PTY launch 는 App Store 빌드에서 unavailable.
- **CLI/helper copy 정리**: Setup card, menu bar RATE LIMITS, Settings Codex/OpenClaw/D200H, App Review notes, TestFlight checklist, feature matrix에서 "Install CLI", `.command` launch, bundled D200H helper, `openclaw devices approve` 중심 안내를 App Store-safe 문구로 교체.
- **Node daemon parity**: Node daemon state에 `gatewayConnected` / `moduleHealth` 를 추가하고 `/health`, `/status`, `/devices` JSON 진단을 맞췄다. OpenClaw virtual session / Pixoo creature / plugin slot 주입은 `gatewayAvailable` 이 아니라 인증된 `gatewayConnected` 기준으로 게이트.
- **ADB reverse parity**: Node ADB reverse는 Android well-known `tcp:9120` → 실제 daemon port 매핑으로 Swift와 맞춤.
- **App Store D200H helper 차단**: App Store 빌드는 자동 bundled-helper promotion 및 Settings helper UI를 숨기고 direct IOKit HID 경로만 남김.

### 검증
- `pnpm --filter @agentdeck/shared build` — 통과
- `pnpm --filter @agentdeck/bridge build` — 통과
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug ... SWIFT_ACTIVE_COMPILATION_CONDITIONS='DEBUG AGENTDECK_APP_STORE'` — 통과
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Release ... SWIFT_ACTIVE_COMPILATION_CONDITIONS='AGENTDECK_APP_STORE'` — 통과
- `bash apple/scripts/verify-appstore-archive.sh /tmp/AgentDeckDerivedDataAppReviewGuardRelease/Build/Products/Release/AgentDeck.app` — 통과

### 핵심 설계 결정
- App Store 앱은 **단독으로 쓸 수 있어야 하며** AgentDeck CLI/LaunchAgent 설치를 요구하지 않는다.
- 사용자가 이미 별도 terminal-managed daemon을 운영하는 경우에는 localhost/WebSocket client로 붙을 수 있지만, App Store UI가 설치나 기동을 유도하지 않는다.
- Claude Code 세션은 앱이 띄우지 않는다. 사용자가 직접 실행하고, AgentDeck는 명시적 hook 동의 후 들어오는 이벤트를 모니터링한다.

---
