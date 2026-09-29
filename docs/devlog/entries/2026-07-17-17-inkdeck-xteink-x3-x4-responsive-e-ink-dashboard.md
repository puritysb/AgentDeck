# 2026-07-17 (심야) — InkDeck/XTeink X3·X4 공통 responsive e-ink dashboard

### 문제
- InkDeck은 800×480 좌표와 2/3열 분기를 `eink_display.cpp` 안에 직접 갖고, 외부 CrossPoint 포크의 X3/X4는 별도 세로 list UI를 구현했다. 같은 ESP32 e-ink dashboard인데도 geometry·카드 우선순위·상태 표현이 갈라져 X3 528×792, X4/InkDeck 800×480 같은 해상도/방향 차이를 새 magic number로 대응해야 했다.
- XTeink 쪽 UI는 세션 glyph/상태/활동을 행으로만 표시해 넓은 X4 화면을 활용하지 못했고, 선택·attention 계층도 InkDeck 카드와 달랐다. 반대로 두 프로젝트는 GxEPD2와 GfxRenderer, 폰트/버튼/refresh lifecycle이 달라 렌더러 전체를 억지로 합칠 수는 없었다.

### 해결
- `esp32/src/ui/eink/eink_dashboard_layout.h`를 allocation-free geometry SSOT로 추가했다. 입력은 패널 크기·헤더/컨트롤 높이·usage/activity 행·세션 수뿐이며, 출력은 header/cards/usage/activity/controls Rect와 density, 1/2/3열·가독 가능한 행/용량이다. 가로 800px는 2열(5세션부터 3열), X3 portrait는 1열 paged stack으로 자동 결정하며 힙/`std::vector`/`String`이 없다.
- InkDeck `eink_display.cpp`의 고정 grid/footer/empty/searching 좌표를 공통 Layout 소비로 바꿨다. GxEPD2 draw, FreeFont/U8g2, content-hash 및 partial/full refresh 정책은 그대로 유지했다.
- `crosspoint-agentdeck`의 `AgentDashboardActivity` Overview를 같은 geometry를 쓰는 paper-card 컴포넌트로 교체했다. glyph+project+activity+state chip, attention 우선, 선택 double outline/rail, capacity 기반 page를 적용했고 Detail timeline/승인 버튼/CJK font/물리 버튼 동작은 유지했다. 회색 fill 없이 1-bit 선·solid chip만 사용한다.
- 별도 저장소 경계를 명시적으로 관리하도록 `scripts/sync-xteink-eink-dashboard.sh`와 `--check` drift gate를 추가했다. 정본을 포크 `src/agentdeck/eink_dashboard_layout.h`로 byte-identical 미러한다.

### 검증
- `scripts/test-eink-dashboard-layout.sh`가 InkDeck 800×480, X3 528×792, X4 800×480 geometry invariants를 C++11 `-Wall -Wextra -Werror`로 통과했다.
- InkDeck host simulator `multi` scene을 실제 firmware renderer로 800×480 PNG 렌더하고 헤더·2×2 카드·2행 usage band를 시각 확인했다.
- simulator가 한 프로세스에서 장면을 연속 렌더할 때 `init()`의 searching frame 뒤 이전 장면 hash가 남아 `display-off`가 searching 화면으로 저장되던 harness 상태 누수도 수정했다. init 후 hash/ticker cache를 무효화해 `idle`/`display-off` PNG byte-identical 불변을 복원했다.
- CrossPoint 포크 전체 `default` ESP32-C3 build 성공(arm64 `~/.platformio/penv/bin/pio`; RAM 113,908B/34.8%, Flash 5,327,641B/81.3%). 공통 모듈은 정적/스택 값 타입뿐이라 새 heap allocation이 없다.

### 실기 배포
- InkDeck는 WiFi OTA가 chunk 659 timeout으로 중단되어 기존 슬롯을 유지한 것을 확인한 뒤, `device_info`로 식별한 USB 장치의 재열거된 bootloader 포트(`/dev/cu.usbmodem3111101`)에 ARM64 PlatformIO로 full flash했다. bootloader/partition/app 기록 100%와 각 SHA 검증을 통과했고, daemon 재기동 후 새 빌드 `e596f7ed-dirty`가 원래 포트(`/dev/cu.usbmodem1CDBD474F4D81`)에서 재접속했다.
- XTeink 공통 `firmware/update.bin`(5,340,928B, SHA-256 `1dcb0874bf52d4366b9d776615b04a641655f62f063cecc10aa933a2ccf07305`)은 준비했으나, X3/X4는 `sd-update-bin` 전용이고 작업 시점에 외장 SD 카드가 마운트되지 않았다. X4는 잠시 `192.168.68.73`으로 감지된 뒤 절전/오프라인이 되었고 X3는 미검출이라 실기 설치는 SD 카드 연결과 기기 복구 화면 확인이 필요하다.

### X3/X4 실기 피드백 후속
- X3/X4 설치 후 카드에 세 줄 공간이 있어도 활동이 한 줄로 잘리고, Detail을 열면 조회 응답이 다른 세션의 16행 링에 밀려 `No recent activity yet…`로 남을 수 있음을 확인했다. XTeink 세션 요약을 고정 192B로 확장하고 daemon의 짧은 `activity/currentTask`와 긴 `goal`을 고정 버퍼 안에서 합성했다. 카드에는 힙 할당 없는 UTF-8 2–3줄 래퍼를 적용하고, Detail 상단에도 `Current work` 요약을 최대 3줄로 항상 표시한다.
- `query_session_timeline` 응답의 top-level `sessionId`가 있으면 혼합 live ring을 해당 세션 history로 교체하고 `timelineRevision`을 올린다. 같은 개수의 이력이 들어와도 e-ink 재렌더가 보장되며, 실제 이력이 없는 경우도 빈 문구만 보이지 않고 현재 작업 요약과 상세 이벤트 대기 안내가 함께 나온다.
- Codex가 7D window만 제공하면 비어 있던 5H cell에 `SUB <plan> <active-until>`을 배치하고 별도 구독 행을 생략한다. 사용량 footer 높이를 한 행 절약해 카드 영역도 유지한다.
- CrossPoint ESP32-C3 전체 build 성공(RAM 115,028B/35.1%, Flash 5,329,557B/81.3%). 새 `firmware/update.bin`은 5,342,848B, SHA-256 `a21533a39fa5a997321f0648218da29573d5c326ee1b927a1f0d29ad5e40d17c`이며 X3/X4 공용이다.

### X3/X4 Attention 실제 선택지·명령 라우팅 정합성 후속
- `creature-positions`는 `controlMode:observed`, `port:0`, `requestId/options 없음`인 Claude 관찰 세션이었다. 실제 터미널에는 세 선택지가 있었지만 Notification/PreToolUse 관찰 이벤트는 그 목록을 내보내지 않았고, X3/X4는 `awaiting_*`만 보고 임의의 Approve/Deny를 만들었다. Approve의 session-scoped `select_option(0)`은 managed registry에서 관찰 세션을 찾지 못했고, Deny의 `escape`는 현재 prompt 응답이 아니라 다음 tool을 막는 soft STOP으로 지연 적용될 수 있었다.
- XTeink 포트에 allocation-free `AttentionMode` 계약을 추가했다. `requestId`가 있는 실제 device gate만 Allow/Deny, 세션 ID가 상관된 실제 options만 option row가 되며, 관찰 세션에 둘 다 없으면 Select 힌트를 숨기고 `Respond in the agent terminal`을 표시한다. 가짜 `Approve → select_option(0)`과 `Deny → escape` fallback은 제거했다.
- managed Detail을 열 때 `focus_session`을 먼저 보내고 `prompt_options`도 파싱한다. options snapshot에는 owner session ID를 저장해 이전 focus/다른 세션의 선택지가 섞이지 않게 했으며, navigable은 wire index의 `select_option`, non-navigable은 option shortcut의 `respond`를 사용한다. 전송 후에는 daemon 상태 전환을 받을 때까지 Detail을 유지한다.
- 순수 계약 테스트 6개가 observed terminal-only, requestId gate, managed correlation 대기, 3-option actionability를 통과했다. CrossPoint default ESP32-C3 build도 성공(RAM 115,220B/35.2%, DRAM static 181,941B/56.63%, Flash 5,331,365B/81.4%)했고 `firmware/update.bin` 5,344,656B(SHA-256 `bd7104dfd3c7366a403600ab224e37a85d6b9795433f8630b26749ebbb8750bc`)를 생성했다. 새 경로는 고정 버퍼만 사용하고 render/protocol loop에 새 동적 할당을 추가하지 않았다.
- 같은 `update.bin`을 X4(`192.168.68.73`)와 X3(`192.168.68.74`)의 File Transfer 저장소에 업로드하고 두 기기 모두 `/api/files`에서 5,344,656B를 확인했다. X3는 기본 4KB WebSocket 프레임이 0.6~3.1MB 구간에서 반복 단절됐지만, 재부팅 후 **1KB 프레임을 64KB 응답마다 멈추지 않고 연속 전송**하자 5,344,656B와 서버 `DONE`까지 완료됐다. 두 기기의 실제 펌웨어 교체는 복구 메뉴에서 `update.bin`을 선택하는 물리 단계가 남아 있다.
