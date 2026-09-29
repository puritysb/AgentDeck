# 2026-04-12 — macOS Dashboard Display-Sleep Freeze Recovery

### 문제
모니터를 끄고 장시간 자리를 비웠다가 돌아오면 AgentDeck macOS 대시보드가 freeze 된 것처럼 보이고 한참 동안 갱신되지 않았다. Daemon 은 이미 IOKit `kIOMessageSystemHasPoweredOn` 핸들러가 있어 wake 시 Bonjour 재광고/모듈 wake/세션 prune 을 수행 (`DaemonServer.swift:351-382`) 하고 있었지만, 대시보드는 죽은 WebSocket 을 붙들고 있어 비대칭 상태가 만들어졌다.

### 원인 (두 가지가 겹침)
1. **Dashboard 가 wake 사실을 모른다** — `AgentStateHolder.handleForegroundReturn()` 은 SwiftUI `scenePhase` 변화에만 반응한다. macOS 에서 모니터 sleep / 시스템 idle 은 `scenePhase` 를 `.background` 로 떨어뜨리지 않으므로 foreground-return 경로 (`AgentStateHolder.swift:177-228`) 가 영원히 트리거되지 않는다.
2. **WebSocket read timeout 부재** — `BridgeConnection` 의 `URLSessionConfiguration` 에 `timeoutIntervalForResource` 가 설정되지 않아 half-open socket 에서 `ws.receive { … }` 가 무한 대기.
3. 회복은 결국 `staleDataMonitor` (10s tick, 20s threshold) 가 AppNap 해제 후 돌면서 일어났지만, AppNap 해제 → 첫 tick → threshold → waterfall → daemon `/health` → bridge connect 까지 최악 수십 초가 걸려 사용자에게는 freeze 로 보였다.

### 해결
- `apple/AgentDeck/State/AgentStateHolder.swift`
  - Daemon 의 IOKit 패턴을 미러링한 `startSystemWakeListener()` / `stopSystemWakeListener()` / `handleSystemWake()` 추가.
  - Wake 감지 즉시 `connection.forceDisconnectAndRestart()` → `connectTo(preferredLocalBridgeUrl)` 또는 `restartWaterfall()`.
  - Swift IOKit import 에서 `kIOMessageSystemHasPoweredOn` 이 private 이라, DaemonServer 와 동일하게 `0xe0000300` raw 상수를 파일 로컬로 선언 (이름 충돌 피하려고 `_AgentStateHolder` suffix).
  - `init()` 에서 `startStaleDataMonitor()` 옆에 등록, `deinit` 에서 `IOObjectRelease` + `IONotificationPortDestroy` 정리.
- `apple/AgentDeck/Net/BridgeConnection.swift`
  - macOS 한정 `config.timeoutIntervalForResource = 30` 추가. 살아있는 소켓은 `pingIntervalSec` 트래픽으로 갱신되므로 영향 없고, wake 후 dead socket 은 30s 내 receive failure → `handleDisconnect` → reconnect.

### 검증
- 빌드: `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataWakeFix build CODE_SIGNING_ALLOWED=NO` → `BUILD SUCCEEDED`.
- 실기 검증은 다음 세션에서: `pmset sleepnow` / `pmset displaysleepnow` → wake → Console.app 에서
  - `[Lifecycle] system wake — force reconnect`
  - `[BridgeConnection] connecting to ws://127.0.0.1:9120/...`
  - `[BridgeConnection] first message received — connected!`

### 핵심 설계 결정
- macOS 에서 "lifecycle" 신호는 SwiftUI `scenePhase` 만으로는 부족하다. 디스플레이 sleep / 시스템 idle 은 scenePhase 를 흔들지 않으므로, **power management 이벤트는 IOKit 을 직접 들어야 한다**. Daemon 이 이미 하고 있던 것을 대시보드에도 동일 패턴으로 추가해 양쪽 생명주기가 대칭이 되게 만들었다.
- half-open WebSocket 탐지는 ping 타이머 한 축 + URLSession resource timeout 한 축으로 이중화. Ping 타이머가 AppNap 으로 느려지는 상황에서도 resource timeout 이 안전망이 된다.
- AppNap 자체를 `ProcessInfo.beginActivity` 로 끄는 옵션은 보류. 이번 두 가지 수정만으로 증상이 사라지는지 먼저 확인하고, 추가 필요 시 결정한다. Sleep 자체를 막지 않는 `.userInitiated` 만 쓰는 식으로 최소 개입 경로를 남겨둔다.
- Swift IOKit module 에서 `kIOMessageSystemHasPoweredOn` 이 private 으로 올라오는 것은 기존 DaemonServer 에서도 같은 raw 값 상수 우회를 쓰고 있다 (`DaemonServer.swift:10`). 중복 정의를 피하려고 공통 헬퍼를 만들고 싶은 유혹이 있지만, 두 곳만 쓰고 의미가 명확하므로 지금은 그대로 둔다.

---
