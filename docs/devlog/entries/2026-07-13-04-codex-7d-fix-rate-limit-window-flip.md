# 2026-07-13 — Codex 7d 게이지 소실 fix: rate-limit window 슬롯 flip → 길이 기준 라벨 + 데몬 정규화

### 문제
사용자 지적 "토큰 잔여량에서 **7d가 안 나온다**". 라이브 진단(`~/.codex/.../rollout-*.jsonl` 최신 `rate_limits` 직독)으로 **Codex 업스트림 스키마 변화**를 확인: 5h 창이 리셋되면 주간(10080분=7d) 창을 `primary` 슬롯에 싣고 `secondary=null`로 방출(같은 롤아웃에서 `primary=300/sec=10080` 113줄 → 이후 `primary=10080/sec=null` 27줄로 **중간 전환**). 슬롯 위치로 5H/7D를 하드코딩한 렌더러는 primary(실제 7d 데이터)를 "5H"로 오표기하고 7D(secondary)는 hide-if-absent로 사라짐. 즉 슬롯은 더 이상 창 종류를 보장 안 하고 `windowMinutes`만 신뢰 가능.

### 해결 — 소비자 2종류 × 2겹 fix
1. **길이 읽는 클라이언트**(windowMinutes 파싱): 슬롯 하드코딩 제거, present 창 순회하며 windowMinutes로 라벨 파생. shared `usageWindowLabel`/`usageWindowKind` SSOT 신설 → `d200h-layout.ts` 타일 + SD `session-slot-manager.ts` usageGauges 양쪽 사용. Device Preview D200H(`D200HLayoutModel`)에 windowMinutes 스레딩(`LivePreviewData`→`D200HUsage`). 메뉴바 `TopologyRail`·Android `codexLimitRows`는 이미 length 기반이라 무수정.
2. **★슬롯만 읽는 펌웨어**(ESP32/InkDeck `esp32/src/net/protocol.cpp`가 `codexRateLimits.primary`→"5H"/`.secondary`→"7D" 하드코딩, windowMinutes 무시): 재플래시/X3 fork 재포팅 불가 → **데몬이 wire 방출 전 길이로 정규화**(짧은창<1일→`primary`, 주간≥1일→`secondary`). Swift `DaemonServer.codexRateLimitsPayload` + Node `usage-event.ts normalizeCodexRateLimits` 양 chokepoint. windowMinutes는 wire 유지 → 길이기반 소비자 무영향(defense in depth).

### 검증 + 배포
- shared/plugin/bridge `tsc`, macOS `xcodebuild` **BUILD SUCCEEDED**. 신규 회귀 테스트: `session-deck-usage`(주간창이 primary로 와도 "7D" 타일·팬텀 없음), `usage-event`(주간 primary→wire secondary 라우팅).
- **실기 배포**: SD 플러그인(심링크→`streamdeck restart`) + Ulanzi/D200H(`package:install` 재번들 후 Studio 재시작) + **Swift 데몬 재시작** → 정규화 payload 실측 `{"secondary":{"usedPercent":5,"windowMinutes":10080},...}`, `primary` 없음. ESP32 5대·InkDeck·D200H·Pixoo·Timebox·iDotMatrix 전부 재연결.
- 커밋 `9e2db965`(길이 라벨) + `bf19e6c3`(데몬 정규화).

### 미해결(범위 밖)
CLI(Node 데몬) 환경은 코드 커밋됐으나 실행중 Node 데몬 재시작 시 반영(현 사용자는 Swift 데몬이라 무관). 물리 ESP32/InkDeck 육안 확인은 사용자 몫(패널 스크린샷 불가). 상세 [[codex-rate-limit-window-slot-flip]].
