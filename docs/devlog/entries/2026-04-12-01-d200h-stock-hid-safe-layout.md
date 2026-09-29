# 2026-04-12 — D200H Stock-HID Safe Layout

### 문제
D200H를 Stream Deck처럼 per-key 동적 화면으로 다루면 아이콘 캐시, partial update, 펌웨어 manifest 해석 차이 때문에 실제 기기에서 2번 셀에 엉뚱한 아이콘이 남거나 13L/13R 병합 영역이 왜곡되어 보였다. 특히 병합 영역을 두 개의 일반 버튼처럼 제어하면 stock firmware의 `smallwindow` 처리와 충돌해 한 버튼 크기 이미지가 가로로 늘어난 형태가 발생할 수 있었다.

### 해결
- D200H는 stock HID 안정 경로로 고정: partial update, press flash, animation을 비활성화하고 전체 `set_buttons` 패킷만 사용
- 아이콘 파일명에 content hash를 포함해 기기/펌웨어 쪽 stale bitmap cache 충돌을 회피
- 13L/13R 병합 영역은 `3_2`의 `com.ulanzi.ulanzideck.smallwindow.window` manifest entry 하나만 사용하고, `4_2` entry는 만들지 않음
- 병합 영역 이미지는 버튼 한 개 PNG를 늘리지 않고 `392x196` wide PNG로 직접 렌더링
- 실제 버튼 가장자리/마스크에서 텍스트가 잘리지 않도록 D200H 렌더러의 safe inset을 키우고 텍스트/상태 표시를 안쪽으로 이동
- `tools/creature-simulator/index.html`의 D200H 미리보기도 Stream Deck 복제가 아니라 동일 UX 의미를 유지하는 D200H-native stock-HID-safe 디자인으로 분리
- `stock-safe-v2` renderer revision을 D200H state hash에 포함해 렌더러만 바뀐 경우에도 다음 빌드/refresh에서 새 payload가 확실히 전송되도록 함
- Stream Deck session/detail button의 agent watermark opacity를 올리고 simulator의 Stream Deck/D200H 미리보기를 같은 방향으로 조정

### 핵심 설계 결정
- **UX 의미는 Stream Deck과 맞추되, 시각 디자인은 D200H 전용으로 둔다.** D200H는 Stream Deck SDK/화면 모델이 아니라 stock firmware manifest와 HID zip 패킷의 제약을 받으므로 pixel-perfect Stream Deck 복제보다 기기 안정성이 우선이다.
- **병합 영역은 펌웨어가 기대하는 한 개 smallwindow로 취급한다.** 두 셀을 개별 아이콘처럼 관리하면 실제 표시 좌표/스케일이 불안정해진다.
- **D200H 아이콘은 물리 버튼 테두리를 신뢰하지 않는다.** 실제 표시 영역 가장자리가 살짝 묻히므로 텍스트와 상태 표시는 충분한 내부 여백 안에 배치한다.

### 검증
- `swiftc -parse apple/AgentDeck/Daemon/Modules/D200hHidModule.swift` - 성공
- `node --check scripts/render-creature-simulator.mjs` - 성공
- `git diff --check -- apple/AgentDeck/Daemon/Modules/D200hHidModule.swift tools/creature-simulator/index.html` - 성공
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' build` - signed debug build 성공
- Runtime `/status`: `stableStockHid=true`, `partialUpdatesEnabled=false`, `usbEntitlementPresent=true`, `managerOpened=true`, `connected=true`, `writeFail=0`
- Runtime `/d200h/refresh`: `writeOK` 114 → 156, `writeFail=0`
- 최신 D200H dump manifest: `3_2` smallwindow entry만 존재하고 `4_2` 없음. wide icon은 `392x196`
- `stock-safe-v2` signed debug relaunch 후 Runtime `/status`: `rendererRev=stock-safe-v2`, `stableStockHid=true`, `usbEntitlementPresent=true`, `managerOpened=true`, `writeFail=0`
- 같은 relaunch에서 port 9120을 별도 `agentdeck claude` session이 점유해 macOS daemon이 9121로 fallback. 이 상태에서는 D200H module은 정상 write하지만 `sessionsCount=0`이라 세션 타일 대신 usage/empty 슬롯 payload가 전송됨
