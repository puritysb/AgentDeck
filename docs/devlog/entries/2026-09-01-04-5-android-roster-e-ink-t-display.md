# 2026-09-01 — 5개 실기 이상: 오디오 소유권·Android roster·e-ink·T-Display 전원 경로

현재 연결된 T-Embed, Lenovo Android 태블릿, EPD47, NM-EPD-420,
T-Display-S3-Pro를 실기에서 재현하고 각 전송/렌더 경로를 분리해 점검했다.

- **T-Embed 연속 스피커음**: OpenClaw attention chime이 스트리밍 재생기가 이미
  소유한 I2S와 별도의 `I2SClass`를 만들었다. S3의 다른 I2S는 PDM 마이크가 쓰므로
  이 세 번째 소유권 경쟁이 앰프에 garbage clock을 남겼다. chime을
  `Audio::playbackBegin/feed/end` 공유 소유자로 옮기고 음성 재생 중에는 생략한다.
- **Android Claude 크리처 소실**: 위 항목의 `lastCompletedAt` 소수점 와이어 버그가
  `sessions_list` 전체를 버리며 roster·카운트·크리처를 함께 지웠다. 생산자 정수화와
  `FlexibleLongSerializer`가 든 Android 1.2.0(15)을 Lenovo에 설치했고, 실기 화면에서
  Claude #1/#2 크리처와 세션 목록을 확인했다. 재시작 후 decoding 오류도 0건이다.
- **EPD47 터치**: 실기 I2C에는 RTC 0x51만 있고 GT911 계열 touch controller가
  없다. 벤더 예제도 같은 결과라 펌웨어 회귀가 아니라 P6 touch FPC/컨트롤러 경로의
  물리 문제다. GPIO21 fallback은 유지하고 footer에 `TOUCH OFF | GPIO21 NEXT`를
  명시해 죽은 touch를 숨기지 않는다.
- **NM 품질/정보량**: working-count 변동이 3색 full refresh를 계속 우회시키던
  urgent 조건을 제거하고, 새 attention·page/link 전환만 즉시 갱신한다. 빠른 full LUT
  대신 stock color waveform을 써 빨강 안료 품질을 우선했다. Claude/Codex의 5H·7D
  4개 gauge와 reset 시간을 추가하고 NM/EPD47 wordmark를 `AgentDeck`으로 통일했다.
  실기 카운터는 마지막 초기화 뒤 11/11에서 고정됐다.
- **T-Display OFFLINE/화면 재시작**: 첫 serial JSON이 명시적
  `device_info_request`여도 device_info를 한 번 더 보내고, Swift도 board 식별 전후로
  초기 상태를 두 번 밀어 native CDC를 과부하시켰다. 응답과 초기 burst를 각각 한 번으로
  줄였다. 또 이 보드는 display+radio 동시 부하의 brownout 이력이 있으므로, USB serial이
  건강한 동안 25초 deferred WiFi join을 금지하고 USB가 실제로 끊긴 뒤에만 WiFi를
  fallback으로 올린다. 최종 실기에서 WiFi radio를 park한 USB-primary 상태로 100초 이상
  `connected=true`, backpressure 0, heartbeat read/write 진행을 확인했다.

네 ESP32에는 firmware 1.2.0을 직접 flash했고 Android도 1.2.0을 설치했다.
`t_embed`, `t_display_pro`, `nm_epd_420`, `lilygo_epd47` release build,
e-ink host render, macOS build와 ESP32 serial/WiFi 대상 XCTest가 통과했다.

---
