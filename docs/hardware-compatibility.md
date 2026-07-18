# Dashboard Hardware / OS Compatibility

지원하는 **모든 Dashboard 환경**의 하드웨어·펌웨어·OS 사양을 한 곳에 모은 종합 레퍼런스 (SSOT).

AgentDeck 에서 "Dashboard" 란 **daemon hub (port 9120) 에 붙어 에이전트 상태를 보여주거나 제어하는 모든 surface** 를 가리킨다 ([docs/daemon.md](daemon.md): _"the daemon is the sole hub for all dashboard clients"_). 하드웨어 변종·플랫폼 변종(Apple/Android)·프로토콜 스트림을 어디까지 별도 surface로 세는지에 따라 마케팅 숫자는 달라질 수 있으므로, 고정 숫자보다 아래 매트릭스를 실제 전체 목록으로 사용한다.

> 이 문서의 시각화 뷰: [docs/hardware/index.html](hardware/index.html) — self-contained 단일 HTML. **공개 링크**: <https://puritysb.github.io/AgentDeck/hardware/> (master 머지 후 GitHub Pages 워크플로우가 배포). 두 파일은 같은 데이터를 담으며 이 마크다운이 SSOT 다 — 수치 변경 시 둘 다 갱신.
>
### 문서 경계 (SSOT 소유권)

드리프트 방지를 위해 각 사실 카테고리의 **단일 소유 문서**를 고정한다. 이 문서는 **크로스-플랫폼 디바이스/사양 매트릭스의 SSOT**(아래 표들)이며, 각 도메인의 **운영 깊이**는 도메인 문서가 소유한다:

| 사실 카테고리 | SSOT 소유 문서 |
|---|---|
| 크로스-플랫폼 디바이스/사양 매트릭스 (SoC·해상도·전송·App Store) | **이 문서** (hardware-compatibility.md) |
| ESP32 펌웨어 운영 (플래시 안전·핀맵·포트·WiFi 프로비저닝) | [docs/esp32.md](esp32.md) |
| Android 빌드/서명/크리처 렌더링 | [docs/android.md](android.md) |
| 전송/프로토콜/디스커버리/이벤트 상세 | [docs/devices.md](devices.md) |
| App Store vs CLI 기능 tier 게이팅 | [docs/appstore-feature-matrix.md](appstore-feature-matrix.md) |

> 같은 수치를 여러 문서에 복제하지 말 것 — 도메인 문서는 이 매트릭스를, 이 매트릭스는 도메인 문서를 상호 참조한다.

**Host 요건**: App Store Swift dashboard는 macOS 26+. Node.js bridge는 Node.js ≥22가 필요하며 macOS와 Windows 11을 지원한다. Windows에서는 ConPTY·Scheduled Task daemon 경로를 사용하고 Apple/Android/ESP32 네이티브 빌드는 범위 밖이다. Linux는 공식 호스트 지원 범위가 아니다. 상세 차이는 [README의 Windows 절](../README.md#windows-bridge--plugin)을 따른다.

---

## 종합 매트릭스 (한눈에)

| Surface | 종류 | SoC · 플랫폼 | 디스플레이 / 해상도 | 전송 (transport) | 연결성 | App Store |
|---|---|---|---|---|:---:|:---:|
| **IPS 3.5"** | HW (ESP32 펌웨어) | ESP32-S3 | AXS15231B IPS · 480×320 | USB Serial / WiFi WS | USB-Serial + WiFi | ✅ |
| **Round AMOLED 1.8"** | HW (ESP32 펌웨어) | ESP32-S3 | ST77916 round AMOLED · 360×360 | USB Serial / WiFi WS | USB-Serial + WiFi | ✅ |
| **86 Box 4"** | HW (ESP32 펌웨어) | ESP32-S3 | ST7701 IPS · 480×480 | USB Serial / WiFi WS | USB-Serial + WiFi | ✅ |
| **TTGO T-Display 1.14"** | HW (ESP32 펌웨어) | ESP32 (classic) | ST7789 TFT · 135×240 | USB Serial / WiFi WS | USB-Serial + WiFi | ✅ |
| **IPS 10.1"** | HW (ESP32 펌웨어) | ESP32-P4 + C6 | JD9365 IPS MIPI-DSI · 800×1280 | USB Serial / WiFi WS | USB-Serial + WiFi | ✅ |
| **XTeink X3** | HW (ESP32 펌웨어 · experimental) | ESP32-C3 | 3.7" e-ink · 528×792 (세로) | WiFi WS | WiFi | ⚠️⁷ |
| **XTeink X4** | HW (ESP32 펌웨어 · experimental) | ESP32-C3 | e-ink · 800×480 | WiFi WS | WiFi | ⚠️⁷ |
| **Divoom Pixoo64** | HW (상용 LED) | Divoom (비-ESP32) | RGB LED · 64×64 | HTTP REST :80 | WiFi | ✅ |
| **InkDeck e-ink** | HW (ESP32 펌웨어 · in development) | XIAO ESP32-S3 Plus | e-ink · 800×480 (Seeed OG DIY Kit, UC8179) | WiFi WS | WiFi | ⚠️⁴ |
| **iDotMatrix 32×32** | HW (상용 BLE) | BLE SoC (비-ESP32) | RGB AMOLED · 32×32 | BLE GATT | Bluetooth LE | ✅ |
| **Divoom Timebox Mini** | HW (상용 BLE) | BLE SoC (비-ESP32) | RGB LED · 11×11 | BLE GATT (ISSC) | Bluetooth LE | ✅ |
| **Ulanzi TC001** | HW (ESP32 펌웨어) | ESP32 (classic) | WS2812B LED · 8×32 (256 LED) | USB Serial / WiFi WS | USB-Serial + WiFi | ⚠️¹ |
| **Ulanzi D200H** | HW (HID deck) | SigmaStar SSD210 | nv3052c LCD · 960×540 (14 keys) | Ulanzi Studio 플러그인 (단일 드라이버; direct-HID retire) | USB | ✅ |
| **Elgato Stream Deck (15-key)** | HW (HID deck) | Elgato (내장) | LCD keys 15 (3×5) | WebSocket :9120 | USB(호스트) → 네트워크 | ✅³ |
| **Elgato Stream Deck Mini** | HW (HID deck) | Elgato (내장) | LCD keys 6 (2×3) | WebSocket :9120 | USB(호스트) → 네트워크 | ✅³ |
| **Elgato Stream Deck+** | HW (HID deck) | Elgato (내장) | LCD keys 8 (2×4) + dials 4 + touch strip | WebSocket :9120 | USB(호스트) → 네트워크 | ✅³ |
| **Apple — macOS** | SW 플랫폼 | Apple Silicon / Intel | 호스트 디스플레이 | 내장 Swift daemon / WS | — | ✅ |
| **Apple — iOS / iPadOS** | SW 플랫폼 | A/M-series | 디바이스 디스플레이 | WebSocket :9120 | WiFi (same-LAN) | ✅ |
| **Android — e-ink** | SW 플랫폼 | 벤더별 (RK3566 등) | e-ink 디스플레이 | WebSocket (ADB localhost) | USB / ADB | ❌² |
| **Android — 태블릿** | SW 플랫폼 | ARM / x86 | 컬러 LCD | WebSocket + mDNS | WiFi (same-LAN) | ⚠️² |
| **SSE 스트림** | 프로토콜 surface | 호스트 | 브라우저/스크립트 렌더 | HTTP SSE :9120 `/sse` | 로컬 / LAN | ✅* |
| **TUI Dashboard** | 터미널 | 호스트 CPU | 터미널 (truecolor) | WebSocket :9120 | 로컬 | ✅ |

¹ **TC001 ⚠️ 는 샌드박스 제약이 아니라 구현 갭**: TC001 은 다른 ESP32 보드와 동일하게 USB serial / WiFi WS 로 붙어 state-JSON 을 자기 렌더하며 `com.apple.security.device.serial` entitlement 로 이미 커버된다(`tui-dashboard.test.ts` 가 TC001 을 serial board 로 보고). 현재 Swift(App Store) 데몬에 `led8x32` 경로가 미검증이라 CLI-tier. **과거 "ADB" 표기는 legacy/dead code 였고 2026-06-25 제거됨** — `AdbDeviceClass.ulanziTc001` 와이어 클래스를 emit 하는 producer 가 없었고(`TopologyRail.pixelDisplaySection`·`MenuBarTopologyList` 의 ADB 분기는 죽어 있었음), 라이브 경로는 serial 이다. `AdbModule.classifyDevice` 분기 · `AgentState.AdbDeviceClass.ulanziTc001` 케이스 · 두 UI 룩업을 모두 삭제했다(라이브 TC001 row 는 USB-serial 섹션 `esp32DisplayName` 으로 그대로 표시). 남은 App Store ⚠️ 는 Swift 데몬 `led8x32` 경로 **HW 검증**만 후속 — 검증 후 ✅ 승격 가능.
² **Android 은 e-ink 와 태블릿을 분리해야 정확하다.** Android 앱은 mDNS LAN(iOS 와 동일) + ADB localhost 양쪽 지원. USB-테더 e-ink 는 App Store Mac 앱이 `adb reverse` 서브프로세스를 못 띄워 CLI 전용(**진짜 제약**). 그러나 **같은 LAN 의 Android 태블릿은 mDNS 로 App Store Mac 데몬에 직접 접속 가능** — 태블릿까지 ❌ 로 묶는 건 과분류라 ⚠️ 로 표기.
³ Elgato Stream Deck 앱 별도 설치 필요 (플러그인 호스트). 표준 15키(`agentdeck-sd`, DeviceType 0), Mini(`agentdeck-sdmini`, DeviceType 1), SD+(`agentdeck-sdplus`, DeviceType 7, 다이얼+터치스트립)는 동일 플러그인의 번들 프로파일이다. XL(DeviceType 2)은 `familyForDeviceType()`의 그리드 산출은 지원하지만 번들 프로파일은 아직 없다.
\* **SSE 풀 스트리밍은 Node 브리지(`bridge/src/hook-server.ts`, `broadcastSse`) 한정.** App Store macOS **Swift 데몬**(`DaemonServer.swift`)의 `/sse` 는 `event: connected` 1회 후 끊는 **스텁**이라 스트리밍 안 함 — App Store 빌드에서 라이브 SSE 대시보드를 쓰려면 외부(Node) 데몬 필요. 실 소비자는 리포 내 `/status`·`/pixoo` HTML 대시보드(인라인 EventSource).

⁴ **InkDeck = experimental (펌웨어 개발 중)**: 하드웨어는 **Seeed TRMNL 7.5" OG DIY Kit** — XIAO ESP32-S3 Plus + 800×480 monochrome e-ink (GDEY075T7 / UC8179), 상시 USB 급전. `esp32/`의 `inkdeck` 환경은 WiFi WS 연결, 연결 직후 `device_info` 자발 발신, state 수신, OTA capability 보고를 구현했고 Node/Swift 데몬도 WiFi ESP32 presence를 등록한다. 남은 ⚠️는 프로토콜 부재가 아니라 **실기 렌더·부분/전체 refresh 및 출하 준비 검증이 끝나지 않았음**을 뜻한다. 전송은 다른 ESP32와 같은 서브프로세스 없는 LAN 경로라 샌드박스 제약이 아니다. **구 "TRMNL" 상용 BYOS pull 통합은 제거됨**(Node commit `c71044bd`) → 순정 TRMNL 펌웨어 패널 미지원.

⁷ **XTeink X3/X4 = experimental (펌웨어 개발 중, 대시보드 등록은 구현됨)**: ESP32-C3 e-ink 리더로, AgentDeck 펌웨어가 아니라 오픈소스 **CrossPoint Reader 포크**(`crosspoint-agentdeck`, AgentDeck 스택 branch `master`)로 "Decision Card" 펌웨어를 개발 중이다. **하나의 펌웨어**가 런타임에 X3/X4 를 자동 감지(`gpio.deviceIsX3()`, I2C IMU 지문)해 보드 문자열 `xteink_x3`/`xteink_x4` 를 발신한다. 등록 경로는 **이중**: ① `client_register{clientType:"eink-device"}` → **macOS 대시보드 E-ink rail** 에 표시(이미 구현), ② `device_info{board}` → **Node 데몬 `esp32-wifi`** 레지스트리에 등록(추가됨). 즉 업데이트된 포크 펌웨어를 플래시하면 대시보드에 표시된다. 전송은 WiFi WS — 다른 ESP32 보드와 동일하게 서브프로세스 없는 LAN 경로라 샌드박스 제약은 아니다. **소유 유닛은 pogo USB-data 패드 사망 → SD `update.bin` 플래시가 유일 경로**라 AgentDeck `esp32/` 에 board def/pio env 가 없다(→ WiFi OTA 대상 아님, `otaSupported:false`). ⚠️ 는 e-ink 렌더가 아직 개발 중 + 온디바이스 플래시 대기라는 뜻. 포크가 포팅하는 와이어 계약은 [esp32-client-contract.md](esp32-client-contract.md) 가 SSOT.

> **포트는 가변**: ESP32 보드의 `/dev/cu.*` 포트 번호는 USB 허브 위치·재연결 순서에 따라 바뀐다. 절대 포트 번호로 보드를 구분하지 말고 `device_info_request` 로 식별한다 ([docs/esp32.md](esp32.md) Flash Safety).

---

## A. ESP32 펌웨어 디스플레이 보드

공통: PlatformIO + Arduino framework, espressif32 toolchain, **LVGL 9.2.0** UI(TC001·XTeink X3 제외), monitor 115200 baud, flash mode DIO. 이중 경로(**USB Serial** 기본 + **WiFi WebSocket** 독립). 출처: [`esp32/platformio.ini`](../esp32/platformio.ini), [`esp32/boards/board_*.h`](../esp32/boards/), [docs/esp32.md](esp32.md).

> **env 이름 두 층**: `friendly명` 은 `esp32/scripts/flash.sh` 가 받는 **canonical 친근명**(panel/form + 인치 규칙: 3.5→35·1.8→18·1.14→114·1.47→147·10.1→101)이고, `pio env` 는 `platformio.ini` 의 실제 `[env:...]`(불변). flash.sh 가 친근명→pio 로 매핑하며 legacy 별칭(`round_amoled`·`ttgo`·`ips10` 등)도 계속 받는다. CI/`pio run -e` 는 pio env 를 쓴다.

| 보드 | friendly명 | pio env | 모델 (제조사) | SoC | 해상도 | 디스플레이 IC | 터치 IC | Flash | PSRAM | USB-UART |
|---|---|---|---|---|---|---|---|:---:|:---:|---|
| **IPS 3.5"** | `ips_35` | `ips35` | JC3248W535 (Guition) | ESP32-S3 | 480×320 | AXS15231B (QSPI) | 통합(AXS15231B) | 16MB | ✅ (qio_opi) | Native USB JTAG |
| **Round AMOLED 1.8"** | `amoled_18` | `amoled` | JC3636W518 (Guition) | ESP32-S3 | 360×360 (원형) | ST77916 (QSPI) | CST816S (I2C) | 8MB | ✅ | Native USB JTAG |
| **86 Box 4"** | `box_40` | `box_86`⁶ | ESP32-S3-4848S040 (Guition) | ESP32-S3 | 480×480 | ST7701 (RGB 16-bit 병렬) | GT911 (I2C) | 16MB | ✅ | CH340 |
| **TTGO T-Display 1.14"** | `tft_114` | `ttgo` | LilyGO T-Display | ESP32-D0WDQ6 (classic) | 135×240 | ST7789 (SPI) | 없음 (버튼 2개) | 16MB | ❌ | CH340⁴ |
| **IPS 10.1"** | `ips_101` | `ips10` | JC8012P4A1C (Guition) | ESP32-P4NRW32 (RISC-V dual-core 400MHz) | 800×1280 (세로) | JD9365 (MIPI-DSI) | GSL3680 (I2C) | 16MB⁵ | ✅ 32MB | CH340 |
| **XTeink X3**⁷ | — | — | XTeink X3 (XTeink) | ESP32-C3 (RISC-V, single-core) | 528×792 (3.7" e-ink, 세로) | e-ink EPD (컨트롤러 미확정) | 없음 | 4MB | ❌ | pogo USB (이 유닛 데이터 사망) |
| **XTeink X4**⁷ | — | — | XTeink X4 (XTeink) | ESP32-C3 (RISC-V, single-core) | 800×480 (e-ink) | e-ink EPD | 없음 | 16MB | ❌ | pogo USB / SD update.bin |

⁴ TTGO 플래시는 57600 baud + `--no-stub` (느림 ~5분). PSRAM 없는 classic ESP32 라 정적 DRAM 여유 ~10KB → 테라리움은 135×160/160×135 제한 버퍼.
⁵ ESP32-P4NRW32 모듈은 16MB Flash + 32MB PSRAM 을 통합한다. AgentDeck `ips10` 펌웨어도 2026-07-05 이후 `board_build.flash_size=16MB` + `jc8012p4a1c_ota.csv` dual-OTA layout(OTA 슬롯 각 6.0MB + SPIFFS)로 구성. WiFi 는 co-processor **ESP32-C6-MINI-1U-N4** 가 담당(esp-hosted), TX 파워 20dBm.
⁶ `box_86` 의 legacy 중복 env `rgb48` 가 `platformio.ini` 의 `default_envs` 다(같은 `box_86_ota.csv` 16MB dual-OTA 파티션, platform source 만 다른 near-dup). 친근명 정리 범위에서 pio env 는 건드리지 않아 그대로 유지 — `pio run` 무인자 빌드 시 `rgb48` 가 선택됨에 주의.
⁷ **XTeink X3 = experimental.** AgentDeck `esp32/` 펌웨어가 아니라 오픈소스 **CrossPoint Reader 포크**(`crosspoint-agentdeck`, AgentDeck 스택 branch `master`)로 "Decision Card" 펌웨어 개발 중 → `friendly명`/`pio env` 없음, LVGL 미사용(CrossPoint `GfxRenderer`). 전송은 WiFi WS(계획). 소유 유닛은 USB-data 패드 사망 → SD `update.bin` 플래시만 가능. 종합 매트릭스 각주⁷ 참조.

**보드별 특이사항**
- **IPS 3.5"**: full flash 시 `--flash_size 16MB` 명시(부트루프 중 8MB 오감지 방지). OTA + FAT.
- **86 Box**: 물리 릴레이 3개 탑재. 16MB `box_86_ota.csv` dual-OTA layout(슬롯 각 ~7.75MB). 현재 실험실 유닛은 2026-07-05 USB 마이그레이션 후 daemon에서 `86box ... OTA 7.8MB`로 검증 완료. 기존 NO_OTA/factory 펌웨어에서 OTA를 시작하려면 최초 1회 USB full flash로 파티션 테이블을 마이그레이션해야 한다.
- **IPS 10.1"**: 렌더는 PPA HW 회전 + LVGL 버퍼 MALLOC_CAP_INTERNAL 필수(PSRAM 폴백 30× 느림). C6 슬레이브는 죽은 saved-AP 로 STA connect 시 ESP-Hosted assert 크래시 주의. 16MB `jc8012p4a1c_ota.csv` dual-OTA layout(슬롯 각 6.0MB)로 OTA 가능하며, 현재 실험실 유닛은 2026-07-05 USB 마이그레이션 후 daemon에서 `ips_10 ... OTA 6.0MB`로 검증 완료. 기존 4MB/factory 펌웨어는 최초 1회 USB full flash 필요.
- 디스플레이 IC 가 잘못 플래시되면 Native USB 보드는 USB PHY 가 끊겨 포트가 잠깐만 살았다 사라진다 — 하드웨어 사망 아님(복구는 BOOT/RST → ROM download → full flash).

---

## B. LED 매트릭스 디바이스

| 디바이스 | 종류 | 컨트롤러 | 해상도 | 전송 | 연결성 | 드라이버 |
|---|---|---|---|---|---|---|
| **Divoom Pixoo64** | 상용 LED 액자 | Divoom 내장 (비-ESP32) | 64×64 RGB | HTTP REST (port 80, Divoom API) | WiFi 2.4G | `bridge/src/pixoo/` (Node) / `PixooRenderer.swift` |
| **iDotMatrix 32×32** | 상용 BLE 픽셀 | BLE SoC (비-ESP32) | 32×32 RGB AMOLED | BLE GATT (transparent-UART) | Bluetooth LE | `bridge/src/idotmatrix/sync.py`(bleak) / `IDotMatrixModule.swift`(CoreBluetooth) |
| **Divoom Timebox Mini** | 상용 BLE 픽셀 | BLE SoC (비-ESP32) | 11×11 RGB | BLE GATT (ISSC transparent-UART, 20B chunk) | Bluetooth LE | `TimeboxBLE.swift`(CoreBluetooth) / `bridge/src/timebox/sync_ble.py`(bleak) |
| **Ulanzi TC001** | ESP32 펌웨어 | ESP32 classic (D0WD) | 8×32 = 256 WS2812B LED (serpentine) | USB Serial / WiFi WS | USB-Serial + WiFi | env `led8x32`, **FastLED 3.7.0** (LVGL 미사용) |

- **Pixoo64**: 인증 없음, LAN IP 자동/수동(`pixoo.json`). push-only, 4종 이벤트. PicID 단조 증가 필수. 지원 전송면은 LAN HTTP REST이며 공개된 raw-frame BLE 경로는 없다. 활동 상태는 2.5s moving-single, idle 10s, 상태변화 floor 1s. 하단 14px는 공식 마스크에서 축소한 9×7 Claude/Codex 크리처 실루엣으로 행을 구분하고, 동일한 provider row 안에 primary/5h·secondary/7d 사용률과 reset countdown을 표시한다. 실기 펌웨어에서 multi-frame GIF 요청 직후 REST timeout + ping 60–87.5% 유실을 확인해 기본 경로에서 완전히 제외했다. HTTP 실패 attempt rate-limit, fresh-session self-heal, circuit breaker를 병행한다.
- **iDotMatrix**: USB 는 전원 전용(데이터 포트 없음). 컨트롤러가 BLE SoC 라 ESP32 펌웨어 구동 불가([`platformio.ini`](../esp32/platformio.ini) 주석). Node/Swift는 완성된 64px 장면 축소 대신 **네이티브 32×32 identity stage**로 공식 마크를 물리 18/13/10px에 직접 합성하고 Claude 5h/7d + Codex primary/secondary 4줄 rail을 표시한다. CLI/Swift 출력 보정은 brightness 1.22 / contrast 1.08. BLE 단일 연결 → 데몬당 1대. 브라이트니스 5–100%.
- **Divoom Timebox Mini**: 11×11 = 121 RGB LED. `TimeBox-mini-light` (BLE) — ISSC transparent-UART (service `49535343-FE7D-…`, write char `49535343-8841-…`, 20B write-without-response chunk). App Store Swift 앱은 네이티브 CoreBluetooth(`TimeboxBLE/Module/DivoomPacket.swift`). 전용 **Agent Beacon**은 중앙의 SVG 생성 9×9 공식 마크에 4-bit-safe 명암을 주고, 연속된 dim 상태 프레임 위에서 상태 강조점만 움직인다. 과거 hand-authored 대체 크리처 표는 제거했다. 토큰 rail은 identity 훼손을 피하려고 의도적으로 생략한다. 프레임 폴링 ~1.5s. **iDotMatrix 와 동일하게 데몬당 BLE 단일 연결** — 둘 다 뜨면 하나만 구동. (과거 Bluetooth Classic SPP 변종은 호환성·App Store 제약으로 제거됨 — BLE 단일 경로.)
- **TC001**: flash 8MB, PSRAM 없음, CH340 UART. 부가 HW — 버튼 3개, 부저, LDR 광센서(adaptive brightness), 배터리 모니터, DS1307 RTC(I2C). AGENTS/Claude usage 외에 violet Codex primary/secondary token-limit 페이지를 데이터가 있을 때 자동 순환한다. stale Codex window는 숨긴다. disconnect 시 매트릭스에 상태 텍스트(`CONNECT WIFI`/`FINDING BRIDGE`/`DAEMON DOWN Xm`). **App Store ⚠️ 사유는 종합 매트릭스 각주¹ 참조 — serial entitlement 으로 커버되는 구현 갭이지 샌드박스 제약 아님.**

> **Zero-config 자동 발견** (Pixoo·iDotMatrix·Timebox 는 ESP32/Stream Deck 과 달리 self-advertise 안 함 → 수동 IP/MAC 입력이 기존 갭이었다):
> - **Pixoo64**: mDNS 광고 없음 → 데몬이 미설정 시 로컬 /24 **서브넷 스윕**으로 `Channel/GetAllConf` 응답(`Brightness` 필드) 호스트를 자동 탐지·등록. **Node**(`bridge/src/pixoo/pixoo-discover.ts`) + **App Store Swift**(`PixooModule.autoDiscoverIfNeeded`, 로컬 HTTP 만 → 서브프로세스/외부서비스 없음, 권한 프롬프트 없음) 양쪽 구현. Divoom 클라우드 LAN API 는 Node fallback 으로만 사용.
> - **iDotMatrix·Timebox(BLE)**: **Node** 데몬은 기존 `scan*.py`(bleak)로 부팅 시 자동 스캔·등록(`*-discover.ts`). **App Store Swift 는 의도적으로 부팅-자동스캔 안 함** — CBCentralManager 생성이 *모든* 사용자에게 Bluetooth 권한 프롬프트를 강제하므로, BLE 발견은 설정 시트(`IDotMatrixSheet`/`TimeboxSheet`)의 **사용자 트리거 Scan** 으로 유지.
> - 공통 규칙: **미설정(0대)일 때만 auto-add**(공유 LAN 에서 이웃 기기 가로채기 방지) + `{pixoo,timebox,idotmatrix}AutoDiscover: false` 로 opt-out.

---

## C. 입력 / 제어 하드웨어 (HID 데크)

### Ulanzi D200H "Deck Dock"

상용 USB HID 매크로 데크. **Ulanzi Studio 플러그인**(`plugin-ulanzi`, daemon WS 등록 시 `clientType: 'ulanzi-plugin'`)이 **유일한 지원 드라이버** — D200H 는 Mac Ulanzi Studio 앱을 통해야만 안정적으로 렌더된다. Node direct-HID는 2026-07-08 삭제됐고 Swift direct-HID·USB entitlement·legacy hardware-research tree도 2026-07-14 삭제됐다. D200H 연결성은 `ulanzi-plugin` WS presence로만 보고한다. 출처: [docs/plugin-conventions.md](plugin-conventions.md) §D200H.

| 항목 | 사양 |
|---|---|
| **SoC** | SigmaStar SSD210 — dual ARM Cortex-A7 @ 1GHz, 64MB DDR2 SIP |
| **RAM** | 33MB total (~16MB free) |
| **패널** | nv3052c LCD, 물리 540×960 (TTL 6BIT, 59fps) → `rotateScreen:90` 논리 **960×540** 가로, BGRA32 |
| **키** | 14 keys (3행×5열, Row2 의 col3+col4 합체), 키 ~192×180px |
| **OS** | FlythingsOS V2.1 (`Zkswe_SSD21X_SPINOR`) |
| **연결성** | USB HID (WiFi 없음) — VID `0x2207` / PID `0x0019`, 1024B 패킷, 헤더 `0x7C7C`, ZIP 청킹 |
| **드라이버** | **유일**: Ulanzi Studio 플러그인 `plugin-ulanzi/`(daemon WS). direct-HID 구현은 양쪽 데몬에서 삭제됨 |
| **App Store** | ✅ — Ulanzi Studio 플러그인이 단일 드라이버. AgentDeck.app은 D200H USB/HID entitlement를 요청하지 않음 |

> D200H의 물리 USB/HID 처리는 Ulanzi Studio가 소유한다. AgentDeck은 plugin WebSocket 연결만 관측한다.

### Elgato Stream Deck (표준 15키) · Mini · Stream Deck+

하나의 플러그인이 세 Elgato 하드웨어를 번들 프로파일로 지원한다. 액션 코드는 디바이스-불문이며 `familyForDeviceType()`(`plugin/src/actions/session-slot-button.ts`)가 등록된 디바이스의 `size.columns × size.rows`로 키패드 슬롯(`slot = row*columns + col`)을 자동 산출한다.

| 항목 | 표준 Stream Deck (15키) | Stream Deck Mini | Stream Deck+ |
|---|---|---|---|
| **프로파일** | `agentdeck-sd` (DeviceType **0**) | `agentdeck-sdmini` (DeviceType **1**) | `agentdeck-sdplus` (DeviceType **7**) |
| **키패드** | LCD 키 **15개 (5×3)** | LCD 키 **6개 (3×2)** | LCD 키 **8개 (4×2)** |
| **인코더/스트립** | 없음 | 없음 | 로터리 인코더 **4개** + LCD 터치 스트립 |
| **키 용도** | 전부 Session Slot 버튼 | 전부 Session Slot 버튼 | 전부 Session Slot 버튼 |
| **추가 지원** | XL(DeviceType 2)은 동적 그리드 산출만 지원하며 번들 프로파일 없음 | — | — |

- **공통**: 호스트 USB → Elgato Stream Deck 앱 플러그인 → daemon WebSocket(:9120). Stream Deck SDK v2, UUID `bound.serendipity.agentdeck`. 양방향, BridgeEvent 13종 전부.
- **인코더 매핑(SD+ 전용)**: E1 유틸리티(볼륨/마이크/미디어/타이머) · E2 액션(프롬프트/옵션) · E3 터미널 · E4 음성. 음성 takeover 시 E2–E4 wide-canvas 병합.

출처: [docs/streamdeck-layout.md](streamdeck-layout.md), [docs/v4-layout.md](v4-layout.md), [docs/devices.md](devices.md).

---

## D. 모바일 / 데스크톱 소프트웨어 플랫폼

### Apple (iOS · iPadOS · macOS)

SwiftUI Multiplatform 단일 코드베이스. App Store 배포(`bound.serendipity.agent.deck`). 출처: [`apple/project.yml`](../apple/project.yml), [docs/appstore-feature-matrix.md](appstore-feature-matrix.md).

| 항목 | macOS | iOS / iPadOS |
|---|---|---|
| **최소 OS** | macOS **26.0** | iOS / iPadOS **17.0** |
| **빌드** | Xcode 26.4, Swift 6.0 | Xcode 26.4, Swift 6.0 |
| **아키텍처** | Apple Silicon (arm64) + Intel (x86_64) universal | A-series / M-series |
| **데몬** | **in-process Swift daemon** (port 9120, Node 불필요) | WS client → 외부 daemon |
| **샌드박스** | App Store sandbox, 서브프로세스/번들 인터프리터 0 (`AGENTDECK_APP_STORE`) | App Store sandbox |
| **엔타이틀먼트** | audio-input · bluetooth · serial · usb · network(client/server) · user-selected files | — (HW 엔타이틀먼트 없음, WS only) |

> macOS 만 하드웨어 모듈(ESP32 serial / D200H USB / Pixoo·iDotMatrix·Timebox BLE) 직접 구동. iOS/iPadOS 는 same-LAN WebSocket 뷰어 컴패니언.

### Android (e-ink 리더 · 태블릿)

Jetpack Compose 런처 앱 (`dev.agentdeck`). 출처: [`android/app/build.gradle.kts`](../android/app/build.gradle.kts), [docs/android.md](android.md), [docs/android-ui.md](android-ui.md).

| 빌드 항목 | 값 |
|---|---|
| **minSdk** | 29 (Android 10) |
| **targetSdk / compileSdk** | 34 (Android 14) |
| **JDK** | 17 |
| **언어/UI** | Kotlin + Jetpack Compose |

**디바이스 매트릭스** (e-ink 벤더별 EPD API 분기)

| 디바이스 | 칩 / 벤더 | 디스플레이 | EPD API |
|---|---|---|---|
| **Crema S** | Rockchip RK3566 | B&W e-ink (16-level grayscale) | `android.os.EinkManager` — `setMode()` + `sendOneFullFrame()` |
| **Onyx Boox** | Onyx | B&W / 컬러(Kaleido 3) e-ink | `BaseDevice.setViewDefaultUpdateMode()` |
| **MOAAN Pantone 6** | Rockchip (rebrand) | 컬러 e-ink (Kaleido 3, 4096색) | `EinkManager` (manufacturer=`moaan`) |
| **Bigme** (Galy / inkNote) | Bigme | 컬러 e-ink (Gallery 3/4) | 컬러 팔레트 `einkPick()` |
| **Kobo** (Android) | Kobo | B&W e-ink | fallback `invalidate()` |
| **일반 태블릿** (Lenovo 등) | ARM/x86 | 컬러 LCD 60fps | 표준 Android 렌더 (e-ink 감지 없음) |

> e-ink 리프레시 모드: GC16(표준) · DU(dither partial) · A2(fast partial). 컬러 e-ink 는 1/4 해상도 컬러 / full 해상도 B&W.
>
> **연결 모델 (중요)**: Android 앱은 **mDNS LAN(`_agentdeck._tcp`, iOS 와 동일) + ADB localhost** 양쪽을 지원하며 localhost 먼저 시도 후 실패 시 mDNS 폴백 (`BridgeDiscovery.kt`, `MainActivity.kt`). 따라서 **App Store 게이팅은 디바이스가 아니라 _프로비저닝 방식_ 에 걸린다** — USB-테더 e-ink 는 Mac 앱이 `adb reverse` 서브프로세스를 못 띄워 CLI 데몬 필요(진짜 제약), 같은 LAN 의 태블릿은 mDNS 로 App Store Mac 데몬에 직접 접속 가능(현재 코드로 동작). 종합 매트릭스 각주⁴ 참조.

#### 왜 Android 렌더링이 iOS(SwiftUI)와 다른가 — 근본적 차이, 통일 이득 없음

Android 는 **e-ink 리더 자체가 타깃 디바이스**(Crema/Onyx/Kobo/Pantone/Bigme)이기 때문에 벤더별 EPD 제어 인프라를 갖는다 — `EinkDetector.kt`(제조사 화이트리스트), `EinkRenderer.kt`(16-level 그레이 양자화 + B&W 2.5fps / 컬러 10fps 보간), `EinkRefreshZone.kt`(GC16 full / DU partial / A2 fast 리프레시 존). iOS 는 **컬러 LCD/OLED 전용**이라 SwiftUI `Canvas` + `TimelineView` 60fps 면 충분하고, EPD 리프레시 모드라는 개념 자체가 OS 에 없어 분기할 수 없고 분기할 필요도 없다.

**이미 통일된 부분은 데이터/프로토콜 계층**이다 — Android·iOS 모두 동일한 `shared/src/protocol.ts` WebSocket dialect(StateUpdate/PromptOptions/Usage/… + PluginCommands)를 송수신한다. 갈라지는 건 (1) **렌더 파이프라인**(e-ink 양자화·리프레시 존 vs SwiftUI Canvas)과 (2) **디스커버리 플러밍**(Android `NsdManager`/OkHttp vs iOS `NWBrowser`/`URLSessionWebSocketTask`)뿐이며, 둘 다 플랫폼-네이티브가 더 안정적이라 의도된 최적화다. 더 "통일"하려면 iOS 에 무의미한 no-op e-ink shim 을 얹어야 해서 **유지보수가 오히려 나빠진다** — 현 구조(공유 프로토콜 + 플랫폼별 렌더)가 옳다.

---

## E. 터미널 Surface

### TUI Dashboard (`agentdeck dashboard`)

| 항목 | 사양 |
|---|---|
| **요건** | truecolor 지원 터미널 (의존성 0) |
| **연결** | WS client → daemon(`findDaemonPort()`: `daemon.json` → `sessions.json` fallback) |
| **렌더** | raw ANSI escape, braille 테라리움, 3단 반응형 레이아웃 (wide 120+ / standard 80–119 / narrow 60–79) |
| **이벤트** | BridgeEvent 13종 (push-only 뷰) |

출처: [docs/tui-dashboard.md](tui-dashboard.md), `bridge/src/tui/`.

### SSE 스트림 (`GET /sse`)

| 항목 | 사양 |
|---|---|
| **전송** | HTTP Server-Sent Events, daemon port 9120 `/sse` |
| **인증** | token query param (local bypass) |
| **이벤트** | BridgeEvent 13종 전부 (필터링 없음), push-only |
| **용도** | 브라우저 대시보드 · 모니터링 스크립트 · 외부 연동 |
| **구현** | **풀 스트리밍은 Node 브리지 한정** — `bridge/src/hook-server.ts`(`broadcastSse`, 멀티클라이언트 레지스트리 + 30s 하트비트). App Store macOS **Swift 데몬**(`DaemonServer.swift`)은 `event: connected` 1회 후 끊는 **스텁**이라 스트리밍 안 함 |
| **실 소비자** | 리포 내 `/status`·`/pixoo` HTML 대시보드(인라인 EventSource JS) + 통합 테스트 |

출처: [docs/devices.md](devices.md), `bridge/src/hook-server.ts` (`broadcastSse`, `/status`·`/pixoo`), `bridge/src/index.ts`. (참고: OpenClaw **Gateway**(WS custom :18789, Ed25519)는 dashboard surface 가 아니라 **upstream agent adapter** 라 본 표에서 제외.)

---

## 평가 노트 — App Store 게이팅이 최선인가

종합 매트릭스의 ❌/⚠️ 가 **샌드박스 근본 제약인지, 단순 구현/분류 갭인지** 구분 (코드 근거):

| 항목 | 현재 표기 | 실제 사유 | 최선 여부 / 개선안 |
|---|:---:|---|---|
| **TC001** | ⚠️ | 구현 갭 + **문서 오류**. serial entitlement 으로 커버되는 self-rendering ESP32. Swift 데몬에 `led8x32` 경로 미검증. "ADB 필요" 표기는 Android 행 복붙 오기(`AdbModule.swift` 주석 포함) | **개선 권장**: 하드웨어 검증 후 App Store ✅ 승격 가능. appstore-feature-matrix·`AdbModule.swift` 주석의 오기 수정 필요 |
| **Android 태블릿** | ⚠️ | 과분류. mDNS 로 App Store Mac 데몬 직접 접속이 코드상 가능 | **개선 권장**: e-ink(USB/adb)와 태블릿(LAN/mDNS)을 별 tier 로 분리 |
| **Android e-ink** | ❌ | **진짜 제약**. USB-테더 + `adb reverse` 서브프로세스 필요 → sandbox 불가 | 현 구조가 합리적(e-ink WiFi 불안정·USB 운용 전제). 변경 불요 |
| **Timebox / iDotMatrix** | ✅ | CoreBluetooth 네이티브 | 최선. 단 둘 다 **데몬당 BLE 단일 연결** 제약 — 동시 1대만. (구 Timebox-SPP serial 변종은 호환성·App Store 제약으로 제거됨) |
| **SSE 스트림** | ✅* | **구현 갭**. 풀 스트리밍(`broadcastSse`, 멀티클라이언트+하트비트)은 Node 브리지(`hook-server.ts`)만 구현. App Store macOS Swift 데몬(`DaemonServer.swift`)은 `/sse` 가 `event: connected` 1회 후 끊는 **스텁** | **개선 권장**: 샌드박스 제약 아님(같은 HTTP 서버에 SSE 가능). Swift 데몬에 멀티클라이언트 SSE 구현 시 ✅ 승격. 현 App Store 빌드는 라이브 SSE 대시보드에 외부 Node 데몬 필요 |
| **D200H** | ✅ | Ulanzi Studio 플러그인이 **단일 드라이버**. direct-HID 구현·USB entitlement·legacy 연구 코드는 삭제 완료 | 최선. daemon은 plugin presence만 보고하며 HID 소유권 경합이 구조적으로 없음 |
| **XTeink X3/X4** | ⚠️ | **등록 구현됨**(experimental, 샌드박스 제약 아님). ESP32-C3 e-ink + 외부 **CrossPoint 포크** 펌웨어(`crosspoint-agentdeck`)가 `client_register{eink-device}` → macOS E-ink rail, `device_info{board}` → Node `esp32-wifi` 로 이중 등록. 전송은 다른 ESP32 와 동일한 WiFi WS(서브프로세스 없음) | **개선 예정**: e-ink 렌더 개발 중 + 업데이트 펌웨어 온디바이스 SD 플래시 대기라 ⚠️. 플래시 후 대시보드 표시 |

요약: **진짜 sandbox 제약은 e-ink(adb) 경로뿐**이고 CLI 대체 경로가 정당하다. **TC001·Android 태블릿의 ❌ 는 구현/분류 갭**이라 본 문서에서 ⚠️ 로 정정했고, **SSE ✅\* 는 Swift 데몬 SSE 미구현이라는 구현 갭**(샌드박스 제약 아님)이라 별도 표기했다. upstream 문서(appstore-feature-matrix.md)와 `AdbModule.swift`·`AgentState.swift`·`TopologyRail.swift` 의 ADB 오기를 정정하고 **legacy dead-code 는 2026-06-25 제거 완료**했다(TC001 의 ✅ 승격만 HW 검증 후속).

---

## 각주 · 검증 표기

- **수치 출처**: 본 문서의 SoC·해상도·Flash·SDK·VID/PID·deployment target 은 모두 리포 빌드 설정/보드 헤더에서 직접 추출 (`esp32/platformio.ini`, `esp32/boards/*.h`, `android/app/build.gradle.kts`, `apple/project.yml`, `docs/plugin-conventions.md`).
- **외부/상용 디바이스**(Pixoo64 · iDotMatrix · Divoom Timebox · Stream Deck+ · D200H)의 내부 실리콘 일부는 제조사 비공개이거나 역공학 결과 — 확정 가능한 값만 기재. Stream Deck+ 의 키/스트립 픽셀 사양은 Elgato 비공개 영역으로 생략.
- **이벤트 카운트**: WS 클라이언트(Stream Deck/Apple/Android/TUI/SSE)는 BridgeEvent 13종 전부, ESP32 serial 은 6종, Pixoo/iDotMatrix/Timebox 는 4종 ([docs/devices.md](devices.md) Device Matrix).
- 본 문서가 SSOT. HTML 뷰([docs/hardware/index.html](hardware/index.html))는 동일 데이터의 시각화이며 수치 변경 시 함께 갱신한다.
