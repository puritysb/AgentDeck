# 2026-04-11 — D200H Swift Button Coordinate + Dump Retention Fix

### 문제
D200H에서 세션 버튼의 아이콘/상태 점이 Stream Deck 기준 위치와 다르게 깨져 보였다. 최신 `partial_update` dump를 추출해 확인한 결과, 텍스트는 `drawText()`에서 top-down 좌표로 뒤집어 렌더링되는데 브랜드 아이콘/상태 점/좌측 인디케이터는 CoreGraphics 기본 좌표계 그대로 그려져 아래쪽으로 뒤집혀 있었다. 그 결과 아이콘이 텍스트 뒤쪽 하단에 겹치고 상태 점도 우상단이 아니라 우하단에 찍혔다.

또한 awaiting/processing animation이 `partial_update` ZIP을 짧은 간격으로 계속 dump하면서, full `set_buttons` dump가 몇 초 만에 prune 되어 실기기 분석 증거가 사라졌다.

### 해결
- `D200hHidModule.swift`
  - `drawInTopDownCoordinates()` 헬퍼를 추가해 버튼 아이콘, 상태 점, 세션 좌측 인디케이터를 텍스트와 같은 top-down 좌표계에서 렌더링하도록 수정.
  - `partial_update` dump를 5초 단위로 throttle.
  - dump prune 정책을 command별로 분리:
    - `set_buttons` 최근 12개 보존
    - `partial_update` 최근 24개 보존

### 검증
- 최신 dump에서 문제 재현:
  - `/tmp/d200h-latest.zip`
  - `icons/btn1.png`가 196×196 PNG이며, 아이콘/상태 점이 하단에 뒤집혀 보임.
- Xcode 빌드 시도:
  - `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataD200HVisualFix build CODE_SIGNING_ALLOWED=NO`
  - 실패 원인은 이 변경과 무관한 기존 local worktree 상태: `apple/AgentDeck/Terrarium/Creatures/JellyfishCreature.swift`가 삭제되어 있는데 Xcode project와 `TerrariumRenderer.swift`는 아직 `JellyfishCreature`를 참조.

### 핵심 판단
- 이번 깨짐은 D200H stock firmware 문제가 아니라 Swift CoreGraphics 렌더러 내부 좌표계 불일치다.
- 장기적으로는 Swift에서 Stream Deck SVG를 손으로 재구현하지 말고, shared SVG renderer → deterministic rasterizer 경로를 D200H도 사용해야 한다. 단 Node `@resvg/resvg-js` 경로는 `loadSystemFonts: false`일 때 텍스트가 누락되는 것을 확인했으므로, font bundling 또는 system font loading 정책까지 같이 정해야 한다.

---
