# 2026-04-08 — D200H Stream Deck Parity Pass: Press Flash + Awaiting Glow

### 문제
D200H Swift 렌더는 브랜드 로고와 상태색을 Stream Deck 쪽에 가깝게 맞춘 뒤에도, 체감상 두 가지 큰 차이가 남아 있었다.

1. 버튼을 눌렀을 때 `showOk`/`showAlert`에 준하는 즉시 피드백이 없어, ZIP 재렌더 전까지 눌림 확인이 비었다.
2. `awaiting` 보더가 단순 alpha pulse라서 Stream Deck SVG의 gaussian glow보다 훨씬 딱딱하게 보였다.

이 차이는 펌웨어-safe icon-first 경로를 유지하더라도 바로 줄일 수 있는 영역이었다.

### 해결
- `apple/AgentDeck/Daemon/Modules/D200hHidModule.swift`
  - 버튼 입력 처리에 `press flash` 단계 추가:
    - 눌린 버튼을 즉시 밝게 만든 `PARTIAL_UPDATE`를 먼저 전송
    - 약 `90ms` 후 실제 command resolution / local handling 수행
    - 화면 전환이 없는 버튼은 현재 상태 partial ZIP으로 자동 복원
  - flash는 단순 배경 변경이 아니라:
    - 배경 밝기 상승
    - 아이콘 밝기 상승
    - 보더를 밝은 solid highlight로 승격
  - option 모드의 merged `BACK` 버튼(slot 13)도 partial ZIP으로 flash 가능하도록 `renderPartialZip()`이 merged button partial을 지원
  - 렌더 경로 중복을 줄이기 위해 현재 화면 상태 계산을 `currentDisplayRenderState()`로 분리
  - `awaitingPulse` 렌더에 CoreGraphics shadow blur를 추가해 Stream Deck의 glow border 감각에 더 가깝게 조정

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataD200HParity build CODE_SIGNING_ALLOWED=NO`
  - 최종 `BUILD SUCCEEDED`

### 핵심 판단
- 이 변경으로 D200H는 단순히 “비슷한 정적 타일”이 아니라, `눌림 반응`과 `awaiting animation`까지 Stream Deck에 더 가까운 촉감을 갖게 됐다.
- 다만 **완전 동일 UI는 아직 아니다.**
  - 현재 경로는 여전히 stock firmware safe path를 우선해 PNG 내부 텍스트를 비워 두고 native label을 사용한다.
  - 따라서 Stream Deck의 `project / model / state` 3단 텍스트를 같은 캔버스에 완전히 재현하려면 vendor-accepted richer PNG 조합을 더 찾거나, stock firmware 우회가 필요하다.

---
