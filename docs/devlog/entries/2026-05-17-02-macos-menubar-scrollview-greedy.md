# 2026-05-17 — macOS MenuBar 팝업 가변 사이징 + ScrollView greedy 해결

### 문제

macOS 메뉴바 드롭다운 (`ControlTowerPanel`) 팝업이 컨텐츠보다 작게 떠서 항상 세로 스크롤바가 노출됨. 사용자 요청: 컨텐츠에 따라 가변적으로 늘어나 스크롤이 최대한 안 생기게.

세부 원인 3 가지:
1. **고정된 chrome 예약 140 pt**: `scrollContentMaxHeight = max(360, screenHeight * 0.85 - 140)` 가 실제 header/banner/footer 높이와 무관. CalmHeader 일 때 chrome 이 ~140 이라 작은 차이지만, AttentionTheater + DaemonOfflineBanner 동반 시 실측 ~290 이 되어 cap 부족.
2. **너비 380 pt 고정**: 긴 projectName / modelName 이 truncate 되며 세로 줄바꿈으로 vertical 부담 가중.
3. **SwiftUI ScrollView greedy 함정** (핵심): `ScrollView { content.fixedSize(vertical: true) }.frame(maxHeight: X)` 패턴에서 `fixedSize` 는 **content** 의 intrinsic 만 고정할 뿐 ScrollView 자체는 여전히 부모가 제안한 `maxHeight` 를 무조건 가득 채움. content 가 frame 보다 작아도 ScrollView 가 frame 만큼 자라 빈 공간이 생기거나, content 가 조금이라도 크면 즉시 스크롤바 발생.

### 해결

**`apple/AgentDeck/UI/MenuBar/ControlTowerPanel.swift`**
- `ChromeHeightKey` PreferenceKey + `measureChromeHeight()` View extension 추가 — header Group / banner+pillActionsBar / footerSection 3 위치의 실측 높이를 reduce-합산.
- `ContentHeightKey` PreferenceKey 추가 — body VStack 에 GeometryReader backing 으로 natural 높이 publish (single-source 라 reduce 는 `value = nextValue()` 로 latest 채택).
- ScrollView frame 을 `min(scrollContentMaxHeight, measuredContentHeight)` 로 명시 바인딩 — ScrollView greedy 우회. content < cap 이면 ScrollView 가 content 크기로 줄어들고 scrollbar 안 뜸.
- `showsIndicators: measuredContentHeight > scrollContentMaxHeight` 조건부 — 진짜 overflow 일 때만 표시.
- `scrollContentMaxHeight` = `max(80, screenHeight - max(140, measuredChromeHeight) - 24)`. `screenHeight * 0.85` 계수 제거 (`visibleFrame` 이 이미 menubar+Dock 제외). 80 pt 플로어는 1 세션 행 가시성 보장; AttentionTheater 가 클 때 body 가 자연 축소되어 popup_total ≤ screen 유지.
- 팝업 너비 `.frame(width: 380)` → `.frame(minWidth: 380, idealWidth: 420, maxWidth: 460)` 가변화.
- Swift 6 strict-concurrency: PreferenceKey `defaultValue` 는 `static let`.

**`apple/AgentDeck/UI/MenuBar/AttentionTheaterView.swift`**
- 옵션 리스트 ScrollView 캡 `220 pt` 고정 → `min(380, screenHeight * 0.35)` 적응형. 일반적인 3–8 옵션 prompt 는 ceiling 에 안 닿아 scrollbar 자체 안 뜸. `/openclaw scope` 같은 30+ 옵션만 카드 내부 스크롤로 흡수.
- Sizing invariant: `options(≤380) + 140(badge/question chrome) + 150(banner+pill+footer) + 80(body floor) + 24(safety) ≤ screen`. 일반 화면 (≥800 pt) 에서 popup 절대 overflow 안 함.

### 핵심 설계 결정

- **SwiftUI ScrollView 는 부모가 제안한 height 를 항상 가득 채우는 greedy view**. `.fixedSize(vertical: true)` 를 안쪽 VStack 에 붙여도 ScrollView 자체는 안 줄어듬. ScrollView 가 content 크기로 줄어들게 하려면 별도 PreferenceKey 로 content 높이를 측정 → `.frame(maxHeight: min(cap, contentHeight))` 로 명시 바인딩 필요. macOS SwiftUI 의 잘 안 알려진 함정.
- **`max(140, measuredChromeHeight)` 형태의 fallback** 은 PreferenceKey 가 첫 frame 에 미발화 (한 runloop tick 뒤 도착) 인 경우를 위한 안전망. 일반적으로 실측치 ≥ 140 이라 `max()` 가 fallback 보다 큰 측정치를 채택해 동작에 영향 없음.
- **여러 sizing cap 은 같은 화면 예산을 나눠 쓴다는 invariant 위에 설계해야**. AttentionTheater 옵션 cap (옵션이 헤더에 포함됨) + body floor 가 독립적으로 자기 몫 주장하면 popup_total > screen 으로 overflow. cap 들의 합 + chrome 추정치 ≤ screen 을 산식으로 명시하고 각 cap 을 그 산식 안에서 정함.
- **ContentHeightKey 의 reduce 는 `value = nextValue()` (덮어쓰기), ChromeHeightKey 는 `value += nextValue()` (누적)**. 전자는 단일 GeometryReader 소스, 후자는 3 위치 합산. PreferenceKey reduce 시맨틱은 source 수에 따라 다르게 선택.
- **같은 popup 안 두 ScrollView 는 둘 다 ContentHeight PreferenceKey 패턴 필요**. 1차 fix 는 ControlTowerPanel body 만 적용했고 AttentionTheater 옵션 ScrollView 는 cap 만 조절해 greedy 그대로 남겨 — Codex stop-time review 가 잡음. 2차 fix 에서 `OptionsHeightKey` 를 file-local 로 정의 (`ContentHeightKey` 와 분리해야 같은 root 의 onPreferenceChange bubble 에서 안 섞임) + 옵션 VStack 에 GeometryReader backing + `frame(maxHeight: min(optionsCap, measuredOptionsHeight))` 명시 바인딩. **교훈**: ScrollView 인스턴스 수만큼 별도 PreferenceKey + 별도 @State 필요.

---
