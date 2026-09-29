# 2026-04-17 — Wake 먹통 근본 원인 수정 (D200H IOHIDManager off-main)

### 문제
오전에 올린 2026-04-17 grace-window fix 는 증상만 덮은 임시 방어선이었다 ("한계 / 추후 과제" 에 명시됨). 실제 원인: `D200hHidModule.start()` 가 `IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), ...)` 로 매치/제거/입력리포트 콜백 전부를 **메인 런루프**에 스케줄. `handleWake()` 5초 sleep 뒤 `start()` 가 새 매니저를 만들고 `IOHIDManagerOpen` + `IOHIDManagerCopyDevices` 를 동기 호출, 이어서 match 콜백이 메인에서 `handleDeviceAttached` → `IOHIDDeviceOpen` 까지 실행. 이 전 과정이 Dashboard WS 파이프라인이 쓰는 메인 액터를 점유해 `[Lifecycle] bridge data stale` watchdog 이 터짐.

### 해결

**1차 시도 — DispatchQueue 전환 (실패, 크래시)**
- `IOHIDManagerSetDispatchQueue(manager, hidQueue)` + `IOHIDManagerUnscheduleFromRunLoop` 제거 + `IOHIDManagerClose` 유지.
- 런타임 결과: wake 복구 중 `stop()` 에서 `assertion failure: Invalid dispatch state: 0x0` 크래시.
- 원인: dispatch-queue 스케줄된 IOHIDManager 는 `Activate` / `Cancel` / `SetCancelHandler` (비동기 cancel 핸들러) 라이프사이클을 요구. `Open` / `Close` 는 런루프 전용 경로. API 믹스 불가.

**2차 시도 — 백그라운드 런루프 스레드 (성공)**
- 신설 `HIDRunLoopThread` 싱글톤: 전용 `Thread` + `NSRunLoop` + `NSMachPort`(런루프 유지용) + `CFRunLoopGetCurrent()` 캡처.
- `IOHIDManagerScheduleWithRunLoop(manager, HIDRunLoopThread.shared.runLoop, CFRunLoopMode.defaultMode.rawValue)` — 호출 시그니처 동일, 타겟만 main → background.
- `Open`/`Close` 라이프사이클 그대로 유지 → 크래시 없음.
- 검증 로그: `D200H wake recovery — full teardown + restart` → `D200H reconnected after wake` ~5s, `[Lifecycle] bridge data stale` **미발생**, Dashboard Usage/Sessions 업데이트 정상.

**Grace window 축소**
- `AgentStateHolder.wakeGracePeriodSec` 10 → 3초. D200H IOHID 재시작이 메인 스레드를 더 이상 점유하지 않으므로 남은 ESP32 (2s 시리얼 재오픈) + mDNS republish 에 필요한 최소치만 유지.

### 핵심 설계 결정

1. **Dispatch queue vs 백그라운드 런루프** — IOHIDManager 는 dispatch-queue 모드에서 별도 라이프사이클 API(`Activate`/`Cancel` + async cancel handler)를 요구하는데, 이 전환은 `handleDeviceAttached` 내 동기 `IOHIDDeviceOpen` 경로까지 재설계해야 함. 백그라운드 런루프 방식은 기존 코드 변경이 3줄(`ScheduleWithRunLoop` 인자만 교체) + 신규 헬퍼 1개로 끝남.
2. **NSMachPort 가 런루프 keep-alive 용** — `RunLoop.run()` 은 스케줄된 source 가 없으면 즉시 반환하므로, 영구 `NSMachPort` 를 하나 붙여 런루프가 살아있게 유지. `CFRunLoopSource` + `CFRunLoopSourceContext` 로 구현할 수도 있으나 Objective-C 런타임 의존성만 추가됨.
3. **ESP32Serial 은 동일 수정 불필요** — 이미 `actor` 로 선언되어 협력적 executor 에서 돌고, `Task.sleep` 은 비차단. Darwin `read/write/close` syscall 은 actor 의 백그라운드 협력 쓰레드에서 실행되어 메인을 막지 않음.
4. **콜백 thread-safety** — 매치/제거/입력리포트 세 콜백이 동일 런루프에서 **직렬화**되어 실행되므로 `nonisolated(unsafe)` 상태 접근 패턴은 유지됨 (이전 메인 런루프 직렬화와 동치).
5. **Usage 0% 는 별건** — `[UsageAPI] raw:` 덤프는 `AGENTDECK_DEBUG_USAGE_RAW=1` opt-in 으로 이미 e61c8fe9 에 배포. 이번 세션의 wake 테스트 로그에서 `5h=21.0%` 정상 리포트 확인됨 → 이전 "0%" 는 저활용 계정의 실제 값이었을 가능성 높음. 향후 재발 시 env var 로 즉시 진단 가능.

### 검증 방법
- **Build**: `xcodebuild -scheme AgentDeck_macOS -configuration Debug build` → BUILD SUCCEEDED.
- **Runtime**: D200H 연결 상태로 앱 실행, 모니터 슬립/웨이크. 로그 확인 포인트:
  - `D200H wake recovery — full teardown + restart` 이후 `D200H reconnected after wake` 5~6초 내 발생 ✓
  - `[Lifecycle] bridge data stale (Ns) — reconnecting` 메시지 없음 ✓
  - Wake 복구 중에도 `[D200H] BROADCAST sessions_list`, `Pixoo] Healthy`, `[Daemon] Usage Tier 3 OK` 계속 들어옴 ✓

### 변경 파일
- `apple/AgentDeck/Daemon/Modules/D200hHidModule.swift` — `HIDRunLoopThread` 추가, `start()` schedule 타겟 교체, `stop()` unschedule 타겟 교체.
- `apple/AgentDeck/State/AgentStateHolder.swift:57` — `wakeGracePeriodSec` 10 → 3.

---
