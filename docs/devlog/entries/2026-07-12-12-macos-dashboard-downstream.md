# 2026-07-12 — macOS Dashboard 리사이즈 잔상 + DOWNSTREAM 레일 오버플로 수정

### 문제
- 창을 리사이즈하는 동안/직후 이전 창 경계 위치에 파란 세로선 잔상이 남았다. 원인은 `KeyboardShortcutsModifier`(⌘ 단축키 처리)가 `MonitorScreen`의 창 전체 콘텐츠에 `.focusable()`을 걸어둔 것 — macOS가 창 크기의 시스템 액센트(파랑) 포커스 링을 그리는데, 라이브 리사이즈 중 이 레이어가 이전 경계에서 무효화되지 않았다.
- `TopologyRail`(우측 UPSTREAM/DOWNSTREAM 패널)이 높이 제한 없는 VStack이라 downstream 기기가 많아지면 카드가 아래로 계속 자라 하단 35%의 타임라인 strip 영역, 특히 거의 투명한(black@0.19) chat detail pane을 가렸다.

### 해결
- `.focusable()` 직후 `.focusEffectDisabled()` 추가 — 포커스 자체와 `onKeyPress` 단축키는 그대로 두고 시각적 링만 억제.
- `MonitorLayout.sandFraction`을 기존 `TerrariumLayout.sandHeightFraction` SSOT에서 파생, `MonitorHUD` landscape 브랜치가 타임라인 위 water 영역 높이를 계산해 `TopologyRail(maxHeight:)`로 전달(가용 높이 <80pt면 레일 자체를 숨김 — 임의 하한값으로 인한 재침범 방지).
- `TopologyRail`은 단일 `ScrollView`를 상시 유지하고 frame height를 `min(측정된 자연높이, cap)`으로 바인딩 — 기기가 적으면 오늘과 동일한 hug-content 카드, 많으면 내부 스크롤. **중요 함정**: macOS는 `ScrollView` 콘텐츠 내부의 `GeometryReader`+`.preference()` 변경을 바깥 `onPreferenceChange`로 전파하지 않는다(iOS는 정상). `onGeometryChange`(macOS 15+/iOS 18+)로 교체해 해결, iOS 17만 preference 폴백 유지. 단일 서브트리 구조라 기존 `hubPulse` `repeatForever` 애니메이션은 재작성 없이 그대로 생존.
- 부수: 같은 날 다른 세션이 추가한 `ObservedSteering.swift`(19d09c4e)에 `#if os(macOS)` 가드가 빠져 iOS 빌드가 깨져 있던 것을 함께 수정.

### 검증
- `xcodebuild AgentDeck_macOS` / `AgentDeck_iOS` 둘 다 BUILD SUCCEEDED, `TopologyRailHelpersTests` 10/10 pass.
- 실행 중인 앱을 재시작(`osascript quit` → `open`)해 실기 확인: 우측 엣지 반복 드래그로 파란 잔상 재현 안 됨, 20종 downstream 기기 붙인 상태에서 레일이 타임라인 위에서 정확히 스크롤 클리핑되고 chat detail이 더는 가려지지 않음.

### 후속 (미착수)
- Android `MonitorScreen.kt`의 동일한 무제한 DOWNSTREAM 레일 — 이번 변경 범위 밖.
- iPad **portrait** 방향의 극단적 기기 수 오버플로는 별도 검토.
