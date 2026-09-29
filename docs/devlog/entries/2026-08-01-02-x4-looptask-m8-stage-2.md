# 2026-08-01 — X4 크래시 규명(loopTask 스택 오버플로)과 M8 Stage 2 착지

### 크래시 수사 → 확정
전날 미해결이던 X4 패닉(포크 23ccd9d1, WS 등록 직후 3/3)을 증거로 닫았다.
File Transfer로 SD `/crash_report.txt` 회수(기기 IP가 .55→.65로 DHCP 이동해
서브넷 스캔으로 재발견) → 23ccd9d1 ELF로 심볼화. 덤프가 명확했다: 패닉 사유
공란(=abort가 아닌 **스택 워치포인트 debug exception**), SP가 정확히
0x2000(=Arduino loop 기본 8KB) 힙 블록의 head 카나리(0xABBA1234)에 위치,
SP 위 ~1KB가 0xA5 프레시 필 — printf 계열 `_svfprintf_r`의 **1,152B 프레임**
한 방이 베이스를 넘긴 흔적. 트리거는 connect 엣지에 인라인된
`refreshGlanceIfStale`의 딥체인(esp_http_client→std::string→ArduinoJson→
덱 persist→SD 로그). pull 모드는 같은 체인을 더 얕게 돌아 X3가 무사했던
것까지 설명된다. 대형 프레임 사냥은 `objdump -d | grep 'addi sp,sp,-1xxx'`
가 결정적이었다.

### 수정 (포크 16c1674b) + 실기 검증
①connect 엣지는 큐잉만, 실행은 loop() 최상단 얕은 프레임(OTA 수신 중 대기)
②`SET_LOOP_TASK_STACK_SIZE(16KB)` — ELF 디스어셈블로 0x4000 반환 확인
③이연 refresh 후 `uxTaskGetStackHighWaterMark` SD 로그(상시 계측).
File Transfer HTTP 업로드→온디바이스 플래시→로스터 워처가 판정:
16c1674b 등록 후 120s+ 생존(기존엔 ~100ms 패닉), 데몬 로그에
`card feed pull from xteink_x4 · 7 cards` — 이연 글랜스 refresh까지 실동작.
X3(6c065027)는 fresh 복귀 시 자동 OTA 워처 대기 중. 교훈은 메모리
`esp32-looptask-stack-deep-sync-chains`로 승격.

### M8 Stage 2 — 파워오프 프레임 blit (포크 f3c9e86d, 데몬 00aaa0ac·e0cdb7a7)
- **frame sig 시계 필드 재발 수정**(00aaa0ac): sig가 픽셀 해시라 masthead의
  `Synced HH:MM`이 매분 sig를 갈아치워 304가 무효였다(deckSig 함정의 한 층
  아래 재발 — fixture가 serverHm 고정이라 테스트는 통과). sig를 "시계 스탬프
  비운 콘텐츠 SVG" 해시로 전환. 검증 3중: 유닛(시계 틱 간 sig 동일+픽셀은
  다름), 라이브 304(sig 에코), 65s 200은 바이트 diff로 행 특정(usage 게이지
  틱+타 세션 랩업 = 진짜 콘텐츠 변화)까지 규명.
- **X3 물리 방향 회전**(e0cdb7a7): blit은 GfxRenderer 매핑을 우회하므로
  데몬이 기기 공식(phyX=y, phyY=physH−1−x)을 미러해 792×528/스트라이드 99로
  패킹. X4/InkDeck은 이미 물리와 일치. 유닛 테스트가 공식을 픽셀 단위 핀.
- **포크 blit**: `HttpDownloader`에 NOT_MODIFIED(304)+단일 응답헤더 캡처
  (X-Frame-Sig) 추가 → `glance_frame_client`가 tmp 다운로드→크기 검증
  (프레임버퍼와 정확 일치)→rename으로 SD 캐시 원자 교체 → render()의
  PoweredOff 분기가 캐시→정적 프레임버퍼 blit(+기존 FULL_REFRESH 8회 케이던스),
  실패는 전부 온디바이스 renderGlance 폴백. **힙 추가 0, fetch는 얕은
  프레임에서만**(스택 교훈 준수). TimedSleep은 "next ~HH:MM" 약속 때문에
  v1에서 온디바이스 유지.
- 라이브 계약 검증: x4 48,000B/800×480, x3 52,272B/792×528, PNG 프리뷰
  (=프로덕션 픽셀) 육안 확인. **X4 실기 플래시는 보류** — 16c1674b를 하룻밤
  소킹(오늘 데몬 재시작 다발 = connect 엣지 반복 소킹)한 뒤 WiFi OTA +
  파워오프 육안 확인으로 마무리 예정.

### 미결
- X3 16c1674b 자동 푸시(fresh 복귀 대기), X4에 f3c9e86d OTA+파워오프 실기
  확인, ambient face blit(Stage 2.1), 데몬 소유권 — 오늘 밤 세션 간 SIGTERM
  경합이 잦았다(00:51/00:58 두 번 내려감; 현재 nohup 데몬이 서비스 중).

---
