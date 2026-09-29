# 2026-04-03 — D200H Hybrid Icon Buttons (Firmware-Safe PNG + Native Text)

### 문제
D200H는 Stream Deck처럼 풍부한 시각 버튼 UX를 맞추고 싶지만, 지금 구현은 사실상 네이티브 텍스트 중심이었다. 과거 시도에서 CoreText로 긴 텍스트를 PNG에 직접 그리면 ZIP 크기와 경계 바이트 조건 때문에 D200H 펌웨어가 `SET_BUTTONS`를 거부하고 기본 시계 화면으로 되돌아가는 문제가 있었다.

### 해결
- `apple/AgentDeck/Daemon/Modules/D200hHidModule.swift`
  - 버튼 구조체에 `icon` / `iconColor` 추가
  - 세션 타입별 배지 추가:
    - Claude Code = octopus
    - Codex CLI = jellyfish/cloud
    - OpenCode = nested square
    - OpenClaw = crayfish
  - 액션 버튼도 전용 glyph 추가:
    - Back / Stop / More / Go On / Review / Commit / Clear / Tool / Usage
  - PNG 렌더러는 더 이상 텍스트를 직접 그리지 않고, 상단의 **희소(sparse) 벡터형 아이콘**만 그린다
  - 라벨은 계속 기기 네이티브 `manifest Text`로 처리
  - 라벨 스타일은 `Size 14 / Weight 72`로 낮춰 아이콘과 텍스트 공존 공간 확보

### 핵심 설계 결정
- **완전 이미지 버튼보다 하이브리드가 안전하다.** D200H는 이미지 자체가 불가능한 게 아니라, 큰 텍스트 렌더가 포함된 PNG와 ZIP이 펌웨어 허용 범위를 쉽게 넘는다.
- **아이콘은 sparse path로만 렌더한다.** 넓은 채움면과 텍스트 래스터를 피하면 PNG 압축률이 좋아지고 boundary padding 우회 성공 확률이 올라간다.
- **텍스트는 계속 native renderer 사용**: 가독성과 펌웨어 안정성을 둘 다 지키기 위한 절충안.

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataD200Hybrid build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`

---
