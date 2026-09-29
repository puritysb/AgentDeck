# 2026-05-10 — Menu bar AgentDeck symbol alignment

### 문제

macOS 메뉴바 라벨과 드롭다운 팝업의 AgentDeck 허브 아이콘이 추상적인
stacked-card mark 를 사용했다. App Store / Dock / pairing splash 의 실제
제품 상징인 aquarium dome + hardware deck 아이콘과 실루엣이 달라,
같은 앱 안에서도 메뉴바 표면만 별도 브랜드처럼 보였다.

### 해결

- `AgentDeckLogo` 를 app icon 의 작은 크기용 심볼로 재정의했다. 전체
  bitmap illustration 을 16–20pt 로 축소하지 않고, dome outline /
  waterline / deck base / button glints 만 SwiftUI Shape 로 그린다.
- 메뉴바 상태 배지와 calm header 연결 상태 색을 `DesignTokens.UI.*`
  product palette 로 이동했다.
- `DESIGN.md` §6 에 small-size product symbol 규칙을 추가하고, 메뉴바
  아이콘 규칙을 현재 구현과 맞췄다. 추상 card-stack / hub / router
  mark 는 production AgentDeck mark 로 쓰지 않는다.

### 검증

- `xcodebuild -scheme AgentDeck_macOS -destination 'platform=macOS' build
  EXCLUDED_SOURCE_FILE_NAMES=LaunchSessionDialog.swift` BUILD SUCCEEDED.
  현재 워크트리의 별도 변경에서 `LaunchSessionDialog.swift` 가 삭제됐지만
  `AgentDeck.xcodeproj` 의 stale reference 가 남아 있어, 일반 빌드는 그
  참조에서 먼저 중단된다.
- `python3 design/verify-tokens-sync.py` All mirrors in sync.
- `git diff --check -- apple/AgentDeck/UI/MenuBar/AgentDeckLogo.swift
  apple/AgentDeck/UI/MenuBar/AgentStatusIcon.swift
  apple/AgentDeck/UI/MenuBar/AttentionTheaterView.swift DESIGN.md
  DEVELOPMENT_LOG.md` 통과.

---
