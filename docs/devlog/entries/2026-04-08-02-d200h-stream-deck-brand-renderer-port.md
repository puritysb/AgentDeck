# 2026-04-08 — D200H Stream Deck Brand Renderer Port

### 문제
D200H Swift 경로는 펌웨어 안전성을 위해 PNG에서 텍스트를 거의 제거한 뒤 너무 단순한 기하 아이콘만 남겨, Stream Deck 구현과 같은 시각 언어가 사라져 있었다. 특히 세션 버튼이 상태색으로만 칠해진 러프한 심볼에 머물러 실제 Stream Deck 세션 슬롯의 브랜드 로고/배지 인상을 재현하지 못했다.

### 해결
- `apple/AgentDeck/Daemon/Modules/D200hHidModule.swift`에서 세션 로고 색을 상태색이 아니라 **에이전트 브랜드색**으로 분리:
  - Claude Code `#C07058`
  - OpenClaw `#ff4d4d`
  - Codex CLI `#6366f1`
  - OpenCode `#F1ECEC`
- D200H PNG 렌더에 Stream Deck renderer 기준 브랜드 path를 직접 이식:
  - Claude robot
  - Codex knot/clover
  - OpenCode nested-square
  - OpenClaw body/claws/antennae/eyes
- `CGPath`용 SVG path parser를 추가해 TypeScript `agent-logos.ts`와 같은 path 데이터를 Swift PNG 렌더에서도 재사용 가능하게 함.
- 세션 타일 상단에 **brand badge**를 추가하고, 그 안에 실제 로고를 배치해 Stream Deck 세션 슬롯의 상단 시그니처 구조를 모사.
- 빠른 액션 아이콘도 Stream Deck 구현에 맞춰 정리:
  - `GO ON` 삼각형
  - `REVIEW` 문서 라인 아이콘
  - `COMMIT` 원형 + 체크
  - `CLEAR` X
- 텍스트는 여전히 `manifest ViewParam.Text`에 남겨 PNG를 텍스트-free로 유지했다. 즉 미감을 올리되, 과거처럼 텍스트가 들어간 PNG 때문에 `SET_BUTTONS`가 거부되는 경로로는 되돌리지 않았다.

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -derivedDataPath /tmp/AgentDeckDerivedDataD200HBoundaryFix build CODE_SIGNING_ALLOWED=NO` 성공.
- 새 Swift 앱 런타임 dump 확인:
  - `20260408-133756-150-set_buttons-L-37674b-OPENCLAW_OPENCLAW__.zip`
  - 전체 ZIP `37674 bytes / 37 packets`
  - `icons/btn0.png = 3649 bytes`
  - `icons/btn1.png = 6257 bytes`
  - `icons/btn13L.png = 2754 bytes`
- 실제 추출 PNG 육안 확인 결과:
  - 기존의 단순 사각/타원 심볼 대신 브랜드 로고와 배지가 보임
  - usage 버튼도 기존과 같은 safe path를 유지

### 남은 한계
- 현재 stock firmware safe path에서는 **Stream Deck의 3단 텍스트 레이어(project/model/state)를 PNG 내부에 그대로 넣는 방식**까지는 복원하지 않았다.
- 따라서 지금은 “브랜드/배경/상태 장식은 Stream Deck에 상당히 근접”, “텍스트 구조는 D200H native label 제약 안에서 동작” 상태다.
- 여기서 더 나아가 완전히 동일한 버튼 캔버스를 원하면 다음 둘 중 하나가 필요하다:
  - Ulanzi 전송 규약을 더 정확히 역공학해서 richer PNG/manifest 조합을 재현
  - stock firmware를 우회하고 자체 렌더러로 takeover

---
