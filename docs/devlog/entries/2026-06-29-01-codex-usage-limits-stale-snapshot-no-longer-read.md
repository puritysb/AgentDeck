# 2026-06-29 — Codex usage limits: stale snapshot no longer reads as "now"

### 문제
대시보드 LIMITS 게이지에서 Codex 사용량이 `5H ███ 67% ↻now` 처럼 모순되게 표시됐다. `now` 는 "지금 리셋 중"(=사용량 ~0)으로 읽히는데 막대는 67% 라 어색했다. 원인은 freshness 모델의 부재: Claude 사용량은 라이브 API + 10분 staleness TTL 인 반면, **Codex 사용량은 `~/.codex/sessions/.../rollout-*.jsonl` 을 수동적으로 읽기만** 한다. Codex 를 안 쓰면 마지막 `rate_limits` 스냅샷이 얼어붙어 `used_percent` 는 옛값 그대로, `resets_at` 은 과거로 흘러가고, 6개의 중복 reset 포매터가 모두 `diff <= 0 → "now"` 를 반환했다.

### 해결
6개 포매터를 건드리지 않고 **이벤트 소스에서 per-window 정규화**:
- `shared/src/format-utils.ts` 에 `isCodexWindowStale(resetsAt, graceMs=5m)` 추가 — `resets_at` 이 grace 넘게 과거면 stale.
- `bridge/src/usage-event.ts` `buildUsageEvent` 가 만료 윈도우를 정규화: `usedPercent` 유지 + `resetsAt` 제거(→ 모든 다운스트림 포매터에서 "now" 소멸) + `stale:true`. 5h 만료/7d 라이브가 독립 처리된다.
- Swift 데몬 미러: `apple/.../DaemonServer.swift` 의 `codexRateLimitsPayload` + `isCodexWindowStale`, `UsageAPIClient.swift` 의 window struct.
- 타입 4표면(`shared/protocol.ts`, Swift/Kotlin `Protocol`, plugin `usage-gauge.ts`) 에 `stale?` 추가.
- 렌더러 dim + "stale" 마커: plugin E3 인코더/144 타일, `shared/d200h-layout.ts`, Apple 메뉴바 `compactGauge` + TopologyRail, Android RateChip(기존 stale 지원 재사용).

### 핵심 설계 결정
- **만료 = stale, zeroing 아님**: 만료 윈도우의 percent 를 0 으로 만들지 않고 마지막값을 유지한 채 dim + "stale" 로 불확실성을 정직하게 노출(`adjustUsagePercent` 의 far-past 철학과 일치). 사용자가 Option A 로 확정.
- **per-window staleness**: 전역 `usageStale`(Claude-API TTL)로 Codex 를 비우면 안 됨 — 윈도우별 `stale` 플래그로 처리. 부수적으로, Claude fetch 가 없을 때 Codex 인코더가 통째로 비워지던 **잠재 버그**도 제거(`buildCodexUsageEncoder` 의 전역 staleness gate 제거).

### 검증
- vitest 1583/1583 (신규 `isCodexWindowStale` 6 + `buildUsageEvent` 정규화 3 포함).
- macOS Swift `xcodebuild` BUILD SUCCEEDED.
- 시각 확인(resvg 라스터): D200H Codex 타일 + plugin E3 인코더 모두 만료 5H 가 흐린 `67% · stale`, 라이브 7D 는 `12% · 4d23h` — "now" 없음.
