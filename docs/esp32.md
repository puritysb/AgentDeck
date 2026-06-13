# ESP32 Firmware

PlatformIO Arduino firmware for LVGL touch displays (ESP32-S3: 86Box 480×480, IPS 3.5" 480×320 landscape / 320×480 portrait, Round AMOLED 360×360; ESP32-P4: Guition JC8012P4A1C 10.1" IPS 800×1280 portrait native + ESP32-C6 co-processor) + SPI TFT displays (ESP32 classic: LilyGO TTGO T-Display 1.14" 135×240 landscape native) + WS2812B LED matrix (ESP32 classic: Ulanzi TC001 8×32). Board-specific `#ifdef`, per-board partition tables, FastLED matrix renderer bypasses LVGL entirely. IPS 3.5" supports runtime portrait↔landscape switching via `set_orientation` protocol command or Settings toggle (NVS persistent, `g_screenW`/`g_screenH` runtime globals).

## Flash Safety

- **절대 `usbmodem` 포트 번호만 보고 IPS 3.5"와 Round AMOLED를 구분하지 말 것.** Native USB JTAG 보드는 허브 위치, 재연결 순서, 복구 모드에 따라 `/dev/cu.usbmodem*` 번호가 계속 바뀐다.
- **정상 부팅 중인 보드는 반드시 `device_info_request`로 보드 식별 후 플래시한다.** 기대값은 `ips35`, `amoled`, `rgb48`, `led8x32`.
- **`esp32/scripts/flash.sh auto`는 `device_info_request` 성공 시에만 자동 선택한다.** 응답이 없으면 추정하지 말고 중단해야 한다.
- **Native USB 보드가 벽돌 상태일 때는 BOOT/RST로 먼저 ROM 다운로드 모드에 진입시킨 뒤, 그 다음에만 수동 업로드한다.** 복구 모드에서는 `device_info_request`가 동작하지 않으므로 환경(`ips35` 또는 `amoled`)을 사람이 명시해야 한다.
- **한 번이라도 잘못된 디스플레이 펌웨어를 Native USB 보드에 올리면 USB가 잠깐만 살아 있다가 끊길 수 있다.** 이 상태는 하드웨어 사망이 아니라 잘못된 앱이 USB PHY를 끊는 케이스일 수 있다.
- **복구 업로드는 bootloader + partitions + firmware 전체를 다시 쓰는 full flash를 기본으로 본다.**
- **복구 직후 화면이 안 켜져도 먼저 부트 상태를 확인한다.** 계속 `esptool`이 즉시 붙으면 GPIO0/BOOT가 눌린 상태로 남아 ROM 다운로드 모드에 머물러 있을 가능성이 높다.
- **플래시 전에 반드시 `lsof /dev/cu.*` 로 daemon 시리얼 점유를 확인한다.** Swift daemon(`AgentDeck`)이 시리얼 포트를 점유하면 esptool이 "chip stopped responding" 오류를 낸다. Daemon 중지 후 플래시.
- **`config.h`의 `MAX_*` 상수는 `constexpr uint8_t`이므로 `#if MAX_OPENCODE > 0` 전처리기 가드를 쓰면 안 된다.** 전처리기는 constexpr을 인식 못해 항상 0으로 평가. 런타임 `if (MAX_OPENCODE > 0)` 또는 가드 없이 for 루프 조건으로 처리.
- **IPS 3.5" full flash 시 `--flash_size 16MB` (또는 `--flash-size 16MB`)를 명시한다.** esptool이 부트루프 중 flash size를 8MB로 오감지하여 파티션 테이블 검증 실패 유발.

## WiFi 독립 운용

ESP32 디스플레이는 **USB 시리얼** (기본) + **WiFi WebSocket** (독립 운용) 이중 경로 지원.

```bash
agentdeck wifi-setup --ssid "MyNetwork" --password "secret"
# → ~/.agentdeck/wifi-config.json 저장 (autoProvision: true)
# → daemon 재시작 시 ESP32에 자동 프로비저닝
```

**USB 연결 시**: daemon이 시리얼로 `wifi_provision` 전송 → ESP32 WiFi 자동 연결. **USB 분리 후**: ESP32가 저장된 자격증명으로 WiFi 재연결 → mDNS로 daemon 발견 → WebSocket 접속. WiFi 인터페이스 자동 감지 (`networksetup -listallhardwareports`), macOS Keychain 비밀번호 조회 지원. Daemon (`daemon-server.ts`)과 Session bridge (`index.ts`) 양쪽에서 auto-provisioning 동작.

## Disconnect 복구 (ESP32 firmware)

시리얼 10초 timeout + WebSocket 지수 backoff (1→8s). `main.cpp`는 `bridgeFound` 플래그 없이 **mDNS를 항상 폴링** → daemon IP 변경(DHCP 갱신, 호스트 이동) 즉시 감지 후 `wsDisconnect()`+새 IP로 `wsConnect()` 재바인딩. WS backoff가 15초 이상 saturated이면 `mdnsRefresh()`로 캐시 강제 무효화 (좀비 dns-sd 광고 상황 방어). `ws_client.cpp`의 `setReconnectInterval()`은 backoff 증가할 때마다 라이브러리 내부 타이머에 재동기화 (기존에는 `wsConnect()` 시점 값에 고정). `DashboardState.lastMessageMs`가 serial/WS TEXT 수신 시 갱신되어 UI에서 disconnect age 계산.

**TC001 matrix disconnect UI**: stale 스프라이트 대신 상태 메시지 (`CONNECT WIFI` / `FINDING BRIDGE` / `DAEMON DOWN Xm` / `NO WIFI Xm`) + 우상단 깜빡이는 빨간 점.

## 기기별 펌웨어 사양 및 포트 매핑 정보 (2026-06-10 기준)

현재 연결된 디스플레이 기기의 사양 및 OS 감지 포트입니다. 포트는 USB 허브 위치/재연결에 따라 변경될 수 있으며 `device_info_request`로 실시간 확인 필요.

| 기기 설명 | PlatformIO Env | 가로/세로 해상도 | 사용 칩셋 | 현재 포트 (2026-06-10) | 상태 |
|---|---|---|---|---|---|
| LilyGO TTGO T-Display 1.14" | `ttgo` | 135×240 (가로 오프셋 보정) | ESP32 | `/dev/cu.wchusbserial58A90021441` | ✅ 연결됨 |
| IPS 3.5" Display | `ips35` | 480×320 / 320×480 | ESP32-S3 | `/dev/cu.usbmodem834101` (Native USB) | ✅ 연결됨 |
| Round AMOLED | `amoled` | 360×360 | ESP32-S3 | `/dev/cu.usbmodem2111201` (Native USB) | ✅ 연결됨 |
| 86 Box | `box_86` | 480×480 | ESP32-S3 | `/dev/cu.wchusbserial2112320` (CH340) | ✅ 연결됨 |
| 10" IPS Display | `ips10` | 800×1280 | ESP32-P4 | `/dev/cu.wchusbserial211240` (CH340) | ✅ 연결됨 |

