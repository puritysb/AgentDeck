# 2026-07-04 — 듀얼 데몬 공존: TRMNL "connecting" 플리커 원인 확정 + Swift fallback-port 자가치유(reclaim/stand-down) + 승격 오탐 완화

### 문제
Node CLI 데몬과 Xcode 디버그 Swift 데몬 동시 실행 환경에서 TRMNL 패널이 간헐적으로 "connecting" 류 화면으로 바뀌었다 정상화. 패널 자체 펌웨어 로그(`/api/log`)를 전수 조사해 원인을 3계열로 분리:
1. **9120 소유권 교대 dead window** — Node 재시작 시 Swift가 ~10초 만에 자기승격하지만 9120이 아직 안 풀려 **9121로 fallback 후 영구 잔류**(재점유 로직 없음). 패널은 9120 고정 폴링이라 `connection refused(-1)` → 펌웨어 자체 재연결 UI. 교대 window 동안 Swift가 ESP32 시리얼 6포트+Pixoo까지 가져가 전 디바이스 소유권 플랩(Pixoo "offline" 오판 로그 확인).
2. **패널 WiFi 전파 요동**(-26↔-84dBm, 7/2 하루 weak 사이클 6회) — 데몬 무관, 펌웨어 "Connecting to WiFi" 화면. 물리적 원인(배치/채널), 코드 수정 불가.
3. (기각) "대시보드 과다 연결 병목" 가설 — `/api/display` 실측 p50 0.9ms(WS 8클라이언트+ESP32 6+Pixoo+BLE 2 동시), 렌더는 state-hash 게이트로 이미 디바운스. 7/1 밤 2시간 404 스트릭은 **이미 7/2에 수정된 `/api/setup/` trailing-slash 별건**(화면 플리커와 무관 — display/이미지 서빙은 정상이었음). 이미지 라우트는 양 허브 모두 해시 무시+항상 200이라 재렌더 race 404는 구조적으로 불가능.

### 해결 (Swift 데몬)
- **fallback-port 자가치유** (`DaemonService.swift::reclaimCanonicalPortIfNeeded`): fallback 포트에서 구동 중이면 5초 헬스 틱마다 canonical 포트 감시 — 건강한 데몬 재등장 → 자기 서버 내리고 **클라이언트 모드로 자진 강등**(Node의 /shutdown 축출 왕복 불필요), 포트가 비면(`isPortBindable`) 즉시 재점유. `standDownServer()`는 `onShutdown` 콜백을 해제해 자동 외부전환과의 이중 전이 차단 + fallback 부기(sessionOverridePort/fallbackAttempted/failedBindPorts) 초기화.
- **승격 오탐 완화** (`DaemonService.swift` + `SessionRegistry.swift`): 외부 데몬 사망 판정을 2연속(~10s)→**3연속 미스 + patient probe(5s)** 로. Node는 단일스레드+동기 SQLite라 부하 시 이벤트루프가 2초 넘게 멈춰도 살아있음 — 기존 2s probe가 오탐으로 라이벌 허브를 승격시켰음. `LocalProbeSession.patient`(5s/5s) 세션 분리로 기존 sibling probe(2s)와 풀 격리 유지.
- 검증: `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED. 런타임 검증은 다음 Xcode 실행에서 로그 확인 — 기대 라인: `standing down fallback-port hub`, `Canonical port ... is free — reclaiming`.

### 남긴 것 / 한계
- Xcode 디버거에 **suspended**된 Swift 데몬이 9120을 물면(7/3 01:13 "grabbed by a non-daemon" 케이스) 어느 쪽도 회복 불가 — probe 무응답+포트 점유. 코드로 못 막는 개발환경 특수 케이스, 사용자가 디버거 재개/중지해야 함.
- Node 쪽 대칭 reclaim(9121로 물러난 Node가 9120 재점유)은 미구현 — 실사용 토폴로지(허브 1개)에선 불필요, 필요해지면 별도 라운드.

---
