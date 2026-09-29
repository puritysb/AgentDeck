# 2026-05-10 — Swift daemon ESP32 false-failure / Usage API fallback stability

### 문제

운영 중인 macOS Debug daemon 로그에서 ESP32 기기 자체는 정상 연결 상태인데도
UART serial write 의 일시적 `EAGAIN`/backpressure(`errno=35`)가 hard
failure 로 분류되어 `portFailures` 와 disconnected 상태로 전파되는 현상이
확인됨. 동시에 `sessions_list` 동일 payload broadcast 가 짧은 시간에 반복되어
serial writer 를 더 압박했고, App Store Swift daemon 이 직접 읽을 수 없는
Claude Code OAuth keychain 경로를 Usage API Tier 3 에서 계속 시도해 실패 로그를
발생시켰음.

### 해결

- `ESP32Serial` write path 에 backpressure 분류를 추가. `EAGAIN`/zero write
  는 2초까지 재시도하고, 끝까지 밀리면 연결을 유지한 채 throttled debug 로만
  기록한다. 실제 hard failure 일 때만 read token invalidation 과
  `failedPorts` 기록을 수행.
- partial write 뒤 다음 payload 앞에 line reset newline 을 붙여 JSONL frame
  오염 가능성을 줄임. 성공 write/read/device_info 수신 시 해당 port 의 stale
  failure 를 제거.
- `device_info` 미수신은 즉시 reconnect 하지 않고 요청을 재시도한다. 완전히
  silent 인 port 만 120초 이후 reconnect 대상으로 분류.
- `statusSnapshot.portFailures` 는 현재 connected port 의 stale failure 를
  노출하지 않도록 필터링하고, `lastReadAt`/`lastWriteAt`/요청 횟수를 추가해
  진단성을 높임.
- `DaemonServer.broadcastSessionsList()` 에 stable JSON fingerprint 기반 dedupe
  를 추가해 동일한 `sessions_list` broadcast storm 을 억제.
- `UsageAPIClient.directOAuthUsageSupported = false` 경계를 명시하고 Swift
  daemon 에서는 직접 OAuth usage fetch 를 건너뛰게 함. Usage path 는 sibling
  relay / Admin API / stale cache semantics 로만 동작.

### 검증

- `xcodebuild -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS
  -destination 'platform=macOS,arch=arm64' -configuration Debug build
  CODE_SIGNING_ALLOWED=NO -derivedDataPath /tmp/AgentDeckStabilityBuild`
- `xcodebuild -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS
  -destination 'platform=macOS,arch=arm64'
  -only-testing:AgentDeckTests_macOS/UsageAPIClientThreadingTests test
  CODE_SIGNING_ALLOWED=NO -derivedDataPath /tmp/AgentDeckStabilityTests`

---
