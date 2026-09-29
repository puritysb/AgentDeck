# 2026-07-17 — inkdeck panic의 정체: mDNS 컴포넌트 크래시 — 코어덤프 파티션에서 backtrace 복원

### 문제
전 라운드 잔여 과제: inkdeck이 13:21–13:26에 panic(reset code 4)으로 재부팅했는데(구빌드 `0301e43d-dirty`) 시리얼 backtrace가 어디에도 없었다. 원인 — **양쪽 데몬 모두 `{`로 시작하지 않는 시리얼 라인을 무조건 폐기**(Node `esp32-serial.ts` `startsWith('{')`, Swift `ESP32Serial.swift` `hasPrefix("{")`)해서 Guru Meditation 덤프가 로그에 남을 방법이 없었다.

### 해결
1. **panic 캡처 (commit `24f0c095`)**: panic 마커(Guru Meditation/Backtrace:/register dump/abort()/assert failed/Rebooting... 등)가 보이면 포트별 10s 캡처 윈도우를 열고 비-JSON 라인을 그대로 데몬 로그에 남긴다(200줄 캡, 마커마다 윈도우 갱신 — 재부팅 후 부트로더 reset-cause 라인까지 포섭). Node+Swift 동일 구현, vitest 2건.
2. **소급 복원 — coredump 파티션**: backtrace는 소실됐지만 arduino-esp32가 coredump-to-flash를 켜둔 상태였다(default_8MB.csv `coredump @0x7F0000`). 데몬 내리고 esptool로 파티션을 읽으니 30KB ELF 코어덤프가 살아 있었음. 원본 ELF(`-dirty`)는 재현 불가라 클린 `0301e43d` 재빌드 ELF로 디코딩 — esp-coredump의 app SHA 검증은 덤프 사본의 9자 SHA 문자열(offset 30720)과 CRC32 트레일러(data_len-4)를 직접 패치해 통과시켰다. 아티팩트: `diagnostics/inkdeck-coredump-20260717/`.

### 판정
`LoadProhibited`, excvaddr `0xabba13c3`(오염 포인터). 크래시 지점은 **prebuilt espressif mDNS 컴포넌트의 수신 경로**(`_mdns_service_task → mdns_parse_packet → _udp_recv`, `mdns_networking_lwip.c:174`) — AgentDeck 앱 코드가 아니다. inkdeck은 HWCDC 손실 때문에 radio parking을 의도적으로 안 하는 유일한 serial 보드라 mDNS 태스크가 LAN 멀티캐스트에 상시 노출되고, panic 시각은 데몬 재시작 반복(mDNS 광고 flap) 시간대였다. 재발 시 데몬 로그에 전체 덤프가 남는다; 잦으면 pioarduino 플랫폼 범프(신형 mdns 컴포넌트) 검토.

### 구펌웨어 3보드 최신화 (a1d59de8, 클린 worktree 빌드)
- 동시 세션이 esp32 크리처 소스를 미커밋 수정 중이라 **HEAD 클린 worktree**에서 빌드 — dirty 편입 방지 + `-dirty` 아닌 검증가능 buildHash.
- **ttgo** 0.1.2→0.2.3(`a1d59de8`) serial 플래시 ✓ / **ips10** `a1d59de8` ✓ / **inkdeck** `a1d59de8` ✓ — 셋 다 flash 후 직접 시리얼 probe로 buildHash 실측 검증. tc001은 이미 `82fbdfff`.
- inkdeck native CDC는 이번에도 `pio -t upload`가 허브 재열거에서 실패 — 보드가 다운로드 모드 포트(`usbmodem3111101`)에 남으므로 **그 포트에 esptool write-flash 직접 실행**(0x0/0x8000/0xe000 boot_app0/0x10000)이 확실한 경로. boot_app0 재기록으로 과거 OTA의 otadata(app1 지향)도 초기화.
- 잔여: **86box가 `53794d2d-dirty`로 구버전** (WiFi-only, OTA는 Node 데몬 필요 — Swift 데몬 미지원).

### 데몬 "SIGKILL 반복" 재검
양쪽 daemon-crash.log 전 기록이 **SIGTERM 클린 종료**뿐 — Node↔Swift 데몬 takeover 요청(`requestDaemonShutdown`)과 앱 종료가 원인이고, 크래시/SIGKILL 증거는 없다. LaunchAgent(KeepAlive) 등록은 가능하지만 Xcode에서 Swift 데몬을 디버깅하는 워크플로와 상충(재스폰된 Node가 Swift를 계속 축출) — 등록은 보류하고 사용자 판단에 위임.
