# 2026-07-08 — 라운드 26: ESP32 단일경로 serial↔wifi 전송 (데몬 dedup + 펌웨어 라디오 파킹)

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
