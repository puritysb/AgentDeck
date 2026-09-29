# 2026-07-18 — IPS10 ESP-Hosted SDIO 패닉: 런타임 deinit 제거

### 원인과 수정
- IPS10이 `reset=panic code=4`로 19~494초마다 실제 재부팅했고, raw serial에는 `sdio_rx_get_buffer` / `sdio_push_data_to_queue (pkt_rxbuff)` assert 뒤 `SW_CPU_RESET`이 남았다. USB serial 첫 JSON 직후 `wifiSetRadioParked(true)`가 `WiFi.mode(WIFI_OFF)`를 호출하고, Arduino P4 remote-WiFi 구현이 이를 `esp_wifi_deinit()` → `hostedDeinitWiFi()`까지 내려 보내 RX 중인 SDIO 버퍼 수명과 경합하는 경로였다.
- `BOARD_IPS10`의 serial-primary parking을 완전 radio-off가 아닌 **STA quiesce**로 변경했다. WebSocket을 먼저 닫고 `WiFi.disconnect(false, 1000)`로 AP 연결만 해제하며 ESP-Hosted/SDIO transport는 계속 초기화된 상태로 둔다. `wifiRadioParked()`는 mDNS/WS 루프를 억제하므로 네트워크 트래픽은 멈추되 in-flight RX 버퍼를 파괴하지 않는다. 다른 ESP32 보드는 기존 `WIFI_OFF` 정책을 유지한다.
- USB가 끊기면 저장 credential로 STA를 복구한다. cold boot에서 credential이 없어 이미 `WIFI_OFF`였던 경우에만 STA mode를 다시 초기화한다.

### 검증·배포 상태
- `/opt/homebrew/bin/pio run -e ips10` 성공: RAM 29.0%, Flash 64.7%, firmware 4,068,386B. PATH의 `/usr/local/bin/pio`는 기존 x86_64 Python/arm64 littlefs 불일치로 실패해 arm64 경로를 사용했다.
- WiFi OTA를 두 번 시도했으나 구펌웨어가 전송 약 15초 안에 다시 패닉해 각각 `no_active_update`로 중단됐다. CH340 `/dev/cu.wchusbserial21110`도 macOS driver wedge가 발생했으나 물리적으로 재연결해 복구했다. 이후 USB full flash가 전체 data hash 검증까지 성공했고(`buildHash=aa91e5a1-dirty`, `buildEpoch=1784343722`), CLI daemon 재연결 시 `wifiRadioParked=true`, `wifiConnected=false` 상태에서 연결/stale 없이 추정 uptime 501초까지 단조 증가했다. 이는 기존 관측 최장 재부팅 간격 494초를 넘긴 짧은 soak이며 새 SDIO 패닉 로그는 없었다. 장시간 현장 안정성은 계속 확인한다.
