# 2026-08-23 — stubless 쓰기는 stub 문제가 아니었다: ips_10 의 SYNC 무응답과 계측기 두 번의 거짓말

### 문제

`esp32-v1.0.7` / npm-v1.0.23 라운드가 "stubless 쓰기는 여전히 미해결"로 닫혔다. 남은
`stub: false` 보드는 ips_35 / round_amoled / ips_10 세 대이고, 첫 가설은 **TTGO 처럼 stub
을 켤 수 있는가**였다.

### 실측으로 무너진 것들

**1. 세 보드 중 두 대는 실패한 적이 없다 — 측정된 적이 없다.** ips_35 와 round_amoled 는
스파이크 때도 오늘도 USB 에 붙어 있지 않다. 그리고 세 보드의 `stub: false` 는 전부
platformio 의 `--no-stub` 에서 상속된 값인데, 그 핀은 2026-06 의 `2cf5fc754` /
`4a28455f6` 에 들어갔고 **두 커밋 메시지 어디에도 stub 이야기가 없다**. 디스플레이와
연결성에 관한 커밋에 곁다리로 들어간 핀이다. TTGO 핀이 틀린 것으로 밝혀진 것과 정확히
같은 모양이라, 이 두 대는 "stubless 가 안 된다"의 증거로 쓸 수 없다. 상태는 `blocked` 가
아니라 **unknown** 이다.

**2. ips_10 은 stub 문제가 아니다 — 원리적으로 아니다.** SYNC 는 두 도구 모두에서 stub
로딩보다 **먼저** 일어난다. ips_10 은 SYNC 에서 죽으므로 `stub: true` 는 이 실패에 닿을
수 없다. 첫 가설은 이 보드에 대해 반증이 아니라 **무관**하다.

**3. SSOT 가 들고 있던 진단이 틀렸다.** 기록은 esptool 의 문장을 그대로 인용하고 있었다 —
"The serial TX path seems to be down". 실측: 보드는 download mode 에 **들어간다**
(`boot:0x307 (DOWNLOAD(USB/UART0/SPI))` + `waiting for download`), 그리고 그 배너는 **바로
그 CH340 UART 로 도착한다**. chip→host 는 download mode 에서 살아 있다. esptool 은 왕복이
실패한 것을 보고 방향을 **추측**했을 뿐이고, 그 추측이 SSOT 에 findings 로 박혀 있었다.

### 계측기가 두 번 거짓말했다

둘 다 "보드가 죽었다"는 확신에 찬 오답을 내놓을 수 있었고, 둘 다 대조군으로만 잡혔다.

**`set({dtr:false})` 는 RTS 를 함께 assert 한다.** node-serialport 의 `set()` 은
`{...defaultSetFlags, ...options}` 이고 기본값이 `dtr:true, rts:true` 다. 부분 지정은 생략한
쪽을 **기본값으로 덮는다**. 첫 배너 캡처는 마지막 줄이 `set({dtr:false})` 였고, 그래서 읽기
창 3초 내내 EN 을 눌러 칩을 리셋에 붙잡아 두고 있었다. 결과는 모든 모드에서 0바이트 —
"ROM 이 아무것도 출력하지 않는다"는 완벽하게 그럴듯한 결론. 저장소의 제품 코드
(`NodeWebSerialPort.setSignals`)는 이걸 이미 알고 두 줄을 항상 함께 쓴다. **하네스가
제품의 트랜스포트를 빌려 쓰지 않고 `set()` 을 직접 부른 것이 결함이었다.**

**`drain()` 타임아웃은 아무 증거도 아니다.** download mode 에서 SYNC 를 쓰면 `write` 는
0~3ms 에 돌아오는데 `drain()` 이 3초를 넘긴다. "바이트가 어댑터를 못 떠난다"로 읽으면
호스트→칩 단선이라는 결론이 바로 나온다. 대조군을 재보면: **앱이 돌 때도 `drain()` 은
똑같이 타임아웃하고, 그런데 앱은 1403바이트를 답한다.** 타임아웃은 이 어댑터의 성질이지
경로에 대한 정보가 아니다. 정상일 때의 값을 먼저 재지 않았다면 여기서 멈췄을 것이다.

### 남은 것과, 다음 사람이 시작할 지점

양방향 모두 살아 있는데 ROM 로더만 답하지 않는다 — esptool.py 5.2.0 5회, 직접 만든 SYNC
프레임 3회, 전부 **0바이트**. 배너는 `DOWNLOAD(USB/UART0/SPI)` 로 USB 를 먼저 적고, 이
보드는 P4 네이티브 USB 포트에 케이블이 없다. 다음 시도는 거기다.

**리셋 전략에서 하나 더 나왔다.** 이 보드를 download mode 로 넣는 건 esptool 의
`UnixTightReset` 뿐이고 `ClassicReset` 은 두 딜레이 모두 0바이트다. esptool-js 는
`ClassicReset` 과 `UsbJtagSerialReset` **만** 구현하므로, 내장 전략으로는 브라우저도 CLI 도
이 보드의 download mode 에 영원히 도달하지 못한다. 다만 `CustomReset` 토큰으로는 표현된다:
`D0|R0|D1|R1|D0|W100|D1|R0|W50|D0` 가 재현성 있게 들어간다. 결정적인 건 **프리앰블**이지
원자성이 아니다 — 프리앰블 없는 원자적 IO0+EN 엣지는 0바이트다("두 줄을 함께 써라"가
예측하는 것과 반대 방향이라 특히 기억할 값어치가 있다). **배선하지 않았다**: SYNC 가 여전히
무응답인 동안 download mode 진입은 보드를 쓸 수 있게 만들지 않고, 아무도 갖지 못한 능력을
주장하는 필드는 없는 필드보다 나쁘다.

전부 비파괴로 측정했다. ips_10 은 시작과 같은 `1.0.6 / 1e974271` 로 서 있고, 플릿 7대는
프로브 전후로 동일하다.

---
