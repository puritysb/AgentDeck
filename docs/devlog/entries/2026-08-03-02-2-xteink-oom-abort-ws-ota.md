# 2026-08-03 (2) — XTeink 두 번째 패닉(OOM abort)과 WS OTA 만성 실패의 진범

### 문제
M8 Stage 2 배포일. X4 전원 홀드에서 **두 번째 패닉** — 이번엔 사유가 찍혔다:
`abort() at PC 0x42191849` = `__cxxabiv1::__terminate`. 동시에 WS OTA가
두 보드 모두 청크 ack 타임아웃으로 만성 실패(X3는 역대 전부, X4는 이날
#573→#14), 로스터 lastSeen이 60–120초로 출렁이는 오래된 미스터리도 있었다.

### 해결 (포크 53a55377 → c70cc220)
- **OTA 실패 진범 = WiFi 모뎀 절전**: 기본 `WIFI_PS_MIN_MODEM`이 청크
  ack마다 비컨 지연을 얹어 데몬의 per-chunk 타임아웃이 기기를 죽은 걸로
  판정. 늘 성공하던 두 경로만 절전을 끄고 있었다(HTTP OtaUpdater,
  File Transfer 서버의 `setSleep(false)`). 수정: WS OTA `begin`에서
  `WIFI_PS_NONE` 고정, 모든 종료 경로(resetRx)에서 복원.
- **패닉 = 힙 고갈 + -fno-exceptions**: 전원오프 글랜스 refresh의 피드
  본문 `std::string` 축적이 힙 free 7KB/최대연속 3.9KB에서 성장 실패 →
  이 빌드는 예외 비활성이라 bad_alloc이 아니라 **곧장 std::terminate**.
  수정 3중: ①HttpDownloader 문자열 싱크에 최악 재할당(용량 2배 복사+여유)
  사전 체크 — OOM=전송 실패로 강등 ②refresh(<12KB)/frame fetch(<8KB) 힙
  게이트 ③계측 확장(스택 워터마크+힙 free/largest SD 로그).
- **전달 사가**: 수정 자체가 고장난 OTA로 못 가는 닭-달걀 → File Transfer
  일괄 전달. RSSI가 결정 변수(-84~-89 = broken pipe 4연속, -50~-55 = 즉시
  성공; 48k 레이트 리밋이 -71을 통과시킴). 끊긴 업로드는 FT 웹서버를
  wedge시켜 재진입 필요.

### 핵심 설계 결정 / 남은 관찰
- **-fno-exceptions 펌웨어에서 std 컨테이너 성장은 전부 잠재적 abort** —
  가변 크기 수신 버퍼는 성장 전 `getMaxAllocHeap()` 사전 체크가 규칙.
- X3 "조용한 WS"의 실체 = **~100초 주기 단명 연결 플랩**(lastSeen 0→100s
  리셋 반복). 소켓이 닫힌 순간이 대부분이라 OTA begin이 꽂힐 창이 거의
  없음 — begin이 꽂히면 절전 고정이 그 사망을 막는지가 다음 실험.
- 전원오프 blit 폴백(온디바이스 글랜스 표시)은 크래시 아닌 정상 강등.
  유력 원인은 그 순간 RSSI -87의 48KB fetch 실패 — 공유기 근처 전원오프
  재현이 판정 실험. 배포 상태: X4=c70cc220 검증(등록+120s), X3=53a55377
  (OOM 가드 미탑재 — 다음 웨이크/FT에서 c70cc220 필요).

---
