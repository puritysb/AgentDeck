# 2026-04-26 — macOS Dashboard auto-connect blocked by daemon readiness

### 문제

Dashboard 는 macOS foreground 복귀 시 daemon ready 신호가 오기 전까지 mDNS waterfall 을 건너뛴다. 그런데 daemon 은 9120 listener 를 먼저 열어도 optional startup 작업들이 끝나기 전에는 `DaemonService.onReady` 를 호출하지 않았다. 이 상태에서 App Group 컨테이너 파일 I/O 또는 HID 진단이 hang 되면 `/health` 는 connection refused 또는 no response 로 보이고, Dashboard 는 자동 localhost 연결을 시작하지 못했다.

샘플에서 확인된 blocker:

- D200H startup diagnostic 의 `IOHIDManagerCopyDevices`
- D200H 분석용 ZIP dump 의 App Group 파일 write/rename
- Pixoo `settings.json`, WiFi `wifi-config.json`, APME/MLX settings, usage cache 의 동기 `Data(contentsOf:)`

### 해결

- D200H HID enumeration diagnostic 을 background/timeout 처리로 바꿔 module startup 을 막지 않게 했다.
- D200H 분석용 ZIP dump 를 best-effort background write 로 전환했다.
- Pixoo/WiFi/APME settings 와 usage cache reads 를 bounded background I/O 로 바꿔 timeout 시 기본값 또는 cache miss 로 진행하게 했다.
- Usage cache write 는 startup/connect path 를 막지 않도록 background write 로 전환했다.

### 검증

- `xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataAutoconnectFix CODE_SIGNING_ALLOWED=NO` 성공
- `xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataAutoconnectFixSigned` 성공
- signed Debug 앱 실행 후 `http://127.0.0.1:9120/health` 가 `status: ok` 반환
- 같은 프로세스에서 `127.0.0.1:<client> -> 127.0.0.1:9120` localhost WS 연결이 `ESTABLISHED` 로 확인됨

---
