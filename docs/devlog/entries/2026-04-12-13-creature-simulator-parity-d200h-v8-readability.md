# 2026-04-12 — Creature simulator parity + D200H v8 readability

### 문제
- `tools/creature-simulator`의 e-ink/ESP32/TC001/D200H preview가 실제 렌더러가 아니라 HTML 전용 근사치라 drift 발생.
- e-ink preview는 1872x1404 기준 높이 비례 폰트가 과대 적용되어 좌측 텍스트와 레이아웃이 실제 Android Compose 화면과 다름.
- TC001 preview에 실제 AGENTS 페이지에는 없는 agent 하단 상태 점이 표시됨.
- D200H 세션/usage 텍스트가 실기기에서 작고, usage 색상 룰이 Pixoo/TC001 계열과 다름.

### 해결
- D200H renderer rev를 `stock-safe-v8`로 갱신하고 세션 키 텍스트/상태 라벨을 확대, idle 상태에서도 agent 브랜드 스트립을 표시.
- D200H usage merged PNG를 `LIMITS` 중심 레이아웃으로 재구성하고 blue/teal/amber/red 사용량 색상 룰로 통일.
- TUI simulator data를 160x40 기준 actual `renderDashboard()` 출력으로 재생성하고 ANSI 색 span을 보존해 실제 terminal 색상과 더 가깝게 표시.
- e-ink simulator preview를 capped font 기반 패널로 교체하여 실제 Compose 화면과 비슷한 밀도 유지.
- ESP32 simulator preview를 실제 LVGL HUD panel 크기/위치에 맞춰 landscape/portrait/round를 분기.
- TC001 simulator sprite와 layout을 `matrix_pages.cpp` 기준으로 맞추고 AGENTS 페이지 하단 dot 제거.

### 검증
- `node --check scripts/render-creature-simulator.mjs` 성공.
- `swiftc -parse apple/AgentDeck/Daemon/Modules/D200hHidModule.swift` 성공.
- `pnpm --filter @agentdeck/bridge typecheck` 성공.
- `playwright screenshot --full-page http://127.0.0.1:8799/index.html /tmp/agentdeck-creature-simulator-after-tui.png` 성공.
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'generic/platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataD200HVisualParity build` 성공.
- D200H 실기 송신 덤프에서 `icons/btn0-stock-safe-v8-*.png`, `icons/btn13-wide-stock-safe-v8-*.png` 생성 확인.

---
