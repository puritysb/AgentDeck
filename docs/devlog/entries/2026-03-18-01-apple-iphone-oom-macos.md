# 2026-03-18 — Apple 앱 iPhone OOM + macOS 연결 불안정 수정

### 문제
1. **iPhone OOM (16분 후 kill)**: `TerrariumView`의 `@State lastDate` 변경이 매 Canvas 프레임마다 `DispatchQueue.main.async`로 SwiftUI re-render 트리거. ProMotion 120Hz x 2 (double render) = 240fps 실효 렌더 → 메모리 압력 누적
2. **macOS/iOS 연결 불안정**: Bridge 사망 시 receive loop error + ping error 동시 발생 → `handleDisconnect` 2회 호출. `defer { isHandlingDisconnect = false }` 가 serial queue에서 순차 실행 시 guard 무효화 → 이중 reconnect 스케줄 → 소켓 2개 경쟁 → cascade failure
3. **mDNS 중복 브리지 표시**: `DiscoveredBridge.id`가 `host:port` → 같은 서비스가 WiFi/Ethernet 양쪽 인터페이스에서 별도 항목으로 표시

### 해결
1. **OOM**: `lastDate`를 `TerrariumRenderer` (plain class)로 이동 → `@State` mutation 제거 → double render 해소. `TimelineView(.animation(minimumInterval: 1.0/60))` 60fps cap 추가
2. **handleDisconnect 이중 호출**: `defer` 제거. `isHandlingDisconnect`는 `connectInternal()`에서만 reset — disconnect~reconnect 구간 동안 두 번째 error callback 차단. 모든 early return 경로에서도 적절히 reset
3. **ping timer thread-safety**: `Timer`+`RunLoop.main` → `DispatchSourceTimer` on `queue`. `stopPingTimer()`는 `DispatchSource.cancel()` (thread-safe) 직접 호출으로 동기화 보장
4. **mDNS dedup**: `DiscoveredBridge.id`를 mDNS service name으로 변경. `handleResults`에서 service name 기준 pre-dedup
5. **waitsForConnectivity**: iOS만 `true` (cold-start WiFi 대기), macOS는 `false` (빠른 failure → 빠른 reconnect)
6. **Suspend threshold**: 20s → 15s (서버 실제 pong timeout = 15s)

### 교훈 / 핵심 설계 결정
- **SwiftUI Canvas에서 `@State` mutation 금지**: `DispatchQueue.main.async { @State = value }` 패턴은 매 프레임 re-render 유발. Canvas 내 시간 추적은 renderer 객체 내부 property로 처리
- **Serial queue `defer` reset은 guard 무효화**: 동일 serial queue에 2개 block이 enqueue되면 첫 block의 `defer` reset 후 두 번째 block이 guard를 통과함. "disconnect~reconnect 구간 동안 true 유지" 패턴이 올바름
- **`DispatchSource.cancel()`은 thread-safe**: `stopPingTimer`를 async 대신 직접 호출 가능. async dispatch는 `disconnect()`와 race condition 유발
- **서버 ping 15s + 클라이언트 ping 15s = 위험**: 동일 간격은 경쟁 가능. iOS 클라이언트 background 복귀 시 15s 초과면 소켓 확정 사망으로 즉시 reconnect

---
