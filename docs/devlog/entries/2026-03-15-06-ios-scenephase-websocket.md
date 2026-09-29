# 2026-03-15 — iOS 앱 접속 불안정 수정 (ScenePhase + WebSocket 라이프사이클)

### 문제
iOS 앱이 Android 대비 접속 불안정. 핵심 원인: **ScenePhase 미처리** — 백그라운드 복귀 시 죽은 WebSocket을 감지/복구하는 로직 부재. Bridge 서버가 15초 ping interval로 30초 후 zombie terminate → iOS 앱은 죽은 소켓을 들고 있음.

### 해결
6가지 수정 적용 (4개 파일, +207/-21줄):

1. **ContentView ScenePhase**: `@Environment(\.scenePhase)` + `.onChange` → `handleForegroundReturn()`/`handleBackgroundEntry()`
2. **3-tier 복구 전략** (AgentStateHolder): suspend 시간 기반 — >20s=force disconnect+waterfall restart, 5~20s=health check(3s timeout), <5s=ping timer restart. `restartWaterfall()`로 waterfallStage 강제 idle 리셋
3. **BridgeConnection health check**: `forceHealthCheck(completion:)` — 즉시 ping + 3초 timeout, NSLock 기반 thread-safe completion guard. `forceDisconnectAndRestart()`, `resetReconnectCount()` 추가
4. **Ping 타이머 개선**: 30s→15s (서버와 동기화), RunLoop `.default`→`.common` (UI 스크롤 중에도 동작)
5. **URLSession 설정**: `timeoutIntervalForRequest=15`, `waitsForConnectivity=false`. Max reconnect 10→20
6. **handleDisconnect race guard**: `isHandlingDisconnect` flag — ping callback + receive loop 동시 호출 방지

### 교훈 / 핵심 설계 결정
1. **iOS 백그라운드 = 연결 소멸 수용**: Background Execution Mode 추가 불가 (VoIP/audio 앱이 아니므로 심사 거절). "백그라운드에서 끊어짐을 수용하고, 포그라운드 복귀 시 즉시 복구"가 올바른 iOS 패턴
2. **Suspend 시간 기반 분기**: 짧은 suspend(<5s)에서 force reconnect하면 불필요한 재연결. 20s 이상이면 서버가 이미 terminate했으므로 health check 생략하고 바로 disconnect. 5~20s 구간만 실제 health check 필요
3. **Ping interval 동기화**: 클라이언트 30s > 서버 15s → 서버가 먼저 zombie 판정. 동일 interval로 맞춰야 서버 terminate 전에 클라이언트가 감지 가능
4. **RunLoop `.common` mode**: `.default` mode Timer는 UI 스크롤/애니메이션 중 suspend됨. 네트워크 heartbeat 같은 타이머는 반드시 `.common`으로 등록

---
