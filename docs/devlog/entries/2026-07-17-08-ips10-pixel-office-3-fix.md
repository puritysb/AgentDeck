# 2026-07-17 — IPS10 "pixel office" 진입 실패 + 카드 무의미 텍스트: 라우팅·바이트캡·소스 3중 fix

### 문제
사용자 리포트 2건: (1) 진행 중인 실제 세션의 크리처가 프로젝트 huddle 영역 안으로 못 들어옴, (2) 오른쪽 카드 영역 텍스트가 TIMELINE처럼 정확하지 않고 일부가 깨져 보이며 결과적으로 의미 없는 정보만 나옴.

### 해결 — 1라운드 (`93d579f5`)
- **진입 실패**: 원인 2겹. ① 테이블이 좌석 행의 3/5만 덮어 아랫줄 착석 크리처가 "영역 밖"으로 보임 → 좌석 전체를 덮는 zone rug 추가. ② 기존 greedy 2-move 이동이 통로를 막은 착석 동료를 우회 못 해 늦게 온 크리처가 huddle 앞에서 영구 교착 → 그리드 BFS 라우팅으로 교체.
- **텍스트 깨짐**: ESP32 버퍼는 바이트 크기(`raw[120]` 등)인데 데몬 캡은 문자 수 기준(Node UTF-16 slice, Swift grapheme prefix) — 한글 39자=117바이트로 `projectName[40]` 초과해 보드 strncpy가 글자 중간을 잘랐다. Node `limitString`/Swift `limitUtf8Bytes`를 UTF-8 바이트 예산+코드포인트 경계 절단으로 수정, 펌웨어에 `esp32/src/util/utf8.h`(C++11-safe SSOT) 방어 트림 추가. 구분자 `·`(U+00B7)가 LVGL 폰트(montserrat+Noto KR 한글전용 폴백) 어디에도 없어 tofu box로 렌더되던 것도 `LV_SYMBOL_BULLET`로 교체.
- sim(`esp32/sim`)에 실기와 동일한 Noto KR 폰트를 번들해 한글 렌더가 tofu인지 진짜 깨짐인지 구분 가능하게 함.

### 해결 — 2라운드 (`a1d59de8`)
1라운드 후에도 카드가 무의미했던 진짜 원인: 카드 body가 **보드 자체의 timeline ring**(64행, 재부팅마다 빈값, 시리얼 접속 시 history 미시드)에서 조합됐다. TIMELINE 뷰가 의미 있는 건 데몬이 전체 스토어를 갖고 있기 때문 — 같은 소스로 옮겼다.
- `sessions_list`의 각 세션에 데몬이 계산한 `lastEventText`(최신 마일스톤)/`lastEventTask`(소속 태스크 라벨)/`lastEventHm`(호스트 로컬 시각)를 추가. Swift는 `broadcastRaw` chokepoint에서 캐시 갱신 + 시작 시 스토어에서 시드, Node는 `bridgeTimeline` 히스토리를 브로드캐스트 시점에 스캔. ESP32 전송 시 바이트 캡(99/39/5), 없으면 필드 자체 생략.
- Swift 시리얼 initial set에 최신 6개 timeline 시드 추가(Node parity), WS 접속 burst도 식별된 보드에 축소 history 전송(전엔 스킵).
- 펌웨어 카드 body 우선순위: awaiting 질문 → 데몬 lastEvent(`HH:MM 태스크 · 텍스트`) → 보드 ring 마일스톤(폴백, HH:MM 프리픽스 추가) → activity. tool-row("Bash") 폴백 제거, idle 카드도 마지막 마일스톤 유지(InkDeck parity).

### 검증
- `esp32/sim`에 한글 포함 crowd 씬(같은 프로젝트 다중 세션) 추가해 두 문제 모두 시각 재현/확인.
- vitest 전체 통과, Swift `ESP32WifiForwardTests`에 UTF-8 캡·lastEvent 필드 테스트 추가 후 통과, ips10/inkdeck/rgb48(C++11) 펌웨어 빌드 통과.
- ips10 USB 플래시 + Swift 데몬 재기동 후 가짜 보드로 라이브 프레임 캡처 — `lastEventText`에 직전 응답 텍스트가 실제로 실려오는 것 확인.

### 부수 이슈: 플래시 반복 실패는 데몬 재스폰 경합
앱 quit/데몬 kill 후에도 다른 브릿지가 Node 데몬(`cli.js daemon`)을 재스폰 → 플래시 도중 그 프로세스의 시리얼 폴러가 포트를 열며 DTR/RTS 토글로 칩 리셋 → "serial noise" 로 보이는 반복 실패, 한 번은 앱 파티션이 깨져 부트루프까지 감. `cli.js`를 일시 리네임해 재스폰을 차단하고 esptool 스텁+460800으로 직접 플래시하면 33초에 해결. `~/.platformio/penv`가 Intel(x86_64) Python으로 오염돼 있던 것도 재생성으로 함께 정리(littlefs import arm64 불일치로 모든 pioarduino 빌드가 깨져 있었음).
