# 2026-04-28 — Pixoo hot-reload / offline 상태 오표시 수정

### 문제

Pixoo64 설정에는 `192.168.68.110` 이 저장되어 있는데 실행 중인 macOS daemon 의 `/health` 와 `/devices` 는 Pixoo `configuredDeviceCount: 0`, `/pixoo/frame` 은 204 로 응답했다. Swift `PixooModule.start()` 가 시작 시점에 설정된 Pixoo 가 없으면 render/probe loop 를 만들지 않고 즉시 return 해, 이후 Settings UI 에서 장치를 추가해도 데몬 재시작 전까지 Pixoo 가 없는 장치처럼 보였다. Device summary 도 프레임 생성 전/일시 push 실패 상태를 idle/offline 처럼 읽히게 했다.

### 해결

- `PixooModule` 이 시작 시 Pixoo 가 없어도 계속 살아 있도록 변경하고, 5초마다 `settings.json` 의 `pixooDevices` 를 hot-reload 한다.
- 설정 변경 시 새 장치만 준비하고, 제거된 IP 의 PicID/log state 를 정리하며, 장치가 모두 없어지면 `/pixoo/frame` shadow 를 비운다.
- wake recovery 때도 설정을 다시 읽고 PicID cache 를 재동기화한다.
- Pixoo Settings 문구에서 daemon restart 요구를 제거했다.
- macOS Dashboard / menubar device summary 에서 Pixoo 의 `warming up`, `retrying`, `retry paused` 상태를 분리해 단순 워밍업을 offline 으로 오해하지 않게 했다.

### 검증

- `git diff --check` 성공
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataPixooHotReload CODE_SIGNING_ALLOWED=NO` 성공
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_iOS -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath /tmp/AgentDeckDerivedDataPixooHotReloadIOS CODE_SIGNING_ALLOWED=NO` 성공

---
