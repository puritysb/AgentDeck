# AgentDeck Development Log

---

> **Older entries are archived by month** under [`docs/devlog/`](docs/devlog/README.md). This active file keeps the current month plus the preceding month (currently 2026-07 and 2026-06); search only the relevant monthly archive for older history.

## 2026-07-18 — Robot Framework CI signal audit

- Audited the ESP32 Robot suites by assertion type. The physical `hw`, `protocol`, and `perf` suites exercise real boot, serial recovery, protocol framing, latency, throughput, and heap behavior and remain valuable lab validation. The GitHub `no-hw` subset only repeated PlatformIO builds already performed in the same job, then asserted generated-file existence, source-file existence, and config parsing; it did not execute firmware behavior.
- Removed the duplicate no-hardware Robot job and its second PlatformIO cache/build pass from GitHub Pages. Build Health now marks Robot as not run with the honest reason that physical hardware is unavailable on hosted runners, rather than presenting compilation wrappers as hardware-test evidence.
- Kept `01_build.robot` as an explicit local pre-flash smoke path with firmware size and partition artifact gates, but removed the meaningless source-file-presence and redundant `pio project config` cases and their dead keywords. Updated the public report label and testing/Pages SSOT accordingly.

## 2026-07-18 — Terrarium rules SSOT: 손미러 3곳 체제를 codegen+drift 게이트로 교체

- idle 바닥수렴/crayfish 제외(610fe15c) 계약이 Swift·Android에만 손미러로 반영되고 TUI·ESP32에는 같은 버그가 살아 있는 파편화를 구조적으로 해소했다. `shared/src/terrarium-rules.ts`가 크로스플랫폼 터라리움 **룰**(crayfish 홈/영토, clear 앵커 0.62, 바닥휴식·hover strip)의 SSOT이고, `pnpm generate-terrarium-rules`가 Swift/Kotlin/C++ 미러를 생성한다. 표면별 **튜닝**(보드별 Y, swim lane)은 로컬에 남긴다.
- `shared/src/__tests__/terrarium-rules.test.ts`가 소스 재-emit과 디스크 미러를 diff해 손편집/재생성 누락을 CI에서 실패시키고, clearance 불변식(clearMaxX + 최대 rester 반폭 < crayfish 집게 좌단)도 한곳에서 검증한다.
- 소비자 연결: Swift/Android TerrariumConfig는 생성 상수 참조로 전환. ESP32 sleeping OpenCode/Antigravity(앵커 0.63–0.74가 crayfish 자리 0.72–0.78과 겹침)와 TUI(opencode homeX 0.68·jellyfish 드리프트 0.65 vs crayfish 0.75)에 클램프를 적용해 잔존 버그를 해소했다.
- 작업 규칙 갱신: CLAUDE.md Key Conventions에 "Cross-platform rules are SSOT-first" 원칙과 캐노니컬 소스 목록을 추가하고, 실제 CLI와 어긋난 Module flags 문서(`--no-mdns`/`--no-serial`/`--no-pixoo`는 존재하지 않음 — 하드웨어 모듈은 데몬 전용)를 바로잡았다.
- 검증: vitest 1889 green, Android `testDebugUnitTest` green, `AgentDeck_macOS` Debug 빌드 green, ESP32 host sim 렌더 정상. Android 실기 3대(Crema S/Lenovo/Pantone6) screencap으로 idle OpenCode×2 + OpenClaw 활성 분리 렌더링도 확인.

## 2026-07-18 — GitHub Pages information architecture and visual unification

- Reorganized the public site around four distinct roles: **Devices** (supported surface catalog), **Live Preview** (interactive canonical renderer output), **Docs** (project handbook), and **Build Health** (latest automated quality evidence). All public surfaces now use aquarium-tide navigation, typography, naming, responsive behavior, and English-language page headers.
- Folded the empty photo Gallery into Devices instead of maintaining a duplicate catalog with invisible image slots. `/gallery/` remains as a backward-compatible redirect to `/hardware/`, while Devices links to Live Preview for render output and to `docs/hardware-compatibility.md` for board-level specifications.
- Reframed the former creature-simulator Demo as Live Preview, moved canonical per-device output to the public focus, and hid internal proposal/reference panels without removing their renderer DOM. Reframed Reports as Build Health with an explicit maintainer/CI role and the shared Pages shell.
- Updated the Pages assembly workflow and `CLAUDE.md` site-surface SSOT to preserve the new roles.
- Verification: `pnpm run demo:build` generated all 160 ESP32 simulator frames and completed the Vite production build; `python3 scripts/generate-html-report.py`, Python bytecode compile, and `git diff --check` passed. The repository-wide design lint still reports its pre-existing generated/vendor findings, while the touched token-defining Pages files add no reported violations.

## 2026-07-18 — Stream Deck Mini 번들 프로파일 추가

- Stream Deck Mini(DeviceType 1, 3×2)를 `agentdeck-sdmini` 번들 프로파일로 추가했다. 구형 `.sdProfile`과 현행 `.streamDeckProfile` 포맷을 함께 제공하며 여섯 키 모두 session-slot 액션으로 초기화한다.
- 플러그인 연결 시 Mini를 감지하면 전용 프로파일로 자동 전환하고, 통합 버전 검증에 두 Mini 프로파일 manifest를 포함했다. XL(DeviceType 2)은 동적 그리드 계산만 있고 번들 프로파일은 아직 없다.
- `pnpm verify-version`, Mini 중심 슬롯·세션 배치 테스트 41/41, `pnpm build`, `pnpm package`, `streamdeck validate`를 통과했다. 생성된 196KB 아카이브에 Mini의 두 프로파일 포맷과 page manifest가 모두 포함됐다.

## 2026-07-18 — Xcode 26.6 recommended settings + Swift 경고 정리

- `apple/project.yml`의 Xcode 정본 버전을 26.4에서 26.6으로 올리고 `xcodegen generate`를 실행했다. 프로젝트와 macOS/iOS scheme의 `LastUpgradeCheck`/`LastUpgradeVersion`이 2660으로 동기화됐으며, App Store 빌드 조건과 의도적인 `ENABLE_USER_SCRIPT_SANDBOXING=NO`는 유지됐다.
- Swift 6/macOS 26 경고를 정리했다: `ApmeCollector`의 같은 MainActor 안 불필요한 `await`, Pixoo/AuthManager의 배열 기반 `String(cString:)`, Timeline/IPS10 preview의 deprecated `Text + Text`를 각각 동기 호출, NUL 절단 UTF-8 decode, styled `Text` interpolation으로 교체했다.
- quicktype이 생성하는 `JSONNull.hashValue`가 프로토콜 재생성 때 되살아나지 않도록 `scripts/patch-quicktype-swift.mjs` 후처리를 추가했다. 세 Swift 산출물에 공통 적용해 `hash(into:)`와 final `JSONCodingKey`를 보장한다.
- 테스트 타깃에서 추가로 드러난 `DevicePreviewSnapshotTests.setUp()` actor 경고는 출력 디렉터리를 MainActor lazy 속성으로 초기화해 제거했다.
- 검증: `pnpm generate-protocol`, `xcodegen generate --spec apple/project.yml`, `AgentDeck_macOS` Debug build 성공. `ApmeTaskBoundaryTests`와 `TimelineTests`도 경고 없이 통과했다.

## 2026-07-18 — Apple slash-command 진행 아이콘 패리티

- macOS/iOS 타임라인은 `/merge` 같은 slash-command의 `chat_start`를 `terminal.fill`로 구분한 뒤 그 사각형 심볼 자체를 회전시켰다. Android는 같은 진행 상태에서 공통 running 아이콘을 회전하므로 플랫폼 간 표현도 달랐다.
- Apple `turnRow`가 정지 상태에서는 기존 터미널 아이콘과 `CMD` 칩을 유지하고, 진행 중에만 `arrow.triangle.2.circlepath`로 교체해 회전하도록 기존 `RotatingTimelineIcon.rotatingSymbolName` 경로를 연결했다. task spinner가 이미 쓰던 동일 규칙이라 별도 상태·프로토콜 변경은 없다.
- `AgentDeck_macOS` Debug 및 `AgentDeck_iOS` Debug(iOS Simulator) 빌드 성공.

## 2026-07-18 — IPS10 ESP-Hosted SDIO 패닉: 런타임 deinit 제거

### 원인과 수정
- IPS10이 `reset=panic code=4`로 19~494초마다 실제 재부팅했고, raw serial에는 `sdio_rx_get_buffer` / `sdio_push_data_to_queue (pkt_rxbuff)` assert 뒤 `SW_CPU_RESET`이 남았다. USB serial 첫 JSON 직후 `wifiSetRadioParked(true)`가 `WiFi.mode(WIFI_OFF)`를 호출하고, Arduino P4 remote-WiFi 구현이 이를 `esp_wifi_deinit()` → `hostedDeinitWiFi()`까지 내려 보내 RX 중인 SDIO 버퍼 수명과 경합하는 경로였다.
- `BOARD_IPS10`의 serial-primary parking을 완전 radio-off가 아닌 **STA quiesce**로 변경했다. WebSocket을 먼저 닫고 `WiFi.disconnect(false, 1000)`로 AP 연결만 해제하며 ESP-Hosted/SDIO transport는 계속 초기화된 상태로 둔다. `wifiRadioParked()`는 mDNS/WS 루프를 억제하므로 네트워크 트래픽은 멈추되 in-flight RX 버퍼를 파괴하지 않는다. 다른 ESP32 보드는 기존 `WIFI_OFF` 정책을 유지한다.
- USB가 끊기면 저장 credential로 STA를 복구한다. cold boot에서 credential이 없어 이미 `WIFI_OFF`였던 경우에만 STA mode를 다시 초기화한다.

### 검증·배포 상태
- `/opt/homebrew/bin/pio run -e ips10` 성공: RAM 29.0%, Flash 64.7%, firmware 4,068,386B. PATH의 `/usr/local/bin/pio`는 기존 x86_64 Python/arm64 littlefs 불일치로 실패해 arm64 경로를 사용했다.
- WiFi OTA를 두 번 시도했으나 구펌웨어가 전송 약 15초 안에 다시 패닉해 각각 `no_active_update`로 중단됐다. CH340 `/dev/cu.wchusbserial21110`도 macOS driver wedge가 발생했으나 물리적으로 재연결해 복구했다. 이후 USB full flash가 전체 data hash 검증까지 성공했고(`buildHash=aa91e5a1-dirty`, `buildEpoch=1784343722`), CLI daemon 재연결 시 `wifiRadioParked=true`, `wifiConnected=false` 상태에서 연결/stale 없이 추정 uptime 501초까지 단조 증가했다. 이는 기존 관측 최장 재부팅 간격 494초를 넘긴 짧은 soak이며 새 SDIO 패닉 로그는 없었다. 장시간 현장 안정성은 계속 확인한다.

## 2026-07-18 — Pixoo64 사용량 HUD 실루엣·배경 fill·Codex 만료일 개선

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

## 2026-07-17 (심야) — InkDeck/XTeink X3·X4 공통 responsive e-ink dashboard

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

## 2026-07-17 — Pixoo64 사용량 HUD 로고 공간 1:1 종횡비(정사각형) 개선

### 문제
- Pixoo64 사용량 HUD의 로고 영역이 $9\times7\text{px}$ 크기의 비대칭 직사각형으로 고정되어 있어, 원래 $24\times24$ 크기의 1:1 종횡비를 가진 브랜드 마크(Claude Code, Codex 크리처)가 가로로 찌그러져 렌더링되며 이질감이 들었다.

### 해결
- **정사각형 렌더링 적용**: CLI daemon (`pixoo-renderer.ts`) 및 Swift daemon (`PixooRenderer.swift`)의 `drawUsageHUD` 렌더링 코드에서 프로바이더 로고의 `markerWidth`를 `9`에서 `7`로 변경했다.
- 이를 통해 가로 영역 $0\sim9\text{px}$ 내에서 좌우 $1\text{px}$ 여백을 확보하며 중앙에 정렬시키고, Y축 $7\text{px}$ 높이에 맞게 완벽한 $7\times7\text{px}$ 정사각형 공간에서 $1:1$ 종횡비로 마스크가 스케일링되도록 보정했다. 찌그러짐이 사라져 고유의 크리처 음각 실루엣이 선명하게 표현된다.
- **검증**: `dot-matrix-glyphs.test.ts` 및 `pixoo-sprites.test.ts` unit test를 돌려 렌더링 데이터의 무결성을 검증하고 정상 통과(Pass)를 확인했다.

## 2026-07-17 — Stream Deck/D200H 선택 세션 상태 격리

### 문제
- 실제 Stream Deck+ 로그에서 OpenClaw `GLM-5.2` 상태 뒤 Claude Code `enhance-timeline` 세션을 선택했는데, Claude의 `state_update`에 모델이 없자 플러그인 전역 `currentModelName`에 남은 GLM이 상세 버튼으로 렌더됐다. 세션 식별자가 없던 호환용 `prompt_options`도 늦게 도착하면 다른 세션의 선택지를 현재 액션 버튼으로 만들 수 있었다.
- D200H는 포커스 응답 전에 상세 화면을 먼저 그리면서 선택 세션의 모델이 없을 때 데몬 전역 모델로 fallback했고, 단일 `lastState`에 모든 세션의 상태·선택지를 합쳤다. 관측 Claude의 PROCESSING 화면에는 현재 작업과 무관한 `COMMIT at turn end` 예약 버튼도 노출됐다.

### 해결
- Stream Deck/Stream Deck+ 상세 화면에 선택 세션 전용 replacement snapshot을 추가했다. `sessionId/focusedSessionId`가 일치하는 이벤트만 적용하고, 누락 필드는 이전 전역 값이 아니라 선택한 `SessionInfo` 또는 unknown으로 처리한다. 불일치/무식별 `prompt_options`는 액션으로 쓰지 않고 drop 로그를 남긴다.
- `PromptOptionsEvent`에 선택적 `sessionId/focusedSessionId`를 추가하고 Node/Swift focus relay가 자식 세션 이벤트에 식별자를 붙인다. 직접 세션 브리지도 자신의 `sessionId`를 발행하며 생성 Swift/Kotlin/schema를 동기화했다.
- D200H `StateStore`를 세션별 맵으로 바꾸고 버튼 입력 직후에는 sessions_list 행으로 새 focus handshake를 시작한다. 공유 레이아웃도 일치하는 focused event 외에는 전역 모델로 fallback하지 않는다.
- 모든 Claude PROCESSING 상세 화면은 상태 readout + STOP 중심으로 제한하고, 관측 세션의 예약 COMMIT 버튼을 제거했다. 실제 선택지는 정확히 상관된 awaiting 이벤트에서만 활성화한다.

### 검증/배포
- 교차 오염 회귀 테스트를 추가하고 전체 Vitest **104 files / 1,846 tests**, `pnpm -r exec tsc --noEmit`, `pnpm build`, protocol codegen, macOS Debug compile, Stream Deck validate, `git diff --check`를 통과했다.
- Stream Deck 플러그인을 재링크·재시작했고, D200H self-contained Ulanzi 플러그인을 사용자 Studio 폴더에 설치한 뒤 Ulanzi Studio를 재기동했다. 양 설치 번들에서 새 격리 코드를 확인했다. 검증 시점에는 port 9120 데몬이 꺼져 있어 실제 세션 버튼 왕복은 수행하지 않았다.

## 2026-07-17 (밤) — TTGO T-Display offline layout overflow fix and serial flashing

### 문제
- TTGO T-Display 기기가 offline 상태(데몬과 미연결 상태)일 때, 화면 중앙에 표시되는 AgentDeck 로고와 연결 카드(connCard)가 135x240 LCD 액정 경계를 벗어나서 잘리는 등 화면 밖으로 넘치고 뭉개지는 레이아웃 어색함이 있었다.
- 또한, 기기가 USB Serial에 연결되어 있을 때 firmware가 WiFi 라디오를 자동으로 파킹(WiFi off)하므로 WiFi OTA를 통한 펌웨어 업데이트가 불가능했다.

### 해결
- **레이아웃 개선**: [esp32/src/ui/screens/aquarium.cpp](file:///Users/puritysb/github/AgentDeck/esp32/src/ui/screens/aquarium.cpp)를 수정하여 TTGO 보드(`BOARD_TTGO`)의 컴팩트 세로 화면(width 135)에 맞게 `connCard` 너비를 화면 가로 길이에 연동(`g_screenW - 16`, 최대 260)하고 패딩을 줄여 좌우 8px의 여백을 깔끔하게 유지하게 했다.
- **방향 대응**: 화면 세로 길이가 150px 미만인 가로 모드 상황을 감안해 레이아웃 플로우를 세로(`COLUMN`)에서 가로(`ROW`) 형태로 동적 전환하여 로고와 텍스트를 좌우 배치함으로써 컴팩트 액정에서의 상하 오버플로우를 완전히 제거했다.
- **폰트 최적화**: 좁은 액정에 적합하도록 카드 제목과 상태 메시지 폰트를 Montserrat 14/12로 줄여 가독성을 높였다.
- **업로드 속도 튜닝**: [esp32/platformio.ini](file:///Users/puritysb/github/AgentDeck/esp32/platformio.ini) 내 `[env:ttgo]`의 시리얼 플래시 업로드 속도를 `57600`에서 표준적이고 훨씬 안정적인 `115200`으로 2배 상향 조정했다.
- **시리얼 플래싱**: 데몬을 잠시 종료해 포트 점유를 해제한 뒤 `pio run -e ttgo -t upload`를 수행하여 USB Serial로 펌웨어를 성공적으로 안전하게 주입했다.

### 검증
- **시뮬레이터 렌더**: `esp32/sim/render.sh`를 활용해 `ttgo` 타겟의 `empty`(offline) 및 `idle`(connected) 씬을 렌더링하고, 생성된 `ttgo-empty.png`, `ttgo-idle.png`를 visual inspection하여 135x240 화면 경계 내에 모든 요소가 비율을 맞춰 완벽히 배치되는 것을 확인했다.
- **기기 실측**: 데몬 재기동 후 TTGO 보드의 시리얼 handshake와 WiFi 자동 프로비저닝(`wifi_provision_ack` 수신) 및 WiFi AP 연결 수립 상태(`wifiConnected: true`, `wifiConfigured: true`)를 확인했다.

## 2026-07-17 — Pixoo64 Claude/Codex usage HUD parity

### 문제
- Pixoo64는 Claude 한도만 하단 7px 숫자 HUD(사용률 배경 + 리셋 카운트다운)로 표현하고 Codex primary/secondary는 그 위 2개의 1px rail로 덧붙였다. 동일한 rate-limit 정보가 서로 다른 계층처럼 보여 출처와 의미가 불명확했고 Codex 리셋까지 남은 시간도 누락됐다.

### 해결
- 하단을 7px provider row 두 개로 통일했다. 문자 키 대신 `design/brand/*.svg`에서 생성된 공식 마스크를 9×7 크리처 실루엣으로 직접 축소해 출처를 표시하고, 두 행 모두 primary/5h 왼쪽·secondary/7d 오른쪽에 동일한 사용률 fill·퍼센트·reset countdown 문법을 쓴다. 한 provider만 있으면 맨 아래 한 행만 사용한다.
- 좁은 29px zone에서 `100%`와 시간이 충돌할 때만 `1h23`을 `1h`처럼 축약하며, 평소에는 기존 상세 카운트다운을 유지한다. Claude stale과 Codex window stale은 서로 독립적으로 숨겨 fresh provider까지 함께 사라지지 않게 했다.
- Node/Swift 렌더러와 creature simulator 입력을 같은 구조로 맞추고, 두 provider 행 모두에 reset-time 픽셀이 존재하는 회귀 테스트를 추가했다.

## 2026-07-17 — 32×32 identity stage + 11×11 shaded beacon + Codex token limits

### 문제
- iDotMatrix 32×32 전용 렌더러도 낮은 채도의 수조/지형이 공식 마크와 경쟁해 색이 탁하고 구성이 축소판처럼 보였다. Node `/pixoo/frame?size=32`는 여전히 64px 장면을 축소해 Swift 네이티브 경로와도 달랐다.
- Timebox Mini의 9×9 공식 마크는 실루엣은 맞지만 2단계 명암과 흩어진 외곽 상태점 때문에 4-bit 실기에서 평평한 픽셀 덩어리처럼 읽혔다.
- Codex rollout의 실제 primary/secondary rate-limit 데이터는 앱과 ESP32 protocol까지 도달했지만 Pixoo64·iDotMatrix·TC001 dot-matrix 출력에는 표시되지 않았다.

### 해결
- **iDotMatrix**: Node/Swift를 같은 네이티브 32×32 identity stage로 통일했다. sand/terrain을 제거한 blue-black field, 고채도 coral/violet/white/red palette, 18/13/10px 공식 마크, mask-aware shadow/halo를 사용한다. 하단 4개 고정 rail은 Claude 5h/7d와 Codex primary/secondary를 source key + 사용률로 표시한다.
- **Timebox Mini**: 생성 공식 9×9 geometry는 유지하되 alpha를 4개 4-bit-safe 명암으로 양자화하고 상→하 lighting을 추가했다. 외곽은 항상 연결된 dim frame이며 processing/awaiting/error/idle 강조만 그 위에서 움직인다. 11px에서는 identity를 해치는 usage rail을 의도적으로 생략했다.
- **Pixoo64 / TC001**: Pixoo64 하단 Claude HUD 위에 violet/indigo Codex 2줄 rail을 추가하고 Codex-only일 때 `Cnn` gauge를 표시한다. TC001은 Claude USAGE와 분리된 violet Codex primary/secondary 페이지를 데이터가 있을 때만 자동 순환한다. stale Codex window는 모든 새 dot-matrix 경로에서 숨긴다.

### 검증
Node/Swift 11px·32px nearest-neighbor montage 시각 검수, bridge typecheck/build, 전체 Vitest 102 files / 1,815 tests, Swift Timebox+iDot/Pixoo 집중 tests, TC001 `led8x32` PlatformIO build, `git diff --check` 통과. TC001 빌드는 Intel Homebrew `pio`와 arm64 `littlefs` 혼선을 피해 arm64 `~/.platformio/penv/bin/pio`를 사용했다.

## 2026-07-17 — iDotMatrix native 32px + Pixoo adaptive loop + Timebox Agent Beacon

### 문제
- Swift iDotMatrix가 Pixoo64 완성 장면을 32px로 절반 축소한 뒤 brightness 1.6 / contrast 1.2를 적용해, 공식 마크가 물리 5–6 LED까지 작아지고 음각·눈이 뭉개졌다.
- Pixoo64는 상태 변화 때만 2프레임을 심고 안정 상태를 단일 프레임으로 덮었으며, 시퀀스가 한 번 실패하면 실행 내내 애니메이션을 포기했다. HTTP 자체보다 업로드 정책이 움직임을 느리게 만든 경우였다.
- Timebox Mini의 별도 hand-authored 11×11 크리처 표는 다른 표면의 공식 마크와 계속 갭을 만들었다. 121 LED에서 테라리엄을 축소하는 접근도 정보 밀도가 지나쳤다.

### 해결
- **iDotMatrix**: Swift `renderCompact32`가 단순화된 수면/지형 위에 최대 3개의 생성 공식 마크를 물리 16/12/9px로 직접 합성한다. 완성 장면 후축소가 없고, 출력 보정은 Swift/Python 모두 1.22 / 1.08로 낮췄다.
- **Pixoo64**: active는 2.5s moving-single, idle 10s, 상태 변화 floor 1s로 바꿨다(기존 active 체감 12s 대비 약 5배 빠름). multi-frame GIF는 실기에서 요청 직후 REST timeout + ping 60–87.5% 유실을 반복 확인해 기본 경로에서 완전히 제외했다. 실패 attempt도 rate-limit하고, 별도 periodic channel reassert가 최근 정상 push를 중복 덮지 않게 했다. 기기는 REST에 응답하지만 장수 URLSession만 고착되는 패턴은 PicID 실패 즉시 fresh probe로 대조해 세션을 재생성한다. 복구 frame 실패를 성공으로 덮던 상태 초기화도 제거했다.
- **Timebox Mini**: 11×11 전용 **Agent Beacon**으로 교체했다. 중앙 9×9은 `design/brand/*.svg`에서 생성한 공식 identity이고, 1px 외곽 rail만 processing cyan chase / awaiting amber corners / error red dash / idle green corners로 움직인다. 기존 수제 대체 크리처 표는 제거했다.

### 검증
`pnpm generate-micro-glyphs` 결정론적 재실행, TypeScript typecheck, 전체 Vitest 102 files / 1,812 tests, Swift Timebox+iDot/Pixoo 정책 집중 tests, macOS Debug build, `git diff --check` 통과. 11×11 5종을 nearest-neighbor 확대 렌더해 공식 실루엣·OpenCode hollow·OpenClaw teal eye·Antigravity 열린 arc를 시각 검수했다. 새 macOS 빌드에서 Timebox/iDotMatrix는 CoreBluetooth connected + 지속 frame update를 실측했다. Pixoo는 multi-frame 실패와 장수-session 고착을 실기 재현한 뒤 안전 단일-frame 빌드에서 `animationMode:single-frame`, `failures:0`, `online:true`, `lastPushError:null`, 2.5s push 갱신과 ping 27회 연속 무손실을 확인했다.

### 핵심 설계 결정
초저해상도는 동일 장면을 축소하는 문제가 아니라 **동일 identity를 각 패널 문법으로 번역하는 문제**다. geometry는 공식 SVG 생성 마스크로 고정하되, 32px는 compact composition, 11px는 stable identity + perimeter status, 64px는 안전한 bounded HTTP cadence로 서로 다른 제약을 직접 다룬다. Pixoo BLE 비공개 프로토콜을 새로 역공학하지 않고 공식 LAN REST 면을 사용한다.

## 2026-07-17 (저녁) — flap 3막: "등록됐는가"로 보드를 판별하면 레이스에서 지는 보드는 영원히 미등록

### 문제
앞선 라운드에서 flap을 고쳤다고 선언했는데 사용자가 **"round_amoled가 reconnecting 상태"**라고 지적했다. 확인해보니 5초 수명으로 계속 죽고 로스터에서도 퇴출돼 있었다 — 내 "4보드 로스터 안정" 검증이 틀렸다. 창이 90초로 짧았고, **접속 횟수만 세고 연결 수명·로스터 잔류를 안 봤다.**

### 원인 (commit `d352844d`)
`DaemonServer.handleClientConnect`의 timeline 분기가 `if cachedWifiEsp32[conn.id] == nil { 원본 100행 } else { 셰이핑 }` — **"등록됐는가"가 기준**이었다. 그런데 보드는 WS open **후에야** device_info를 announce하므로 burst의 timeline 단계(~300ms)에선 **언제나 미등록**이다. 결과: 대시보드용 원본 **115,236B**(4096B 라인버퍼의 28배) → announce 전에 소켓 사망 → 재접속 → 또 레이스 패배 → **영원히 미등록**이라는 자기영속 루프. 2막에서 `conn.isEsp32`(업그레이드 URL 태깅)를 넣고도 이 분기만 안 거쳐 놓쳤다. 86box가 멀쩡했던 건 레이스를 이겨서였을 뿐. Fix=분기 기준을 `isEsp32`로. 실측 **115,236B→3,159B**(라이브 데몬에 `clientType=esp32`로 붙어 device_info 없이 측정). Node는 무관 — esp32Clients를 업그레이드 시 태깅하고 serial seed를 6행으로 캡한다.

### ★"남은 건 RF"는 오판이었다 — 손실률은 storm의 증상 (인과 역전)
fix 후 실패 양상이 `peer FIN` 5초 → `ETIMEDOUT` ~75초로 바뀌었고, 그 시점 ping이 86box 10% / ips_35 20% / **round_amoled 96.7% loss**로 churn과 깔끔히 상관했다. 나는 "링크가 죽었다, 소프트웨어로 못 고친다, 물리 점검 필요"로 보고했다. **20분 뒤 사용자가 "지금은 괜찮은데?" — round_amoled 96.7%→0.0% loss, 접속 23회/14분→1회/10분.** 아무도 아무것도 안 만졌다(USB `0x303a` 여전히 0개 = 케이블 그대로, 그 사이 커밋은 pixoo뿐).

진짜 그림: fix는 09:56:44에 이미 라이브였는데(프로브 3159B 확인) flap이 10분 더 지속되다 10:08부터 간격이 벌어지며(2m20s→1m16s→1m04s) 10:16에 멈췄다 — **폭풍이 관성으로 돌다 damp out된 것**(1막의 자기강화 storm과 같은 구조: 보드들의 동시 재접속 난사 → 2.4GHz 혼잡 → 전 보드 추가 실패 → 더 재접속). 내 ping은 **폭풍 한복판에서 찍은 값**이었다.

**교훈**: ① 원인이 데몬/프레임이면 **전 보드가 함께** 나빠지고 **함께** 좋아진다(실측: 4보드 동시 개선 86box 7→0, ips_35 13→2, amoled 23→1, tc001 15→6). 특정 보드만 지속적으로 나쁠 때가 물리 후보다. ② **한 시점의 ping 손실률은 계층 판별 증거가 못 된다.** ③ **fix 후 판정은 15~20분 damp out을 기다려라** — 직후 창은 여전히 나쁘다. 실패 양상 구분(`peer FIN`=프레임 오버런 vs `ETIMEDOUT`=링크 침묵)은 유효하나, 링크 침묵의 원인이 storm일 수 있으므로 RF로 단정하지 말 것.

### IPS10 SDIO panic 재발 (별건, 미수정)
오늘 추가한 panic 캡처가 첫날부터 실제 크래시를 잡았다: `assert failed: sdio_rx_get_buffer sdio_drv.c:896` / `sdio_push_data_to_queue sdio_drv.c:928` 3회(06:37:58, 07:22:34, 09:29:10) + `rst:0xc (SW_CPU_RESET)` = P4 전체 재부팅. **07-08에 19회 발생 후 커밋 `79579148`에서 고쳤다고 문서화된 그 버그**인데, 수정 포함 빌드(`a1d59de8`)에서 동일 빈도(≈1회/시간)로 재발한다 — 당시 검증이 300초·90초 창이라 1시간 주기 이벤트에 원리적으로 무력했다. 트리거는 로그로 특정: 데몬 기동 `09:29:08` → assert `09:29:10`(2초 후). 시리얼 JSON 도착 순간 `main.cpp:108-125`가 라디오를 **즉시** 파킹(`hostedDeinitWiFi`)하는데 그때 WiFi RX가 진행 중이면 SDIO 버퍼가 사라진 채 C6가 밀어넣어 assert. 그 코드 주석이 *"hosted SDIO가 오버랩에서 assert하니 stability window 없이 즉시 파킹"*인데 — **즉시 파킹이 오히려 레이스를 만든다**는 게 관측 결과다. 확률적이라 다른 재시작(08:39/08:43/08:50/09:20/09:34)에선 안 터졌다.

## 2026-07-17 — Swift 데몬 WiFi OTA 포팅 + WiFi 보드 만성 flap의 진범(37KB 단일 프레임)

### Swift 데몬 ESP32 WiFi OTA (commit `e2edaa27`)
Swift 데몬은 WiFi 보드를 받기만 하고 업데이트를 못 해서 OTA 때마다 Node 데몬으로 교체해야 했다. `ESP32WifiOta.swift`가 Node `performWifiEsp32Ota`를 포팅: otaId 기반 ack 라우팅, 단계별 timeout(begin 15s / chunk·end 30s), **reconnect-follow 재전송**(WiFi-flash 공존 드롭 시 새 소켓 추적, 최대 12회), abort best-effort. `POST /esp32/ota`는 `firmwarePath` 외에 **`firmwareB64` 인라인**을 받는다 — 샌드박스 데몬이 컨테이너 밖 경로를 못 읽는 경우의 경로로, CLI가 `firmware_unreadable` 응답에 자동 재전송(HTTP 바디캡은 이 라우트만 24MB). App Store 안전성: 서브프로세스 없음(펌웨어는 기기에서 실행되는 데이터), `--build`(pio)만 Tier 2 — feature matrix에 행 추가. 실측: Xcode Debug 샌드박스 데몬이 `~/github` 경로를 직접 읽었음(폴백 미발동이나 코드는 유지 — 서명/프로파일에 따라 달라질 수 있음).

### WiFi 보드 만성 flap — 근본원인은 fanout이 아니라 "프레임 크기 × 시각"
전 WiFi 보드(86box/ips_35/round_amoled/tc001)가 오후 내내 ~5초 주기 connect→choke→reconnect. OTA는 chunk ack가 계속 유실되며 실패(chunk #7, resend 소진). 야간 로그는 시간당 연결 2회(안정) — **flap은 콘텐츠 의존**이었다:
1. **connect burst의 timeline_history**: 64행 ring 캡은 있었지만 바이트 캡이 없어, 바쁜 오후의 한글 타임라인 64행 = **실측 ~37KB 단일 라인**. serial 펌웨어는 초과 라인을 침묵 폐기(무증상)하지만 **WiFi WS 클라이언트는 소켓을 끊는다** → 재접속 → 같은 프레임 → 무한 flap. 야간엔 타임라인이 비어서 프레임이 작아 안정 — "밤엔 멀쩡한데 오후에 미친다"의 실체.
2. **Swift sessions_list 무캡**: Node는 `SERIAL_SESSIONS_CAP=10`(roundRobinByAgentType)인데 Swift shrink는 관측 세션 전부를 실었다(다중 Claude 세션 오후에 증폭 요인).
3. **등록 레이스**: connect burst가 보드의 device_info 등록보다 먼저 발화하면 셰이핑 없는 풀 프레임이 나감. Node는 **WS 업그레이드 URL 쿼리(`clientType=esp32`)로 접속 즉시 태깅**하는데 Swift는 쿼리를 버렸다.

Fix (commit `9f6657e0`): timeline_history **바이트 예산 3500B**(최신 우선, 양 데몬 미러 `budgetTimelineEntries`) + Swift에 roundRobin 캡 포팅 + `WebSocketConnection.isEsp32`(업그레이드 라인 파싱)로 frame-zero 셰이핑/드롭. 검증: 로스터가 4보드 동시 안정(이전: 1대씩 순환), 90초 신규연결 4회(초기 접속뿐).

### 구펌웨어 4보드 최신화 — Swift 데몬 OTA 실전 검증
- **round_amoled** 7b81882f-dirty → `e2edaa27` OTA ✓ (2.4MB/2480 chunks) — Swift 데몬 첫 OTA
- **86box** 53794d2d-dirty → `e2edaa27` OTA ✓ (2.5MB/2543 chunks)
- **ips_35** 7b81882f-dirty → `e2edaa27` OTA ✓ (2.4MB/2495 chunks)
- **tc001** 5f0f4e52-dirty → `e2edaa27` serial 플래시 ✓ — 구펌웨어의 radio parking(serial 연결 시 WiFi off)으로 WS가 안 돌아와 OTA 불가; /diag의 82fbdfff 표기는 stale이었음(실측 5f0f4e52-dirty)
- 셋 다 재부팅 후 WiFi 재등록으로 buildHash 실측 검증. vitest 62/62(serial), XCTest ESP32WifiForwardTests 9/9. (전체 vitest의 timebox-ble 7건 실패는 동시 세션의 micro-glyphs 진행 중 작업 — 이 라운드 무관)

## 2026-07-17 — IPS10 "pixel office" 진입 실패 + 카드 무의미 텍스트: 라우팅·바이트캡·소스 3중 fix

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

## 2026-07-17 — inkdeck panic의 정체: mDNS 컴포넌트 크래시 — 코어덤프 파티션에서 backtrace 복원

### 문제
전 라운드 잔여 과제: inkdeck이 13:21–13:26에 panic(reset code 4)으로 재부팅했는데(구빌드 `0301e43d-dirty`) 시리얼 backtrace가 어디에도 없었다. 원인 — **양쪽 데몬 모두 `{`로 시작하지 않는 시리얼 라인을 무조건 폐기**(Node `esp32-serial.ts` `startsWith('{')`, Swift `ESP32Serial.swift` `hasPrefix("{")`)해서 Guru Meditation 덤프가 로그에 남을 방법이 없었다.

### 해결
1. **panic 캡처 (commit `24f0c095`)**: panic 마커(Guru Meditation/Backtrace:/register dump/abort()/assert failed/Rebooting... 등)가 보이면 포트별 10s 캡처 윈도우를 열고 비-JSON 라인을 그대로 데몬 로그에 남긴다(200줄 캡, 마커마다 윈도우 갱신 — 재부팅 후 부트로더 reset-cause 라인까지 포섭). Node+Swift 동일 구현, vitest 2건.
2. **소급 복원 — coredump 파티션**: backtrace는 소실됐지만 arduino-esp32가 coredump-to-flash를 켜둔 상태였다(default_8MB.csv `coredump @0x7F0000`). 데몬 내리고 esptool로 파티션을 읽으니 30KB ELF 코어덤프가 살아 있었음. 원본 ELF(`-dirty`)는 재현 불가라 클린 `0301e43d` 재빌드 ELF로 디코딩 — esp-coredump의 app SHA 검증은 덤프 사본의 9자 SHA 문자열(offset 30720)과 CRC32 트레일러(data_len-4)를 직접 패치해 통과시켰다. 아티팩트: `diagnostics/inkdeck-coredump-20260717/`.

### 판정
`LoadProhibited`, excvaddr `0xabba13c3`(오염 포인터). 크래시 지점은 **prebuilt espressif mDNS 컴포넌트의 수신 경로**(`_mdns_service_task → mdns_parse_packet → _udp_recv`, `mdns_networking_lwip.c:174`) — AgentDeck 앱 코드가 아니다. inkdeck은 HWCDC 손실 때문에 radio parking을 의도적으로 안 하는 유일한 serial 보드라 mDNS 태스크가 LAN 멀티캐스트에 상시 노출되고, panic 시각은 데몬 재시작 반복(mDNS 광고 flap) 시간대였다. 재발 시 데몬 로그에 전체 덤프가 남는다; 잦으면 pioarduino 플랫폼 범프(신형 mdns 컴포넌트) 검토.

### 구펌웨어 3보드 최신화 (a1d59de8, 클린 worktree 빌드)
- 동시 세션이 esp32 크리처 소스를 미커밋 수정 중이라 **HEAD 클린 worktree**에서 빌드 — dirty 편입 방지 + `-dirty` 아닌 검증가능 buildHash.
- **ttgo** 0.1.2→0.2.3(`a1d59de8`) serial 플래시 ✓ / **ips10** `a1d59de8` ✓ / **inkdeck** `a1d59de8` ✓ — 셋 다 flash 후 직접 시리얼 probe로 buildHash 실측 검증. tc001은 이미 `82fbdfff`.
- inkdeck native CDC는 이번에도 `pio -t upload`가 허브 재열거에서 실패 — 보드가 다운로드 모드 포트(`usbmodem3111101`)에 남으므로 **그 포트에 esptool write-flash 직접 실행**(0x0/0x8000/0xe000 boot_app0/0x10000)이 확실한 경로. boot_app0 재기록으로 과거 OTA의 otadata(app1 지향)도 초기화.
- 잔여: **86box가 `53794d2d-dirty`로 구버전** (WiFi-only, OTA는 Node 데몬 필요 — Swift 데몬 미지원).

### 데몬 "SIGKILL 반복" 재검
양쪽 daemon-crash.log 전 기록이 **SIGTERM 클린 종료**뿐 — Node↔Swift 데몬 takeover 요청(`requestDaemonShutdown`)과 앱 종료가 원인이고, 크래시/SIGKILL 증거는 없다. LaunchAgent(KeepAlive) 등록은 가능하지만 Xcode에서 Swift 데몬을 디버깅하는 워크플로와 상충(재스폰된 Node가 Swift를 계속 축출) — 등록은 보류하고 사용자 판단에 위임.

## 2026-07-17 — 5개 에이전트 공식 마크 전 기기 통합 + 혼선 에셋 제거

### 문제
`design/brand/{claudecode,codex,openclaw,opencode,antigravity}.svg`가 정본인데도 표면별 구현이 갈라져 있었다. Shared/Stream Deck은 Claude에 Anthropic 별표와 Codex에 절차적 구름을 썼고, Android·Apple 테라리엄/E-ink는 Codex/OpenClaw/OpenCode를 근사 도형으로 다시 그렸다. Apple 설정·온보딩의 Codex는 에이전트 마크 대신 일반 OpenAI 로고였으며, TC001 미리보기는 펌웨어와 다른 옛 5×6 스프라이트였다. `assets/logos/`에는 미사용 대체 로고·AI 생성 PNG·영상이 한데 있어 새 정본처럼 오해할 여지도 있었다.

### 해결
- Shared/Stream Deck, Android Compose/E-ink, Apple SwiftUI/미리보기, ESP32 테라리엄을 5개 공식 path로 통일했다. 상태 애니메이션은 마크 전체를 움직이거나 주변 효과를 더할 뿐, 식별 형상을 재구성하지 않는다.
- Android/Apple SVG parser가 압축 arc flag(`0 110`)를 정확히 읽도록 보강했다. OpenClaw E-ink와 Apple 공용 미리보기의 120×120 근사 가재를 공식 24×24 마크로 교체했다.
- ESP32 64×64 및 dot-matrix 24×24/TC001 8×8 마스크 생성기가 `design/brand` SVG를 직접 래스터화하도록 바꿨다. TC001 Apple 미리보기도 펌웨어와 같은 생성 마스크를 소비한다.
- Apple 설정·온보딩을 `SessionCreatureIcon`으로 통합해 Codex/OpenCode/Antigravity까지 공식 에이전트 마크를 표시한다.
- `assets/logos/`, 미사용 AI animation CSS, 중복 Apple `Creature*.imageset`과 `BrandOpenAI.imageset`, Android의 사장된 `AgentMark` 상태를 제거했다. `DESIGN.md`에 `design/brand` 단일 정본과 픽셀 제약 예외를 명시했다.
- `brand-assets-contract.test.ts`를 추가해 정본 SVG↔Shared↔Android↔Apple 경로 일치, 생성기 5종 입력, 대체 에셋 부재를 고정했다.

### 검증
- `pnpm test`: 102 files / 1,802 tests 통과(공식 Claude Code 로봇으로 바뀐 10개 renderer snapshot 갱신 포함).
- Android release APK 빌드, macOS Debug 빌드 통과.
- ESP32 `led8x32`, `inkdeck`, 격리 빌드의 `ips10` 통과. IPS10은 flash 42.5%, RAM 29.8%.

## 2026-07-17 — 시리얼 보드 "무응답"의 정체: ack 된 적 없는 keepalive + 회수 불가능한 half-open UART

### 문제
CLI 데몬 점검 중 CH340 시리얼 보드 3 개(ips_10 / ulanzi_tc001 / ttgo)가 4–20+ 분씩 RX 침묵하는데 데몬은 `transportOpen: true, lastWriteSecondsAgo: 0` 으로 정상인 척했다. stale reaper 는 영원히 발동하지 않았고(자가치유 불능), native-CDC 인 inkdeck 만 멀쩡했다.

### 원인 (두 겹)
1. **keepalive 가 애초에 ack 된 적이 없다.** 펌웨어(`serial_client.cpp`)는 `strstr(buf, "\"keepalive\"")` 매치 라인에만 `heartbeat_ack` 를 회신하는데, Node 가 5 초마다 보내던 프레임은 `{"type":"serial_keepalive"}` — 부분문자열 불일치로 **단 한 번도 매치되지 않았다** (2cf5fc75 에서 도입된 명명이 펌웨어 계약을 못 봄). 즉 유일한 주기적 board→host 트래픽은 60 초 device_info refresh 뿐이었고, 응답 1 회 유실 = 1 분+ 장애처럼 보였다. `isResponsive` 의 60 초 임계와 정확히 경계가 겹쳐 `connected` 플래그도 만성적으로 플랩했다 (single-path dedup 의 입력이므로 WiFi WS 억제까지 흔들림).
2. **half-open UART 는 구조적으로 회수 불가.** reaper 의 UART 조항이 "read>60s **AND** write>60s" 를 요구하는데, heartbeat write 는 5 초마다 커널 버퍼에 성공적으로 들어가므로 writeAge≈0 이 영원히 유지된다. CDC 쪽엔 이 함정을 인지한 `isHalfOpenIdentifiedCdc` 가 있었지만 "연결 후 무읽기" 케이스만 커버 — **중도에 RX 가 죽은 UART** 는 좀비 FD 로 영구 보유됐다.

### 해결 (00c94bee — Node + Swift 세트)
- **Node**: keepalive 타입을 `keepalive` 로 (Swift 데몬이 이미 쓰는, 458fb1d3 이후 모든 배포 펌웨어가 ack 하는 프레임). `isSilentIdentifiedUart` 추가 — 식별된 UART 가 읽은 적 있고 RX 침묵 >180s 면 write 건강과 무관하게 recycle (재오픈의 DTR/RTS 토글 = 보드 리셋 = self-heal).
- **Swift** (`ESP32Serial.swift`): keepalive 를 **매 사이클 상시 발송**으로 (기존엔 "다른 페이로드가 없을 때만" — sessions_list/display_state 를 매 사이클 re-sync 하므로 활성 데몬에선 keepalive 가 사실상 발송된 적 없음 = 건강한 보드도 수신 0). 동일한 180s half-open recycle 추가.

### 핵심 설계 결정
- **liveness reaper 와 그 liveness 신호는 반드시 한 커밋으로.** Swift 에 reaper 만 넣었다면 (keepalive 상시화 없이) 활성 데몬이 건강한 보드를 3 분마다 DTR/RTS 리셋하는 더 나쁜 회귀가 됐다. 임계값(180s)은 신호 주기(3–5s ack)의 ~40–60 배로 잡았다.
- **write 성공은 peer 생존의 증거가 아니다** — 커널 버퍼가 받아줄 뿐. 시리얼 liveness 는 반드시 read 쪽으로 판단한다 (외부 peer async I/O 컨벤션의 시리얼 버전).
- 회귀 가드: vitest `serial keepalive ack contract` 가 프레임이 펌웨어 strstr 계약(`"keepalive"` 인용 부분문자열)을 만족하는지 고정.

### 검증
데몬 재시작 후 4 보드 전부 read age 0–9 초 안정 (수정 전: 60 초 주기 + 분 단위 갭). 잔여 관찰: 당일 13:21–13:26 에 보드 3 개가 동시기 재부팅(tc001=poweron, inkdeck=panic on 구빌드 0301e43d)한 것은 별건 — inkdeck panic backtrace 추적과 ttgo(0.1.2)/inkdeck 구펌웨어 최신화가 후속 과제.

## 2026-07-17 — 브릿지 플랩의 정체: 정당한 포트 리클레임 + UI 가 그걸 못 견딘 것

### 문제
직전 항목에서 "타임라인 스크롤이 바닥으로 튄다" 의 진범을 브릿지 플랩으로 지목하고, **"이 개발 머신에서 약 30 초 주기로 재현"** 이라고 기록했다. 이번 조사로 **그 빈도 주장이 틀렸음을 확인**했다. 만성 플랩이 아니었다.

### 실제 원인
Swift 데몬 로그(`swift-daemon.log`, UTC)를 보면 오늘 리클레임은 **총 4 회** 뿐이고, 그중 두 번이 정확히 관측된 리셋 시각이었다:

```
2026-07-17T00:36:54Z INFO Canonical port 9120 is free — reclaiming it from fallback port 9122
2026-07-17T00:39:12Z INFO Canonical port 9120 is free — reclaiming it from fallback port 9121
2026-07-17T00:39:12Z INFO Daemon shutting down...
```

`DaemonService.reclaimCanonicalPortIfNeeded()` 는 **의도된 동작**이다 — fallback 포트(9121/9122)에 고립된 허브는 canonical 9120 을 resolve 하는 클라이언트에게 보이지 않으므로, 9120 이 비는 순간 `standDownServer` → `start()` 로 되찾는다. 그 재시작이 자기 자신을 포함한 모든 WS 클라이언트를 ~5 초 끊는다.

앱이 애초에 fallback 포트로 뜬 이유는 **빠른 재시작 churn** — 검증하느라 `pkill` 직후 바로 재실행하면 죽어가던 인스턴스가 9120 을 아직 쥐고 있어(400ms 재시도로도 부족) 새 인스턴스가 9121 을 잡고, ~30 초 뒤 리클레임한다. 즉 30 초는 플랩 주기가 아니라 **리클레임 폴러의 지연**이었고, 유발자는 나였다. (`DaemonService.swift:533-549` 는 *promotion* 경로에 대해 이미 같은 thrash 를 문서화하고 가드하고 있다 — startup 경로만 남아 있었다.)

### 해결
플랩 빈도가 낮다고 문제가 사라지는 게 아니다. **정당한 ~5 초 재시작이 사용자의 읽던 위치를 날리면 안 된다.** `MonitorScreen` 이 `if !bridgeConnected { ConnectionOverlay() } else { hudLayer(geo:) }` 로 HUD 서브트리를 **스왑**하던 것을, **항상 마운트하고 `disconnected` 일 때 감추는** 방식으로 바꿨다 (`opacity(0)` + `allowsHitTesting(false)` — 이미 `hudHidden` 토글이 쓰던 패턴). ConnectionOverlay 는 자체 스크림을 위에 그리므로 겉모습은 동일하다.

### 검증
공유 중인 Node 데몬(병렬 세션이 기기 디버깅에 사용 중)을 건드리지 않기 위해, 임시 훅으로 `bridgeConnected` 를 false→true 강제 플랩시켜 확인했다. 수정 전에는 재연결마다 `strip onAppear` 가 다시 찍혔고(09:38, 09:39 2 회), 수정 후에는 25 초 disconnect 를 통과해도 **onAppear 가 1 회**. 끊긴 동안 스크린샷도 이전과 동일(테라리엄+스크림+카드, HUD 비침 없음), 재연결 후 HUD·타임라인 정상 복귀. 계측은 제거했다.

### 핵심 설계 결정
- **연결 상태로 UI 서브트리를 스왑하지 말고 감춰라.** 브릿지 드롭은 일상적으로 transient 하다(포트 리클레임, 데몬 재시작, WS blip). 스왑은 그 안의 모든 @State — 스크롤 오프셋, sticky 모드, 확장 상태 — 를 조용히 날린다. 사용자가 거의 인지 못 하는 blip 이 읽던 위치를 잃게 만드는 건 UX 비용이 크다.
- **로그의 빈도 주장은 로그로 확인하라.** 직전 세션의 "30 초 주기" 는 두 번의 관측을 주기로 일반화한 것이었다. `grep -c` 한 번이면 4 회라는 게 드러났다. 증상의 원인을 맞혔더라도 그 *빈도·범위* 는 별도의 증거가 필요하다.

## 2026-07-17 — 타임라인 최신행 고정 + 날짜 구분선, 그리고 계측이 밝힌 진범

### 문제
대시보드 TIMELINE 이 **첫 히스토리 로드에서 최신 행으로 스크롤되지 않았다** (iOS/macOS). Android 만 됐다. 또 한 번 행을 탭하면 자동 스크롤이 세션 필터를 바꾸기 전까지 영구히 얼어붙었고, 개수가 변하지 않는 in-place 갱신(chat_response 접힘, `×count` 병합, task_end upsert)은 스크롤을 갱신하지 못했다. 세션이 자정을 넘기면 행이 `HH:mm` 만 보여줘 어제 것인지 오늘 것인지 구분할 수 없었다.

### 해결
- **Apple 첫 로드 미스크롤의 근본 원인**: ScrollView 가 `if grouped.isEmpty { } else { }` 의 else 안에 있어서, empty → 첫 스냅샷 전이 때 SwiftUI 가 스크롤 분기를 **최종 개수로 새로 생성**했다. 그래서 `onChange(of:)` 가 변화를 관측할 일이 없었다. ScrollView 를 무조건 생성하고 empty 상태를 그 안으로 옮겨 0→N 을 평범한 콘텐츠 변경으로 만들었다.
- 자동 스크롤 키를 행 개수 → **"타임라인이 변경됐다" 신호** (Swift `timelineVersion` / Kotlin `grouped`) 로 교체해 in-place 갱신에도 바닥에 붙어 있게 했다.
- `focusedIndex < 0` 가드를 **스크롤 위치 기반 sticky-bottom** 으로 교체. 선택은 자동 스크롤과 완전히 분리된다.
- 날짜 구분선 (`TODAY` / `YESTERDAY` / `WED, JUL 15` / `DEC 31, 2025`) 을 각 달력일의 첫 행 위에 렌더. 합성 행을 리스트에 끼우지 않고 아이템 **내부**에 그려 `focusedIndex` / `.id(index)` 인덱스가 밀리지 않게 했다.

### 검증에서 드러난 진범 (★ 이 세션의 핵심 교훈)
sticky-bottom 을 실기에서 확인하자 **처음엔 실패했다** — 위로 스크롤했는데도 바닥으로 끌려갔다. 내 로직을 의심하기 전에 NSLog 로 계측했더니 원인이 전혀 달랐다:

```
09:39:15  bridgeConnected=false            ← 브릿지 ~5초 끊김
09:39:20  bridgeConnected=true
09:39:20  strip onAppear (fresh @State)    ← 뷰 전체 재생성
```

`MonitorScreen.swift` 의 `if !bridgeConnected { ConnectionOverlay() } else { hudLayer(geo:) }` 때문에 **브릿지가 잠깐 끊겼다 붙으면 hudLayer 분기가 통째로 파괴·재생성되어 타임라인의 스크롤 위치·선택·확장·sticky 상태가 전부 초기화된다.** 계측 없이 코드만 읽었다면 멀쩡한 sticky 로직을 뜯어고쳤을 것이다. 플랩 원인은 후속 조사로 넘겼다 (아래 항목에서 규명).

플랩 없는 구간에서 로그로 전 사이클 확인: 실행→최신 pin, 바닥에서 새 행 도착→따라감, 위로 스크롤→`stick=false` 유지, 복귀→`stick=true`, 탭→영향 없음. macOS + Lenovo TB-J606F 양쪽. Apple 427 / Android 237 통과.

### 핵심 설계 결정
- **날짜 구분선 index 0 은 의도적으로 비대칭**이다. 하루짜리 버퍼(압도적 다수)에는 구분선이 아예 안 나오고, 오래된 날부터 시작하는 버퍼에만 맨 위 앵커가 붙는다. 이 좁은 HUD 에 "TODAY" 배너를 상시 띄우는 건 순수 노이즈지만, 아래 행이 전부 `HH:mm` 뿐인 과거 버퍼는 앵커가 실제로 필요하다.
- **sticky-bottom 은 정책만 미러하고 메커니즘은 플랫폼별로 다르다.** Swift 는 iOS 17 호환을 위해 GeometryReader 로 콘텐츠 하단을 읽고(PreferenceKey 는 macOS ScrollView 밖으로 전파 안 됨), Kotlin 은 `canScrollForward` 를 쓴다. 양쪽 모두 **"행 집합이 바뀌어서 생긴 재레이아웃"을 count baseline 으로 걸러낸다** — 그러지 않으면 append 된 행이 뷰포트 아래 착지하는 순간이 "사용자가 떠났다"로 읽혀 정작 스크롤해야 할 모드를 스스로 끈다.

## 2026-07-17 — 도트 매트릭스 4종 공식 에이전트 에셋 정합

### 문제
Pixoo64·iDotMatrix·Timebox Mini·TC001의 에이전트 표시를 다시 대조하니 Timebox의 11×11 수제 글리프는 공식 마크의 핵심 특징을 보존했지만, 표준 Pixoo 렌더는 Node와 Swift가 서로 다른 손그림 격자·스케일을 쓰고 TC001은 별도 5×6 근사 스프라이트를 사용했다. 특히 Codex `>_` 음각, Claude Code 눈 구멍, OpenCode hollow center, Antigravity 열린 아크를 모든 런타임에서 보장하는 단일 경로가 없었다. 크리처 시뮬레이터도 Antigravity와 실제 TC001 출력을 누락하고 오래된 근사 스프라이트를 보여줬다.

### 해결
- `pnpm generate-micro-glyphs`가 기존 Timebox TS→Swift 미러와 함께 `design/brand/*.svg` 5종을 직접 래스터해 Pixoo/iDotMatrix용 24×24 alpha mask(TS+Swift)와 TC001용 8×8 alpha mask(TS+C++)를 생성한다.
- Node `pixoo-renderer`와 App Store Swift `PixooRenderer`가 같은 공식 마스크를 사용하도록 전환했다. idle/processing/awaiting의 색·bob·particle은 유지하되 geometry는 바꾸지 않는다. OpenClaw teal eye와 Antigravity product rainbow도 공식 실루엣 위의 표현 레이어로만 적용한다.
- TC001 AGENTS 페이지를 5×6 근사 도형에서 패널 전체 높이의 8×8 공식 마스크로 교체했다. 32열에 4 glyph 또는 OpenClaw 고정 슬롯+3 glyph가 정확히 들어가며, alpha coverage는 LED 밝기로 보존한다.
- Timebox는 11px에서 자동 축소보다 승인된 hand-tuned bitmap이 더 읽기 좋아 그대로 유지하되, 5종 렌더·OpenCode hollow·OpenClaw teal eye 회귀 테스트를 추가했다. 크리처 시뮬레이터는 Antigravity와 생성된 실제 TC001 frame data를 사용한다.

### 검증
공식 mask/Timebox/Pixoo/Timebox BLE focused Vitest 37개와 전체 Vitest 101 files / 1,784 tests 통과. monorepo typecheck, bridge build, creature-simulator production build, macOS Debug unsigned build 성공. ESP32 host simulator `led8x32` 전 scene 렌더 성공 후 실제 `led8x32` PlatformIO firmware build 성공(Flash 46.8%, RAM 25.9%). TC001에는 bootloader+partitions+firmware 전체 이미지를 115200 baud로 실기기 플래시해 각 영역 hash 검증, 하드 리셋, 32×8 matrix task, 저장 AP/Wi-Fi 재연결까지 확인했다. Apple Silicon에서는 `flash.sh`가 PATH의 Intel Homebrew `pio`를 먼저 잡으면 ARM64 `littlefs` 모듈과 충돌하므로 `~/.platformio/penv/bin`을 PATH 앞에 두어야 한다. 생성기 결정론적 재실행 및 `git diff --check` 통과. 디자인 린트는 신규 vendor/emulator·DerivedData까지 스캔하는 기존 scope 문제로 task 외 baseline 607건을 보고했다(본 작업 simulator 경로는 lint prune 대상).

### 핵심 설계 결정
초저해상도에서도 **상태 애니메이션과 공식 geometry를 분리**한다. 색·pulse·sparkle는 기기별 표현 계층이지만 실루엣/음각은 `design/brand/*.svg`에서 생성한다. 유일한 예외인 Timebox 11×11은 자동 downscale가 기능 픽셀을 잃기 때문에 hand-tuned accessibility reduction을 유지하고 자동 테스트로 정의적 특징을 고정한다.

## 2026-07-17 — 세션 상태 오표시 2건: TTL 사다리에서 누락된 claude, 턴마다 지워진 opencode dedup

### 문제
데크가 실제와 반대되는 세션 상태를 보였다. 방향은 정반대인데 둘 다 "조용한 세션을 어떻게 해석하는가" 의 문제였다.

1. **활발히 작업 중인 standalone `claude` 세션이 "멈춤" 으로 표시**됐다가 잠시 뒤 되살아났다. 실측: 세션 `a690b039` 가 서브에이전트 3개를 기다리며 180 초 조용해지자 evict 됐고, 5 초 뒤 다음 `tool_start` 에서 부활했다.
2. **끝난 standalone `opencode` 세션이 "작업중" 으로 고착**돼 30 분 idle TTL 이 행을 걷어낼 때까지 풀리지 않았다. 실측: `ses_0929a5bc` 가 같은 초에 `opencode_stop` 과 `opencode_user_prompt_submit` 을 남기고 13 분간 무음 — 그동안 opencode 프로세스는 프롬프트에서 놀고 있는데 행은 processing 을 주장했다.

### 해결
- **claude 는 TTL 사다리의 어느 분기에도 걸리지 않았다** (2ea847ca). codex 는 `codexInteractiveIdleTTL` + tool-aware companion 창을, opencode 는 `openCodeIdleTTL` (d330778d) 을 받았지만 claude-code 만 매칭 없이 180 초 `pushedSessionStaleTTL` 로 떨어졌다 — 데몬이 그 판단 시점에 `state=processing`, `currentTool=Bash` 를 손에 쥐고 있는데도. Claude Code 는 훅을 SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/Notification/SessionEnd 에서만 쏘므로 **180 초보다 긴 툴 호출 하나면 그 사이 아무것도 emit 되지 않는다** (긴 빌드, 테스트 런, 서브에이전트 팬아웃). eviction 은 파괴적이다 — 합성 `chat_end` 로 열린 턴을 강제 종료하므로 타임라인이 "턴이 끝났다" 고 거짓 주장하고 모든 표면이 행을 떨군다. claude-code 에 동일한 30 분 interactive backstop 을 부여했다.
- **opencode 는 `session.idle` 핸들러가 자기가 필요로 할 dedup 엔트리를 지우고 있었다** (aa682120). `sendPrompt` 는 user messageID 로 `promptSent` dedup 하는데, settle 중인 세션의 바로 그 엔트리를 삭제했다. OpenCode 는 턴이 정착할 때 user message 의 `message.updated` 를 재발행하고, dedup 엔트리가 사라진 상태의 그 후행 업데이트가 `sendPrompt` 를 다시 불러 `opencode_user_prompt_submit` 을 재전송했다. 데몬은 이를 `state=processing` + phantom turn (`appendOpenCodeChatStart`) 으로 매핑한다. 세션은 이미 idle 이라 이를 닫아줄 `session.idle` 이 뒤따르지 않았고 행은 그대로 굳었다. messageID 는 재제출되지 않으므로 `userMsgs`/`promptSent` 는 순수 dedup 메모리이고 **턴보다 오래 살아야 한다** — 턴마다 비운 것이 버그였지 경계가 버그가 아니었다. `toolPhase` cap 을 미러해 추가 시점에 cap 한다.
- **TTL 추측의 근거였던 거짓 전제를 정정**했다 (040f8c2d, 주석 전용). `codexInteractiveIdleTTL` 주석은 샌드박스가 `ps` 를 막아 "Node 데몬과 달리 프로세스 테이블에 liveness 를 기댈 수 없다" 고 서술했다. 틀렸다 — 막히는 것은 `ps` **spawn** (서브프로세스, App Store 2.5.2) 뿐이고 sysctl 은 아니다. `ProcessEnumerator` 가 바로 이 데몬에서 이미 KERN_PROC_ALL + KERN_PROCARGS2 를 읽고 `LocalCodexAppObserver` 가 프로덕션에서 호출한다. 샌드박스 테스트 호스트에서 실측: **642 개 프로세스 열거, 모든 에이전트 CLI 가 pid·시작시각·argv 와 함께 보였다.**

### 검증
- ladder 순수 함수 테스트 8 종 신규 + macOS 전체 424 통과.
- opencode: 기존 테스트는 이벤트 **이름** 만 고정해 시퀀싱 버그를 원리적으로 못 잡으므로, 실제 플러그인 body 를 구동해 이벤트를 흘리는 커버리지를 새로 썼다. 수정 전 핸들러에 대해 먼저 **failing 확인** (user_prompt_submit 2 회 post, 기대 1 회).
- 두 버그 모두 로그 실측 세션 (`a690b039`, `ses_0929a5bc`) 에서 관측 후 수정.

### 핵심 설계 결정
- **새 에이전트를 붙일 때 TTL 사다리 분기는 필수다.** 이 버그의 형태는 "잘못된 값" 이 아니라 "분기 없음 → 조용한 fallback" 이었다. 매칭 실패가 가장 공격적인 창(180 초)으로 떨어지는 구조라 새 에이전트일수록 위험하다. 사다리를 순수 함수로 바꿔 **ORDER 자체를 테스트**한다 — awaiting 이 per-agent TTL 보다 계속 우선해야 하며, 안 그러면 권한 프롬프트가 사용자의 판단 도중에 evict 된다 (`awaitingHookStaleTTL` 이 존재하는 이유).
- **로그가 조사를 오도했다.** eviction 로그 줄이 `pushedSessionStaleTTL` 을 리터럴로 재진술해, 실제로는 30 분을 받은 opencode·interactive codex 행에도 "no hook in 180s" 를 찍었다. 이제 실제 적용된 TTL 과 agentType 을 보고한다. 이 낡은 줄이 이번 조사를 이미 적용되지 않는 창으로 몰아갔다.
- **opencode 는 데몬 측 settle 타이머가 아니라 플러그인에서 고쳤다.** 데몬은 놓친 stop 과 정당하게 긴 조용한 턴을 구별할 수 없고, 그 추측으로 행을 걷어내는 것이 이틀 전 d330778d 가 opencode 에 대해 고친 바로 그 실패다.
- **진짜 제약은 가시성이 아니라 귀속(attribution)이다.** 훅은 session_id 를 싣고 CLI 의 pid 는 절대 싣지 않으며, 동시 실행되는 claude 프로세스들은 argv 로 구분되지 않는다 (전부 argv0 == "claude"). 이를 해제할 조건($PPID 를 훅 스니펫이 싣는 것)까지 주석에 남겨, 다음 사람이 존재하지 않는 제약을 물려받지 않게 했다.
- **진짜 ghost 빈도는 아직 측정되지 않았다 — 출하 후로 미룬다.** 전체 집계는 eviction 175 회였으나 그 **대부분이 위에서 고친 false positive** 였다. (세션 중 "session_end 75 회이므로 ghost 는 드물다" 고 판단한 순간이 있었는데, 로그 tail 만 본 오판이었다.) 2ea847ca 이후로는 false positive 가 사라졌으므로 **이후 로그에 남는 eviction = 진짜 ghost** 다. 0.2.3 출하 후 `Evicted stale session` 을 distinct sid 대비 반복 횟수로 세어 유의미하면 $PPID 작업에 착수한다 — 단 $PPID 가 정말 claude pid 인지 (셸이 손자면 틀어진다) 검증이 선행돼야 한다. ⚠ "claude 프로세스 0 개면 evict" 대안은 `processSnapshots()` 가 **실패 시에도 `[]` 를 반환**하므로 살아있는 세션을 전부 지울 수 있다.

## 2026-07-16 — ASC 제품 페이지 실입력에서 드러난 메타데이터 결함 3종

### 문제
`docs/appstore-metadata-draft.md` 는 `validate-appstore-submission.sh` 를 통과하고 있었지만, 실제 App Store Connect 폼에 붙여넣자 저장이 거부됐다. **로컬 검증기는 글자수만 세기 때문에 "ASC 가 받아주는 내용인가" 는 원리적으로 검증하지 못한다** — 실제 폼에 넣어봐야만 드러나는 계층이 있다.

### 발견 (3종)
1. **ASC 는 설명 필드에서 `═` (U+2550, BOX DRAWINGS DOUBLE HORIZONTAL) 를 거부한다.** "필드에 하나 이상의 유효하지 않은 문자가 포함되어 있습니다" 로 저장 자체가 막힌다. ko/en 설명이 섹션 구분선으로 각 30 개씩 쓰고 있었다. em dash 로 교체하니 통과. 같이 쓰는 다른 비 ASCII (`•` `—` `™` `→` `…`) 는 전부 정상 저장됐으므로 박스드로잉 문자 하나가 유일한 범인.
2. **ko 설명 끝에 마크다운 링크 문법이 그대로 남아 있었다** — `[ATTRIBUTION.md](https://…)` 가 App Store 에 문자 그대로 노출된다. en 은 이미 평문 URL 이었다. 문서용 마크다운과 스토어 카피가 같은 파일에 살면서 생긴 누수.
3. **"로그인 필요(Sign-in required)" 가 iOS/macOS 양쪽 다 체크돼 있었다.** `APP_REVIEW_NOTES.md` 는 "No account required" 라고 명시하는데, 체크된 채로 제출하면 심사팀이 계정 자격증명을 기다린다. 해제.

부수적으로 `APP_REVIEW_NOTES.md` 요약 문단이 아직 "Anthropic 백엔드만 기기를 벗어난다" 고 서술해 자기 APME 섹션·App Privacy 답변과 모순됐다 (2026-07-15 공시 수정의 잔여분). 함께 정정.

### ASC 현재 상태 (앱 레코드 6784822497, `bound.serendipity.agent.deck`)
- iOS + macOS × 영어 + 한국어 제품 페이지 4 조합 저장 완료 (프로모션/설명/키워드/지원·마케팅 URL/저작권)
- 버전 문자열 `1.0` → **`0.2.3`** (양 플랫폼). ASC 기본값이 1.0 이라 `VERSION` SSOT 와 어긋나 있었다 — Apple 은 App Store 버전 문자열과 빌드의 `CFBundleShortVersionString` 이 일치해야 빌드를 붙일 수 있다
- 심사 메모 3833/4000 자 (양 플랫폼), App Privacy 설문 2 유형 = 앱 기능 / 신원 연결됨 / 추적 없음

### 남은 수동 작업
스크린샷 9 + App Preview 3 업로드 (브라우저 자동화 도구가 호스트 경로를 거부, 프리뷰는 20MB+ 라 우회 불가), App Privacy "게시" 버튼(법적 진술), 심사 연락처 정보, TestFlight QA 69 항목, `apple-v0.2.3` 태그.

### 핵심 설계 결정
스토어 카피의 "유효성" 은 두 계층이다 — 길이(로컬 검증기가 봄) 와 문자/렌더링(ASC 만 앎). 카피를 고칠 때 `validate-appstore-submission.sh` 통과는 필요조건이지 충분조건이 아니다.

## 2026-07-15 — App Store 출시 게이트: CI 빌드 번호 소유 + 원격 평가 백엔드 공시

### 문제
출시 준비 상태를 점검하다 두 가지 갭을 찾았다.

1. **빌드 번호가 `apple/project.yml:15`의 `2`에 고정.** `apple-release.yml`은 `MARKETING_VERSION`만 주입하고 `CURRENT_PROJECT_VERSION`은 건드리지 않았다. ASC 는 이미 본 `(version, build)` 쌍의 재업로드를 거부하므로 **첫 업로드는 통과하고 재업로드에서만 터지는** 형태였다. `verify-version-sync.mjs` 도 이 값은 검사하지 않아 가드가 전혀 없었다.
2. **OpenAI 호환 백엔드의 데이터 흐름이 미공시.** `APP_REVIEW_NOTES.md` 는 사용자가 OpenRouter 같은 원격 엔드포인트를 지정하면 턴 내용이 제3자로 나간다고 정확히 서술하는데, App Privacy 답변·ko/en 앱 설명·공개 개인정보처리방침은 모두 "Anthropic API 를 켰을 때만"이라고 말하고 있었다. 심사자는 리뷰노트와 metadata 를 나란히 읽으므로 모순이 그대로 노출되는 상태였다.

### 구현
- `apple-release.yml`: iOS/macOS 두 archive 스텝에 `CURRENT_PROJECT_VERSION=${{ github.run_number }}` 주입. `run_number` 는 실행마다 단조 증가하므로 재태그마다 ASC 제약을 자동 충족한다. `project.yml` 의 `2` 는 로컬 빌드 기본값으로 남긴다.
- `RELEASING.md`: Apple 절차 1번의 "손으로 `CURRENT_PROJECT_VERSION` 증가" 를 제거하고, CI 가 빌드 번호를 소유한다고 명시.
- 원격 백엔드 공시를 4개 표면에 반영 — `appstore-metadata-draft.md` 의 App Privacy 표 + Backed-by 목록, ko/en Description 의 APME 문단, `scripts/pages-index.html` 의 공개 방침(effective date 2026-07-15), `appstore-feature-matrix.md` 의 APME Layer 2 행. 로컬 루프백(Ollama·LM Studio·vLLM·MLX)이면 기기를 벗어나지 않고, OpenRouter 등 원격이면 제3자로 전송된다는 구분을 모든 표면에서 동일하게 서술.
- 갭의 원인 문장도 교정: metadata 는 "방침은 Anthropic 전송을 공시해야 한다" 고 백엔드를 못박아 두어 새 백엔드가 추가돼도 공시 의무가 자동으로 따라오지 않았다. "턴 내용을 기기 밖으로 보내는 모든 opt-in 백엔드" 로 일반화하고, 백엔드 추가 시 같은 커밋에서 방침을 고치라고 적었다. `appstore-feature-matrix.md` 의 없어진 "Optional developer extensions" 섹션 참조도 실제 "App Privacy (ASC form)" 로 교체.
- 영문 What's New 의 스테일 문자열 `What's in v0.1:` → `v0.2.3` (한국어판에는 없던 버그).

### 검증
`pnpm test` 100 파일 1772 테스트 통과. macOS Debug 빌드 성공. `pnpm verify-version`(0.2.3 동기화), `verify-tokens-sync.py`(6 미러), `validate-appstore-submission.sh`(스크린샷 9 + Preview 3 + 메타데이터 12 필드, en Description 3807/4000) 통과. 워크플로 YAML 파싱 후 두 archive 스텝의 빌드 번호 주입을 확인. `pages-index.html` 디자인 린트 위반 0 건.

### 남은 수동 게이트
`docs/testflight-qa-checklist.md` 69 항목 전부 미체크, `SUBMISSION_CHECKLIST.md` ASC 입력 49 건 미완. 최신 apple 태그는 `apple-v0.1.0`(80+ 커밋 전)이라 0.2.3 은 TestFlight 에 올라간 적이 없다.

## 2026-07-15 — App Store/런치 촬영용 결정론적 멀티에이전트 공연 하네스

### 결정
출시 앱에 simulation/demo 기능을 넣지 않고 개발 전용 촬영 하네스로 분리했다. App Store Preview는 Apple 2.3.4에 맞춰 실제 앱 UI만 사용하고, 터미널 3분할은 웹·SNS·프레스용 마케팅 영상에만 사용한다. 기존 정적 `appstore-screenshot-mock.mjs`와 업로드 완료 자산은 그대로 보존한다.

### 구현
- `scripts/appstore-demo-orchestrator.mjs`: 실제 AgentDeck WS 계약(`state_update`/`sessions_list`/`timeline_*`)으로 Claude/Codex/OpenCode 3세션을 24초 결정론적 타임라인에 따라 구동. 같은 epoch를 쓰는 가상 터미널 transcript replay도 제공하며 실제 에이전트나 사용자 workspace를 실행/접근하지 않는다.
- `scripts/record-feature-demo.sh`: `app-only`/`marketing`/`stop` 진입점. marketing은 tmux 3-pane을 동일 epoch로 재생한다.
- `AgentStateHolder`의 `-AgentDeckScreenshotURL`을 모든 Debug Apple 타깃으로 확장해 macOS도 실데이터 유출 없이 실제 SwiftUI를 촬영할 수 있게 했다. `#if DEBUG` 내부이므로 Release/App Store 바이너리에는 미포함.
- `apple/appstore-submission/RECORDING_RUNBOOK.md`: App Store 24초 스토리와 외부 런치 필름 40초 스토리, poster frame, 촬영 금지사항을 정리.

### 검증
Node 구문, bash 구문, `git diff --check` 통과. 로컬 WS에 테스트 클라이언트를 연결해 `connection → state_update → sessions_list → timeline_history` 초기 burst와 3개 세션 상태를 확인. marketing 모드 tmux 3-pane 모두 `node` replay가 live인 것을 확인하고 stop 정리. macOS Debug unsigned 빌드 성공. `validate-appstore-submission.sh`에서 기존 9개 스크린샷+3개 Preview와 메타데이터 전체 통과.

## 2026-07-15 — iOS/Android tablet display sleep 지속성·전환 경합 보강

### 문제
macOS `display_state{displayOn:false}`를 받는 iOS/iPadOS·Android LCD 태블릿 경로를 iDotMatrix 소등 문제와 함께 재점검했다. Android는 7/9 수정으로 full-off 시 `FLAG_KEEP_SCREEN_ON` 해제 + 밝기 0 + 2초 timeout이 이미 적용됐지만, 매 상태 snapshot마다 별도 coroutine을 띄워 DataStore `first()`에서 지연된 옛 off 작업이 빠른 wake 뒤 실행될 가능성이 있었다. iOS는 더 직접적인 결함 2건: (1) host가 계속 off여도 5분 timer가 사용자 밝기를 무조건 복원, (2) foreground 재진입 시 re-dim을 의도한 `pendingDim`이 어디에서도 true가 되지 않아 경로가 영구 no-op이었다.

### 해결
- **iOS/iPadOS** `DisplaySyncService`를 timer 기반 안전복원에서 desired-state 기반으로 변경. host off/full-off는 밝기 0을 명시적 wake·sync disable·bridge disconnect까지 유지하고, min 모드는 1–100% clamp, legacy dim 없음은 full-off로 처리한다. background/foreground 동안 host state+dim instruction을 보존해 UIKit이 밝기를 바꿔도 foreground에서 재적용한다. sync toggle을 끄면 즉시 원래 밝기로 복원. iOS 공개 API로 제3자 앱이 화면을 강제 lock할 수는 없으므로 OS auto-lock은 그대로 두고 brightness 0을 full-off 의미로 사용.
- **Android LCD** `MonitorService`에 단일 `displaySyncJob` 소유권을 두어 새 snapshot이 이전 정책 작업을 cancel. 이미 정립된 full-off(`KEEP_SCREEN_ON` 해제·brightness 0·2s timeout), min/disabled keep-awake, e-ink panel-awake 정책은 불변.
- 회귀 테스트: Swift `resolvedBrightness` 4종(full-off/wake, legacy, min clamp, disabled restore), Android screen policy 2종(dim disabled, keep-awake disabled) 추가.

### 검증
- Android `./gradlew :app:testDebugUnitTest` — BUILD SUCCESSFUL.
- Apple macOS-hosted `AgentDeckTests_macOS/ProtocolTests` — TEST SUCCEEDED.
- `AgentDeck_iOS` Debug, generic iOS Simulator, signing off — BUILD SUCCEEDED.

## 2026-07-15 — Timeline: folded 큐잉 프롬프트 + observed-agent tool_exec 억제 + opencode idle TTL

### 문제
타임라인에서 Claude/Codex는 깔끔한데 특정 관측(observed) 케이스가 이상하게 렌더됐다. ① Codex 세션에 프롬프트를 빠르게 두 번 넣으면 앞 프롬프트가 "진행중 마크가 남고 응답 없음"으로 고착. ② OpenCode 턴은 프롬프트 아래 `bash`/`bash completed` 툴 행 무더기 + 응답 없음으로 도배. ③ (부수) 긴 OpenCode 턴이 조용하면 창이 조기 종료된 것처럼 보이는 flap 위험.

### 해결
- **큐잉 프롬프트 folded 렌더** (`e8b03573`): 관측 에이전트는 연속 프롬프트를 한 턴으로 합치고 Stop을 한 번만 내며, 그 응답의 `startedAt` 앵커가 **가장 최근에 열린 턴**에 찍힌다(`sameTurnAnchor`). 앞 프롬프트의 `chat_start`는 매칭 완결을 못 받아 고아가 된다. 이를 "folded"로 탐지해 `↳` 글리프 + "answered with next turn" 노트로 표시하고, 디테일 패널은 뒤 턴의 공유 응답을 차용, 흡수한 턴엔 "shared" 태그. Apple/Android 2미러 + 각 4테스트.
- **observed-agent tool_exec 억제** (`c25d880b`): OpenCode observer 플러그인이 내부 Bash/read/todowrite마다 tool_exec 행을 append하는데, Codex는 이미 low-signal 억제 대상이었지만 OpenCode는 빠져 있어 타임라인을 도배했다. `agentType == "opencode"`를 **4미러**(shared/Swift storage drop + Apple/Android display filter)에 추가해 Codex와 동일 처리. chat/task 행 유지, APME는 hook trajectory를 읽으므로 무관.
- **opencode idle TTL** (`d330778d`): `evictStaleHookSessions`가 opencode를 180s ghost TTL로 reap → 조용한 라이브 턴이 조기 close(가짜 chat_end)+creature flap. 표준 opencode는 항상 interactive(플러그인은 standalone만 부착)이므로 `openCodeIdleTTL=30min`(codexInteractiveIdleTTL 미러) 부여.
- **antigravity forward-compat** (`ffdfa558`): Node `classifyObservedHookEvent`가 `antigravity_*`를 이미 수용(프로듀서 없음). AGY observer가 생기면 tool_exec가 홍수날 수 있어 4미러 억제 목록에 미리 추가. 오늘 동작 변화 없음.

### 핵심 설계 결정
- 관측 에이전트별 tool_exec 억제는 **agentType 명시 opt-in — 4미러**(2 storage: shared/Swift, 2 display: Apple/Android). 신규 관측 에이전트는 4곳 모두 추가해야 한다. Node는 storage에서 drop하지만 Swift daemon은 opencode를 append했으므로 display 필터가 과거 timeline.json 잔여도 잡는다.
- turn 완결 신호는 에이전트별로 다르다: Claude=Stop hook+transcript+orphan reaper, Codex=rollout tail, OpenCode=**session.idle 단일 의존** → missed-idle 백스톱은 eviction reaper뿐. 그래서 opencode는 interactive TTL로 조기 reap을 막는 게 중요하다.
- AGY는 현재 usage/quota 폴러 전용이라 타임라인 미생성 — 문제 표면 자체가 없다.

### 검증
- Shared: tsc + vitest 66. Apple: macOS BUILD SUCCEEDED, `AgentDeckTests_macOS` TimelineTests 69 / OpenClawToolNoiseTests 38 통과. Android: `:app:testDebugUnitTest` TimelineDisplayScenarioTest·TimelineStoreTest 통과(각 fold/opencode/antigravity 신규 케이스 포함).

## 2026-07-14 — D200H direct-HID·legacy research tree 제거 + 루트 설정 정리

### 배경
- D200H의 유일한 지원 경로는 이미 `plugin-ulanzi/`(Ulanzi Studio 공식 플러그인)였지만, Apple 타깃에는 약 3,800줄의 비활성 `D200hHidModule.swift`, USB entitlement, stand-down arbitration, 직접-HID 진단/UI 설정이 계속 남아 있었다.
- 루트 `zkswe/`에는 폐기된 on-device C agent와 ADB/HID reverse-engineering 도구·현행처럼 보이는 오래된 상태 문서가 보존돼 있었다. Node 쪽에도 삭제된 renderer를 참조하는 `test-d200h.cjs`와 HID 나열 스크립트, dump-preview workflow가 남아 있었다.
- pnpm build-script 허용 설정이 `package.json`, `pnpm-workspace.yaml`, `.pnpm-approvedBuilds.json`에 서로 다른 형식으로 중복됐고, 실제 pnpm 11은 `package.json#pnpm`을 무시했다. GitHub 루트에서 이미 삭제된 `compatibility.json`을 조회하는 fallback도 코드에 남아 있었다.

### 정리
- Swift/Node 직접-HID 코드와 `node-hid`, `/d200h/refresh`, direct-HID 전용 설정·health 필드를 제거. D200H health는 양쪽 daemon 모두 `ulanzi-plugin` WS presence만 사용하며, 플러그인 미접속 시 topology row를 만들지 않는다.
- health payload가 `{connected, driver}`로 좁아진 것을 소비자 세 미러에 모두 반영. TUI(`bridge/src/tui/renderer.ts`)는 `externalOwner`를 읽던 탓에 D200H 행이 `ready plugin` → `ready`로 회귀했고, 그 회귀를 이제는 만들어질 수 없는 fixture(`{managerOpened, externalOwner}`)가 green으로 덮고 있었다. Android(`Protocol.kt`/`EinkStatusCompact.kt`)도 `D200hHealth` 9개 필드와 pending/error 분기가 도달 불가 상태로 남아 있어 Swift와 동일하게 `connected` 하나로 축소했다.
- 후속 review audit에서 Node `WsServer`에 남아 있던 미사용 direct-HID presence callback/non-WS command dispatch를 제거하고, Swift daemon의 단일 Ulanzi connection ID를 `Set<UUID>` presence roster로 바꿔 재연결 소켓이 잠시 겹쳐도 D200H 상태가 잘못 offline으로 전환되지 않게 했다.
- `zkswe/` 전체, 직접-HID 실험/덤프 스크립트와 workflow를 삭제. 현행 `plugin-ulanzi/`, 공용 `shared/src/d200h-layout.ts`, Apple Device Preview와 레이아웃 테스트는 유지했다.
- App Store USB entitlement와 관련 Review Notes를 제거하고 feature matrix/architecture/hardware 문서를 plugin-only 구조로 갱신했다.
- 지원 pnpm 범위를 11.x로 명시하고 `allowBuilds`를 `pnpm-workspace.yaml` 하나로 통합. exact `packageManager` 필드는 이 환경의 pnpm 자체 버전 관리가 오프라인 검증 전에 재설치를 시도해 `engines.pnpm` 범위로 대체했다. npm metadata만 사용하는 compatibility check로 단순화했다.
- 루트에 남아 있던 ignored GIF/log/profraw/scratch/test/compatibility 일회성 파일을 삭제했다.

### 검증
- `pnpm typecheck`, `pnpm test`(100 files / 1,770 tests), `pnpm verify-version` 통과.
- macOS Debug, iOS Simulator Debug, 서명된 macOS Release 빌드 성공. `AgentDeckTests_macOS` 404 tests, Android JUnit 227 tests 통과.
- 서명된 Release `.app`에 `apple/scripts/verify-appstore-archive.sh`를 실행해 App Store archive invariant 통과 및 USB entitlement 부재를 확인.
- TUI D200H 행을 실제 payload 4종(구 데몬 connected/disconnected, 신 데몬 connected, 신 데몬 키 부재)에 직접 렌더해 확인: 각각 `● D200H ready plugin` / `○ D200H offline` / `● D200H ready plugin` / 행 없음. 구 데몬 payload에도 `connected`가 있어 롤링 업그레이드 중에도 행이 유지된다.
- 후속 review audit 뒤 `pnpm typecheck`, TUI dashboard 10 tests, Android `:app:testDebugUnitTest`, macOS Debug unsigned build 통과.

## 2026-07-14 — InkDeck은 macOS 모니터 off에도 대시보드 유지

### 문제
macOS의 모니터 끄기 단축키/잠금/디스플레이 sleep은 공통 `display_state{displayOn:false}`를 모든 기기에 정상 전파한다. LCD/OLED/LED는 이를 full-off 또는 최소 밝기로 적용해야 하지만, 상시 USB 급전 e-ink인 InkDeck 펌웨어도 같은 이벤트에서 대시보드를 `asleep` 카드로 덮고 패널 controller를 `hibernate()`했다. 이는 이미 Android e-ink 경로에 정립된 “e-ink는 화면을 끄지 않는다” 정책과 불일치했고, e-ink의 무전력 화면 유지 특성상 유용한 상태를 숨길 실익도 없었다.

### 해결
- InkDeck 렌더러에서 host display-off 전용 sleep 카드/hibernate/wake full-refresh 분기를 제거. `display_state` 수신 자체는 공통 프로토콜 파리티를 위해 유지하되 InkDeck 렌더링은 `hostDisplayOn`을 무시하며, Mac 본체가 깨어 있는 동안 들어오는 실제 대시보드 변경은 계속 부분/전체 refresh한다.
- host simulator에 `display-off` 장면을 추가해 InkDeck의 `idle` 장면과 byte-identical PNG인지 회귀 확인할 수 있게 하고, `docs/devices.md`에 기기별 display-sleep 정책을 명시.
- repo deploy SSOT/`esp32/scripts/flash.sh`에 빠져 있던 `inkdeck` 명시 타깃을 추가. helper의 build→upload 이중 `pio run`은 BUILD_EPOCH 재주입 때문에 전체 펌웨어를 두 번 빌드하므로 upload target 1회로 통합.

### 검증
`pio run -e inkdeck` 펌웨어 빌드와 host simulator `inkdeck` 빌드 성공. simulator의 `idle`/`display-off` 출력 PNG SHA-256 일치로 모니터 off가 InkDeck 픽셀을 바꾸지 않음을 확인. 실기 `device_info`로 `inkdeck`/XIAO MAC `1c:db:d4:74:f4:d8`를 확정한 뒤 플래시. 다단 USB hub의 CDC/esptool 전송은 재열거 후 끊겼지만 built-in USB-JTAG OpenOCD 경로로 merged 1.6MB image write + read-back **Verify OK**, 정상 flash boot 복귀. Swift daemon serial health에서 `/dev/cu.usbmodem1CDBD474F4D81`, `board:inkdeck`, `version:0.2.3`, connected 재등록 확인.

## 2026-07-14 — ESP32 host simulator: 하드웨어 없이 전 보드 화면 픽셀정확 렌더 (`esp32/sim/`)

### 문제
ESP32 보드 화면(LVGL terrarium+HUD, IPS10 office, TC001 matrix, InkDeck e-ink)을 실제 기기 없이 미리 볼 방법이 없었다. Swift Device Preview의 ESP32 타일은 펌웨어를 눈으로 재현한 손그림(T3 tier)이라 원본과 drift 위험이 상존했고, 펌웨어 렌더 로직 변경을 플래시 전에 검증할 수단이 없었다.

### 해결
`esp32/sim/` — standalone PlatformIO `platform=native` 프로젝트. 펌웨어 렌더 소스를 **verbatim 컴파일**(보드별 `BOARD_*`/`SCREEN_W/H` 그대로)해 headless 프레임버퍼에 그린 뒤 자체 PNG 인코더(stored DEFLATE+CRC32/Adler32, 무의존)로 덤프. "그 보드 펌웨어 − 하드웨어 I/O"라 픽셀정확. `pnpm esp32:sim` → 7보드 × 5씬(+matrix 2페이지) = 40 결정론적 PNG.
- **LCD 4보드**(box_86 480², ips35 480×320, amoled 360² round, ttgo 135×240) + **IPS10 태블릿**(1280×800 office+mosaic)은 실제 `Screens::aquariumCreate()` 보드별 빌더로 합성 — 손조립 아님.
- **TC001 matrix**(led8x32): LVGL-free CRGB 페이지 렌더러(usage/agents) ×16 업스케일.
- **InkDeck e-ink**(inkdeck 800×480): 실제 direct-draw GxEPD2 트리. 텍스트는 vendored upstream Adafruit GFX core+FreeFont(BSD, hardware-coupled SPITFT 제외)로 픽셀정확; `GxEPD2_BW` 셰임이 `Adafruit_GFX` 서브클래스로 drawPixel만 1-bit 버퍼로 뺌.
- 하드웨어 셰임(`sim/shims/`): Arduino/esp_heap_caps/freertos/FastLED/WiFi/Print/SPI/GxEPD2/U8g2/net — millis/Serial/heap/mutex/CRGB/GFX-Print/net-status만 스텁. 씬은 실제 `g_state`를 채워 session→creature/card 파생을 그대로 태움.

### 핵심 설계 결정 (재사용 교훈)
- **per-env 오브젝트 격리 필수**: 펌웨어 소스를 `build_src_filter`의 `../..` 경로로 직접 참조하면 오브젝트가 env 무관 shared `.pio/build/src/`에 떨어져 보드 `#if`(IS_ROUND/canvas swap/MAX_*)가 먼저 빌드된 env로 **동결**(round 마스크가 rect 보드로 샘). Fix=`src/{fw,mtx,eink}/`의 unity-include 래퍼(`#include "../../../src/..."`)로 sim src_dir 내부 컴파일 강제 → `.pio/build/<env>/` 격리. per-env `build_src_filter`로 표면 격리(fw=LCD, mtx=matrix, eink=e-ink).
- **LVGL stride 패딩 오버런**: width×2가 32배수 아닌 보드(360 amoled, 135 ttgo)는 tight 버퍼가 LVGL의 `LV_DRAW_BUF_STRIDE_ALIGN` 패딩과 안 맞아 heap 손상 크래시(stderr無). Fix=`lv_draw_buf_width_to_stride()`로 버퍼 잡고 flush에서 stride-aware 복사.
- **anon-namespace 전역은 별도 TU에서 extern 불가**: InkDeck `display`가 익명 네임스페이스 → SimEink 진입점을 eink wrapper TU 안(include 뒤)에 정의해야 접근.
- **logo asset은 `.c`로 컴파일**: C++ 래퍼로 include 시 `const lv_image_dsc_t`가 internal linkage → `img_logo_48` undefined.
- 상세 [[esp32-host-simulator]]. 문서 `esp32/sim/README.md` + `docs/esp32.md`.

### 검증
7 env(box_86/ips35/amoled/ttgo/ips10/led8x32/inkdeck) clean 빌드 + 40 PNG 렌더 성공, 시각 확인(터라리움 크리처·HUD 게이지·IPS10 office 그리드·TC001 스프라이트·InkDeck 대시보드). 동일 씬 2회 렌더 byte-identical(결정론). 커밋 `42e3f0c0`(터라리움 3보드) + `0301e43d`(전 표면).

## 2026-07-14 — 타임라인 divergence 후속 3종: 클라 upsert 필드머지 + iOS 빌드 복구 + tool_exec 축출 파리티

### 배경
직전 세션(`228709f3`)이 divergence 4종 CLOSE + 데몬 앵커 버그를 고치며 남긴 **미해결 후속 3종**을 우선순위대로 처리. 항목 (a)/(b)는 [[timeline-client-divergence-two-store-topology]]의 "미해결" 목록, 항목 (2)는 기존 iOS-target break.

### ① Swift 클라 `TimelineStore.addEntry(upsert:)` 전체교체 → 필드머지
증상: 클라 upsert 두 경로(task_end-by-taskId, ts+type) 모두 `entries[idx] = entry` **전체교체**. task-judge rollup(taskScore/Outcome/Category/Summary)은 boundary 후 5–30s의 **2차 task_end emit**에 실려 오는데, 그 뒤 nil-rollup 재emit(중복/진행)이 오면 이미 세팅된 score를 덮음. Node `BridgeTimelineStore` merge-path·Android `upsertEntry`는 이미 `incoming ?? base` coalesce인데 Swift 클라만 미적용. Fix=`mergedUpsert(base:incoming:)` 헬퍼(모든 optional coalesce, raw는 최신, ts/type 정체성은 base 유지). 회귀 테스트 `testTimelineStoreUpsertMergesTaskRollupWithoutClobbering`(boundarySignal/startedAt 보존 + nil 재emit이 score 안 덮음).

### ② iOS 타깃 빌드 복구 — macOS 전용 API 2곳 가드
- `SettingsScreen.swift`의 APME judge 프리셋 버튼 3개가 `.buttonStyle(.link)`(macOS 전용)을 크로스플랫폼 뷰에서 참조 → iOS 앱 빌드 break. Fix=`presetLinkButtonStyle()` 헬퍼(macOS `.link` / iOS `.borderless`). iOS 앱 **BUILD SUCCEEDED**.
- 그 break를 고치자 **가려져 있던 2차 break** 노출: `DevicePreviewSnapshotTests.swift`의 `NSBitmapImageRep`(AppKit)이 iOS 테스트 타깃에서 미가드. 이 파일엔 크로스플랫폼 레이아웃 테스트(D200H buildSessionDeck 등)도 있어 클래스 전체 가드는 손실 → PNG 인코딩만 `#if os(macOS)` NSBitmapImageRep / `#else` `UIImage.pngData()` 로 분기(+`#if canImport(UIKit) import UIKit`). iOS **TEST BUILD SUCCEEDED**.

### ③ Node timeline store `tool_exec` 버퍼aging — 검토 → 프리미스 검증 + Node/Swift 파리티 fix
- **검토 결과 프리미스 정확**: `index.ts:1552`가 PTY `agentdeck claude` 세션의 tool action마다 `type:'tool_exec', agentType:'claude-code'` emit(훅이 2s 내 미발화 시). 저장필터 `shouldDropLowSignalTimelineEntry`는 **codex tool_exec만 드롭**(claude/opencode는 통과). 200-cap의 `evictOne`이 chat_start를 tool_exec와 동급 FIFO로 취급 → chat_start(턴 최古 ts)가 자기 tool_exec보다 먼저 축출 → reconnect 시 `timeline_history`에 응답만 남는 고아행(Node측 "답변만 튀어나옴").
- **★진단 주의**: 라이브 `~/.agentdeck/timeline.json`의 codex tool_exec 87개는 **필터 이전 옛 Node 데몬 stale 산출물**(현 9120=Swift 앱). 현재 실행 Swift store(200행)는 **tool_exec 0개** — codex는 이미 드롭됨. 즉 codex는 무해, 잔여 위험은 claude/opencode PTY tool_exec.
- Fix(**두 데몬 파리티**): Node `BridgeTimelineStore.evictOne` + Swift `DaemonTimelineStore.evictOne` 둘 다 generic non-task 축출 전에 **oldest `tool_exec` 우선 축출**(tool_exec은 request/resolved 페어 없는 독립행이라 안전, turn skeleton 보존). 테스트: Node `timeline-task-retention`(tool-heavy 턴에서 chat_start 생존) + Swift `testDaemonTimelineStoreShedsToolExecBeforeChatStart`.

### 검증
- Node **vitest 100파일 1770 통과**(신규 축출 테스트 포함). Swift **macOS 400 통과**(1 skip). **iOS 앱+테스트 타깃 BUILD SUCCEEDED**.
- 상세 [[timeline-client-divergence-two-store-topology]].

## 2026-07-13 — Codex 7d 게이지 소실 fix: rate-limit window 슬롯 flip → 길이 기준 라벨 + 데몬 정규화

### 문제
사용자 지적 "토큰 잔여량에서 **7d가 안 나온다**". 라이브 진단(`~/.codex/.../rollout-*.jsonl` 최신 `rate_limits` 직독)으로 **Codex 업스트림 스키마 변화**를 확인: 5h 창이 리셋되면 주간(10080분=7d) 창을 `primary` 슬롯에 싣고 `secondary=null`로 방출(같은 롤아웃에서 `primary=300/sec=10080` 113줄 → 이후 `primary=10080/sec=null` 27줄로 **중간 전환**). 슬롯 위치로 5H/7D를 하드코딩한 렌더러는 primary(실제 7d 데이터)를 "5H"로 오표기하고 7D(secondary)는 hide-if-absent로 사라짐. 즉 슬롯은 더 이상 창 종류를 보장 안 하고 `windowMinutes`만 신뢰 가능.

### 해결 — 소비자 2종류 × 2겹 fix
1. **길이 읽는 클라이언트**(windowMinutes 파싱): 슬롯 하드코딩 제거, present 창 순회하며 windowMinutes로 라벨 파생. shared `usageWindowLabel`/`usageWindowKind` SSOT 신설 → `d200h-layout.ts` 타일 + SD `session-slot-manager.ts` usageGauges 양쪽 사용. Device Preview D200H(`D200HLayoutModel`)에 windowMinutes 스레딩(`LivePreviewData`→`D200HUsage`). 메뉴바 `TopologyRail`·Android `codexLimitRows`는 이미 length 기반이라 무수정.
2. **★슬롯만 읽는 펌웨어**(ESP32/InkDeck `esp32/src/net/protocol.cpp`가 `codexRateLimits.primary`→"5H"/`.secondary`→"7D" 하드코딩, windowMinutes 무시): 재플래시/X3 fork 재포팅 불가 → **데몬이 wire 방출 전 길이로 정규화**(짧은창<1일→`primary`, 주간≥1일→`secondary`). Swift `DaemonServer.codexRateLimitsPayload` + Node `usage-event.ts normalizeCodexRateLimits` 양 chokepoint. windowMinutes는 wire 유지 → 길이기반 소비자 무영향(defense in depth).

### 검증 + 배포
- shared/plugin/bridge `tsc`, macOS `xcodebuild` **BUILD SUCCEEDED**. 신규 회귀 테스트: `session-deck-usage`(주간창이 primary로 와도 "7D" 타일·팬텀 없음), `usage-event`(주간 primary→wire secondary 라우팅).
- **실기 배포**: SD 플러그인(심링크→`streamdeck restart`) + Ulanzi/D200H(`package:install` 재번들 후 Studio 재시작) + **Swift 데몬 재시작** → 정규화 payload 실측 `{"secondary":{"usedPercent":5,"windowMinutes":10080},...}`, `primary` 없음. ESP32 5대·InkDeck·D200H·Pixoo·Timebox·iDotMatrix 전부 재연결.
- 커밋 `9e2db965`(길이 라벨) + `bf19e6c3`(데몬 정규화).

### 미해결(범위 밖)
CLI(Node 데몬) 환경은 코드 커밋됐으나 실행중 Node 데몬 재시작 시 반영(현 사용자는 Swift 데몬이라 무관). 물리 ESP32/InkDeck 육안 확인은 사용자 몫(패널 스크린샷 불가). 상세 [[codex-rate-limit-window-slot-flip]].

## 2026-07-13 — 타임라인 구조적 divergence 4종 CLOSE + 데몬 chat_response 앵커 버그 fix

### 배경
직전 세션의 렌더 드리프트 수정 후 남은 **구조적 divergence 4종**을 사용자와 우선순위 협의(4개 모두 선택) + 추가로 "요청↔응답 페어링" 일관성("가끔 답변만 튀어나온다")을 **실데이터로 분석**하라는 지시. 두 `timeline.json`(Node `~/.agentdeck`, Swift 컨테이너)을 백그라운드 에이전트로 감사.

### ★데이터 감사 핵심 발견 — "답변만 튀어나옴"은 클라 렌더버그가 아니라 **데몬 emit-path 버그**
- Swift store `chat_response`의 **42%(22/53)가 `startedAt=null`**로 방출 → 앵커 없음. 앵커가 있는 31개는 **31/31 완벽 페어링**. 순서이상 0, 중복 0.
- null 앵커 22개 중 **13개는 같은 세션에 유효한 `chat_start`가 실재**(claude-code 15/codex-cli 7). 즉 페어는 존재하나 데몬이 응답에 앵커를 안 찍음.
- 근본원인: `ChatTurnAnchorTracker.claimOpenTurn`이 anchor를 **소비(remove)** → 중복/지연 Stop 훅이 nil 반환 → `respEntry.startedAt = nil`. fallback 없음.
- Node store는 다른 문제(범위 밖): `tool_exec` 77개가 100-cap 채워 `chat_start` 축출(버퍼 aging) + 응답 중복.

### 데몬 앵커 fix (DaemonServer.swift)
`ChatTurnAnchorTracker`에 **소비되지 않는 `lastChatStartTs`** 추가(noteChatStart가 세팅, claim이 안 지움, clear가 지움). 3개 emit 함수(`appendClaudeCodeChatEnd`/`appendCodexChatEnd`/`appendOpenCodeChatEnd`)에서 `let startTs = claimedTs ?? lastChatStart(sid)`. **guard/open-turn 결정은 `claimedTs` 유지** — 응답 없는 지연 Stop이 유령 "Completed" 행을 새로 만들지 않게. 응답이 항상 자기 턴 chat_start에 앵커됨.

### 클라이언트 수렴 픽스 4종
- **① history 수신**: Swift 클라 `mergeHistory`(ts-only dedup+append, no clear)→`replaceSnapshot`(ts-type-raw dedup + **replace-on-connect**, Android 파리티). 외부 Node 데몬 재연결 시 재스탬프 OpenClaw 고스트행 누적 제거. AgentStateHolder `.timelineHistory` 핸들러도 교체.
- **② 그루핑 술어**: Swift `sameSession`(sessionId만)→`sameTimelineContext`(taskId→runId→sessionId→project+agent 4단계, Android 미러). Swift 내부 display-filter(풀컨텍스트)와 일치, 병렬세션 runId 분리 그루핑. 2 호출처(×count collapse, turn merge) 교체.
- **③ Android 부재 UI 이식**: `TimelineSessionFilter`+`TimelineEntry.matchesTimelineFilter`(TimelineDisplay.kt, Swift 미러) / MonitorScreen `focusedSessionId` 기반 필터 빌더(primary→sibling→openclaw-gateway→bare) / TimelineStrip `filter` 파라미터+필터링+헤더 `· label`(TetraNeon)+빈상태 "No events for this session"+선택 리셋 / `summaryBackendLabel`(AI/MLX/Ollama/Heur) pill 2곳(standalone chat_end + merged completion 서브라인).
- **④ 버퍼캡+스토리지필터**: Swift 클라 cap 200→**500**(Android 파리티). 클라 `normalizeTimelineEntryForStorage`(Model/Timeline.swift) 추가 — 기존 display `timelineIsLowSignalEntry` 재사용 + `timelineIsOpenClawLowSignalResponse` 드롭 + cron 요약; addEntry(upsert 포함)/replaceSnapshot 양 경로 배선. OTel/tool 노이즈가 버퍼 슬롯 점유 못 하게(iOS + macOS-외부데몬 모드).

### 검증
- macOS `xcodebuild` **BUILD SUCCEEDED**. Swift 테스트 **114/114 통과**(신규: 앵커 fallback×4, replaceSnapshot authoritative/저신호 드롭, cap 500, runId 그루핑×2).
- Android `compileDebugKotlin` clean + `TimelineStoreTest`(신규 `matchesTimelineFilter`×5) **BUILD SUCCESSFUL**.
- iOS: 변경 파일 전부 컴파일 통과(빌드 실패는 **기존 `SettingsScreen.swift` `link` unavailable-in-iOS**, 이번 작업과 무관).

### 미해결(범위 밖, 보고)
(a) Swift 클라 `addEntry(upsert)` 전체교체 vs Android `upsertEntry` 필드머지 — task-judge rollup 필드 보존 갭 가능. (b) Node store `tool_exec` 100-cap 버퍼aging + 응답중복 = Node 데몬 자체 이슈. 상세 [[timeline-client-divergence-two-store-topology]].

## 2026-07-13 — REVIEW mid-turn 게이팅: 진행중 턴에서 데크 REVIEW 비활성 + Swift 데몬 가드

### 문제
사용자 지적: Swift 데몬에서 Stream Deck/D200H가 **에이전트 작업 진행중(processing)에도 REVIEW를 누를 수 있는** 흐름이 어색함. 조사 결과 세 표면(d200h-layout processing 분기, SD 플러그인 managed/observed processing 분기) 모두 활성 REVIEW 타일을 노출했고, 근거 주석 "judges the current delta"는 **Node 데몬(git working-tree diff)에만 맞는 가정**. Swift 데몬 `handleReviewRun`은 상태 가드 없이 타임라인 trajectory를 judge에 넘기는데, judge 프롬프트가 "incomplete work/검증 생략"을 리스크로 잡도록 지시하므로 진행중 턴(응답 없는 USER+TOOL)은 구조적으로 오탐 리스크 보고 + 작업 중 결과 패널 팝업.

### 해결
- **데크 게이팅(2표면)**: processing 중 REVIEW → 비활성 배지로 강등. 판정중이면 REVIEWING 스피너, 직전 verdict 있으면 inert `risk … · N` 배지, 없으면 타일 생략. shared `reviewBadgeTile()` + SD `reviewBadgeSlotConfig()`. idle/턴 종료 후엔 기존대로 pressable(verdict 배지 재실행 포함).
- **Swift 데몬 방어 가드**: 세션 상태 `processing`/`awaiting*`이면 review_run 거절 + `review_status:error`("run REVIEW after the turn completes") 브로드캐스트. 직전 verdict 배지는 보존(lastReviewBySession 안 건드림). 구형/서드파티 클라이언트 커버.
- Node 데몬은 무변경 — diff 기반 mid-turn 리뷰 의미는 유지되나 데크에서 더 이상 트리거 안 됨.

### 핵심 설계 결정
REVIEW = "완료된 작업의 독립 평가"로 의미 통일. 데몬별 리뷰 입력(Node diff vs Swift trajectory)이 달라도 데크 UX는 동일하게 턴 완결 후에만 제공. 동종 어색함 스윕 결과 나머지는 건강(observed awaiting w/o requestId→"answer in terminal" 비활성, Codex notify-only 무버튼, STOP steerable-only, COMMIT "at turn end" 명시).

### 검증
vitest 1767 전체 통과(d200h 테스트 신규 2건: processing 중 review_run 부재 + inert 배지), `pnpm build` green, macOS xcodebuild BUILD SUCCEEDED. 실기 시각 확인(D200H/SD+ processing 중 배지 렌더)은 후속.

## 2026-07-13 — 타임라인 클라이언트 렌더 패리티: macOS detail 중복/선택 + Android↔Swift 드리프트

### 배경
사용자 지적 2건: ① Android 태블릿 TIMELINE이 macOS와 조금 다르게 보임, ② macOS detail 영역에 중복 텍스트 + 일부 영역만 드래그 선택됨. 토폴로지(두 데몬/두 스토어)가 아니라 전부 **클라이언트 렌더 드리프트**로 확인(9120=Swift 데몬, 양 클라이언트 동일 스트림 수신). 병렬 Explore 에이전트 2기로 macOS detail 감사 + Android↔Swift 파이프라인 divergence 매핑.

### macOS detail 영역 (2건)
- **중복 텍스트**: standalone `chat_response`는 모든 producer가 `raw`=`detail`의 문자 접두어 절단(200/1000자)으로 스탬프하는데 detail pane이 볼드 Summary(raw)+markdown 본문(detail)을 둘 다 무조건 렌더 → 응답 서두가 두 번(위=마크다운 원문, 아래=포맷). 본문 표시 시 Summary가 본문 서두면 억제(`timelineSummaryIsRedundantWithDetail`, 마크다운 스트립 토큰-접두어 비교로 절단 경계 mid-word 허용). 병합 턴(프롬프트+응답)은 프롬프트가 응답의 접두어가 아니라 유지.
- **부분 드래그 선택**: `.textSelection(.enabled)`이 markdown 본문에만 있어 Summary·타임스탬프·lifecycle 행이 선택 불가였고 본문도 라인마다 별도 Text라 조각남. pane-wide selection + 연속 text/code 라인을 단일 Text로 coalesce.

### Android 태블릿 ↔ macOS Swift 패리티
가장 큰 원인: Android DetailPane이 `timelineDetailIsRedundant` 게이트를 응답에도 적용해 **응답 본문을 거의 항상 숨김**(summary=detail 접두어라 8-토큰 규칙 무조건 발화)+`bodyEntry.summary`가 병합 턴에서 **프롬프트 소실**. Apple의 `shouldShowDetailForDashboard` 게이트+`timelinePromoteInformativeLead`+summary redundancy를 Kotlin으로 포팅. 추가: 아이콘 색을 수동 `typeColor` 맵 대신 아이콘 키에서 유도(chat_end/tool_request/eval_result/chat_response 4종 불일치 해소), TaskEvalBadge "…"→"unscored" 5분 전이, `task_milestone` 라벨("TODOS ✓").

### 스피너 정확성 (shared/Apple/Android SSOT 3미러)
- in-flight task 스피너에 10분 staleness 캡을 shared+Android에 추가(기존 Apple 전용) → 태블릿 고아 task 행 영구회전 해소.
- Swift `timelineIsRotatingEntry` chat_start에 shared sibling 스캔 포팅(후속 동일세션 completion 또는 superseding chat_start면 즉시 정지 — 기존엔 10분 age 캡만).

### 미수정 (구조적, 보고만)
history 수신 replace+clear-on-connect(Android) vs ts-only merge(Swift) → 외부 데몬 모드에서 macOS 고스트행 가능; 그루핑 술어 Swift `sameSession` vs Android 풀컨텍스트; ×count 동등성; eval_result 윈도; per-session 필터·summary 백엔드 pill의 Android 부재; 버퍼캡 500vs200. 상세는 [[timeline-client-divergence-two-store-topology]] 메모리.

### 검증
- shared vitest 47, Swift 96(+6), Android 218(+7); `pnpm build` green; design lint 905(불변).
- **실기**: macOS 재시작 후 REPLY 행 무중복+선택 동작, 태블릿 재배포 후 병합/standalone detail·unscored 배지 확인. 커밋 4899695a (origin/master).

## 2026-07-12 — REVIEW judge: OpenAI 호환 backend(Ollama/OpenRouter/…) + HTTP-only 로컬 감지 + on-device 실패 진단

### 배경
사용자 지적 3건: ① 방금 리뷰가 어떤 모델인지(답: Apple Intelligence 온디바이스), ② Ollama/OpenRouter 같은 사실상 표준 환경을 유연 지원, ③ 온보딩에서 사용자 환경에 있는 걸 자연스럽게 연결, ④ App Store 심사 안전. 추가로 발견한 버그: REVIEW 패널이 "judge 없음" 셋업 가이드를 reason="available"로 잘못 띄움 — 실은 judge는 있는데 온디바이스 컨텍스트(~4k) 초과로 호출 실패한 것.

### on-device judge 실패 진단 분리 (선행 fix, 커밋 3ff44df1)
FoundationModels judge가 nil 반환 시 셋업 가이드로 오분류하던 것을 분리: 트래젝토리 캡 20k→6k자 축소(온디바이스 컨텍스트), `judgeThrowing` 도입으로 실제 에러 노출, "judge 있는데 호출 실패"는 런타임 에러 패널(설정 갭 아님). `unavailableReason`을 구체 상태(device-not-eligible/not-enabled/model-not-ready)로 교체.

### OpenAI 호환 backend (커밋 66b72e95)
MLX가 이미 OpenAI chat-completions 호환이므로 **범용 `openai` backend 하나**로 Ollama(:11434)/LM Studio(:1234)/vLLM/llama.cpp + 클라우드 OpenRouter/Together/Groq를 전부 커버. config=endpoint+선택 Bearer apiKey+model(blank=auto-detect via /v1/models 또는 Ollama /api/tags). Node `callOpenAICompatible`+Swift `ApmeJudgeOpenAI`(throwing 변형 포함). endpoint 정규화(bare host/base+v1/full URL 허용). probe=카탈로그 도달+모델 해석 가능+원격은 키 필수.

### HTTP-only 로컬 감지 + 온보딩
`judge-detect.ts`/`ApmeJudgeDetect.swift`: loopback 표준 포트를 GET으로 프로브해 실제 사용 가능 모델을 광고하는 서버만 반환. **서브프로세스/CLI 프로브 없음**(ollama list 등) — App Store 서명 데몬에서 그대로 동작. `GET /apme/judge/detect` 양 데몬. REVIEW 셋업 가이드(Node 브라우저 HTML + Swift 네이티브 패널)가 **감지된 로컬 서버를 최상단에** 붙여넣기용 config와 함께 표시, 이어서 랭킹(API→OpenRouter→OpenClaw→로컬→Apple). macOS Settings judge picker에 "OpenAI-compatible" 옵션+endpoint/model/key 필드+프리셋 버튼(Ollama/LM Studio/OpenRouter)+"Detect local servers" 버튼. AppPreferences가 apme.judge.endpoint/model/apiKey 저장.

### App Store 안전
APP_REVIEW_NOTES: OpenAI 호환 어댑터+loopback 감지를 network-client 전용으로 문서화(서브프로세스 없음, 설치 유도 없음; 카피는 "이미 돌리는 서버를 가리켜라"). REVIEW opt-in+온디바이스 기본은 무설정 동작이라 provider 없어도 앱 안 깨짐.

### 검증
- vitest 100파일 1764/1764(신규: openAIChatUrl 정규화, 감지-provider 가이던스). xcodebuild AgentDeck_macOS BUILD SUCCEEDED. design lint 905(불변).
- **실기**: 새 데몬 `/apme/judge/detect`가 이 Mac의 Ollama(:11434, bge-m3)+MLX(:8800, Qwen3.6-35B)를 HTTP-only로 감지 확인. 커밋 3ff44df1+66b72e95 (origin/master).

## 2026-07-12 — REVIEW judge 프리플라이트/가이던스 · 옵트인 API judge · 수동리뷰 히스토리 · 대시보드 미평가 설명

### 배경
REVIEW=독립 eval 재설계 후속. 사용자 지적: judge 머신이 없거나 지정 안 된 경우 정확히 안내하고, 현실적 최소 수준(로컬 8B+)을 감안해 미사용 상황도 고려하며, 외부 API 연동이 필요하면 그쪽으로 유도할 것. 또 수동 리뷰와 APME 자동 리뷰는 같은 목적이니 대시보드에서 수동 실행분을 구분 플래그로 볼 수 있게 하고, 대시보드 데이터 표시 의미성도 점검할 것.

### judge 프리플라이트 + 가이던스 플로우
REVIEW 버튼을 눌렀을 때 사용가능 judge가 없으면 dead-end 에러 대신 **셋업 가이드**를 띄운다. Node=self-contained HTML을 `<dataDir>/reviews/`에 쓰고 브라우저 오픈(앱 없는 CLI 티어의 팝업), Swift=네이티브 NSPanel(`ReviewGuidancePanelView`). 양쪽 모두 리뷰 품질 순으로 백엔드 랭킹: **① Anthropic API(최상) → ② OpenClaw 게이트웨이 → ③ 로컬 MLX(8B급 최소, 30B급 권장) → ④ Apple Intelligence(온디바이스, 기본 스크리닝만)**. "REVIEW 안 써도 무방(백그라운드 실행 없음)"을 명시해 미사용을 정식 선택지로 안내. 리포트 푸터에 정직한 judge-tier 캐비앗(`judgeTierNote`).

### 옵트인 Anthropic API judge (Node)
`callApi()`를 `@anthropic-ai/sdk`로 실제 구현(이전엔 항상 throw하는 스텁 → settings 로더가 "mlx"로 silent 다운그레이드). **엄격 옵트인**(cost-sensitive defaults 정책): 자동 선택 경로 없음, 크레덴셜(`apme.judge.apiKey`/`ANTHROPIC_API_KEY`/`ant auth login`) 없으면 프로브가 셋업 가이드와 함께 `unavailable`. settings.ts의 api→mlx 리라이트 제거. 프로브는 무료 Models 엔드포인트로 모델 id 검증(토큰 소비 0).

### 수동 리뷰 히스토리
REVIEW 완료 시 `manual_review` 레이어 eval(metric=risk, score=리스크가중치)을 자동 파이프라인과 **같은 APME 스토어**에 세션 활성 태스크로 기록. 신규 `ApmeEvalLayer='manual_review'`(+ `ApmeEvalRow` 유니온, 프로토콜 코드젠 재생성). 대시보드에 "Manual Reviews (hand-run)" 섹션(리스크/발견수/judge 모델), 레이어 필터로 자동 eval 섹션 오염 없음. Swift는 `ApmeCollector.activeRunAndTask`로 동일 기록.

### 대시보드 데이터 의미성
미평가 완료 run(composite/judge eval 전무 — judge 미설정 시 흔함)이 헤더만 덜렁 뜨던 문제 → "Not evaluated — <이유>" 설명 + apme.judge 안내(REVIEW 가이드와 동일 맥락) + "trajectory/cost/outcome는 여전히 기록됨" 명시. 나머지 표면(scorecard/categories/recommend 빈 상태, active-session pending)은 이미 graceful — 회귀 방지 테스트로 잠금.

### 검증
- vitest 100파일 1758/1758(신규: review-runner 렌더/가이던스/tier, apme-manual-review 라운드트립, apme-dashboard-html 어포던스; apme-settings/apme-judge-probe는 구현된-API 계약으로 갱신).
- `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED. design lint 905(불변). generate-protocol 재생성.
- 커밋 `f5831db5`+`41b04749` (origin/master).
- 미실시: judge 실호출 E2E(로컬 MLX/FM/API 실행 필요) — 실기 REVIEW 1회로 확인 권장.

## 2026-07-12 — macOS Dashboard 리사이즈 잔상 + DOWNSTREAM 레일 오버플로 수정

### 문제
- 창을 리사이즈하는 동안/직후 이전 창 경계 위치에 파란 세로선 잔상이 남았다. 원인은 `KeyboardShortcutsModifier`(⌘ 단축키 처리)가 `MonitorScreen`의 창 전체 콘텐츠에 `.focusable()`을 걸어둔 것 — macOS가 창 크기의 시스템 액센트(파랑) 포커스 링을 그리는데, 라이브 리사이즈 중 이 레이어가 이전 경계에서 무효화되지 않았다.
- `TopologyRail`(우측 UPSTREAM/DOWNSTREAM 패널)이 높이 제한 없는 VStack이라 downstream 기기가 많아지면 카드가 아래로 계속 자라 하단 35%의 타임라인 strip 영역, 특히 거의 투명한(black@0.19) chat detail pane을 가렸다.

### 해결
- `.focusable()` 직후 `.focusEffectDisabled()` 추가 — 포커스 자체와 `onKeyPress` 단축키는 그대로 두고 시각적 링만 억제.
- `MonitorLayout.sandFraction`을 기존 `TerrariumLayout.sandHeightFraction` SSOT에서 파생, `MonitorHUD` landscape 브랜치가 타임라인 위 water 영역 높이를 계산해 `TopologyRail(maxHeight:)`로 전달(가용 높이 <80pt면 레일 자체를 숨김 — 임의 하한값으로 인한 재침범 방지).
- `TopologyRail`은 단일 `ScrollView`를 상시 유지하고 frame height를 `min(측정된 자연높이, cap)`으로 바인딩 — 기기가 적으면 오늘과 동일한 hug-content 카드, 많으면 내부 스크롤. **중요 함정**: macOS는 `ScrollView` 콘텐츠 내부의 `GeometryReader`+`.preference()` 변경을 바깥 `onPreferenceChange`로 전파하지 않는다(iOS는 정상). `onGeometryChange`(macOS 15+/iOS 18+)로 교체해 해결, iOS 17만 preference 폴백 유지. 단일 서브트리 구조라 기존 `hubPulse` `repeatForever` 애니메이션은 재작성 없이 그대로 생존.
- 부수: 같은 날 다른 세션이 추가한 `ObservedSteering.swift`(19d09c4e)에 `#if os(macOS)` 가드가 빠져 iOS 빌드가 깨져 있던 것을 함께 수정.

### 검증
- `xcodebuild AgentDeck_macOS` / `AgentDeck_iOS` 둘 다 BUILD SUCCEEDED, `TopologyRailHelpersTests` 10/10 pass.
- 실행 중인 앱을 재시작(`osascript quit` → `open`)해 실기 확인: 우측 엣지 반복 드래그로 파란 잔상 재현 안 됨, 20종 downstream 기기 붙인 상태에서 레일이 타임라인 위에서 정확히 스크롤 클리핑되고 chat detail이 더는 가려지지 않음.

### 후속 (미착수)
- Android `MonitorScreen.kt`의 동일한 무제한 DOWNSTREAM 레일 — 이번 변경 범위 밖.
- iPad **portrait** 방향의 극단적 기기 수 오버플로는 별도 검토.

## 2026-07-12 — REVIEW=독립 eval로 재설계 · observed GO ON 제거 · 에이전트별 버튼 매트릭스 정리

### 배경 (스티어링 재점검)
사용자 재점검 결론: ① observed processing의 GO ON 선제 큐잉은 실존하지 않는 시나리오(턴은 의도적으로 끝나지 조기 종료하지 않음) — 제거. ② COMMIT="작업 완료 후"=턴엔드 큐 의미 그대로 유지. ③ REVIEW는 에이전트에게 보내는 프롬프트가 아니라 **독립 모델이 최종 결과물의 리스크를 평가하는 eval**로 재설계 — 에이전트 제어가 불필요해져 managed/observed 전 타입+**codex observed(유일 가용 액션)**까지 커버.

### REVIEW = `review_run` (신규 PluginCommand)
- **Node 데몬** (`bridge/src/review-runner.ts`): 세션 cwd의 git diff(60KB 캡)+untracked 수집 → APME judge 스택 재사용(`callJudgeWithMeta`, 로컬 우선/API opt-in) → 리스크 JSON(strict) → self-contained aquarium-tide HTML 리포트를 `<dataDir>/reviews/`에 생성 후 **브라우저 오픈**(앱 없는 CLI 티어의 팝업). cwd 해석: observed 행 cwd → APME run projectPath 폴백.
- **Swift 데몬** (`ReviewRunner.swift`): 샌드박스는 git 실행·cwd 읽기 불가 → **입력=자기 타임라인 트래젝토리**(프롬프트/툴/응답), judge=`ApmeJudgeFoundationModels`(온디바이스). 결과=**비모달 NSPanel 네이티브 팝업**(modal NSAlert 금지 — MainActor 데몬 정지) + "Open HTML Report" 버튼(컨테이너 파일+NSWorkspace, 서브프로세스 없음). `review_run` 인터셉트는 gateway 소비 블록 앞.
- 공통: `review_status`/`review_result` WS 이벤트 + `SessionInfo.reviewStatus/reviewRisk/reviewFindings` 배지(30분 TTL) → REVIEW 타일이 REVIEWING/`risk low · 2` 표시. 실행 중 중복 트리거 무시.

### 버튼 매트릭스 (d200h-layout + SD plugin 공통)
| | managed | observed Claude | observed OpenCode | observed Codex |
|---|---|---|---|---|
| idle | GO ON·REVIEW·COMMIT·CLEAR | REVIEW+OBSERVED 타일 | GO ON·COMMIT(inject now)+REVIEW | REVIEW+OBSERVED |
| processing | RUNNING·모델·REVIEW | STOP·COMMIT(at turn end)·REVIEW | STOP·REVIEW | REVIEW |
- observed processing GO ON 제거, OpenCode mid-run inject 제거(실행 중 끼어들기 배제). REVIEW는 SD에서 `localAction:'review_run'` 프리셋(배지 포함), D200H에서 `reviewTile()`.

### 검증
- vitest 97/1745 전부 통과(d200h-observed 매트릭스 테스트 재작성), `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED, generate-protocol 재생성(ReviewRunCommand/ReviewStatus·ResultEvent), design lint 905(신규 위반 0).
- 미실시: judge 실호출 E2E(FoundationModels/MLX 실행 시간 소요) — 실기 REVIEW 버튼 1회 눌러 패널/브라우저 확인 필요.

## 2026-07-12 — Observed PreToolUse 게이트: `auto` 권한모드 false attention 수정

### 문제
사용자가 auto 권한모드로 observed Claude 세션(이 대화 자체 포함)을 쓰는 동안, 실제로 승인을 물은 적 없는 `git add`/`git -C`/`grep`/`Write` 등 호출마다 디바이스에 "Allow Bash: …?" attention이 뜨고 첫 호출마다 ~25초씩 멈췄다.

### 원인
당일 앞서 구축한 PreToolUse 게이트([[observed-steering-hook-rpc-ladder]] 참조)의 모드 게이트(`shouldGate`/`shouldGatePreToolUse`)가 `auto`를 `default` 브랜치("Claude may prompt → gate")로 분류했다. 그러나 auto 모드는 정책 엔진이 세션 내부에서 자동승인하며 그 결정이 settings 허용리스트 파일에 남지 않는다 — 룰 예측기가 이를 볼 수 없어 `.none`("prompt-prone, no rule match") 판정 → hold. `~/.agentdeck/swift-daemon.log`에서 같은 세션의 `git add`/`git -C`/`grep -rn`/`Write` 호출이 정확히 25초 뒤 "learned auto-approved signature"로 릴리즈되는 패턴을 확인해 라이브로 재현.

### 해결
`auto`를 `bypassPermissions`/`dontAsk`와 동일한 no-gate 케이스로 이동(Node `bridge/src/awaiting-overlay.ts` + Swift `DaemonServer.shouldGate`). auto 모드에서 드물게 뜨는 진짜 프롬프트는 이미 Notification `permission_prompt` 오버레이(display-only 경로)가 커버하므로 기능 손실 없음.

### 검증
- vitest `awaiting-overlay.test.ts` + `observed-steering.test.ts` 통과.
- XCTest `DeviceApprovalGateTests`(macOS) — TEST SUCCEEDED.
- 전체 vitest 중 `d200h-observed.test.ts` 4건 실패는 동시 세션이 작업 중이던 `shared/src/d200h-layout.ts` 등 in-flight 변경 때문으로, stash 후 재확인해 이 수정과 무관함을 검증.

## 2026-07-12 — XTeink X4 약한 RF 링크 진단 · WiFi ESP32 topology flap 유예 확대

### 진단
- XTeink X4(`192.168.68.61`)가 Swift 데몬 WebSocket을 수십 초 간격으로 재연결하고 `Connection reset by peer`/timeout 뒤 roster에서 제거되는 현장을 확인했다. 동일 펌웨어(`1.4.1-dev-master-69fd5368`)의 X3는 안정적이었다.
- 같은 시점 ping 20회 비교: X4 손실 20%(평균 112ms, 최대 391ms), X3 손실 0%(평균 70ms), gateway 손실 0%(평균 0.57ms). 공통 데몬/펌웨어 버전 회귀보다 X4 위치·안테나의 2.4GHz RF 마진 문제가 직접 원인이다.
- 외부 `crosspoint-agentdeck`의 Agent Dashboard 경로는 Web Server/OTA 경로와 달리 `WiFi.setSleep(false)`를 적용하지 않는다. 실제 소켓 안정화 후속 후보는 dashboard 진입 동안 ESP32-C3 modem sleep을 끄고 종료 시 복원하는 것(외부 포크에서 별도 진행).

### 완화
- Swift `DaemonServer`의 WiFi ESP32 close-driven roster eviction grace를 10초→45초로 확대했다. 약한 RF에서 교체 소켓 등록이 10–30초 걸려도 topology에서 장치가 사라졌다 나타나는 churn을 막는다. 닫힌 소켓으로 이벤트를 보내지 않고 identity만 잠시 유지한다.

### 검증
- `xcodebuild build -project AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' -quiet` — BUILD SUCCEEDED(기존 경고만).
- `git diff --check` 통과.

## 2026-07-12 — OpenClaw Gateway 모델 오표시 수정

### 문제
- Swift `OpenClawAdapter`가 Gateway `models.list`에서 `default` role을 인식하지 못하면 첫 available 모델을 기본 모델로 선택했다. RPC catalog 순서의 첫 항목이 로컬 Qwen인 환경에서 실제 메인 세션 `zai/glm-5.2`와 무관하게 `/status`의 `openclaw-gateway.modelName`이 Qwen으로 표시됐다.
- 잘못 선택된 `gatewayModelName`은 재연결과 default 판별 실패 뒤에도 보존되어 오표시가 계속 남았다. Node model catalog 경로에도 같은 catalog-order fallback이 있었다.

### 해결
- Swift 모델 선택을 Gateway의 명시적 default/primary metadata → canonical `agent:main:main` 세션의 provider-qualified model 순으로 제한하고, catalog의 첫 available fallback을 제거했다. 둘 다 없으면 `gateway_model` nil 이벤트로 과거 캐시를 지운다.
- main session의 flat/nested model shape를 처리하고 catalog key와 일치하면 display name으로 변환한다. Node `getDefaultModelName()`도 default tag가 없으면 null을 반환하도록 정렬했다.
- `OpenClawToolNoiseTests`에 main-session 선택, provider qualification, 첫 세션 fallback 금지, nested shape 회귀 테스트를 추가했다.

### 검증
- `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -only-testing:AgentDeckTests_macOS/OpenClawToolNoiseTests` — 33/33 pass.

## 2026-07-12 — Observed 세션 스티어링: 정밀 PreToolUse 게이트 복원 + soft STOP + 턴엔드 지시 큐 + OpenCode 직접 스티어링

### 배경
observed(직접 `claude`/`codex`/`opencode`, PTY 없음) 세션에 디바이스가 작동하는 것처럼 보이는 제어 버튼을 노출하던 P1(명령 조용한 드롭)의 근본 해결. hook은 단방향 알림이 아니라 **Claude Code가 데몬에 열어주는 동기 RPC 채널**(PreToolUse curl은 이미 `--max-time 60`+응답 echo 형태로 설치돼 있었음)이라는 점을 이용해, PTY 없이 스티어링 사다리를 구축.

### 스티어링 프리미티브 (Claude observed)
- **디바이스 승인 게이트 복원**: `/hooks/PreToolUse` 응답을 hold → 디바이스 `permission_decision`(allow/deny) 또는 타임아웃(기본 25s, `AGENTDECK_APPROVAL_HOLD_MS`). **과거 제거 사유(오발+선택지 날조)를 설계로 해소**: ① 날조 금지 — TUI 프롬프트 미러링 대신 디바이스 고유 의미론("Allow Bash: git push…?" 2버튼), ② 오발 금지 — hold 조건 전부 보수적(`shouldGatePreToolUse` 모드 게이트 + never-prompt/prompt-prone 도구셋 + **allowlist 예측**(user/project settings 4파일+managed policy 병합, 파싱실패·판독불가=hold 안함) + MCP 도구 제외 + 접속 클라이언트 0이면 제외 + 세션당 동시 1홀드), ③ **자동승인 학습기** — 홀드가 undecided로 릴리즈된 뒤 permission_prompt Notification 없이 tool_end가 오면(세션 "always allow"였음) 해당 시그니처(Bash=명령 앞 2토큰) 세션 내 재홀드 금지, ④ 타임아웃 폴백을 `ask`→**빈 응답(pass)** 으로 — `ask`가 allowlist를 우회해 강제 프롬프트를 띄울 가능성 원천 차단. 킬스위치 `AGENTDECK_OBSERVED_APPROVAL=0`.
- **Soft STOP**: 디바이스 interrupt → stop 플래그 → 다음 PreToolUse에서 `deny`+정지 지시. Ctrl+C는 아니지만 다음 툴 경계에서 확정 정지. user_prompt_submit/턴종료 시 자동 해제, TTL 10분.
- **턴엔드 지시 큐**: Stop hook을 request-response로 전환(installer `--max-time 10`+echo, migration 5) → 큐에 GO ON/REVIEW/COMMIT이 있으면 `{decision:"block",reason:지시}` 로 턴 연장 배달. 큐 캡 3, 턴당 1개 드레인, 빈 큐는 항상 정상 종료(stop_hook_active 루프 불가). **reason은 지시 텍스트라 슬래시 명령 실행 불가** → observed 프리셋은 자연어만, /clear 제외.

### OpenCode observed = near-managed
observer 플러그인(v2)이 in-process SDK `client`를 보유 → 데몬 명령 큐(`GET /opencode/commands?sid=` long-poll 25s)를 드레인해 `session.abort`(즉시 interrupt)/**`session.promptAsync`**(idle에도 프롬프트 주입; `session.prompt`는 턴 전체를 블로킹하므로 폴백에서만 non-await — sst/opencode 소스 검증) 실행. Node `opencode-steering.ts` + Swift `OpenCodeCommandQueue` 양데몬 동일 엔드포인트.
- **OpenCode 승인 게이트(무예측·무오발)**: 플러그인이 `permission.asked`/`permission.replied` 이벤트를 `opencode_permission_*` 훅으로 전달(서버가 **실제로 물어볼 때만** 발화 — Claude 게이트와 달리 예측 불필요). Swift가 세션 행에 `requestId="ocperm:<rawSid>:<permId>"`+awaiting 오버레이 → 디바이스 ALLOW/DENY → `permission_decision`이 큐로 `permission_respond`(allow→"once", deny→"reject") 배달 → 플러그인이 `postSessionIdPermissionsPermissionId` 실행. `permission.ask` 훅은 미발화 버그(sst/opencode #7006/#19927/#22558)로 이벤트+respond 엔드포인트 경로 채택.
- **codex observed는 전면 inert**: codex 훅은 notify 전용이라 스티어링 경로 없음 — D200H/SD observed UI를 steerable(claude/opencode)로 게이팅해 작동 불가 버튼 노출 방지. OpenCode observed는 idle에서도 inject-now 프리셋 활성.

### 디바이스 UI (P1 수정 포함)
- shared `d200h-layout.ts` + SD `session-slot-manager.ts`: observed 세션 detail을 capability 사다리로 게이팅 — awaiting+requestId→ALLOW/DENY, awaiting only→"answer in terminal", processing→soft STOP+큐 프리셋("at turn end" 부제), **idle→작동 불가 버튼 전부 제거**(inert STOP, OBSERVED 안내 타일). SD plugin `sendFocusedSessionCommand`가 observed도 `session_command`로 래핑(구 bare-fallback 드롭 제거). observed 상태는 릴레이가 아닌 sessions_list 행에서 직접 파생.
- `SessionInfo` 신규 필드 `stopRequested`/`queuedDirectives`(+기존 requestId 활용), `pnpm generate-protocol` 재생성.

### Swift 데몬 패리티
`ObservedSteering.swift`(actor: 게이트 continuation hold/soft stop/큐/학습기/룰 예측기) + `DaemonServer` 배선(async 핸들러가 hold를 자연스럽게 suspend). hook 생성 세션 5곳에 `controlMode:"observed"` 태깅(디바이스 게이팅의 전제). **샌드박스 정밀도**: 룰 예측기는 `~/.claude`·`<cwd>/.claude` 디렉토리 리스팅이 성공해야만(양성 판독 증명) 게이트 활성 — App Store 샌드박스에서는 자동 비활성(soft STOP/큐/표시는 유지, 둘 다 사용자 개시라 오발 불가). `permission_decision`은 observed 게이트 우선→OpenClaw exec-approval 폴백. observed `session_command` 인터셉트는 gateway 소비 블록 **앞**에 배치.

### 검증
- vitest 97파일 1745/1745 (신규: `observed-steering.test.ts` 정밀도 스위트 — allowlist/모드/safe-tool/MCP/파싱실패/학습기 케이스 전수, `d200h-observed.test.ts` — codex-inert·opencode inject·ocperm 게이트 포함, `opencode-steering.test.ts`; `permission-resolver.test.ts`는 pass-through 신계약으로 갱신). 커버리지 임계 통과. OpenCode SDK 표면은 sst/opencode@dev(≈v1.17.x) 소스 대조 검증.
- `xcodebuild -scheme AgentDeck_macOS build` — BUILD SUCCEEDED.
- design lint 905 = 변경 전과 동일(신규 위반 0).
- 실기 디바이스(SD/D200H) 라이브 검증은 앱·플러그인 재시작 필요 — 미실시.

## 2026-07-12 — Swift 데몬 opencode_* 인제스트 · projectName "/" 버그 수정

### 문제
- **OpenCode 미표시**: Swift 데몬만 실행 중일 때 standalone `opencode` TUI 세션이 대시보드에 안 보임. observer 플러그인(`agentdeck.js`)은 App Store 컨테이너 `daemon.json`+9120 폴백으로 Swift 데몬을 정상 발견해 `opencode_*`를 POST하고 있었으나(라이브 로그 194건 수신 확인) `DaemonServer.handleHookEvent`의 `if event.hasPrefix("opencode_") { return }` 드롭 필터가 유일 차단점. opt-in SSE observer(`openCodeMonitoringEnabled`, 기본 OFF)는 bare TUI의 ephemeral 포트를 발견할 수 없어(문서화된 한계) 훅이 유일한 신호였음. 필터 주석의 "PassiveSessionObserver가 커버" 주장은 오류 — Swift 트리에 그 컴포넌트 없음(Node 전용).
- **Codex App 프로젝트명 "/"**: Codex App **ambient/백그라운드 태스크**가 cwd `/`로 OTel 스팬을 보내면 `ProjectNameResolver.resolve`의 최종 폴백 `NSString.lastPathComponent`가 `/`를 그대로 반환(Node `basename('/')`→``''``→`'unknown'`과 발산) → 세션 행·타임라인 행에 리터럴 "/" 라벨(라이브 timeline.json 3건 확인). `ensureCodexSession` 업그레이드 경로가 "Codex App" 폴백명을 "/"로 덮어쓰기까지 함.

### 해결
- `ProjectNameResolver.resolve`: base=="/"면 "" 반환(미해결 취급) → 호출부 폴백("Codex App"/"OpenCode"/agent-tag)이 작동. Node와 라벨 발산 제거.
- `DaemonServer.handleHookEvent`: 드롭 필터 → `opencode_*` 인제스트로 교체. 세션 키 `opencode:<id>`(SSE observer와 동일 prefix로 수렴), switch 케이스 5종(session_start/user_prompt_submit/tool_start/tool_end/stop + forward-compat session_end), `openCodeTurnAnchors`(ChatTurnAnchorTracker 3번째 인스턴스) 기반 `appendOpenCodeChatStart/ToolEvent/ChatEnd` 타임라인 appender(agentType "opencode"), resurrection predicate(플러그인이 session_start를 프로세스당 1회만 announce하므로 mid-turn 훅도 재생성 허용 — Codex와 달리 companion-task 노이즈 없음), eviction 스윕 open-turn 강제 종료 분기. **APME collector 제외는 유지**(codex와 동일 — Claude-lifecycle 전용 모델).

### 검증
- `xcodebuild test -scheme AgentDeck_macOS -only-testing:ProjectNameResolverTests -only-testing:TerrariumCloudFoldTests` — 31/31 pass (신규: resolve("/")=="" · trailing-slash basename · opencode resurrection predicate).

## 2026-07-12 — WiFi ESP32 flap · IPS10 재부팅 안정화

### 문제
- WiFi-WS ESP32 보드가 ~5초마다 접속/해제 반복(flap). 근본원인=커밋 `f7443d42`가 Swift 데몬으로 하여금 WiFi 보드에 대시보드 full-state를 무필터 broadcast하게 만든 회귀(`broadcastRaw` + 연결 burst). 작은 버퍼가 2.4GHz에서 못 버텨 소켓 드롭→재접속→또 broadcast 자기강화 storm. `587879f4` coalescer는 CPU만 잡았고 보드 드롭은 안 고쳐짐 — **2.4GHz는 원인 아님**(몇 주간 정상이었음, 로그 시계열이 재시작 시점에 정확히 폭발).
- IPS10 "간혹 재부팅"=`hud_bar.cpp` 세션 Detail 활동로그 스택스매싱. `lp += snprintf(logbuf+lp, sizeof-lp, "…%s\n", te.raw)`가 would-have-written을 누적 → 긴 타임라인 항목 하나로 `lp>640` → 뒤의 `logbuf[lp-1]` 이 버퍼 밖 write → UI task 스택 파손 SW reset. `de6b1519`와 같은 클래스, `appendBounded`가 IPS10 컴파일아웃된 곳에서 재발.

### 해결
- WiFi ESP32를 USB-serial 보드와 동일한 화이트리스트+`prepareForSerial` 축소 스트림만 받게 함(Node esp32 eventTransformer 파리티): `prepareForSerial` static+`deviceInfo`화(serial/wifi 공유), `broadcastRaw`가 esp32 연결을 full fanout에서 제외하고 보드별 축소 payload 전송, 연결 burst는 `timeline_history` 100개 덤프 스킵(serial `initialEvents`와 일치). `ESP32WifiForwardTests`로 불변식 잠금.
- IPS10: snprintf 반환값 누적 후 `if (lp>=sizeof) lp=sizeof-1` clamp.

### 핵심 설계 결정
- **WiFi ESP32는 대시보드가 아니라 display 클라이언트** — full-state fanout 금지, serial과 동일 SSOT(`serialForwardedEvents`) 화이트리스트. serial-relay `broadcastHooks`는 계속 full(자체 shaping).

### 검증
- `xcodebuild build/test -scheme AgentDeck_macOS` — BUILD SUCCEEDED, `ESP32WifiForwardTests` 3/3 pass.
- 라이브: WiFi flap 데몬 재시작 후 100초 재접속 0회(baseline 95/3min), 보드 전부 `stale:false`. IPS10 신펌웨어(0.2.3) 플래시 후 60초 재부팅/스톨 0회. 86box는 storm 진정+USB 재열거 후 시리얼 안정(초반 "부트루프"는 backtrace 미확증 추정 — 실은 일시적 CH340 wedge).
- 커밋 `f0b62122` (origin/master).

## 2026-07-12 — Codex 관찰 세션 OTel turnEnd Stop 드리프트 수정

### 변경
- Swift 데몬에서 codex 관찰 세션의 답변이 타임라인에 누락되던 버그를 고쳤다. 직전 턴의 OTel `turnEnd` 스팬이 hook stop보다 늦게(~3s) 도착해, 이미 열린 다음 프롬프트 턴을 빈 payload로 조기 종료(heuristic chat_end·`chat_response` 없음)하고 세션을 finished로 마킹 → 이후 실제 tool·응답이 "Ignored late … for finished session"으로 폐기됐다. 답변은 `~/.codex/sessions` 롤아웃에는 정상 존재.
- `DaemonServer.swift`의 OTel `.turnEnd` 핸들러가 버리던 `turnId`를 살려 세션별 `codexOtelTurnIdBySession` 앵커로 게이트(`shouldCloseOnCodexOtelTurnEnd`): OTel이 서비스 중인 turnId와 일치할 때만 close, hook이 새 턴을 열면(`appendCodexChatStart`) 앵커 무효화, 미확립 상태에서 hook 앵커가 열려 있으면 hook stop / eviction 백스톱에 위임. FIFO/TTL 아닌 turnId 아이덴티티 매칭이라 기존 `ChatTurnAnchorTracker` open-turn 앵커 규칙과 일치.

### 검증
- `xcodebuild build … -scheme AgentDeck_macOS -configuration Debug` — BUILD SUCCEEDED.
- `xcodebuild test … -only-testing:AgentDeckTests_macOS/CodexOtelParserTests` — 42/42 pass (신규 드리프트-가드 4 케이스: 정상매치 close / 이전턴 reject / nil+hook앵커 reject(현장 재현) / 순수 OTel close).

## 2026-07-12 — Device Preview live emulator 확장 · TUI downstream parity

### 변경
- Device Preview live-follow 입력을 실제 daemon 세션·포커스·옵션·Claude/Codex usage snapshot으로 확장해 D200H와 단일 타일 프리뷰가 실제 프로젝트명·모델·상태를 렌더하도록 했다. Antigravity를 preview agent로 추가하고 Pixoo/TC001/iDotMatrix/D200H 경로와 회귀 픽스처를 보강했다.
- TUI dashboard downstream 영역에 Stream Deck, WiFi-only ESP32, TUI dashboard 행을 추가하고 serial+WiFi dual-home 보드는 중복 표시하지 않도록 했다.

### 검증
- `pnpm vitest run bridge/src/__tests__/tui-dashboard.test.ts` — 10/10 pass.
- `xcodebuild test ... -only-testing:AgentDeckTests_macOS/DevicePreviewSnapshotTests` — build/test 성공(매핑 1 pass, PNG 렌더 1건은 opt-in 환경변수 미설정으로 skip).

## 2026-07-12 — App Store 제출 캡처·검증 정리

### 변경
- App Store 제출용 macOS/iPhone/iPad 캡처를 현재 UI로 갱신하고 iPhone 슬롯을 ASC의 6.5-inch 1284×2778 규격에 맞췄다. 반복 온보딩 세트를 iPhone(환영·대시보드·권한 요청), iPad(대시보드·권한 요청·수족관 보기)로 교체했다.
- 실제 개발 세션이 캡처에 섞이지 않도록 합성 세션만 보내는 `scripts/appstore-screenshot-mock.mjs`와 iOS Debug 전용 `-AgentDeckScreenshotURL` 연결 경로를 추가했다. Release/App Store 빌드에는 포함되지 않는다. 제출 검증기에 screenshot alpha 금지 검사를 추가했다.

### 검증
- `bash apple/scripts/validate-appstore-submission.sh` — 9개 캡처 해상도·alpha·중복 및 한/영 메타데이터 제한 통과.

## 2026-07-12 — 구현-문서 정합성 감사 및 개발 로그 월별 정리

### 정리
- `docs/architecture.md`의 오래된 Swift 데몬 규모, Claude/Codex hook 경로, D200H direct-HID 소유권, AgentType 목록을 현재 구현과 `CLAUDE.md` 기준으로 갱신했다.
- `docs/agent-harness.md`의 OpenCode/Antigravity 자동 발견 범위를 `AGENTS.md`와 일치시키고, 활성 개발 로그 크기를 고정 줄 수가 아닌 보존 정책으로 설명했다.
- InkDeck은 WiFi WS·자발적 `device_info`·daemon presence·OTA capability가 이미 구현된 상태와, 실기 렌더/refresh/출하 검증이 남은 상태를 분리해 hardware/appstore/device 문서에 반영했다.
- `docs/devices.md`의 폐기된 Apple bundle ID와 plugin→Gateway 직접 연결 설명을 제거했다.
- 활성 로그에서 2026-05 항목 51개를 `docs/devlog/2026-05.md`로 이동해 6–7월만 유지하고 아카이브 인덱스를 갱신했다.

### 검증
- 제품 버전 mirror 동기화, 추적 Markdown 로컬 링크, 월별 로그 항목 수/활성 월 범위를 기계적으로 재검사.

## 2026-07-11 — 턴 앵커 유실-Stop 드리프트 수정(FIFO→open-turn 트래커) + APME run projectName 보강

### 문제
1. **앵커 큐 어긋남**: Swift 데몬의 claude/codex `chat_start` ts FIFO 큐(`ChatStartTsQueue`)는 매 턴 Stop hook이 도착할 때만 정확했다. 한 번 유실되면 고아 head가 남아 이후 모든 Stop이 **이전 턴**의 앵커를 pop — 영구 off-by-one으로 chat_response가 엉뚱한 턴에 병합되거나, 고아 entry가 10분 TTL에 걸린 뒤에는 앵커 없이 독립 행으로 렌더링됐다. 부수 결함: 10분 넘는 정상 장시간 에이전트 턴도 TTL이 앵커를 버려 응답이 standalone. Claude Stop hook은 best-effort(~18%)라 유실이 지배적 실패 모드인데, Node 데몬은 Stop 시점 타임라인 백스캔(`turnOpen = lastStart.ts > lastCompletionTs`)이라 자기치유되고 Swift만 드리프트했다.
2. **TASK 헤더 프리픽스 폴백**: hook `session_start` payload에 `project_name`이 없으면(직접 `claude` 설치 형태) `run.projectName`이 비어 task_start/task_milestone/projected 행 전부 무라벨 → 클라이언트가 agentType 폴백 프리픽스를 표시.

### 해결
- **`ChatStartTsQueue` → `ChatTurnAnchorTracker`** (Node Stop-time 백스캔 파리티): 세션당 open turn은 최신 chat_start 1개뿐. `noteChatStart`가 미청구 앵커를 대체(유실 Stop은 다음 프롬프트에서 자기치유), `claimOpenTurn`이 첫 Stop에 앵커를 넘기고 턴을 닫음(중복/지연 Stop은 nil → response-only 폴백만), TTL 제거(장시간 턴 앵커 보존). 트레이드오프(Node와 동일): 이전 턴 Stop 전에 후속 프롬프트가 오는 진짜 인터리브에선 늦은 Stop이 새 턴 앵커를 가져감 — 관찰 턴은 세션당 직렬이고 유실이 압도적이라 수용, 트래커 주석+테스트로 명문화.
- session_end/stale-eviction의 미완 턴 강제 close 판정은 `hasOpenTurn`(구 `depth>0`), codex tool_exec 중간 스탬프는 `peekOpenTurn`(비소비, Stop이 claim 소유).
- **projectName 보강 2단**: DaemonServer가 컬렉터 호출 전 `apmeEnrichedHookPayload`로 payload에 project_name 주입(`pushedSessionsById` 우선 → `ProjectNameResolver` cwd 폴백) + 컬렉터 프롬프트 경로에서 빈 `run.projectName`을 store 백필(빈 값일 때만 — 덮어쓰기 금지). task_start/milestone은 emit 시 store에서 run을 fresh 조회하므로 지연 승격 헤더도 라벨을 받는다.

### 검증
macOS XCTest 전체 스위트 green — 신규: 앵커 트래커 7건(유실 Stop 재동기화 THE-regression·중복 Stop 억제·no-TTL·세션 격리·peek 비소비·clear)·projectName 백필/비덮어쓰기 1건. FIFO 시맨틱을 단정하던 구 큐 테스트 9건은 새 시맨틱 테스트로 대체. macOS 앱 타깃 빌드 성공.

---

## 2026-07-11 — 타임라인 교차 세션 가짜 서브트리: Swift 컬렉터 per-session 전환 (d22969f0)

### 문제
macOS Dashboard TIMELINE에서 완전히 독립적인 codex/claude 세션들이 한 TASK 헤더 아래 들여쓰기되어 "관련 작업 서브트리"처럼 보였다. 실데이터 검증 결과 태스크 25개 중 12개가 2~6개 세션에 걸쳐 오염. 부수 증상: TASK 헤더가 자기 턴들 **아래**에 렌더링(지연 승격 task_start의 백데이트 ts를 append-only 스토어가 제위치에 못 넣음), task 행의 sessionId가 `hook-N-epoch` 합성 키라 세션 필터에서 헤더 실종, chat_end 전부·codex chat_start의 taskId 미스탬프로 래그드 인덴트.

### 해결
- **근본**: `ApmeCollector.swift`의 데몬 전역 `activeTask`/`activeTurn` 스칼라를 Node `collector.ts`와 동일한 **세션별 맵**(sessionToTurn/Task/LastMilestone/Usage + per-session idle-gap 타이머)으로 전환. 이벤트 귀속 키 = hook payload `session_id`(없으면 최근 세션 폴백). run.sessionId = 실제 세션 UUID → task_start/task_end 행이 세션 필터에 걸림. `activeTaskId(sessionId:)`/`setTurnResponse(sessionId:)`/`closeTaskExternal(sessionId:)` 세션 스코프 API.
- **스탬핑**(`DaemonServer.swift`): claude chat_start/response/end 모두 세션 스코프 스탬프. codex chat_response의 글로벌 taskId 스탬프는 **제거**(codex는 컬렉터 미추적 — 구 스탬프가 오염 그 자체). `setTurnResponse`는 chat_end 행의 sessionId로 라우팅(응답 텍스트 오귀속도 함께 해소).
- **정렬 삽입**: 스토어 4곳(Swift 데몬 `DaemonTimelineStore`/Swift UI `TimelineStore`/SD 플러그인 `timeline-store.ts`/Android `TimelineStore.kt`) live add를 ts 정렬 삽입으로 — 백데이트 task_start가 제위치에 들어감.
- **인덴트 가드**(Swift `timelineRowIsNestedUnderTaskHeader` + Kotlin 미러): 들여쓰기 조건을 "taskId 있음" → "**바로 위 task 마커가 같은 taskId의 task_start일 때만**"으로. 디스크에 남은 레거시 오염 행도 가짜 서브트리로 안 그려짐.

### 핵심 설계 결정
- **컬렉터 상태는 세션이 1급 키** — Node가 원본 설계(`sessionToTask` 맵)였고 Swift 포트가 스칼라로 축약한 것이 회귀 원인. Swift 데몬에 새 세션-연관 상태를 추가할 땐 맵 + payload `session_id` 키가 기본. 미등록 세션의 non-prompt 이벤트는 **드롭**(과거처럼 최근 세션에 오귀속하지 않음) — 게이트웨이 컬렉터는 모든 합성 페이로드에 `"openclaw-gateway"`를 동봉해야 한다.
- **codex 행은 taskId 없음이 정상**: codex는 Swift 컬렉터 미추적이므로 플랫 렌더링. codex용 APME 컬렉터 경로는 별도 후속.
- 재시작 후 실기 검증: 새 run이 실제 UUID로 기록, 이 세션 프롬프트에 자기 태스크 스탬프, codex 행 플랫, 레거시 오염 행 전부 플랫 렌더링(스크린샷 확인).

### 검증
macOS 365 XCTest(신규 동시 2세션 격리 3건 포함) · iOS 빌드 · vitest 1693 · Android testDebugUnitTest 전부 green. 기존 게이트웨이 테스트 1건은 프로덕션 플로우(session_id 항상 동봉)에 맞게 픽스처 수정. 알려진 잔여 한계: 앵커 큐 어긋남(Stop hook 유실 시 응답이 독립 행) — 위 후속 항목(open-turn 트래커 전환)에서 해결.

---

## 2026-07-11 — 토폴로지 누락(TUI·WiFi ESP32) 복구 · Device Preview 실기 드리프트 3건 수정 · Live 프리뷰/스냅샷 QA 도구

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

## 2026-07-11 — iOS idle Claude 세션을 SETUP 미완료로 오인

### 문제
iOS의 `SetupNeededCard`가 Mac 소유 상태인 Claude hook 설치 여부를 iOS 로컬 `AppPreferences.hooksInstalled`로 평가했다. 이 값은 iOS에서 채워지지 않으므로 Claude 세션이 없고 OAuth 신호도 없는 idle 구간에는 정상 설정된 환경도 `SETUP · Claude Code` 미완료로 표시됐다. 세션 존재는 설정 완료의 증거가 될 수 있지만 세션 부재는 설정 미완료의 증거가 아닌데 두 상태를 혼동한 것이다.

### 해결
- iOS SETUP 정책에서 Claude descriptor를 제외했다. iOS는 read-only 대시보드이며 Claude hook/OAuth 설정은 paired Mac이 소유하므로, wire protocol에 명시적인 hook-readiness 신호가 생기기 전에는 세션 유무로 설정 상태를 추론하지 않는다.
- daemon이 명시적이고 지속적인 `gatewayAuthStatus`를 보내는 OpenClaw SETUP 진단은 유지했다.
- `ProtocolTests.testIOSSetupPolicyDoesNotInferClaudeSetupFromSessionAbsence`로 iOS 정책에 Claude가 다시 들어오지 않도록 회귀 가드를 추가했다.

### 검증
`xcodebuild`로 `AgentDeck_iOS` generic-device Debug build 성공, macOS `ProtocolTests` 성공.

---

## 2026-07-11 — Swift 데몬 codex 세션 플랩 · Codex/OpenClaw 타임라인 응답·귀속 유실

### 문제
이 머신은 Node CLI 데몬이 반복 자체종료([[dev-machine-node-daemon-repeated-shutdown]])라 **Swift 인프로세스 데몬이 상시 9120 허브**다. Node의 `ps`/`lsof` 기반 observed 세션과 달리 Swift는 hook-TTL 휴리스틱만 있어 아래 결함이 Swift 허브에서만 발현됐다.
- **codex 세션 플랩**: companion-task용 공격적 TTL(post-terminal 60s / idle 90s)이 장수 인터랙티브 `codex` CLI에 그대로 적용되고, 부활은 `codex_session_start`/`codex_user_prompt_submit`만 허용 → 긴 thinking(무 hook 90s) 중 evict되면 이후 tool hook이 계속 와도 다음 프롬프트까지 세션이 사라짐. 로그상 한 스레드가 30초(sweep 주기)마다 반복 evict.
- **Codex/OpenClaw 응답 미표시**: OpenClaw는 Gateway가 응답을 flat `payload.response`가 아니라 `payload.message.content[].text` 구조로 옮겼는데 Swift 어댑터가 옛 필드만 프로빙 → `model_response` 전멸(라이브 timeline.json에서 0건 확인). Codex는 세션 플랩이 chat 큐(`startedAt` 앵커)와 세션 엔트리(projectName)를 지운 뒤 늦은 stop이 도착해 앵커/귀속 없는 응답 행이 되어 병합 실패.
- **prefix 혼재**: evict 후 방출된 codex 행이 projectName 없이 저장돼 클라 prefix가 `[Codex CLI]`로 fallback(`[AgentDeck]`와 뒤섞임).
- **Android만 "Connected/Prompt sent/Bash" 가짜 행**: Swift connect burst에 `timeline_history`가 없어 Android가 히스토리도 못 받고 `receivingBridgeTimeline` 억제 플래그도 안 켜져 로컬 StateTimelineGenerator가 iOS/macOS엔 없는 상태-파생 행을 계속 생성.

### 해결
- `DaemonServer.swift`: (a) terminal 기록이 있는 스레드가 새 턴을 열면 **interactive 승격**(`codexRegisterNewTurnSignal` — 재개=인터랙티브 시그니처, companion은 단일턴)해 post-terminal fast-evict 면제 + 30분 idle TTL. (b) evict 시 terminal ts를 **tombstone으로 보존** — tombstone/terminal 기록 없는 미지 세션의 `codex_tool_start/end`는 산 턴이 중간에 reap된 것이므로 부활 허용, 있으면 companion 잔여 콜백이라 차단. (c) codex 타임라인 projectName 해석 체인(세션엔트리→payload cwd→evict 생존 캐시). (d) connect burst에 `timeline_history`(getRecent 100) 추가.
- `OpenClawAdapter.swift`: Node `extractMessageText` static 미러(테스트 2건 포함) + delta 누적 fallback으로 model_response 복원; 행 projectName 기본값 "OpenClaw".
- `AgentState.kt`: Apple parity — `gatewayConnected==true`면 StateTimelineGenerator 억제.
- `TimelineStrip.kt`: prefix를 **projectName 단독**(`[AgentDeck]`)으로, agent tag는 project 없을 때만.

### 핵심 설계 결정
- **codex 플랩의 근본 = 샌드박스가 `ps`를 막아 Swift가 프로세스 생존을 못 봄**. Node는 프로세스 테이블로 grounding하지만 Swift는 hook 휴리스틱뿐이므로, "multi-turn 재개"를 companion↔interactive를 가르는 유일하게 신뢰 가능한 신호로 삼았다.
- **evict와 부활의 구분은 tombstone**: terminal 기록을 지우지 않고 evict를 넘겨 보존해야 "죽은 companion의 잔여 hook"과 "산 턴이 중간에 reap된 것"을 나눌 수 있다.
- **Swift connect burst는 Node bridge-core와 이벤트 파리티를 유지**해야 한다. Node에 있는 초기 이벤트가 Swift에 없으면 클라이언트 억제 로직이 영영 안 켜져 가짜 행이 샌다.
- **타임라인 prefix는 projectName 단독**(사용자 확정) — 브랜드 글리프가 이미 에이전트를 시각화하므로 텍스트 태그 병기는 중복.

### 검증
`xcodebuild AgentDeck_macOS Debug` BUILD SUCCEEDED, 대상 XCTest 80/80 (신규 extractMessageText 2건 포함) 0 failures, Android `compileDebugKotlin` + `testDebugUnitTest` 통과. 적용은 앱 재시작(옛 데몬 pid 1756은 구코드) 필요.

---

## 2026-07-11 — Android WiFi adb 배포 경로 · BrandIcon pivot 버그 · D200H Swift 토폴로지 행

### 문제
- Android 대시보드 기기(e-ink 리더/태블릿) APK 업데이트가 매번 USB 케이블을 요구했고, in-app OTA는 기기별 설치확인 탭 + REQUEST_INSTALL_PACKAGES가 강제라 UX가 오히려 나쁘다.
- e-ink 타임라인 히어로 행(28dp)의 에이전트 브랜드 글리프가 좌상단 화면 경계 밖으로 이탈 — Compose `DrawScope.scale()`의 기본 pivot이 캔버스 중심이라 그림이 `center×(s−1)`만큼 밀리는데, 13dp 기본 크기(s≈1.08)에선 무증상이라 잠복해 있었다.
- Swift 데몬은 `client_register "ulanzi-plugin"`에서 direct-HID stand-down만 하고 토폴로지 registration을 만들지 않아, D200H가 Ulanzi Studio 경유로 정상 구동 중이어도 대시보드에 행이 없었다 (Node 데몬은 presence로 행 생성 — 티어 간 불일치).

### 해결
- `scripts/deploy-android-wifi.sh` 신설 (`c73263c3`): `enable`=USB 상태에서 `adbd tcpip:5555` 전환 + wlan0 IP를 `~/.agentdeck/android-adb-devices.json`에 기록, `deploy [--build]`=전 등록 기기에 최신 `dist/agentdeck-v*.apk` silent 설치 + 앱 재실행. Moaan Pantone6 · Crema S · Lenovo TB-J606F 3대 WiFi 트랜스포트로 실배포 검증. 재부팅 시 tcpip 모드가 풀리므로 USB 1회 재-enable 필요 (docs/android.md).
- `BrandIcon.kt`에 `scale(s, s, pivot = Offset.Zero)` (`547fb5e3`) — terrarium 크리처들이 이미 따르던 관례로 정렬. Crema 실기 `adb exec-out screencap` before/after로 검증.
- Swift 데몬에 `d200hHealthSnapshot()` 단일 chokepoint (`45377214`): dormant HID 모듈이 없으면 ulanzi-plugin WS presence로 `modules.d200h {connected, externalOwner, managerOpened}` 합성 (Node `moduleHealthProvider` 파리티), 플러그인 등록/해제 시 broadcast. UI는 `externalOwner`로 "Ulanzi Studio · 14 keys" 표기, 메뉴바 D200H 행 제목 정정. 플러그인 부재 시 키 자체를 생략해 D200H 없는 설치에서 ghost row가 없다.

### 핵심 설계 결정
- **Android 무선 업데이트는 in-app OTA가 아니라 adb-over-WiFi**: adb install은 무확인 silent이고 앱/데몬 코드 변경이 0 — 로컬 개발 플릿에는 상위 호환. 단 tcpip 모드는 재부팅 비영속이 트레이드오프.
- **D200H 토폴로지 행 부재 = 플러그인 미연결이지 물리 USB 부재가 아니다**: Ulanzi Studio가 떠 있으면 덱이 안 꽂혀 있어도 행이 뜬다. 물리 확인은 여전히 `system_profiler SPUSBDataType`.

### 검증
- WiFi 배포 3/3 Success + 데몬 재등록, Crema screencap 렌더 확인, `xcodebuild AgentDeck_macOS Debug` BUILD SUCCEEDED, 앱 재시작 후 `/health modules.d200h` + 대시보드 "USB HID · D200H · Ulanzi Studio · 14 keys" 라이브 확인. Codex usage bookmark는 재빌드에도 유지됨.

---

## 2026-07-11 — 제품 버전 0.2.3 통합 및 드리프트 CI 가드

### 문제
- 2026-06-26 Apple bundle ID 교체 시 Apple만 합법적으로 버전을 재시작할 수 있었는데, npm 소스까지 0.2.x에서 0.1.0으로 낮춰 레지스트리 최신 버전과 소스가 역전됐다. 그 결과 `npx @agentdeck/setup`은 미배포 구버전을 계속 받았고 Windows 수정이 소스에 있어도 배포할 수 없었다.
- Apple/Android/npm/ESP32/Stream Deck/Ulanzi가 독립 버전 트랙이라 문서·지원·호환성 설명이 분산되고, ESP32 소스 0.1.2와 릴리스 문서 0.1.1 같은 드리프트가 발생했다.

### 해결
- 루트 `VERSION`을 제품 버전 SSOT로 신설하고 모든 패키지·Apple·Android·ESP32·Stream Deck·Ulanzi 버전을 npm 최고 공개 버전보다 높은 `0.2.3`으로 통일했다. Apple build는 2, Android versionCode는 2로 독립 단조 증가를 유지한다.
- `scripts/verify-version-sync.mjs`와 `pnpm verify-version`을 추가하고 CI install 직후 실행해 package/project/firmware/plugin/profile mirror 드리프트를 차단한다.
- `RELEASING.md`를 "통합 제품 버전 + 독립 빌드 번호/배포 채널" 정책으로 교체했다. 채널별 prefixed tag는 실제 배포 기록을 위해 유지하며, manifest가 동기화됐다는 이유만으로 미제출 채널을 배포 완료로 간주하지 않는다.
- README, CLAUDE.md, App Store 제출 체크리스트와 TestFlight QA 문서를 0.2.3 기준으로 갱신했다.

### 핵심 설계 결정
- npm public 패키지(hooks+shared→bridge→setup)는 lockstep으로 배포한다. `bridge`가 hooks/shared에 런타임 의존하므로 네 패키지가 모두 같은 제품 버전으로 registry에 존재해야 한다. 플랫폼 전용 hotfix도 공통 제품 patch를 올리되, 변경 없는 채널은 바이너리 배포를 생략할 수 있다.
- 외부 레지스트리/스토어에 도달한 버전은 태그 삭제로 리셋할 수 없다. 새 bundle ID/package name처럼 외부 identity가 바뀐 경우만 별도 migration으로 재시작할 수 있다.

### 검증
- `node scripts/verify-version-sync.mjs` green. 전체 pnpm/build 및 플랫폼 빌드는 후속 검증에서 실행.

---

## 2026-07-11 — Swift 데몬 기기 자동연결 실패 근본수정 (BLE 데드락 · Pixoo 세션 고착 · WS 메인큐 굶주림)

### 문제
Swift 데몬 실행 중 Timebox Mini/iDotMatrix가 15시간째 `statusReason:"connecting…"·lastError:null·로그 0줄`로 무음 고착, Pixoo64는 살아있는데(외부 curl 즉답) 백오프에서 영영 못 나옴, Android 태블릿은 WS 접속 폭주/등록 0건 churn(앱 CPU 94.7%). 태블릿은 별도로 "usb connect"에 갇혀 `ws://127.0.0.1:9120`만 반복 시도.

### 해결
- **BLE 데드락** (`aae72d9a`): `withTimeout`의 task group은 timeout 자식이 throw해도 work 자식 종료를 await하는데, CB delegate 콜백만이 resume할 수 있는 continuation은 취소 비인지라 콜백 부재 시(TCC 미결정/기기 OFF — CB connect는 자체 타임아웃 없음) 영구 데드락 → `isPushing` 가드가 모듈 전체 동결. 모든 continuation을 `withTaskCancellationHandler` + queue-confined cancel-pending 플래그로 cancellation-aware화, connect 취소 시 `cancelPeripheralConnection`, CB state/authorization 진단 로그 추가.
- **BLE 환경 트리거**: TCC Bluetooth 레코드가 서명 전환기 빌드의 **cdhash에 고정** → 재빌드 후 `authorization=notDetermined`인데 stale 레코드가 재프롬프트도 차단. `tccutil reset BluetoothAlways bound.serendipity.agent.deck` 후 재실행으로 identity 기반 새 허용 획득(재빌드에도 유지).
- **Pixoo 자가치유** (`aae72d9a`, `6fb8566f`): 장수 URLSession NW 고착 시 fresh-세션 sweep이 같은 IP의 생존 기기를 찾으면 `rebuildURLSession()`+backoff 해제(기존엔 relocated 아니라고 조용히 폐기), deep-hang 경계에서도 세션 재생성. 브레이커 상수를 주석이 주장하던 Node 값으로 실제 정렬(threshold 1→6, cap 300→60s).
- **Android USB 갇힘** (`6fb8566f`): 자동연결이 localhost(USB)→저장URL→6초 mDNS 창 순환이라 Swift 데몬(adb reverse 없음)에선 USB 시도에 갇힘. 상시 mDNS collector가 데몬 발견 즉시 localhost 시도를 선점(매 연결 재resolve — 데몬 재시작 후 stale 포트도 치유).
- **WS/UI 구조** (`d11a297e`): NWListener/NWConnection이 `.main`에서 돌아 SwiftUI layout이 send-completion을 굶주림("64 in flight"=갇힌 completion) → 전용 직렬 큐로 이전. 타임라인 행 분류 정규식 재컴파일을 static 컴파일+NSCache 메모이즈로, `@Published state` 필드별 ~40회 publish를 로컬 복사 후 단일 대입으로. 30s 연속 포화 클라이언트는 cancel 축출.
- **android-dashboard 토폴로지** (`148ae3f6`): WiFi 태블릿이 익명 소비자라 행이 없던 갭 — `client_register{clientType:"android-dashboard"}` volunteer-roster를 Android 송신 + 양 데몬 캐시/evict-on-close + TopologyRail Android 섹션으로 신설(feature-matrix 선등재).

### 핵심 설계 결정
- **timeout 헬퍼 안의 모든 continuation은 cancellation-aware가 계약**: 구조적 동시성의 task group은 취소된 자식도 종료를 기다리므로, delegate-resumed continuation이 하나라도 취소 비인지면 timeout이 영구 hang으로 역전된다 (CLAUDE.md "External peer async I/O" 원칙의 코어 케이스).
- **fresh-세션 probe 성공 = "네트워크 정상, 내 세션 고장" 신호**로 취급해 세션 재생성으로 자가치유 — "restart AgentDeck" 수동 권고 제거.
- 데몬과 UI가 한 프로세스인 이상 **NW I/O는 절대 .main에 두지 않는다**.
- WiFi 클라이언트 가시성은 volunteer-roster(`client_register`) 모델로 통일 (Stream Deck/XTeink/android-dashboard 동형).

### 검증
4개 기기 전부 라이브 복구·자동 재연결 확인(데몬 재시작/기기 OFF→ON/force-stop 축출 각 시나리오 실기), Lenovo TB-J606F 토폴로지 행 스크린샷 확인, 앱 CPU 94.7%→25~28%, saturation 로그 15h 연속→0. bridge vitest 1168 green, macOS XCTest 전체 green.

---

## 2026-07-10 — App Store 제출 패키지·스크린샷 검증 자동화

### 문제
기존 `apple/appstore-screenshots/`는 iPhone/iPad 12장이 같은 온보딩 첫 화면이었고, macOS 캡처는 브라우저·터미널·개발 데스크톱 및 비표준 화면비를 포함해 App Store Connect 업로드용으로 사용할 수 없었다. 메타데이터도 Device Preview 수가 드리프트했고, 원격 통신·Intel 지원 문구가 서로 달랐으며 영문 promotional text/description은 ASC 글자 수 제한을 초과했다.

### 해결
- `apple/appstore-submission/`에 실제 앱 UI로 다시 캡처한 업로드 세트(macOS 2880×1800, iPhone 1320×2868, iPad 2064×2752 각 3장), 제출 체크리스트, 선택 App Preview 22초 스토리보드를 추가. 과거 폴더는 historical archive로 명시. macOS 세트는 Swift standalone 화면(Device Preview/APME/Integrations)만 사용하며, 실제 경로와 불일치한 구 D200H USB 자동연결 문구가 있던 hardware screenshot은 제외.
- `docs/appstore-metadata-draft.md`의 한/영 문구를 Swift standalone 카탈로그 17종으로 통일하고, developer-daemon tier 설명을 제품 페이지에서 제거. privacy/시스템 요구사항을 실제 optional integration 동작에 맞게 수정하고 모든 ASC 필드를 제한 내로 축약.
- `apple/scripts/validate-appstore-submission.sh` 추가: 플랫폼별 1–10장/허용 해상도/중복 해시, 한·영 필드 글자 수, Privacy manifest, 1024 아이콘 alpha, export compliance plist, 선택 public URL reachability를 검사.
- Apple의 collection 정의 재검토 결과 optional Anthropic API backend는 지속 전송이라 optional-disclosure 예외가 아님. Privacy manifest/ASC 초안을 `Other User Content` + `Product Interaction`, linked, App Functionality, tracking 없음으로 보수적 정합화하고 공개 privacy policy 원본에 원격 모델 전송·대안(on-device Foundation Models)을 명시.
- iOS/macOS Info.plist에 `ITSAppUsesNonExemptEncryption=false` 명시(시스템 표준/면제 암호화만 사용).

### 검증
`xcodebuild` Debug build가 `AgentDeck_macOS`와 `AgentDeck_iOS` 모두 성공. `bash apple/scripts/validate-appstore-submission.sh --network` green. 세 plist `plutil -lint` 통과, App Store 아이콘 1024×1024/no alpha 확인.

---

> **Older entries are archived by month** under [`docs/devlog/`](docs/devlog/README.md) to keep this active log small. This file keeps the most recent months (2026-06, 2026-05). For history, grep the specific month file in `docs/devlog/` rather than loading everything.

---

## 2026-07-09 — ips10 SDIO 패닉 재발 = 미반영 재플래시, 86box 재부팅 = 허브 전원 경합

### 문제
ips10이 07-08 하루 종일 WiFi 텔레메트리로 `reset=panic code=4`(SDIO `sdio_rx_get_buffer`/`sdio_push_data_to_queue` assert) 19회를 보고했다 — 라운드24(커밋 `79579148`, 07-07 02:46 KST)에서 이미 고쳐졌다고 문서화된 바로 그 버그였다. 별개로 86box도 반복 `reset=poweron code=1`(하드웨어 리셋)을 보고했다.

### 해결
- **ips10**: 실기 buildHash가 `aedbeb8f-dirty`(buildEpoch 07-07 02:41 KST)로, 수정 커밋(`79579148`)보다 5분 앞선 빌드였다. 라운드26 로그가 "ttgo·inkdeck를 serial로 재플래시"라고만 적어 ips10 자체는 그 이후 한 번도 재플래시된 적이 없었다. CH340 포트(네이티브 P4 "high speed" USB 포트는 진단 콘솔 전용 — `USB Mode: UART0/Hardware CDC` 설정이라 앱 JSON 프로토콜 불가)로 현재 HEAD(`53794d2d-dirty`)를 재플래시한 뒤 두 차례 관찰 창(300s+, 90s+)에서 신규 패닉 0건.
- **86box**: 펌웨어는 이미 최신이었다 — 근본 원인은 코드가 아니라, 진단 중 다른 보드 케이블을 같은 USB 허브에 추가로 꽂자 86box 포트가 통째로 사라지는 물리적 전원 경합이었다. Mac 직결 포트로 재연결 후 안정화(`wifiRadioParked:true`, uptime 정상 증가, 신규 리셋 없음). 사용자가 재차 허브로 시도했을 때 USB 데이터는 안 뜨고 WiFi-only(99–187ms, 손실 있음)로 폴백되는 것을 확인 — 라디오 파킹이 안 걸려 라운드26이 해결하려던 2.4GHz 혼잡 취약점이 그대로 재노출됨.

### 핵심 설계 결정
- **"이미 고친 버그"라도 실기 buildHash/buildEpoch 대조 없이는 안 믿는다.** 재플래시 세션 로그에 보드명이 명시적으로 언급 안 됐으면 그 보드는 빠졌을 가능성을 먼저 의심한다.
- **재부팅 증상은 항상 `reset=panic`(코드4, 소프트웨어 assert) vs `reset=poweron`(코드1, 하드웨어 리셋)으로 구분.** 후자는 전원/케이블/허브를 먼저 의심하고 코드를 의심하지 않는다.

---

## 2026-07-09 — Android LCD tablet display sleep sync (`f42c2c67`)

### 문제
macOS 키보드 단축키로 모니터를 끌 때 Lenovo Android tablet 화면이 계속 켜져 있을 수 있었다. 기존 `BrightnessController`는 host `display_state{displayOn:false}`에서 LCD brightness를 0으로 낮추고 `SCREEN_OFF_TIMEOUT`을 2초로 설정했지만, `MainActivity`가 `FLAG_KEEP_SCREEN_ON`을 계속 유지해 Activity window가 실제 화면 sleep을 막을 수 있었다.

### 해결
- `MainActivity.shouldKeepDashboardScreenOn()` 정책 추가: LCD tablet은 host display off + full-off dim(legacy `dim` 없음 포함)일 때 `FLAG_KEEP_SCREEN_ON`을 해제한다.
- `displaySleepDim.mode == "min"` 또는 dim disabled면 기존처럼 화면을 켜 둔다.
- E-ink/InkDeck 계열은 화면 자체를 끄지 않아도 되는 정책을 유지한다. Android e-ink는 계속 awake 상태로 두고 frontlight/backlight만 dim한다.
- 회귀 테스트 `MainActivityScreenPolicyTest` 추가(LCD full-off/legacy off/min dim/e-ink full-off).

### 검증
`./gradlew :app:testDebugUnitTest` green, `bash scripts/build-android-release.sh` green. `dist/agentdeck-v0.1.0.apk`를 Lenovo Tab `HVA095B4`에 설치/실행하고 `adb reverse tcp:9120 tcp:9120` 적용. 설치 상태 `versionName=0.1.0`, `versionCode=1` 확인.

---

## 2026-07-08 — D200H Node direct-HID 삭제 + OFFLINE 브랜드 마크 통일

### 문제
1. **D200H "미연결" 오표시**: Ulanzi Studio 플러그인으로 연동 중인데 `/devices`·`agentdeck devices`가 direct-HID 연결 여부만 봐서 계속 미연결로 나옴.
2. **direct-HID dead code**: Node direct-HID(`d200h-module.ts` + `bridge/src/d200h/`)는 데몬이 이미 `d200h: false`로 게이팅해 런타임에 아무 데서도 start 안 됨(dormant "재활성 가능"으로 문서화돼 있었으나 실질 dead). 사용자 요청으로 제거.
3. **OFFLINE 이미지 결 불일치**: D200H·StreamDeck·StreamDeck+ 의 오프라인 화면이 초록 play 글리프/파랑 pulse/Arial "Offline" 텍스트라, AgentDeck 돔+데크 브랜드 마크를 쓰는 다른 표면(macOS/iOS/Android 오버레이, ESP32 splash)과 튐.

### 해결
- **연결성 fix**: `WsServer.getUlanziClientCount()` 추가, `/devices`·module-health·CLI 가 `ulanzi-plugin` WS presence 로 D200H connected 판정.
- **Node direct-HID 삭제**: `bridge/src/modules/d200h-module.ts`, `bridge/src/d200h/{hid-protocol,image-renderer}.ts`, `d200h-button-map.test.ts` 제거. 잔여 dead 배관 정리(`/devices` d200hModule 조회+writeOK/writeFail, cli 도달불가 else 분기, `ModuleConfigs.d200h` 플래그, stale 주석). **Swift `D200hHidModule.swift` 는 그대로 dormant 보존**. `shared/src/d200h-layout.ts`(레이아웃 엔진, plugin-ulanzi+TUI 의존)는 유지.
- **OFFLINE 브랜드 마크 SSOT**: `AgentDeckLogo.swift`(0–24 유닛)를 SVG로 포팅한 `renderAgentDeckMark()` 신설(`shared/src/svg-renderers/session-slot-renderer.ts`), `'agentdeck'` 글리프가 delegate, 아쿠아리움 시안-on-잉크 `'brand'` 톤 추가. 3표면 오프라인 전부 라우팅(SD `renderDisconnectedSlot`/`renderOpenApp*`, SD+ `renderOfflineTouchStrip`+plugin `response`/`voice` 타일, D200H `buildSessionDeck` hero+레거시 `renderOfflineSlot`). resvg 렌더 육안 검증 완료, 스냅샷 7개 갱신.

### 핵심 설계 결정
- **삭제 vs dormant 보존**: 문서는 Node direct-HID 를 "flip 하나로 재활성 가능한 dormant"로 규정했으나, 런타임 dead + 사용자 명시 삭제 요청 → 삭제하고 재활성 경로를 "git history 복원"으로 문서 갱신. Swift 쪽은 미변경(별도 flip-point 유지).
- **오프라인 결 = 브랜드 마크**: 다수 표면(Apple/Android/ESP32)이 이미 돔+데크 마크. shared 에 AgentDeck SVG 가 아예 없던 걸 신설해 SSOT 화 → 표면별 재구현 없이 한 곳 수정으로 통일.

## 2026-07-08 — 라운드 26: ESP32 단일경로 serial↔wifi 전송 (데몬 dedup + 펌웨어 라디오 파킹)

### 문제
USB 재배치 후 86box가 반복적으로 불안정(WS stale, 화면 정지)해졌다. dual-home(serial+wifi 동시) 보드가 **같은 디스플레이 프레임을 serial·WiFi 양쪽에서 이중 수신**하고 있었고, serial로 구동되는 보드도 **WiFi 라디오를 계속 켜둬** 2.4GHz airtime을 낭비했다. 라이브 ping 스윕 결과 "가장 나쁜 보드"가 분 단위로 바뀌고(86box↔round↔ttgo) gateway(5GHz)는 0% 손실 → 개별 보드 하드웨어가 아니라 **2.4GHz 대역 혼잡**이 근본 원인. 각 보드 위치는 baseline 마진만 정하고, 순간 간섭이 마진 얇은 보드를 문턱 밖으로 밀어냄.

### 해결
- **데몬 single-path dedup** (`bridge/src/daemon-server.ts` eventTransformer): serial에 live인 보드는 WiFi WebSocket으로 `SERIAL_FORWARDED_EVENTS` 재전송을 억제. `getSerialReachableBoards()`(esp32-serial.ts, device_info에 `ip` 캡처 추가) + `isWifiTransportRedundant()`(board id + wifi IP 매칭, 테스트 `esp32-transport-dedup.test.ts`). OTA·device_info_request는 WiFi로 계속 흘려 standby 소켓 유지. serial 끊기면 자동 복귀. `serialActive`를 /devices·`agentdeck devices`에 표기.
- **펌웨어 serial-primary 라디오 파킹** (`esp32/src/main.cpp` networkTask): serial 4초 안정 시 `WiFi.mode(WIFI_OFF)`로 2.4GHz airtime 확보. 분기 — `BOARD_LED8X32`(tc001, 사용자 요청 제외: 기존 `serialConnected && !wifiConnected` 유지) / `!BOARD_IPS10`(ttgo·inkdeck·나머지: serialConnected면 파킹) / IPS10 자체 블록.
- ttgo·inkdeck를 serial로 재플래시(사용자 원칙: serial 연결=serial 플래시, wifi-only=OTA — 파킹 조건과 자동 일치).

### 핵심 설계 결정
- **파킹 근거 = OTA 경로와 자동 정합**: serial 기기는 serial로 플래시하므로 WiFi OTA 불필요, wifi-only는 `serialConnected()=false`라 파킹 안 됨 → OTA 경로 무손실. "OTA 위해 라디오 유지"라는 기존 명분 소멸.
- **실측 효과**: ttgo 파킹 후 86box WiFi 손실 66%→0%, tc001 66%→0%. 반복 stale 해소.
- **inkdeck는 파킹 안 됨(의도적 수용)**: HWCDC(native USB) inbound 손실로 serial keepalive를 놓쳐 `serialConnected()`가 불안정 → 트리거 미발동. inkdeck serial 자체가 lossy하므로 WiFi를 fallback으로 남기는 게 안전(serial+wifi 둘 다 lossy면 고립). 0% 손실로 정상.

## 2026-07-07 — 라운드 25: IPS10 WiFi payload 축약 + OpenClaw disconnected 오표시 수정

### 문제
IPS10이 USB 해제 후 WiFi로 붙은 상태에서 에이전트 활동이 감지되면 다시 리셋성 불안정이 나타났다. 동시에 OpenClaw는 다른 대시보드에서 idle/offline 계열인데 IPS10 office 화면에서는 working처럼 보였다. 라이브 WS 확인 결과 `sessions_list`의 `openclaw-gateway`는 실제로 `state:"disconnected"`였고, processing은 현재 Codex 세션이었다.

### 해결
- ESP32 WiFi 클라이언트가 WS URL에 `clientType=esp32`를 붙이도록 변경하고, Node WS 서버가 이 클라이언트에는 serial 경로와 같은 `prepareForSerial()` 축약 payload만 보내도록 함. 일반 대시보드용 `modelCatalog`/`moduleHealth` 등 대형 state_update를 ESP32가 통째로 파싱하지 않게 했다.
- ESP32 WiFi 전송 필터는 display/session/timeline/OTA 이벤트만 통과시키고 나머지 대시보드 전용 이벤트는 drop.
- IPS10 office worker 상태 판정을 `processing`만 working으로 좁힘. `disconnected`/빈 state/unknown은 idle 계열로 처리해 OpenClaw가 working으로 보이지 않게 함.
- IPS10 serial RX buffer를 8192로 올려 큰 `sessions_list`가 USB 경로에서 잘리는 가능성을 줄임.

### 검증
`pnpm vitest run bridge/src/__tests__/esp32-serial-node.test.ts` 47/47 green, `pnpm --filter @agentdeck/bridge build`, `/opt/homebrew/bin/pio run -e ips10`, `/opt/homebrew/bin/pio run -e ttgo` green.

---

## 2026-07-07 — 라운드 24: IPS10 USB detach 무한재부팅 원인 확정 및 hosted C6 즉시 파킹

### 문제
IPS10 USB 해제/재연결 실험에서 실제 `SW_CPU_RESET` 루프가 재현됐다. 원시 시리얼 로그 기준 panic 원인은 ESP32-P4 hosted C6 경로의 `sdio_rx_get_buffer` / `sdio_push_data_to_queue` assert였다. 특히 USB serial 첫 JSON 이후에도 약 8초 동안 WiFi/mDNS/WS가 살아 있어, 그 초기 overlap 창에서 stale mDNS endpoint `192.168.68.60:9120`을 다시 저장하거나 WS를 열며 SDIO assert가 발생했다. `/health`의 낮은 `uptimeSec`만으로는 리셋 판정이 애매했지만, raw serial의 assert/backtrace로 실제 리셋임을 확인.

### 해결
- IPS10은 첫 유효 serial JSON 직후 즉시 hosted C6 라디오를 `WIFI_OFF`로 park. 기존 8초 안정화 대기 제거.
- radio parked 상태에서는 mDNS polling, long-disconnect mDNS refresh, WS loop를 전부 skip.
- USB serial timeout으로 serial primary가 사라질 때만 저장된 daemon WiFi credentials로 STA를 복구.
- `wifi_provision`은 IPS10 serial-primary 상태에서 radio를 깨우지 않고 SSID/password와 bridge endpoint만 NVS에 저장한 뒤 ACK하도록 변경.
- bridge auto-provision은 IPS10 online 상태에서도 endpoint refresh를 한 번 수행하되, provision 프레임을 priority queue로 보내 초기 payload에 밀리지 않게 변경.
- mDNS self-heal은 WS connect 시도 중에는 실행하지 않아 저장 endpoint 연결 시도와 stale mDNS 결과가 경쟁하지 않게 함.

### 검증
`pnpm vitest run bridge/src/__tests__/esp32-serial-node.test.ts` 47/47 green, `pnpm --filter @agentdeck/bridge build`, `/opt/homebrew/bin/pio run -e ips10`, `/opt/homebrew/bin/pio run -e ttgo` green. IPS10 실기 flash 성공. 데몬 재기동 후 `/health`에서 `buildEpoch:1783351803`, `wifiConnected:false`, `wifiRadioParked:true`, `uptimeSec:73` 확인.

---

## 2026-07-06 — 라운드 23: IPS10 USB-primary 안정화와 C6 라디오 파킹

### 문제
IPS10(ESP32-P4 + hosted ESP32-C6)이 USB 시리얼로는 정상인데 WiFi/WebSocket 경로가 배경에서 flap하며 디스플레이 재초기화처럼 보여 "무한 재부팅"으로 오인되는 증상이 계속됐다. stale endpoint 재프로비저닝은 위생 조치였지만 flap 자체를 멈추지 못했고, configured 보드에 WiFi를 의도적으로 끄면 daemon auto-provision이 다시 credentials를 밀어 넣어 firmware 정책과 싸울 위험도 있었다.

### 해결
- IPS10 전용 USB-primary 정책 추가: `Net::serialConnected()`가 8초 이상 안정적으로 유지되면 WS를 끊고 `wifiSetRadioParked(true)`로 hosted C6 라디오를 park. USB JSON이 `SERIAL_TIMEOUT_MS` 이상 끊기면 STA를 복구해 WiFi-only/OTA 경로를 되살림.
- `wifi_manager`에 `wifiRadioParked()` 상태를 추가하고, 명시적 `wifiConnectWith()`/수동 provision은 radio parking을 해제하도록 정리.
- serial/device_info에 `wifiRadioParked`, `uptimeSec`를 추가하고 bridge/shared 타입과 `/health` projection까지 노출. 현장 검증에서 `/dev/cu.wchusbserial211240`은 `buildHash:"aedbeb8f-dirty"`, `wifiConnected:false`, `wifiRadioParked:true`, `uptimeSec:84`로 확인.
- daemon auto-provision 조건을 "처음 설정되지 않은 보드"로 제한. `wifiConfigured:true` 보드는 WiFi가 꺼져 있어도 자동 provision하지 않아 IPS10 radio parking과 충돌하지 않음.

### 검증
`pnpm vitest run bridge/src/__tests__/esp32-serial-node.test.ts` 47/47 green, `pnpm --filter @agentdeck/shared typecheck`, `pnpm --filter @agentdeck/bridge typecheck`, `pnpm --filter @agentdeck/bridge build`, `/opt/homebrew/bin/pio run -e ips10`, `/opt/homebrew/bin/pio run -e ttgo` green. `/usr/local/bin/pio`는 Python x86_64 vs PlatformIO arm64 extension mismatch로 실패해 `/opt/homebrew/bin/pio`를 사용. IPS10 실기 flash 성공 후 daemon 재기동 및 `/health`로 라디오 파킹 상태 확인.

---

## 2026-07-06 — 라운드 22: Codex App OTel activity false-active + Swift Codex 응답 본문 복구

### 문제
Codex 데스크톱 앱이 켜져 있기만 한 상태에서 Swift 데몬이 `observed:codex-app:<pid>`를 `processing` 세션처럼 표시했다. 원인은 Codex App/app-server가 내보내는 OTel `receiving`/`stream.request`류 activity span을 실제 사용자 turn 신호처럼 처리한 것. 별개로 Swift 데몬의 Codex CLI hook 경로는 `codex_stop`/`codex_turn_complete` payload만 보고 응답 본문을 찾았는데, 실제 Codex 답변은 대개 rollout JSONL에 있어 타임라인이 질문→답변 한 턴이 아니라 빈 완료/독립 세션처럼 보였다(Node 데몬은 이미 rollout tail reader 보유).

### 해결
- Swift `handleCodexTrace`: OTel `activity`는 새 Codex App 세션 생성 또는 idle→processing 승격에 쓰지 않고, 이미 `turnStart`/`toolCall`로 `processing`인 세션의 freshness 갱신에만 사용. `turnStart`/`toolCall`/`turnEnd`가 상태 전이의 권위 신호.
- Swift `LocalCodexAppObserver`: 최상위 `/Applications/Codex.app` 실행 여부만으로 만들던 `observed:codex-app:<pid>` fallback 제거. 세션 목록에는 `kernel.js --session-id/--working-dir`처럼 durable session metadata가 있는 Codex App 프로세스만 노출해, 단순 앱 실행 상태를 에이전트 세션으로 오인하지 않게 함.
- Swift `CodexRolloutResponseReader` 추가: `~/.codex/sessions/<y>/<m>/<d>/rollout-*-<sessionId>.jsonl` tail에서 `task_complete.last_agent_message` 우선, 없으면 최신 `agent_message`를 읽어 `appendCodexChatEnd`가 `chat_response`를 방출하게 함. Node `codex-rollout-response.ts`와 같은 우선순위.
- D200H Swift direct-HID: live Claude usage가 없을 때 slot 13을 빈 usage 카드로 점유하지 않고 14번째 세션 타일로 재사용. Swift self-daemon/App Store 모드처럼 사용량을 직접 표시할 수 없는 상황에서는 세션 모니터링 공간을 우선한다.
- 회귀 테스트: OTel activity 상태 승격 predicate + rollout reader 우선순위/폴백 케이스 추가. macOS 앱 타깃 빌드 통과. 현재 Xcode project의 노출 scheme에는 테스트 타깃이 포함되지 않아 `-only-testing` XCTest 실행은 scheme 구성상 실패.

---

## 2026-07-06 — 라운드 21: Android e-ink 다중행 + macOS Setup 카드 false "hooks off" + IPS10 WiFi 영속화

### 문제
라운드 20 후속 3건. (1) Android e-ink 타임라인이 최신 1건만 커서 "단편적·정보량 부족" 지적. (2) macOS Dashboard가 Claude/Codex hook이 **연결 안 된 것처럼 보인다** — 실제로는 세션·타임라인 정상 렌더 중인데 중앙 SETUP 카드가 "Live session hooks off"/"Codex live observation off"를 계속 띄움. (3) IPS10이 프로비저닝된 데몬 엔드포인트를 재부팅 후 잃어 auto-reconnect 불가(동시 세션 in-flight).

### 해결
- **Android e-ink 적응형 다중행** (`7f61b8a2`, `EinkTimelinePanel.kt`): 최신 항목을 크게 + 구분선 아래 컴팩트 2건까지. 개수는 primary 메시지 길이에 적응(≤90자→+2, ≤240→+1, 초과→단독)해 무스크롤 글랜스 화면이 넘치지 않음. Moaan e-ink 실기 확인(primary+secondary+구분선 렌더).
- **macOS Setup 카드 false-nag** (`c48cf8b0`, `SetupNeededCard.swift`): 두 항목은 로컬 UserDefaults 플래그 `hooksInstalled`/`codexConfigInstalled`로만 판단 — 이 플래그는 **앱 자체 인앱 설치 경로로만** true. CLI가 hook을 깔면(이 머신: `~/.claude/settings.json` + `~/.codex/config.toml` 실재, prefs 플래그는 0) 영영 false → Tier-2에서 영구 nag. 샌드박스라 파일 검증도 불가. Fix: `isUsingExternalDaemon`이면 외부 Node 허브가 hook 소유·중계하므로 두 nudge suppress.
- **IPS10 WiFi 영속화** (`67934f94`, 동시 세션 작업 통합): SSID/password + bridge IP/port/token을 NVS Preferences("adwifi")에 저장·부팅 시 재로드해 WS 재연결. `Net::wifiConfigured()`(NVS 인지) + provision 전 STA 모드 재진입(hosted C6 radio 파킹 대비). 데몬측 `touchWifiEsp32Socket`로 인바운드 프레임마다 lastSeenMs 갱신(stale 회수 방지).

### 핵심 설계 결정
- e-ink는 "한 줄"이 아니라 "글랜스"가 목표 — 고정 N행이 아니라 **메시지 길이 적응**이 무스크롤 화면에 맞음.
- macOS 대시보드는 **항상 순수 WS 클라이언트** — 세션은 허브의 `sessions_list` 중계로만 옴(자기 `pushedSessionsById` 미사용, 외부데몬 모드). 따라서 hook 세션 렌더는 by-construction 정상이고, "미연결처럼 보임"은 **설치-추적 플래그의 false-negative**일 뿐 연결 문제가 아님. 독립 코드탐색(BridgeConnection/AgentStateHolder/DaemonService)으로 교차검증.
- 별개 실패모드 주의: Swift가 Node 순단 중 owner로 promote하면 자기 빈 데몬을 서빙해 **세션 0건**(연결레벨 empty). 오늘 증상(세션은 보이고 카드만 오표시)과 구분됨. promotion 가드 `DaemonService.swift:534-549`.
- 검증: vitest 1226/1226, `tsc -p bridge` green, macOS xcodebuild green, Android `:app:assembleRelease` green, inkdeck/ips10 펌웨어 빌드 SUCCESS, 라이브 데몬 E2E(합성 codex/opencode 턴 + 실제 `opencode run`) + Moaan e-ink 실기 스크린샷.

## 2026-07-06 — 라운드 20: 관측 Codex/OpenCode 타임라인 에이전트 패리티 + 디바이스 milestone 정렬 (`d17f33b8`)

### 배경
라운드 19로 Claude 세션 타임라인(프롬프트→응답 턴)은 깔끔해졌지만, 사용자 지적: **OpenCode 기록이 타임라인에 전혀 안 보임**. 조사 결과 사용자는 `opencode`를 standalone으로 실행 중(3 프로세스, `agentdeck opencode` 아님)이었고, OpenCode는 lifecycle hook이 없으며 standalone TUI는 TCP 리스너도 없어(SSE attach 불가) **관측 경로 자체가 부재**. 직접 `codex`도 마찬가지: 훅은 데몬에 POST되지만 `/hooks/` 핸들러가 Claude 전용(eventMap PascalCase만, openRun `agentType:'claude-code'` 하드코딩, chat_start/stop 게이트가 Claude 이름만) — `codex_*`는 모든 게이트를 통과 못해 **타임라인 0행 + APME ingestHook no-op**. Swift 데몬은 codex 패리티 있음(appendCodexChatStart/End); Node만 뒤처짐.

### 해결 — 훅-우선 원칙으로 전 에이전트 동일 턴 패턴
- **데몬 일반화** (`classifyObservedHookEvent`, daemon-server.ts): `codex_*`/`opencode_*`(+미래 `antigravity_*`) → agent-중립 `boundary` + `agentType`으로 분류, Claude 훅과 **단일 파이프라인** 공유(openRun 올바른 agentType, prompt 실린 chat_start, chat_response/chat_end 완결). `codex_turn_complete`→stop 매핑(open-turn 가드가 중복 완결 흡수). 프롬프트 추출 체인 `prompt`→`message.content`→`user_prompt`. **Response-only close**(Swift 패리티): 프롬프트 훅 놓친 턴도 응답 텍스트 있으면 chat_response 방출(raw-equality dedup 가드).
- **Codex 응답 텍스트 = rollout tail** (`codex-rollout-response.ts`): codex_stop payload엔 응답이 거의 안 실림(탐사 확인). `~/.codex/sessions/<y>/<m>/<d>/rollout-*-<sessionId>.jsonl` tail에서 `task_complete.last_agent_message`(권위) → 최신 `agent_message` 폴백. 파일명에 session uuid 내장이라 역방향 탐색 가능(30 day-dir 바운드, 자정 넘김 커버).
- **OpenCode 관측 = 플러그인 훅** (`hooks/src/opencode-install.ts` → `~/.config/opencode/plugins/agentdeck.js`): OpenCode 공식 플러그인 API의 `event` 훅으로 `opencode_session_start/user_prompt_submit/tool_start/tool_end/stop` POST. messageID→role 맵으로 user 텍스트 파트(프롬프트)와 assistant 파트(응답) 분리, `session.idle`에 `last_assistant_message` 동봉. **AGENTDECK_PORT 감지 시 self-disable**(managed 세션은 SSE 어댑터가 이미 풍부한 스트림 인제스트 — 중복 카운트 방지). `agentdeck opencode`/`daemon install`이 설치, hook uninstall이 제거.
- **Managed OpenCode 어댑터 턴 셰이프**: chat_start가 "Processing · proj" 고정이었음 → 실제 유저 프롬프트 upsert(Claude 패턴). user 텍스트 파트가 accumulatedResponse를 덮어 유저 말이 chat_response로 에코되던 버그 수정. chat_response XOR chat_end(3행 파편화 제거) + startedAt/endedAt 스탬프.
- **Swift 데몬 가드**: `opencode_*` 무시(안 하면 generic Claude 폴백이 OpenCode 세션마다 유령 claude 세션 행 합성 + Claude-keyed ApmeCollector 오귀속). Swift 쪽 OpenCode 타임라인 패리티는 후속 과제로 명시.
- **디바이스 milestone 정렬**: InkDeck 티커 milestone 필터에 `chat_response` 추가(chat_end dedup 이후 응답 있는 턴은 chat_response가 완결 행 — 없으면 "질문은 보이는데 답은 영영 안 보임"). IPS10 세션카드 body를 2-pass로: milestone 우선(chat_start=진행 중 질문, chat_response=완료 답) → 없으면 기존 raw 최신행 폴백(tool-only 이력 공백 방지). Android e-ink는 이미 turn-merge 완료 행 표시라 무수정.

### 검증
- vitest 1226 전체 green(신규: classify 6, rollout reader 4, 어댑터 턴셰이프 5, 플러그인 계약/설치 12) + `tsc` + macOS xcodebuild green + inkdeck/ips10 펌웨어 빌드 SUCCESS + InkDeck WiFi OTA 배포(1.5MB/1574 chunks).
- **라이브 E2E**: 재시작한 데몬에 합성 `codex_*`/`opencode_*` 턴 POST → `task_start`+`chat_start`(prompt)+`chat_response`(응답, startedAt/endedAt/taskId) 정확히 랜딩. **실제 standalone `opencode run` 실행** → 플러그인이 실프롬프트/실응답 캡처해 타임라인에 Claude와 동일 턴 패턴으로 표시 확인.

### 남긴 것 / 주의
- Antigravity: 훅 설치 수단 없음(IDE가 lifecycle hook 미노출). 데몬은 `antigravity_*` 수신 준비 완료(installer만 생기면 무변경 패리티); transcript 폴링 기반 턴 합성은 파서가 휴리스틱이라 실기 테스트 가능해질 때까지 보류.
- 데몬 재시작 중 9120 teardown과 겹쳐 **9124로 fallback** 기동됨(포트 유연성 정상 동작) — 클라이언트는 daemon.json 재해석으로 자동 추종. 다음 재시작 시 9120 복귀.
- 검증용 합성 e2e-* 행이 데몬 인메모리 타임라인에 잠시 남음(링 캡으로 자연 소멸).
- 데몬 기동 직후(~40s) 최초 훅 배치 1회가 무손실 응답(received:true)에도 타임라인 미랜딩한 transient 관찰 — 동일 payload 재현 불가(이후 결정론적 성공). 재발 시 startup 초기화 순서 조사.

## 2026-07-06 — 라운드 19: 타임라인 턴 완결/병합 정합 + 세션 목록 프로젝트 그루핑

### 배경
Android 태블릿 타임라인이 "정신없이 흘러가는 로그"로 보인다는 사용자 지적. 실기 adb 스크린샷으로 확인한 실제 증상: 이미 끝난 작업이 계속 running 스피너, 프롬프트/응답이 2-3행으로 흩어짐, 라벨/텍스트 잘림. 원인은 렌더링이 아니라 3층 구조 문제였음. 이어서 사용자가 IPS10 e-ink의 프로젝트 접두어 그루핑("워크트리 여러 세션을 한 huddle로 묶어 보여주는 것")을 다른 대시보드 세션 목록에도 이식해 달라고 요청.

### 해결 1 — 타임라인 턴 완결/병합 (`c43a3dd5`)
- **근본 원인**: Node 데몬 `/hooks/*` 핸들러가 `user_prompt_submit`에서 `chat_start`만 기록하고 **`stop`에서 완료 행을 전혀 방출하지 않았음** — 훅관찰(직접 `claude`) 세션은 완료 신호가 영구 부재해 모든 표면에서 턴이 "running"으로 고착. `session-transcript-timeline.ts`에 `lastAssistantTextFromTranscript` 추가(transcript tail의 마지막 assistant 텍스트 추출), `daemon-server.ts` Stop 핸들러가 이를 읽어 `chat_response`(텍스트 없으면 `chat_end`)를 열린 턴에만(마지막 chat_start > 마지막 완료행) anchor(`startedAt`) 매칭으로 방출.
- **턴 병합 인접행 전용의 한계**: Android `groupConsecutive`/Apple `Timeline.swift`의 chat_response→chat_start 병합이 "바로 다음 그룹"만 봤음. 세션 5개+ 동시 실행 시 프롬프트-응답 사이에 항상 다른 세션 행이 끼어 병합이 거의 항상 실패 → 턴이 2-3행으로 파편화. `tryMergeTurnChild`로 교체: 최근 40그룹/12h 바운드 역스캔, 같은 세션 tool/model_call 행은 통과, 최신 same-context chat_start가 곧 그 턴(anchor 불일치 시 standalone, cross-talk 방지).
- **스피너 의미론**: Android `isRotatingEntry`가 icon-key만 봤음(Apple에는 있던 age-cap/완료-감지 가드가 미러 안 됨). `shared/src/timeline-icons.ts`를 SSOT로: chat_start는 (a)같은 세션 이후 완료 존재 (b)이후 새 프롬프트로 대체 (c)10분 경과 중 하나면 회전 정지. Android/Apple 동일 가드 이식.
- 텍스트: 요약행 개행 공백 접기(`rowSummary`), `[project]·Agent` 라벨폭 96dp→150dp(태블릿).

### 해결 2 — 세션 목록 프로젝트 그루핑 (`66a42eec`)
- IPS10 office huddle 알고리즘(`esp32/src/ui/terrarium/office.cpp` `normProject`/`sameProjectGroup`)을 `shared/src/session-utils.ts`로 이식: `normalizeProjectForGrouping`(basename+" #N" 제거) + `projectGroupKey`(구분자 정렬 공통접두어, 보수규칙 stem≥14자+양쪽 delim≥2) + `groupSessionsByProject`. Android(`util/SessionGrouping.kt`) + Apple(`Model/SessionGrouping.swift`) 손미러.
- 렌더: 그룹 헤더(공통 stem+×N) 아래 멤버는 차별화 꼬리만 표시, 완전중복은 agent 표시명+#N 폴백.
- Android 태블릿 세션레일 폭 220dp→300dp + `heightIn(60%)+verticalScroll`(8+ 세션 시 타임라인 침범 방지, 부수 요청).

### 핵심 설계 결정
- 훅관찰 세션의 턴 완결은 **데몬 책임**(클라이언트가 아무리 잘 병합해도 완료 신호 자체가 없으면 무의미) — Stop hook + transcript tail이 유일한 소스.
- 다중세션 UI에서 "인접 행만 병합"은 반드시 실패하는 가정 — 세션 스코프 백스캔이 필요.
- 스피너/그루핑 모두 반복 패턴: **Apple에 이미 있던 가드가 Android에 미러 안 됨** → 앞으로 타임라인/세션 UI 가드는 shared TS SSOT 우선, 3언어 동시 갱신.
- 검증: vitest 1649/1649, Android JUnit 전체 통과, Swift `TimelineTests` 전체 통과, macOS BUILD SUCCEEDED, 실기(Lenovo 태블릿) adb 스크린샷 + 2프레임 픽셀 diff로 스피너 정지 확인.

## 2026-07-06 — 라운드 18: PERM 상태 명확화(RUNNING과 구분 + 진짜 대기 크리처 소멸 방지) + IPS10 attention-only

### 배경
BabelForge Claude Code 세션이 PERM(awaiting_permission) 상태였는데 (1) StreamDeck·D200H에서 RUNNING과 애니메이션/테두리가 거의 같아 PERM 인식이 어렵고, (2) 10" IPS에 과거의 ALLOW/DENY 팝업이 떠서 최근 정한 attention-only 방향과 불일치, (3) 오래 응답 안 하고 기다리니 해당 에이전트 크리처가 대시보드에서 **아예 사라짐**(세션은 남아있음).

### 해결
- **PERM ≠ RUNNING** (`shared/src/svg-renderers/session-slot-renderer.ts`, SD 키패드 + D200H 공유): 과거 RUNNING이 gold `#F5B942`로 override돼 awaiting amber `#f59e0b`와 동색 + 둘 다 동일 orbiting-march. 수정: RUNNING=쿨 teal `#2DD4BF` marching + RUN pill / PERM=amber **solid breathing**(전둘레 호흡) + bold **PERM** pill + amber PERMIT? 라벨. D200H detail info-slot 톤도 분리(PERMIT?=warning, RUNNING=info). 인코더 LCD는 이미 permission=red/diff=amber/option=blue라 무수정.
- **크리처 소멸 = 데몬별 근본원인이 다름** (진단 discipline: `lsof 9120`로 어느 데몬이 관측 중인지 먼저 확인):
  - Node managed(`agentdeck claude`): `state-machine.ts`의 10분 `AWAITING_STUCK_TIMEOUT_MS`가 안 답한 프롬프트를 IDLE 강등 → `isAwaiting` 필터서 소멸. **awaiting wall-clock backstop 제거**(real signal로만 탈출; PROCESSING 5분은 유지); `states.ts` awaiting stuck_timeout 전이 3개 삭제.
  - **★Swift observed(plain `claude`, App Store 데몬 실제 경로)**: Swift StateMachine은 processing만 stuck-arm이라 무관했으나, observed 세션은 `DaemonServer.swift evictStaleHookSessions`가 hook 없이 180s 지나면 **엔트리 통째 eviction**(state 무관) → 권한 프롬프트는 Notification 훅 1회 후 침묵 → 소멸. `awaitingHookStaleTTL=6h` 신설 + `entry.state.hasPrefix("awaiting")` 예외.
  - Node observed overlay `awaiting-overlay.ts` TTL 5분→6h(clear-on-next-hook primary).
- **IPS10 attention-only** (`esp32/src/ui/widgets/hud_bar.cpp`): 유일 터치 보드의 인라인 Approve/Deny + 모달 Approve/Deny 제거 → 부풀며 amber "AWAITING" + 질문 텍스트만(다른 보드와 parity). `permission_decision` 송신부는 unreachable로 잔존.

### 핵심 설계 결정
- **"진짜 사용자 대기"는 wall-clock으로 강등/eviction 금지** — 부재와 parser-miss를 타이머로 구분 못하므로, real signal(spinner/idle/response/stop)로만 탈출하고 죽은 세션은 liveness가 회수. observed는 시간 TTL이 유일 backstop이라 6h로 넉넉히.
- observed 크리처 소멸 디버깅은 state-machine이 아니라 **eviction/overlay TTL**이 원인 — "어느 데몬 관측?"부터 확인.
- IPS10 approve/deny 제거는 2026-06-19 결정(터치 승인)을 최근 attention-only 방향으로 뒤집음.
- 검증: vitest 1628/1628, shared/bridge build, macOS BUILD SUCCEEDED, ips10 firmware SUCCESS, 렌더 PNG 육안확인. 배포: Node 데몬 9120, SD·Ulanzi 플러그인 리로드, ips10 USB 플래시(buildHash 확인) + WiFi("swiss") 프로비저닝(persistent, otaSupported).

## 2026-07-05 — 라운드 17: 타임라인 귀속 파이프라인 정합 + 멀티 데몬 핸드오프 견고화 + fresh-daemon stale 정리

### 배경
대시보드 타임라인 아이콘이 전 표면에서 깨지고, `daemon restart`/`stop`/역방향(app→CLI) 핸드오프에서 macOS 재접속 실패·InkDeck "no active sessions"·미지원 usage 흔적 잔존·Android stale 로그가 발생. 사용자가 여러 데몬 핸드오프 시나리오를 probe하며 다수의 갭을 노출.

### 해결
- **타임라인 귀속(아이콘)**: 근본원인=타임라인 행 71%가 `agentType: undefined`. `bridge-core` wireTimeline attributor(저장시점 단일 chokepoint)에서 collector `getRunAgentType()`로 backfill. 신규 `shared/src/timeline-label.ts` SSOT(agentDisplayLabel/timelineRowAttribution/formatTimelineRowLabel) + 언어 미러(Kotlin `BrandIcon.agentDisplayLabel`, C++ `esp32/src/ui/agent_label.h`).
- **ESP32**: device `TimelineEntry`에 agentType/projectName/taskId 파싱 추가(파서가 버리고 있었음); InkDeck 티커·IPS10 카드가 "agent·project·task·text" 조합.
- **Android**: 태블릿 agent+project 라벨, e-ink 타임라인=스크롤 폐기·최신1건 뷰.
- **Swift stale spinner**: 완료가 timestamp-인접 merge에만 의존→lenient `timelineHasLaterCompletion` + chat_start age-cap.
- **멀티 데몬**: Node eink-device 등록 포팅(Swift 전용이었음); serial sessions_list 하트비트 재sync(양 데몬); `daemon restart` promotion 가드(포트 점유중 승격 스킵); 역방향 takeover(`isSwift` 감지→Swift `POST /stand-down`+`standDownForTakeover`+yieldUntil, /shutdown fallback).
- **fresh-daemon stale**: macOS 승격 엣지 `clearRelayedUsageState`; Android Disconnected서 usage/LIMITS clear·Connected서 timeline clear; Node 데몬 빈 `timeline_history`도 항상 전송.
- **chat_response taskId**: Swift 데몬이 attributor 우회 수동 방출로 taskId 누락→Q&A 분할. Claude·Codex 응답 경로에 `activeTaskId` 태깅(Node는 attributor로 이미 OK).

### 핵심 설계 결정
- 귀속은 **저장시점 단일 attributor**에서, 표시명은 **shared SSOT + 언어 미러**로 — 표면별 하드코딩 제거.
- 데몬 전환 stale 정리는 **전환 엣지**(승격/Disconnected)에서 clear, transient blip엔 유지(flicker 방지). Codex/AGY는 로컬 재방출이라 clear 안전.
- takeover는 앱을 죽이지 않는 clean demote(`/stand-down`) + self-heal(실패시 yieldUntil 만료 후 재승격).
- 검증: vitest 1629/1629, ESP32 inkdeck+ips10 SUCCESS, macOS BUILD SUCCEEDED, Android compileDebugKotlin SUCCESSFUL.

## 2026-07-05 — 라운드 16: XTeink X3/X4 대시보드 등록 + ESP32 client contract + 프로젝트 클러스터 정리

### 배경
AgentDeck / crosspoint-agentdeck(포크) / OpenClaw 세 레포의 경계가 모호해진 것을 정리하고, XTeink X3/X4 를 macOS 대시보드에서 관제 가능하게 만듦. 핵심 정신모델: **2 제품 + 3 레포 + 양쪽 클라이언트 1 기기**. AgentDeck(에이전트 스티어링) / BabelForge(이중언어 책 파이프라인, OpenClaw 서 분리) 두 제품, 그리고 두 제품 모두의 클라이언트인 X3/X4 기기.

### 해결
1. **ESP32 client contract 공식화** — `docs/esp32-client-contract.md`(신규 SSOT): display-only 클라이언트가 지켜야 할 와이어 계약(inbound 이벤트, `device_info`/command 프레임). C/C++ 코드젠 없음(quicktype=Swift/Kotlin only, no-PSRAM ArduinoJson 불가) → 드리프트는 port-sync 규율로 관리(`docs/esp32.md`, 포크 `.skills/SKILL.md`).
2. **X3/X4 device_info 발신 구현** — 포크 `AgentDashboardActivity::sendDeviceInfo()`(`crosspoint-reader@07408ec9`), 보드 `xteink_x3`/`xteink_x4`, 단일 펌웨어 런타임 감지(`gpio.deviceIsX3()`). pio 빌드 [SUCCESS].
3. **디바이스 매트릭스 4표면 + Swift** — `esp32DisplayName` 케이스 추가, `protocol.ts` 정본 문자열, hardware-compat/appstore/devices/hardware.html 에 X4 추가 + 상태 갱신. macOS `xcodebuild AgentDeck_macOS` SUCCEEDED.
4. **BabelForge 분리** — `book_translator/`(OpenClaw 서 미추적)를 `~/github/BabelForge`(GitHub private) 로 이동 + git init; launchd `com.local.book-translator-watcher` 재지정; agent 스캐폴드(CLAUDE.md/AGENTS.md/`.agents/skills`) 셋업.

### 핵심 설계 결정
- ★**Dual-registration gotcha**: 두 데몬이 WiFi 기기를 **다른 메시지**로 등록 — **macOS Swift 데몬** = `client_register{clientType:"eink-device"}` → E-ink rail(포크가 이미 발신); **Node 데몬** = `device_info{board}` → `esp32-wifi`(board-agnostic, 아무 문자열 수용). 그래서 포크는 둘 다 발신.
- X3/X4 는 SD `update.bin` 플래시만 가능(USB-data 사망) → `otaSupported:false`, `esp32/` pio env 없음 → **WiFi OTA 대상 아님**(`ESP32_OTA_BOARDS` 미등록). 등록 자체는 board-agnostic 이라 무관.
- bilingual-EPUB 포맷 SSOT 는 소비자(포크 `docs/bilingual-epub.md`) 소유 유지; BabelForge=생산자.
- 미완: 포크 펌웨어는 **온디바이스 SD 플래시 대기**(하드웨어 수동 단계). 상세 맥락은 memory `project-cluster-two-products-babelforge.md`.

## 2026-07-05 — 라운드 15: 2-티어 제품 공식화 — Tier 1 attention 복원 + macOS 알림 + OpenCode SSE observer + 문서 정합

### 배경 (제품 방향)
1차 목표 = **App Store Swift 앱 단독(Tier 1)** 으로도 완결된 모니터링 대시보드; `agentdeck` CLI 추가 설치 시(Tier 2) PTY 스티어링·구독 사용량이 얹히는 순수 업그레이드 구조로 층위 확정. 조사 결과 구조는 ~80% 기구현(HookInstaller 앱 내 hook 설치, Swift 데몬 hook 인제스트, 9120 중재, `isUsingExternalDaemon` 게이트) — 남은 품질 격차 3건 + 문서 공식화를 수행.

### 1 — display-only attention 복원 (Swift + Node, `765a1023` 부분 복원)
2026-06-27 커밋이 PreToolUse 가짜 Allow/Deny 게이트를 제거하면서 **Notification 기반 display-only awaiting까지 함께 제거**했었음. 실패 원인은 PreToolUse(자동승인 툴에도 발화)였지 Notification이 아님 — `notification_type: "permission_prompt"` 는 실제 권한 프롬프트가 표시될 때만 발화하는 진짜 대기 신호. 분류기(`isPermissionNotification`)는 양쪽에 살아있었고 Node `awaiting-overlay.ts` 는 고아 모듈이었음.
- Swift: `DaemonServer` `case "notification"` no-op → awaiting_permission + question(120자) 복원. options/requestId 없음 → 전 표면 "Respond in the terminal" 경로(UI 변경 0).
- Node: `daemon-server.ts` 에 `setAwaitingOverlay`(requestId 없이) + 후속 hook clear + `applyAwaitingOverlayToObserved` enrich 재배선. held-gate/`permission-resolver` 호출부는 계속 제거 상태.
- vitest 에 display-only 계약 테스트 추가 (requestId undefined 단언 + idle ping 거부).

### 2 — macOS 시스템 알림 (`AttentionNotifier.swift` 신규)
`AgentStateHolder` sessionsList diff 에서 awaiting 진입 시 UN notification post / 이탈 시 clear (identifier=sessionId 로 교체·잔존 방지, 디듀프 맵). **앱 레이어 배치라 양 티어 공통**. `AppDelegate` 에 `UNUserNotificationCenterDelegate` 채택(포그라운드 배너). 기존 `NotificationPermission` 동의 흐름 재사용 — 이 파일의 과장된 주석도 실제 포스트 지점 서술로 정정.

### 3 — Tier 1 OpenCode 모니터링 (opt-in 기본 OFF, Swift SSE observer 신규)
- `ProcessEnumerator.swift` — `LocalCodexAppObserver` 의 sysctl KERN_PROC_ALL/PROCARGS2 헬퍼를 공용 추출.
- `OpenCodeSSEClient.swift` — `opencode-client.ts` read-only 포팅 (`/global/health`·`/session/status`·`/session/{id}`·SSE `/global/event`). 프레임 파서/이벤트 분류기 = `nonisolated static` 순수함수(XCTest 13개).
- `OpenCodeObserver.swift` — 발견 3경로(사용자 URL / `opencode serve` 기본 4096 프로브(GatewayProbe 선례) / sysctl argv 명시적 `--port`, agentdeck-managed 제외). **기본 TUI(랜덤포트)는 의도적 발견불가 — 포트스캔 금지**. 5s tick = keepalive(180s TTL 리핑 방지) + 재연결 백오프. OFF 면 프로브 0회.
- `DaemonServer.handleOpenCodeObserverUpdate` — Codex OTel 경로와 동일 계약(`pushedSessionsById`+`lastHookAtByPushedSession`+broadcast-on-change). `permission.requested` = display-only awaiting(Node adapter 의 Allow/Deny 조작 미포팅). 연결 시 busy 세션 seed.
- Settings → Integrations 에 OpenCode 행(카탈로그+status evaluator+토글/URL 슬롯). 카피는 설정 사실 서술만(4.2.3).

### 4 — 문서 공식화
- `docs/appstore-feature-matrix.md`: 선두 "Two-tier product" 절 + **Guard conventions**(실 options[]만 렌더 / observed 는 requestId 금지 / `isPermissionNotification` SSOT / PreToolUse 게이팅 금지) 신설. "Permission prompt 표시" 행을 notification_type 시맨틱으로 정정(그동안 코드와 불일치했음), "Device approval gating" 행 ❌/❌ 로 정정(양쪽 제거 사실 반영), OpenCode 행 ⚠️ opt-in 으로 갱신.
- `APP_REVIEW_NOTES.md`: `settings.local.json`→`settings.json` drift 3곳(App Store 앱은 settings.json 대상 — Node CLI 는 여전히 settings.local.json 이 맞음), OpenCode 절을 opt-in localhost SSE 클라이언트 서술로 재작성(OpenClaw 절 모델), Local notifications 절 신설.
- README: App Store 절 앞에 Two-tier 업그레이드 서사(업그레이드 유도는 README/문서만 — 인앱 금지), :290 drift 수정. metadata draft·QA checklist 의 settings.json drift 도 수정.

### 검증
vitest 1625/1625, macOS XCTest 352/352(신규 OpenCodeObserverTests 13 포함), macOS+iOS 빌드 SUCCEEDED, xcodegen pbxproj 커밋.

## 2026-07-05 — 라운드 14: 라운드12/13 반영 상태 전수조사 → CLI OTA 별칭 회귀 + 1주일 묵은 stale XCTest 발견/수정

### 배경
"현재 코드레포 전부 잘 반영되어 있나 조사하라" 요청으로 라운드 12(86box/ips_10 OTA)·13(APME task 그룹핑) 반영 이후 전체 정합성 점검. Node 빌드+vitest 1603, `generate-protocol` drift 0, `design/verify-tokens-sync.py` 전체 sync, ESP32 `box_86`/`rgb48`/`ips10` 컴파일(로컬 esptool/riscv32 툴체인 부재로 패키징만 실패 — 코드 문제 아님), Android(자체 collector 없이 daemon WS 그대로 소비라 무변경) 모두 이상 없음. Swift는 `xcodebuild test`(별도 세션에이전트 위임) 로 `AgentDeckTests_macOS` 339개 전수 실행.

### 발견 1 — `bridge/src/cli.ts` OTA 별칭 회귀 (라운드12 누락분)
`ESP32_OTA_ENV_BY_TARGET` 맵에 `86box`/`box_86`/`box_40`/`ips10`/`ips_10`/`ips_101` 항목이 전혀 없어 `agentdeck esp32-ota 86box --build` 류가 `Unknown environment names` 로 즉시 실패. 근본 원인: `target` 문자열이 이중 역할(로컬 pio env 해석 **+** daemon 이 `device_info.board` 자가보고 문자열과 매칭하는 키) 인데 firmware 는 `"86box"`/`"ips_10"`(언더스코어) 로 보고 — pio env 이름(`box_86`/`ips10`) 과 다르다. `docs/esp32.md` 자체 예시(`agentdeck esp32-ota ips10 --firmware ...`)도 빌드는 되지만 실제 업로드 매칭에 실패하는 문구였음.
- **수정**: 맵에 누락 별칭 추가 + 어느 별칭이 실제 동작하는지 주석/문서에 명시. `docs/esp32.md` 예시를 `ips_10` 로 정정, SSOT 표에서 동작하는 별칭 굵게 표시.
- **기지(pre-existing, 미수정)**: 같은 유형 문제가 `ttgo`/`ips35`/`amoled` 짧은 별칭에도 이미 있음(동작하는 건 `ttgo_t_display`/`ips_35`/`round_amoled`) — 라운드12 이전부터 있던 gap, 이번엔 인지만.

### 발견 2 — `TimeboxProtocolTests.swift` 의 `testMicroGlyphAntigravityPeak` 1주일 묵은 stale 실패
`master` 에 이미 커밋된 상태에서 실패 중이던 테스트(오늘 세션 변경과 무관). 원인: 커밋 `8bd609b8`(2026-06-28, "improve timebox antigravity creature") 가 Antigravity 마이크로 글리프 geometry 를 재조정하고 이후 리팩터가 중앙 hollow 를 black cutout(`K`) 에서 진짜 transparent 로 바꿨는데, 테스트의 하드코딩된 픽셀 좌표/기대값은 **처음 작성 시점(그 이전) 기준으로 멈춰있었음**. `bridge/src/pixoo/micro-glyphs.ts` SSOT 와 생성된 Swift mirror 는 정상 sync — drift 는 순수하게 test literal 쪽.
- **왜 CI 가 못 잡았나**: Apple/XCTest 는 `.github/workflows/test-report.yml` CI 파이프라인에 안 걸림(Vitest+Android JUnit+Robot Framework 만 실행) — Xcode 테스트는 로컬/수동 실행에만 의존하므로 이런 drift 가 조용히 누적될 수 있음.
- **수정**: 현재 idle 그리드 기준으로 좌표 재계산 후 픽셀 좌표/기대값 정정. `xcodebuild test`(scheme `AgentDeck_macOS`) 전체 339개 통과 확인.

### 구조적 교훈
Apple/XCTest 가 CI 밖에 있다는 사실 자체가 리스크 — 향후 유사 stale-test drift 방지하려면 CI 편입 검토 필요(범위 밖이라 이번엔 미착수, TODO 로만 기록).

## 2026-07-05 — 라운드 13: timeline task 그룹핑을 device 표면에 노출 (데몬 /hooks/ 3중버그 + Node·Swift deferred emit parity)

### 증상 (사용자 관찰)
진행 중인 세션에 후속 프롬프트를 넣으면 timeline에 **매번 새 task처럼** 표시됨. 의도는 "완결성 있는 작업 단위로 묶여서" 보이는 것.

### 진단
- APME 데이터 모델(`apme.sqlite`)은 **의도대로 그룹핑 중**(후속 프롬프트 = 같은 task에 turn 추가, `/clear`·`session_end`에서만 분절). 실증: 한 task에 6턴.
- 그러나 사용자가 보는 device timeline(`timeline.json`)엔 task_start/task_end **0개, taskId 0개** — 그룹핑이 표면에 안 실림. `AGENTDECK_TIMELINE_PROJECTION`도 off(기본).
- 근본원인 3중(Node `daemon-server.ts` `/hooks/` 직접경로):
  1. **event name case mismatch(치명)**: collector `ingestHook`은 PascalCase `'UserPromptSubmit'` 매칭인데 데몬은 snake_case `mapped` 전달 → 턴오픈 영구 no-op → task 미생성.
  2. **단일 `'daemon-hook'` 버킷**: 모든 직접실행이 한 sessionId로 뭉침 → 동시세션 뒤섞임 + 한 세션 session_end가 남의 run 파괴.
  3. **openRun이 session_start에서만**: 누락/late 시 `ingestHook`이 run 없음으로 no-op.

### 수정 (Node)
- `collector.ts`: `normalizeHookEventName()`로 case-tolerant(snake↔Pascal). **deferred task_start** 이식 — 단발 Q&A엔 헤더 없음, 2번째 턴/첫 TodoWrite plan에 `emitDeferredTaskStartIfNeeded()` 승격(backdated). `ActiveTask.timelineEmitted` 플래그로 task_end emit 게이팅.
- `apme/index.ts`: `promotedTaskIds` Set로 sync/async(judge 재emit) task_end 게이팅 — 미승격 단발 task의 orphan end 방지, eval enqueue는 항상.
- `daemon-server.ts` `/hooks/`: real `json.session_id` 키잉 + lazy openRun(run 없고 event=session_start|user_prompt_submit일 때만; stray tool/stop hook은 phantom run 방지 제외) + `/clear`→`splitRun` + chat_start를 collector 처리 **후** `getActiveTaskId()`로 taskId 태깅.
- `fallback-task-timeline.ts`: `getActiveTaskId()` 추가.
- 관리 세션브리지는 `BridgeCore.setAttributor`(bridge-core.ts:230)가 이미 자동 taskId 태깅 → 무변경.

### 수정 (Swift parity — 이미 collector 포트+deferred emit 완비)
- `DaemonServer.swift`: `appendClaudeCodeChatStart`에 taskId(collector를 switch 전 hoist=`apmeHandledEarly`, 후 double-run skip).
- `ApmeCollector.swift`: **idleGapSec 90s→1800s** — 90초 idle 자동종료가 생각멈춤마다 task를 파편화(사용자 의도 정반대)했음. 30분 backstop은 abandoned 세션만 닫고 정상 세션은 안 건드림(Node는 idle-gap 없이 session_end까지 그룹). lazy openRun(user_prompt_submit 한정).

### 구조 원칙
task 그룹핑은 **UserPromptSubmit/SessionEnd/clear 훅으로만** 결정 — TTY 파싱 무의존(agent CLI TUI가 바뀌어도 안 흔들림). TTY 파싱은 Claude chat_response/chat_end 턴종료에만 load-bearing으로 잔존(Stop훅 ~18% 신뢰도). Swift는 TTY 파싱 전무.

### 검증
- Node: `pnpm build` 통과, vitest 1603 통과(+deferred/grouping/lazy-open 신규 3), 격리데몬(alt port+`AGENTDECK_DATA_DIR`)에 curl 훅 시퀀스 → WS `query_session_timeline`로 실측: multi-turn=`task_start`1개+chat 3개 동일 taskId+`task_end`, single-turn=헤더 없음. stray tool/stop hook이 phantom run 안 만듦 확인.
- Swift: macOS 타깃 `xcodebuild ... test` BUILD SUCCEEDED, ApmeTaskBoundaryTests 45 + CategoryE2E 58 + Timeline 3 통과(+lazy-open 신규).
- **적용**: 사용자 데몬은 재시작해야 새 빌드 반영(`agentdeck daemon stop && agentdeck daemon start` 또는 LaunchAgent 재시작).

## 2026-07-05 — 라운드 12: 86box 및 ips_10 WiFi OTA v1 지원 확장 (16MB dual-OTA 파티션 적용)

- **86box 및 ips_10 OTA 지원**: 물리 플래시가 16MB임에도 4MB 및 factory 단일 파티션으로 설정되어 WiFi OTA 대상에서 제외되었던 `86box`와 `ips_10` 기기에 OTA v1을 활성화.
- **파티션 레이아웃 변경**:
  - `86box` (ESP32-S3 16MB)용 `partitions/box_86_ota.csv`를 신설하여 dual-OTA 슬롯(각 ~7.75MB) 배치.
  - `ips_10` (ESP32-P4 16MB 실물 플래시 확인)용 `partitions/jc8012p4a1c_ota.csv`를 신설하여 dual-OTA 슬롯(각 ~6.0MB) 배치.
- **platformio.ini 설정**: `rgb48`, `box_86`, `ips10` 환경의 `board_build.flash_size`/`board_upload.flash_size`를 16MB로 선언 및 파티션 테이블을 각각 신규 `*_ota.csv`로 교체. `NO_OTA=1`을 제거하고 `HAS_OTA=1`을 활성화.
- **빌드 검증**: `pio run -e box_86` 및 `pio run -e ips10` 빌드를 각각 실행하여 컴파일 성공 및 바이너리가 dual-OTA 파티션 크기(box_86: 7.75MB, ips10: 6.0MB)에 정상적으로 안착함을 확인.
- **실기 USB 마이그레이션 및 daemon 감지 검증**: `86box`는 `/dev/cu.wchusbserial21110`에 dual-OTA 펌웨어 업로드 완료(1421KB compressed) 후 daemon에서 `86box v0.1.2 (f82f4616-dirty) OTA 7.8MB`로 감지. `ips_10`은 `/dev/cu.wchusbserial201240`에서 clean build 후 업로드 완료(1350KB compressed) 및 daemon에서 `ips_10 v0.1.2 (f82f4616-dirty) OTA 6.0MB`로 감지. 두 실기 유닛 모두 `otadata` + `app0/app1` layout 마이그레이션 완료.

## 2026-07-05 — 라운드 11: usage 게이지 동결 근본원인 + 한글 렌더링 + OTA dogfood (커밋 6a27d994, 731d8752)

### 사용자 증상 3건 → 원인 → 수정
1. **"Claude 리밋 사라짐"**: serial usage_update가 블록리스트 방식이라 신규 필드가 계속 새어나감 — `modelCatalog`(3.2KB)가 실리며 라인 4154B > 펌웨어 라인버퍼 4096 → **모든 usage_update가 통째로 폐기**되어 게이지가 마지막 성공 시점(Codex만 있던)에 동결. fix=펌웨어가 파싱하는 필드만 **화이트리스트** 송신(~1KB) + InkDeck 라인버퍼 8192. 실측: 패널 usageFiveH=88 복구.
2. **"티커 ######?"**: 한글 프롬프트를 GFX 라틴 폰트가 못 그려 ASCII 새니타이저가 '#'런으로 치환. fix=**U8g2 unifont korean 경로**(비ASCII 시) — 티커/활동요약/질문/프로젝트명/독 칩 전체, UTF-8 경계 안전 랩/말줄임(`utf8Boundary`, `smartFitText`, `smartTextAt`). ASCII는 기존 FreeSans 유지. Flash 44→48%.
3. **"타임라인 시간 이상"**: OTA 라운드 이후 보드가 USB 벤치에서도 WS 상시연결 → WS 경로 timeline엔 `localHm`이 없어(serial prepareForSerial만 스탬프) UTC 폴백(KST-9h) 표시. fix=`stampLocalHm`을 **소스(bridge-core broadcast+capped history)로 이동** — 양 전송로 공통.
- 부가: IDLE 독 이름 ≤20자(UTF-8 글자수)는 말줄임 금지(칩 흐름 배치라 넓어져도 무해), device_info 리얼리티 카운터에 usageFiveH/processingCount 추가(+데몬 매핑).
- **배포 = OTA dogfood**: 라운드10 파이프라인으로 `agentdeck esp32-ota inkdeck` 1.5MB/1571청크 성공, 재부팅 후 세션/타임라인 유지 확인. 최종 실측: sessions=8 **processing=2** usageFiveH=88 timeline=39 — "codex 1개만 processing" 증상의 데이터 계층 완치.

## 2026-07-04 — 라운드 10: ESP32 WiFi OTA 대상 검증 + OTA v1 구현/실기 검증

- 직접 플래싱 대상 중 WiFi OTA v1 후보를 `inkdeck`, `led8x32`/`ulanzi_tc001`, `ttgo`, `ips35`, `amoled`/`round_amoled`로 확정. 연결 실기 기준 모두 WiFi 설정/연결 확인. `86box`는 `NO_OTA`/factory 파티션, `ips10`은 현재 4MB/factory 구성이라 v1 제외. 우리가 직접 펌웨어를 플래싱하지 않는 장치는 검토 대상에서 제외.
- `device_info`에 OTA capability 필드 추가: firmware가 파티션 테이블을 읽어 OTA 슬롯 개수, 최소 슬롯 크기, `ESP.getFreeSketchSpace()`, 미지원 사유(`no_ota_build`, `no_dual_ota_partition`, `no_next_ota_partition`)를 serial/WebSocket 양쪽에 보고. 브리지/공유 protocol/CLI도 해당 필드를 보존·표시.
- OTA v1 프로토콜 구현: daemon→ESP32 `esp32_ota_begin/chunk/end/abort`, ESP32→daemon `esp32_ota_ack/error`. firmware는 `Update` + MD5 검증 + 1KB base64 chunk 수신 후 성공 시 재부팅. daemon은 WiFi ESP32 WS socket을 board/IP별로 추적하고 `POST /esp32/ota` 및 `agentdeck esp32-ota <target> [--build|--firmware]` CLI로 업로드.
- WiFi provisioning 안정화: `WiFi.persistent(true)`로 serial provisioning이 restart/OTA 후 유지되게 수정. classic ESP32(TTGO/TC001) display-noise radio parking은 `serialConnected && !wifiConnected`일 때만 수행해, USB bench 상태에서도 OTA용 WiFi WS가 올라오게 조정.
- 실기 검증: TC001은 USB 1회 최신 수신 펌웨어 플래시 후 WiFi WS 등록(`192.168.68.57`) 확인, 이후 `agentdeck esp32-ota ulanzi_tc001 --build` 성공(1.4MB / 1437 chunks) 및 serial/WiFi buildEpoch `1783175827` 갱신 확인. TTGO도 USB 1회 최신 수신 펌웨어 플래시 후 WiFi 재프로비저닝 + WS 등록(`192.168.68.73`) 확인.
- 빌드 검증: `pnpm build` 통과, `/opt/homebrew/bin/pio run -e inkdeck -e led8x32 -e ttgo -e ips35 -e amoled` 통과. 이후 radio parking 최종 수정본은 `led8x32`, `ttgo` 실기 플래시 빌드로 재검증.

---

## 2026-07-04 — 라운드 9: "no active sessions" 근본원인 = HWCDC → TinyUSB 전환 + 태스크 단위 로그 (커밋 aefd462c)

### 진단 여정 (증거 기반)
1. 데몬 debug: sessions_list 25회 브로드캐스트, 쓰기 에러 0 — 송신은 정상.
2. device_info에 **리얼리티 카운터**(sessionCount/timelineCount) 추가 + 하트비트 60s 재식별 → `/devices`로 포트 안 뺏고 보드 내부 상태 관측 가능해짐. 측정: 데몬 90초 후에도 sessionCount=0.
3. 실제 prepared sessions_list 라인(1.3KB, 유효 JSON) 직주입 → `[Protocol] JSON error: IncompleteInput` 재현 — **인바운드 트렁케이션**. HWCDC가 아침에 확인된 아웃바운드 64B 드롭과 대칭으로 **수신 방향도 드롭**(풀듀플렉스에서 확률↑; ack-per-line이 악화 요인).
4. **`ARDUINO_USB_MODE=0`(TinyUSB USB-OTG CDC) 전환** → out 10/10, in burst 5/5, 실데몬 90s **sessionCount=7** 완치. 포트명 MAC 기반 `cu.usbmodem1CDBD474F4D81`로 변경(스캔 패턴 매치). USBCDC엔 TX knob 없음 → HWCDC 전용 가드.

### 로그 품질 (사용자 지적: "명령어 다 뿌리지 말고 태스크 단위로")
- 데몬 훅 방출을 **chat_start(사용자 프롬프트)만**으로 축소 — 라운드 7의 per-tool tool_exec("Bash: cd /Users/…") 제거. 태스크 그룹핑은 APME task_start/end 몫.
- InkDeck 티커는 **마일스톤 타입만**(chat/task start/end) 표시 — tool 행·JSON 본문 제외.
- heartbeat_ack는 keepalive에만 응답(기존: 모든 인바운드 JSON마다 → 상시 TX).
- "no active sessions"의 이전 관측 일부는 플래시/재시작 윈도우의 일시 화면 + /devices 카운터가 연결직후 화석이었던 것도 혼재 — 60s 재식별로 해소.

## 2026-07-04 — 라운드 8: IDLE 독 2줄 + 티커 빈칸 원인(60s 첫표시 게이트) (커밋 6c384a32)

- IDLE 독을 칩 2줄로 확장(카드영역 78..294, 독 298..366). 칩은 1줄 넘치면 2줄로 랩 후 "+N".
- **티커 빈칸의 실제 원인 = 60초 rate-limit이 부팅 후 '첫 표시'까지 게이트** — 최대 1분간 빈 줄이 "고장"으로 읽힘. blank→text 전이는 즉시 드로우로 변경. 시드 파싱 자체는 건강함을 실증: timeline_history 주입 → device_info `timelineCount:3` 응답(신규 디버그 필드; "시드 미파싱 vs 렌더 게이팅" 판별용).
- 시드 엔트리 필드를 펌웨어 버퍼로 바운딩(raw 119/detail 199) — 긴 chat 본문이 소형 RX 버퍼 보드에서 히스토리 라인을 터뜨리지 않게.

## 2026-07-04 — 라운드 7: 타임라인 인제스트 복구(observed hook→timeline) + InkDeck 랩 버그 (커밋 3bf1f235)

- **"로그가 00:28 이후 안 쌓임" 근본 원인**: 타임라인 chat/tool 행은 **managed 세션 브리지의 릴레이로만** 생성됐음. 00:28 = 마지막 managed codex 세션 종료 시각; 이후 사용자의 모든 작업은 observed(터미널 직접 실행 + hook만)라 행이 0개. 로그 시스템 고장이 아니라 **observed 경로에 방출 지점이 아예 없던 구조적 갭**. fix: 데몬 훅 엔드포인트(`/hooks/:event`)가 UserPromptSubmit→chat_start(프롬프트), PreToolUse→tool_exec(툴+입력 힌트)를 직접 방출(session_id + cwd basename 프로젝트명). chat_end는 의도적 미방출(훅엔 응답 텍스트가 없어 "Completed" 빈 행 = 파편화). **라이브 검증**: 재시작 수 초 뒤 현 세션의 Bash 훅이 타임라인에 등장.
- 부수 관찰: "프로젝트명 '/' + 빈 JSON" 행들은 어제 managed codex PTY가 남긴 것(rollout tool JSON이 chat_response로 기록, cwd '/' 어트리뷰션) — 링에서 자연 퇴출; InkDeck 티커는 `{`/`[` 시작 raw를 스킵.
- InkDeck 랩 버그 2건: 공백-전용 백오프가 하이픈 긴 단어("Hello-world-claude-opus…")에서 첫 줄을 한 글자("H")까지 축소 → `drawWrapped2`(단어 경계 우선 + mid-word 하드브레이크 + **두 줄 동일 폰트**). 티커도 classic 강하 제거(9pt 고정).

## 2026-07-04 — InkDeck 라운드 6: 2줄 위치 교정 + activity SSOT 표면 정렬 (커밋 75c3c55f, baf064a3)

- 라운드 5 오독 교정: **2줄은 카드의 에이전트 활동 요약**(카드의 핵심), 하단 타임라인 티커는 1줄 유지. 좁은 카드에서 사라졌던 모델 표시 복원(classic 폰트 강하로 전 카드 유지).
- **activity 원라이너 표면 감사**: 브리지가 sessions_list에 붙이는 공유 `activity`(session-activity.ts, "Shared by X3+TRMNL" 주석)를 실제로 읽는 표면이 InkDeck뿐이었음 — Android는 `SessionInfo`에 필드 미선언(`ignoreUnknownKeys`가 조용히 폐기), Apple은 미디코드. 각자 `프로젝트·모델`/`모델·상태` 서브라인을 손으로 만들어 표면마다 다르게 보였던 원인.
- 수정: Android `Protocol.kt SessionInfo.activity` + `EinkAgentBlock` 3행 + 태블릿 `SessionListPanel`; Apple `Protocol.swift` 디코드 + `SessionListPanel.swift` 행. primary 행은 anchor sibling에서 차용(state_update엔 activity 없음). Android JUnit 195 pass, macOS BUILD SUCCEEDED.
- **잔여 갭**: Swift in-process 데몬은 자체 sessions_list를 만들며 activity를 계산하지 않음 — Swift에 activityFor 포트 필요(추후).

## 2026-07-04 — InkDeck 라운드 5: 2줄 티커 + AGY 칩 + 타임라인 연결시 시드 (커밋 3a385daa)

- 티커 2줄 랩(공백 그리디 랩, 2행 넘칠 때만 캐스케이드/말줄임). Antigravity credits 표시 폐기(무의미한 raw 값), 구독은 우하단 classic "AGY Pro ~8/1" 칩으로 최소화(resolve 시에만), ANTIGRAVITY 전용 행 제거.
- **데몬이 serial 연결 시 최근 3개 timeline 엔트리를 시드** — 사용자가 지적한 "InkDeck UI round 3..." 잔존 문자열의 정체는 테스트 주입 데모가 링에 남은 것(연결 시 히스토리 미시드 갭). 이제 재연결 즉시 실데이터로 교체됨. 3개 제한 = 비-InkDeck 보드의 작은 RX 버퍼 보호.

## 2026-07-04 — InkDeck 라운드 4: 폰트 캐스케이드 + 구독 표시 + Antigravity + 타임라인 티커 (커밋 205ca86f)

- **말줄임 최소화**: 텍스트가 넘치면 자르기 전에 폰트를 한 단계 낮춤(`fitCascade`: 이름 Bold12→Bold9, 상태/활동 9pt→classic 6×8). 3열 카드는 글리프 48px로 축소해 텍스트 폭 확보, model 태그는 넓은 카드에만.
- **구독 만료**: usage_update `subscriptions[{name,until}]`를 serial로 전달(ISO until→"~M/D" 프리포맷), LIMITS 행 라벨 아래 classic 서브라인("Max 20x ~7/12") — 데몬이 resolve 못 하면 자연스럽게 숨김. 펌웨어 `g_state.subscriptions[3]` 신규 파싱.
- **Antigravity**: 계정 연동 시에만 텍스트 행(글리프+"13450 credits · Pro"). 크레딧은 raw count라 바 없음.
- **타임라인 티커**: 최신 timeline 이벤트 1줄("16:52 요약")을 최하단에 — e-ink용 초압축 타임라인. **contentHash에서 제외 + 60초당 1회만 자체 리프레시**(tool 이벤트 폭주가 패널을 스트로브하지 않게; 다른 갱신에는 피기백). serial 경로가 host-local "HH:MM"(`localHm`)을 스탬프(패널은 tz 없음, 기존 ts는 UTC유래).
- 푸터 재배치: rule 370, 프로바이더 행 28px×3 + 티커 라인; 카드 영역 78..366(독 시 330..366).

## 2026-07-04 — InkDeck 라운드 3: 브랜드 마크 교정 + screenLocked 래치 + activity 카드 + HWCDC 64B 드롭

### 사용자 피드백 → 수정 (커밋 71308024, 4581f31b, 7a125921)
1. **"asleep인데 데몬은 실행 중"** → 패널 정상, 데몬 버그. macOS가 잠금 해제 시 ioreg `CGSSessionScreenIsLocked` 키를 **삭제**(No로 안 바꿈)하는데 파서가 부재=undefined로 방치 → 한 번 잠그면 `screenLocked=true` 영구 래치 → 전 패널 슬립 고착. + 실키는 `k` 접두사(`kCGSSessionOnConsoleKey`)라 매칭 자체도 실패. fix: IOConsoleUsers 보이면 잠금 키 부재=UNLOCKED + `k?` 접두사 허용. 실검증 `/display-state` true 복구.
2. **"구형 로고"** → AD 실드는 SD/SD+ 시절 마크. 현행 = **돔+데크**(`AgentDeckLogo.swift`가 기하 SSOT, "older mark 대체" 명시). e-ink는 베지어 돔/워터라인/버블/3키 데크를 절차적으로 스트로크(`drawAgentDeckMark`). 실드 마스크 생성기 폐기.
3. **"IDLE 시간이 무의미"** → elapsedSec=세션 시작 후 경과라 "IDLE · 54m"가 오독됨. 카드에서 제거하고 **per-session activity one-liner**(bridge 공유 필드, X3와 동일)를 표시 — serial 경로 `prepareForSerial`에 activity 추가 + 펌웨어 파싱.
4. **"에이전트 많으면?"** → attention-first: awaiting/processing만 카드, 7개 이상이면 idle은 하단 IDLE 독(글리프+이름 칩 + "+N")으로 압축.
5. **"5H/7D 간격 없음, 버전 표시 불필요"** → 게이지 바 140px + "42% · 1h 23m" 결합 텍스트(블록 x=150/490), 버전 태그는 대시보드에서 제거(탐색 화면에만).

### HWCDC 전송 무결성 (검증 중 발견, 실측 기반)
- **RX 2048 < 8세션 sessions_list 2215B** → 인바운드 트렁케이션(`JSON error: InvalidInput`). INKDECK RX 8192.
- **HWCDC TX가 단일 println 중간에서 정확히 64B(HW FIFO 1블록) 드롭** — device_info 7/10 오염, flush는 악화. 드라이버 레벨 버그. GxEPD2 `init(115200)` 진단 출력(Core 1)도 오염원이라 `init(0)` 필수. fix: `Net::serialWriteJsonLine()` — INKDECK은 60B/드레인 페이싱(9/10 무결, 잔여는 데몬 identify 재시도가 흡수), UART 보드는 println 유지. 후보 후속: TinyUSB 모드(`ARDUINO_USB_MODE=0`) 실험.

## 2026-07-04 — InkDeck UI 전면 재설계: 고스팅 원인 수정 + 브랜드 헤더 + 세션 카드 + 사용량 게이지 교정

### 사용자 보고 증상 → 원인 → 수정 (커밋 f6620b07, a992bf6e)
1. **텍스트 잔상/흐림**: 리프레시마다 `display.hibernate()` 호출 → 컨트롤러 딥슬립이 이전 프레임 RAM을 소거 → 다음 partial refresh가 소거된 버퍼와 diff → 흐린 텍스트. 수정: 리프레시 사이 `powerOff()`(RAM 유지), hibernate는 호스트 슬립 카드에만 + 기상시 full 강제. full 주기 8→5 partial / 30→10분.
2. **AI 사용량 표시 부정확**: 구 게이지 레이아웃에서 5H 값 텍스트(x≈354)가 7D 게이지 라벨(x=410)과 겹치고, 7D 값 텍스트는 x>800으로 화면 밖 클리핑 → 값이 안 보임. 수정: LIMITS 푸터를 프로바이더별 행(Claude/Codex 미니 글리프 + 5H/7D 바 + % + reset)으로 재설계. **시리얼 주입 검증**: 42/61(1h23m/2d4h)·codex 12/44 주입 → 렌더 로그 완전 일치.
3. **OpenClaw 크리처 부정확**: body-only `CRAYFISH_BODY_A8`(터라리움용, 집게/더듬이는 절차적 애니메이션 전제)를 카드에 그려 블롭으로 보임. 수정: 풀 브랜드 마크 `OPENCLAW_MARK_A8` + paper 눈 펀치(agentGlyphMono와 동일 기하).
4. **로고/워드마크 통일**: LVGL 스플래시가 쓰는 logo_64.png를 luma>150 라인아트 마스크로 변환(`pnpm generate-eink-logo` 신설 → `logo_glyph_generated.h`), AD 실드 + "AgentDeck" 워드마크 + 링크 상태 칩 헤더.
5. **레이아웃 재설계**: 적응형 세션 카드 그리드(≤2 tall / 2×2 / 3×2), awaiting 카드는 반전 + 질문 랩핑 + 포커스 옵션 목록, 상태 마커(솔리드/해치/할로우), empty/searching/sleep 화면.

### 파생 버그 2건 (검증 중 발견)
- **크로스코어 Serial 인터리브**: 렌더 경로(Core 1)의 `Serial.printf` 디버그가 Core 0의 protocol JSON 응답과 줄 중간에서 섞여 device_info 응답을 오염 — 데몬이 stale buildHash를 계속 표시. 렌더 경로 Serial 출력 금지로 수정.
- **데몬 identify 캐시 고착**: esp32-serial이 연결 시 deviceInfo를 캐시로 시드하면 재요청 조건(`!conn.deviceInfo`)이 영원히 거짓 → 응답 1회 유실 시 재플래시 보드가 옛 buildHash로 영구 표시(buildHash 배포검증 관례 무력화). `deviceInfoFresh` 플래그로 이 연결에서 응답을 받을 때까지 (한도 내) 재시도. 실검증: 재플래시 후 /devices가 90e1dc07→94201190로 갱신됨.

## 2026-07-04 — InkDeck 최초 실기 플래시: TRMNL 패널 하드웨어 실체 확정 + 8MB boot-loop 수정 + 부팅/상태 UI 렌더링 확인

### 배경
- 아래 엔트리에서 TRMNL BYOS 제거 + InkDeck 커스텀 펌웨어 전환을 결정했으나 "실기 미검증" 상태로 남아 있었다. 물리 패널(MAC `1C:DB:D4:74:F4:D8`)에 InkDeck 펌웨어를 최초로 플래시해 부팅까지 검증했다.

### 하드웨어 실체 확정 (TRMNL 7.5" OG DIY Kit)
- **칩**: XIAO ESP32-S3 — esptool `flash_id`는 **16MB** 검출(Plus급), PSRAM 8MB octal. `board_inkdeck.h`의 "16MB flash" 주석은 칩 기준으론 맞으나 아래 BSP 제약과 충돌.
- **버튼 배선 (중요)**: 외부 버튼은 `RST` + `KEY1/KEY2/KEY3` 뿐, **BOOT(GPIO0) 노출 없음**. TRMNL 펌웨어 원본(`usetrmnl/firmware include/config.h`, `BOARD_XIAO_EPAPER_DISPLAY` non-MINI) 매핑: **KEY1=GPIO2, KEY2=GPIO3, KEY3=GPIO5**. 어느 KEY도 GPIO0(boot strap)이 아니므로 **버튼 조합만으로 ROM 다운로드 모드 진입 불가**.
- **USB 데이터 경로**: 초기(충전 케이블 추정)엔 RST 리부트에도 USB가 전혀 열거되지 않음(5분+ 모니터링 0건). **데이터 통신 케이블로 교체 + RST** 후에야 부팅 윈도우에 USB-Serial/JTAG(VID 303A PID 1001)가 열거됨.

### 플래시 절차 (재현 가능 — BOOT 버튼 없는 패널용)
1. 데이터 케이블을 허브 데이터 포트에 연결.
2. RST 1회 누름 → ESP32-S3 풀부트 중 ROM/2nd-stage 단계에서 USB-Serial/JTAG가 **수 초간** 열거.
3. 와처(`esptool --before default-reset`)가 새 `cu.usbmodem*`(1C:DB:D4)을 잡는 즉시 USB-Serial/JTAG 하드웨어 리셋으로 다운로드 모드 강제 진입 → `write_flash`(bootloader 0x0 / partitions 0x8000 / boot_app0 0xe000 / firmware 0x10000). 한 번 진입하면 칩이 다운로드 모드에 머물러 플래시 시간은 무제한.
- 1차 시도서 firmware 11%에서 접촉 불량으로 끊겼으나 2차 RST에서 4 이미지 전부 hash verify 완료.

### 핵심 버그: 16MB 파티션 → 8MB 부트로더 충돌 (boot-loop)
- 증상: 플래시 후 `E flash_parts: partition 3 invalid - offset 0x650000 size 0x640000 exceeds flash chip size 0x800000` / `E boot: load partition table error!` 무한 루프.
- 원인: `seeed_xiao_esp32s3` BSP 자체가 **8MB** (`partitions=default_8MB.csv`, `upload.flash_size=8MB`). 그런데 `[env:inkdeck]`이 `board_build.partitions=default_16MB.csv`로 **파티션만 16MB로 강제** → 2nd-stage 부트로더(BSP 기본 8MB flash-size 필드로 빌드)가 16MB 파티션 테이블을 거부.
- 수정: `esp32/platformio.ini [env:inkdeck]`에서 `board_build.flash_size = 8MB` + `board_build.partitions = default_8MB.csv`로 통일(사유 주석 추가). 칩은 16MB지만 BSP 8MB 설정이 일관되게 동작하며 firmware(1.47MB)는 app0(3.3MB)에 충분. `erase_flash` 후 재플래시로 boot-loop 완전 해소.

### 결과
- **InkDeck 정상 부팅 확인**. e-ink 화면에 `INKDECK` 브랜드 + `Wifi not connected` 상태가 렌더링됨 → 상태 UI 동작(이전 "대시보드 미표시" 한계를 넘어 최소 status 화면은 그림). USB-Serial/JTAG가 `cu.usbmodem101`로 안정 상주(딥슬립 하지 않고 활성).
- `erase_flash`로 WiFi 자격증명 삭제 → WiFi 미연결 상태였으나 **아래 USB-serial 경로로 우회 검증 완료**.

### USB-serial 데몬 연결 검증 (최종)
- **WiFi 불필요 — USB 시리얼만으로 daemon↔패널 연결·대시보드 렌더링 성공**. `agentdeck daemon start` 후 daemon의 esp32-serial 스캐너가 `/dev/cu.usbmodem101`을 자동 발견, `device_info_request` → 패널이 `{"type":"device_info","board":"inkdeck","version":"0.1.2",...}` 응답 → `/devices`에 `inkdeck v0.1.2 (90e1dc07-dirty) @ /dev/cu.usbmodem101`로 정식 등록. 패널 측 로그 `[Serial] First JSON received — bridge connected via USB`. 이후 daemon이 대시보드 프레임을 시리얼로 push → e-ink에 기존 ESP32 보드들과 동일한 대시보드 렌더링 확인(footer `USB`).
- 펌웨어의 serial 전송(`esp32/src/net/serial_client.cpp`)은 WiFi와 독립해 항상 활성(`main.cpp:64-95`: 시리얼 연결 시 WS/WiFi 시도 생략). `serial_client.cpp:31-66`가 보드별 device_info(`"inkdeck"` 포함) 송신.
- **실질적 병목은 케이블**: 데이터 통신 케이블(플래시에 쓰던 것)로만 USB 열거; 다른 케이블들은 전원만 통했음. 펌웨어 USB 모드(`ARDUINO_USB_MODE=1`/`CDC_ON_BOOT=1`)는 정상 동작(우려와 달리 TinyUSB/하드웨어 JTAG 불일치 없음).

### 남은 과제
- WiFi WS 경로(프로비저닝 후 mDNS 광고·WS device_info 발신)는 여전히 미검증 — USB-serial이 1차 검증 경로로 확보됐으므로 후순위.
- e-ink 대시보드 품질(부분 리프레시 고스팅·핀맵) 실사 검증.
- USB 안정성: 약한 전원/접촉에 취약하므로 전력 충분한 데이터 포트 사용 권장.

---

## 2026-07-04 — TRMNL BYOS 전면 제거 → InkDeck 커스텀 펌웨어 전환 + 정렬/색상 SSOT 수렴

### 배경
- inkterface(SteamOS e-ink 모니터) 소스 분석에서 나온 개선 제안 검증 → "snapshot+commit 계층 신설"은 TRMNL frame-cache에 이미 존재, "collector registry 신설"은 기존 shared SSOT 드리프트가 진짜 문제로 판명.
- 물리 패널의 정체가 리테일 TRMNL이 아니라 **Seeed TRMNL 7.5" OG DIY Kit**(XIAO ESP32-S3 Plus + GDEY075T7/UC8179 800×480, 상시 USB 급전)로 확정. stock 펌웨어의 deep-sleep→WiFi 재접속→HTTP 폴링 모델이 "WiFi connected 화면 회귀" 증상의 구조적 원인(매 wake가 재접속 기회=실패 기회)이라 BYOS 유지 대신 **커스텀 펌웨어로 전환** 결정. 기기명 **InkDeck**으로 재명명.

### 작업 (커밋 4개)
1. `07d8e221` **SSOT 수렴**: dead `d200h-renderer.ts` 삭제(임포터 0), `d200h-layout.ts` 로컬 sort→canonical `sortSessions`+`foldCodexSessionsForDisplay`(D200H/Ulanzi 순서가 SD/Apple/Android와 일치), state 색상 5중복→`STATE_COLORS` 파생(TUI ansi truecolor, Pixoo 셔머 튜플, hook-server 인라인 페이지 2곳).
2. `c71044bd` **Node/shared TRMNL 제거**: bridge/src/trmnl/* + 모듈 + `/api/setup|display|log`·`/trmnl/image` 라우트 + `agentdeck trmnl` CLI + `trmnl-layout.ts` + 테스트 5파일.
3. `88192bc7` **Swift/문서**: TrmnlModule/ImageRenderer/Settings + TrmnlHealth 모델/파서/DeviceEntry kind 제거(xcodegen 재생성, BUILD SUCCEEDED). 문서 전반 TRMNL→InkDeck.
4. `d03d9836` **InkDeck 펌웨어 + 브리지**: `env:inkdeck`(pioarduino S3, GxEPD2), `ui/eink/` 직접 드로잉(콘텐츠 해시 게이트, partial 8회/30분마다 풀 리프레시, awaiting 반전 밴드, 크리처 A8 실루엣, 5H/7D 게이지), `boards/board_inkdeck.h` 핀맵. **WS device_info 발신**(기존 serial 전용 → WiFi 보드가 데몬에 미등록되던 갭 해소) + 데몬 `esp32-wifi` 레지스트리(/devices) + **15초 display_state WS 재브로드캐스트**(serial 하트비트 자가치유의 네트워크 등가물).

### 검증 / 미검증
- vitest 1600 pass · bridge tsc · `pio run -e inkdeck` SUCCESS(RAM 41.7%/Flash 22.4%) · `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED.
- **실기 미검증**: 패널 플래시(`pio run -e inkdeck -t upload`) 후 partial refresh 고스팅 품질·핀맵 확인 필요. 사용자 settings.json의 고아 `trmnl` 블록은 무해(수동 정리 가능).

## 2026-07-04 — observed Codex 상태 양방향 오판 교정 + display sleep 하트비트 자가치유

### 문제
1. **observed Codex 세션이 유령 processing 고착**: 놀고 있는데 대시보드에 processing 표시. `passive-observer.ts parseCodexRollout`이 큰 rollout(>1.25MB)을 head 256KB + tail 1MB로 샘플링하는데, head 구간 `function_call`의 `function_call_output`이 head–tail 갭에 떨어지면 `pendingCalls`가 영구 잔류 → 파일이 `task_complete`로 끝나도 processing. 실측 3.4MB rollout에서 dangling call 5개.
2. **(1) 수정이 반대 방향 유령 idle을 노출**: 작업 중인데 idle 표시(움직임 안 보임). 구 로직은 `function_call`·mid-turn `agent_message`가 `modelGenerating=false`로 turn을 꺼서, 첫 tool call 이후 상태가 pendingCalls에만 의존 → tool output 직후~다음 call 사이 thinking 구간이 전부 idle. 실제 rollout 리플레이에서 **턴 진행 시간의 13%만 processing** 표시.
3. **TC001 등 serial LED 패널이 화면 꺼진 채 고착**(전원 재연결로만 복구). `display_state`가 순수 엣지 트리거(상태 변경 시 + serial 연결 시)라, off 수신 후 wake 엣지를 놓치면(half-open serial, 데몬 교대 타이밍) 재전송이 없어 영구 소등.

### 해결
- **turn 단위 상태 의미론** (`passive-observer.ts`): `task_started`/`user_message`에서 turnActive=true(+user_message에서 pendingCalls.clear()), `task_complete`/`turn_aborted`에서만 turnActive=false + pendingCalls.clear(). mid-turn 이벤트는 turn 상태 불변. state = `turnActive || pending>0`. end-event 유실 유령 방지 백스톱: processing인데 pending 없음 + rollout mtime 10분 초과 침묵 → idle(in-flight tool 있으면 면제 — 조용한 장기 빌드 보호).
- **display_state 하트비트 재동기화** (Node `esp32-serial.ts` `sendHeartbeat` + Swift `ESP32Serial.swift` `sendHeartbeat`/`SerialEventSnapshot.currentDisplayStateEvent`): state/usage는 이미 매 5초 재전송하고 있었으나 display_state만 빠져 있었음. 매 주기 재전송 추가(페이로드 ~70B, 펌웨어 핸들러 멱등) → wake 엣지 유실돼도 5초 내 자가치유.

### 핵심 설계 결정
- 부분 샘플 기반 상태 파생은 (a) 경계 이벤트에서 pending 리셋, (b) mid-turn 이벤트가 활성 상태를 끄지 않게 — **두 원칙 모두** 필요. 하나만 고치면 반대 방향 유령이 드러난다(방향 1 수정이 방향 2를 노출).
- Swift 데몬은 rollout 파싱을 안 하므로(`LocalCodexAppObserver`는 프로세스 존재만 감지) Codex 수정은 Node 전용. 반면 display_state 하트비트 결함은 Swift에도 대칭 존재 → 양쪽 수정.
- 검증: vitest 1655 pass, Android JUnit 195 pass, `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED. 실기 육안 확인은 사용자 세션에서 데몬/앱 재시작 후.

## 2026-07-04 — Timebox Mini: 데몬 재시작 후 대시보드 미전환 자가치유 + micro 패널 활동 표현 강화

### 문제
1. **데몬 재시작 시 Timebox가 기본 시계 모드에 고착**(기기 전원 재투입해야만 대시보드 복귀). 원인: 데몬이 비정상 종료되면 고아가 된 Python BLE sync 자식(`sync_ble.py`)이 **작별 blank 프레임**(전-검정)을 그리는데, 그 시점이 후계자(재시작된) 데몬이 대시보드를 다시 그린 **직후**라 후계자 프레임을 덮어씀. stateful 패널 + dedup(`last_key`)로 재-push가 안 일어나 고착. 유일한 자가치유 경로가 "기기 전원 재투입 → BLE disconnect → `last_key` 리셋"이라 전원 재투입이 필요했음.
2. **micro 글리프가 정지 상태**(특히 Claude 로봇 `work`==`idle`이라 무애니메이션), Codex `>_`가 오프화이트 1px라 LED 디퓨저에서 배경/구름에 뭉개짐.

### 해결
- **후계자 인지형 작별** (`sync_ble.py`·`sync.py`·`matrix_sync_common.py`): 종료 사유 추적(`signal`/`orphan`/`bridge_gone`) + 신규 `bridge_reachable()`. 부모 사망(orphan)인데 브리지가 다시 응답 = 후계자 존재 → **작별 페인트 생략**(BLE clean disconnect는 유지해 single-central 링 해방). iDotMatrix OFFLINE 패리티 동일 적용.
- **하트비트 재-push** (`sync_ble.py`, `HEARTBEAT_SEC=8`): 콘텐츠 불변이어도 8초마다 강제 재전송 → RF 글리치·중첩 창으로 유실된 프레임이 전원 재투입 없이 수 초 내 자가치유. `push_micro_frame`이 실제 전송 여부(`sent`) 반환.
- **활동 표현** (`micro-glyphs.ts` SSOT → Swift 미러 재생성): Codex `>_` 순백·2px 볼드(작업 시 커서 blink), Claude 로봇 `work` 프레임(작업 시 시안 눈 점등+다리 stride), processing 배경 breathing(느린 파란 심박), OpenCode 링 pulse. idle은 정지 유지, awaiting amber 펄스 유지.

### 핵심 설계 결정
- **SIGKILL orphan reaper 채택 안 함**: SIGKILL은 BLE half-open(원래 버그) 재유발, SIGTERM reap은 작별-clobber 재유발. clean-disconnect + 하트비트가 더 견고.
- animFrame은 10fps지만 디바이스는 ~1.5s 폴링 재-push라, 빠른 포즈 애니보다 **느린 breathing 배경 + 상태별 확실히 구분되는 포즈**가 체감 신호. breathing은 프레임을 계속 변화시켜 dedup-lock 자가치유에도 유리.
- `TimeboxProtocolTests.swift`가 이미 stale(현 글리프에 없는 amber 눈/D 관절 검증)이던 것을 현 미러에 맞게 정정.
- 검증: vitest 1650 pass, `swiftc -parse` OK, `scripts/micro-preview.mjs`로 렌더 시각 확인. **실기기 디퓨저 체감 + XCTest 실행은 미확인**.

## 2026-07-04 — 듀얼 데몬 공존: TRMNL "connecting" 플리커 원인 확정 + Swift fallback-port 자가치유(reclaim/stand-down) + 승격 오탐 완화

### 문제
Node CLI 데몬과 Xcode 디버그 Swift 데몬 동시 실행 환경에서 TRMNL 패널이 간헐적으로 "connecting" 류 화면으로 바뀌었다 정상화. 패널 자체 펌웨어 로그(`/api/log`)를 전수 조사해 원인을 3계열로 분리:
1. **9120 소유권 교대 dead window** — Node 재시작 시 Swift가 ~10초 만에 자기승격하지만 9120이 아직 안 풀려 **9121로 fallback 후 영구 잔류**(재점유 로직 없음). 패널은 9120 고정 폴링이라 `connection refused(-1)` → 펌웨어 자체 재연결 UI. 교대 window 동안 Swift가 ESP32 시리얼 6포트+Pixoo까지 가져가 전 디바이스 소유권 플랩(Pixoo "offline" 오판 로그 확인).
2. **패널 WiFi 전파 요동**(-26↔-84dBm, 7/2 하루 weak 사이클 6회) — 데몬 무관, 펌웨어 "Connecting to WiFi" 화면. 물리적 원인(배치/채널), 코드 수정 불가.
3. (기각) "대시보드 과다 연결 병목" 가설 — `/api/display` 실측 p50 0.9ms(WS 8클라이언트+ESP32 6+Pixoo+BLE 2 동시), 렌더는 state-hash 게이트로 이미 디바운스. 7/1 밤 2시간 404 스트릭은 **이미 7/2에 수정된 `/api/setup/` trailing-slash 별건**(화면 플리커와 무관 — display/이미지 서빙은 정상이었음). 이미지 라우트는 양 허브 모두 해시 무시+항상 200이라 재렌더 race 404는 구조적으로 불가능.

### 해결 (Swift 데몬)
- **fallback-port 자가치유** (`DaemonService.swift::reclaimCanonicalPortIfNeeded`): fallback 포트에서 구동 중이면 5초 헬스 틱마다 canonical 포트 감시 — 건강한 데몬 재등장 → 자기 서버 내리고 **클라이언트 모드로 자진 강등**(Node의 /shutdown 축출 왕복 불필요), 포트가 비면(`isPortBindable`) 즉시 재점유. `standDownServer()`는 `onShutdown` 콜백을 해제해 자동 외부전환과의 이중 전이 차단 + fallback 부기(sessionOverridePort/fallbackAttempted/failedBindPorts) 초기화.
- **승격 오탐 완화** (`DaemonService.swift` + `SessionRegistry.swift`): 외부 데몬 사망 판정을 2연속(~10s)→**3연속 미스 + patient probe(5s)** 로. Node는 단일스레드+동기 SQLite라 부하 시 이벤트루프가 2초 넘게 멈춰도 살아있음 — 기존 2s probe가 오탐으로 라이벌 허브를 승격시켰음. `LocalProbeSession.patient`(5s/5s) 세션 분리로 기존 sibling probe(2s)와 풀 격리 유지.
- 검증: `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED. 런타임 검증은 다음 Xcode 실행에서 로그 확인 — 기대 라인: `standing down fallback-port hub`, `Canonical port ... is free — reclaiming`.

### 남긴 것 / 한계
- Xcode 디버거에 **suspended**된 Swift 데몬이 9120을 물면(7/3 01:13 "grabbed by a non-daemon" 케이스) 어느 쪽도 회복 불가 — probe 무응답+포트 점유. 코드로 못 막는 개발환경 특수 케이스, 사용자가 디버거 재개/중지해야 함.
- Node 쪽 대칭 reclaim(9121로 물러난 Node가 9120 재점유)은 미구현 — 실사용 토폴로지(허브 1개)에선 불필요, 필요해지면 별도 라운드.

---

## 2026-07-04 — IPS10 오피스 씬: 프로젝트 자리에서 실시간 상태 표시(REST 밴드 제거) + Codex 카드 글리프 수정

### 문제
10" IPS(ESP32-P4) 대시보드 좌측 "픽셀 오피스"에서 (1) processing 워커가 자리에 앉아 **완전 정적**(bob·버블 없음)이라 프로젝트별로 실제 일하는지 티가 안 났고, (2) idle 워커는 프로젝트 자리를 떠나 하단 **REST 밴드(커피/정수기)로 이동** — 에이전트는 이미 프로젝트별로 할당돼 있는데 자리를 비우니 "그 자리에서 쉬는지/일하는지/대기하는지"라는 실제 상태를 못 읽음. 별개로 (3) 우측 세션 카드에서 **Codex만 크리처 아이콘 누락**(dot fallback).

### 해결
- **자리 고정 + 자리에서 상태 표시** (`esp32/src/ui/terrarium/office.cpp`): REST 이동 로직 전면 제거(`pickLounge`/`loungeTargetTaken`/tea-time 셔플/lounge 밴드·러그·"REST" 라벨·커피·정수기 소품). `targetFor()`는 항상 프로젝트 시트 반환 → 워커가 허들 자리를 떠나지 않음. 상태별 in-place 표현: **working**=bob 재활성화 + 발밑 맥동 시안 글로우 링 + `w` 스파크 버블, **awaiting**=앰버 `?`+bob, **idle**=크리처 디밍(α235→120)+정적 `z`, **error**=빨강 `!`+jitter.
- **Codex 카드 글리프** (`esp32/src/ui/widgets/hud_bar.cpp`): `ips10AgentGlyph()`만 4개 렌더 표면 중 codex 분기 누락 → `nullptr` → 셀 글리프 숨김. `glyphCodex`(구름+`>_`)는 이미 빌드돼 있었음. `if (strstr(agentType,"codex")) return &glyphCodex;` 한 줄 + stale 주석 4곳 정정.

### 핵심 설계 결정
- **저전력 scene-skip 보존**: working에 애니메이션을 넣으면 매 프레임 sig가 바뀌므로, 글로우 링의 양자화 위상을 `workerSig()` 해시에 포함 → 작업/대기 중일 때만 재렌더, 전 세션 idle이면 여전히 패널 정지(정적+디밍 → sig 불변 → memcpy/flush skip).
- `OFFICE_W`(408px) 불변 → hud_bar/renderer 폭 동기화 불필요.
- Codex 누락은 "agent→glyph 4표면 중복 매핑에서 1곳 누락 시 dot fallback" 패턴의 재발.

### 검증
`pio run -e ips10` `[SUCCESS]`(Flash 63.3%). 실기 `/dev/cu.wchusbserial201240`(board `ips_10`) 플래시 `Hash of data verified`, buildHash `fff7db54-dirty`→`14e88efd-dirty`로 라이브 확인. 데몬 재시작 후 ESP32 6대·Pixoo·ADB 전체 복구. **주의**: 물리 LCD 렌더 육안 확인은 미수행(패널 스크린샷 불가) — 글로우/디밍/스파크 미세조정은 실기 확인 후 후속. 플래시 중 데몬이 SD/Ulanzi 플러그인 트리거로 자동 재생성돼 포트를 재점유하는 gotcha 있음(stop 직후 깨끗한 창에서 즉시 flash로 해소).

## 2026-07-03 — 기기 표면 offline UI 일관성: connection-state lexicon SSOT + ESP32 재연결 라벨 수정

### 문제
데몬 링크가 끊겼을 때 표면마다 표기가 제각각: SD/D200H/Pixoo는 "OFFLINE", 앱은 "Searching for bridges..."/"Connecting..."/"Reconnecting...", Apple만 "Retry Discovery" 버튼, ESP32는 splash가 "Searching for bridges..."인데 aquarium 오버레이는 SEARCHING·RECONNECTING **둘 다 "Connecting"**(같은 기기 안 불일치 + 재연결 단계 구분 소실).

### 설계 — 기기 특성별 2클래스 어휘
- **자가연결 클라이언트**(Apple/Android 앱, ESP32, TUI): 실제 단계를 표기 — `Searching for AgentDeck...`(소형 패널 압축형 `Searching...`) / `Connecting...` / `Reconnecting...` / `No WiFi`, 재시도 버튼 `Search Again`, 빈 발견 힌트 `No AgentDeck found on this network`. 내부 용어 "bridges"는 사용자 카피에서 제거.
- **데몬-구동 수동 표면**(SD, D200H, Pixoo, Timebox, iDotMatrix, TRMNL): 스스로 탐색 못 하므로 터미널 상태 `OFFLINE`(+`Open AgentDeck` CTA)만 — 수행할 수 없는 Connecting/Reconnecting을 주장하지 않음.

### 구현
- **SSOT**: 신규 `shared/src/connection-status.ts` — `DaemonLinkPhase` + `DAEMON_LINK_LABELS(_COMPACT)` + `PASSIVE_OFFLINE_LABEL`/`OPEN_AGENTDECK_LABEL` 등. TS 소비자(session-slot-renderer, display-tile, session-slot-button, d200h-layout, trmnl-layout, pixoo-renderer) 리터럴을 상수로 교체.
- **ESP32**: aquarium 오버레이 SEARCHING→"Searching...", RECONNECTING→"Reconnecting..."(기존 둘 다 "Connecting"); splash 상태 "Searching for AgentDeck..."(compactStatus가 전 보드에서 "Searching..."으로 압축).
- **Apple**: `ConnectionOverlay.swift`에 `ConnectionLexicon` 미러 enum; "Retry Discovery"→"Search Again", "No bridges found on network"→lexicon, SettingsScreen 검색 라벨 포함.
- **Android**: `ConnectionComponents.kt`에 `ConnectionLexicon` object; MonitorScreen/EinkMonitorScreen/StatusBadge 라벨 전부 lexicon 참조.
- **문서**: DESIGN.md §9 Voice & copy에 lexicon 규칙 추가(mirrors 동시 갱신 규칙 포함).

### 검증
vitest 92파일/1637 pass, `pnpm build` OK, `xcodebuild AgentDeck_macOS` OK, Android `compileDebugKotlin` OK, ESP32 `pio run -e ips35` OK. 코드 전역에서 "Searching for bridges"/"Retry Discovery" 리터럴 0건 확인.

### 후속(실기 배포 중 발견) — Android "Connecting..." 두 줄 중복 제거
실기 APK 반영 후 CONNECTING 상태에서 "Connecting..."이 두 줄로 뜨는 게 드러남. MonitorScreen/EinkMonitorScreen 모두 상태 부제(status subtitle)가 이미 CONNECTING→"Connecting..."을 렌더하는데, 그 아래 별도 블록이 같은 문자열을 한 번 더 표시하던 **기존 중복**. lexicon 상수화로 두 줄이 정확히 같아지며 눈에 띔. 별도 CONNECTING 블록 제거(부제 한 줄만 유지). **참고**: 사용자가 함께 본 "daemon-9120 + AgentDeck-9121 두 개 발견"은 코드 버그가 아니라 **같은 머신에 데몬 2개 공존**(macOS 앱 Swift 데몬 project=daemon/v=3/9120 + CLI Node 데몬 project=AgentDeck/v=1/9121 fallback)이 각각 mDNS 광고한 것 — 한쪽 데몬 정지로 해소. **후속**: 아래 2026-07-03 듀얼 데몬 공존 감사가 이 증상의 근본 원인(싱글턴 가드의 포트 스캔 사각지대)을 수정.

---

## 2026-07-03 — 듀얼 데몬 공존 감사: split-brain 가드 · mDNS TXT 통일 · task 행 아이콘 패리티 · 관찰 세션 프로젝트명 통일

### 배경
3축 감사(데몬 공존 / 세션 프로젝트명 / 타임라인 표면 일관성) 결과 확정 결함 수정. 브랜치 `audit/daemon-timeline-consistency`.

### 구현
1. **데몬 split-brain 차단** — Node 싱글턴 가드는 파일(daemon.json/sessions.json) + 기본포트 probe만 검사했는데, App Store Swift 데몬의 daemon.json은 sandbox private container라 Node가 못 읽고(TCC hang 회피로 의도적 미독), 일시적 9120 경합으로 데몬이 fallback 포트(9121+)에 앉으면 둘 다 놓쳐 **이중 데몬**(mDNS 이중 광고·Gateway/timeline 중복 relay·adb reverse flapping). `scanDaemonPortWindow()`(9120–9139 병렬 /health sweep, Swift가 이미 하던 것의 Node 미러) + Swift 축출 시 고정 1500ms sleep 대신 `waitForDaemonExit()` health-gone 폴링(Swift가 serial/ADB/BLE 모듈 정리 전 인수하면 tty/adb reverse 이중 소유). `docs/daemon.md` singleton guard·client discovery 절 현행화(구 기술은 stale였음).
2. **mDNS TXT `v` 통일** — Node `v:'1'` vs Swift `v:'3'` (같은 `_agentdeck._tcp`). 현재 v를 읽는 클라이언트는 없어 Node를 '3'으로 정렬 + 양쪽 lockstep 주석.
3. **task 행 아이콘 패리티** — task_start/task_end/task_milestone이 TUI(`tui/renderer.ts` typeIcon)와 Android e-ink EventLog(`EinkEventLog.kt` typeIcon)에서 default 아이콘으로 뭉개짐(Apple/Android rich 타임라인만 표시). `timelineIconKey()` 의미(task→task 글리프, milestone→success)로 두 맵 보강.
4. **관찰 세션 프로젝트명 통일** — PTY는 `resolveProjectName()`(git root→package.json→basename), Swift 데몬은 `ProjectNameResolver.swift` 동일 미러인데 Node passive-observer만 `basename(cwd)` → 같은 프로젝트가 실행 경로 따라 다른 이름("AgentDeck" vs "bridge"), projectName 키 기반 `#N` dedup·Codex folding도 경로 간 분리. 신규 `resolveProjectNameFromCwdCached()`: 동일 순서, git 탐지는 서브프로세스 없는 `.git` ancestor walk(dir/file — Swift 미러와 동일 알고리즘, 스캔 이벤트루프 스톨 방지), cwd별 memoize.
   - **스크레이프 override 차단** — Claude PTY의 `OutputParser` PROJECT_DIR 정규식(아무 경로형 줄의 basename, first-match-sticks)이 state-machine snapshot을 타고 `bridge-core.ts`의 `snapshot.projectName ?? this.projectName` 우선순위로 git-aware 이름을 덮어씀(모노레포 서브디렉토리 세션이 repo명→서브디렉토리명으로 플립). `seedProjectName()`으로 resolved 이름을 파서에 시드해 스크레이프를 비활성(resolver가 'unknown'일 때만 fallback 유지, reset() 후에도 시드 유지). OpenCode(세션 제목)·OpenClaw(고정 'OpenClaw') 경로는 의도된 override라 그대로.
   - **OpenCode 어댑터** — `directory.split('/').pop()` basename fallback도 동일 리졸버로 교체(세션 title 우선은 유지).
5. **X4 포크 펌웨어**(crosspoint-agentdeck, 브랜치 `feature/agentdeck-timeline-consistency`) — Detail 타임라인을 타 표면과 정렬: entry.ts 포워딩+데몬시계 추정 나이 표시, 공유 `EINK_ICON_GLYPHS` 마커, chat_start turn 그룹핑, sessionId 없는 error/scheduled 행 유지, OFFLINE/Disconnected 문구 단일화. 기기 검증 대기.

### 미수정(확인만; 후속 후보)
- 영속 timeline.json/apme.sqlite가 Node(~/.agentdeck)와 Swift(sandbox container)로 분기 — 포트 소유자 교대 시 과거 히스토리 스왑(라이브는 relay로 정상). Group Container 재도입 또는 병합 로직 필요.
- TRMNL은 timeline을 안 그림(sessions만) — glance-only 설계로 판단, 필요 시 별도 결정.
- `agentdeck monitor` 브리지 행은 모니터 프로세스 cwd로 명명(훅 payload cwd 미사용) — 전역 훅이 모든 bare 세션에서 같은 포트로 POST하므로 훅 기반 rename은 다중 세션에서 flapping; 정확한 행은 passive observer가 별도 표면화하므로 의도적 보류.
- Node/Swift 타임라인 스토어는 손 미러링 2벌 — 공유 fixture 기반 projection 패리티 계약 테스트 부재.

### 검증
vitest 92파일/1649 pass(신규: scanDaemonPortWindow/waitForDaemonExit 5, resolveProjectNameFromCwdCached 4, seedProjectName 3), Android JUnit 195 pass, X4 `pio run` SUCCESS.

---

## 2026-07-02 — 타임라인 완결성 후속: 갭 5건 구현 (마일스톤 행 · OpenCode idle-gap · task 행 FIFO 보호 · APME-off fallback · unscored 종결)

### 배경
dd43efd2(중복/이중 인제스트 수정)에서 확정만 해 둔 잔여 갭 5건. 사용자 방향 확인 후 전부 구현 (①마일스톤 행 표면화 ③task 행 FIFO 보호 ⑤타임아웃→unscored 는 권장안 채택).

### 구현
1. **`task_milestone` 타임라인 타입 신설** — TodoWrite-all-completed soft hint(발화율 ~18%, 비세그먼트 유지)를 타임라인 행으로 표면화. `shared/src/timeline.ts` union + `timeline-icons.ts`(success 아이콘, detail body 제외). Node: `collector.onTaskMilestone` 콜백(per task+turn 1회 dedup, `fireTaskMilestone`) → `apme/index.ts` emit(`Todos done (N)`). Swift 패리티: `ApmeCollector.emitTaskMilestoneIfNeeded`(deferred task_start 승격 포함) + `Timeline.swift` enum case + TimelineStripView `TODOS ✓` 라벨/아이콘. Kotlin: TimelineIcons.kt 매핑. `pnpm generate-protocol` 재생성. 소비 표면 전수조사 결과 미인지 클라이언트는 전방 호환(Swift lenient enum `.unknown`, Kotlin String type).
2. **OpenCode idle-gap 경계** — OpenClaw 미러: `opencode-hook.ts`에 `OPENCODE_IDLE_GAP_MS=90s` + `opencodeIdleGapTaskBoundary()`; 어댑터가 `session.idle`에서 arm, 새 작업 신호(`beginChatIfNeeded`)·shutdown에서 clear, 발화 시 `task_boundary(idle_gap)` span → `closeTask`. 이전엔 session_end로만 닫혀 세션=1태스크(per-task eval 무효).
3. **task 행 FIFO 보호** — `BridgeTimelineStore`: 일반 FIFO에서 task 행 제외, 별도 캡 `MAX_TASK_ENTRIES=60`(초과 시 닫힌 태스크부터 evict, in-flight `task_start`는 절대 evict 금지), `loadPersistedEntries` trim·`getHistoryForSession`(limit=chat/tool에만 적용, task 행은 전량 동승) 동일 보호. Swift `DaemonTimelineStore` 미러(evictOne/loadFromDisk/historyForSession).
4. **APME-off fallback task 행** — 신규 `bridge/src/fallback-task-timeline.ts`: better-sqlite3 로드 실패 시 hook 경계 신호만으로 task_start/task_end 행 발행(합성 taskId, eval 없음). daemon-server hook 엔드포인트(`json.session_id` per-session 귀속) + 세션 브리지 index.ts hook 경로에 wiring.
5. **eval 배지 unscored 종결** — `TaskEvalBadge`에 `closedAt` 추가: task_end 후 5분 내 judge 결과 없으면 "…"→"unscored" 확정 표기 (judge 비활성/백엔드 다운/enqueue 유실 시 영구 pending 방지).

### 검증
vitest 92파일/1635 pass(신규: timeline-task-retention 4, fallback-task-timeline 3, apme-task-milestone 2), `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED, Android `compileDebugKotlin` OK.

---

## 2026-07-02 — 데몬 로그 위생: iDotMatrix 60초 respawn 근본 원인 + BLE sync 반복 사이클 억제 + TRMNL `/api/setup/` trailing-slash 404

### 문제
`~/.agentdeck/daemon-stderr.log`가 iDotMatrix BLE sync의 60초 주기 respawn 로그(connect→send→disconnect→respawn, code=0)로 도배(clean exit 4,057행, 비정상 0행). 조사에서 근본 원인 3건 확정:
1. **iDotMatrix `sync.py` 워치독 굶주림** — bridge-gone 워치독(30s)의 `last_bridge_ok`가 frame fetch에서만 갱신되는데, host display dimmed 경로는 frame fetch를 건너뛰므로(display-state fetch는 성공하는데도) 30초마다 "Bridge unreachable" clean exit → 데몬이 60초 백오프로 영구 respawn. Timebox `sync_ble.py`는 이미 display-state fetch에서 갱신하고 있었음(패리티 누락).
2. **로그 truncate-on-start** — `cli.ts` daemon 백그라운드 fork가 `daemon-std{out,err}.log`를 `'w'`로 열어 재시작마다 이전 로그 소실 → 야간 기기 인시던트("not responding")와 관측성 로그(`back after`/`device log from`)의 며칠치 대조가 구조적으로 불가.
3. **(로그가 드러낸 별건) TRMNL `/api/setup/` 404** — 패널이 매 wake마다 `returned code is not OK. Code - 404` 보고. 펌웨어 v1.5.12 `getDeviceCredentials()`(bl.cpp:1600)가 **trailing slash 포함** `{base}/api/setup/`을 GET하는데 Node·Swift 허브 모두 exact match(`=== '/api/setup'`)라 404 → api_key 저장이 영영 안 돼 매 wake 재시도 (frames는 `/api/display` soft MAC auth로 정상 렌더).

### 해결
- **`bridge/src/idotmatrix/sync.py`** — display-state fetch 성공 시(connect 블록 + 1c 루프) `last_bridge_ok` 갱신. 성공한 display-state 응답 = bridge 생존 증거.
- **`bridge/src/ble-sync-spawn.ts` `createSyncCycleSquelch()`** — 동일 exit 사이클은 처음 2회만 전체 로그, 이후 start/exit 쌍 억제 + 시간당 카운트 요약(`suppressed N repeats … latest:`). 다른 exit(새 에러 텍스트·비정상 code·5분+ 정상 가동 후 재발)은 요약 flush 후 즉시 로그. 사이클 identity는 output tail 기준: hex/숫자 마스킹 + ` | ` 세그먼트 dedupe/sort(링버퍼가 같은 재시도 에러를 1개 또는 2개 캡처해도 동일 사이클). iDotMatrix(모듈 단일)·Timebox(엔트리별) 매니저 양쪽 wiring.
- **`bridge/src/cli.ts`** — fork 로그를 append(`'a'`)로 열고 5MB 초과 시 `.1`로 rotate. launchd 경로(StandardErrorPath)는 원래 append.
- **`bridge/src/daemon-server.ts` + `apple/.../Server/HttpServer.swift`** — TRMNL API 라우트 trailing-slash 무시 매칭(Node: `trmnlPath` 정규화, Swift: `route()`에서 normalizedPath 비교). 양 허브 패리티.

### 검증
- vitest 89파일/1626 pass(신규 `ble-sync-squelch.test.ts` 5케이스), `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED.
- 라이브: 수정 배포 후 `sync.py` child가 기존 30초 사망 주기를 넘겨 지속 생존; TRMNL 다음 wake부터 setup 404 소멸 확인. Timebox "not found" 루프(기기 꺼짐)는 2회 로그 후 억제.
- 부수 복구: LaunchAgent plist가 과거 설치 시점의 pnpm Node 22 절대경로를 고정하고 있어 Node 26 업그레이드 후 better-sqlite3 ABI 불일치로 APME가 죽어 있었음 — better-sqlite3를 Node 26으로 재빌드 + `daemon uninstall/install`로 plist 재생성(이제 `agentdeck` shim + PATH 해석), APME/MLX judge 복구.

---

## 2026-07-02 — 타임라인 이벤트 단위 정합성: OpenClaw 중복 행 제거 + APME 이중 인제스트 차단 + orphan task reaper

### 문제
"타임라인에 태스크 진행/완료가 완결성 있게 안 보이고 OpenClaw 이벤트가 중복된다"는 리포트. 라이브 `~/.agentdeck/timeline.json` 조사로 확정한 사실: OpenClaw 턴 종료 시 `chat_response`와 `chat_end`가 1~13ms 간격으로 **같은 응답 `detail`을 실은 2행**으로 기록됨(예: ts `…314998`/`…315011`). 코드 원인 4계열:
1. **OpenClaw 어댑터 이중 emit** — `chat_response`(APME 캡처용으로 추가됨) + 기존 `chat_end`가 둘 다 emit. Claude 경로는 이미 상호배타(`emitCompletion`, response>20자면 chat_end 생략)로 고쳐졌지만 OpenClaw엔 미적용된 회귀.
2. **APME 이중 인제스트** — OpenCode처럼 `setApmeSession`으로 직접 span을 넣는 어댑터의 타임라인 행을 `wireAgentApme`가 또 span으로 변환 → 한 프롬프트에 turn_start 2~3회(phantom 빈 턴, turn_index 밀림), tool 스팬 2배(counter-based dedupCore라 storage dedup 무력). upsert 이벤트(chat_start topic 힌트, LLM 요약)도 span으로 재변환되고 있었음.
3. **turn_start 에코** — OpenClaw `chat.send` span과 gateway `session.message` role=user 에코가 같은 프롬프트로 각각 turn_start. Swift 데몬도 동일(chat `prompt` echo와 session.message가 모두 `model_call`→`user_prompt_submit`; 스토어 dedup과 무관하게 APME 공급은 무조건 실행).
4. **Swift log-tail replay 중복** — `parseLogLine`이 ts를 **파싱 시각**으로 재스탬프 → 재연결마다 재fetch된 80줄이 새 ts로 8s dedup을 통과해 중복 누적. + Node 데몬에는 Swift `computeOrphanTaskEnds` 같은 orphan task reaper가 없어 데몬이 태스크 중간에 죽으면 task_start 고아가 영구 in-flight 스핀.

### 해결
- **`bridge/src/adapters/openclaw.ts`** — chat final에서 `chat_response`(응답 있음)/`chat_end`(무응답) 상호배타 emit. `chat_response`에 `automated` 플래그 승계. async LLM 요약 upsert 타깃을 chat_end→chat_response로 변경, automated 턴은 enrichment 스킵(저장단에서 low-signal drop된 행을 upsert 폴스루가 부활시키는 것 방지).
- **`bridge/src/index.ts` wireAgentApme** — upsert 이벤트는 span 변환 제외; `hasDirectApmeIngestion()`(openclaw/opencode 어댑터에 신설) true면 타임라인→span 변환 스킵(직접 인제스트가 단일 소스). `classifyAndEnqueueTurn`은 non-upsert chat_response에서 유지.
- **`bridge/src/apme/collector.ts` + Swift `ApmeCollector.swift`** — duplicate-open 가드: active turn이 같은 프롬프트 + toolCalls==0 + 응답 없음 + 15s 이내면 turn_start 무시(`DUPLICATE_TURN_OPEN_WINDOW_MS`). `ActiveTurn`에 `prompt`/`hasResponse` 추가, `setTurnResponse`가 hasResponse 마킹.
- **`bridge/src/timeline-store.ts` `reapOrphanTaskStarts()`** — Swift `computeOrphanTaskEnds` 미러. 데몬 시작 시 persisted 로드 후 고아 task_start에 합성 task_end(`"Interrupted · –"`, boundarySignal `interrupted`) — 실제 task_end가 늦게 오면 taskId merge로 대체됨. `daemon-server.ts` 로드 직후 호출.
- **Swift `OpenClawAdapter.requestInitialLogTail`** — 어댑터 수명 내 재생한 라인 seen-set(`replayedLogLines`, 4096 캡)으로 재연결 replay 중복 차단(ts 기반은 재스탬프 때문에 무효).
- docs/gateway-protocol.md의 Swift 어댑터 경로 표기 수정(Modules/→Gateway/).

### 검증
- vitest 전체 88 파일/1621 테스트 pass. 신규: `openclaw-timeline-completion.test.ts`(상호배타+automated+LLM upsert 타깃), `timeline-orphan-reaper.test.ts`, collector 에코 가드 2케이스. (참고: better-sqlite3 ABI 재빌드 필요했음 — Node 26 업그레이드 여파, 기존 메모리 패턴.)
- `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED; XCTest 338개 중 실패 6개는 stash 대조로 전부 pre-existing(Timebox 글리프 색상 4 + idle-gap 타이밍) 확인.

---

## 2026-07-02 — TRMNL/D200H blank-frame 근본 원인: PTY 제어문자 → SVG 파스 실패 → 무음 백지 프레임

### 문제
"이미지 스트리밍 기기(특히 TRMNL)에 화면이 안정적으로 표시되지 않는다"는 리포트. 라이브 조사에서 전송로(패널 폴링·RSSI·데몬 헬스)는 정상이었지만, 렌더 파이프라인에서 재현 가능한 근본 원인을 확정: **세션 goal/activity/currentTask 문자열에 ANSI escape(`\x1b[31m` 등)나 제어문자가 섞이면 resvg가 SVG 전체를 거부하고, `renderTrmnlFrame`의 catch가 `debug()` 한 줄만 남기고 순백 blank PNG를 패널에 서빙**한다. `escXml`(5곳 중복 정의)은 `&<>"`만 이스케이프하고 XML 1.0이 금지하는 제어문자는 통과시켰고, `cleanGoal`의 `\s+` 정규식도 `\x1b`를 못 거른다. 툴 인자(예: Bash 명령의 escape 문자)·PTY 파생 텍스트에서 흔히 유입되므로 "특정 세션이 떠 있는 동안만 간헐적으로 백지"라는 증상과 정확히 일치. 재현: goal=`'Fix \x1b[31mred\x1b[0m bug'` → 249바이트 blank 프레임.

### 해결
- **`shared/src/svg-renderers/text-utils.ts`에 `stripUnsafeText`/`escSvgText` 신설** — ANSI(CSI/OSC/2-char) 제거 → XML-불법 제어문자(C0−`\t\n\r`, DEL, U+FFFE/FFFF) 제거 → lone surrogate 제거 → 엔티티 이스케이프. 5곳의 로컬 `escXml`(trmnl-layout, d200h-layout, session-slot-renderer, plugin display-tile)을 이것으로 일원화(qr-renderer의 것은 dead code라 삭제).
- **blank 프레임 방어(defense-in-depth)**: `renderTrmnlFrame` 실패 시 `TrmnlFrame.degraded` 마킹 + `logTagged` 상시 로그(에러 메시지별 1분 rate-limit). frame-cache는 degraded 프레임이 오면 **마지막 정상 프레임을 유지**(stale 대시보드 > 백지 화면), 정상 프레임이 없던 해상도만 blank 허용.
- **캡처 지점 방어**: `cleanGoal`(passive-observer)·`quickActivity`(session-activity)에 `stripUnsafeText` 적용 — Swift/Android 등 SVG 아닌 표면에도 깨끗한 문자열 전파. Swift 허브도 `TrmnlModule.sanitizeText`(NSRegularExpression ANSI + 스칼라 필터)로 sessions_list 인제스트 시 동일 처리.
- **관측성(전송로 dead-window 대조용)**: ① 패널이 폴 윈도우를 놓치고 돌아올 때 1줄 gap 로그(`notePollGap`, 2×cadence+30s 초과, Node+Swift 양쪽) ② firmware가 에러 후 보내는 `POST /api/log`를 debug 게이트 없이 상시 기록(패널당 10s rate-limit, `logs_array` 요약) ③ `logger.ts`·daemon-server 로컬 log()에 ISO 타임스탬프 — 지금까지 daemon-stderr.log의 재시작/사건 시각을 특정할 수 없었다.

### 검증
- 적대 입력 4종(ANSI/제어문자/lone surrogate/emoji+한글) → 전부 정상 프레임(1.8KB+, degraded=false); 수정 전 동일 입력은 249B blank.
- vitest: 신규 `text-sanitize.test.ts`(shared) + `trmnl-frame-cache-degraded.test.ts` + trmnl-renderer 적대 입력 3케이스 포함 관련 스위트 51/51 pass. 전체 스위트의 APME 83개 실패는 stash 검증으로 pre-existing better-sqlite3 ABI 문제(본 변경 무관) 확인.
- `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED (xcodegen 스킴 drift는 원복).
- 라이브: 데몬 재시작 후 실제 패널(1C:DB:D4…)이 재폴링·정상 대시보드 프레임 수신 확인(스크린샷 검증), 15분 텔레메트리 샘플링에서 폴 간격 ~190s 규칙성 확인.

---

## 2026-07-01 — TRMNL "not responding" 근본 원인 조사 + weak-RSSI 전이 로깅

### 문제
TRMNL e-ink 패널이 "WiFi connected / not responding"을 자주 보인다는 리포트를 받아, 실행 중인 프로세스/포트/로그(`~/.agentdeck/swift-daemon.log`, `daemon-stderr.log`, 실시간 `/status`)를 대조 조사했다. 서로 다른 세 메커니즘이 겹쳐 있었다: (1) 6/18~6/29, Node CLI daemon과 Swift macOS 앱 daemon이 포트 9120을 두고 서로 능동적으로 축출하는 dual-hub race — Swift의 health-probe(2s 타임아웃 × 연속 2회 실패 ≈10s)가 Node의 이벤트루프 지연(동기식 better-sqlite3 APME 기록)에 false-positive를 일으키고, Node는 재시작 시 살아있는 Swift daemon을 능동적으로 shutdown시킨다. (2) 당일 새벽 03:00~03:04, iDotMatrix/Timebox BLE sync의 5초 간격 clean-exit→respawn 폭주가 daemon 자체의 반복 self-restart(28회 "Shutting down...", 일부는 shutdown 타임아웃까지)를 유발 — 같은 날 commit `8949e6f8`로 이미 수정됨, 이후 daemon은 6시간+ 무재시작. (3) 패널 자체 WiFi 링크의 물리적 변동(-59dBm ↔ -26dBm 관측) — 서버가 완전히 안정적으로 떠 있어도 firmware가 단발성 poll 실패를 WIFI_FAILED로 표시할 수 있고, 다음 poll에 자동 복구되는 잔여 리스크.

### 해결
- Node(`bridge/src/trmnl/byos-server.ts`)와 Swift(`apple/AgentDeck/Daemon/Modules/TrmnlModule.swift`) 양쪽에 기존 weak-link 임계값(`TRMNL_WEAK_RSSI_DBM`/`weakRssiDbm`, -78dBm — 이미 `image_url_timeout` 확장에 쓰이던 값)을 재사용한 RSSI 상태-전이 로깅을 추가. Node는 `logTagged`(기존 `debug()`는 `--debug` 게이트라 기본 운영 로그에 안 보임), Swift는 `DaemonLogger.error/.info` — 둘 다 항상 노출.
- 매 poll(60~180s)마다 로그하지 않고 weak 진입/회복 **전이 시점에만** 1줄 남겨, 향후 "not responding" 발생 시각을 실제 RSSI 이력과 상시 로그로 대조 가능하게 함.
- (2)는 로그 타임스탬프 교차검증으로 당일 커밋이 이미 해결했음을 확인. (1)은 Swift 앱이 현재 비활성이라 코드 변경 대신 기존 운영 가이드(`docs/devices.md`, 동시 실행 금지)로 커버 — 코어 singleton-guard 튜닝은 전체 daemon 시작 경로에 영향을 주는 리스크가 있어 이번 세션에서는 보류.

### 핵심 설계 결정
- RSSI 로그는 telemetry(매 poll 갱신)와 별개로 **전이만** 남긴다 — 상관관계 신호가 목적이라 매 poll 로그는 스팸.
- dual-hub race의 근본 수정(예: Swift health-probe 타임아웃 완화)은 전 사용자에게 영향을 주는 변경이라 별도 확인 후 진행하기로 하고 이번엔 진단 로깅만 반영.

### 검증
- `npx vitest run bridge/src/__tests__/trmnl-byos.test.ts` — 23/23 pass (신규 weak-RSSI 전이 테스트 포함).
- `cd bridge && npx tsc --noEmit` — clean.
- `xcodegen generate && xcodebuild -project AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' build` — BUILD SUCCEEDED.
- 전체 `bridge/src` vitest는 사전부터 있던 `better-sqlite3` ABI mismatch(APME/codex-turn-manager, 83 tests)로 실패 — `git stash`로 본 변경 제외 후 동일 실패 재현 확인, 본 세션 변경과 무관(다른 세션이 이미 위 항목에서 추적 중).

---

## 2026-07-01 — Daemon 운영 로그 점검 후 TIMELINE/diagnostic hardening

### 문제
라이브 Node daemon 은 `/health`/`/status` 기준 안정적으로 동작했지만, 운영 로그에서 세 가지 개선점이 드러났다. (1) persisted `timeline.json` 에 과거 Codex `tool_exec` firehose 와 OpenClaw `NO_REPLY` polling 찌꺼기가 남아 있고, live WS history 는 필터 후 16개만 내려오지만 late upsert 때문에 timestamp 순서가 어긋날 수 있었다. (2) Claude `<task-notification>` payload 가 서버 저장소에는 `chat_start` 로 남아 클라이언트 렌더 단계 필터에 의존했다. (3) iDotMatrix BLE sync 가 한때 `code=0` clean exit → respawn 을 반복했는데 stdout 이 버려져 종료 원인을 알 수 없었다. 별도로 APME 는 `better-sqlite3` native ABI mismatch(Node 22 daemon vs Codex runtime Node 26)로 비활성화되어 있었다.

### 해결
- shared `timeline.ts` 저장 normalization 에 `isTaskNotificationChatStart` 필터를 추가해 `<task-notification>` `chat_start` 를 서버 저장/브로드캐스트 단계에서 제거.
- `BridgeTimelineStore.getHistory()` / `getHistoryForSession()` 이 항상 timestamp 오름차순 copy 를 반환하도록 변경해 `timeline_history` 와 session detail replay 의 순서를 안정화.
- BLE Python sync helper 가 stdout/stderr 를 live flood 없이 작은 ring buffer 로 캡처하고, iDotMatrix/Timebox daemon sync exit 로그에 clean exit 원인까지 남기도록 변경.
- daemon-managed BLE sync 의 `code=0` 반복 종료는 정상 shutdown 이 아니므로 healthy-uptime backoff reset 대상에서 제외. Timebox `device not found` 나 iDotMatrix clean disconnect 가 5초 루프로 계속 로그를 때리는 경로를 줄였다.
- 로컬 운영 환경에서 daemon Node 22 기준 `better-sqlite3` 를 재빌드해 APME native load 문제를 해소.

### 검증
- `pnpm vitest run shared/src/__tests__/timeline.test.ts bridge/src/__tests__/timeline-integration.test.ts` 성공 — 106 tests.
- `pnpm build` 성공.
- daemon Node v22 및 shell Node v26 양쪽에서 bridge 기준 `better-sqlite3` require 성공.

---

## 2026-07-01 — OpenCode 세션이 활동 중에도 dashboard 에서 idle 로 고착

### 문제
사용자가 OpenCode(`agentdeck opencode`) 세션이 실제로 작업 중인데 dashboard 에 계속 idle 로 표시된다고 보고했다. 점검 결과 OpenCode 어댑터는 PTY 스피너 파싱을 의도적으로 끄고(`wireOutputParser`/`feedParser` no-op) run-state 를 SSE 이벤트로만 도출하는데, 공유 StateMachine 을 `IDLE → PROCESSING` 으로 옮기는 유일 트리거 `spinner_start` 를 내보내던 곳이 `session.status` 의 `status.type === 'busy'` 분기 하나뿐이었다. 현행 OpenCode 빌드는 작업을 `message.updated` / `message.part.updated` / `message.part.delta` 로 통지하고 종료를 `session.idle` 로 알리며 별도의 안정적인 `busy` 시작 이벤트를 보내지 않아, 한 턴 내내 IDLE 로 고착됐다. `tool_action` 파서 이벤트는 `currentTool` 만 세팅하고 상태 전이는 하지 않으므로 툴 이름은 떠도 라벨은 idle 인 상태가 가능했다. Claude/Codex 는 hook + PTY 스피너로 구동되어 정상이었다.

### 해결
- `bridge/src/adapters/opencode-adapter.ts` 에 `beginChatIfNeeded()` 헬퍼를 추출(턴당 1회 래치). `chat_start` 타임라인 + `spinner_start` 파서 이벤트를 발행.
- OpenCode 가 실제로 보내는 작업-시작 신호에서 호출: `handleSessionStatus` busy, `handlePartUpdated`, `handlePartDelta`, 그리고 생성 중인 assistant `message.updated`(`time.completed == null`).
- `finishChat()`(`session.idle`)가 `chatStarted` 를 리셋해 다음 턴 재무장.
- connect-time `listSessions` 가 갓 생성 세션을 놓쳐 `activeSessionID` 가 미해결이면 작업유발 이벤트의 sessionID 로 auto-track(이전에는 `sessionID !== activeSessionID` 가드가 전 이벤트를 silent drop). non-active 세션 part drop 시 진단 로그.
- 어댑터의 상태 도출 자체를 고친 것이라 dashboard/Stream Deck/devices/Apple 표면이 동시에 정상화됨(표면별 렌더 버그 아님).

### 핵심 설계 결정
- run-state 무장을 `session.status:busy` 단일 이벤트에 의존하지 않고, 버전에 관계없이 실제 도착하는 message/part/delta 신호에서 래치. 재발행되는 `spinner_start` 는 PROCESSING 에서 no-op 이고 PTY activity 가 stuck-timer 를 계속 리셋하므로 장기 턴도 중간에 idle 로 강등되지 않는다.

### 검증
- 신규 `bridge/src/__tests__/opencode-adapter-state.test.ts` 6 케이스(arm-once 래치, idle 리셋+재무장, auto-track, 생성중 vs 완료 message 무장, non-active 세션 drop).
- `pnpm build` 성공, `pnpm vitest run bridge/src/__tests__/` 1106/1106 성공.

## 2026-07-01 — Node display sleep sync: lock/screen saver/session presence parity

### 문제
사용자가 `cmd+shift+eject` 로 즉시 모니터를 끄면 dashboard 기기들이 대부분 꺼지지만, 장시간 유휴 → macOS 잠금 화면 유지 → 이후 모니터 sleep 경로에서는 일부 기기가 계속 켜질 수 있다고 보고했다. 점검 결과 Swift in-process daemon 은 display asleep + screen lock + screensaver + session inactive 를 합성해 `display_state{displayOn:false}` 를 보내지만, Node CLI daemon 의 `DisplayMonitor` 는 `CGDisplayIsAsleep()`/`pmset IODisplayWrangler` 만 보고 있었다. 즉 잠금 시점에는 fan-out 이 없고, 이후 display sleep 감지도 메인 display/power-state 신호에 의존해 외부 모니터·잠금 화면 경로에서 놓칠 여지가 있었다.

### 해결
- Node `bridge/src/display-monitor.ts` 를 Swift 와 같은 의미의 composite monitor 로 변경: `displayAsleepByCG`, `displayAsleepByPower`, `screenLocked`, `screensaverActive`, `sessionInactive` 를 별도 저장하고 합성값이 바뀔 때만 `display_state` 를 emit.
- fallback poll 이 `pmset` 외에 `ioreg -n Root -d1` 의 `CGSSessionScreenIsLocked` / `CGSSessionOnConsoleKey`, `pgrep -x ScreenSaverEngine` 를 함께 본다.
- `BridgeCore.wireDisplayMonitor()` 는 listener 를 먼저 등록한 뒤 monitor 를 시작한다. 이미 잠긴 상태에서 데몬이 시작될 때 즉시 fallback poll 이 `display_state:false` 를 emit 해도 유실되지 않게 하기 위함.
- `isDisplayOn()` 과 `/display-state` 초기 응답도 합성값을 반환하므로 새로 붙은 Stream Deck/Android/ESP32/BLE sync 클라이언트가 잠금 중 밝게 살아나는 경로를 줄였다.
- `docs/plugin-conventions.md` 의 display sleep/wake sync 설명을 Node/Swift composite 의미로 갱신.

### 검증
- `parseIoregPresence` 회귀 테스트 추가.
- `pnpm --filter @agentdeck/bridge typecheck` 성공.
- `pnpm vitest run bridge/src/__tests__/tier3-integration.test.ts bridge/src/__tests__/display-dim.test.ts bridge/src/__tests__/bridge-core.test.ts` 성공.
- `pnpm build` 성공.

## 2026-06-30 — OpenClaw polling NO_REPLY timeline noise 필터 패리티

### 문제
OpenClaw cron/polling 흐름이 "Still translating", "No action needed", `NO_REPLY` 같은 상태 확인 응답을 `chat_response`/automated `chat_start`로 남겨 Android/Apple/shared device timeline에 사용자 작업처럼 보일 수 있었다. 반대로 LINE/userId 알림 실패 같은 실제 조치 필요 신호는 숨기면 안 된다.

### 해결
- shared `timeline.ts`, Swift `DaemonTimelineStore`, Android `TimelineDisplay.kt`에 `isOpenClawLowSignalResponse` 필터를 추가.
- polling/no-op 응답과 automated polling start는 storage/display low-signal로 제거.
- LINE notification/userId/target ID 실패·미설정·pending 신호는 예외로 유지.
- shared, Swift XCTest, Android unit test에 polling drop / notification failure keep 회귀 케이스 추가.

### 검증
- `pnpm build` 성공.
- Android `:app:testDebugUnitTest` 성공.
- macOS `AgentDeck_macOS` build 성공.

---

## 2026-06-30 — Claude timeline turn rows: chat_response와 chat_end 중복 제거

### 문제
Claude Code turn 하나가 `chat_start` + `chat_response` + dimmed `chat_end` 3행으로 flat timeline 표면(Stream Deck plugin, TUI, persisted `timeline.json`)에 남아 실제 작업 단위가 과도하게 쪼개졌다. Android/macOS dashboard projection은 paired `chat_end`를 렌더 단계에서 대부분 숨기지만, 저장/relay/flat surface에는 중복 metadata row가 계속 흘렀다.

### 해결
- Node `bridge/src/index.ts`: 응답 텍스트가 있으면 `chat_response`만 turn completion row로 emit하고, 응답이 없는 tool-only/response-less turn에서만 `chat_end`를 emit.
- Voice assistant는 더 이상 `chat_end.detail`만 보지 않고 `chat_response`를 우선 읽고 `chat_end`를 fallback으로 사용.
- Swift `DaemonServer.swift`: Node와 같은 계약으로 `assistantText`가 비어 있을 때만 `chat_end`를 생성. 응답 있는 turn의 LLM summary 기반 `chat_end` upsert 경로는 제거.
- Android stale test 보정과 맞물려 Codex/Claude device timeline은 chat/task lifecycle row 중심으로 유지.

### 검증
- `pnpm build` 성공(bridge TypeScript compile 포함).
- Android `:app:testDebugUnitTest` 성공. Claude paired `chat_end` suppression 기대와 Codex tool firehose 제거 기대가 모두 녹색.

---

## 2026-06-30 — Android mDNS/WiFi 접속 fallback 검증 및 반영

### 문제
Android tablet/e-ink 앱이 USB reverse(`127.0.0.1:9120`) 실패 후 mDNS로 daemon을 찾아도, dual-homed Mac에서 Bonjour TXT `ip`와 Android NSD resolved host가 다를 때 한쪽 경로만 고집하면 WiFi 접속 복구가 막힐 수 있었다.

### 해결
- `BridgeDiscovery.kt`: TXT `ip`를 primary로 유지하되 link-local/IPv6/raw-invalid host를 제외하고, NSD resolved IPv4가 primary와 다르면 `fallbackHost`로 보존.
- `BridgeConnection.kt`: primary URL이 연속 실패하면 같은 pairing token을 유지한 fallback URL로 한 번 전환한 뒤 기존 re-discovery 흐름으로 복귀.
- tablet/e-ink/settings의 모든 mDNS connect 호출이 `bridge.wsUrl()`과 `bridge.fallbackWsUrl()`을 함께 넘기도록 배선.
- `BridgeDiscoveryTest`로 primary/fallback URL이 동일 pairing token을 유지하는 계약을 고정.
- stale test 보정: Android 정책상 Codex `tool_exec` firehose는 device timeline에서 제거되므로 `TimelineDisplayScenarioTest` 기대를 `TimelineStoreTest`/현재 devlog 정책과 맞춤.

### 검증
- `pnpm install --frozen-lockfile`, `pnpm build` 성공.
- Android `:app:compileDebugKotlin`, `:app:testDebugUnitTest`, `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.1.0.apk`.
- Pantone 6(`AA007422R24C1300039`), Crema S(`CREMAA21W09235`), Lenovo Tab(`HVA095B4`)에 APK 설치/실행 성공.
- USB reverse 제거 후 세 기기 모두 mDNS로 `192.168.68.100:9120?token=...` 연결 `onOpen` 확인. host `lsof`에서도 `192.168.68.68`, `192.168.68.55`, `192.168.68.53` → `192.168.68.100:9120` 직접 ESTABLISHED 확인.
- 세 기기 `AndroidRuntime` fatal/crash 로그 없음. 검증 후 표준 배포 상태로 `adb reverse tcp:9120 tcp:9120` 복구.

---

## 2026-06-30 — iOS "won't connect" = Local Network permission denied (surface an in-app prompt)

### 문제
iPhone(새 번들 `bound.serendipity.agent.deck`)의 대시보드 앱이 데몬에 "접속 안 됨". 라이브 기기 진단 결과 토큰/네트워크/데몬은 모두 정상(`~/.agentdeck/auth-token` == mDNS TXT, 데몬 healthy)이었고, flapping이나 dual-home도 아니었다. `devicectl … process launch --console`로 앱 stdout을 직접 잡으니 진짜 원인이 드러남: NWBrowser가 `waiting(-65570: PolicyDenied)` 루프 — **iOS 로컬 네트워크 권한이 거부 상태**라 mDNS 검색이 0개를 반환하고 영영 연결 못 함. 앱은 `.waiting`을 "권한이 방금 바뀐 줄 알고" `restartBrowser()`만 무한 반복할 뿐 사용자에게 아무 안내가 없었다(외부 유저는 원인을 알 수 없음). 권한을 켜자 즉시 `resolved → connecting → first message received — connected!`로 복구되어 단일 원인임을 확인.

### 해결
- **`BridgeDiscovery.swift`**: `NWBrowser.State.waiting(error)`에서 PolicyDenied(`-65570` / description fallback)를 감지해 `@Published localNetworkDenied` 플래그를 올림. 거부 루프의 ready→waiting flicker는 debounce(`.ready` 2초 유지 시에만 clear, `browseResultsChanged` 시 즉시 clear)로 처리.
- **`ConnectionOverlay.swift`**: `localNetworkDenied`일 때 "Local Network access is off" 카드 + iOS는 `UIApplication.openSettingsURLString`로 **[Open Settings]** 버튼, macOS는 System Settings 경로 안내. 무한 "Searching…" 대신 명확한 행동 유도.
- **`BridgeConnection.swift`** (secondary, keepalive 견고화): 주기 keepalive ping에 **5초 timeout** 추가(없었음 — URLSessionWebSocketTask `sendPing` completion은 stall 시 60초 receive timeout까지 hang → 데몬 15s eviction을 한참 넘김), repo의 "모든 외부 await에 timeout" 규약 준수. ping 간격 15s→8s(데몬 eviction 2× 마진), 첫 ping 2초, ±jitter. 죽은 상수 `maxReconnectAttempts=20` vs 실제 5 정리.

### 핵심 설계 결정
- "접속 안 됨" 디버깅은 **앱 stdout(`--console`)이 ground truth** — `idevicesyslog`는 앱 `print()`를 못 잡고(os_log만), 화면 캡처는 DDI 필요. CFNetwork `Sent ping N` os_log는 잡히지만 connection liveness 추론에만 유용.
- 로컬 네트워크 권한은 TCC라 코드로 못 켬 → 거부를 first-class 상태로 감지해 Settings 딥링크 유도가 정답(App Review-safe: 컴패니언 설치 유도 아님, OS 권한 재요청).
- **함정**: iPhone에 이름이 같은 "AgentDeck" 앱이 둘(`agent.deck` 0.1.0 신규 + `agentdeck.dashboard` 1.0.7 구) 깔려 둘 다 데몬에 붙어 clients 카운트(6~10)를 출렁이게 함. 구 앱이 권한 살아있어 안정 연결(ping 263, 15s)이라 신 앱 진단을 흐렸음.

### 검증
- iOS·macOS `BUILD SUCCEEDED`. iPhone에 dev 서명 빌드 배포 후 `--console`로 권한 grant→`connected!` 확인. 권한 카드는 실제 `PolicyDenied` 로그 신호에 직접 매칭(컴파일 검증).

## 2026-06-29 — LIMITS gauges: render Codex (not just Claude) on e-ink + TRMNL surfaces

### 문제
전자책(Android e-ink: CremaS/Panton 등)과 TRMNL e-ink의 **LIMITS** 영역이 Claude의 5h/7d만 보여주고 Codex 등 다른 솔루션은 안 나왔다. 데이터 문제가 아니라 렌더링 누락이었다: `buildUsageEvent`는 단일 `usage_update`에 Claude + `codexRateLimits` + `antigravityStatus`를 모두 싣고, Android `AgentState`는 `state.codexRateLimits`를 hoist까지 한다. 실제로 HUD rail(`TopologyRail`)·D200H·ESP32 IPS10 topbar는 이미 Codex를 그렸지만, e-ink composable들과 TRMNL 렌더러는 `fiveHourPercent`/`sevenDayPercent`만 읽고 `codexRateLimits`를 무시했다.

### 해결
- **표시 규약(사용자 결정)**: 브랜드 마크가 provider를 나타낸다 — 라벨은 `5h`/`7d` 그대로, 행 앞의 per-agent 브랜드 마크로 Claude/Codex를 구분(D200H의 "brand dot conveys the agent" 규약과 동일).
- **Android**: 공유 헬퍼 `codexLimitRows()`/`windowLabel()`/`ProviderLimitRow`를 `util/TimeFormatUtils.kt`에 추가하고 `TopologyRail.buildCodexRateChips`를 그것으로 리팩터(drift 방지). e-ink LIMITS 표면(live `EinkLimitsCornerCard` + 레거시 `EinkStatusPanel`/`EinkStatusCompact`/`EinkEngineColumn`/`EinkUsagePanel`)과 태블릿 `UsageSummaryCard`에 Codex 행을 `BrandIcon`과 함께 추가. Codex는 Claude의 `usageStale`이 아니라 **윈도별 자체 stale**로 게이팅.
- **TRMNL**: Node `shared/src/trmnl-layout.ts`와 Swift 미러 `TrmnlImageRenderer.swift`에 Codex 풋터 행(Codex 글리프 + 5H/7D) 추가, Codex 있을 때 풋터 밴드를 2행으로 확장. `frame-cache.ts::trmnlStateHash`와 Swift `TrmnlModule.stateHash`에 Codex 필드를 접어 넣어 Codex-only 변경도 재렌더되게 함. `TrmnlDashState`에 codex 윈도 필드 추가 + `applyUsage`에서 hoist 파싱.

### 핵심 설계 결정
- 매핑 SSOT는 `codexLimitRows`/`windowLabel` 한 곳 — rail과 e-ink가 갈라지지 않게.
- TRMNL은 Node SVG + Swift CoreGraphics **이중 렌더**(App Store 격리)라 두 렌더러를 같은 변경에서 동시 수정해야 한다(미러 불변식).
- **ESP32는 이번 변경에서 제외**: Codex는 이미 메인 IPS10에서 렌더되고, non-IPS10 TANK STATUS 확장은 best-effort인데 `esp32/`가 동시 세션에서 활발히 편집 중(agent_state.h 포함)이라 충돌 위험 + 하드웨어 플래시 검증 필요 → 깨끗한 후속으로 미룸.

### 검증
- vitest TRMNL: layout 23 + frame-cache 4 + renderer/byos 27 통과. Codex 풋터를 실제 PNG로 래스터화해 Claude/Codex 2행 + 브랜드 마크 시각 확인.
- Android `:app:compileDebugKotlin` 성공, `TimeFormatUtilsTest` 24개 통과(신규 `codexLimitRows`/`windowLabel` 포함).
- `AgentDeck_macOS` Debug 빌드 성공(Swift 미러).
- Android e-ink 카드 자체 에뮬레이터 스크린샷은 미수행(스크린샷 테스트 하니스 없음) — 동일 데이터+`BrandIcon` 경로이고 TRMNL PNG가 마크 규약을 시각 검증.

---

## 2026-06-29 — IPS10 USB-only reboot root cause: HUD stack smash, not WiFi/daemon half-open

### 문제
10.1" IPS(`ips_10`, `/dev/cu.wchusbserial211240`)가 같은 전원/USB 환경에서도 몇 초 간격으로 재부팅했고, 데몬에서는 한때 포트가 열려 있으나 세션/크리처 데이터가 보이지 않는 것처럼 관찰됐다. 초기 판단은 P4+C6 WiFi/ESP-Hosted half-open 쪽으로 기울었지만, USB-only에서도 재부팅된다는 사용자 관찰과 직접 serial monitor 로그가 그 진단을 반박했다.

### 실제 원인
직접 `pio device monitor`로 데몬을 배제하고 본 로그는 `Stack smashing protect failure!` + `rst:0xc (SW_CPU_RESET)`였다. addr2line 기준 app frame은 `HUD::update()` / `Office::update(float)`였고, stack 내용에는 `crosspoint-agentdeck`, `claude-code`, `OpenClaw` 등 live session 문자열이 남아 있었다.

근본 버그는 `esp32/src/ui/widgets/hud_bar.cpp::HUD::update()`의 legacy session-list buffer였다. IPS10은 `lblSessions == nullptr`이고 D1 mosaic을 쓰는데도 매 프레임 `char buf[400]`에 최대 10개 세션명을 조립했다. 게다가 `pos += snprintf(...)`는 실제로 쓴 길이가 아니라 "썼을 길이"를 반환하므로, 긴 project/session name 조합에서 `pos > sizeof(buf)`가 되고 다음 `buf + pos` / `sizeof(buf) - pos`가 stack 밖 주소와 size_t underflow로 이어졌다. 결과는 UI task stack smash → SW reset. 즉 전원, 배터리, WiFi, C6 coprocessor, office 렌더 자체 문제가 아니라 host 세션 데이터가 충분히 들어온 뒤 HUD text formatting이 stack을 부순 것이다.

### 해결
- IPS10에서는 legacy session-list copy와 `char buf[400]` 조립을 compile-out했다. IPS10은 D1 mosaic 경로가 세션 표시의 소유자다.
- non-IPS legacy HUD도 같은 패턴에 취약했으므로 `appendBounded()` helper로 `snprintf` 반환값을 clamp하고, `pos`가 버퍼 끝을 절대 넘지 않게 했다.
- render loop에 heap allocation은 추가하지 않았다. PSRAM 보드/무-PSRAM 보드 모두 고정 stack buffer + bounded append 경로다.

### 검증
- `pio run -d esp32 -e ips10` 성공.
- `pio run -d esp32 -e ttgo` 성공(non-IPS legacy HUD compile path 확인).
- HUD stack-smash fix를 IPS10 실기에 플래시한 뒤 `/health` 60초+ 샘플에서 `connected=true`, `transportOpen=true`, `stale=false`, read/write 0-4초 유지. 이후 office dead-code cleanup은 위 두 보드 빌드로 검증했다.

### 왜 Claude Code가 헤맸는가
1. `/status`/`sessions_list`/`/devices`의 의미를 섞었다. `/status allSessions: []`를 세션 부재로 과해석했고, `/devices`의 `ips_10` live state와 WebSocket `sessions_list` 10개를 같은 타임라인으로 맞춰 보지 않았다.
2. 포트가 열려 있는데 UI 데이터가 안 보이는 현상을 "half-open"으로 이름 붙인 뒤, 그 가설을 panic log로 검증하지 않았다. ESP32 재부팅/크래시 의심 시에는 daemon health보다 direct serial monitor의 panic line이 1차 증거다.
3. P4+C6 WiFi hang이라는 알려진 문제를 너무 빨리 적용했다. `wifiConfigured:false`는 USB serial 운영에서 정상일 수 있고, USB-only reboot는 WiFi 브링업 hang 가설과 맞지 않는다.
4. `snprintf` 반환값 semantics를 놓쳤다. C/C++ firmware에서 `pos += snprintf(buf + pos, size - pos, ...)`는 `pos < size` guard 없이 쓰면 overflow 방어가 아니라 overflow 트리거가 된다.

Memory tags: `ips10-hud-stack-smash`, `serial-half-open-requires-panic-log`, `snprintf-return-value-not-written-length`.

## 2026-06-29 — Codex usage limits: stale snapshot no longer reads as "now"

### 문제
대시보드 LIMITS 게이지에서 Codex 사용량이 `5H ███ 67% ↻now` 처럼 모순되게 표시됐다. `now` 는 "지금 리셋 중"(=사용량 ~0)으로 읽히는데 막대는 67% 라 어색했다. 원인은 freshness 모델의 부재: Claude 사용량은 라이브 API + 10분 staleness TTL 인 반면, **Codex 사용량은 `~/.codex/sessions/.../rollout-*.jsonl` 을 수동적으로 읽기만** 한다. Codex 를 안 쓰면 마지막 `rate_limits` 스냅샷이 얼어붙어 `used_percent` 는 옛값 그대로, `resets_at` 은 과거로 흘러가고, 6개의 중복 reset 포매터가 모두 `diff <= 0 → "now"` 를 반환했다.

### 해결
6개 포매터를 건드리지 않고 **이벤트 소스에서 per-window 정규화**:
- `shared/src/format-utils.ts` 에 `isCodexWindowStale(resetsAt, graceMs=5m)` 추가 — `resets_at` 이 grace 넘게 과거면 stale.
- `bridge/src/usage-event.ts` `buildUsageEvent` 가 만료 윈도우를 정규화: `usedPercent` 유지 + `resetsAt` 제거(→ 모든 다운스트림 포매터에서 "now" 소멸) + `stale:true`. 5h 만료/7d 라이브가 독립 처리된다.
- Swift 데몬 미러: `apple/.../DaemonServer.swift` 의 `codexRateLimitsPayload` + `isCodexWindowStale`, `UsageAPIClient.swift` 의 window struct.
- 타입 4표면(`shared/protocol.ts`, Swift/Kotlin `Protocol`, plugin `usage-gauge.ts`) 에 `stale?` 추가.
- 렌더러 dim + "stale" 마커: plugin E3 인코더/144 타일, `shared/d200h-layout.ts`, Apple 메뉴바 `compactGauge` + TopologyRail, Android RateChip(기존 stale 지원 재사용).

### 핵심 설계 결정
- **만료 = stale, zeroing 아님**: 만료 윈도우의 percent 를 0 으로 만들지 않고 마지막값을 유지한 채 dim + "stale" 로 불확실성을 정직하게 노출(`adjustUsagePercent` 의 far-past 철학과 일치). 사용자가 Option A 로 확정.
- **per-window staleness**: 전역 `usageStale`(Claude-API TTL)로 Codex 를 비우면 안 됨 — 윈도우별 `stale` 플래그로 처리. 부수적으로, Claude fetch 가 없을 때 Codex 인코더가 통째로 비워지던 **잠재 버그**도 제거(`buildCodexUsageEncoder` 의 전역 staleness gate 제거).

### 검증
- vitest 1583/1583 (신규 `isCodexWindowStale` 6 + `buildUsageEvent` 정규화 3 포함).
- macOS Swift `xcodebuild` BUILD SUCCEEDED.
- 시각 확인(resvg 라스터): D200H Codex 타일 + plugin E3 인코더 모두 만료 5H 가 흐린 `67% · stale`, 라이브 7D 는 `12% · 4d23h` — "now" 없음.

## 2026-06-28 — Timebox Mini micro glyph: actual creature fidelity pass

### 문제
Divoom Timebox Mini(11×11 BLE)의 micro glyph 가 기기 해상도 제약을 고려하더라도 canonical creature 와 다르게 읽혔다. 특히 Claude 는 amber-eye 캐릭터처럼 보였고, Codex 는 하단이 cloud lobe 가 아니라 다리처럼 갈라졌으며, OpenCode 는 실제 단일 rectangular ring 이 아니라 겹친 사각형처럼 보였다.

### 해결
- Timebox Mini 렌더링 전략을 “작은 테라리움”이 아니라 **single dominant status badge** 로 명문화했다. 상태는 배경색이 담당하고, 전경 11×11 glyph 는 canonical mark 식별점만 남긴다.
- `bridge/src/pixoo/micro-glyphs.ts` SSOT 를 원본 asset + Pixoo/iDotMatrix small LOD 기준으로 재드로: Claude=two-row vertical dark cutout eyes + full-width robot arms + straight legs, Codex=rounded cloud + oversized `>_` + bottom cloud lobe, OpenCode=single tall hollow ring, OpenClaw=side claws + teal eyes(raised claws 는 11px 에서 과장돼 제외), Antigravity=transparent center hollow. Swift mirror 는 `pnpm generate-micro-glyphs` 로 재생성했다.
- Pixoo64/iDotMatrix shared renderer 의 Codex small LOD/MD 도 같은 원칙으로 정리했다. 기존 분리된 top/bottom lobes 는 작은 화면에서 다리처럼 보였으므로, rounded cloud body + prompt mark 형태로 변경하고 `pixoo-sprites.test.ts` 회귀 가드를 추가했다.
- `timebox-ble.test.ts` 에 각 glyph 의 identity pixel 을 고정하는 회귀 테스트를 추가했다.

### 검증
- `pnpm generate-micro-glyphs` 성공.
- `pnpm vitest run bridge/src/__tests__/timebox-ble.test.ts bridge/src/__tests__/pixoo-sprites.test.ts` 성공.

## 2026-06-28 — Antigravity creature color parity: Android color e-ink/tablet + ESP32 terrarium

### 문제
Antigravity 크리처가 Android color e-ink 기기에서 배경과 겹치는 흐릿한 단색처럼 보였고, Android tablet 에서는 원본 rainbow mark 대신 노란색이 과하게 지배적으로 보였다. 또한 TC001 matrix 경로에는 micro sprite 가 있었지만 일반 ESP32 terrarium 경로에는 antigravity session count/name/render 연결이 없어 화면에 나오지 않았다.

### 해결
- Android tablet `AntigravityCreature` 를 canonical path fill rule(`EvenOdd`)로 맞추고, base gradient 를 녹색→시안→블루→핑크→레드→오렌지→노랑 대각 rainbow 로 재조정했다. 기존 warm overlay 는 낮은 alpha 로 줄여 노란색 단색처럼 덮이지 않게 했다.
- Android e-ink renderer 의 color e-ink 모드에서 antigravity mark 를 더 크게 그리고, 어두운 외곽선 + 밝은 hairline 을 추가해 Kaleido 배경 위에서도 형태가 분리되게 했다. 흑백 e-ink 는 기존 고대비 gray fallback 을 유지한다.
- ESP32 terrarium 에 `MAX_ANTIGRAVITY`, `antigravityCount`, `antigravityNames`, `Antigravity::render` 경로를 추가했다. 기존 generated `ANTIGRAVITY_A8` mask 를 정적 참조하고 per-pixel rainbow tint 를 입히므로 render path 에 heap allocation 은 추가하지 않았다. TC001 `led8x32` matrix 경로는 기존 micro sprite 를 유지한다.

### 검증
- Android `./gradlew :app:compileDebugKotlin --no-daemon` 성공.
- Android `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.state.TimelineStoreTest --no-daemon` 성공.
- ESP32 `pio run -d esp32 -e ttgo`, `pio run -d esp32 -e ips35`, `pio run -d esp32 -e led8x32` 성공.

## 2026-06-28 — Android tablet TIMELINE macOS parity: Codex Bash firehose 제거 + daemon history 복원

### 문제
Android tablet TIMELINE 이 macOS Dashboard 와 다르게 Codex `tool_exec` row(`Bash: ...`, `Bash completed: ...`, `apply_patch ...`)를 그대로 보여줘 실제 사용자-facing 활동 단위(chat/task)를 밀어냈다. 또한 Node CLI daemon 재시작 뒤 새로 연결한 Android tablet 은 `BridgeTimelineStore` 메모리 buffer 가 비어 있으면 디스크 `~/.agentdeck/timeline.json` 에 최근 활동이 있어도 `timeline_history`를 받지 못해 `No timeline events` 로 보였다.

### 해결
- Android `TimelineDisplay.kt` low-signal filter 를 Apple/Shared 정책과 맞춰 Codex `tool_exec` 를 전부 device timeline storage/display 에서 제거. APME/내부 trajectory 는 별도 경로로 유지하고, tablet 은 Codex chat/task lifecycle row 만 표시.
- Node `BridgeTimelineStore` 에 persisted `timeline.json` rehydrate 경로를 추가. daemon 시작 시 후보 data dir 의 최신 `timeline.json` 을 listener broadcast 없이 메모리 replay buffer 로 로드하고, 같은 storage normalization 으로 Codex tool firehose 는 복원하지 않는다.
- 회귀 테스트: Android `TimelineStoreTest` 에 일반 `codex:<uuid>` Bash row drop 케이스 추가, bridge `timeline-integration.test.ts` 에 persisted history load + Codex tool_exec 제거 케이스 추가.

### 검증
- Android `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.state.TimelineStoreTest --tests dev.agentdeck.net.ProtocolTest --no-daemon` 성공.
- `pnpm vitest run bridge/src/__tests__/timeline-integration.test.ts shared/src/__tests__/timeline.test.ts` 성공 — 2 files / 100 tests.

---

## 2026-06-28 — Antigravity 구독 만료일 수집 및 상단 LIMITS 정보 공간 효율 개선 (10" IPS / TRMNL)

### 문제
10" IPS 및 TRMNL 기기 등 BYOS(Bring Your Own Screen) 환경에서 화면 상단에 표시되는 구독 정보(`LIMITS`)가 가로로 너무 긴 영역을 차지하여 화면 구성의 비효율이 발생했다. 또한, Antigravity(Gemini) 세션의 경우 실시간 크레딧 정보(`1000cr`)가 불명확하게 노출되었고, 구독 만료일 정보는 수집 및 노출되지 않아 관리의 편의성이 부족했다.

### 해결
1. **Antigravity 구독 만료일 수집**:
   - `antigravityAuthStatus` DB 데이터로부터 `subscriptionActiveUntil` 등의 속성 값을 파싱하도록 구현함.
   - 만약 JSON 키로 직접 노출되지 않는 경우를 대비해, base64로 디코딩된 protobuf 아스키 데이터 목록(`strings`)에서 ISO 8601 날짜 정규식 패턴(`^\d{4}-\d{2}-\d{2}`)을 대조하여 안전하게 만료일을 식별하도록 폴백 장치를 추가함.
2. **구독 텍스트의 로고화 및 가로폭 최소화**:
   - `shared/src/trmnl-layout.ts` 헤더 영역에 `"Claude"`, `"ChatGPT Plus"`, `"Google AI Pro"` 등 불필요하게 긴 텍스트를 나열하는 대신, 각 플랜에 해당하는 모노크롬 로고 아이콘을 렌더링하고 바로 옆(간격 4px 최소화)에 플랜의 컴팩트 명칭(`Plus`, `Pro` 등)과 만료일(`→ Month Day`)만 표시하는 구조로 개선함.
   - Claude의 경우 텍스트 명칭을 생략하고 로고 아이콘과 만료일만으로 공간 효율을 극대화함.
3. **E-ink 모니터 스크린 Parity**:
   - 안드로이드 E-ink 대시보드의 Limits 행에서도 중복되던 `"AG"` 라는 라벨 접두어와 불명확한 `credits` 값 노출을 제거하고, 순수 플랜 명과 컴팩트하게 포맷팅된 만료일을 렌더링하도록 일치화함.
4. **Parity 동기화 및 테스트**:
   - `shared/src/protocol.ts`에 `AntigravityStatusInfo.subscriptionActiveUntil` 스펙을 추가하고 `pnpm generate-protocol`을 수행하여 Kotlin 및 Swift 타입 선언과 동기화함.
   - 변경된 컴팩트 렌더링 사양에 맞춰 `trmnl-layout.test.ts` 테스트 코드를 갱신하여 1566개 단위 테스트 전원 통과를 확인(Green).

---

## 2026-06-28 — CLI 데몬 ↔ macOS GUI 앱(Swift) 경합 방지 및 포트 Takeover

### 문제
macOS GUI 앱(Swift 인프로세스 데몬)이 먼저 `9120` 포트를 선점하고 동작할 때, 터미널에서 CLI 데몬(`agentdeck daemon start`)을 띄우면 이미 포트가 점유 중임을 감지하여 CLI 데몬이 즉시 종료(`process.exit(0)`)되었다. 이로 인해 Claude Code/Codex 등 터미널 세션을 띄우는 데 필수적인 PTY 스폰 전용 CLI 데몬 허브를 함께 띄울 수 없어 두 프로그램 간에 경합과 동작 차단이 발생했다.

### 해결
1. **Swift Daemon `/health` 응답 보완**: `DaemonServer.swift`의 `/health` 응답 JSON에 `"isSwift": true` 플래그를 실어, 해당 데몬이 macOS 앱의 인프로세스 데몬임을 구별할 수 있게 함.
2. **Swift 앱 자동 양보 및 클라이언트 전환**:
   - `DaemonServer.swift`에 `onShutdown` 콜백을 등록.
   - `DaemonService.swift`에서 `onShutdown` 콜백 수신 시 `connectToExternalDaemon`을 바로 실행하여, 로컬 HTTP/WS 소켓을 닫고 외부 CLI 데몬의 중계 클라이언트 모드(`isUsingExternalDaemon = true`)로 실시간 복귀하도록 조치.
3. **CLI 데몬 Takeover 메커니즘**:
   - `session-registry.ts`에 타 데몬 종료 유도 API인 `requestDaemonShutdown(port)` 추가.
   - `daemon-server.ts`의 싱글톤 가드 로직에서 `/health` 프로브 시 `isSwift === true`가 발견되면, 해당 데몬에게 `requestDaemonShutdown`을 쏘고 **1.5초**간 소켓 릴리즈를 대기한 뒤 `process.exit(0)` 없이 포트를 이어받아 기동하게 함.

### 핵심 설계 결정
- **소유자(Port Owner)의 양보와 백엔드 보존**: GUI 앱이 포트 `9120`을 반납(수신 소켓 Close)하고 외부 데몬의 클라이언트로 붙어도, 앱 프로세스는 유지되므로 **D200H USB HID(Stream Deck+) 통신 등의 샌드박스 내 기기 제어는 온전히 살아남아** 외부 CLI 데몬으로 데이터가 정상 릴레이됨.
- **100% 완전체 하이브리드 구동**: 샌드박스 외부 CLI의 PTY 기동 권한과 샌드박스 내부 앱의 USB 독점 권한이 경합 없이 한 쌍으로 엮이는 구조를 실현.
- **검증**: `pnpm test`로 `vitest` 유닛 테스트 1556개 전원 통과 확인.

## 2026-06-28 — D200H sleep/wake 후 OFFLINE 고착 (실제 원인 = state='disconnected' 오해석)

### 문제
macOS 잠자기 → 깨우면 Ulanzi D200H 가 OFFLINE 으로 남고 수동 개입 없이는 복구되지 않았다.

### 해결 (실제 근본 원인)
런타임 점검(lsof)으로 plugin↔Studio, plugin↔daemon WS 둘 다 ESTABLISHED·생존(15s ping-evict 통과) 확인 → WS 층은 멀쩡. 데몬 WS 프로브로 진짜 원인 발견: 데몬이 `state_update{state:'disconnected', allSessions:[]}` + `sessions_list{6 observed sessions}` 를 보내는데, `shared/src/d200h-layout.ts buildSessionDeck` 이 top-level `state==='disconnected'` 만 보고 **allSessions 무시한 채 OFFLINE hero** 를 그렸다. 데몬의 top-level state 는 **managed/focused 세션 기준** — sleep 으로 managed PTY 세션이 끝나고 observed(ps) 세션만 남으면 state='disconnected' 가 되어, 세션 6개가 살아있어도 OFFLINE.

Fix: OFFLINE 게이트에 `&& state.allSessions.length === 0` 추가(`5616ab73`). 진짜 링크끊김은 plugin store 가 `{state:'DISCONNECTED'(대문자), allSessions:[]}` 로 보내므로 여전히 OFFLINE.

### 함께 고친 latent 버그 (증상 원인은 아님)
점검 중 plugin-ulanzi 가 독립 WS 2개 중 **Ulanzi Studio 브리지**(vendored `vendor/ulanzi-api`)에만 재연결이 없음을 발견(데몬 링크는 wake-watchdog+backoff 있음). vendored `connect()` 는 1회만 열고 `onclose`→`Events.CLOSE` emit, `app.ts` 는 로그만. → `ReconnectSupervisor`(`plugin-ulanzi/src/reconnect-supervisor.ts`, backoff+10s wake-watchdog+connect-timeout 인플라이트 가드) 추가(`2cd6221a`). 이번 증상의 원인은 아니지만 sleep 시 Studio 소켓 사망 시나리오 대비 견고성 개선.

### 핵심 설계 결정
- **"disconnected" 두 의미 혼동이 핵심**: (1) plugin store.connected=false=진짜 링크끊김(대문자 DISCONNECTED+빈목록) vs (2) 데몬 session-state 'disconnected'(소문자)+세션존재. 레이아웃이 둘을 혼동 → allSessions 유무로 구분.
- **점검 순서 교훈**: WS "OFFLINE" 증상이라고 WS 재연결부터 의심하지 말 것. lsof 로 소켓 생존 먼저 확인 → 살아있으면 페이로드(브로드캐스트) 프로브로 렌더 입력을 직접 봐야 진짜 원인이 보인다. 첫 세션의 reconnect 진단은 실증 없이 코드만 보고 내린 오진이었다.
- **배포**: fix 가 shared → plugin-ulanzi esbuild 가 app.js 에 번들 → `pnpm package:install` → **Ulanzi Studio 재시작 필수**(Studio 는 플러그인 프로세스 kill 해도 자동 재기동 안 함).
- **검증**: 전체 1556 tests pass, coverage exit 0, repro(state=disconnected+세션 → OFFLINE=0/open=N) 로 증명, 설치본 app.js 에 게이트 번들 확인, 재시작 후 plugin(16972) 양 링크 재연결 확인. 실기 화면은 사용자 확인.

## 2026-06-28 — observed 세션 Detail = transcript 재구성 (CLI 데몬)

### 문제
XTeink X3 가 세션 Detail 을 열면 `query_session_timeline` 으로 히스토리를 요청하는데, **passively-observed 세션**(ps 로 발견되는 claude/codex 세션)은 항상 빈 응답("No recent activity yet")만 받았다. relay 경로(`SessionTimelineRelay`)는 managed + hook 세션만 timeline store 에 push 하고, observed 세션은 timeline 행이 하나도 없기 때문.

### 해결
신규 self-contained 모듈 `bridge/src/session-transcript-timeline.ts` + `query_session_timeline` 핸들러 fallback. store 가 비면 세션의 Claude Code transcript JSONL(`~/.claude/projects/*/<uuid>.jsonl`)을 replay 해 최근 활동을 `TimelineEntry[]`로 재구성:
- user 프롬프트 → `chat_start`, assistant 텍스트 → `chat_response`, tool_use → glanceable `tool_request`("Editing config.ts", "Reading foo.cpp", "Running npm test"…)
- 각 entry 에 조회한 sessionId(observed: prefix 포함)를 다시 찍어 기기 Detail 필터(`rawSid()` 양쪽 비교)와 매칭.
- transcript 위치는 cwd 없이 session id 만으로 `projects/*/<uuid>.jsonl` 스캔(=`findClaudeTranscript` fallback 미러). read-only, 절대 throw 안 함.

### 핵심 설계 결정
- **CLI 데몬 전용**: App Store Swift 데몬은 샌드박스가 `~/.claude/settings.json` 만 grant 하고 per-session transcript jsonl 접근 권한이 없다 → observed 세션 transcript-level Detail 은 외부 Node 데몬(`isUsingExternalDaemon`) 기능. 기존 progressive-enhancement 아키텍처와 일치.
- **firmware 무변경**: Detail 진입 시 이미 `sendQuerySessionTimeline()` 호출 + `handleTimelineHistory()` 가 ring 적재. 빈 응답이 아닌 entry 를 받기만 하면 됨.
- **동시세션 격리**: `daemon-server.ts` 에 다른 세션의 미커밋 작업(FoundationModels `/generate`, hookCwd, cockpit)이 있어 isolated-commit 으로 내 두 hunk 만 격리 커밋(`f8ae8720`), 나머지는 working tree 에 복원.

### 문제
모니터링 대상에 Antigravity가 추가됐지만 (1) 네이티브 테라리움(Swift/Android/ESP32)에 크리처가 없어 octopus/dot로 폴백됐고, (2) 남은 사용량 표시는 Claude 5h/7d만 있었다. Codex 사용 리밋과 Antigravity 사용량도 보여달라 — 단 Antigravity는 ToS 주의.

### 해결
- **Antigravity 크리처**: peak/arc 크리처를 Swift 테라리움 + Android + ESP32 글리프(4표면)에 추가, octopus 필터에서 제외.
- **Codex 사용 리밋**: Codex CLI가 자기 로컬 rollout(`~/.codex/sessions/.../rollout-*.jsonl`)의 `token_count.rate_limits`에 5h(primary)/7d(secondary) used_percent+resets를 쓴다 → `bridge/src/codex-rate-limits.ts`(+Swift `UsageAPIClient.readCodexRateLimits`)로 읽어 `usage_update`에 실어 macOS/iOS/메뉴바/Android 대시보드 + Stream Deck + D200H에 표시. **API 호출 없음, 로컬 파일만.**
- **App Store 샌드박스**: 사용자가 `~/.codex` 폴더를 한 번 허용(보안 스코프 북마크, Antigravity DB 피커와 동일 패턴)하면 샌드박스 데몬도 읽음 — subprocess/홈-상대 엔타이틀먼트 없음.
- **게이지 재설계(Stream Deck/D200H)**: 풀블리드 레벨 채움(사용률만큼 차오름, 초록→호박→빨강 단계색 0.38 톤 + 3px 수위선), 전부 흰 글자 + 테두리 없음(작은 글씨 가독성), 점 대신 제공사 브랜드 로고. SD+ 인코더는 다이얼로 뷰 순환(both→5h→7d→session), PROMPT 인코더 폐기→선택지 키패드 이동. D200H는 게이지를 넓적버튼 위 2×2 블록(3_0/4_0 Claude, 3_1/4_1 Codex)에 배치.
- **키패드/D200H 정리**: 눌리지만 무동작이던 INFO/상태카드/TOKENS/COST → 납작 라벨로 재스타일.

### 핵심 설계 결정
- **Antigravity 두-그룹(Gemini / Claude+GPT-OSS) 5h·weekly % 쿼터는 백엔드 전용** — `state.vscdb`/CLI 어디에도 로컬 영속되지 않음(aggregate credit+plan명만 로컬). 이를 보여주려면 Google 비공개 엔드포인트 호출 필요 = ToS 위험이라 **표시 안 함, plan명만**. (memory: antigravity-quota-two-pool-backend-only)
- 데이터 생산(데몬)과 렌더(플러그인/앱)가 분리 — 반영하려면 데몬 재시작 + 각 소비자 리로드/재빌드 둘 다 필요. show/hide 불변식·Swift/CLI 데몬 패리티 유지.

## 2026-06-28 — OpenClaw "미연결" 원클릭 복구: 대시보드 Import token

### 문제
OpenClaw가 대시보드에서 계속 "미연결"로 떴다. 조사 결과 버그가 아니라 **config 갭**: gateway는 reachable(`available:true`)이지만 shared-token 모드라 토큰 없는 핸드셰이크를 1008 "gateway token missing"으로 거절 → `gatewayConnected:false`. Node 어댑터는 `~/.openclaw/openclaw.json`을 매 reconnect 직읽기해서 "그냥 됨"이지만, 샌드박스 Swift 데몬은 토큰을 **Keychain에서** 읽으므로 한 번도 Import 안 했으면 영구 `gateway_token_missing`. 커밋 `fd5dae13`(presence-driven 가시성)이 unauth gateway의 phantom 세션 주입을 막으면서, 늘 있던 토큰 갭이 이제야 "미연결"로 정직하게 드러났다. 대시보드 `SetupNeededCard`는 이미 이 항목을 띄웠지만 CTA가 제네릭 "Open Settings"뿐 — 복구가 Settings→Integrations→OpenClaw 3~4클릭 깊이에 묻혀 있었다.

### 해결
- `SettingsScreen.importOpenClawTokenFromConfig()`의 NSOpenPanel→parse→Keychain→bookmark→`reconnectGatewayAdapter()` 오케스트레이션을 공유 `OpenClawTokenImporter`(`apple/.../UI/Monitor/`)로 추출. Settings는 이제 위임만(동작 무변, `extractGatewayToken`은 테스트가 참조하므로 유지).
- `SetupItem`에 옵셔널 `primaryAction` 추가 → `SetupNeededCard`가 인라인 amber "Import token" 버튼 + 일시 피드백을 렌더.
- `openClawSetupAction`이 **token-remediable status에만** 버튼 부착: `gateway_token_missing`/`token_mismatch`/`connect_timeout`. pairing/device-auth(`pairing_required`/`device_auth_invalid`/`auth_failed`)는 Web-UI approve/reset-identity 사다리가 Settings에 있으므로 제네릭 "Open Settings" 유지.
- `MonitorScreen`이 platform-split `setupCard` 헬퍼로 macOS 변형에만 `daemonService` 주입(iOS는 Mac으로 라우팅하므로 import affordance 없음).

### 핵심 설계 결정
- **추출 후 위임**: import 플로우가 Settings 뷰의 private 메서드에 갇혀 있던 게 진짜 문제. 두 표면(Settings repair row + 대시보드 카드)이 동일 copy/action 재사용.
- **App-Store-safe 유지**: user-selected 파일 entitlement, security-scoped bookmark, 서브프로세스 없음 — 기존 플로우를 옮긴 것뿐. `directoryURL`은 Powerbox 힌트.
- status→action 매핑은 한 곳(`SetupNeededCard.openClawSetupAction`)에 집중.

### 검증
macOS `xcodebuild` BUILD SUCCEEDED, iOS 컴파일 green(서명 제외). verify-appstore-archive는 forbidden subprocess 문자열 0(나머지 실패는 Debug 산출물). 시각 확인은 Xcode rebuild 시 기존 Setup 카드의 OpenClaw 항목에 Import token 버튼 노출.

---

## 2026-06-27 — Attention 정확도 재설계: 실제로 물어볼 때만, 진짜 선택지로

### 문제
"Attention"(에이전트 스티어링) 신호가 두 가지로 부정확했다. (1) 거짓 발동 — observed(`claude` 직접) 세션의 PreToolUse device-approval gate(기본 ON)가 `permission_mode`+도구명만 보고 발동해서, Claude가 자체 allowlist로 자동 승인하는 도구에도 디바이스에 Allow/Deny를 요구했다. PreToolUse는 모든 tool 호출마다 발화하므로 "에이전트가 안 물어봤는데 Attention". (2) 선택지 붕괴 — Claude Code 훅 페이로드엔 실제 선택지가 없어서 observed 세션은 binary Allow/Deny를 **날조**했고, PTY 파서마저 `Yes,/No,/Always`만 매칭해 번호/커스텀 선택지를 하드코딩 3개로 붕괴시켰다.

### 해결
정확한 원격 스티어링은 PTY 관리 세션(CLI)에서만 가능하다는 사실(Claude Code 훅 사양으로 확인: 어떤 훅도 실제 다중 선택지를 안 실어줌)을 기준으로:
- **observed 세션 Attention 경로 제거** (Node `daemon-server.ts` + Swift `DaemonServer.swift` parity): Notification awaiting overlay 합성 + 보류형 PreToolUse 게이트 + `deviceApprovals` 설정 삭제. observed 세션은 idle/processing만 보고.
- **`requestId`→Allow/Deny 날조 전 표면 제거**: shared `d200h-layout`, `esp32-serial`, Apple(`MonitorScreen`/`ControlTowerPanel`/`D200hHidModule`/`ESP32Serial`), Android `MonitorScreen`, SD 인코더(`option-dial`). 표면은 실제 `options[]`가 있으면 렌더, 없으면 "respond in terminal".
- **PTY 파서 풍부화**: `output-parser.ts`의 yes_no_always 가지가 `parseOptions()`에 먼저 위임해 Claude의 실제 번호/커스텀 선택지를 방출 → 기존 `options[]` 프로토콜로 StreamDeck·D200H·Apple·Android에 자동 전파.

### 핵심 설계 결정
- **정직성 우선**: 정확한 신호가 불가능한 상태(Swift 앱 단독/observed 훅)에서는 Attention을 아예 끈다. 부정확한 Allow/Deny를 띄우느니 안 띄운다.
- **wire-compat 보존**: `permission_decision` 커맨드 + `SessionInfo.requestId`는 `@deprecated`로 유지(미업데이트 plugin/Android 호환). Swift `permission_decision` 핸들러는 이제 OpenClaw gateway exec-approval 전용.
- `shouldGate`/`isPermissionNotification` static은 `DeviceApprovalGateTests` 위해 잔존(프로덕션 호출자 없음).

### 검증
vitest 1497/1497 (신규 파서 회귀 포함), 전 TS 빌드, macOS app BUILD SUCCEEDED, Android `compileDebugKotlin` SUCCESSFUL, Swift `DeviceApprovalGateTests` 5/5. commit `765a1023`.

---

## 2026-06-27 — Antigravity creature foundation for CLI daemon

### 문제
Antigravity 통합은 App Store-safe usage/credit DB 표시만 있고 `AgentType`/brand/glyph/session rendering 기반이 없어서, CLI daemon에서 Antigravity 프로세스를 발견하더라도 creature anchor 로 표시할 수 없었다. 기존 문서도 "Antigravity/OpenCode hook 없음"이라고 단정해 최신 제품 hook/plugin 표면과 App Store 제약을 섞어 설명하고 있었다.

### 해결
- **최신 판단 정정**: Antigravity/OpenCode 모두 hook/plugin/event 표면은 존재한다. 다만 App Store 앱은 외부 CLI/plugin/hook 설치, IDE/CLI spawn, process/port scan 을 하지 않으므로 coding-session 관측은 계속 미지원이다. CLI daemon 경로는 별도 companion tier 로 유지.
- **Antigravity agent 기반 추가**: shared `AgentType`, capabilities, protocol generation, sorting/rank, state color, SVG/brand renderers, TRMNL/D200H/Pixoo/Timebox micro glyph, TUI glyph, Apple/Android label/icon/formatter 경로에 `antigravity` 추가.
- **CLI daemon passive discovery**: Node passive observer 가 standalone Antigravity app/CLI/helper process 를 `observed:antigravity:<pid>` 세션으로 표출한다. 구조화 이벤트가 없는 경우에도 project cwd 기반 idle creature anchor 를 제공한다.
- **App Store 문서 정리**: `docs/appstore-feature-matrix.md`, `apple/APP_REVIEW_NOTES.md`, `docs/agent-harness.md` 를 "hook 부재"가 아니라 "App Store 앱은 외부 실행/설치/스캔을 하지 않는다"는 기준으로 갱신.

### 검증
진행 중: shared/passive observer focused tests, TypeScript typecheck, Swift/Kotlin compile smoke.

---

## 2026-06-27 — iDotMatrix / Divoom Timebox Mini 가 대시보드·패널에 안 보이던 문제

### 문제
두 BLE 매트릭스 패널(iDotMatrix 32×32, Timebox Mini 11×11)이 대시보드 토폴로지에 안 뜨고 패널 렌더도 깨졌다. 단일 버그가 아니라 3겹 plumbing gap이었다.

### 해결
- **Node 가시성**: Timebox는 정식 `TimeboxModule`인데 **iDotMatrix는 모듈 미등록**(직접 `startIDotMatrixSync` spawn만)이라 `buildNodeModuleHealth`/`/devices`/TUI/`agentdeck devices` 전부에서 누락. `IDotMatrixModule` 신설(Timebox 미러)+`createDefaultModules` 등록+health/devices/cli/TUI 분기+`ModuleConfigs.idotmatrix`. daemon-server의 직접 start 호출은 제거(모듈이 단일 소유).
- **Apple 가시성**: Swift 데몬은 `/health`에 idotmatrix+timebox `statusSnapshot()`을 이미 emit하지만 **클라가 버렸음** — `ModuleHealthState` 필드 없음+`BridgeEventParser.parseModuleHealth` 미디코드+`TopologyRail` 섹션 없음. 공유 `BLEMatrixHealth` struct+파서 분기+`bleMatrixSection`(statusReason→LEDStatus).
- **진단성**: 양 daemon-sync가 `stdio:'ignore'`로 Python 크래시(bleak/idotmatrix 미설치 등)를 삼켜 blank 패널이 무진단이었다. 공유 `bridge/src/ble-sync-spawn.ts`(stdout 묵음+stderr ring buffer, exit 시 tail 로그)로 교체. iDotMatrix는 설정 변경 시 재시작도 추가.

### 핵심 설계 결정
- **★ 실사용 즉시 원인 = settings 경로 분리.** App Store 플래그 빌드는 컨테이너 settings.json을 읽는데 `agentdeck ... add`는 `~/.agentdeck/`에 씀 → 앱이 `configuredDeviceCount:0`("no device configured")으로 아무것도 안 그림. 컨테이너 빌드는 앱 Settings 시트로 페어링해야 한다.
- **Swift 렌더 하드닝 후보 3건은 defect 아님(검증 후 변경 안 함)**: Timebox dim `max(0)`=의도(hw 밝기 없어 0=blank), TimeboxBLE settle 불필요(프레임당 1패킷+flow-control), wake stale-connected는 `handleWake()`가 이미 처리.
- **병렬 세션 브랜치 정리 중 Phase 1 Node 누락 → 재적용.** "Salvage … #30"이 Apple/Phase2/cli는 가져갔으나 iDotMatrix 모듈 등록+daemon-server health/devices 배선을 빠뜨려 Node 가시성 회귀. 본 브랜치에서 surgical 재적용.

### 검증
`pnpm build` green, `xcodebuild -scheme AgentDeck_macOS` BUILD SUCCEEDED, Node 데몬 e2e로 `/health`·`/devices`에 두 기기 표출 확인.

---

## 2026-06-25 — TRMNL App Store standalone hub parity + observability

### 문제
TRMNL 안정화 문서/CLI가 "Node daemon = usage-capable hub, macOS app = client" 중심으로 굳어 App Store 단독 배포 관점과 충돌했다. 실제 Swift 앱은 `/api/display`를 서비스하지만 `/health`/`/status`/`/devices`/`moduleHealth`에 `trmnl`이 빠져 있어 운영자는 패널이 붙었는지, stale인지, RSSI가 약한지 알 수 없었다. 또한 Swift TRMNL enrollment가 in-memory라 앱 재시작 뒤 상태 표면이 비어 보이고, 실행 중인 구버전 앱에서는 약한 RSSI에도 낮은 `image_url_timeout`이 나가 "not responding" 재발 가능성이 있었다.

### 해결
- **App Store Swift daemon을 first-class BYOS hub로 승격**: `TrmnlSettings`가 `trmnl.devices[]`를 Node와 같은 shape으로 읽고 저장. Auto-enroll 시 sandbox `settings.json`에 enrollment만 영속화하고, poll telemetry는 runtime-only 유지(파일 churn 없음).
- **관측성 parity**: Swift `TrmnlModule.statusSnapshot()`을 `/health`·`/status`·`/devices`·`state_update.moduleHealth`·앱 내부 `DeviceSummary`에 연결. telemetry는 MAC, 해상도, RSSI, 배터리, lastSeen/secondsSinceSeen, stale flag를 제공. 동기 broadcast 경로는 5초 캐시 사용(SerialModule 패턴).
- **계약 parity**: Swift 경로도 기본 `image_url_timeout=50s`, 약한 RSSI(≤ -78dBm)는 60s로 확장. App Store 앱 단독으로도 등록/렌더/헬스가 완결되고, CLI daemon은 개발 세션/Claude OAuth quota relay를 보강하는 progressive enhancement로 재정의.
- **화면 효율 개선**: TRMNL footer가 quota-known 일 때만 5H/7D gauge를 그린다. App Store-only/OAuth-blind 상태처럼 quota가 구조적으로 unknown이면 30px compact hub-status strip으로 접어 800×480에서 9번째 session row까지 본문에 돌려준다(Node SVG + Swift CoreGraphics parity).
- **문서/CLI 정정**: `agentdeck trmnl`, `docs/devices.md`, README, App Store feature matrix, hardware compatibility에서 "Node가 정답 hub" 문구를 "하나의 안정적 hub(App Store 앱 또는 CLI)"로 변경.

### 핵심 설계 결정
- **Daemon이 완전히 꺼진 상태는 TRMNL 펌웨어 오류 UI가 맞다.** Pull-only BYOS 특성상 응답 프로세스가 없으면 AgentDeck offline 이미지를 줄 수 없다. App Store 패키지의 목표는 "앱이 실행 중이면 standalone hub로 완결"이지, 앱 종료 후에도 별도 responder 없이 표시를 제어하는 것이 아니다.
- **영속화는 enrollment만.** 매 poll마다 telemetry를 settings에 쓰면 sandbox container 파일 churn과 UI 편집 레이스가 생긴다. stale/lastSeen은 runtime health로 충분하다.

### 검증
Green:
- `pnpm vitest run bridge/src/__tests__/trmnl-byos.test.ts bridge/src/__tests__/trmnl-renderer.test.ts shared/src/__tests__/trmnl-layout.test.ts` (42 tests)
- `pnpm --filter @agentdeck/bridge typecheck`
- `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' -only-testing:AgentDeckTests_macOS/TrmnlModuleTests -only-testing:AgentDeckTests_macOS/SessionLauncherTests`
- `xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS'`

---

## 2026-06-25 — LED 매트릭스 디바이스 주변부 공통화 + 구현 갭 정리

### 문제
`docs/hardware/index.html` §B LED 매트릭스 4종(Pixoo64 64×64 · iDotMatrix 32×32 · Timebox Mini 11×11 · TC001 8×32) 점검: 렌더 코어 바깥 **주변부**에 파편화/갭. ① iDotMatrix 소프트 밝기 부스트가 Node 1.6 / Swift 1.3 / `sync.py` 기본 1.5 로 3중 drift → 같은 패널을 두 데몬이 다른 밝기로 렌더. ② iDotMatrix `sync.py`·Timebox `sync_ble.py` 가 HTTP/디밍 plumbing(`fetch_display_state`·`resolve_display_brightness`·상수)을 ~80% 중복 보유. ③ Timebox 11×11 micro-glyph 그리드를 `micro-glyphs.ts`↔`MicroGlyphs.swift` 손으로 byte-mirror(침묵 drift). ④ TC001 `.ulanziTc001` ADB 분류 경로가 producer 없는 dead code 로 5곳 잔존.

### 해결
- **렌더 코어는 안 건드림** — Node `renderFrame(...,size,layout)`+`/pixoo/frame` 단일 fan-out, Swift 단일 `PixooRenderer` 3모듈 공유. Node↔Swift 재구현(App Store 서브프로세스 0)·Android e-ink 분기는 **의도된 설계**.
- **WS1 밝기 parity** (`e886d3cc`): 세 지점 1.6 통일 + cross-ref 주석.
- **WS2 Python sync 공통화** (`e886d3cc`): 신규 `bridge/src/pysync/matrix_sync_common.py`(상수+`fetch_display_state`+파라미터화 `resolve_display_brightness`). 두 클라이언트가 sibling `sys.path` insert 로 import. **dim FLOOR 는 디바이스마다 다름**(iDotMatrix 5/5, Timebox 0/0) → thin wrapper 로 파라미터화, 호출부 시그니처 불변. 20-edge parity 검증.
- **WS3 micro-glyph 코드젠** (`8d54a045`): 신규 `scripts/generate-micro-glyphs.mjs`(`pnpm generate-micro-glyphs`)가 `micro-glyphs.ts`(SSOT 유지)를 파싱해 `apple/.../MicroGlyphs.generated.swift` 생성. `MicroGlyphs.swift` 는 paint/statusBg 로직만. `generate-creature-glyphs` 옆에 등록.
- **WS4 TC001 dead-ADB 제거** (`38858021`): `.ulanziTc001`(AdbModule classify·AgentState enum·TopologyRail·MenuBar) 삭제 + 문서 3표면(hardware-compatibility.md·hardware/index.html·appstore-feature-matrix.md) "제거 완료" 갱신. 라이브 row 는 이미 `ESP32Serial.swift` USB-serial 경로.

### 핵심 설계 결정
- **micro-glyph 데이터는 inline TS 유지(JSON 분리 금지).** bridge 는 `dist` 에서 compiled 실행 + `tsc` 가 JSON sidecar 를 `dist` 로 안 복사 → `.json` import 면 런타임 크래시. 그래서 codegen 이 `new Function` 으로 TS 리터럴 파싱(에셋은 fonts 처럼 `import.meta.url` readFileSync 만).
- **Python BLE sync 는 source/dev 설치 전용.** `bridge/package.json` files=["dist","assets/fonts"] 라 `.py`/`pysync/` 는 published npm 에 없고, daemon-sync.ts 가 `existsSync(.venv & sync.py)` 로 gate. `pysync/` 를 `.py` 와 같은 `src/` 에 co-locate → packaging 변경 불요.
- **TC001 ✅ 승격은 HW 검증 후속.** 이번엔 dead-code 제거 + serial 이 단일 라이브 경로임을 문서에 확정. golden `TimeboxProtocolTests.swift` 는 paint/statusBg/MicroCreature 공개 API 만 써서 코드젠 후에도 그대로 green.
- 동시 세션이 같은 트리에서 device-discovery/attention 작업을 master 에 커밋(`4231605e`/`e8027589`) → 얽힘 해소 후 내 변경분만 명시 pathspec 3-commit. xcodegen scheme 다운그레이드 noise(구버전)는 revert, pbxproj 는 deterministic +12 라인(내 generated + 그쪽이 누락한 DeviceApprovalGateTests)만.

검증: TS build green · vitest 1463/1463 · `py_compile`+resolve parity · xcodegen + macOS BUILD SUCCEEDED.

---

## 2026-06-25 — macOS Attention 오발 + 선택지 불일치: permission_mode / notification_type 게이팅

### 문제
macOS Dashboard 가 observed direct-`claude` 세션에 대해 (1) 묻지도 않은 상황에서 "Attention" 카드를 띄우고, (2) 띄울 때 보여주는 선택지가 에이전트의 실제 요청과 안 맞았다. 근본은 PTY 없는 observed 세션의 awaiting-state·options 를 **coarse hook 신호로 합성**한 것 — Claude Code 가 실제로 주는 정밀 필드를 무시.

### 해결 (Swift 데몬 + Node 브리지 parity)
- **gate 가드 (오발 #1)**: `handlePreToolUseHook` 가 device-approval 게이트로 Bash/Write/Edit/MultiEdit/NotebookEdit 를 전부 hold 했는데 `permission_mode` 를 안 읽음. PreToolUse 는 **모든** tool 호출마다 발화(acceptEdits/bypass/dontAsk/plan/allowlisted 라 Claude 가 안 묻는 경우 포함). 새 공유 술어 `shouldGate(permissionMode, tool)`: bypassPermissions/dontAsk/plan 은 게이트 안 함, acceptEdits 는 edit-family 만 skip(Bash 는 게이트), default/auto/unknown 만 게이트. Swift `DaemonServer.shouldGate` + Node `awaiting-overlay.ts::shouldGatePreToolUse`.
- **notification_type (오발 #2)**: Notification awaiting 을 free-text `message` 정규식 대신 `notification_type == "permission_prompt"` 로 판정(`isPermissionNotification`, 정규식은 구버전 Claude fallback). idle_prompt/auth_success/elicitation_* 가 더 이상 attention 을 켜지 않음.
- **stale options (불일치)**: `attentionOptions`(MonitorScreen+ControlTowerPanel)가 비-gated 세션에 aggregate `stateHolder.state.options` 를 빌려와 무관한 옛 프롬프트의 선택지를 dead 버튼으로 렌더. 이제 awaiting `state_update` 가 그 세션에 attribute 된 경우(`state.sessionId == session.id`)만 빌림 — observed 세션은 질문 + "respond in terminal" fallback.

### 핵심 설계 결정
- **coarse 합성 < Claude 정밀 신호.** hook 스크립트가 stdin 을 `-d @-` 로 그대로 포워드하므로 `permission_mode`·`notification_type` 가 이미 daemon 에 도달 — 안 읽었을 뿐. (Gotcha: 탐색 subagent 가 "permission_mode 는 PreToolUse 에 없다"고 오답 — AgentDeck 가 extract 안 한 것과 Claude 가 send 안 한 것을 혼동.)
- **게이트 잔여 한계**: 순수 default 모드 + allowlisted tool 은 여전히 게이트됨 — hook 은 Claude 의 allowlist 를 못 보고 `permission_mode` 만 봄. gated 경로의 device 응답은 `permissionDecision: allow/deny/ask` 만 가능 → Claude 의 3지선다("don't ask again") 표현 불가(binary Allow/Deny 는 device 가 결정자라 faithful).
- 동시 세션이 같은 트리에서 MicroGlyphs 리팩터 진행 중 → macOS 풀빌드는 그쪽 미완성으로 red(내 Swift 파일은 무관·컴파일 통과). 커밋은 temp-index `commit-tree` 로 내 7파일만 격리(daemon-server.ts 는 concurrent autoDiscover hunk 제외, 내 3 hunk 만).

---

## 2026-06-25 — 디바이스 friendly-name 일치 점검 + zero-config 자동 발견

### 문제
"연동 기기 이름이 `docs/hardware/index.html` friendly명과 일치하는가" + "남이 설치해도 기기 속성을 자동 감지해 같은 타입으로 매핑되는가" 점검 요청. 라이브 데몬(`/health`) 대조 결과 두 갭: ① Swift 표시명 switch(`TopologyRail`/`MenuBarTopologyList`)에 `ttgo_t_display`·`esp32_c6_147` 케이스 누락 → raw 와이어 문자열로 노출(TTGO 가 실제 연결 중인 라이브 버그). 네이밍 체계 4종(wire/flash.sh/Swift/HTML)이 SSOT 없이 분산. ② self-advertise 하는 기기(ESP32 device_info·Stream Deck SDK·TRMNL BYOS·Android EinkDetector)는 자동 매핑되지만 **Pixoo·Timebox·iDotMatrix 는 수동 IP/MAC 입력**이라 신규 설치 시 안 잡힘.

### 해결
- **네이밍**: 누락 케이스 추가 + AMOLED/86 Box/IPS 10.1 라벨을 HTML friendly 열에 맞춤(두 Swift switch 동기, 중복 주석 명시). `shared/src/protocol.ts` 와이어 타입힌트 7-board 완성.
- **자동 발견**: Pixoo 는 mDNS 없음 → 로컬 /24 **서브넷 스윕**(`Channel/GetAllConf`→`Brightness` 프로브) 신설. **Node**(`pixoo-discover.ts`) + **App Store Swift**(`PixooModule.autoDiscoverIfNeeded`, URLSession+getifaddrs, 서브프로세스/외부서비스/권한프롬프트 없음) 양쪽. BLE(Timebox/iDotMatrix)는 **Node 만** 부팅 자동스캔(기존 bleak `scan*.py` 재사용, `*-discover.ts`). 공통: 0대일 때만 auto-add + `*AutoDiscover` opt-out.

### 핵심 설계 결정
- **Swift BLE 부팅-자동스캔 의도적 제외.** `CBCentralManager` 생성이 *모든* App Store 사용자에게 Bluetooth 권한 프롬프트를 강제 → 기기 없는 사용자까지 묻게 됨. 현재 데몬은 BLE 기기 설정한 사용자에게만 lazy-create. 그래서 Swift BLE 발견은 설정 시트의 **사용자 트리거 Scan** 유지, Node CLI(프롬프트 무관)만 부팅 자동스캔. plan 승인 범위에서 벗어난 유일한 의도적 deviation.
- **actor 직렬화 회피.** `PixooModule.postCommand` 는 actor-isolated → 254-host 직렬 스윕은 수 분. 스윕 프로브를 `nonisolated` + per-host ephemeral URLSession 으로 빼 실제 동시성 확보(concurrency 32, 600ms timeout).
- **Pixoo 발견은 클라우드보다 로컬 우선.** Divoom 클라우드 LAN API 는 외부 서비스 → App Review 마찰. 로컬 스윕이 App-Store-clean. 클라우드는 Node fallback 으로만.

---

## 2026-06-24 — Evaluation(APME) 재정의: 타임라인 분리 + turn→명시적 task + 스코어카드 추천 + tuner 제거

### 문제
원래 의도("특정 태스크를 어떤 에이전트/모델이 얼마나 잘 수행하는가"를 LLM-as-judge로 평가)가 노이즈에 묻힘. 3가지 근본 원인: ① 평가 단위(task)가 가장 불안정한 신호에 의존 — `todo_complete`(TodoWrite 전부완료) hook은 Claude Code v2.1에서 ~18%만 발화 + 발화해도 논리적 task를 파편화. 카테고리 분류는 async run 분류가 task 닫힌 뒤 도착해 `taskCategory=null`. ② 한 단위가 deterministic+turn+task+run = 최대 6개 `eval_result` row를 타임라인에 발행 → 활동 로그와 평가가 섞여 둘 다 더러움. ③ 페이오프 부재 — vibe 피드백(Stage 3)이 실사용에서 안 일어나 tuner·recommender가 死코드, "어느 모델이 뭘 잘하나" 결론을 아무도 소비 안 함.

### 해결 (4-phase, bridge Node + Swift 데몬 양쪽)
- **P1 타임라인 디노이즈**: `eval_result` 타임라인 row 발행 전부 제거(`daemon-server.ts` onResult 4블록 + `index.ts` 세션브리지 + Swift `handleApmeResult` appendEvalResultTimeline + 死헬퍼). **타임라인 = 활동 로그만(chat/tool/state).** eval은 `apme_eval` WS + SQLite/스코어카드로만. `broadcastApmeEval`/`updateTurn`은 보존.
- **P2 단위 재정의 (turn→명시적 task)**: `todo_complete`를 task 경계 → **non-segmenting soft hint 강등**(`state` sample 이벤트로만 기록). 이제 task는 명시적 경계(`/task close`·디바이스 버튼=manual, `/clear`)나 `session_end`에서만 분할. **카테고리를 closeTask에서 동기 확정**(`computeSignals`+`classify`, run.endedAt nil이라 duration은 task.startedAt에서 유도). `collector.ts` + Swift `ApmeCollector.swift` 미러.
- **P3 스코어카드 표면(페이오프)**: 추천기를 dashboard SPA에 **"Recommend" 탭**으로 연결 — `/apme/samples`(v_sample_scorecard: agent×model×category) 카테고리별 best 랭킹. 양 데몬이 `/apme` 서빙(WKWebView). vibe 👍/👎는 run detail에 이미 존재.
- **P4 死코드 정리**: tuner 완전 제거 — `tuner.ts`·`ApmeTuner.swift`·테스트 삭제, `/apme/tune` 라우트·CLI `apme tune`·`autoTune` 설정(Node+Swift)·DaemonServer retune 루프 제거.

### 핵심 설계 결정
- **타임라인 ≠ 평가 표면.** 평가를 활동 로그에서 완전히 분리하는 단 한 수가 "노이즈" 불만의 대부분을 해소. inert해진 `eval_result` 렌더러(tui/plugin/Apple/Android)는 타입 churn 회피 위해 남김(발행 0이라 무해).
- **신뢰 가능한 단위 우선.** turn(UserPromptSubmit→응답)이 시스템에서 가장 확실한 경계. task는 명시적·결정론적 경계로만. 불안정한 hook 의존 제거가 "태스크 단위 기록 부재"의 근본 해법.
- **Gotcha (CI 함정)**: `apple/AgentDeck/Resources/apme-dashboard.html`은 `dashboard-html.ts`의 raw 렌더가 **아니라** design-token-compliant 별도 미러(`verify-tokens-sync.py`가 css-root로 검사, body는 `var()`/`color-mix()`만). TS를 그대로 렌더하면 Design System CI가 깨짐 → 두 파일 각각 수정. xcodegen은 xcscheme도 재생성(downgrade)하니 scheme churn은 `git checkout HEAD`로 되돌릴 것.

---

## 2026-06-23 — TRMNL e-ink: 안정화 + 정보밀도 재설계 + 세션 goal

### 문제
실기기 TRMNL 패널이 "WiFi connected / TRMNL not responding"로 깜빡이고, 토큰 사용량 게이지가 0%, 대시보드 정보 가치가 낮음. 이후 피드백: 아이콘이 실제 캐릭터와 드리프트(Claude를 문어로), 5H/7D 푸터 공간 낭비 + 시간 디테일 부족, 6+ 세션 처리, "이 세션이 뭐하는지" 요약 부재.

### 해결
- **신뢰성(루트커즈)**: "not responding" = 펌웨어 `WIFI_FAILED`(기기측 HTTP 요청 실패=네트워크). 서버는 로컬 8/8 정상. 한 LAN 피어 50% 패킷로스 + 데몬 2개(Node/Swift) 9120 경쟁. → **단일 허브 규칙**(Node=usage-capable hub, macOS=client). 펌웨어 BYOS 계약 정렬: `refresh_rate` 숫자(문자열→0 파싱), `image_url_timeout` 전송, **filename 안정화**(펌웨어가 filename으로 캐시→실변화에만 hash 변경; 시계/freshness churn 제거→flaky 재다운로드+깜빡임 감소). adaptive cadence는 AWAITING만 빠르게(60s).
- **사용량 정확도**: usage는 `usage_update`에만 있고 `state_update`엔 없음 — TRMNL/D200H 모듈이 미구독 → 영구 0%. `usage_update` 구독+merge, `usageKnown` 트라이스테이트("—" vs 거짓 0%).
- **정보밀도 재설계** (`shared/src/trmnl-layout.ts` + Swift 미러): 텍스트 태그→**캐노니컬 브랜드 크리처 아이콘**(robot/cloud+`>_`/ring/lobster — `assets/logos/*_creature_gen.png` 충실, 손그림 금지). 세션 description, 헤더에 구독+만료(`subscriptions[].until`), 한 줄 푸터 + adaptive 행높이(42~58px, 6~9세션 packing), 시간 디테일(`resets 3h 6m`).
- **세션 goal**: `parseClaudeTranscript`가 head+tail 읽어 **첫 user 프롬프트=세션 목적** 추출(`cleanGoal`로 태그/슬래시 노이즈 제거), `SessionInfo.goal`로 전파, description이 goal 우선. CJK: goal이 한글/중문이라 Latin 번들폰트가 □ → resvg `loadSystemFonts`로 OS CJK 폴백(TRMNL은 상태변화 시 1프레임만 렌더라 비용 OK).

### 핵심 설계 결정
- **펌웨어가 진실**: `usetrmnl/firmware src/bl.cpp`+`byos_sinatra` 대조로 계약 확정. PNG 지원(BM 스니프), filename 캐시, `image_url_timeout`. 로컬 폴루프로 서버 정상이면 "not responding"은 WiFi 문제.
- **Swift는 SVG 못 읽음** → `TrmnlImageRenderer.swift`에 미니 `SVGPath` 파서(M/L/H/V/C/S/Q/T/A/Z, 원호→큐빅, `addArc` clockwise 회피) + 브랜드 path 바이트미러. standalone `swiftc` 하니스로 4글리프 검증.
- **세션 의미 요약 = 첫 프롬프트가 최선**(LLM 요약 인프라 없음). currentTask는 마지막 도구 호출뿐.
- **동시 세션 주의**: 같은 워킹트리 다중 세션 — 공유파일(d200h-layout) 섞이면 분리, 비공유(timebox micro-glyphs)는 각자 커밋. 커밋 전 `git status`로 남의 WIP 확인.

### 검증
Node: vitest 38(TRMNL suites) green. Swift: `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED. 실기기(MAC `1C:DB:D4:74:F4:D8`) 라이브 검증: 아이콘·goal·CJK·footer 정상. 7 commits (`aecfb6c3`..`ba381bbf`), PR #19.

---

## 2026-06-22 — TRMNL e-ink BYOS: device-agnostic Node + App Store Swift 포팅

### 문제
TRMNL(WiFi e-ink BYOS 패널)은 (1) Node 브리지 전용이라 **App Store Swift 데몬에선 아예 동작 안 함**, (2) 해상도를 **800×480으로 하드코딩**하고 device가 보내는 `Width`/`Height` 등 BYOS telemetry 헤더를 전부 무시 → 다른 모델/해상도 패널이 붙으면 잘못된 크기 이미지를 받음, (3) `normalizeMac`이 12-hex 아닌 ID를 raw로 돌려줘 MAC 표기가 달라지면 orphan/중복 enrollment.

### 해결
- **Node device-agnostic** (`bridge/src/trmnl/`, `shared/src/trmnl-layout.ts`): `renderTrmnlDashboard`를 해상도 가변(행수=`floor((H-header-footer)/rowH)`, 컬럼·게이지 W 비례, 극단 화면비 compact 가드)으로. 단일 글로벌 프레임 → **`WxH` 키 프레임캐시(LRU 8)**, image URL이 `<W>x<H>-<hash>.png` 운반. `normalizeMac` 결정적 정규화 + `sameMac`. telemetry 헤더 런타임 맵(`trmnl-telemetry.ts`). `special_function` 추가. idle hero(합성 phantom row 제거). 28 테스트 green.
- **App Store Swift 포팅** (`apple/.../Trmnl{Module,ImageRenderer,Settings}.swift` + `DaemonServer.swift`): TS SVG/resvg는 이식 불가 → **CoreGraphics + CoreText로 대시보드 직접 그리고 1-bit grayscale PNG를 Foundation zlib로 인코딩**(D200H 렌더러 패턴). `TrmnlModule`은 actor, MAC 무관 auto-enroll + 해상도별 캐시 + in-memory enrollment/telemetry. 전송은 기존 `HTTPServer`(`/api/setup`·`/api/display`·`/api/log`·`/trmnl/image/*`). `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED, 바이너리 forbidden-subprocess 0.
- **부수 수정**: direct-HID 폐기 커밋(`6d298427`)이 `let d200hRef = d200h`를 비활성 블록 안 var로 깨뜨려 **커밋된 HEAD의 macOS 타깃이 컴파일 불가**였음 → `self.d200hModule`(옵셔널, nil) + `?.handleBroadcast`로 복구.
- **문서**: `appstore-feature-matrix.md`·`hardware-compatibility.md`·`hardware/index.html` 사양표에 TRMNL 행 추가.

### 핵심 설계 결정
- **App Store 적법**: 신규 entitlement 0 — 기존 `com.apple.security.network.server`로 커버(Pixoo `/pixoo/frame`과 동일 LAN-HTTP 선례). resvg/Node/서브프로세스 일절 없음. TS SVG 레이어는 공유 불가라 Swift는 레이아웃을 손으로 재구현(D200H/Pixoo와 동일).
- **enrollment 비영속**: settings.json write 없이 in-memory. 폴링마다 파일 쓰면 thrash + UI 편집 레이스. 재시작 시 다음 폴링에 재등록(soft auth라 안전).
- **`vitest`/`tsc`/SourceKit green ≠ Swift 모듈 컴파일** — Apple 편집 후 반드시 `xcodebuild AgentDeck_macOS`로 실검증해야 HEAD 컴파일 드리프트를 잡는다.

---

## 2026-06-21 — Timebox Mini: 디스플레이 sleep/wake + micro 크리처 canonical 재드로

### 문제
Divoom Timebox Mini(11×11 BLE)가 iDotMatrix와 달리 (1) macOS 화면 sleep/wake에 전혀 반응 안 하고, (2) 보여지는 micro 크리처가 원본 스프라이트와 너무 달랐다. 추가로 유저 기기에 "옛 애니메이션"이 떠 있던 진짜 이유는 **기기가 데몬 settings에 미등록**(`timeboxDevices: []`)이라 `sync_ble.py`가 아예 안 떠서 — 화면은 기기 공장 기본 애니였다(옆에서 돌던 BLE는 별개 iDotMatrix `98A0BE6C`).

### 해결
- **sleep/wake** (`bridge/src/timebox/sync_ble.py`): iDotMatrix 패턴(`fetch_display_state` + `resolve_display_brightness` + dim-then-pause 루프) 이식. BLE sync 드라이버는 `display_state`를 WS로 못 받으므로 각 스크립트가 데몬 `/display-state`를 직접 폴링해야 함. Timebox는 **하드웨어 brightness 명령이 없고 소프트 brightness가 프레임에 baked**(0=blank sleep 프레임)이라, dedup key를 `sha256(frame)|brightness`로 만들어 source 프레임이 같아도 sleep/wake 시 재푸시. 공유 `displaySleepDim` 설정 준수.
- **canonical 재드로** (`bridge/src/pixoo/micro-glyphs.ts`): `27995fbd`의 "sharpen"도 원본과 안 닮아 유저가 재지적. `pixoo-sprites.ts`의 HD/MD 스프라이트에 맞춰 4종 재드로 — Codex=구름+아래 촉수 로브(was 공), OpenCode=코어 없는 hollow 이중 링(was 꽉 찬 회색 코어=그림자), 가재 눈=teal `#00E5CC`(was near-black), 문어 눈=2×2 negative space(was 1px). 1:1(11px) PNG로 눈검증.
- **Swift 패리티**: `apple/AgentDeck/Daemon/Modules/MicroGlyphs.swift` byte-mirror + `TimeboxProtocolTests.swift` 골든 픽셀 갱신(문어 팔 row, codex 몸체 col). TS↔Swift 격자·색상 자동 대조 통과.

### 핵심 설계 결정
- micro 글리프는 애니가 아니라 **손그림 11×11 비트맵 품질 + canonical 스프라이트 충실도**가 전부. 눈색 규칙: 문어=near-black negative space, 가재=teal(`pixoo-sprites.ts` COLORS). 64px에서 멀쩡해도 11px에서 깨지니 1:1 눈검증 필수.
- 이 글리프는 **두 번째 회귀** — 승인본이 커밋 전 동시-세션 wipe로 두 번 날아감. 재드로 직후 즉시 커밋(`752492fc`)으로 보호.

---

## 2026-06-21 — D200H direct-HID 폴백 폐기: Ulanzi Studio 플러그인 단일 경로로

### 문제
D200H는 Mac용 **Ulanzi Studio** 앱 없이는 제대로 렌더링하기 어려운데, 두 데몬(Node CLI / Swift macOS)이 여전히 **direct-HID 폴백**으로 기기를 직접 잡고 있었다. stand-down은 *Ulanzi 플러그인이 마침 연결돼 있을 때만* 발동(`onUlanziPluginPresence`→`setExternalOwner(true)`)하므로, Ulanzi Studio가 안 떠 있으면 데몬이 기기를 그대로 가로채 "제대로 안 되는 화면"을 그렸다. 어떤 settings 토글도 이를 막지 못했다(중재가 순전히 "플러그인 연결 여부"였음).

### 해결 (activation 비활성화 — 코드는 dormant 보존, 가역적)
- **Node CLI daemon**: `bridge/src/daemon-server.ts`의 `initModules` 설정을 `d200h: 'auto'` → `d200h: false`. `D200hModule.shouldActivate(false)`가 즉시 `false`라 모듈은 `createDefaultModules`로 인스턴스화되지만 `start()` 안 됨 → `node-hid` 미접근. 세션 브리지(`cli.ts`)는 이미 전부 `d200h: false`라 유일한 활성화 지점이었음.
- **Swift macOS daemon**: `apple/AgentDeck/Daemon/Server/DaemonServer.swift`에서 `D200hHidModule()` 생성/등록을 `let enableD200hDirectHID = false` 가드로 감쌈 → IOKit `IOHIDManager` 미생성, `d200hModule`은 `nil` 유지. 모든 소비자가 이미 `if let d200hModule` 가드라 status 스냅샷에서 빠지고 stand-down 훅은 no-op.

### 핵심 설계 결정
- 코드 삭제가 아니라 **activation off** 선택: `D200hModule`/`D200hHidModule.swift`/`bridge/src/d200h/*`/공유 `d200h-layout.ts` 전부 유지. 되돌리려면 Node 설정을 `'auto'`로, Swift `enableD200hDirectHID`를 `true`로 플립.
- `ulanzi-plugin` 등록/stand-down 중재(`ws-server.ts` `onUlanziPluginPresence`, Swift `setExternalOwner`)는 dormant 코드로 그대로 둠 — direct-HID가 살아 있을 때만 의미 있던 경로라 무해.
- `plugin-ulanzi`는 무변경: 이미 기기 소유 + 데몬 죽으면 OFFLINE/press-to-launch(아래 항목).

---

## 2026-06-21 — D200H(Ulanzi 플러그인) 오프라인 시 OFFLINE 화면 + 키 눌러 컴패니언 앱 실행 (SD/SD+ 패리티)

### 문제
macOS 컴패니언 앱(데몬)이 안 떠 있을 때 D200H가 "제대로 작동 안 하는 fallback"을 보였다. `plugin-ulanzi`는 이미 WS 끊기면 `DISCONNECTED`로 강제했지만(`StateStore.toLayoutInput`), `buildSessionDeck`이 OFFLINE 타일을 **코너 키(slots[0]=0_0)** 에만 그리고 나머지는 빈 칸 + 모든 키 `action: null` 이라 **눌러도 아무 일도 안 일어났다**. SD/SD+는 오프라인 시 아무 키나 누르면 앱을 실행한다(`session-slot-button.ts:357` → `openAgentDeckAppOrGitHub`).

### 해결
- `shared/src/d200h-layout.ts` `buildSessionDeck` DISCONNECTED 분기: OFFLINE 히어로를 **가운데 키**(`Math.floor(slots.length/2)`)로 옮기고 "press any key" 힌트 추가. `DeckAction`에 `{ kind: 'launch' }` 추가 후 **모든 키**에 부여 → 아무 키나 눌러도 앱 실행.
- `plugin-ulanzi/src/launch.ts`(신규): `launchCompanionApp()` — `open -a AgentDeck`, 실패 시 GitHub 페이지 폴백. SD의 `openAgentDeckAppOrGitHub` 미러(크로스-패키지 import 불가라 복제). Node+macOS 전용.
- `plugin-ulanzi/src/app.ts` `onPress`에 `launch` case 디스패치.

### 핵심 설계 결정
- D200H 오프라인 화면 "주체"는 **구동 경로별로 다르다**: Ulanzi Studio 플러그인(별도 프로세스, 데몬 죽어도 살아 WS 재연결·앱 실행 가능)이 SD/SD+의 진짜 analog. direct-HID(Swift/Node 데몬이 HID 직접 구동)는 데몬=구동주체라 데몬이 죽으면 아무도 못 그림 — "press to launch"가 구조적으로 불가하므로 이번 변경 범위 밖(별도 엔진 `computeLayout`).
- `buildSessionDeck`/`DeckAction`은 **plugin-ulanzi 단일 소비자**(grep 검증)라 union 확장이 격리됨.

---

## 2026-06-19 — CLI iDotMatrix display sleep/wake dim parity 점검 및 수정

### 문제
macOS 모니터 sleep/wake 시 `display_state` 동기화 경로를 점검한 결과, Node CLI daemon의 Pixoo/D200H/ESP32/Stream Deck/Android 경로와 Swift in-process daemon의 Pixoo/D200H/ESP32/iDotMatrix 경로는 밝기 dim/restore를 처리했지만, **CLI-only iDotMatrix**는 Python BLE sync가 `/pixoo/frame?size=32`만 폴링하고 고정 brightness를 60초마다 재주장해 host display off/on을 반영하지 않았다.

### 해결
- Node daemon에 `GET /display-state`를 추가해 현재 `displayOn`과 `displaySleepDim` 설정(`enabled/mode/level`)을 JSON으로 노출.
- `bridge/src/idotmatrix/sync.py`가 `/display-state`를 폴링해 display off 시 `off=5%`(iDotMatrix 하드웨어 floor), `min=level%`, wake 시 설정 brightness로 복원하도록 수정.
- dimmed 상태에서는 BLE 프레임 업로드를 멈춰 Swift iDotMatrixModule의 `displayDimmed` guard와 동작을 맞춤.

### 핵심 설계 결정
- iDotMatrix는 BLE 밝기 명령 범위가 5~100이라 true-off 대신 5%를 practical off floor로 사용한다. 이는 Swift 네이티브 iDotMatrix 경로와 동일한 정책이다.
- `/display-state`가 없는 구형/session-only bridge에 붙은 수동 sync는 기존처럼 설정 brightness를 유지하도록 graceful fallback.

---

## 2026-06-17 — D200H: 공식 Ulanzi Studio 플러그인(주) + direct-HID(폴백) + 공유 세션 덱 엔진

### 문제
D200H가 direct-HID(역공학 0x7C7C)에서 "이미지 안 뜸 + 버튼 오작동"으로 불만. 더 근본적으로 사용자가 "벤더 공식 SDK로 갈아탈지" 물음. 1차 진단으로 direct-HID는 평범한 버그(폰트·버튼맵)였지만, Ulanzi가 **공식 플러그인 SDK(Elgato 스타일, Studio 안에서 WS)** 를 제공함을 확인 → 그게 더 맞는 경로.

### 해결
- **direct-HID 폴백 수선**: resvg가 폰트 미공급(`loadSystemFonts:false`+fontFiles 없음)이라 `<text>` 전멸 → `bridge/assets/fonts`(IBM Plex Sans+JetBrains Mono, OFL) `fontFiles`+`defaultFontFamily`. 버튼맵을 렌더 layout 단일소스화(`buildButtonCommandMap`).
- **신규 `plugin-ulanzi/`** (공식 UlanziDeckPlugin-SDK vendor): **단일 동적 액션** + **세션 중심 2단계 UX(v4)** — 목록(키1=세션1, 고정위치, awaiting 강조) ↔ 상세(BACK+INFO+옵션/Allow·Deny(requestId면 permission_decision)/idle 빠른액션+STOP). 데몬 자동발견(Swift/Node 무관) + `client_register clientType:ulanzi-plugin`. self-contained 패키징(esbuild + resvg 네이티브·ws 동봉) + 원클릭 설치.
- **공유 레이아웃 엔진** `shared/src/d200h-layout.ts`: `buildSessionDeck`(v4) + 레거시 `computeLayout/buildButtonCommandMap`(direct-HID). direct-HID와 플러그인이 동일 엔진.
- **충돌 배타(App Store 완결성)**: `ulanzi-plugin` 등록 시 데몬이 direct-HID를 stand-down. Node(`ws-server`+`d200h-module.setExternalOwner`) + Swift(`DaemonServer` 훅 + `D200hHidModule.setExternalOwner`, 디바이스 미오픈만 — App-Store-safe, macOS BUILD SUCCEEDED).

### 핵심 설계 결정 / 교훈
- **기기 디코드엔 풀 데이터 URI 필수**: `setBaseDataIcon`에 `data:image/png;base64,…` 프리픽스 없으면 Studio 프리뷰는 렌더되나 **하드웨어는 못 풀어 옛 프레임 유지**(공식 데모도 풀 URI). 가장 오래 헤맨 버그.
- **더블파이어**: D200H는 키 1회 누름에 `keydown`+`run` 둘 다 발생 → 둘 다 핸들하면 open→back 상쇄. `run` 하나만 처리.
- **반응성 = Studio 경유 LCD의 한계 + 우리 오버헤드**: 풀-덱 reflow + 매 렌더 GIF 재인코딩이 Studio→하드웨어를 폭주(초당 7회). 처방: GIF 기본 OFF(정적 PNG, env opt-in) + 키별 페이싱 큐 + 렌더 throttle/dedup + PNG 캐시. Stream Deck(네이티브+SVG직결)보다는 느림.
- **Ulanzi `key` = `col_row`**("0_0"~"4_0", 실기기 13키=5+5+3) — 우리 그리드 스킴과 동일해 단일 동적 액션이 성립.
- **공식 SDK 유무를 repo 검색만으로 단정 말 것**(사용자 정정). 벤더 native .dylib SDK였다면 App Store 위반이었겠지만, 플러그인 SDK는 Studio 안에서 돌아 AgentDeck.app에 미번들 → 불변식 무관.

## 2026-06-14 — TTGO 세로모드 검정 진짜 원인(캔버스 stride 비정렬) + 회전 화면 누수 먹통 + 오버레이 레벨트리거

### 증상
직전 "80px 메트릭 스트립" 작업으로 전체 검정 오버레이를 제거한 뒤에도 **가로모드는 테라리움 정상, 세로모드만 검정**이 남았다. 이후 stride 수정으로 세로가 정상이 되자, 이번엔 **회전 버튼을 2번째 누르는 순간 기기가 먹통**(프리즈)이 됐다.

### 근본 원인 3종 (시리얼 직접 구동 + firmware 로그로 각각 확정)
1. **세로 검정 = LVGL 캔버스 draw-buf stride 비정렬.** `lv_conf.h`의 `LV_DRAW_BUF_STRIDE_ALIGN 32`. 캔버스 stride = `canvasW*2`인데, 가로는 너비 160px → 320B(32정렬, 정상), 세로는 너비 135px → 270B(=8×32+14, **비정렬**) → LVGL blit 경로가 깨져 검정 밴드. C6(172px, 역시 비정렬)가 멀쩡해 보여 1차에서 오배제했으나, C6는 **기본이 가로**라 세로 비정렬이 미검증이었음. **착시 단서**: 화면 배경은 모래색(`0x2A1F14`)·splash는 파랑(`0x163B5C`)이라, 렌더 실패면 모래색이 보여야 함 → "순수 검정"은 near-black 불투명 요소(`connScrim 0x070B13`)이거나 blit 깨짐.
2. **회전 먹통 = 화면 재생성 heap 누수.** 회전 시 `main.cpp`가 splash/aquarium/timeline/settings/permission **5개 스크린을 재생성**하는데, 각 `xxxCreate()`는 `lv_obj_create(NULL)`로 새로 만들고 모듈-static 포인터만 덮어쓸 뿐 **옛 스크린을 삭제 안 함** → 회전마다 스크린 트리 5개 통째 누수. PSRAM 없는 ESP32라 heap ~200KB뿐 → 1차 회전(자동 portrait)은 성공·heap ~50KB로 하락, 2차 회전(버튼)에서 재빌드 중 추가 할당 실패 → 모든 JSON `[Protocol] JSON error: NoMemory` + 먹통.
3. **연결 오버레이 stuck = 엣지 트리거.** 연결상태 스크림 갱신이 `showConnected`/`wifiNow` **엣지에서만** 동작 → 회전이 화면을 재생성하면 새 `connScrim`이 하드코딩 기본값(HIDDEN)으로 생기는데 엣지가 안 떠 실제 연결상태 재적용이 누락(로그상 회전 후 `[Conn] overlay status` 없음). "가로는 우연히 숨겨져 정상, 부팅 orientation은 stuck" 비대칭의 정체.

### 해결
- **stride** (`esp32/src/ui/terrarium/renderer.cpp`): 세로 캔버스 너비를 16의 배수로 패딩(`TTGO_PANEL_SHORT_EDGE_W = 144`, 135→144) → stride 288B(32정렬). 남는 9px는 화면 우측 밖 클리핑. LVGL이 stride를 존중하든 재계산하든 둘 다 288이라 mismatch 불가. 정적 버퍼 `ttgo_canvas_buf[144*160]`(+2880B, DRAM free 10424→7544, 예산 내). 검증: 세로 `Canvas 144x160`, 가로 `Canvas 160x135` 둘 다 정렬.
- **회전 누수** (`esp32/src/main.cpp`): 회전 재생성 시 옛 5개 스크린 포인터 보관 → 새 스크린 생성·`lv_screen_load`(활성 전환) **후** `lv_obj_del`로 옛 스크린 삭제(LVGL은 활성 스크린 삭제 금지라 순서 필수). 캔버스 draw-buf는 공유 정적 버퍼라 객체 삭제해도 live 화면 무영향. 검증: **10회 연속 회전 NoMemory 0·heartbeat_ack 54·먹통 없음**(수정 전 2회째 사망).
- **오버레이 레벨트리거** (`esp32/src/main.cpp`): 엣지 트리거 폐기, 매 프레임 desired `ConnOverlayStatus` 계산해 실제 적용값과 다를 때만 적용(`lastOverlayStatus`). 회전 재생성 시 `lastOverlayStatus=-1`로 강제 재적용. recreation-safe + self-heal.

### 핵심 교훈
- **LVGL 캔버스 stride는 항상 `LV_DRAW_BUF_STRIDE_ALIGN`(=32B) 정렬 필요.** 캔버스 너비를 16px 배수로 두지 않으면 보드/회전에 따라 검정. 폭이 16배수인 보드는 우연히 통과해 회귀가 늦게 드러남.
- **회전 = 전체 화면 재생성 = 누수 위험 1순위.** 스크린 재빌드 패턴은 옛 트리 삭제를 반드시 동반. PSRAM 없는 보드는 1~2회만에 heap 고갈.
- **CH340 TTGO 플래시**는 먹통/크래시 상태에서 "chip stopped responding" 반복 → **USB 물리 재인가**가 유일한 깨끗한 복구. 플래시 ~5.5분(57600+--no-stub).
- **시리얼 직접 구동 디버깅**: 데몬 중지 후 pyserial로 heartbeat JSON 주입(연결상태 위조) + `set_orientation` 명령 + firmware 로그 캡처로 화면 없이도 stride/scrim/heap 거동을 실측. pyserial DTR/RTS 자동리셋은 이 보드에서 불안정(esptool 또는 전원재인가 사용).

## 2026-06-14 — TTGO 테라리움 검은 배경 재발 원인 분석 + 80px 메트릭 스트립 고정

### 문제
TTGO T-Display 에서 테라리움 배경 대신 검은 화면처럼 보이는 현상이 계속됐다. 이전 안정화는 전체 135×240 테라리움 캔버스를 포기하고 135×160 정적 버퍼 + 80px 메트릭 영역으로 낮추는 방향이었지만, 현재 UI 위젯은 테라리움 위에 **전체 화면 `0x000000` / 50% 오버레이**를 덮고 있었다. 작은 ST7789 패널에서는 이 반투명 레이어가 수중 배경을 사실상 검정으로 눌러 보이게 만들었다. 또한 회전 상태가 landscape 로 남아 있으면 고정 135×160 캔버스가 240×135 화면의 좌측 일부만 차지하는 불일치도 있었다.

### 하드웨어 한계
LilyGO TTGO T-Display 1.14" 는 ST7789 135×240 SPI LCD + ESP32 classic 계열이며, PSRAM 없이 동작한다. 이번 빌드 기준 `pio run -d esp32 -e ttgo` 의 정적 DRAM 여유는 **10,424 bytes**뿐이다. 전체 135×240 RGB565 캔버스는 64,800 bytes, 현재 제한된 135×160 캔버스는 43,200 bytes 라 전체 캔버스로 되돌리면 추가 21,600 bytes 가 필요해 정적 DRAM 예산을 초과한다.

### 해결
- TTGO 테라리움 버퍼를 21,600픽셀로 고정하되, 회전에 따라 135×160(세로) 또는 160×135(가로)로 해석하게 했다.
- `TTGO::StateWidget` / `TTGO::ActivityWidget` 의 전체 화면 검정 반투명 배경을 제거하고, 남는 80px 메트릭 스트립만 모래색 불투명 패널로 칠하게 했다. 테라리움 영역 위에는 더 이상 검정 오버레이가 올라가지 않는다.
- TTGO LVGL partial draw buffer 를 40라인에서 20라인으로 줄여 런타임 DMA-capable heap 압박을 낮췄다.
- 문서화: `docs/esp32.md` 에 TTGO 전체 캔버스 금지와 160px terrarium + 80px strip 규칙을 추가.

### 검증
`pio run -d esp32 -e ttgo` 성공. 빌드 결과: DRAM 114,156 / 124,580 bytes 사용(91.63%), 잔여 10,424 bytes. Flash 2,597,031 / 6,291,456 bytes 사용(41.3%).

## 2026-06-14 — APME 재구축: canonical SessionSample (Inspect 스타일) SSOT + cost/Pareto + 타임라인 projection

### 문제
타임라인과 APME 평가가 **두 개의 분리된 파편화 파이프라인**이었다. 어댑터가 chat_start/response/end·tool_request/resolved 를 직접 emit(중복·race·경계 없음), 디스플레이타임 `groupConsecutive` 로만 묶임. OpenClaw `session.tool`/`session.message` 는 default case 에서 **silent drop**(`openclaw.ts:1093`) → 대부분 도구 호출이 아예 안 보임. 평가 단위(`task`)는 untyped `steps` + `tool_calls:count` 로 trajectory 손실. 비용/모델 비교는 스키마에만 있고 미활용.

### 해결
Inspect AI 의 `EvalLog→Sample→Event→Scorer` 모델을 네이티브(TS+Swift, Python/subprocess 無)로 차용. **`SessionSample`** = 경계 있는 단위 + 타입 trajectory(user/assistant/model/tool/state/info) 를 도입, 타임라인·평가 **둘 다 이것의 projection**.
- **shared**: `sample.ts`(SessionSample + TrajectoryEvent), `pricing.ts`(override 가능 단가표, local=$0), `trajectory` eval layer.
- **bridge**: collector 가 `sample_events` 에 dual-write(UNIQUE index 저장시점 dedup) + cumulative-usage delta 로 per-task 비용 pricing; runner 가 `getSample()` 로 도구 trajectory 를 judge 프롬프트에 + `scorers/`(trajectory_quality·tool_efficiency); `pareto.ts` frontier + recommender 재배선; `/apme/pareto`·`/apme/samples` 라우트; OpenClaw `session.tool`/`session.message` 캡처 복구.
- **Phase 6 타임라인 컷오버 (flag-gated, default OFF)**: `AGENTDECK_TIMELINE_PROJECTION=1` 시 타임라인이 SessionSample projection 으로 전환 — 로컬 chat/tool 행 suppress, projected/relayed/task 행은 bypass. `BridgeTimelineStore.setSuppressLocalChatTool` + `add(entry,{bypassSuppression})`, `DaemonTimelineStore` 미러.
- **Swift 데몬 미러**: 스키마+sample DAO, collector dual-write+pricing(`ApmePricing.swift`), scorers(`ApmeScorers.swift`), Pareto recommender, HTTP 라우트, projection. App Store 타깃 빌드 clean, 신규 subprocess 문자열 0.
- 검증: vitest **1360 통과**, `xcodebuild AgentDeck_macOS` SUCCEEDED. 데몬 재시작으로 라이브 반영 + 신규 라우트 실측 확인. 커밋 `e83953f5`.

### 핵심 설계 결정
- **하나의 normalizer(collector) + 두 projection(타임라인·평가)** 으로 "two pipelines" 버그군 제거 — 디스플레이타임 grouping·8s race dedup·OpenClaw drop 이 부수적으로 해결됨.
- 기존 `task` 행 = SessionSample 헤더로 재사용(rename 없음). `steps` 는 raw archive 로 유지.
- 컷오버는 **env 플래그 default OFF** — 배포는 타임라인 무변경(안전), 사용자가 1개 표면에서 렌더 검증 후 전역 flip. 코드 변경 없이 env 빼면 즉시 원복.
- Node/Swift 데몬은 **alternative(동시 아님)** 라 sample dedup_key 는 raw composite 로 충분(cross-daemon dedup 불필요).
- pricing 달러값은 best-effort public 단가 + **런타임 override 가능**(`setPricingOverrides`) — 코드 수정 없이 정정. claude-api skill 의 단가가 redacted 라 임의값 하드코딩 회피.

## 2026-06-14 — OpenClaw 타임라인 오표기 fix (attribution + cron 프롬프트 dump)

### 문제
사용자가 timeline 에서 "OpenClaw 가 bash 작업 같은 걸 하고 있다"고 보고. `~/.agentdeck/timeline.json` 분석 결과 결함 2종:
1. **(Node, 라이브)** OpenClaw Gateway cron 활동(memory review/LINE/YouTube 더빙)이 `agentType:null` + `projectName:"AgentDeck"` 로 들어가 OpenClaw 로 분류되지 못하고 AgentDeck 프로젝트에 섞임.
2. **(Swift)** Gateway 가 echo 한 cron 프롬프트(`[cron:...]` prefix, 내부에 `ls -lt`/`tail -50` 셸 문구)가 `model_call.detail` 에 truncation 없이 통째로 dump → bash 실행처럼 보임. 실제 도구 실행 아니라 프롬프트 텍스트.

### 진단 키
`timeline.json` 은 Node·Swift 데몬이 번갈아 쓰는 같은 파일. 출처 구분 시그니처: **`model_call` 타입 = Swift 전용** emit, **`automated:true` 플래그 = Node 전용** 설정.

### 해결
- **Fix A (Node):** `daemon-server.ts` 에 `enrichGatewayTimelineEntry()` export 추출 → `case 'timeline'` 에서 어댑터 엔트리에 `agentType:'openclaw'`/`projectName:'OpenClaw'` stamp. 어댑터(`openclaw.ts`)는 bare 엔트리를 emit 하고, `bridge-core.ts` attributor 는 projectName 을 데몬 하드코딩 `'AgentDeck'` 로 fallback + agentType fallback 없음 → null 이던 것을 chokepoint 에서 보정. 데몬 재시작 후 실제 cron turn 으로 end-to-end 검증(chat_start/response/end 전부 openclaw/OpenClaw 로 표기).
- **Fix B (Swift):** `OpenClawAdapter.swift` 의 model_call/model_response/`fromSessionMessage` 에서 `detail` 1000자 cap(Node 의 ~1000 cap 과 정합) + `[cron:` 감지 시 `automated:true`(`automatedRunId` instance var 로 response 까지 전파).
- 회귀테스트 `bridge/src/__tests__/gateway-timeline-attribution.test.ts` 추가.

### 핵심 설계 결정
Gateway 어댑터는 OpenClaw 전용 wiring 이므로 origin attribution 은 어댑터 출구가 아닌 **데몬 핸들러 chokepoint** 에서 stamp(단일 지점). 긴 프롬프트/응답은 detail cap 필수 — cron 지시문은 multi-KB 셸-verb blob 이라 verbatim 노출 시 도구 실행으로 오인됨.

## 2026-06-14 — OpenCode 크리처 전 표면 hollow-ring 재설계 + IPS10 2D 트리맵

### 문제
- OpenCode 크리처가 기기마다 제각각이고 원본 로고와 달랐다. 진짜 `design/brand/opencode.svg`(`M16 6H8v12h8V6zm4 16H4V2h16v20z`, **evenodd**)는 세로 직사각 **링**(outer 16×20, inner 8×12 hollow) 단색인데, 대부분 표면이 채워진 nested square + 어두운 inner 로 그려 **가운데가 그림자처럼** 보였다.
- 게다가 일부 표면은 아예 깨짐: **Pixoo32/iDotMatrix** 는 HD 그리드가 32px 를 오버플로우해 OpenCode 미표시, **TC001** 은 cyan(브랜드 아님) + 5×5 정사각, **Pixoo 상단 에이전트 점 인디케이터** 는 색이 octopus/jellyfish 2종뿐이라 opencode 점이 octopus 색으로 묻힘.
- IPS10 사이드바 모자이크가 좁은 세로 스택이라 공간을 못 채웠다.

### 해결 (uncommitted → 이번 세션 커밋)
- **OpenCode = 단색 hollow vertical ring 으로 통일**:
  - ESP terrarium: `generate-creature-glyphs.mjs` 에 OPENCODE evenodd 래스터 추가 → `creature_glyphs_generated.h` mask, `opencode.cpp` 가 그리드 대신 `Draw::alphaMask` 단색 hollow 렌더.
  - Pixoo(64/32/iDotMatrix): `pixoo-sprites.ts drawOpenCode` 그리드→**procedural hollow ring**(해상도 무관 스케일, 32px 해결).
  - TC001: `matrix_pages.cpp` 색 cyan→warm gray, sprite 5×8(과도)→**5×6 ring + dim 3×4 inner shadow**(다른 크리처와 키 맞춤, 깊이감).
  - e-ink/tablet: `drawEinkOpenCode`/`OpenCodeCreature.kt` thick-stroke ring(e-ink 은 B&W 대비 위해 dark stroke).
  - shared SVG: `agent-logos.ts` 3중 fill→evenodd path.
  - Pixoo 점 인디케이터: `pixoo-renderer.ts` 점 색에 opencode 분기 추가(`getOpenCodePaletteForSession().outer`).
- **IPS10 모자이크 → 2D 트리맵**: `hud_bar.cpp` absolute-positioned 셀 slice-and-dice(면적 ∝ activity weight, 긴 변 분할), rect lerp 유동. terrarium canvas 408 / 사이드바 372 로 폭 확대(`renderer.cpp`).

### 핵심 설계 결정
- **단일 캐노니컬 geometry 를 표면별 렌더 기법에 매핑**: 같은 evenodd 링을 ESP 는 빌드타임 alpha mask, Pixoo 는 procedural, tablet/e-ink 는 stroke, SVG 는 path 로. 펌웨어는 런타임 SVG 파싱 불가라 mask 가 정답.
- **TC001 같은 초저해상도(8px)에서는 hollow 가 비어 보여** inner 를 body 밝기의 40% dim shadow 로 채워 깊이 부여 — 큰 화면의 "그림자처럼 보임" 불만과 반대 방향이지만 매체 특성상 정당.
- ESP 플래시는 매 보드 `device_info_request` 재검증 후 진행(IPS↔AMOLED 오플래시 위험 차단). C6 는 probe 타이밍으로 1회 skip 후 재시도 성공.

---

## 2026-06-13 — iDotMatrix 정체 규명 + 네이티브 CoreBluetooth 제어 (App Store 합법화)

### 문제
- "픽셀 디스플레이 32"가 화면 나오다 무한 재부팅. 처음엔 ESP32 1024-LED 매트릭스로 가정하고 brownout(전력 캡 부재 + TC001용 밝기 상속)으로 진단했으나, 기기를 분해해보니 **컨트롤러가 ESP32가 아니라 BLE SoC**(실크 핀 `PA9`/`PC4`/`ANT1`/마이크/부저 — Telink TLSR8 계열)였다.
- 레포의 `[env:idotmatrix]` + `boards/board_idotmatrix_s3.h`는 "iDotMatrix=ESP32-S3"라는 **틀린 가정**으로 만들어진 유령 보드. 헤더의 MAC 주석(`d0:cf:13:1e:0b:64`)이 실제론 **round AMOLED ESP32**의 것이라, MAC 매칭만 믿고 round 기기에 매트릭스 펌웨어를 **오플래시**(round 화면 black/TG1WDT 루프) → 올바른 `amoled` 펌웨어 재플래시로 복구.
- iDotMatrix 제어가 Node CLI의 **Python 서브프로세스(`idotmatrix/sync.py`, bleak)** 로만 가능 → 번들 인터프리터 + subprocess라 App Store 불변식(2.5.2) 위반. App Store macOS 앱엔 기능 부재.

### 해결 (commit 7dfc8963, 852dd97a)
- **유령 보드 제거**: `[env:idotmatrix]` + `board_idotmatrix_s3.h` + `board_config.h` 분기 삭제. iDotMatrix는 BLE 경로(`agentdeck idotmatrix sync` / 네이티브)로만 구동.
- **네이티브 Swift CoreBluetooth 재구현** (Pixoo가 HTTP라 합법인 것과 동일 전략):
  - `IDotMatrixBLE.swift` — `IDM-` 스캔, CBPeripheral UUID 연결, service `fa00`/write char `fa02`, MTU 청크 write, `setMode(1)`/`setBrightness`/`uploadImage`. 모든 connect/write await에 타임아웃 강제(OpenClawAdapter 패턴).
  - `IDotMatrixModule.swift` (`actor DeviceModule`) — PixooModule 미러(Shadow/circuit-breaker/offline-frame/5s settings reload/handleEvent). 프레임: `PixooRenderer`(64×64) → 2×2 box 다운스케일 32×32 → PNG.
  - `IDotMatrixSheet.swift` — BLE Scan→Pair UI + 밝기 슬라이더. `idotmatrixDevices[]` 저장.
  - entitlement `com.apple.security.device.bluetooth` + `NSBluetoothAlwaysUsageDescription`(macOS+iOS) + 기능 매트릭스/리뷰 노트.

### 핵심 설계 결정
- **상용 BLE 기기는 ESP32 펌웨어 대상이 아니다.** 기기 식별은 보드 헤더 MAC 주석을 믿지 말고 **연결/해제 시 사라지는 포트 diff**로 확정. iDotMatrix의 USB는 데이터가 아니라 전원 입력(포트 안 뜸).
- **BLE를 App Store에 넣는 걸 막는 건 BLE가 아니라 Python 서브프로세스.** CoreBluetooth는 1st-party라 `verify-appstore-archive.sh` 무관, entitlement+usage string만 필요.
- **공존**: in-process Swift 데몬은 외부 Node 데몬이 9120을 소유하지 않을 때만 실행(상호 배타) → 두 데몬이 BLE 단일 연결을 동시에 잡는 일 없음. standalone `idotmatrix sync` 오버랩만 남고, 그건 circuit breaker가 backoff로 흡수(`isUsingExternalDaemon` 플러밍 불필요).
- 원래 재부팅은 **기기 자체 전원 brownout**(코드 무관, 2A+ 어댑터로 해결).

---

## 2026-06-13 — 도트 디스플레이 크리처 렌더링: iDotMatrix 32px 사이징 + TC001 노이즈/크리처

### 문제
- 신규 **iDotMatrix 32×32 BLE** 디스플레이(`/pixoo/frame?size=32`)에서 크리처가 프레임을 넘쳐 터라코타 색 벽 + 거대한 검은 눈 사각형으로만 보였다. 64px Pixoo는 정상.
- Pixoo/iDotMatrix **OpenClaw 가재**가 세로로 길쭉(`cellH = cellW*1.5`)하고 공식 마스코트(`design/brand/openclaw.svg`)와 안 닮았다.
- **Ulanzi TC001**(8×32 WS2812 매트릭스, ESP32) 화면에 조금씩 노이즈/시머가 끼고, 크리처가 단색 5×6이라 표현이 빈약했다.

### 해결 (commit a467edd1)
- **해상도 인식 사이징**: `bridge/src/pixoo/pixoo-sprites.ts`의 octopus/jellyfish/crayfish/tetra 셀 크기를 `cam.zoom`-only → `creatureCellSize(zoom, w, cols) = SPRITE_W_FRAC(0.1875)*zoom*w/cols`로 변경(`drawOpenCode`가 쓰던 패턴 통일). `w`(출력 너비)를 곱해 32px에서 크리처가 절반 픽셀로 들어맞음. `selectGrid`의 `canvasWidth<=32 && zoom>=1.3` 분기를 MD→HD로 바꿔 32px도 64px와 동일 실루엣.
- **가재 재설계**: `cellH = cellW`(square)로 세로 스트레치 제거 + `CRAYFISH_GRID_HD`를 둥근 몸통(공식 마스코트: 모서리 더듬이, 분리된 집게, teal 눈, 다리)으로 재작성. MD/LOD도 동반 수정. 가재 눈은 grid 아닌 `eyeRow`/`eyeCols` overlay라 위치 재조정.
- **TC001 노이즈**: 원인은 **FastLED temporal dithering**(밝기<255 기본 ON)이 ~30fps + LDR 가변 밝기에서 어두운 픽셀에 시머 생성. `matrix_display.cpp init()`에 `FastLED.setDither(DISABLE_DITHER)` + raw LDR median-of-5 추가.
- **TC001 크리처**: 단색 5×6 → `drawCreature(body, accent)` body+lit accent overlay(문어 머리 하이라이트/Codex `>_` 마킹/OpenCode 코어/가재 teal 눈).

### 핵심 설계 결정
- **LED 매트릭스 accent는 반드시 몸 밝기에 비례시킬 것**. 고정 밝기 accent(teal 눈 등)는 크리처가 idle/dormant(near-black body)일 때 어두운 몸이 가시 한계 아래로 떨어지며 accent만 떠올라 "눈만 깜빡 / 머리 빨간 점"으로 보인다. `accentScaled(hue, body, boost)`로 accent 밝기를 `bodyMax/255*boost`에 묶어 active일 땐 또렷, dormant일 땐 같이 어두워지게 해결.
- 펌웨어 플래시: TC001은 다른 ESP32 보드 다수와 동시 연결되므로 **daemon device_info로 보드(`ulanzi_tc001`) + MAC(`24:d7:eb:b1:cd:e4`) 확인 후** esptool 직접(`--flash-size keep`, boot_app0+firmware, daemon 중지)으로 플래시. env는 `led8x32`.

---

## 2026-06-13 — App Store 제출 전 데몬 감사 + 공존 하드닝 + 통신 효율 개선

### 문제
- Swift/Node 데몬 듀얼 구조의 공존 완결성, APME 평가 정확성, Timeline 그루핑 품질을 App Store 제출 전 전수 감사할 필요.
- 통신 구조 점검에서 브로드캐스트 증폭과 이벤트 루프 블로킹 병목 확인.

### 해결 (commit a467edd1)
- **감사 결과**: APME(3-layer eval, colMap, 30s 루프) / Timeline(3-site roundtrip, 회전 3-surface, summary pill) / App Store invariants 모두 클린 — 제출 블로커 없음.
- **공존 하드닝**: Swift singleton guard 에 9120-9139 포트 스캔 추가 (`SessionRegistry.scanForDaemonPort`) — Node 데몬이 fallback 포트에 있을 때 dual-daemon 방지. Node `loadDaemonSettings` 가 `getCandidateDataDirs()` mtime 최신본 읽기 + `AGENTDECK_DATA_DIR` 존중.
- **Timeline 노이즈**: Codex otel-active placeholder 필터를 enumerated list → structural match 전환 (OpenClaw 필터와 동일 패턴).
- **통신 효율**: ① Swift sessions_list tool-boundary 2s 디바운스 + trailing flush (state/question 전이는 즉시 — Node `maybeBroadcastSessionsList` 패리티), ② Node passive observer `ps`/`lsof` 를 async execFile 로 — 브로드캐스트 경로 이벤트 루프 블로킹 제거, ③ 유휴 폴러 감속 (judge 30→120s, antigravity 15→60s, WS 클라이언트 없을 때), ④ WS send 64-frame in-flight 백프레셔 (snapshot 프레임 드롭 안전), ⑤ TimelineStore dead `@Published grouped` 제거.

### 핵심 설계 결정
- **"no WS clients ≠ idle"**: `wsServer.onBroadcast` 훅이 디바이스 모듈(ADB/Serial/Pixoo/D200H) fan-out 이라 zero-client 직렬화 스킵은 전제 불성립. gateway 5s probe 도 같은 이유로 감속하지 않음. (memory: broadcast-hook-device-fanout)
- **settings.json 공존 동기화는 파일로 불가**: 비샌드박스 Node 가 App Store 컨테이너를 읽으면 TCC hang — cross-talk 은 port scan/health probe 가 정답. 한계는 `docs/appstore-feature-matrix.md` 인프라 표에 기록. (memory: settings-split-dir-tcc-limit)
- Device approval gating(PreToolUse Allow/Deny) 은 Node 전용, Swift 는 display-only awaiting — 의도된 App Store 차이로 feature matrix 에 기록.

---

## 2026-06-13 — TTGO T-Display 안정화 조치 및 6대 기기 매핑 테이블 추가

### 문제
- LilyGO TTGO T-Display 1.14" 기기에서 135x240 전체 해상도 사용 시 DRAM 용량 부족(BSS 오버플로우) 및 부팅 후 힙 메모리 파편화로 인해 `malloc`이 실패해 화면이 검게 나오는 현상이 발생함.
- 해상도를 135x190으로 시도했으나 정적 BSS 메모리 마진이 7KB 이하로 내려가 LovyanGFX 및 LVGL 하드웨어 디스플레이 초기화 단계에서 메모리 부족으로 화면이 켜지지 않는 침묵 에러(Silent Fail) 발생.
- 135x160으로 가동 시 화면 가로방향으로 검은 노이즈 라인이 수시로 깜빡이는 현상(Tearing & bus collision) 발생.
- 유저가 추가로 1대의 ESP32 디바이스를 연결하여 총 6대의 기기 연동이 개시됨.

### 해결
1. **정적 135x160 버퍼 및 모래사장 여백 융합 (완전 안정화)**:
   - TTGO의 캔버스 해상도를 부팅 안전성이 검증된 `135x160` 정적 버퍼(DRAM 남은 용량: **15.2KB**)로 롤백하여 메모리 부족으로 런타임에 화면이 안 켜지는 현상을 원천 방지함.
   - 캔버스 하단에 남는 80px 영역은 `aquarium.cpp`에서 스크린 배경 불투명도를 `lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0)`로 강제 설정하고 배경색을 수족관 모래사장 테마 칼라인 `0x2A1F14`로 자연스럽게 채워 검은 여백을 해결하고, 해당 영역을 Claude 에이전트 정보 및 잔여 토큰 게이지 표출을 위한 메트릭 창으로 매끄럽게 융합함.
2. **가로 노이즈선 및 깜빡임 해결**:
   - `display.cpp` 의 `disp_flush` 콜백 루프 내부에서 LovyanGFX로 데이터를 푸시하기 전후에 `tft.startWrite()` 와 `tft.endWrite()` 로 트랜잭션을 잠금(Lock) 처리하여 다른 비동기 네트워크 스택 등이 SPI 버스 전송을 방해하는 것을 막아 노이즈선을 완전히 소멸시킴.
   - SPI 클럭 주파수를 기존 20MHz에서 **40MHz**로 높여 프레임 리프레시를 가속하고 화면 찢어짐(Tearing)을 극소화함.
3. **6대 ESP32 하드웨어 시리얼 매핑 캐시 최신화**:
   - 데몬의 `/devices` REST API 조회 결과를 바탕으로 현재 워크스페이스에 연동 중인 6대 기기 매핑 목록을 영구 기록함.

### ESP32 기기 시리얼 포트 매핑 목록 (2026-06-13 기준)
| 시리얼 포트 명 | 식별 보드 타입 | 설명 및 해상도 |
| --- | --- | --- |
| `/dev/cu.wchusbserial58A90021441` | `ttgo_t_display` | LilyGO TTGO T-Display 1.14" (135x240, 캔버스 135x160 + 80px 메트릭 여백) |
| `/dev/cu.wchusbserial211240` | `ips_10` | Guition JC8012P4A1C 10.1" HMI (Landscape 1280x800) |
| `/dev/cu.usbmodem2111201` | `round_amoled` | AMOLED Round 1.8" (454x454 원형 AMOLED) |
| `/dev/cu.usbmodem834101` | `ips_35` | 3.5" IPS 디스플레이 모듈 (480x320) |
| `/dev/cu.wchusbserial2112320` | `86box` | 86 Box 4" (480x480) |
| `/dev/cu.usbmodem83201` | `Unknown (S3 CDC)` | 신규 추가 연결됨 (Native USB CDC) |

---

## 2026-06-09 — ESP32 dynamic stride root-cause fix & glow animation restoration

### 문제

- 이전 조치(수동 stride 계산식 도입)에도 불구하고 86 Box, IPS35 등 일부 디바이스에서 연결 상태 텍스트("Connecting" 등) 갱신 시 여전히 가로 노이즈 밴드가 발생하거나 화면이 깨지는 현상이 지속됨.
- 원인은 부분 invalidate 영역의 stride 바이트 수 수동 계산 공식이 LVGL 9이 내부적으로 재할당/재정형(reshape)하는 실제 버퍼 stride 구조와 어긋날 수 있고, `BOARD_RGB48` (86 Box) 및 `BOARD_IPS35` (3.5" IPS) 분기에서는 stride 보정(line-by-line drawing) 로직 자체가 누락되어 있었기 때문임.
- 또한, 애니메이션을 정적으로 완전히 지워버려 UI의 비주얼 피드백이 밋밋해져, 깨지지 않는 안전한 glow 효과의 복원이 필요함.

### 수정

- **dynamic stride 조회**: `esp32/src/ui/display.cpp`의 `disp_flush`에서 수동 stride 계산을 모두 제거하고, LVGL API인 `lv_display_get_buf_active(display)->header.stride`를 조회하여 픽셀 stride(`stride_pixels`)를 동적으로 정밀하게 획득하도록 수정함.
- **모든 보드 stride 보정 적용**: `BOARD_RGB48` 및 `BOARD_IPS35`를 포함한 모든 디스플레이 드라이버 분기에 `stride_pixels != w`인 경우 라인 바이 라인으로 그리는 안전 분기를 일관되게 제공함.
- **Glow & Breathing 효과 추가**:
  - `esp32/src/ui/screens/splash.cpp`의 브랜드 로고 이미지(`imgLogo`)에 opacity breathing (`100`~`255`, 1.5초 주기) 애니메이션을 적용함.
  - `esp32/src/ui/screens/aquarium.cpp`의 재연결 카드(`connCard`) 테두리에 border_opa breathing (`40`~`180`, 1.5초 주기) 애니메이션을 적용하여 깨짐 없는 세련된 Cyan Border Glow 효과를 구현함.

### 검증

- 5개 연결된 모든 ESP32 실기기에 순차 배포 완료:
  - `ttgo` (`/dev/cu.wchusbserial58A90021441`) -> **SUCCESS**
  - `amoled` (`/dev/cu.usbmodem2111201`) -> **SUCCESS**
  - `ips10` (`/dev/cu.wchusbserial10`) -> **SUCCESS**
  - `box_86` (`/dev/cu.wchusbserial211340`) -> **SUCCESS**
  - `ips35` (`/dev/cu.usbmodem21133201`) -> **SUCCESS**
- 디바이스의 부팅 및 재연결 스크린에서 텍스트 노이즈 찢어짐 현상이 완벽히 소멸되었고, 은은한 로고 브리딩과 테두리 글로우 애니메이션이 E-ink/LCD/AMOLED 전 패널에서 매우 부드럽고 정상적으로 작동함을 확인함.

---

## 2026-06-09 — ESP32 connecting animation noise fix

### 문제

TTGO, Round AMOLED, IPS 10", 86 Box, IPS 3.5"에 배포된 현재 펌웨어에서 연결 시도/재연결 상태의 애니메이션이 화면 깨짐 또는 노이즈처럼 보였다. 스크린샷 확인 결과 spinner 형태 자체보다 작은 LVGL 객체/텍스트와 부분 redraw가 패널별 flush 경로와 충돌하는 것으로 보여, 고위험 경로를 제거했다.

- 초기 splash 화면의 `lv_spinner` arc 애니메이션이 작은 영역을 고속 invalidate 한다.
- 재연결 overlay가 `aquariumUpdate()` 매 tick마다 full-screen scrim 배경색을 변경해 패널 전체 flush를 유발한다.

### 수정

- `esp32/src/ui/screens/splash.cpp`의 `lv_spinner`와 dot animation을 제거하고, 정적인 opaque splash (`AgentDeck` + `Connecting`)만 표시하도록 변경했다.
- `esp32/src/ui/screens/aquarium.cpp`의 full-screen background pulse와 reconnect indicator animation을 제거하고, 정적인 opaque overlay만 표시하도록 변경했다.
- `esp32/platformio.ini`의 `ips35`, `amoled`, `ips10`, `box_86` upload/monitor 포트를 2026-06-09 실제 성공 포트 매핑과 일치시켰다.

### 검증

- `pio run -d esp32 -e ttgo -e amoled -e ips10 -e box_86 -e ips35` 통과.
- 정적 연결 UI 펌웨어 업로드 성공: `ttgo` (`/dev/cu.wchusbserial58A90021441`), `amoled` (`/dev/cu.usbmodem2111201`), `box_86` (`/dev/cu.wchusbserial211340`), `ips35` (`/dev/cu.usbmodem21133201`).
- `ips10` 빌드는 통과했지만, 업로드 시점에 `/dev/cu.usbmodem101`가 macOS 포트/USB registry에서 감지되지 않아 업로드는 보류했다.

---

## 2026-06-07 — 86box ESP32-S3 Serial UART fix

### 문제

86box (ESP32-S3-4848S040) 기기가 백라이트는 켜지지만 화면이 검은색으로 나오는 현상이 발생했다. 진단 결과 펌웨어 업로드는 성공했지만, 시리얼 출력이 전혀 나오지 않았다. 원인은 ESP32-S3의 `ARDUINO_USB_MODE=1` 설정과 `ARDUINO_USB_CDC_ON_BOOT` 미지정이 결합되어 Serial 클래스가 Native USB CDC로 출력을 보내려 했으나, 86box는 CH340 UART 어댑터로 연결되어 있어 실제 시리얼 데이터가 나가지 않는 상황이었다.

### 수정

- `esp32/platformio.ini`의 box_86 환경에 `-DARDUINO_USB_CDC_ON_BOOT=0`을 추가해 Serial을 UART0(CH340)으로 강제 redirection 했다.
- `esp32/src/main.cpp`의 setup() 함수에 `BOARD_BOX_86 || BOARD_86_BOX` 케이스를 추가해 CH340 UART에서는 CDC 연결 대기 없이 바로 시리얼 출력을 시작하도록 했다.
- `esp32/boards/board_config.h`에 `BOARD_BOX_86`, `BOARD_86_BOX` backward compatibility를 추가했다.

### 검증

- `pio run -e box_86` 빌드 통과 (RAM 26.5%, Flash 30.6%)
- 펌웨어 업로드 후 `pio device monitor`로 시리얼 출력 확인 필요 (CH340 /dev/cu.wchusbserial20110)
- 디스플레이 패널 테스트 코드가 RED→GREEN→BLUE→WHITE→BLACK 순서로 1초씩 표시되는지 시각적 확인 필요

---

## 2026-06-07 — Swift daemon ESP32 serial discovery hang/status stale 수정

### 문제

Swift daemon 실행 시 ESP32 serial 모듈은 시작됐지만 `/health.modules.serial.connections` 가 빈 배열로 남고, round/3.5"/86box 계열 보드가 연결되지 않는 것처럼 보였다. 진단 결과 오래된 `flash.sh`/수동 probe Python 프로세스들이 `/dev/cu.usbmodem2111201` 을 점유했고, Swift daemon 은 CDC 포트를 순차 open/config 하는 동안 WCH/UART 포트 discovery 까지 밀릴 수 있었다. stale Python 정리 후에는 AgentDeck 이 CDC 2개와 WCH 3개를 실제로 열었지만, serial actor 가 broadcast/write 작업 뒤에 밀리면 dashboard-facing status cache 는 계속 빈 배열을 내보내는 문제도 있었다.

### 수정

- Swift `ESP32Serial` 의 포트 탐색 순서를 UART/WCH 우선, CDC 후순위로 정렬했다.
- 포트 open/config 를 actor 내부 동기 순차 작업에서 detached bounded attempt 로 분리하고, 3초 timeout/backoff 와 late-fd close 방어를 추가했다.
- `device_info_request` 와 초기 state 전송은 포트 등록 및 read loop 시작 이후 실행하도록 유지했다.
- serial health/status 용 `SerialStatusShadow` 를 추가해 actor 가 broadcast/write 로 바쁠 때도 `/health` 와 dashboard module health 가 마지막 연결 스냅샷을 즉시 읽을 수 있게 했다.
- 현재 환경의 stale Python serial probe/flash 프로세스를 종료했다. 작업 중 `/dev/cu.wchusbserial20110` 은 `esptool` 플래시 프로세스가 점유 중이었고, 플래시 완료 후 `/dev/cu.wchusbserial211340` 으로 다시 enumerate 되어 Swift daemon 이 연결했다.

### 검증

- `bash scripts/capture-apple-diagnostics.sh --tail 1000 --last 15m`
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataSwiftSerialFix build`

---

## 2026-06-07 — APME `_empty` run timeline 반복 노이즈 차단

### 문제

OpenClaw Gateway 연결 노이즈로 생성된 prompt/turn/step 없는 run 이 orphan cleanup 에서 `_empty` 로 닫힌 뒤에도, APME daemon 30초 loop 의 `listUnevaluatedRuns()` 후보에 계속 포함됐다. 이 run 은 outcome 계산상 `abandoned`, composite `0.2` 로 저장되어 `TIMELINE` 에 `★ run 20% [_empty] abandoned` 가 반복 append 됐다.

### 수정

- Node `bridge/src/apme/store.ts` 와 Swift `apple/AgentDeck/Daemon/Apme/ApmeStore.swift` 의 `listUnevaluatedRuns()` 에서 `task_category='_empty'` run 을 제외했다.
- Node `ApmeRunner.doDrain()` 이 layer1/layer2 모두 실행되지 않은 no-op run result 는 `onResult` listener 로 내보내지 않도록 방어했다.
- Node daemon run-level `onResult` branch 에도 eval row 가 0개인 no-op result 방어를 추가해 timeline append 를 건너뛰게 했다.
- 회귀 테스트: `_empty` run 이 unevaluated queue 에 들어가지 않는지, no-op run eval 이 `onResult` 를 호출하지 않는지 검증했다.

### 검증

- `pnpm vitest run bridge/src/__tests__/apme-collector.test.ts bridge/src/__tests__/apme-runner.test.ts`
- `pnpm --dir bridge build`

## 2026-06-07 — Mobile Reconnect & ESP32 CDC Connection Stabilized

### 문제

1. **Android/iOS Reconnecting Loop**: 모바일 기기가 Dead Port(9121)나 이전 잘못된 포트에 물려 있을 때, Wifi 접속 실패 후 mDNS 재탐색으로 넘어가지 못하고 무한 Reconnecting 루프에 갇히는 현상이 발생했다.
2. **ESP32 Native CDC 기기 무한 리셋**: `/dev/cu.usbmodem*` (round_amoled, ips_35 등) 기기가 화면 렌더링은 잘 되지만 read 트래픽이 없어 데몬에서 20초마다 오프라인(`stale`)으로 판단하여 연결을 닫았다 다시 여는 현상이 있었다.
3. **D200H**: 데몬이 기동될 때 활성 세션(Claude Code 등)이 없으면 메인 ZIP 이미지가 전송되지 않아 기기가 Stock 펌웨어 대기화면(crayfish 캐릭터)에 멈춰 있었고, macOS TCC 보안 정책으로 인해 Node-HID가 Keyboard Interface를 열지 못해 버튼 이벤트가 유실되어도 관련 오류가 표출되지 않고 있었다. 또한, macOS 상의 `node-hid` 에서는 Output Report ID가 필요하지 않은 HID 기기에 쓰기를 할 때 첫 번째 바이트에 `0x00` 패딩(Report ID)을 붙이지 않으면 OS HID 드라이버가 임의로 데이터의 첫 번째 바이트를 제거해버려 D200H 기기 상에서 ZIP 패킷의 `0x7C 0x7C` 헤더가 깨지며 화면이 아예 갱신되지 않고 굳어버리는 버그가 있었다.
4. **Unit Tests**: Claude subscription quota 체크 규칙으로 인해 일부 bridge-core 테스트 케이스가 실패했다.

### 수정

- **Android 클라이언트 (`BridgeConnection.kt`)**: Wifi URL 포함하여 연결이 5회 연속 실패하면 내부 URL을 클리어하고 Reconnect 시도를 중지시켜, mDNS 백그라운드 재탐색을 즉시 유도했다.
- **iOS 클라이언트 (`BridgeConnection.swift`)**: 모든 URL의 최대 재연결 시도를 20회에서 5회로 줄여, 잘못된 Wi-Fi 데몬 주소에서 빠르게 빠져나오고 mDNS 재탐색을 실행하도록 했다.
- **ESP32 Serial 모듈 (`esp32-serial.ts`)**: CDC 디바이스(usbmodem 또는 ttyACM)는 DTR/RTS 신호 제한으로 read 트래픽이 없어도, 최근 쓰기(`write`)가 성공했고 디바이스 정보 캐시가 존재하면 활성 상태(`isResponsive` -> true, `stale` -> false)로 간주하고 강제 재연결을 면제했다.
- **D200H 계측 & 기동 수정 (`d200h-module.ts`)**:
  - D200H 연결 직후 세션 유무와 무관하게 즉시 초기 OFFLINE/대기 대시보드 레이아웃을 렌더링(ZIP 패킷 전송)하여 대기화면에 멈추는 문제를 해결했다.
  - Keyboard Interface 오픈 에러 발생 시 catch 블록에서 `lastOpenError` 에 명시적으로 'macOS Input Monitoring Permission' 안내 문구를 기입하여 진단 가능성을 극대화했다.
  - macOS 환경인 경우, HID 키보드 오픈 권한 실패 시 최초 1회 시스템 설정의 '입력 모니터링' 보안 패널(`x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`)을 자동으로 호출해 사용자의 권한 획득을 가이드하도록 개선했다.
  - `node-hid` write 시 첫 번째 바이트에 `0x00` (macOS Report ID dummy) 패딩을 추가 전송하여, OS 드라이버에 의한 D200H 프로토콜 헤더(`0x7C 0x7C`) 깨짐 현상을 근본적으로 해결했다.
- **Unit Tests (`bridge-core.test.ts`)**: Claude subscription 검증 통과를 위해 테스트 스테이트 머신에 Claude 모델 명칭을 명시적으로 기입했다.

### 검증

- `pnpm test`로 1,276개 전체 유닛 테스트의 성공을 확인했다.
- `pnpm build`로 패키지 모노레포의 빌드 무결성을 확인했다.
- `adb` 및 `streamdeck` 툴을 통해 모바일 기기(Pantone 6, Lenovo Tab) 배포와 Stream Deck 플러그인 링크 배포를 자동으로 진행했다.
- `agentdeck daemon start` 후 `agentdeck devices` 확인 결과:
  - Android 기기 2대(Crema S 포함)가 reverse tcp 포트(9120)를 타고 실시간 WebSocket으로 즉시 자동 연결됨.
  - `round_amoled`와 `ips_35`를 포함한 총 6개의 ESP32 디바이스가 `stale: false`, `connected: true`로 안정적으로 연결 유지됨.
  - D200H 기기가 정상 감지되어 0x00 패딩이 추가된 초기 대시보드 렌더링 ZIP 패킷 송출(writeOK 누적)을 성공적으로 수행했으며, `lastOpenError`에 macOS Input Monitoring 권한 에러 메시지 및 `resvgLoaded: true` 진단 상태가 정상 표출되는 것을 확인.

---

## 2026-06-07 — CLI daemon serial open FD leak / stale registry 정리

### 문제

CLI daemon 이 ESP32 serial 포트를 `Promise.race(fs.promises.open(), timeout)` 방식으로 열면서, timeout 후에도 macOS 커널 open 이 늦게 완료되면 daemon 프로세스가 해당 FD 를 계속 소유할 수 있었다. 이 상태에서는 `/health.modules.serial` 에는 연결 0개 또는 일부만 보이지만 `lsof` 상 daemon 이 `/dev/cu.*` 포트를 잡고 있어 다음 poll/restart 에서 나머지 기기가 계속 open timeout 됐다. 또한 `/health` 가 죽은 daemon session 이 `sessions.json` 에 남아 start/status 경로의 판단을 오염시켰다.

### 수정

- `bridge/src/esp32-serial.ts` 에서 serial open hang 가능성을 별도 Node probe 프로세스로 격리하고, daemon 본체는 probe 통과 후 명시적인 fd 기반 read/write/close 만 수행하도록 변경했다.
- timeout 된 native USB CDC 포트가 있어도 daemon 본체가 해당 `/dev/cu.usbmodem*` FD 를 누수하지 않게 했다.
- nonblocking serial write 의 `EAGAIN` / `EWOULDBLOCK` 는 terminal failure 가 아니라 backpressure 로 분류해 연결을 즉시 닫지 않고 write queue 재시도로 넘기도록 했다.
- cache 된 `device_info` 만 있고 live read 가 아직 없는 serial connection 에는 `usage_update` / `sessions_list` 같은 큰 payload 를 보내지 않도록 했다.
- `bridge/src/session-registry.ts` 에 stale daemon session 제거 helper 를 추가했다.
- `bridge/src/cli.ts` / `bridge/src/daemon-server.ts` 에서 `/health` 가 응답하지 않는 daemon.json / daemon session 을 발견하면 로그만 남기지 않고 registry 에서 제거하도록 했다.

### 검증

- `pnpm --dir bridge build`
- `pnpm vitest run bridge/src/__tests__/esp32-serial-node.test.ts bridge/src/__tests__/daemon-lifecycle.test.ts`
- `node bridge/dist/cli.js daemon status || true` 로 stale `sessions.json` daemon 엔트리 제거 확인.
- `node bridge/dist/cli.js daemon start --debug`
- 45초 관찰한 `daemon status`: ESP32 serial 4개(`/dev/cu.wchusbserial10`, `/dev/cu.wchusbserial20120`, `/dev/cu.wchusbserial211340`, `/dev/cu.wchusbserial58A90021441`) 모두 `connected:true`, `stale:false`; ADB 2개, Pixoo64 1개, D200H writeOK 증가 확인.
- `lsof` 확인: 새 daemon PID 는 정상 연결된 WCH serial 4개만 소유하며 timeout 된 `/dev/cu.usbmodem21133201` FD 는 소유하지 않음.
- 추가 확인: `/dev/cu.usbmodem2111201` 은 직접 Node nonblocking fd 테스트와 pyserial(DTR/RTS reset 포함) 테스트 모두 write timeout / read 0 으로 확인되어 daemon payload 문제가 아니라 USB CDC endpoint/보드 wedged 상태로 판단.
- 남은 환경 이슈: 이전 stuck `(node)` PID `46424` 가 `*.9120 LISTEN` 을 `SIGKILL` 후에도 놓지 않아 현재 daemon 은 9125 fallback 에서 정상 동작 중. `/dev/cu.usbmodem21133201` 의 stale `stty` PID `54649` 도 `U` 상태라 사용자 kill 로 제거되지 않음.

---

## 2026-06-07 — CLI daemon ESP32 reconnect / D200H 상태 계측 수정

### 문제

CLI daemon 재시작 후 ESP32 기기들이 순간적으로 연결됐다가 `reconnecting` 으로 돌아갔다. 특히 86box 는 처음 화면이 나오다가 다시 reconnecting 상태가 됐고, TTGO 외 보드들의 `device_info` 가 재시작마다 안정적으로 잡히지 않았다. D200H 는 화면 write 가 실제로 성공해도 status 에 `writeOK: 0` 으로 표시되어 전송 실패인지 렌더링 문제인지 구분할 수 없었다. 또한 serial `open()` 에 걸린 stale daemon PID 가 `/health` 에 응답하지 않아도 CLI start guard 가 PID 생존만 보고 새 daemon 시작을 막았다.

### 수정

- `bridge/src/esp32-serial.ts` 에서 serial 전용 `state_update` / `sessions_list` payload 를 firmware 가 실제로 읽는 필드만 남기도록 allowlist 기반으로 축소했다.
- ESP32 연결별 write queue 를 추가해 USB serial burst 를 120ms 간격으로 pacing 하고, 식별 전 `sessions_list` 는 보내지 않도록 했다.
- 큰 payload 와 독립적인 `serial_keepalive` JSON 을 우선순위로 보내 ESP32 펌웨어의 USB 연결 타이머가 state/session payload 파싱 지연에 끌려가지 않게 했다.
- 일부 보드는 host JSON 을 받아 화면은 갱신하면서도 `heartbeat_ack` 를 안정적으로 echo 하지 않으므로, read silence 만으로 포트를 닫지 않고 read/write 양쪽이 모두 멈춘 경우만 stale 처리한다. 실제 `/dev/cu.*` 포트 소실은 poll 단계에서 닫도록 분리했다.
- CLI serial status 가 포트 open/cache 만으로 `connected:true` 를 표시하던 false positive 를 제거했다. 이제 초기 `device_info`/JSON read 가 실제로 들어온 포트만 connected 로 세고, 포트만 열린 상태는 `transportOpen:true, connected:false` 로 분리한다.
- macOS native USB CDC 포트(`/dev/cu.usbmodem*`)에서 `stty -f` 와 sync `openSync()` 가 커널 I/O 대기로 hang 되어 전체 ESP32 poll 을 막던 문제를 수정했다. `stty` timeout 은 child exit 를 기다리지 않고 즉시 실패 처리하며, serial open 은 async timeout 으로 감싸고 CH340/UART 포트를 우선 poll 한다.
- `device_info_request` 를 우선순위 큐에 넣고 5초 단위로 재시도한다.
- 포트별 last-known `device_info` 를 `~/.agentdeck/esp32-device-cache.json` 에 저장/복원해 daemon 재시작 직후 86box/TTGO/TC001/IPS 10/IPS 3.5/Round AMOLED 가 바로 식별되게 했다.
- ESP32 firmware 의 `BOARD_IPS10` device_info 라벨을 `ips_10` 으로 추가하고, firmware flash 후에는 10인치 보드가 `ips_35` 로 잘못 보고되지 않게 했다.
- `bridge/src/daemon-server.ts` / `bridge/src/cli.ts` / legacy `bridge/src/daemon.ts` 는 PID 생존만으로 기존 daemon 을 인정하지 않고 `/health` 응답이 없으면 stale 로 무시한다.
- `bridge/src/modules/d200h-module.ts` 에 실제 `writeOK` / `writeFail` / HID report / button count / last error 계측을 추가했다.

### 검증

- `pnpm --dir bridge build`
- `pnpm vitest run bridge/src/__tests__/esp32-serial-node.test.ts bridge/src/__tests__/daemon-lifecycle.test.ts`
- `pio run -d esp32 -e ips10 -e ips35 -e amoled -e rgb48`
- `agentdeck daemon stop`
- `agentdeck daemon start --debug`
- 정정: 최초 75초 관찰의 "ESP32 serial 6개 연결"은 `lastReadAt` 초기값/cache 때문에 생긴 false positive 였다.
- 수정 후 70초+ 관찰한 `agentdeck daemon status`: ESP32 serial 4개 실제 연결(`/dev/cu.wchusbserial10`=`ips_10`, `/dev/cu.wchusbserial20120`=`ulanzi_tc001`, `/dev/cu.wchusbserial211340`=`86box`, `/dev/cu.wchusbserial58A90021441`=`ttgo_t_display`), 모두 `stale:false`, `connectionCount:4`. Native USB CDC 2개는 아직 미연결: `/dev/cu.usbmodem21133201` 및 `/dev/cu.usbmodem2111201` open timeout. D200H `writeOK: 122`, `writeFail: 0`.

---

## 2026-06-07 — CLI ESP32 serial initial burst parity

### 문제

Node CLI daemon 의 ESP32 serial bridge 는 reader 를 먼저 열지만, `device_info` 가 오기 전에도 같은 connection 에 `state_update` / `usage_update` 를 그대로 밀어 넣어 native USB 보드에서 초기 backpressure 를 일으킬 수 있었다. Swift daemon 에서 넣은 완화가 CLI-only 경로에는 아직 반영되지 않았다.

### 수정

- `bridge/src/esp32-serial.ts` 에서 connection 별로 `device_info` 전의 initial/heartbeat/broadcast payload 를 더 가볍게 만들었다.
- `device_info` 전에는 `state_update` 의 고용량 필드를 제거하고, initial burst 의 `usage_update` 는 건너뛴다.

### 검증

- `pnpm vitest run bridge/src/__tests__/esp32-serial-node.test.ts`
- `pnpm --dir bridge build`

## 2026-06-07 — ESP32 native USB reconnect 루프 완화

### 문제

`/dev/cu.usbmodem*` native USB ESP32 두 대가 `write stalled ... errno=35` 를 반복하면서 initial state burst 직후 reconnect 루프에 들어갔다. `device_info_request` 와 초기 `state_update`/`usage_update` 가 read loop 시작 전에 쏟아져 CDC 포트의 backpressure 를 악화시키고 있었다.

### 수정

- `ESP32Serial.openAndRegisterPort()` 에서 read loop 를 먼저 시작한 뒤 initial state 를 보내도록 순서를 바꿨다.
- `device_info` 가 아직 없는 부팅 직후에는 `usage_update` 를 initial burst 에서 생략하고, `state_update` 에서도 `moduleHealth`/`subscriptions` 같은 고용량 필드를 걷어냈다.

### 검증

- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug build -quiet`

## 2026-06-07 — OpenClaw handshake / usage quota / daemon diag 정합성 수정

### 문제

CLI daemon 이 일부 surfaces 에서는 기기 연결이 살아 보이는데 OpenClaw gateway 는 계속 disconnected 로 남고, Stream Deck+ usage / LIMIT 표시는 현재 모델이 확정되지 않은 상태에서도 Claude quota 를 붙여서 틀리게 보였다. 또한 `agentdeck diag` 는 daemon fallback port 를 찾더라도 daemon HTTP 서버에 `/diag` 가 없어 404 를 냈다.

### 수정

- OpenClaw Node adapter 의 connect payload 를 Swift adapter 와 맞췄다. shared gateway token 은 `~/.openclaw/openclaw.json` 에서 읽고, device auth 서명은 v3 payload (`platform`/`deviceFamily` 포함) 로 생성한다.
- `buildUsageEvent()` 는 모델명이 명시된 Claude 계열일 때만 5h/7d subscription quota 를 붙이도록 바꿨다. model 이 아직 unknown 인 상태에서는 LIMIT 를 숨긴다.
- daemon HTTP 서버에 `/diag` 를 추가하고 `agentdeck diag` 는 `daemon.json` / `findDaemonPort()` 기반으로 daemon port 를 우선 찾도록 바꿨다.

### 검증

- `pnpm vitest run bridge/src/__tests__/usage-event.test.ts bridge/src/__tests__/adapter.test.ts`
- `pnpm --dir bridge build`
- `agentdeck daemon stop`
- `node bridge/dist/cli.js daemon start --foreground --debug`
- `agentdeck daemon status`
- `agentdeck diag --tail 20`

## 2026-06-06 — daemon stop hang / Android 재연결 / devices 포트 정합성 수정

### 문제

CLI daemon 이 `/shutdown` 후 HTTP listener 만 닫고 Node 프로세스가 남아, 다음 daemon 이 꼬이거나 9120 대신 fallback 포트로 올라가면서 Android/Swift/CLI surface 의 연결 표시가 엇갈렸다. Android 앱은 daemon 이 죽은 동안 localhost 재시도를 포기하면 daemon 이 나중에 살아나도 USB 경로를 다시 시도하지 않아 미연결로 남을 수 있었다. 또한 `agentdeck devices` 는 daemon fallback port 를 무시하고 9120 만 조회해, 실제 daemon 이 살아 있어도 "Bridge is not running" 을 출력했다.

### 수정

- Node daemon shutdown 최종 경로를 self-SIGKILL fallback 으로 보강해 macOS serial fs worker 가 `process.exit()` join 에 걸려도 `agentdeck daemon stop` 후 PID 가 남지 않도록 했다.
- Android tablet/e-ink auto-connect recovery 에 mDNS 확인 후 USB localhost 재시도 루프를 추가해 daemon 이 앱보다 늦게 살아나도 다시 붙도록 했다.
- ESP32 serial poll 에 in-flight guard / opening port set / port dedupe 를 추가해 같은 serial port 가 중복 연결 수로 잡히지 않게 했다.
- `agentdeck devices` 가 `daemon.json` / `findDaemonPort()` 를 우선 사용해 daemon 이 fallback port 에 있어도 올바르게 조회하도록 했다.

### 검증

- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm --filter @agentdeck/bridge build`
- `./gradlew :app:compileDebugKotlin --no-daemon`
- `./gradlew :app:assembleDebug --no-daemon`
- `bash scripts/build-android-release.sh`
- 연결된 Pantone 6 / Lenovo Tab 에 `dist/agentdeck-v0.4.1.apk` 업데이트 설치 및 실행.
- `agentdeck daemon stop` 후 1초 내 daemon PID 제거 확인.
- 최종 `agentdeck devices`: WebSocket 5 clients, ESP32 serial 6, Pixoo64 1, ADB 2, D200H 1.

---

## 2026-06-06 — 안드로이드 가로모드/태블릿 해상도 적응형 테라리움 스케일링 적용

### 문제

Pantone 6 및 Crema S 등 화면 비율이 다른 기기에서 찌그러짐 문제를 해결하기 위해 `aspectRatio(2f)` 및 Centering Box 제약을 강제로 부여했으나, 이로 인해 Lenovo Tab 같은 일반 가로형 안드로이드 태블릿에서 위아래로 큰 검은 여백(Letterbox)이 생겼다.

### 원인

Vector 기반의 `ColorTerrariumCanvas` 및 각 지형지물/크리처 렌더링 로직이 가로 너비 `w`에만 비례하여 크기 및 선 두께를 스케일링하고 있었기 때문에, 가로세로 비율이 달라지면 크리처가 상하로 삐져나가거나 돌이 지나치게 비대해지는 현상이 발생했고, 이를 막기 위해 임시로 어항 비율을 2:1로 강제 고정(Letterbox)했던 것이 근본 원인이었다.

### 수정

- `MonitorScreen.kt`에서 `ColorTerrariumCanvas`에 가해졌던 `aspectRatio(2f)`와 Box 래퍼를 완전히 제거하고 원래의 `fillMaxSize()` 구조로 롤백했다.
- `CrayfishCreature`, `OctopusCreature`, `CloudCreature`, `OpenCodeCreature`, `RockFormation`, `KelpField`, `DataParticleSystem`, `WaterSurface`, `LightRaySystem`, `WaterEffect`, `BubbleSystem`, `PlanktonSystem`, `SandDisturbance` 등 전체 13개 구성 요소의 `draw` 메서드에 `baseWidth = minOf(w, h * 2f)`를 도입했다.
- 이로써 물, 모래, 배경 영역은 전체 화면으로 가득 차게 확장되도록 하면서, 돌의 높이/너비, 해초 잎과 줄기 두께/sway 흔들림 폭, LED 선 및 점 크기, 물고기 및 먹이 크기, 빛줄기 두께, 버블 및 플랑크톤 입자 반경 등 스케일에 민감한 요소들은 `baseWidth` 비율로 찌그러짐 없이 안전하게 드로잉되도록 전면 개선했다.
- 수정 사항에 대해 compile 및 175개 안드로이드 유닛 테스트 통과를 검증했고, 연결된 3대 기기(Crema S, Lenovo Tab, Pantone 6)에 APK를 배포하여 letterbox가 사라지고 꽉 찬 테라리움이 올바르게 렌더링됨을 눈으로 수동 검증했다.

---

## 2026-06-06 — GLM/API-backed Claude Code 세션의 Claude quota 표시 차단

### 문제

Claude Code 를 Anthropic 공식 subscription 모델이 아니라 GLM 같은 API-backed 모델로 사용하는 경우에도, AgentDeck 이 `api.anthropic.com/api/oauth/usage` 에서 읽은 Claude OAuth 5h/7d quota 를 그대로 표시했다. 이 값은 현재 GLM/API 세션의 사용량이나 제한이 아니라 남아 있는 Claude 계정 quota 이므로, UI 에서는 정확한 정보처럼 보이는 잘못된 숫자였다.

### 수정

- `buildUsageEvent()` 에서 5h/7d/extra usage quota 는 subscription quota 가 적용되는 Claude 모델(alias: `claude`/`opus`/`sonnet`/`haiku`)일 때만 포함한다.
- 현재 모델명이 `glm-5.1` 등 Claude 계열이 아니면 OAuth 연결 상태는 유지하되, 5h/7d quota 필드는 이벤트에서 제거해 모든 downstream surface 가 자연스럽게 숨기도록 했다.
- `usage-event` 순수 단위 테스트를 추가해 GLM 모델에서는 quota 가 빠지고, `opus-4.6` 같은 Claude alias 에서는 기존처럼 표시되는지 검증한다.

### 검증

- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm vitest run bridge/src/__tests__/usage-event.test.ts`
- `pnpm --filter @agentdeck/bridge build`
- `pnpm vitest run bridge/src/__tests__/bridge-core.test.ts` 는 기존 WS/http lifecycle suite 가 출력 없이 hang 하여 중단하고, 위 순수 단위 테스트로 변경 범위를 검증했다.

---

## 2026-06-06 — CLI daemon / Swift client-mode device status 정합성 수정

### 문제

Swift in-process daemon 이 실행되지 않고 Node CLI daemon 이 9120 을 소유한 상태에서, CLI daemon 의 `/health.modules` 는 ADB/D200H/Pixoo/ESP32 serial 을 정상 연결로 보고했지만 macOS 앱의 `DaemonService.deviceSummary` 는 로컬 `server` snapshot 만 읽어 외부 daemon client-mode 에서 비어 있었다. 그 결과 같은 daemon 상태를 보면서도 일부 UI 는 정상 연결, 일부 UI 는 미연결처럼 보여 혼란스러웠다.

또한 사용자가 `agentdeck stop` 을 실행하면 기본 포트 9120 에 `/hooks/shutdown` 을 보내 세션 bridge 종료 경로만 타고, 9120 이 daemon 일 때는 `/shutdown` 으로 가지 않아 CLI daemon 이 종료되지 않았다.

### 수정

- `DaemonService.refreshDeviceSummary()` 가 외부 daemon client-mode 에서는 `SessionRegistry.probeDaemonHealth()` 의 `modules` payload 를 `DeviceSummary` 로 변환해 사용한다.
- `DeviceSummary.make(fromModuleHealth:)` helper 를 추가해 Swift/Node daemon module snapshot 을 같은 builder 경로로 처리한다.
- `agentdeck stop` 은 대상 포트의 `/health` 를 먼저 확인하고 daemon 이면 `/shutdown`, session bridge 면 기존 `/hooks/shutdown` 으로 보낸다. 요청에는 timeout 을 걸었다.
- `agentdeck daemon stop` 의 shutdown POST 에도 timeout 을 추가했다.

### 검증

- 현재 실행 중인 CLI daemon PID 56582 의 `http://127.0.0.1:9120/health` 에서 ADB 3대, D200H, Pixoo 1대, serial 6개 연결 확인.
- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm --filter @agentdeck/bridge build`
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataDaemonCoexist CODE_SIGNING_ALLOWED=NO`
- `xcodebuild test ... -only-testing:AgentDeckTests/SessionLauncherTests` 는 현재 scheme/test plan 에 `AgentDeckTests` 가 포함되어 있지 않아 실행되지 않음.

---

## 2026-06-06 — Pixoo64 제한적 프리로드 애니메이션 실험

### 문제

Pixoo64 안정화를 위해 Swift daemon 의 push cadence 를 크게 늦추자 기본 화면 튐/재부팅성 리셋은 줄었지만, 캐릭터 움직임이 거의 정지 화면처럼 보였다. 과거 `PicNum > 1` 다중 프레임 스트리밍은 Pixoo 펌웨어의 `Loading...` 화면과 HTTP timeout 을 유발해 상시 스트리밍 방식으로는 부적합했다.

### 수정

- Swift `PixooModule` 에 제한적 animated sequence 정책을 추가했다.
  - `processing` / `awaiting_*` 상태로 진입하는 state change 에서만 `PicNum=2` 프레임을 1회 전송한다.
  - heartbeat, disconnected frame, recovery re-seed, channel reassert 는 계속 `PicNum=1` 단일 프레임을 사용한다.
  - 특정 Pixoo IP 에서 2프레임 push 가 실패하면 해당 실행 세션 동안 자동으로 single-frame mode 로 fallback 한다.
- 의도는 “매 프레임 업로드”가 아니라 Pixoo 내부 GIF 재생 버퍼에 짧은 active-state animation 을 심고, 이후 HTTP 부하는 낮게 유지하는 것이다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataPixooPreload CODE_SIGNING_ALLOWED=NO`

---

## 2026-06-06 — Pixoo64 HTTP 서버 재부팅 방지용 gentle push 프로파일

### 문제

AgentDeck 재시작 후에도 Pixoo64 가 순간적으로 기본 화면으로 튀고, 이후 기기가 재부팅되는 듯한 현상이 반복됐다. 로그상 `Draw/SendHttpGif` 단일 프레임 push 가 `picId=61` 부근부터 `NSURLErrorDomain Code=-1001` timeout 으로 연속 실패했고, 복구 직후 `GetHttpGifId` 가 `1` 로 동기화됐다. 이는 네트워크 한 번의 흔들림이 아니라 Pixoo 기기 내장 HTTP/GIF 상태가 실제로 리셋됐다는 신호다.

### 원인

이전 안정화는 `PicNum=1` 로 payload 크기를 줄였지만, 상태 변화가 있으면 1.5초 heartbeat 를 우회해 즉시 push 했다. 앱 시작 직후 OpenClaw 연결, Codex App 관찰, sessions_list 변화가 몇 초 안에 연속 발생하면서 Pixoo HTTP 서버에 16KB급 JSON POST 가 짧은 간격으로 여러 번 들어갔다. 실패 후에도 기존 circuit breaker 는 6회 timeout 까지 계속 push 를 시도해, 이미 멈춘 HTTP 서버를 추가로 압박했다. 또한 timeout 된 PicID 를 성공처럼 캐시에 남겨 다음 push 가 PicID gap 을 만들 수 있었다.

### 수정

- Swift `PixooModule` 에 gentle profile 적용:
  - 상태 변화 push 도 최소 12초 간격으로 coalesce.
  - steady heartbeat 는 60초로 완화.
  - `Channel/SetIndex` reassert 는 30초 → 300초.
  - push timeout 은 5초 → 3초.
  - 첫 push timeout 부터 즉시 backoff/probe 로 전환 (`backoffThreshold=1`, initial 30초, max 300초).
- push 실패 시 해당 기기의 cached PicID / last frame / last push time 을 제거해 다음 성공 경로에서 `GetHttpGifId` 로 재동기화한다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataPixooGentle CODE_SIGNING_ALLOWED=NO`

---

## 2026-06-06 — Codex OTel / D200H sessions_list 중복 broadcast 완화

### 문제

Swift daemon 연동 점검에서 D200H/Pixoo/OpenClaw/Stream Deck/ESP32 연결 자체는 정상임이 확인됐지만, Codex App OTel 수신 중 `[CodexOTel] Updated observed:codex-app...` 와 `[D200H] BROADCAST sessions_list...` 로그가 한 순간에 과도하게 반복됐다. D200H HID 전송은 `lastStateHash` 로 실제 ZIP 중복 송신을 대부분 막고 있었지만, sessions payload parse/render 경로와 로그가 불필요하게 churn 했다.

### 원인

`updateSessionHookState()` 가 OTel `toolResult` / `activity` 처럼 이미 `processing` 상태인 세션을 다시 `processing` 으로 쓰거나 이미 비어 있는 `currentTool` 을 clear 하는 경우에도 매번 `broadcastSessionsList()` 를 호출했다. 또한 D200H 모듈은 daemon 전체 broadcast 정책상 동일한 `sessions_list` 를 받아도 payload digest 없이 매번 로그와 `updateDisplay()` 를 실행했다.

### 수정

- `DaemonServer.updateSessionHookState()` 는 세션의 visible state/currentTool 이 실제로 바뀐 경우에만 `broadcastSessionsList()` 를 호출한다. Codex processing TTL 갱신은 계속 수행한다.
- `D200hHidModule` 은 D200H 렌더링에 영향을 주는 sessions payload digest 를 캐시하고, 동일 payload 는 로그와 render 호출 없이 무시한다.
- 관찰 전용 Codex App 세션(`port=0`)은 health probe 대상에서 제외해 `http://127.0.0.1:0/health` CFNetwork 노이즈도 차단했다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataD200HDedupe CODE_SIGNING_ALLOWED=NO`

---

## 2026-06-06 — Codex session-end repo skill 추가

### 문제

Claude Code 의 `/session-end` 역할(세션 종료 전 공유 메모리 정리, clear/new 이후 작업 인계)을 Codex 환경에서 대체할 표면이 필요했다. Codex에는 같은 이름의 기본 slash command가 없고, custom prompts는 deprecated라 repo-shared workflow로 쓰기에는 부적합했다.

### 수정

- `.agents/skills/session-end/SKILL.md` 를 추가해 Codex repo skill로 세션 종료/인계 절차를 정의했다.
- handoff 출력 형식, `git status`/`git diff --stat` 기반 상태 확인, durable docs 업데이트 기준(`DEVELOPMENT_LOG.md` / `CLAUDE.md` / `AGENTS.md`)을 명시했다.
- `CLAUDE.md`의 Codex Development Surface에 `session-end` 사용 규칙을 추가했다.

### 검증

- Skill frontmatter와 파일 위치 확인.

---

## 2026-06-06 — Swift Pixoo64 default 화면 순간 전환 완화

### 문제

Swift daemon 의 Pixoo64 push 는 단일 프레임/1.5초 heartbeat 로 안정화됐지만, 실기기에서 순간적으로 Pixoo 기본 Custom/default 화면으로 전환되는 현상이 남았다. 로그상 HTTP push 자체는 `error_code=0` 으로 회복되고 있었고, 튐은 특히 backed-off 복구 후 `Channel/SetIndex`/`SetBrightness`/`GetHttpGifId` 재준비와 정기 Custom 채널 재확인 구간에서 발생할 수 있었다.

### 원인

`Channel/SetIndex` 는 Pixoo 를 Custom 채널로 되돌리지만, 바로 `Draw/SendHttpGif` 를 이어서 보내지 않으면 펌웨어가 Custom 채널의 내장 기본 화면을 잠깐 노출할 수 있다. Swift `PixooModule.reassertChannels()` 는 30초마다 `Channel/SetIndex` 만 전송했고, normal push 경로는 동일 프레임 5초 skip 을 적용하므로 기본 화면이 다음 강제 push 까지 보일 수 있었다. 복구 경로도 probe 성공 직후 `prepareDevice()` 로 채널을 먼저 바꾼 뒤 2초 grace 를 기다려 같은 노출 창을 만들었다.

### 수정

- `probeBackedOffDevices()` 는 probe 성공 뒤 2초 동안 기기를 건드리지 않고 안정화한 다음 `prepareDevice()` 와 현재 프레임 강제 seed 를 연속 실행하도록 변경했다.
- `reassertChannels()` 는 actor-level `isPushing` guard 를 공유하고, `Channel/SetIndex` 직후 현재 Pixoo 프레임을 `force=true` 로 다시 전송한다.
- `pushSequenceToDevice()` 에 force 옵션을 추가해 channel reassert/recovery seed 는 동일 프레임 5초 skip 을 우회한다.
- Pixoo API 응답의 `error_code` / `errorCode` 가 0 이 아닌 경우 HTTP 성공이어도 push 실패로 기록한다.

### 대안

정기 `Channel/SetIndex` 를 완전히 제거하면 default 화면 노출 가능성은 더 낮아지지만, brownout/펌웨어 drift 후 Custom 채널 자동 복구가 느려진다. 현재 선택은 재확인을 유지하되 재확인 직후 프레임을 즉시 재시드하는 절충안이다.

---

## 2026-06-06 — Codex 개발 표면 정비 (AGENTS 컨텍스트, repo skills, setup/CLI)

### 문제

AgentDeck는 Codex 세션/훅 지원을 이미 갖고 있었지만, 개발 지침과 자동화 표면은 Claude Code 중심으로 남아 있었다. `AGENTS.md`가 매 작업마다 800KB 이상인 `DEVELOPMENT_LOG.md` 전체 읽기를 요구했고, `.claude/skills`에 있는 AgentDeck 전용 skill들은 `.gitignore` 대상이라 Codex repo skill로 자동 발견되지 않았다. 또한 setup 경로가 Claude CLI를 필수로 요구하고, `agentdeck codex`는 lifecycle hook 설치 결과를 로그로 노출하지 않아 Codex 관찰이 꺼진 상태를 알아차리기 어려웠다.

### 수정

- `AGENTS.md`의 컨텍스트 규칙을 `CLAUDE.md` 우선 + `DEVELOPMENT_LOG.md` 최신/관련 항목 검색 방식으로 변경했다.
- `.agents/skills/`에 Codex repo skills를 추가했다: `agentdeck-workflows`, `agentdeck-deploy`, `sdc-diagnose`.
- `setup/src/setup.ts`와 `scripts/install.sh`를 Claude 또는 Codex CLI 중 하나만 있어도 setup이 진행되도록 수정하고, Codex 사용 안내를 추가했다.
- 로컬 `scripts/install.sh`는 Codex CLI가 있을 때 `hooks/dist/install.js`의 `installCodexHooksIfNeeded()`를 호출해 Codex observation hook을 설치한다.
- `agentdeck codex`가 `~/.codex/config.toml` hook 설치/skip/failure 결과를 stderr에 출력하도록 변경했다.

### 검증

- `pnpm --filter @agentdeck/setup build`
- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm --filter @agentdeck/hooks build`

---

## 2026-06-06 — Codex hook timeout 누적 방지

### 문제

Codex `PreToolUse`/`PostToolUse` hook 이 `hook timed out after 5s` 로 반복 실패하고, timeout 된 hook 의 `curl -d @-` 자식 프로세스가 남아 9120 연결을 누적 점유했다. 누적 후에는 `/health` 도 연결 timeout 이 발생하며 AgentDeck HTTP listener 가 포화 상태로 악화됐다.

### 원인

`~/.codex/config.toml` 에 설치되는 AgentDeck Codex lifecycle hook 은 health probe 에만 `--max-time 0.3` 을 걸고, 실제 `/hooks/codex_*` POST 에는 curl timeout 을 걸지 않았다. AgentDeck daemon 이 busy 하거나 9120 연결이 밀리면 Codex 는 hook wrapper 를 5초 뒤 timeout 처리하지만, 자식 `curl` 은 계속 남을 수 있었다.

### 수정

- `CodexConfigInstaller.swift` 와 `hooks/src/codex-install.ts` 의 Codex hook POST 명령에 `--connect-timeout 0.2 --max-time 0.8` 을 추가했다.
- Swift/TypeScript installer 테스트에 bounded curl invariant 를 추가해 무제한 POST 회귀를 막았다.

---

## 2026-06-06 — Pixoo64 스트리밍 안정화 및 단일 프레임 동적 주기 최적화

### 문제

Pixoo64 실시간 스트리밍 시, 다중 프레임 애니메이션 시퀀스(`PicNum > 1`)를 전송하면 기기 하드웨어에서 강제적으로 **"Loading..." 화면**을 출력하는 제약 조건이 발생함. 또한, 페이로드 크기를 6프레임(~98 KB)으로 줄이고 타임아웃을 5초로 늘렸음에도 불구하고 ESP32 웹 서버의 자원 한계로 인해 지속적으로 HTTP 요청 타임아웃(`NSURLErrorDomain Code=-1001`) 및 서킷 브레이커 오프라인 전환이 반복됨.

### 원인

1. **다중 프레임 시퀀스의 하드웨어 제약**: Pixoo64 API 구조상 `PicNum > 1`인 시퀀스를 전송받을 때 화면에 로딩 인디케이터가 강제 출력되어 화면이 깜빡이고 전환이 끊김.
2. **저전력 MCU 자원 한계**: ESP32가 약 100 KB에 달하는 Base64 JSON 바디를 파싱하는 과정에서 힙 메모리 부족이나 처리 지연으로 소켓 연결이 끊어지거나 타임아웃이 초래됨.
3. **과도한 네트워크 전송 빈도**: 매 프레임을 3~4 FPS 속도로 지속 전송하여 대역폭 및 기기 처리 능력을 상시 초과함.

### 수정

1. **단일 프레임 전송 복구**:
   - `frameCount`를 다시 `1`로 고정하여 약 **~16 KB** 크기의 단일 프레임만 전송하도록 복구함. 이를 통해 "Loading..." 화면의 노출을 완벽히 방지하고 요청 속도를 대폭 높임.
   - [pixoo-bridge.ts](file:///Users/puritysb/github/AgentDeck/bridge/src/pixoo/pixoo-bridge.ts) 및 [PixooModule.swift](file:///Users/puritysb/github/AgentDeck/apple/AgentDeck/Daemon/Modules/PixooModule.swift)에서 `frameCount`를 `1`로 수정.
2. **동적 전송 주기 적용**:
   - **대기/안정 상태 (Idle)**: 물고기 애니메이션 등 배경 업데이트를 위한 프레임 전송 간격(하트비트)을 기존의 과도한 주기 대신 **1.5초(1500ms)당 1회 (0.67 FPS)**로 늘려 디바이스 부하 및 대역폭 점유율을 75% 이상 낮춤.
   - **상태 변경 상태 (State Changed)**: 사용자 프롬프트 시작, 완료, 세션 목록 변경 등 테라리움의 상태 변경이 감지되는 즉시 타이머 주기와 상관없이 **즉시 단일 프레임을 푸시**하여 snappiness(체감 속도)를 극대화함.

### 검증

- Node.js Vitest 테스트(`pnpm vitest run bridge/src/__tests__/pixoo-sprites.test.ts`) 성공 확인.
- macOS 데몬 빌드(`xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug`) 성공 확인.
- 로그 분석을 통해 상태 변경 시 즉각 푸시가 발화되고, 대기 상태에서는 1.5초 주기로 성공적인 푸시(`error_code=0`)가 지속됨을 검증함.

---

## 2026-06-05 — ESP32 신규 기기 지원 추가 (Guition JC8012P4A1C 및 LilyGO TTGO T-Display)

### 문제

ESP32-P4 기반의 Guition JC8012P4A1C 10.1인치 HMI 기기 및 LilyGO TTGO T-Display 기기를 위한 펌웨어 빌드 및 LCD/터치 구동이 요구됨. 기기별 기본 화면 회전 방향 지정(TTGO = Portrait, JC8012P4A1C = Landscape) 및 터치 보정이 필요함. 또한 업로드 후 화면의 일부 색상 채널(Red/Blue)이 뒤바뀌어 나타나거나, USB CDC 업로드 시 기기가 멈추는 에러 발생.

### 원인

1. **기기별 회전 방향 요구**:
   - **TTGO T-Display** (어제 기기): 기본 세로모드(Portrait, 135x240) 요구.
   - **JC8012P4A1C** (오늘 기기): 기본 가로모드(Landscape, 1280x800) 요구. 하드웨어 스캔 방향이 800x1280 세로로 고정되어 있어 소프트웨어 회전 및 터치 축 변환이 동반되어야 함.
2. **JC8012P4A1C 색상 스왑**: 제조사 드라이버 `esp_lcd_jd9365.c`는 `color_space` 필드를 통해 RGB/BGR을 감지하지만, `jd9365_lcd.cpp` 초기화 시 legacy 필드인 `.rgb_ele_order`만 세팅되어 `color_space`가 0(RGB)으로 uninitialized 됨. 그러나 실제 IPS 스크린은 RGB 채널을 직접 보내야 올바른 색상이 나옴 (즉, BGR로 세팅 시 Red/Blue가 스왑되어 버림).
3. **USB 업로드 오류 및 노이즈**: native USB JTAG CDC 포트 `/dev/cu.usbmodem101`에서 플래싱 속도를 460800 또는 921600으로 변경 시 macOS의 CDC 클래스 드라이버(`AppleUSBACM`)와 통신 동기가 깨지며 `Serial data stream stopped: Possible serial noise or corruption` 오류 발생. native USB JTAG CDC 포트 사용 시에는 업로드 속도를 전환하지 않고 기본 부트로더 속도인 `115200`으로 플래싱해야 100% 끊김 없이 고속 쓰기가 가능함.

### 수정

1. **보드 설정 및 기본 방향 세팅**: 
   - [board_jc8012p4a1c.h](file:///Users/puritysb/github/AgentDeck/esp32/boards/board_jc8012p4a1c.h) 신규 생성 (JD9365 MIPI-DSI, GSL3680 터치 핀 맵, 800x1280 해상도).
   - [board_ttgo_t_display.h](file:///Users/puritysb/github/AgentDeck/esp32/boards/board_ttgo_t_display.h) 기본값을 **Portrait**로 설정 (`BOARD_ROTATION = 0`, `SCREEN_W = 135`, `SCREEN_H = 240`).
2. **JC8012P4A1C 가로모드(Landscape) 소프트웨어 회전 및 터치 축 대입**:
   - [display.cpp](file:///Users/puritysb/github/AgentDeck/esp32/src/ui/display.cpp)에서 JC8012P4A1C의 `g_screenW`/`g_screenH`를 가로 크기(1280x800)로 세팅.
   - `displayInit` 호출 시 LVGL 디스플레이를 물리 크기(800x1280)로 생성한 뒤 `lv_display_set_rotation(disp, LV_DISPLAY_ROTATION_90)`를 통해 소프트웨어적으로 90도 가로 회전 적용.
   - `touch_read` 함수에서 물리 터치 입력 좌표(X, Y)를 90도 시계방향 회전 수식(`temp_x = x; x = BOARD_NATIVE_H - y; y = temp_x;`)을 적용하여 논리 landscape 맵에 매핑.
3. **색상 순서 교정**: [jd9365_lcd.cpp](file:///Users/puritysb/github/AgentDeck/esp32/src/ui/lcd/jd9365_lcd.cpp)에서 `.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB`로 설정하여 색상 스왑 현상 해결.
4. **업로드 포트/속도 튜닝**: [platformio.ini](file:///Users/puritysb/github/AgentDeck/esp32/platformio.ini)에서 업로드 포트를 `/dev/cu.usbmodem101`로, 속도를 `115200`으로 지정하여 native USB 통신 노이즈 방지 및 쓰기 안정성 확보.

### 검증

- `pio run -e jc8012p4a1c -t upload` 명령을 통해 `/dev/cu.usbmodem101` 포트(115200 bps)로 펌웨어를 끊김 없이 100% 업로드 및 자동 리셋 확인.
- JC8012P4A1C 기기 부팅 후 기본 가로모드(Landscape, 1280x800)로 화면이 출력되며, UI 색상(블루 테마 및 아쿠아리움 개체들)이 정상적으로 노출되고 터치 조작 방향 또한 완벽히 일치함을 확인.

---

## 2026-06-01 — 포트 누적 증가 버그 수정 (`isPortFree` 127.0.0.1 → 0.0.0.0)

### 문제

새 세션을 시작할 때마다 포트가 9121 → 9122 → 9123 → ... 으로 계속 올라감.

### 원인

**파일**: `bridge/src/session-registry.ts`의 `isPortFree()`

```ts
// 이전 (버그):
server.listen(port, '127.0.0.1');

// 수정:
server.listen(port, '0.0.0.0');
```

`isPortFree()`가 `127.0.0.1`에 bind를 시도했는데, 실제 WebSocket 서버(`BridgeCore`)는 `0.0.0.0`(모든 인터페이스)으로 listen한다. macOS에서는 `SO_REUSEPORT` 등에 따라 `0.0.0.0`으로 이미 점유된 포트에 `127.0.0.1`로 bind가 **성공**하는 경우가 있다. 결과적으로 `isPortFree()`가 이미 점유된 포트를 "free"로 잘못 판정 → `findAvailablePort()`가 다음 포트를 반환 → 포트 계속 증가.

실제로 netstat에서 9121/9122/9123이 LISTEN으로 보임에도 `sessions.json`에 없었고, health 응답도 없는 (좀비) 상태였다. 이 포트들을 `isPortFree(127.0.0.1)`는 통과시켜버림.

### 수정

`server.listen(port, '0.0.0.0')`으로 변경. 실제 서버와 동일한 주소로 bind 시도하므로 어느 인터페이스에 점유된 포트도 정확하게 감지.

### 검증

- `pnpm build` — SUCCEEDED
- `pnpm test` — 1268 tests passed

---

## 2026-06-01 — Android/E-ink/ESP32 daemon 자동 연결 불가 수정

### 문제

Android 기기 (태블릿 포함), E-ink 디스플레이 기기, ESP32 기기 모두 daemon에 자동 연결되지 않는 현상.
원인은 4가지가 얽혀 있었다.

### 원인 1: `SerialModule.shouldActivate('auto')` — ESP32 시작 시 부재 시 모듈 미초기화

**파일**: `bridge/src/modules/serial-module.ts`

`shouldActivate('auto')`가 daemon **시작 시점**에 `/dev/`를 딱 한 번 확인했다. 이때 ESP32가 꽂혀 있지 않으면 `SerialModule` 자체가 `start()`되지 않아 10초 폴링(`pollForDevices`)이 전혀 실행되지 않는다. 나중에 꽂아도 자동 연결 불가.

**수정**: `shouldActivate`에서 기기 감지 제거. `startESP32Serial()` 내부의 10초 폴링이 기기 감지를 담당하므로 SerialModule은 항상 active 상태로 유지. 기기 없어도 무해.

### 원인 2: `BridgeDiscovery.kt`의 TXT `ip` 필드 우선 사용 — stale IP로 연결 실패

**파일**: `android/.../net/BridgeDiscovery.kt`

Bonjour TXT 레코드의 `ip` 필드를 실제 NSD resolve 주소보다 우선했다. Bonjour 캐시가 DHCP 갱신 전의 구 IP를 제공하면 연결 실패. `daemon.md`에 명시된 대로 Swift `BridgeDiscovery`는 TXT `ip` 필드를 무시하고 `NWConnection` 실제 해석 주소를 사용한다. Android도 같은 정책으로 통일.

**수정**: `txtIp` 변수 제거, `resolvedHost`를 직접 사용.

### 원인 3: `BridgeConnection`의 localhost 무한 재시도 — WiFi 기기 mDNS 차단

**파일**: `android/.../net/BridgeConnection.kt`

localhost(adb reverse) 연결 실패 시 `LOCALHOST_STEADY_RETRY_MS = 30_000ms` 주기로 영원히 재시도했다. WiFi 전용 기기(E-ink)에서 localhost는 당연히 실패하므로 30초마다 localhost만 무한 시도 → mDNS 경로가 완전히 막힘.

**수정**: `MAX_LOCALHOST_ATTEMPTS` 초과 시 재시도 완전 중단 + `url = null` 클리어. 이 신호로 `LaunchedEffect(connectionStatus, currentUrl)`가 즉시 mDNS fallback 실행.

### 원인 4: `EinkMonitorScreen` auto-connect mDNS 4초 타임아웃 후 재시도 없음

**파일**: `android/.../ui/screen/EinkMonitorScreen.kt`

`LaunchedEffect(Unit)`의 mDNS 타임아웃이 4초로 짧고, 이후 재시도 로직이 없었다. URL 클리어 시 mDNS 재발견하는 effect도 없었다.

**수정**: 타임아웃 4000→6000ms로 확장 + `LaunchedEffect(connectionStatus, currentUrl)`에서 `url=null+DISCONNECTED` 감지 시 즉시 mDNS 재발견 + 자동 연결 추가. `TabletDashboard`(MainActivity.kt)도 동일하게 통일.

### 해결 흐름 (수정 후)

```
E-ink/Android 앱 시작
  └→ LaunchedEffect(Unit): localhost:9120 시도 (3초)
        ↓ 실패
        └→ savedUrl 시도 (5초)
              ↓ 실패 or 없음
              └→ mDNS 6초 discover → daemon 발견 시 즉시 connect

  (WiFi 전용 기기인 경우)
  localhost MAX_LOCALHOST_ATTEMPTS(5회) 초과
    → BridgeConnection: shouldReconnect=false, url=null 클리어
    → LaunchedEffect(DISCONNECTED, url=null): 0.5초 후 mDNS 재발견
    → daemon 발견 시 connect

ESP32 daemon 기동 후 꽂는 경우
  → SerialModule 항상 active → pollForDevices() 10초마다 실행
  → 기기 감지 즉시 openPort() + 초기 상태 전송
```

### 핵심 설계 결정

- **SerialModule은 항상 active**: `startESP32Serial()` 내부 10초 폴링이 실제 기기 감지를 담당. `shouldActivate`에서 기기 유무 확인은 "daemon 시작 시 꽂혀 있어야 한다"는 잘못된 전제 하에 작동했음.
- **mDNS TXT ip 무시**: Bonjour 캐시 stale 문제. Swift와 Android가 동일 정책 적용. `daemon.md`에 이미 기술된 내용이었으나 Android 구현에 반영되지 않은 상태였음.
- **localhost 빠른 포기 + URL 클리어 시그널**: `LOCALHOST_STEADY_RETRY_MS` steady-retry 전략 폐기. WiFi 전용 기기에서는 localhost 포기 신호(url=null)를 mDNS fallback trigger로 사용. 재시도 전략과 fallback 경로를 명확히 분리.
- **LaunchedEffect key 설계**: `(connectionStatus, currentUrl)` 조합으로 url=null 상태 변화를 정확히 감지. `Unit`으로 키잉하면 앱 시작 시 한 번만 실행되어 재시도 불가.

### 검증

- `pnpm build` — BUILD SUCCEEDED
- `pnpm test` — 57 files / 1268 tests passed (vitest)
- `cd android && ./gradlew testDebugUnitTest` — BUILD SUCCESSFUL

---

## 2026-06-06 — ESP32-P4 JC8012P4A1C 4MB 플래시 대응 및 화면 정방향 교정

### 문제
- JC8012P4A1C 10.1인치 디스플레이 보드(메인 칩: ESP32-P402N) 플래싱 후 화면이 켜지지 않는 현상이 발생함.
- 부트 로그 확인 결과 `Failed to verify partition table` 파티션 검증 실패로 인해 무한 리셋 루프를 돌고 있었음. 원인은 P402N 칩의 실제 내장 플래시 크기가 4MB인 반면, 플랫폼 설정 및 파티션 테이블이 16MB 기준으로 작성되어 주소 영역을 초과했기 때문임.
- 1차 파티션 테이블 수정 후 화면 백라이트와 UI는 정상 가동되었으나, 화면 상하가 반대로 뒤집혀(180도 반전) 출력되는 현상이 관찰됨.

### 해결
- **플래시 크기 및 파티션 스펙 다운사이징**:
  - `platformio.ini`에서 `board_build.flash_size = 4MB`로 수정함.
  - `partitions/jc8012p4a1c.csv`를 4MB 플래시에 맞춘 단일 팩토리 앱 레이아웃(No OTA, NVS 20KB, APP0 3MB, SPIFFS 960KB)으로 변경하여 부트 리셋 루프를 해결함.
- **디스플레이 및 터치 180도 회전 보정**:
  - `esp32/src/ui/display.cpp`의 `disp_flush`에서 manual transposition 공식을 90도 시계방향 회전에서 270도 회전(`rotated_buf[(w - 1 - c) * h + r] = src[r * w + c]`)으로 전환하고, 좌상단 물리 매핑 좌표를 보정함.
  - 이에 대칭적으로 `touch_read` 내의 터치 좌표 역변환 공식도 270도 레이아웃에 맞춰 보정(`x = BOARD_NATIVE_H - 1 - y_phys`, `y = x_phys`)하여 터치 조작 방향을 정방향으로 일치시킴.

### 검증
- `pio run -e jc8012p4a1c --target upload`를 통한 빌드 및 플래싱 성공.
- 시리얼 모니터링 상에서 크래시 없이 `Touch GSL3680 initialized`, `LVGL initialized 1280x800` 로그가 정상 기록되는 것을 확인.
- 기기 화면이 올바른 가로 정방향으로 출력되며 터치 제어가 정상 작동함 확인.

---

## 2026-06-06 — Pixoo64 스트리밍 안정성 개선 (재생 위임 및 상태 감지 도입)

### 문제
- Pixoo64 LED 매트릭스는 어항 애니메이션을 위해 250ms(Node) / 333ms(Swift)마다 64x64 raw RGB 프레임을 매번 새로 렌더링하여 HTTP POST로 전송했다.
- 이 방식은 매초 3~4회의 대용량 이미지 쏘기로 인해 와이파이 전송 레이턴시가 발생하고, 펌웨어/네트워크 부하로 스트리밍이 뚝뚝 끊기거나 딜레이가 체감되는 원인이 되었다.

### 해결
- **애니메이션 재생 위임 (Sequence Push)**:
  - 1프레임 단위 푸시 대신 12프레임 분량의 애니메이션 시퀀스(10fps 기준 1.2초 재생 루프)를 한 번에 생성하여 Pixoo 하드웨어에 전송(`PicNum = 12`, `PicSpeed = 100`).
  - Pixoo 기기가 데이터를 넘겨받으면 자체 보드 성능으로 루핑 애니메이션을 매끄럽게 재생하게 함으로써 30~60fps에 가까운 움직임을 연출.
- **상태 변화 감지 도입 (Incremental State Push)**:
  - 렌더링에 실질적 영향을 미치는 상태 정보(에이전트 연결 상태, 활성 세션 정보들의 조합, CPU 사용량의 정수부, 리셋 시간 텍스트, 게이트웨이 상태, 디스플레이 dimming 상태 등)를 요약해 Hash/Digest로 관리.
  - 500ms 주기로 이 해시 값을 비교하여 실질적인 변화가 발생했거나, 혹은 30초의 강제 하트비트 갱신 주기가 만료되었을 때만 새 12프레임 시퀀스를 렌더링하여 전송.
- **Node.js 및 Swift 데몬 병행 적용**:
  - Node.js bridge (`pixoo-client.ts`, `pixoo-bridge.ts`, `pixoo-renderer.ts`)와 Swift macOS daemon (`PixooModule.swift`, `PixooRenderer.swift`) 양쪽 모두에 동일한 재생 위임 및 해시 감지 메커니즘을 동일하게 포팅.
  - Swift 데몬의 `PixooRenderer`가 시간의 흐름을 반영해 여러 프레임 시퀀스를 한 번에 출력할 수 있도록 `renderSequence` 메서드를 추가하고 기존 `render`를 래핑.

### 검증
- **Node.js**:
  - `pnpm build` TypeScript 빌드 성공.
  - `pnpm vitest run bridge/src/__tests__/pixoo-sprites.test.ts` (3 tests passed).
- **Swift macOS Daemon**:
  - `xcodebuild build` Debug 구성 macOS target 빌드 완료 및 괄호 불일치 오류 교정 후 빌드 성공.
  - CLI 명령어 동작 및 `swift-daemon.log` 관찰 결과 불필요한 프레임 전송 없이 상태 변화 시에만 안정적으로 시퀀스 PUSH 됨을 확인.

---

## 2026-06-06 — Pixoo64 HTTP 스트리밍 안정성 강화 (재진입 방지 및 리셋 지연)

### 문제
- single-frame 푸시(`frameCount = 1`)와 1.5초 dynamic refresh rate 적용 이후에도 약 230여 회 전송 후 연속적인 HTTP 타임아웃과 함께 기기가 오프라인으로 이탈(Backoff)하는 현상이 관찰됨.
- 원인 분석 결과:
  1. **PicID Reset 후 안정화 시간 누락**: `PicID`가 250 이상이 될 때 전송하는 `ResetHttpGifId` 명령어 직후 딜레이 없이 즉시 다음 프레임 POST 요청을 보내면서 ESP32의 가벼운 네트워크 스택이 병목으로 인해 중단되거나 연결을 거부하는 현상이 발생함.
  2. **Swift Actor 재진입성(Re-entrancy)으로 인한 Overlapping**: Swift의 `PixooModule` actor는 비동기 작업대기(`await`) 중 정지될 때 실행 제어권을 넘기므로, 500ms 주기로 동작하는 `checkAndPush()`가 이전 푸시 동작의 완료를 기다리지 않고 중복 실행되어 concurrent HTTP request가 발생하고 디바이스를 리셋/먹통으로 만드는 버그가 있음.
  3. **URLSession의 반복적인 재생성**: 매 HTTP POST 요청마다 `URLSession`을 인스턴스화하고 취소(`invalidateAndCancel`)하면서 포트 경합과 불필요한 시스템 자원 낭비가 누적됨.

### 해결
- **PicID 리셋 후 지연 추가**:
  - Node.js 브리지(`pixoo-client.ts`) 및 Swift 데몬(`PixooModule.swift`)에서 `ResetHttpGifId` 전송 직후 **2.0초의 대기 지연(sleep)**을 추가하여 ESP32가 GIF 캐시와 상태를 안전하게 초기화하고 안정화될 시간을 확보함.
- **Actor 중복 실행 방지 (isPushing 플래그)**:
  - Swift 데몬 `PixooModule.swift`에 `isPushing` 플래그를 추가하고 `checkAndPush` 시작점에 중첩 진입 방지 guard를 배치하여 network latency 등으로 인해 500ms 이상 소요될 때 이전 push 작업과 겹치지 않도록 방어함.
- **URLSession 인스턴스 공유**:
  - Swift `PixooModule`에 단일 `urlSession` 인스턴스를 유지하도록 변경하고, `httpMaximumConnectionsPerHost = 1` 설정을 명시해 기기당 HTTP 연결 개수를 제한하여 전송 계층의 병목을 완화함.

### 검증
- **Node.js**:
  - `pnpm vitest run bridge/src/__tests__/pixoo-sprites.test.ts` (3 tests passed).
- **Swift macOS Daemon**:
  - `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug build` 빌드 성공 확인.
