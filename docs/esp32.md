---
id: spec.esp32
title: ESP32 Firmware
description: Supported boards, flash safety rules, WiFi provisioning, OTA, and disconnect recovery for the ESP32 surfaces.
category: Specs
locale: en
canonical: true
status: stable
owner: Firmware maintainers
reviewed: 2026-07-22
revision: 2026-07-22
source_of_truth: docs/esp32.md
validators: [bash esp32/robot/run.sh build]
---
# ESP32 Firmware

PlatformIO Arduino firmware for LVGL touch displays (ESP32-S3: 86Box 480×480, IPS 3.5" 480×320 landscape / 320×480 portrait, Round AMOLED 360×360; ESP32-P4: Guition JC8012P4A1C 10.1" IPS 800×1280 portrait native + ESP32-C6 co-processor) + SPI TFT displays (ESP32 classic: LilyGO TTGO T-Display 1.14" 135×240 with a 160px terrarium viewport + 80px metric strip) + WS2812B LED matrix (ESP32 classic: Ulanzi TC001 8×32). Board-specific `#ifdef`, per-board partition tables, FastLED matrix renderer bypasses LVGL entirely. IPS 3.5" supports runtime portrait↔landscape switching via `set_orientation` protocol command or Settings toggle (NVS persistent, `g_screenW`/`g_screenH` runtime globals).

## Host simulator (no-hardware preview)

`esp32/sim/` renders **real** board screens on the host — no board, no flashing.
It compiles the firmware's render surfaces against a native toolchain into a
headless framebuffer, dumped to PNG. Sources are pulled in verbatim with each
board's build defines (`BOARD_*`/`SCREEN_W/H`), so output is **pixel-exact** —
that board's firmware minus hardware I/O, not an approximation. This is the ESP32
counterpart to the Node preview tools (`bridge/scripts/pixoo-preview.ts`) and
removes the drift risk of the hand-mirrored Swift Device Preview ESP32 tiles.

```bash
pnpm esp32:sim                 # all 7 boards, all scenes → esp32/sim/sim-out/
pnpm esp32:sim box_86 working  # one board, one scene
```

Covers all board classes: LCD terrarium + HUD (`box_86` 480×480, `ips35` 480×320,
`amoled` 360×360 round, `ttgo` 135×240 compact overlay), the IPS10 tablet "pixel
office" + sidebar mosaic (`ips10` 1280×800), the TC001 8×32 LED matrix (`led8x32`,
usage/agents pages), and the InkDeck 1-bit e-ink dashboard (`inkdeck` 800×480).
LCD boards render the **real** composed screen via `Screens::aquariumCreate()`
(the firmware's per-board builder). A thin hardware shim layer (`sim/shims/`)
stubs the surface the render code touches (millis/Serial/heap/mutex/FastLED/
GxEPD2/Print/net-status); the e-ink text uses the vendored real Adafruit GFX
fonts for pixel-exact glyphs. Named scenes populate the same `g_state` the
firmware fills from the daemon's `state_update`, exercising the real session →
creature/card derivation. Frames are deterministic (virtual clock + re-seeded
PRNG) for golden tests. Adding a board = one `platformio.ini` env block.
Standalone PlatformIO project (does not inherit `esp32/platformio.ini`), so
WiFi/WebSockets/LovyanGFX never enter the native build. Limitations: Latin labels
only (CJK stubbed); e-ink is a single full-buffer pass (no partial-refresh
ghosting). See [esp32/sim/README.md](../esp32/sim/README.md).

## Flash Safety

- **절대 `usbmodem` 포트 번호만 보고 IPS 3.5"와 Round AMOLED를 구분하지 말 것.** Native USB JTAG 보드는 허브 위치, 재연결 순서, 복구 모드에 따라 `/dev/cu.usbmodem*` 번호가 계속 바뀐다.
- **정상 부팅 중인 보드는 반드시 `device_info_request`로 보드 식별 후 플래시한다.** 기대값은 `ips35`, `amoled`, `86box`, `led8x32`.
- **`esp32/scripts/flash.sh auto`는 `device_info_request` 성공 시에만 자동 선택한다.** 응답이 없으면 추정하지 말고 중단해야 한다.
- **Native USB 보드가 벽돌 상태일 때는 BOOT/RST로 먼저 ROM 다운로드 모드에 진입시킨 뒤, 그 다음에만 수동 업로드한다.** 복구 모드에서는 `device_info_request`가 동작하지 않으므로 환경(`ips35` 또는 `amoled`)을 사람이 명시해야 한다.
- **한 번이라도 잘못된 디스플레이 펌웨어를 Native USB 보드에 올리면 USB가 잠깐만 살아 있다가 끊길 수 있다.** 이 상태는 하드웨어 사망이 아니라 잘못된 앱이 USB PHY를 끊는 케이스일 수 있다.
- **복구 업로드는 bootloader + partitions + firmware 전체를 다시 쓰는 full flash를 기본으로 본다.**
- **복구 직후 화면이 안 켜져도 먼저 부트 상태를 확인한다.** 계속 `esptool`이 즉시 붙으면 GPIO0/BOOT가 눌린 상태로 남아 ROM 다운로드 모드에 머물러 있을 가능성이 높다.
- **플래시 전에 반드시 `lsof /dev/cu.*` 로 daemon 시리얼 점유를 확인한다.** Swift daemon(`AgentDeck`)이 시리얼 포트를 점유하면 esptool이 "chip stopped responding" 오류를 낸다. Daemon 중지 후 플래시.
- **`config.h`의 `MAX_*` 상수는 `constexpr uint8_t`이므로 `#if MAX_OPENCODE > 0` 전처리기 가드를 쓰면 안 된다.** 전처리기는 constexpr을 인식 못해 항상 0으로 평가. 런타임 `if (MAX_OPENCODE > 0)` 또는 가드 없이 for 루프 조건으로 처리.
- **IPS 3.5" full flash 시 `--flash_size 16MB` (또는 `--flash-size 16MB`)를 명시한다.** esptool이 부트루프 중 flash size를 8MB로 오감지하여 파티션 테이블 검증 실패 유발.
- **TTGO는 전체 135×240 테라리움 캔버스를 쓰지 않는다.** 이 보드는 PSRAM 없는 ESP32 classic이라 정적 DRAM 여유가 10KB대다. 테라리움은 135×160(세로) 또는 160×135(가로) 정적 버퍼로 제한하고, 남는 80px 영역에만 상태/활동 메트릭을 둔다. 전체 화면 반투명 검정 오버레이를 올리면 테라리움 배경이 검은 화면처럼 보이므로 금지한다.

## Diagnostic commands (firmware-local)

몇몇 진단은 **호스트를 거치지 않고 보드 펌웨어에만** 존재한다. 데몬은 이 타입들을 보내지 않으며 — `daemon-server.ts`의 `esp32WifiEvents` allowlist가 등록되지 않은 타입을 esp32 클라이언트로 보낼 때 조용히 드롭한다 — 그래서 `shared/src/protocol.ts`·codegen·Swift/Kotlin 미러·XTeink 포크 재포팅 의무가 전혀 발생하지 않는다. 대신 **시리얼 포트에 JSON 한 줄을 직접 써서** 트리거한다. `serial_client.cpp`가 `{`로 시작하는 모든 줄을 파싱하므로, `esp32/scripts/flash.sh`가 `device_info_request`를 보내는 것과 같은 메커니즘이다.

먼저 포트를 비운다(`agentdeck daemon stop` + `lsof /dev/cu.*`). 그 다음 `pio device monitor`에 직접 타이핑하거나 pyserial로 한 줄 쓴다.

| 명령 | 보드 | 하는 일 |
|---|---|---|
| `{"type":"device_info_request"}` | 전체 | 보드 식별 — 플래시 전 필수 |
| `{"type":"touch_diag"}` | `ips35`, `amoled` | Arduino `Wire` I2C 스윕 + 터치 컨트롤러 프로브 |
| `{"type":"i2c_diag"}` | `ips10` | 오디오 코덱 프로브 — 터치 버스 스윕 + ES8311 정체 확인 + 레지스터 덤프 + 후보 핀 레벨 |
| `{"type":"i2c_diag","sda":N,"scl":N}` | `ips10` | 2차 I2C 버스 후보 프로브(opt-in). P4↔C6 ESP-Hosted SDIO 핀(14·15·16·17·18·19·54)은 거부된다 |
| `{"type":"i2c_diag","dump":24}` | `ips10` | 해당 주소 레지스터 덤프(읽기 전용) |

`i2c_diag`는 ips10 부팅 시 자동으로 1회 돈다(`displayInit()`의 GSL3680 init 직후, uiTask에서 터치 폴링 시작 전 — 같은 버스 경합 회피). 이 보드는 USB 시리얼이 붙으면 WiFi STA를 파킹하므로 결과를 실어 보낼 소켓이 없어 **출력은 Serial 전용**이다. `[I2CDiag]` 접두어로 grep하면 된다.

## WiFi 독립 운용

ESP32 디스플레이는 **USB 시리얼** (기본) + **WiFi WebSocket** (독립 운용) 이중 경로 지원.

```bash
agentdeck wifi-setup --ssid "MyNetwork" --password "secret"
# → ~/.agentdeck/wifi-config.json 저장 (autoProvision: true)
# → daemon 재시작 시 ESP32에 자동 프로비저닝
```

**USB 연결 시**: daemon이 시리얼로 `wifi_provision` 전송 → ESP32 WiFi 자동 연결. **USB 분리 후**: ESP32가 저장된 자격증명으로 WiFi 재연결 → mDNS로 daemon 발견 → WebSocket 접속. WiFi 인터페이스 자동 감지 (`networksetup -listallhardwareports`), macOS Keychain 비밀번호 조회 지원. Daemon (`daemon-server.ts`)과 Session bridge (`index.ts`) 양쪽에서 auto-provisioning 동작.

## WiFi OTA v1

WiFi OTA는 **우리가 직접 AgentDeck 펌웨어를 플래싱하는 ESP32 계열** 중, WiFi WebSocket으로 daemon에 붙고 dual-OTA 파티션을 가진 보드만 대상이다. 상용 펌웨어/비-ESP32/직접 플래싱하지 않는 장치(Pixoo64, iDotMatrix, Timebox Mini 등)는 검토 대상이 아니다.

운영 흐름:

```bash
agentdeck devices                         # WiFi ESP32 연결 및 board 이름 확인
agentdeck esp32-ota inkdeck --build       # 해당 env 빌드 후 OTA 전송
agentdeck esp32-ota ips_10 --firmware esp32/.pio/build/ips10/firmware.bin
```

체크아웃 없이 업데이트하려면 `esp32-v*` GitHub Release 자산을 그대로 쓴다. 자산 이름은 **canonical board id** 기준(`agentdeck-<board>.bin`)이라 다운로드한 파일명이 곧 OTA target 이다:

```bash
agentdeck esp32-ota ips_10 --firmware agentdeck-ips_10.bin
```

릴리스는 `docs/hardware-compatibility.md`에서 Shipping 인 보드 전체를 빌드하며(현재 10종), 보드별로 `-partitions.bin`/`-bootloader.bin`과 `SHA256SUMS.txt`를 함께 첨부한다. 릴리스 노트의 보드 표는 빌드 산출물에서 렌더링되므로 손으로 관리하는 두 번째 목록이 아니다. **Shipping 보드를 추가하면 `.github/workflows/esp32-release.yml`의 matrix 행도 같이 추가해야 한다** — 빠뜨려도 실패 없이 그 보드 펌웨어만 조용히 누락된다.

Daemon API는 `POST /esp32/ota` 이며 CLI는 이 엔드포인트를 호출한다. OTA 프로토콜은 daemon→firmware `esp32_ota_begin`, `esp32_ota_chunk`, `esp32_ota_end`, `esp32_ota_abort`, firmware→daemon `esp32_ota_ack`, `esp32_ota_error` 로 구성된다. Firmware는 `device_info`에 OTA capability(지원 여부, OTA 슬롯 수, 최소 슬롯 크기, free sketch space, 미지원 사유)를 실어 serial/WebSocket 양쪽에 보고한다. 전송은 WiFi WS socket에서 1KB base64 chunk 단위로 진행하고, `Update` + MD5 검증 성공 후 재부팅한다.

OTA 대상 SSOT. **`agentdeck esp32-ota <target>`의 `<target>`은 로컬 PlatformIO env뿐 아니라 daemon이 연결된 기기를 매칭하는 키(firmware의 `device_info.board` 문자열)로도 그대로 쓰인다 — 아래 굵게 표시한 별칭만 둘 다 만족한다.** 다른 별칭은 `--build`까지는 되어도 실제 보드가 그 이름으로 자신을 보고하지 않아 업로드 단계에서 `No online WiFi ESP32 target matches …`로 실패한다:

| Target aliases | PlatformIO env | OTA slot size | 운영 메모 |
|---|---|---:|---|
| `inkdeck` | `inkdeck` | ~3.3MB | Seeed XIAO ESP32-S3 Plus BSP와 일치하도록 8MB layout 유지 |
| `ulanzi_tc001`, `led8x32` | `led8x32` | ~3.0MB | FastLED matrix, LVGL 미사용 |
| **`ttgo_t_display`**, `ttgo` | `ttgo` | ~6.0MB | PSRAM 없는 classic ESP32, 작은 렌더 버퍼 유지 |
| **`ips_35`**, `ips35` | `ips35` | ~3.5MB | FAT 포함 dual-OTA layout |
| **`round_amoled`**, `amoled`, `amoled_18` | `amoled` | ~3.0MB | 8MB flash dual-OTA layout |
| **`86box`**, `box_86`, `box_40` | `box_86` | ~7.75MB | 실험실 유닛은 2026-07-05 USB 마이그레이션 완료; 이전 layout 유닛은 최초 1회 USB full flash 필요 |
| **`ips_10`**, `ips10`, `ips_101` | `ips10` | ~6.0MB | 실험실 유닛은 2026-07-05 USB 마이그레이션 완료; 이전 layout 유닛은 최초 1회 USB full flash 필요 |
| **`t_embed`**, `tembed`, `knob` | `t_embed` | ~6.0MB | Companion Knob (인코더 조향); 2026-07-25 OTA 실기 검증 완료 |
| **`t_display_pro`**, `tdisplaypro`, `ticker`, `s3pro` | `t_display_pro` | ~6.0MB | Focus Strip (캡션 바 + 터치 승인); 공장 single-app 4MB → 최초 1회 USB 플래시로 dual-OTA 마이그레이션. USB CDC 고속 손상 → upload_speed 230400 고정. **카메라/무카메라 2대 동시 운용** — 아래 주의 참조 |

**같은 board 2대를 동시에 운용할 때 (현재 `t_display_pro`)**: WiFi registry 키는 `board:ip`라 유닛별 슬롯은 분리되지만, `agentdeck esp32-ota t_display_pro`처럼 **board 이름으로 지목하면 두 유닛이 모두 매칭돼 `Target ... is ambiguous`로 실패**한다(`findWifiOtaTarget`, `bridge/src/daemon-server.ts`). 한 대만 올릴 때는 **IP를 타깃으로** 주면 된다 — `agentdeck esp32-ota 192.168.0.78 --firmware <bin>`. 두 유닛은 같은 이미지를 쓰므로 순서만 다를 뿐 빌드는 한 번이면 된다. 또한 `serialActive`는 board 단위로 계산되므로 한 대가 USB에 물리면 WiFi 전용인 나머지 유닛 항목에도 serial 표시가 뜬다(표시 오염이며, OTA 대상 판정과는 별개).

최초 마이그레이션 주의:

- `86box`와 `ips10`은 2026-07-05 이전 펌웨어가 단일/factory 또는 NO_OTA 파티션일 수 있다. 이 상태에서는 WiFi OTA를 받을 다음 OTA 슬롯이 없으므로 `esp32/scripts/flash.sh` 또는 PlatformIO upload로 bootloader + partition table + app을 USB full flash 한 뒤부터 OTA 대상이 된다.
- USB flash 전에는 `agentdeck stop` 또는 macOS AgentDeck 앱 종료 후 `lsof /dev/cu.*` 로 포트 점유를 확인한다. Daemon이 CH340/CDC 포트를 잡고 있으면 esptool이 chip stopped responding 오류를 낼 수 있다.
- OTA 실패 시 보드는 기존 실행 슬롯을 유지해야 한다. 반복 실패하면 `agentdeck devices`의 OTA capability 미지원 사유(`no_ota_build`, `no_dual_ota_partition`, `no_next_ota_partition`)와 firmware size 대비 slot size를 먼저 확인한다.

실기 마이그레이션 검증(2026-07-05):

| Board | USB upload result | Daemon detection | 판정 |
|---|---|---|---|
| `86box` | `/dev/cu.wchusbserial21110`, dual-OTA firmware upload 100% 완료(1421KB compressed) | `86box v0.1.2 (f82f4616-dirty) OTA 7.8MB @ /dev/cu.wchusbserial21110` | 완료 |
| `ips_10` | `/dev/cu.wchusbserial201240`, clean build 후 dual-OTA firmware upload 100% 완료(1350KB compressed) | `ips_10 v0.1.2 (f82f4616-dirty) OTA 6.0MB @ /dev/cu.wchusbserial201240` | 완료 |

위 포트는 해당 검증 시점의 USB 스냅샷이다. 운영 판단은 포트명이 아니라 `device_info`/`agentdeck devices`에 표시되는 board 이름과 OTA slot size를 기준으로 한다.

## Disconnect 복구 (ESP32 firmware)

시리얼 10초 timeout + WebSocket 지수 backoff (1→8s). `main.cpp`는 `bridgeFound` 플래그 없이 **mDNS를 항상 폴링** → daemon IP 변경(DHCP 갱신, 호스트 이동) 즉시 감지 후 `wsDisconnect()`+새 IP로 `wsConnect()` 재바인딩. WS backoff가 15초 이상 saturated이면 `mdnsRefresh()`로 캐시 강제 무효화 (좀비 dns-sd 광고 상황 방어). `ws_client.cpp`의 `setReconnectInterval()`은 backoff 증가할 때마다 라이브러리 내부 타이머에 재동기화 (기존에는 `wsConnect()` 시점 값에 고정). `DashboardState.lastMessageMs`가 serial/WS TEXT 수신 시 갱신되어 UI에서 disconnect age 계산.

**TC001 matrix disconnect UI**: stale 스프라이트 대신 상태 메시지 (`CONNECT WIFI` / `FINDING BRIDGE` / `DAEMON DOWN Xm` / `NO WIFI Xm`) + 우상단 깜빡이는 빨간 점.

## Downstream client port sync

`esp32/src/net/protocol.cpp` 는 first-party 보드의 **AgentDeck 와이어 계약** 참조 구현이다.
이 계약의 인간용 subset 은 [esp32-client-contract.md](esp32-client-contract.md) 에 문서화되어 있다.

외부 포크가 이 계약을 **손으로 포팅**해서 쓰는 경우가 있다 — 현재는 **XTeink X3/X4**
(CrossPoint Reader 포크 `crosspoint-agentdeck` 의 `src/agentdeck/*`, *"TRIMMED port of
AgentDeck esp32/src/net/protocol"*). C3(no-PSRAM/ArduinoJson)에는 C++ 코드젠을 쓸 수 없어
포크는 이 파서를 손으로 따라간다. 따라서 **드리프트는 규율로 막는다**:

- `shared/src/protocol.ts` 의 `DISPLAY_FORWARDED_EVENTS`/`SERIAL_FORWARDED_EVENTS` 를 바꾸거나
  `sendDeviceInfo` 의 `device_info` 필드 목록을 바꾸면, first-party 파서와 **X3/X4 포크의
  `src/agentdeck/protocol.*` 를 함께 재포팅**해야 한다.
- 렌더 API(GxEPD2/GfxRenderer)는 기기별로 유지하되, 카드 열/행·헤더·usage/activity/footer
  영역 계산은 `esp32/src/ui/eink/eink_dashboard_layout.h`가 정본이다. 변경 후
  `scripts/sync-xteink-eink-dashboard.sh`로 포크의 `src/agentdeck/eink_dashboard_layout.h`를
  갱신하고, `--check`로 byte-for-byte drift를 검사한다. 이 헤더는 고정 크기 구조체만 쓰며
  힙 할당이 없다.
- 포크 쪽 절차는 `crosspoint-agentdeck` 의 `.skills/SKILL.md`(upstream-sync 섹션의
  downstream 짝) 에 있다. AgentDeck 쪽은 이 노트가 그 절반이다.

## 기기별 펌웨어 사양 및 포트 매핑 정보 (2026-06-10 기준)

현재 연결된 디스플레이 기기의 **포트 매핑 스냅샷**(디버깅용)입니다. 포트는 USB 허브 위치/재연결에 따라 변경될 수 있으며 `device_info_request`로 실시간 확인 필요. **SoC·디스플레이 IC·터치 IC·Flash/PSRAM 등 전체 칩 사양은 [hardware-compatibility.md § ESP32 board specification sheet](hardware-compatibility.md#esp32-board-specification-sheet) 가 SSOT** 다.

| 기기 설명 | PlatformIO Env | 가로/세로 해상도 | 사용 칩셋 | 현재 포트 (2026-06-10) | 상태 |
|---|---|---|---|---|---|
| LilyGO TTGO T-Display 1.14" | `ttgo` | 135×240 (테라리움 135×160 / 160×135 + 80px 메트릭 스트립) | ESP32 | `/dev/cu.wchusbserial58A90021441` | ✅ 연결됨 |
| IPS 3.5" Display | `ips35` | 480×320 / 320×480 | ESP32-S3 | `/dev/cu.usbmodem834101` (Native USB) | ✅ 연결됨 |
| Round AMOLED | `amoled` | 360×360 | ESP32-S3 | `/dev/cu.usbmodem2111201` (Native USB) | ✅ 연결됨 |
| 86 Box | `box_86` | 480×480 | ESP32-S3 | `/dev/cu.wchusbserial2112320` (CH340) | ✅ 연결됨 |
| 10" IPS Display | `ips10` | 800×1280 | ESP32-P4 | `/dev/cu.wchusbserial211240` (CH340) | ✅ 연결됨 |
| LilyGO T-Embed CC1101 (Companion Knob) | `t_embed` | 320×170 + 8-LED ring | ESP32-S3 | `/dev/cu.usbmodem2101` (Native USB) | ✅ 연결됨 |
| LilyGO T-Display-S3-Pro (Focus Strip, 무카메라) | `t_display_pro` | 480×222 가로 (Ticker UI) | ESP32-S3 | `/dev/cu.usbmodem3111201` (Native USB) | ✅ 연결됨 |
| LilyGO T-Display-S3-Pro (Pocket, GC0308 카메라) | `t_display_pro` | 222×480 세로 (Pocket UI) | ESP32-S3 | WiFi 상주 (부팅 시 카메라 감지 → 세로 전환) | ✅ 연결됨 |
