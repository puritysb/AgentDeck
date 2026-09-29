# 2026-06-07 — CLI daemon serial open FD leak / stale registry 정리

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
