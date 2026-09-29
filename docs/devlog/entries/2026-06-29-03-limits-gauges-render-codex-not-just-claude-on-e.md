# 2026-06-29 — LIMITS gauges: render Codex (not just Claude) on e-ink + TRMNL surfaces

### 문제
전자책(Android e-ink: CremaS/Panton 등)과 TRMNL e-ink의 **LIMITS** 영역이 Claude의 5h/7d만 보여주고 Codex 등 다른 솔루션은 안 나왔다. 데이터 문제가 아니라 렌더링 누락이었다: `buildUsageEvent`는 단일 `usage_update`에 Claude + `codexRateLimits` + `antigravityStatus`를 모두 싣고, Android `AgentState`는 `state.codexRateLimits`를 hoist까지 한다. 실제로 HUD rail(`TopologyRail`)·D200H·ESP32 IPS10 topbar는 이미 Codex를 그렸지만, e-ink composable들과 TRMNL 렌더러는 `fiveHourPercent`/`sevenDayPercent`만 읽고 `codexRateLimits`를 무시했다.

### 해결
- **표시 규약(사용자 결정)**: 브랜드 마크가 provider를 나타낸다 — 라벨은 `5h`/`7d` 그대로, 행 앞의 per-agent 브랜드 마크로 Claude/Codex를 구분(D200H의 "brand dot conveys the agent" 규약과 동일).
- **Android**: 공유 헬퍼 `codexLimitRows()`/`windowLabel()`/`ProviderLimitRow`를 `util/TimeFormatUtils.kt`에 추가하고 `TopologyRail.buildCodexRateChips`를 그것으로 리팩터(drift 방지). e-ink LIMITS 표면(live `EinkLimitsCornerCard` + 레거시 `EinkStatusPanel`/`EinkStatusCompact`/`EinkEngineColumn`/`EinkUsagePanel`)과 태블릿 `UsageSummaryCard`에 Codex 행을 `BrandIcon`과 함께 추가. Codex는 Claude의 `usageStale`이 아니라 **윈도별 자체 stale**로 게이팅.
- **TRMNL**: Node `shared/src/trmnl-layout.ts`와 Swift 미러 `TrmnlImageRenderer.swift`에 Codex 풋터 행(Codex 글리프 + 5H/7D) 추가, Codex 있을 때 풋터 밴드를 2행으로 확장. `frame-cache.ts::trmnlStateHash`와 Swift `TrmnlModule.stateHash`에 Codex 필드를 접어 넣어 Codex-only 변경도 재렌더되게 함. `TrmnlDashState`에 codex 윈도 필드 추가 + `applyUsage`에서 hoist 파싱.

### 핵심 설계 결정
- 매핑 SSOT는 `codexLimitRows`/`windowLabel` 한 곳 — rail과 e-ink가 갈라지지 않게.
- TRMNL은 Node SVG + Swift CoreGraphics **이중 렌더**(App Store 격리)라 두 렌더러를 같은 변경에서 동시 수정해야 한다(미러 불변식).
- **ESP32는 이번 변경에서 제외**: Codex는 이미 메인 IPS10에서 렌더되고, non-IPS10 TANK STATUS 확장은 best-effort인데 `esp32/`가 동시 세션에서 활발히 편집 중(agent_state.h 포함)이라 충돌 위험 + 하드웨어 플래시 검증 필요 → 깨끗한 후속으로 미룸.

### 검증
- vitest TRMNL: layout 23 + frame-cache 4 + renderer/byos 27 통과. Codex 풋터를 실제 PNG로 래스터화해 Claude/Codex 2행 + 브랜드 마크 시각 확인.
- Android `:app:compileDebugKotlin` 성공, `TimeFormatUtilsTest` 24개 통과(신규 `codexLimitRows`/`windowLabel` 포함).
- `AgentDeck_macOS` Debug 빌드 성공(Swift 미러).
- Android e-ink 카드 자체 에뮬레이터 스크린샷은 미수행(스크린샷 테스트 하니스 없음) — 동일 데이터+`BrandIcon` 경로이고 TRMNL PNG가 마크 규약을 시각 검증.

---
