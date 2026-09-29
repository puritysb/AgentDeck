# 2026-04-02 — Swift Daemon ESP32 Serial 통신 수정

### 문제
Swift daemon에서 ESP32 3대 (Round AMOLED, IPS 3.5", Ulanzi TC001)가 모두 화면이 꺼져 있었다. 시리얼 포트 4개가 connected 상태였지만 `deviceInfo`가 전부 null — device_info 응답을 수신/파싱 못함.

### 해결
3중 버그:
1. **FileHandle.readabilityHandler 미작동**: macOS의 dispatch source가 시리얼 포트 fd에서 제대로 트리거되지 않음 → DispatchQueue + `Darwin.read()` 50ms polling으로 교체
2. **Swift actor executor 경합**: read 스레드에서 `Task { await actor.handleReadData() }` 호출 시 actor 접근이 대기 상태에 빠짐 → `NSLock` 기반 `pendingReads` 큐 + heartbeat 주기에 `drainPendingReads()` 호출로 교체
3. **CR 줄바꿈 미인식**: `cfmakeraw`가 `ICRNL`(CR→LF 입력 변환)을 비활성화하여 ESP32의 `Serial.println()`이 보내는 `\r`이 `\n`으로 변환되지 않음 → `handleReadData`에서 `\r\n`/`\r` → `\n` 정규화 추가

추가: pyserial과 동일하게 `O_NONBLOCK` 유지, `dup()` 대신 단일 fd 사용, 초기 device_info 응답을 동기 read로 수신 후 큐에 전달

### 핵심 설계 결정
- **pyserial 동작을 reference로**: pyserial은 `O_NONBLOCK` 유지 + `VMIN=0,VTIME=0` 설정. Swift 코드도 이를 따라야 ESP32와 정상 통신 가능
- **Actor isolation 우회**: Swift actor의 cooperative scheduling이 시리얼 read 처리량을 감당 못함. `nonisolated(unsafe)` + `NSLock`으로 thread-safe queue 구성

---
