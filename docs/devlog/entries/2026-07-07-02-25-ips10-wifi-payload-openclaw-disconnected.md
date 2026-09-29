# 2026-07-07 — 라운드 25: IPS10 WiFi payload 축약 + OpenClaw disconnected 오표시 수정

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
