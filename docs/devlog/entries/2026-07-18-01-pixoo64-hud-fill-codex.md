# 2026-07-18 — Pixoo64 사용량 HUD 실루엣·배경 fill·Codex 만료일 개선

### 문제
- 전날 Pixoo64 사용량 HUD의 provider 마커를 7×7 정사각형으로 바꾸면서, 실제 점유 영역이 24×15인 Claude Code 마스크까지 내용 경계를 잘라 7×7로 늘려 원본보다 세로로 긴 로봇이 됐다.
- 9px 마커 영역 뒤에 사용량 창이 x=10부터 시작해 마커의 왼쪽은 1px, 오른쪽은 2px처럼 보였고, primary/secondary 창 너비도 26px/27px로 미세하게 달랐다.
- 사용률이 하단 1px rail로만 남아 TC001의 면적형 gauge보다 한눈에 읽기 어려웠고, 로고 슬롯과 수치 영역도 별개 조각처럼 보였다.
- Codex rollout이 secondary(7D) window만 제공할 때 행 앞 절반을 활용하지 못했고, 이미 수집 중인 ChatGPT 구독 만료일도 Pixoo에서는 보이지 않았다.

### 해결
- Node/Swift `drawUsageHUD`가 마스크의 점유 bbox를 crop하지 않고 canonical 24×24 캔버스 전체를 7×7로 샘플링하게 했다. 따라서 Codex는 정사각형 실루엣을 유지하고 Claude는 원본처럼 7×5의 넓고 낮은 외곽으로 렌더된다.
- HUD geometry를 `9px marker + 27px primary + 1px divider + 27px secondary`로 재배치했다. 마커는 x=1…7을 써 좌우 여백이 정확히 1px이고 사용량은 x=9에서 바로 이어진다.
- TC001처럼 사용된 폭을 7px 높이 전체의 어두운 색면으로 채운다. 로고 슬롯에도 조금 더 짙은 provider tint를 이어 붙이고, 70% 미만은 Claude coral/Codex violet, 70%/90%부터 amber/red 경고색을 써 마커·수치·fill이 한 밴드로 읽힌다.
- Codex primary가 없고 secondary만 있을 때 왼쪽 27px zone에 `M/D` 구독 만료일을 가운데 배치하고, 오른쪽에는 기존 7D 퍼센트+reset countdown을 유지한다. 날짜가 없거나 해석 불가능하면 기존처럼 단일 window를 전체 폭으로 렌더한다.
- Node/Swift 회귀 테스트에 마커 x=1…7 대칭, Claude의 비정사각 실루엣, full-height fill, Codex-only 만료일 배치를 추가했다.

### 검증
- `pnpm vitest run bridge/src/__tests__/dot-matrix-glyphs.test.ts bridge/src/__tests__/pixoo-sprites.test.ts` — 36/36 통과.
- `pnpm build` — 전체 workspace build 통과.
- `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination platform=macOS -only-testing:AgentDeckTests_macOS/IDotMatrixProtocolTests` — 18/18 통과.
- 실제 Node 렌더러로 Claude 35/58%, Codex 7D 72%, 구독 만료 8/1인 64×64 프레임을 nearest-neighbor 8배 확대해 full-height fill, 로고 슬롯 연결감, `8/1 | 72% 3d` 가독성을 시각 확인했다.
