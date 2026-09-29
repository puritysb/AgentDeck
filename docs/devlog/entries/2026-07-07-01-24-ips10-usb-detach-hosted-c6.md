# 2026-07-07 — 라운드 24: IPS10 USB detach 무한재부팅 원인 확정 및 hosted C6 즉시 파킹

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
