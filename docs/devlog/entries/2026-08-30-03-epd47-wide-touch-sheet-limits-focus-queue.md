# 2026-08-30 — EPD47이 wide touch sheet와 자율 LIMITS/FOCUS/QUEUE 정책을 갖는다

LilyGo EPD47을 공용 roster 축소판에서 960×540 전용 work sheet로 바꿨다. 상단에는
다른 AgentDeck 표면과 같은 mark/wordmark, `FOCUS`/`QUEUE`/`LIMITS` 탭, pull/link
상태를 고정했다. 본문은 durable active work가 없으면 Claude/Codex의 5H/7D 사용량과
reset을 보여주는 `LIMITS`, 하나면 creature와 요청/작업을 크게 보여주는 `FOCUS`,
둘 이상이면 세션 3개를 정렬한 `QUEUE`를 자동 선택한다. 구조화된 질문은 터치 가능한
`DECISION`으로 승격한다. 탭이나 옵션 터치는 8분 hold를 열고, hold가 끝나면 다시
자율 페이지로 복귀한다. GPIO21은 모든 상태에서 자율 GLANCE로 돌아가는 escape이며
GPIO47 touch IRQ는 deep-sleep wake로 과장하지 않는다.

EPD47의 연결 종료 화면도 공용 디자인 언어로 맞췄다. paper-white 바탕, AgentDeck
mark, 단일 `OFFLINE` 상태행, 실제 transport 단계만 말하는 보조행을 사용하며 세션
creature는 Claude와 Codex의 canonical monochrome glyph를 재사용한다. 터치 탭은
현재 GT911 주소 0x14/0x5D와 pinned vendor library의 legacy 0x5A를 부팅 시 고정 메모리
scan으로 자동 감지하고, 성공한 경우에만 `touch` capability를 광고한다. 진단은
`touchAddress`/`touchI2cDeviceCount`/`touchRtcSeen`으로 양 device_info 전송 경로에
남긴다.

host simulator의 EPD47 전용 env와 data-only page policy test를 추가했다. empty,
offline, idle, display-off, working, multi, crowd, dense, permission 9장 모두 960×540으로
렌더하고 layout test 및 diff whitespace gate를 통과했다. Release 빌드는 RAM 38.4%,
Flash 21.6%이며 `/dev/cu.usbmodem21401`의 owned EPD47(MAC
`a4:cb:8f:ef:7a:bc`)에 DIO로 hash-verified 배포했다.

실기에서는 새 UI와 Wi-Fi/serial 상태 전송이 정상이나 touch controller는 응답하지
않았다. 세 번의 전체 I2C scan과 IRQ low→high wake 뒤에도 RTC 0x51 하나만 발견되어
`touchReady:false`, `touchAddress:0`, `touchI2cDeviceCount:1`, `touchRtcSeen:true`다.
과거 기본 펌웨어에서 터치가 됐다는 관찰을 반영해 보존한 출고 앱을 잠시 복원하고,
현재 LilyGo 저장소의 공식 `examples/touch`도 같은 앱 파티션에 올려 다시 비교했다.
출고 앱은 calendar 빌드라 터치 진단을 하지 않았고, 공식 touch example은 현재 실기에서
`Failed to find GT911`을 반복했다. 따라서 AgentDeck 드라이버만의 실패는 아니며, 현재
연결 상태에서 제조사 코드도 GT911을 찾지 못한다. AgentDeck은 출고 demo처럼 첫 패널
전원/전체 draw 뒤 0x14/0x5D/legacy 0x5A를 탐색하며, controller가 응답하면 재빌드 없이
자동 활성화한다. 표준 NM-EPD-420은 제조사 README·회로도·factory test 모두 USER/BOOT
두 버튼만 정의하고 touchscreen controller는 두지 않는다. board JSON의
`use_1200bps_touch`는 화면 터치가 아니라 USB bootloader 진입 옵션이다.
