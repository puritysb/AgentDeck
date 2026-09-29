# 2026-04-03 — TC001 SEARCHING Flap 조사 및 Swift Serial 안정화

### 문제
Ulanzi TC-001가 정상 화면과 `SEARCHING...` 오버레이 사이를 반복했다. Swift daemon `/health`에서는 `/dev/cu.wchusbserial211340`가 반복적으로 `connected: false`로 떨어졌고, `~/.agentdeck/swift-daemon.log`에는 약 10초 간격으로 `Opened` → `device_info` → `Read exit ... errno=9` 패턴이 계속 남았다.

### 해결
- `apple/AgentDeck/Daemon/Modules/ESP32Serial.swift`
  - UART(CH340/CP210x) termios 설정에서 `HUPCL`을 명시적으로 끄도록 변경해 Node serial bridge의 `stty ... -hupcl` 동작과 맞춤
  - serial read thread가 `FileHandle`을 명시적으로 retain 하도록 변경해 reader lifetime이 connection struct/ARC 타이밍에 간접 의존하지 않게 보강
  - `<<EOF>>` 단일 sentinel 대신 `errno`와 strerror를 포함한 read failure 메시지를 health/log에 남기도록 개선

### 핵심 설계 결정
- **Swift daemon은 Node serial bridge와 포트 제어 parity를 유지해야 한다.** 특히 UART 계열 ESP32는 `hupcl` 여부에 민감하고, Node 구현에서 이미 안정화된 termios 차이를 그대로 두면 보드별로만 재현되는 플랩이 생길 수 있다.
- **fd lifetime은 암묵적 보장에 맡기지 않는다.** read thread가 raw fd만 들고 돌면 handle 소유권이 struct copy/cleanup 경로에 묻히기 쉽다. reader가 직접 handle을 붙잡아 두는 편이 안전하다.
