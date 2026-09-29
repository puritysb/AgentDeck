# 2026-07-03 — 기기 표면 offline UI 일관성: connection-state lexicon SSOT + ESP32 재연결 라벨 수정

### 문제
데몬 링크가 끊겼을 때 표면마다 표기가 제각각: SD/D200H/Pixoo는 "OFFLINE", 앱은 "Searching for bridges..."/"Connecting..."/"Reconnecting...", Apple만 "Retry Discovery" 버튼, ESP32는 splash가 "Searching for bridges..."인데 aquarium 오버레이는 SEARCHING·RECONNECTING **둘 다 "Connecting"**(같은 기기 안 불일치 + 재연결 단계 구분 소실).

### 설계 — 기기 특성별 2클래스 어휘
- **자가연결 클라이언트**(Apple/Android 앱, ESP32, TUI): 실제 단계를 표기 — `Searching for AgentDeck...`(소형 패널 압축형 `Searching...`) / `Connecting...` / `Reconnecting...` / `No WiFi`, 재시도 버튼 `Search Again`, 빈 발견 힌트 `No AgentDeck found on this network`. 내부 용어 "bridges"는 사용자 카피에서 제거.
- **데몬-구동 수동 표면**(SD, D200H, Pixoo, Timebox, iDotMatrix, TRMNL): 스스로 탐색 못 하므로 터미널 상태 `OFFLINE`(+`Open AgentDeck` CTA)만 — 수행할 수 없는 Connecting/Reconnecting을 주장하지 않음.

### 구현
- **SSOT**: 신규 `shared/src/connection-status.ts` — `DaemonLinkPhase` + `DAEMON_LINK_LABELS(_COMPACT)` + `PASSIVE_OFFLINE_LABEL`/`OPEN_AGENTDECK_LABEL` 등. TS 소비자(session-slot-renderer, display-tile, session-slot-button, d200h-layout, trmnl-layout, pixoo-renderer) 리터럴을 상수로 교체.
- **ESP32**: aquarium 오버레이 SEARCHING→"Searching...", RECONNECTING→"Reconnecting..."(기존 둘 다 "Connecting"); splash 상태 "Searching for AgentDeck..."(compactStatus가 전 보드에서 "Searching..."으로 압축).
- **Apple**: `ConnectionOverlay.swift`에 `ConnectionLexicon` 미러 enum; "Retry Discovery"→"Search Again", "No bridges found on network"→lexicon, SettingsScreen 검색 라벨 포함.
- **Android**: `ConnectionComponents.kt`에 `ConnectionLexicon` object; MonitorScreen/EinkMonitorScreen/StatusBadge 라벨 전부 lexicon 참조.
- **문서**: DESIGN.md §9 Voice & copy에 lexicon 규칙 추가(mirrors 동시 갱신 규칙 포함).

### 검증
vitest 92파일/1637 pass, `pnpm build` OK, `xcodebuild AgentDeck_macOS` OK, Android `compileDebugKotlin` OK, ESP32 `pio run -e ips35` OK. 코드 전역에서 "Searching for bridges"/"Retry Discovery" 리터럴 0건 확인.

### 후속(실기 배포 중 발견) — Android "Connecting..." 두 줄 중복 제거
실기 APK 반영 후 CONNECTING 상태에서 "Connecting..."이 두 줄로 뜨는 게 드러남. MonitorScreen/EinkMonitorScreen 모두 상태 부제(status subtitle)가 이미 CONNECTING→"Connecting..."을 렌더하는데, 그 아래 별도 블록이 같은 문자열을 한 번 더 표시하던 **기존 중복**. lexicon 상수화로 두 줄이 정확히 같아지며 눈에 띔. 별도 CONNECTING 블록 제거(부제 한 줄만 유지). **참고**: 사용자가 함께 본 "daemon-9120 + AgentDeck-9121 두 개 발견"은 코드 버그가 아니라 **같은 머신에 데몬 2개 공존**(macOS 앱 Swift 데몬 project=daemon/v=3/9120 + CLI Node 데몬 project=AgentDeck/v=1/9121 fallback)이 각각 mDNS 광고한 것 — 한쪽 데몬 정지로 해소. **후속**: 아래 2026-07-03 듀얼 데몬 공존 감사가 이 증상의 근본 원인(싱글턴 가드의 포트 스캔 사각지대)을 수정.

---
