# 2026-08-30 — E-ink 면은 push/pull별 상태 집합이 되고 패널 실측은 device_info가 맡는다

후속 실물 방향 확인에서 LilyGo EPD47의 native scan 방향이 케이스의 읽기 방향과
180° 반대임을 확인했다. 보드 정본에 `BOARD_EINK_ROTATION=2`를 두고 4-bit PSRAM
canvas가 논리 좌표를 물리 좌표로 회전해 기록하도록 수정했으며, 960×540 host
preview도 같은 raw panel orientation을 쓴다.

InkDeck 24시간 실측에서 2,757회 재도색 중 행동 가능한 변경은 0.22%였고 이미지
중앙 수명은 3초로 레이트리밋에 포화돼 있었다. 이를 단순 주기 튜닝 문제가 아니라
면 상태기계 문제로 승격했다. `docs/eink-surface-contract.md`가 다섯 면
(`DECISION`/`ANSWER`/`DIGEST`/`GLANCE`/`ROSTER`), 본문/밴드 경계, 8분 hold와
expiry, 항상 같은 escape 의미를 정본으로 고정한다. 상시 연결 push는 다섯 면,
딥슬립 pull은 세 면이 기본이며 물리 웨이크 뒤의 제한된 interactive lease에서만
두 상호작용 면을 연다.

실물/공식 자료 대조 결과 InkDeck은 push, RockBase NM-EPD-420과 LilyGo EPD47은
pull 기본으로 분류했다. NM은 BOOT(GPIO0) wake/PTT와 USER(GPIO45) escape,
EPD47은 GPIO21 wake/escape이며 온보드 오디오가 없어 PTT가 없다. 세 기기의
모델·패널/방향, MCU/PSRAM, 전원, 딥슬립 웨이크, 마이크 경로, 스피커 앰프 enable은
`docs/hardware-compatibility.md`의 e-ink 6필드 표로 고정했다. NM의 ES8311은
full-duplex I2S이고 PA enable은 GPIO41이지만, 이번 display-first 타깃은 오디오
드라이버를 켜지 않아 BOOT hold를 PTT에 예약만 한다.

세 보드가 이제 하나의 paper-face 렌더러를 쓴다. InkDeck은 다섯 면을 모두 상시
허용하고, pull 보드는 GLANCE/DIGEST/ROSTER를 기본으로 하되 물리 입력 뒤 8분
interactive lease에서만 DECISION/ANSWER를 허용한다. 오프라인은 정적 ROSTER,
escape와 expiry는 GLANCE다. 400×300 NM의 SSD1683 B/W differential 경로는 완전히
금지했다. 전면 실험이 심한 깜빡임과 dark wash를 만든 뒤, red를 제외한 byte-aligned
`(8,56) 392×244` 영역만 쓰고 old/new RAM을 같게 맞춘 2차 실험도 실물 사진에서 화면
전체에 균일한 gray veil을 만들었다. 즉 `hasPartialUpdate`는 이 controller의 RAM 주소
지정 능력이지 장착된 GDEY042Z98 tri-color glass의 파형 호환성 보장이 아니다. NM의
custom 30,000바이트 B/W/color canvas와 모든 `refresh_bw()` 호출을 제거하고 정식 3색
full waveform만 남겼다. 부팅 첫 회는 extended waveform으로 pigment plane을 복구하고,
자동 변화는 5분 단위로 합치며 물리 키만 즉시 갱신한다. red는 상단 brand rail과
DECISION 왼쪽 rail에 고정해 full-color 주기의 추가 비용 없이 사용한다.
960×540 EPD47은 PSRAM에 259,200바이트
4-bit 버퍼를 한 번만 할당하는 responsive layout을 사용한다. 이후 발견된 잔상은
공장 화면이 아니라 `full` 요청에서도 실제 clear 없이 이전 AgentDeck 이미지를
덮어쓴 결과였다. 이제 첫 프레임·연결 전환·4회/10분 주기 full refresh에서 vendor
`epd_clear()` 후 새 이미지를 쓰고, 그 사이만 image-only 갱신한다.
두 보드는 captive portal 대신 USB provisioning을 기본으로 하여 pull 전력 계약과
Arduino 3 WiFiManager callback 안정성을 함께 지킨다.

재설계 후 평가를 손재현하지 않도록 InkDeck의 실제 패널 I/O choke point에
`repaintCount`/`fullRefreshCount` 부팅 이후 누적치를 추가했다. `device_info`의
직렬·WiFi 경로를 Node/Swift 양 데몬에서 보존해 `/devices`와 module health로
노출하며, 요청됐으나 gating에서 버려진 render는 세지 않는다.

실기 배포 전에 LilyGo와 NM의 16MB factory flash를 각각 완전 백업하고 SHA-256을
검증했다. 이후 LilyGo(`/dev/cu.usbmodem21401`, MAC a4:cb:8f:ef:7a:bc),
NM(`/dev/cu.usbmodem83201`, MAC 68:ee:8f:5b:bc:a8), InkDeck(다운로드 노드
`/dev/cu.usbmodem3111101`, MAC 1c:db:d4:74:f4:d8)에 순차 플래시했다. 부팅 실측은
각각 16MB/8MB, 16MB/8MB, BSP 8MB/8MB이며, 세 `device_info` 모두 새 board id와
refresh counters를 보고했다. NM은 단일 3MB app이라 OTA false, EPD47은 6.25MB
dual OTA, InkDeck은 3.19MB dual OTA다.

EPD47의 custom board와 최종 이미지 header는 flash DIO가 정본이다. 동일 app을
강제로 QIO write했을 때 TG0WDT reset loop가 재현됐고 DIO로 다시 쓰자 즉시 안정
부팅했다. PlatformIO의 `qio_opi` memory type은 octal PSRAM 배선을 뜻하며 flash
transport를 QIO로 바꾸라는 의미가 아니다.

검증: vitest 3,713건, Node typecheck, Swift `ESP32WifiForwardTests`, 세 e-ink
PlatformIO release 빌드/실기 부팅, 11개 first-party host simulator frame,
문서 링크/H1 및 design-system catalog coverage 게이트.
