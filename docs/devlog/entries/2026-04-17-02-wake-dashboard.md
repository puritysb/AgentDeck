# 2026-04-17 — 모니터 Wake 직후 Dashboard 먹통 진단 + 수정

### 문제
모니터가 슬립에서 깨어날 때 macOS Dashboard가 ~25초간 먹통. 로그에서 `[Lifecycle] system wake — force reconnect` 직후 `[Lifecycle] bridge data stale (24s) — reconnecting preferred local bridge`가 나오며 두 번째 강제 재접속 사이클이 돌아 UI가 깜빡이고 데이터가 끊겨 보임.

### 해결

**AgentStateHolder.swift** — 3가지 안전장치:
1. `handleSystemWake()` 1초 디바운스 — IOKit `kIOMessageSystemHasPoweredOn` + `NSWorkspace.screensDidWake`가 S3→wake에서 둘 다 발화하는 걸 막음
2. `handleSystemWake()`에서 `lastDataReceivedAt = now` 리셋 — pre-sleep 시각이 watchdog 기준으로 남아있는 문제 해결
3. `checkForStaleBridgeData()`에 10초 wake grace window 추가 — 데몬 wake 복구(D200H HID 재생성 + 5s 슬립, ESP32 4× close/open + 2s 슬립, mDNS republish) 진행 중 stale 판정 억제

**UsageAPIClient.swift** — `AGENTDECK_DEBUG_USAGE_RAW=1` 환경변수 opt-in raw JSON dump. 사용자가 5h/7d=0% 보고할 때 실제 응답과 파서 누락을 구분하기 위함.

**project.pbxproj** — 앞선 a8f5dc14 커밋에서 DeviceDiagnosticPanel.swift가 repo에는 있으나 Xcode 프로젝트에 등록 누락 → MonitorHUD.swift에서 `Cannot find 'DeviceDiagnosticPanel' in scope`. PBXFileReference + 2× PBXBuildFile + group membership + 2× Sources build phase 엔트리 추가.

**DeviceDiagnosticPanel.swift** — `private enum DeviceStatus` → `DeviceRowStatus` 리네임. Swift 6에서 `DaemonService.swift`의 internal `DeviceStatus`와 충돌하며 "invalid redeclaration" 에러. `private` 의도와 관계없이 Swift 6가 재선언으로 flag.

### 핵심 설계 결정

1. **Wake 이후의 stale 판정은 "데이터 신선도" 문제가 아니라 "복구 중" 문제** — watchdog를 없애는 대신 grace window로 억제. 복구가 10초 이상 걸리면 여전히 발동.
2. **In-process 데몬의 wake 복구는 Dashboard와 같은 main actor를 공유** — 소켓이 끊겼다기보다 main이 밀려 이벤트 처리 지연. 따라서 소켓 재접속 반복은 오히려 역효과.
3. **Usage 원시 로그는 preference 대신 env var** — UI 없이 Xcode scheme 환경변수 한 줄로 토글. 영구 플래그보다 1회성 진단에 적합.

### 한계 / 추후 과제
- Wake 복구 작업(D200H IOHIDManager 재생성, ESP32 serial 4중 close/open) 자체를 전용 background queue로 옮기는 것은 미처리. 증상은 잡았지만 근본 원인(main actor 점유)은 잔존. D200hHidModule / ESP32Serial이 `@unchecked Sendable`이지만 IOKit/serial 콜백은 main run loop에 스케줄됨.
- Usage 0% 원인 판별은 다음 세션에서 `AGENTDECK_DEBUG_USAGE_RAW=1` 실행 후 확인.

---
