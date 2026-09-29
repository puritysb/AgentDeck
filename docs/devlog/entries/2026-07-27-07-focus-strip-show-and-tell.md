# 2026-07-27 — 카메라는 방향이 역할을 정한다: Focus Strip show-and-tell 사진 파이프라인

T-Display-S3-Pro의 후면 GC0308 쉴드로 플릿의 첫 **이미지 입력 채널**을
열었다. CAM 페이지(카메라 probe 성공 시에만 생김)에서 2:1 전체-프레임
뷰파인더로 프레이밍하고 SNAP/BOOT로 찍으면, JPEG가
`photo_begin`/binary WS/`photo_end`(voice 캡처 브래킷의 1:1 복제)로
데몬에 올라가 `~/.agentdeck/photos/`에 저장되고, 대상 세션에 파일
경로가 dictation과 같은 배달 사다리(observed=터미널 주입,
managed=`send_prompt`)로 꽂힌다. iTerm2 주입 → 에이전트가 사진을 읽고
응답하는 것까지 실기 검증 완료. 전면 카메라를 가진 ips10(JC8012P4A1C,
벤더 스펙 "MIPI CSI 1080P", 센서 미확정)은 향후 presence 단계로 기록.

하드웨어가 낸 숙제 네 개가 이 커밋들의 실제 내용이다. (1) 보드-헤더
매크로(`BOARD_HAS_DVP_CAMERA`)는 `-D` 플래그와 달리 include 없이는 안
보여서 업로드 경로가 no-op 스텁으로 조용히 컴파일됐다 — 모든 셔터가
"no link". (2) 카메라 상시 전원 + 부팅 중 WiFi join이 3.3V 레일을
주저앉혀 자기지속 재부팅 루프(E BOD, 이후 poweron급)를 만들었다 —
카메라는 CAM 페이지 acquire/release로만 켜지고, WiFi는 부팅 join 금지
+ serial-primary 중 provision은 저장만(IPS10 패턴, `wifiConfigured`
플립으로 데몬 재프로비저닝도 차단) + 25초 후 deferred join + brownout
리셋 부팅은 auto-join 차단이라는 사다리가 됐다. (3) 업로드 중 카메라
구동이 겹치면 전원이 또 무너져서, 캡처 직후 센서를 끄고 전송한다.
(4) 이 보드도 InkDeck과 같은 HWCDC라 64B FIFO 홀이 2.8KB base64 청크
라인을 절반쯤 찢었다 — 페이싱 가드를 확장했지만 잔존해서, 사진 blob은
WS를 우선하고 serial은 byte-count 무결성 가드가 지키는 폴백으로 남겼다.
"보드가 보냈다고 말하는 것"과 "데몬이 받은 것" 사이의 모든 간극은
`photo_result`(전달/실패/타임아웃)로 명시화했다.

---
