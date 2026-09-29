# 2026-07-01 — TRMNL "not responding" 근본 원인 조사 + weak-RSSI 전이 로깅

### 문제
TRMNL e-ink 패널이 "WiFi connected / not responding"을 자주 보인다는 리포트를 받아, 실행 중인 프로세스/포트/로그(`~/.agentdeck/swift-daemon.log`, `daemon-stderr.log`, 실시간 `/status`)를 대조 조사했다. 서로 다른 세 메커니즘이 겹쳐 있었다: (1) 6/18~6/29, Node CLI daemon과 Swift macOS 앱 daemon이 포트 9120을 두고 서로 능동적으로 축출하는 dual-hub race — Swift의 health-probe(2s 타임아웃 × 연속 2회 실패 ≈10s)가 Node의 이벤트루프 지연(동기식 better-sqlite3 APME 기록)에 false-positive를 일으키고, Node는 재시작 시 살아있는 Swift daemon을 능동적으로 shutdown시킨다. (2) 당일 새벽 03:00~03:04, iDotMatrix/Timebox BLE sync의 5초 간격 clean-exit→respawn 폭주가 daemon 자체의 반복 self-restart(28회 "Shutting down...", 일부는 shutdown 타임아웃까지)를 유발 — 같은 날 commit `8949e6f8`로 이미 수정됨, 이후 daemon은 6시간+ 무재시작. (3) 패널 자체 WiFi 링크의 물리적 변동(-59dBm ↔ -26dBm 관측) — 서버가 완전히 안정적으로 떠 있어도 firmware가 단발성 poll 실패를 WIFI_FAILED로 표시할 수 있고, 다음 poll에 자동 복구되는 잔여 리스크.

### 해결
- Node(`bridge/src/trmnl/byos-server.ts`)와 Swift(`apple/AgentDeck/Daemon/Modules/TrmnlModule.swift`) 양쪽에 기존 weak-link 임계값(`TRMNL_WEAK_RSSI_DBM`/`weakRssiDbm`, -78dBm — 이미 `image_url_timeout` 확장에 쓰이던 값)을 재사용한 RSSI 상태-전이 로깅을 추가. Node는 `logTagged`(기존 `debug()`는 `--debug` 게이트라 기본 운영 로그에 안 보임), Swift는 `DaemonLogger.error/.info` — 둘 다 항상 노출.
- 매 poll(60~180s)마다 로그하지 않고 weak 진입/회복 **전이 시점에만** 1줄 남겨, 향후 "not responding" 발생 시각을 실제 RSSI 이력과 상시 로그로 대조 가능하게 함.
- (2)는 로그 타임스탬프 교차검증으로 당일 커밋이 이미 해결했음을 확인. (1)은 Swift 앱이 현재 비활성이라 코드 변경 대신 기존 운영 가이드(`docs/devices.md`, 동시 실행 금지)로 커버 — 코어 singleton-guard 튜닝은 전체 daemon 시작 경로에 영향을 주는 리스크가 있어 이번 세션에서는 보류.

### 핵심 설계 결정
- RSSI 로그는 telemetry(매 poll 갱신)와 별개로 **전이만** 남긴다 — 상관관계 신호가 목적이라 매 poll 로그는 스팸.
- dual-hub race의 근본 수정(예: Swift health-probe 타임아웃 완화)은 전 사용자에게 영향을 주는 변경이라 별도 확인 후 진행하기로 하고 이번엔 진단 로깅만 반영.

### 검증
- `npx vitest run bridge/src/__tests__/trmnl-byos.test.ts` — 23/23 pass (신규 weak-RSSI 전이 테스트 포함).
- `cd bridge && npx tsc --noEmit` — clean.
- `xcodegen generate && xcodebuild -project AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' build` — BUILD SUCCEEDED.
- 전체 `bridge/src` vitest는 사전부터 있던 `better-sqlite3` ABI mismatch(APME/codex-turn-manager, 83 tests)로 실패 — `git stash`로 본 변경 제외 후 동일 실패 재현 확인, 본 세션 변경과 무관(다른 세션이 이미 위 항목에서 추적 중).

---
