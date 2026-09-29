# 2026-05-08 — HUD primary-only OpenClaw + ChatGPT subscription parity (3-round stop-gate)

### 문제
- 우측 HUD Upstream 의 OpenClaw 줄에 모델 카탈로그 전체가 노출. 사용자는 primary (`role=="default"`) 만 원함.
- macOS 에서 ChatGPT subscription 행이 아예 안 떴고, Android 태블릿은 이미 지나간 `subscription_active_until` 을 그대로 표시.

### 해결
- `apple/AgentDeck/Daemon/Server/DaemonServer.swift` — `buildFullStateEvent` 가 `buildSubscriptions()` 를 호출하도록. 이전엔 `buildUsageEvent` 에만 들어가 SwiftUI 의 `state.subscriptions` 가 비어 있었음.
- `apple/AgentDeck/Model/Protocol.swift` `openClawDisplayLines` + Android `TopologyRail.kt` / `EinkStatusPanel.kt` / `EinkStatusCompact.kt` — `role == "default"` 만 통과시키는 strict filter. fallback-N / configured 는 모두 숨김. **default 가 없으면 row 자체를 비움** (사용자 명시 선택을 그대로 따름).
- 만료 처리: `subscriptionTrailing(until, now)` 헬퍼 — future date 는 `~yyyy-MM-dd`, 과거/parse 실패는 `renewal needed` 라벨로 전환. macOS 는 `TerrariumHUD.ledAmber`, Android 는 `TerrariumColors.LEDAmber` 로 강조.
- **Time invalidation (Android 전용)**: `rememberCurrentInstant(periodMillis = 60_000L)` Compose 헬퍼 도입 — `produceState` 로 60s tick 을 발생시켜 expiring window 가 자동으로 "renewal needed" 로 전환. 이전엔 `Instant.now()` 를 view body 에서 직접 읽거나 `remember(subs) { Instant.now() }` 로 캐시 → recomposition 트리거 없이는 갱신 안 됨.
- `parseUntilDate` (Apple) — `^\d{4}-\d{2}-\d{2}$` regex gate + `isLenient = false` 추가. 기존엔 `2026/05/06` 같은 형식이 silent 통과.
- 테스트: `OpenClawDisplayLinesTest` 신규 (Android), `TopologyRailHelpersTests` 에 `subscriptionTrailing` 케이스 4종 추가, 기존 `SubscriptionLineTest` 를 "renewal needed" 기대값으로 갱신.

### 핵심 설계 결정
- **Render-side filter, not server-side trim.** OpenClaw 카탈로그는 model-swap UI 등 다른 surface 가 그대로 사용해야 하므로 daemon/bridge 는 전체 카탈로그 유지. HUD 만 좁힘.
- **Past-date 는 daemon 에서 거르지 않고 UI 에서 라벨 변환.** Codex CLI 가 `subscription_active_until` 을 로그인 시 한 번만 쓰고 자동 갱신하지 않기 때문에 stale 은 정상 시나리오. cache 의 lossy fallback (`current ?? previous`) 도 그대로 둠 — re-login 으로 회복.
- **시간 의존 렌더링은 ticker state 가 default.** Compose 의 `produceState` 60s tick. SwiftUI 는 `EnvironmentObject` 변경 빈도가 충분해 별도 ticker 없음 (Codex stop-gate 도 Android 만 지적).

### 회고
같은 패턴 (`sub.until?.take(10)` raw render, `firstOrNull { it.available }` fallback) 이 4 파일에 흩어져 있었는데 stop-gate 가 3 라운드 도는 동안 발견. 첫 implementation 직전에 `rg -n "sub.until|firstOrNull { it.available }" android/app/src/main/kotlin/` sweep 한 번이면 모두 잡혔을 것. 사용자가 single-select 로 `default 만` 을 명시했음에도 "비면 어쩌지" 라는 추측으로 fallback 을 끼워 넣은 첫 라운드 regression 도 동일 류 — 사용자 명시 답에 hedge 추가 금지.

---
