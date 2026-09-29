# 2026-07-11 — 토폴로지 누락(TUI·WiFi ESP32) 복구 · Device Preview 실기 드리프트 3건 수정 · Live 프리뷰/스냅샷 QA 도구

### 문제
1. **macOS Dashboard downstream 누락**: TUI dashboard(`agentdeck dashboard`)는 익명 WS 클라이언트로 붙어 어느 데몬도 식별 불가 → 행 자체가 없음. WiFi WS ESP32는 Node가 `/devices`(`esp32-wifi`)로는 추적하지만 **moduleHealth에 미포함**이라 대시보드(클라)는 볼 수 없고, Swift 데몬은 firmware가 접속 직후 자발 announce하는 `device_info` 프레임을 그냥 버려 추적 자체가 없었다.
2. **Device Preview 실기 불일치**: (a) 2026-07-11 커밋 208b1afc가 SSOT 원본 2곳(`d200h-layout.ts` usage 타일 hide-if-absent, `eink_display.cpp` adaptive usage/grid split)을 바꾸면서 Swift 미러(D200HLayoutModel/InkDeckPreview)를 같은 커밋에서 갱신 안 함. (b) `SessionSlotRenderer.swift`(5-26 포트)는 TS 원본의 7커밋 뒤 — RUNNING teal 궤도대시/PERM amber 브리딩+PERM 필(f9869f9e), idle 전용 ACT 배지 미반영. (c) ESP32 프리뷰 자체 오류: 86Box를 "1.28" round"로 그림(실물=4" 480×480 정사각 ST7701), Round AMOLED 1.6" 표기(실물 1.8"), TTGO에 HUD 바(실물=상단 135×160 테라리움+하단 갈색 0x2A1F14 메트릭 패널, ttgo_state.cpp), IPS10에 aquarium terrarium+HUD(실물=D1 태블릿 레이아웃: 풀폭 top bar+좌 408px office 씬+우 세션카드 팬, office.cpp/hud_bar.cpp).

### 해결
- **TUI presence**: TUI가 접속 시 `client_register {clientType:"tui", devices:[{id:"host#pid",name,kind}]}` 송신. Node `ws-server.ts` roster(`getTuiClients`, id 중복 dedup) + moduleHealth `tuiDashboards` + `/devices` `tui` 타입; Swift `handleClientRegister` case "tui" + close/TTL evict + 동일 emit. macOS TopologyRail "Terminal" 섹션 + MenuBarTopologyList 행.
- **WiFi ESP32**: Node moduleHealth에 `esp32Wifi {board,ip,version,stale,serialActive}` 추가(데이터는 기존 `listWifiEsp32Devices`). Swift 데몬 `handleWifiEsp32DeviceInfo` — WS `device_info` 프레임을 volunteer-roster로 등록, `wifiEsp32HealthSnapshot()`이 serial 연결과 board(+ip) 매칭으로 `serialActive` 계산(Node `isWifiTransportRedundant` 미러). UI는 **단일경로 원칙**: serialActive 보드는 WiFi 행 억제(USB serial 행에 `· WiFi` 태그), WiFi-only 보드만 "Wi-Fi ESP32" 섹션 행.
- **CLI `agentdeck devices`**: `tui` 브랜치 신설 + (메모리에 기록돼 있던 기존 갭) `idotmatrix`/`timebox`의 Swift-데몬 shape(`configuredDeviceCount/deviceName/statusReason`) 브랜치 추가 — 라이브 Swift 데몬 대상 iDotMatrix·Timebox 행 출력 확인.
- **프리뷰 드리프트**: D200HLayoutModel `buildUsageTiles` Claude 5H/7D hide-if-absent 포팅(`D200HUsage` optional화); InkDeckPreview adaptive usage 밴드(0/1/2 provider rows, 0이면 separator 생략·그리드 확장); SessionSlotRenderer RUNNING/PERM 시각 분리 + 왼쪽 스트립 제거 + idle 전용 ACT + 워터마크 위치/불투명도 TS 파리티.
- **ESP32 프리뷰 재작성**: 86Box 정사각 4", AMOLED 1.8" 표기, TTGO 테라리움+메트릭 패널 분할(HUD 미사용 — `hudHeight<=0`이면 HUD 미생성 가드 포함), IPS10 top bar+office(카펫/데스크 팟/상태 버블/legend chip)+세션 카드 팬 재구성. 카탈로그 displayName/byline도 hardware-compatibility SSOT와 일치화.
- **QA 도구 2종(에뮬레이터화 1단계)**: ① Device Preview 툴바 **Live 토글** — `DevicePreviewScreen.liveSelectionInputs`가 데몬 aggregate state(agent/state/alive 세션 수 {0,1,2,4} 클램프, awaiting 우선)를 프리뷰 입력으로 매핑해 실기 없이 "지금 기기가 그리고 있을 화면"을 미러. ② `DevicePreviewSnapshotTests` — `TEST_RUNNER_AGENTDECK_PREVIEW_SNAPSHOTS=1`로 실행하면 컨테이너 tmp(`…/Data/tmp/agentdeck-previews`)에 프리뷰별 PNG 14종을 렌더(ImageRenderer). 프리뷰/포트 수정 후 눈검증·펌웨어 배포 전 화면 QA용.
- 드라이브바이: `DaemonServer.swift` gateway `select_option` 경로의 state machine 트리거 오타 `"user_sㅈelection"` 수정.

### 핵심 설계 결정
- **presence는 volunteer-roster 단일 패턴**: streamdeck-plugin/eink-device/android-dashboard와 동일하게 "등록은 클라가 자발, 소멸은 WS close + TTL". TUI·WiFi ESP32 모두 이 패턴에 편입 — 데몬이 클라이언트를 능동 스캔하지 않는다(App Store 안전).
- **WiFi ESP32 행도 단일경로 dedup을 따른다**: 물리 1대=행 1개. dual-home 보드는 serial 행이 대표하고 WiFi는 태그로만 표현 — `agentdeck devices`의 `[serial-active · wifi standby]`와 같은 원칙.
- **에뮬레이터화는 3단계 로드맵**: (1) Live 미러+스냅샷(이번에 구현, 프리뷰 입력 모델이 coarse해 근사) → (2) 프리뷰 입력을 실제 WS 이벤트 스트림(sessions_list/usage_update)으로 확장해 세션별 충실 재현 → (3) 픽셀 정확 ESP32는 LVGL 호스트 시뮬레이터(pio native env)로 실펌웨어 렌더 코드를 직접 구동. Swift 손포트는 (3) 전까지의 근사이며 SSOT PORT 헤더+동커밋 규율이 유일한 드리프트 방어.

### 후속(같은 날, 병렬 탐색 에이전트 감사 리포트 반영)
- **Node 티어 Stream Deck 행 부재(신규 갭)**: SD 플러그인이 보내는 `client_register {clientType:"streamdeck-plugin"}`을 Node 데몬이 버리고 있었음(Swift 데몬만 처리) → volunteer-roster(`streamDeckRegistrations`) + moduleHealth `streamDeck` emit 추가. 외부 CLI 데몬 사용자도 이제 Stream Deck 행을 봄.
- **메뉴바 리스트 파리티**: TopologyRail에는 있고 메뉴바에는 없던 Timebox/iDotMatrix/androidDashboards 행 추가(BLE statusReason 매핑 미러 포함).
- **D200H 타일 충실도**: 세션 타일에 `slot.subtitle`(모델 별칭/"Running task") 렌더 추가(실 renderSessionSlot 3행 파리티), usage 타일을 가로 캡슐+"CLAUDE 5H" 텍스트 접두어에서 실기와 같은 **세로 물탱크**(bottom-up fill 0.38+level line, 브랜드 마크 우상단, 텍스트 접두어 없음, usageRampColor >80 red/>50 amber 포팅)로 교체, OFFLINE hero에 "Open AgentDeck" 서브타이틀.
- **InkDeck**: 카드 상태 라벨을 펌웨어 `stateLabel()` 문자열(PROCESSING/PERMISSION/IDLE/OFFLINE — "AWAITING"은 실기에 없음)로, 빈 상태를 2종 구분(disconnected="searching for daemon…" vs connected-empty="no active sessions"+워크스페이스 힌트).
- **ESP32 공유 씬**: 세션당 크리처 1마리(기존: 항상 1마리), HUD 우측을 실 hud_bar `makeTankGroup` 구조(브랜드 컬러 "● CLAUDE" 헤더 + 5h/7d 탱크, Codex 세션 존재 시 "● CODEX" 그룹)로, 좌측을 세션 리스트(상태 dot·프로젝트, 최대 3줄)로. IPS 3.5" 종횡비 480×320(1.5)로 교정.
- 미해결(낮은 우선순위, 의도적 보류): InkDeck idle-dock "+N more"/게이지 reset countdown/AGY 칩, TC001 USAGE 페이지·antigravity 스프라이트(프리뷰 입력 모델에 antigravity 없음), iPad/Android/e-ink(CremaS·Pantone6) 프리뷰는 명시적 schematic(포트 아님).

### 검증
vitest 전체 1693 pass(신규: ws-server TUI roster 2건), macOS `ProtocolTests` 34 pass(신규: tuiDashboards/esp32Wifi/serial.wifiConnected 디코드), `DevicePreviewSnapshotTests` live 매핑 pass + 스냅샷 14종 눈검증(IPS10 office/카드, TTGO 메트릭 패널, SD+ RUN teal/PERM amber, InkDeck codex-only 밴드, D200H 세로 탱크+서브타이틀, IPS3.5 브랜드 탱크 그룹), macOS/iOS 양 타깃 빌드 성공. 라이브 Swift 데몬 대상 CLI devices 출력 확인(구데몬은 신규 clientType 무시 — 하위호환).

---
