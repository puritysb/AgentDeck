# 2026-06-06 — CLI daemon / Swift client-mode device status 정합성 수정

### 문제

Swift in-process daemon 이 실행되지 않고 Node CLI daemon 이 9120 을 소유한 상태에서, CLI daemon 의 `/health.modules` 는 ADB/D200H/Pixoo/ESP32 serial 을 정상 연결로 보고했지만 macOS 앱의 `DaemonService.deviceSummary` 는 로컬 `server` snapshot 만 읽어 외부 daemon client-mode 에서 비어 있었다. 그 결과 같은 daemon 상태를 보면서도 일부 UI 는 정상 연결, 일부 UI 는 미연결처럼 보여 혼란스러웠다.

또한 사용자가 `agentdeck stop` 을 실행하면 기본 포트 9120 에 `/hooks/shutdown` 을 보내 세션 bridge 종료 경로만 타고, 9120 이 daemon 일 때는 `/shutdown` 으로 가지 않아 CLI daemon 이 종료되지 않았다.

### 수정

- `DaemonService.refreshDeviceSummary()` 가 외부 daemon client-mode 에서는 `SessionRegistry.probeDaemonHealth()` 의 `modules` payload 를 `DeviceSummary` 로 변환해 사용한다.
- `DeviceSummary.make(fromModuleHealth:)` helper 를 추가해 Swift/Node daemon module snapshot 을 같은 builder 경로로 처리한다.
- `agentdeck stop` 은 대상 포트의 `/health` 를 먼저 확인하고 daemon 이면 `/shutdown`, session bridge 면 기존 `/hooks/shutdown` 으로 보낸다. 요청에는 timeout 을 걸었다.
- `agentdeck daemon stop` 의 shutdown POST 에도 timeout 을 추가했다.

### 검증

- 현재 실행 중인 CLI daemon PID 56582 의 `http://127.0.0.1:9120/health` 에서 ADB 3대, D200H, Pixoo 1대, serial 6개 연결 확인.
- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm --filter @agentdeck/bridge build`
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataDaemonCoexist CODE_SIGNING_ALLOWED=NO`
- `xcodebuild test ... -only-testing:AgentDeckTests/SessionLauncherTests` 는 현재 scheme/test plan 에 `AgentDeckTests` 가 포함되어 있지 않아 실행되지 않음.

---
