# 2026-04-12 — Daemon Self-Probe Restart Loop + D200H IOHIDManagerOpen + iPad IPv6 Discovery

### 문제
in-process Swift daemon 이 매 ~60초마다 자기 자신을 셧다운하고 재시작하는 루프에 빠져 있었다. D200H HID module 은 `managerOpened=true, connected=false` 상태에 고착해 버튼이 영구 뜨지 않았다. iPad 앱은 Bonjour 로 daemon 을 찾고는 "Invalid URL" 에러로 접속 실패.

### 원인 (세 개가 완전히 독립)

**1. `DaemonService.checkDaemonHealth()` 의 self-HTTP-probe 안티패턴**
`URLSession.shared.data(for: http://127.0.0.1:9120/health)` 를 5초마다 돌리고 2초 timeout → 2연속 실패 시 `server.shutdown() + start()`. URLSession 이 다른 호스트(죽은 sibling 9121/9122/9123, Pixoo 192.168.68.110 느린 응답) 타임아웃으로 혼잡해지면 loopback self-probe 도 덩달아 2초 넘어가면서 false-positive 재시작 발동. 재시작하면 D200H/ESP32/Pixoo 모듈이 전부 재초기화되고 D200H 의 IOKit matching 콜백은 첫 tick 안에 발화해야 하므로 연결 기회를 영구 상실.

**2. `D200hHidModule.start()` 에서 `IOHIDManagerOpen` 누락**
`a75b6da6` 최초 커밋에는 있었지만 `d2c04ea0 feat(d200h): multi-session agent controller` 에서 "개별 device 를 `handleDeviceAttached` 에서 `IOHIDDeviceOpen` 할 거니 manager open 은 불필요" 라는 잘못된 판단으로 제거됨. 하지만 IOKit HID 의 device matching 콜백은 **manager 가 open 상태**여야 already-present device 에 대해 발화한다. 그래서 schedule + matching dict 는 정상 설정되는데 **첫 `handleDeviceAttached` 콜이 평생 안 찍힘**. `managerOpened=true` 는 플래그만 무조건 올려두던 옛 코드였고, `lastOpenError=0` 이라 진단 불가능.

**3. `BridgeDiscovery` 의 IPv6 link-local + bracket 누락**
Mac 이 Bonjour 로 `daemon-9120` 를 광고할 때 여러 인터페이스(Wi-Fi, VPN utun, awdl 등) 주소가 함께 올라온다. `resolveEndpoint` 가 `NWConnection(to:using:.tcp)` 를 aggregate endpoint 로 열면 link-local IPv6 (`fe80::...%en0`) 에 먼저 붙는 경우가 생긴다. 거기서 `%en0` zone suffix 를 잘라내고 `DiscoveredBridge(host: "fe80::...")` 로 저장 → `wsUrl = "ws://fe80::...:9120"` ← **RFC 3986 위반** (IPv6 literal 은 bracket 필수). Foundation `URL(string:)` 이 nil 리턴 → `BridgeConnection:95` 의 "Invalid URL: ..." 표시.

### 해결

**1. Daemon self-probe 제거** (`DaemonService.swift:526`)
`isUsingExternalDaemon == false` 일 때는 `isRunning && server != nil` 인메모리 상태만 신뢰. HTTP probe 는 외부 daemon 추적 용도로만. D200H helper 자동 승격 체크는 best-effort 로 유지하되 probe 실패가 재시작 트리거 안 하도록 분리.

**2. Sibling reachability 기반 sessions.json 청소** (`SessionRegistry.swift`, `TimelineRelay.swift`, `DaemonServer.swift`)
`kill(pid, 0)` 만 보던 `listActive()` 는 PID 재사용이나 stuck 프로세스를 못 거름. 새 `listActiveAndReachable()` 는 각 non-daemon 세션의 `/health` 를 1.5s 로 병렬 probe 해서 unreachable 항목을 `sessions.json` 에서 자동 deregister. `TimelineRelay.sync()` 를 async 로 변환, `fetchUsageRelayed`/`refreshSessions` 도 reachable 버전 호출.

**3. `IOHIDManagerOpen` 복구 + 열거 진단** (`D200hHidModule.swift:140-192`)
- `IOHIDManagerOpen(manager, kIOHIDOptionsTypeNone)` 호출 복구 (Seize 안 씀 — keyboard interface 가 macOS input stack 과 공존해야 함).
- 성공 시 `D200H IOHIDManagerOpen succeeded (sandbox=…, usbEntitlement=…)` 로그. 실패 시 `kIOReturnNotPermitted` 와 일반 실패를 구분 로깅.
- 바로 이어서 `IOHIDManagerCopyDevices` 로 한 번 열거해 matched device 수 + D200H 개수 + usage page 를 덤프. 이 **한 줄** 로 "디바이스 안 꽂힘" / "IOKit 보는데 콜백 미발화" / "sandbox 차단" 세 상태를 확정 구분 가능.

**4. iPad Bonjour IPv6 경로** (`BridgeDiscovery.swift`)
- `DiscoveredBridge.wsUrl` — host 에 `:` 있으면 `[...]` 로 감쌈 (IPv4/DNS 는 그대로).
- `handleResults` resolve 필터 확장: `nil`, `169.254.*`, `fe80:*`/`fe80%*`, `::1`, `127.*` 전부 reject + 이유 로그.
- `resolveEndpoint` — `NWParameters.tcp.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options` 에서 `version = .v4` 강제. Bonjour A 레코드만 resolve, AAAA 회피.

**5. WebSocket 접속 가시화** (`WebSocketServer.swift:230`)
`[WS] Client connected (N total)` → `WS: Client connected from 192.168.68.45:53123 (N total)`. 로컬 vs LAN 클라이언트 즉시 구분 (iPad 접속 추적용).

### 핵심 설계 결정
- **In-process 서비스를 자기 HTTP 로 probe 하지 않는다**: "같은 프로세스의 liveness 를 네트워크 경계를 가로질러 확인" 은 data race + cache miss + 자기 부정적 피드백을 만드는 안티패턴. 인메모리 객체 참조로 충분.
- **PID 생존 ≠ 서비스 생존**: `kill(pid,0)` 은 최소 조건. 진짜 liveness 는 프로토콜 레벨 응답이어야 하므로 `SessionRegistry` 에 `listActiveAndReachable()` 을 추가해 sibling-relay 경로에서만 비용을 감당하고 hot path (GUI) 에서는 기존 fast `listActive` 유지.
- **IOKit HID 의 숨은 계약**: `IOHIDManagerScheduleWithRunLoop` + `SetDeviceMatchingMultiple` 만으로 matching 콜백이 발화한다고 오해하기 쉽지만, manager 는 반드시 `IOHIDManagerOpen` 상태여야 이미 꽂힌 device 에 대해 attach callback 이 발화한다. 이건 Apple 문서에 명시가 없어서 인턴 레벨 함정.
- **mDNS 에서 IPv4 강제**: LAN 에서 iPad↔Mac 접속은 IPv4 가 사실상 universal 하고, link-local IPv6 는 zone ID 가 URL/WebSocket 경계를 넘지 못해 고장의 원인만 된다. `NWProtocolIP.Options.version = .v4` 한 줄이 `[fe80::...]` 의 모든 잔혹함을 차단.

### 검증
- `xcodebuild -scheme AgentDeck_macOS` / `AgentDeck_iOS` 양쪽 BUILD SUCCEEDED.
- 런타임: 새 바이너리 실행 직후 `D200H IOHIDManagerOpen succeeded (sandbox=true, usbEntitlement=true)` + `D200H IOKit enumeration returned no devices` → 케이블 재연결 → `D200H Keyboard interface attached` + `D200H Consumer Control interface attached` + `D200H connected via HID` → 첫 `set_buttons` 62KB/61pkt 전송, Gateway/OpenClaw/AgentDeck 버튼 렌더링 확인.
- Daemon 안정성: `Local daemon on port 9120 is no longer healthy — restarting` 메시지 완전 소멸, `Usage Tier 1 OK` 연속 성공, Pixoo pushes 가 매 분 리셋되지 않고 누적.
- iPad: iOS 재빌드 필요, 다음 세션에서 `WS: Client connected from 192.168.x.x:...` 로그로 검증.

---
