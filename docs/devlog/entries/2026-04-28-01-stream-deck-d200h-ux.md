# 2026-04-28 — Stream Deck / D200H 세션 UX 아이콘·배치 수정

### 문제
- D200H 세션 타일이 terrarium creature 가 아니라 provider logo path 를 그려 Codex가 깨진 clover/logo처럼 보임.
- D200H processing dashed/stitch 테두리가 정지 이미지 파이프라인에서 어색하고, 왼쪽 상태선과 작업 테두리가 겹침.
- Stream Deck+ 8키 기준의 detail 레이아웃이 Stream Deck 15키에서 그대로 해석되어 ESC/Back 위치와 pagination 이 물리 버튼 수를 반영하지 못함.

### 해결
- 공용 SVG 세션 렌더러: Claude robot, Codex cloud prompt, OpenClaw crayfish, OpenCode nested square mini creature 로 교체. Processing 상태는 dashed border 대신 solid/pulse ring + RUN badge 로 변경.
- D200H Swift 렌더러: `rendererRev=creature-session-icons-v22`, logo path 렌더링 제거, Codex cloud/Claude robot/OpenCode square를 CoreGraphics로 직접 그림. 상태선은 테두리 안쪽으로 이동해 겹침 제거.
- 플러그인 슬롯 매니저: `DeckLayout(columns, rows, keyCount)` 기반으로 list/detail 슬롯을 계산. SD+는 4×2, Stream Deck은 5×3 프로필을 사용하며 ESC/STOP은 항상 마지막 물리 키에 배치.
- Stream Deck classic용 bundled profile `agentdeck-sd` 추가, SD+는 기존 `agentdeck-sdplus` 유지.

---
