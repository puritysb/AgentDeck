# 2026-07-04 — InkDeck 최초 실기 플래시: TRMNL 패널 하드웨어 실체 확정 + 8MB boot-loop 수정 + 부팅/상태 UI 렌더링 확인

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
