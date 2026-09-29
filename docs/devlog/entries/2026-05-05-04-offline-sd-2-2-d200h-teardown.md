# 2026-05-05 — OFFLINE 히어로 SD+ 2×2 클러스터 + D200H teardown 프레임

### 문제
- `d030c142` 의 단일-키 OFFLINE 히어로가 짝수×짝수 데크(SD+ 4×2, SD XL 8×4) 에선 진짜 중앙이 없어 `floor(rows/2)*cols + floor(cols/2)` 가 항상 우하단으로 치우친 후보를 골라 시각 균형이 깨짐. SD+ 에서 슬롯 6 (button 7) 에 표시돼 어색.
- D200H 는 데몬이 종료되면 마지막 세션 화면이 그대로 남아 OFFLINE 표시가 전혀 없음. App 종료 후 재실행 전까지 stale 한 정보가 키패드에 떠 있음.

### 해결
- 공용 렌더러 `renderOpenAppQuadrant(quadrant)`: 288×288 논리 캔버스를 4 개의 144×144 viewBox 로 클리핑(transform translate). 각 키는 자기 외곽 둥근 모서리를 유지하면서 panel/icon/text 가 4 키에 걸쳐 하나의 카드로 보임.
- `computeCenterCluster(layout)`: 짝수×짝수 → tl/tr/bl/br 사분면 4 슬롯, 그 외 → 단일 'full' 슬롯 폴백. 기존 `computeCenterSlot` 시그니처는 보존.
- `session-slot-button.ts`: hero/keypress 둘 다 cluster 기반 — 클러스터 4 키 어디 눌러도 `openAgentDeckAppOrGitHub()` 발동.
- D200H Swift `sendOfflineFrame()`: `stop()` 에서 `disconnect()` 직전 호출, 14 ButtonSlot dim + 슬롯 7 (col=2,row=1, 시각 중앙) 에 OFFLINE/Open AgentDeck 카드 push. App→DaemonService.stop→DaemonServer.shutdown→ModuleManager.stopAll→D200hHidModule.stop 경로로 도달.

### 핵심 설계 결정

**1. 짝수 그리드 정중앙은 4-키 분산이 정답**
floor 공식이 항상 한쪽으로 치우치는 한계는 산술적으로 풀 수 없음. SVG viewBox 클리핑으로 한 카드를 4 등분하면 진짜 시각 중앙이 가능하고, 카드 자체도 2 배 크게 그릴 수 있어 OFFLINE 같은 hero 신호로는 단일 키보다 강함. 홀수 차원은 단일 hero 유지 (true center 가 존재).

**2. ButtonSlot.textOverlay 기본값 .none = 텍스트 미렌더 함정**
`renderButtonPng` 의 텍스트 분기는 `slot.textOverlay` 가 `.none` 이면 title/subtitle 둘 다 무시하고 아이콘만 그림 (line 2544). 직관과 반대 — title 이 비어있지 않으면 그릴 거라 가정하면 망함. status tile 류는 모두 `.infoTile` 명시 필요. Codex stop-time review 가 잡음.

**3. App 강제종료/크래시는 비범위**
graceful teardown (Cmd-Q, SIGTERM 등) 에선 `stop()` 이 호출되므로 OFFLINE 프레임 push 가능. SIGKILL/패닉은 별도 보조 프로세스(LaunchAgent 등) 없인 캐치 불가 — 큰 작업이라 별 이슈로 분리.

---
