# 2026-04-26 — macOS Dashboard launch freeze: App Group I/O timeout guard

### 문제

Xcode 에서 macOS 앱을 실행하면 Dashboard 창이 복원된 뒤 앱이 멈춘 것처럼 보였다. `sample` 결과 Dashboard 렌더링이 아니라 daemon startup 경로가 main actor 에서 막혀 있었다.

- macOS state restoration 이 `savedIdentifier=dashboard` 창을 복원해 Dashboard 가 먼저 보였다.
- `DaemonService.start()` → `DaemonServer.init()` → `AuthManager.loadOrCreateToken()` 경로에서 App Group 컨테이너 파일 I/O가 동기 실행됐다.
- `auth-token` read timeout 이후 error logging 이 다시 `swift-daemon.log` 를 동기 open 하면서 main thread 가 `open()` syscall 에서 멈췄다.
- 같은 Group Container 의 `auth-token`, `swift-daemon.log`, `daemon.json`, `sessions.json`, `apme.sqlite` 는 shell 에서도 open 이 hang 될 수 있는 상태였다.

### 해결

- Logger file write/read 를 best-effort background I/O 로 변경하고, 첫 file write 가 hang 되면 추가 file-log write 를 drop 하도록 guard 를 추가했다. `os.Logger` logging 은 유지된다.
- Auth token, daemon/session registry, timeline load/save 를 bounded/background I/O 로 바꿔 startup main path 를 막지 않게 했다.
- APME SQLite open 에 timeout guard 를 추가했다. DB open 이 hang 되면 APME store 는 해당 launch 에서 skip 될 수 있지만 daemon 과 UI startup 은 계속 진행된다.

### 검증

- `xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataLoggerFreezeFix CODE_SIGNING_ALLOWED=NO` 성공
- signed Debug build 를 sandbox/App Group entitlements 로 실행 후 `http://127.0.0.1:9120/health` 가 `status: ok` 반환
- 검증용 앱 종료 후 9120 listener 없음

---
