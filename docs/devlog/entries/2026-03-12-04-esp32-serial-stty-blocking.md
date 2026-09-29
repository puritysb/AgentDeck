# 2026-03-12 — ESP32 serial `stty` blocking 수정

### 문제
`sdc` 시작 시 `startESP32Serial()` → `execSync('stty -f /dev/cu.usbmodem201301 ...')`가 USB 디바이스 불량 상태(uninterruptible kernel I/O)에서 무한 블로킹. `execSync` timeout이 SIGTERM 보내지만 커널 I/O 대기 중인 `stty`는 SIGTERM 무시. Node.js 이벤트 루프 전체 정지 → WebSocket 서버 생성, 터미널 attach 모두 불가.

### 해결
`execSync` → async `exec` + Promise 래퍼 (`execWithKill`). 3초 timeout 후 SIGTERM, +1초 후 SIGKILL 에스컬레이션. `detectESP32Ports()`, `openPort()`, `pollForDevices()` 모두 async 전환. `startESP32Serial()`은 sync 유지하되 `pollForDevices().catch()` fire-and-forget 호출 — 브리지 startup을 절대 블로킹하지 않음. 10초 poll interval이 실패한 디바이스 자동 재시도.

### 교훈
- **Node.js에서 `execSync`는 시한폭탄**: 외부 프로세스가 커널 I/O에 갇히면 timeout+SIGTERM으로도 해결 불가. USB/시리얼 관련 명령은 반드시 async + SIGKILL 에스컬레이션
- **Bridge startup path에 sync I/O 금지**: 하나의 불량 디바이스가 전체 서비스 startup을 막을 수 있음

---
