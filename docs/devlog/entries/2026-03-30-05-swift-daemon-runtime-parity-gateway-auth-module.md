# 2026-03-30 — Swift Daemon Runtime Parity: Gateway/Auth, Module Health, Pixoo Preview

### 문제
Swift daemon이 macOS 앱 안에서 빌드되고 기동되더라도, Node daemon 대비 런타임 parity가 부족했다. 특히 OpenClaw gateway 인증이 미구현이었고, Pixoo preview는 stub이었고, ADB/ESP32/D200H 상태를 앱에서 진단하기 어려웠다.

### 해결
- `OpenClawAdapter.swift`: `connect.challenge -> connect` 흐름 추가, `device.json`/`device-auth.json` 로드, Ed25519 서명 기반 device auth 구현, `sessions.list` 후 active `sessionKey` 추적, `chat.send`/`chat.abort`/`exec.approval.resolve`에 session/run/approval 문맥 자동 보강
- `DaemonServer.swift`: `/health`와 `/status`에 `gateway`/`adb`/`serial`/`pixoo`/`d200h` 상태 노출, `/pixoo/frame`을 실제 BMP 응답으로 구현, `/pixoo`를 polling preview 페이지로 전환
- `PixooModule.swift`: 마지막 프레임과 push 오류 상태 보존
- `AdbModule.swift`: 감지 디바이스, reverse 준비 개수, 최근 에러 상태 보존
- `ESP32Serial.swift` / `SerialModule.swift`: 감지 포트, 포트별 연결/device_info, 최근 open/read/write 실패를 health 스냅샷으로 노출
- `D200hHidModule.swift`: manager 초기화 상태와 keyboard seize 흐름 정리, 상태 스냅샷 추가

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataParity8 build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`

### 남은 갭
- OpenClaw handshake는 이제 구현됐지만, 실제 gateway와의 실기 인증 성공 여부는 런타임 검증 필요
- `/pixoo/stream` SSE는 현재 HTTP server 구조상 미구현, 대신 `/pixoo` polling preview로 대체
- ADB reverse, ESP32 serial, Pixoo push는 health/preview는 보강됐지만 실제 장치 연결 상태에서 확인 필요

### 추가 구현 (같은 날 후속)
- `HTTPServer.swift` / `WebSocketServer.swift`: long-lived HTTP stream route 지원 추가
- `DaemonServer.swift`: `/pixoo/stream` SSE 구현, `/pixoo`를 SSE 우선 + polling fallback preview로 전환
- `OpenClawAdapter.swift`: 연결 성공 후 `openclaw models list --json` 실행으로 model catalog fetch, default model 추출
- `DaemonServer.swift`: `gateway_health` 이벤트를 `cachedGatewayHasError`에 반영해 daemon 상태 갱신
