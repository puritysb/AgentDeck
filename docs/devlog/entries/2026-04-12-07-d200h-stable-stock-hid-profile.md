# 2026-04-12 — D200H Stable Stock HID Profile

### 문제
실제 D200H에서 preview/dump와 다른 화면이 표시됨. `13L`이 `13R` 영역까지 늘어나 보이고, 2번 셀에는 현재 렌더가 아닌 이전/다른 재생 아이콘이 보였다. daemon status는 HID write 성공(`writeOK` 증가, `writeFail=0`)이므로 USB 전송 실패보다는 stock firmware의 manifest/resource 해석 및 캐시 문제로 판단.

### 해결
- D200H stock HID 경로를 안정성 우선 프로파일로 고정.
- 모든 아이콘 파일명을 `icons/btnN-<content-hash>.png` 형태로 만들어 펌웨어가 같은 경로의 stale bitmap을 재사용하지 못하게 함.
- 병합 영역은 stock dump와 맞춰 `3_2` 단일 entry만 사용하고 `Action=com.ulanzi.ulanzideck.smallwindow.window`를 유지. `4_2` entry를 제거하고, `3_2` icon 자체를 2칸 폭 wide PNG로 생성.
- 부분 업데이트, press flash, animation frame 전송을 끔. D200H는 Stream Deck 같은 per-key dynamic surface가 아니라 stock 앱의 manifest-driven 화면으로 취급.
- preview dump 스크립트도 manifest의 `ViewParam.Icon`을 읽도록 변경해 hash 기반 파일명과 wide icon을 그대로 확인하게 함.

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataD200HStableHid build CODE_SIGNING_ALLOWED=NO` 성공.
- 실행 중인 daemon status: `d200h.connected=true`, `stableStockHid=true`, `partialUpdatesEnabled=false`, `writeFail=0`.
- 최신 dump `20260412-080432-812-set_buttons-L-50194b-GATEWAY_OPENCLAW__.zip`: hash 기반 icon filename 사용, `3_2`는 `icons/btn13-wide-da0dd945.png`를 참조, `4_2` entry 없음.
- `btn13-wide-da0dd945.png` 크기: 392x196. 일반 버튼 아이콘은 196x196.

### 핵심 설계 결정
공식 앱 없이 HID manifest만 흉내내는 방식은 D200H에서 저수준 화면 제어가 아니다. 안정화 목표는 "현재 상태가 틀리지 않게 보이는 것"이며, Stream Deck 수준의 부분 갱신/프레스 피드백/애니메이션은 이 프로파일에서 제외한다. 이 변경 후에도 실기기 화면이 계속 preview와 다르면 D200H stock HID 지원은 best-effort로 낮추고 Android 내부 앱/프레임버퍼 경로나 다른 하드웨어 연동 방식을 우선 검토한다.

---
