# 2026-04-04 — ESP32 시리얼 FD 누수 + TC001 SEARCHING 고착

### 문제
TC001이 SEARCHING 상태에서 벗어나지 못함. Daemon `/health` status에서 `connected: true`이지만 `deviceInfo: null`.

### 진단
1. **Daemon 사망**: `daemon.json`의 PID가 실제 프로세스 없음 → 아무도 TC001에 JSON을 보내지 않음
2. **FD 누수**: daemon restart/wake 사이클마다 같은 시리얼 포트에 `open()` 호출하지만 기존 FD 미해제. `lsof`로 확인 시 `/dev/cu.wchusbserial211340`에 FD 5개 동시 오픈
3. **macOS tty 경합**: 동일 시리얼 디바이스에 복수 FD open 시 커널 tty 레이어에서 데이터 송수신 불안정

### 근본 원인
- `stop()` — `pollTask?.cancel()` 후 task 완료를 기다리지 않아 in-flight `pollForDevices()`가 새 FD를 열 수 있음
- `handleWake()` — connections 수동 정리 + 즉시 `pollForDevices()` 호출, 기존 read thread가 아직 살아있어 FD 미해제
- `openAndRegisterPort()` — 같은 포트에 기존 연결이 있어도 확인 없이 새로 open

### 해결 (`ESP32Serial.swift`)
- `ReadToken` 클래스: read thread 종료를 thread-safe하게 제어
- `openAndRegisterPort()`: 같은 포트 기존 연결 close → token invalidate → 제거 후 open
- `stop()` → `async`: `await pollTask?.value` 등으로 task 완료 대기
- `handleWake()` → `await stop()` + `start()` (완전 정지 후 재시작)
- heartbeat: `deviceInfo == nil` 30초 타임아웃 시 자동 재연결

### 핵심 교훈
- **macOS 시리얼 포트 복수 open은 위험**: 같은 `/dev/cu.*`에 여러 FD가 열리면 tty 레이어 경합으로 데이터 전달이 불안정해진다
- **Swift actor Task cancel은 cooperative**: `cancel()` 호출만으로는 즉시 중단 안 됨. `await task?.value`로 완료 대기 필수
- **D200H 로그 이중 출력**: `debugLog()`가 `DaemonLogger` + `NSLog` 양쪽에 써서 Xcode 콘솔에 2줄씩 출력됨 (broadcast 중복이 아님)

---
