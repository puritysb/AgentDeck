# 2026-09-13 — 데스크의 호스트 전부를 출시 버전으로 맞췄고, 맞추기 전엔 하나도 아니었다

npm 1.3.2를 컷한 직후 "지금 보고 있는 화면이 최신 릴리스인가"를 실측했다. 답은
**아니오, 하나도** — 데몬 1.3.1, Mac 앱 1.2.1(build 2), Stream Deck은 9/11에 빌드한
저장소 심볼릭 번들(태그에 포함된 shared 커밋 3개 이전), Ulanzi 1.2.0, Android 1.2.0,
ESP32 11대는 1.0.5~1.2.2에 `-dirty` 빌드 5대. 전부 올렸다.

### 무엇을 어떻게

각 채널의 **GitHub Release 산출물**(그 태그 커밋에서 CI가 만든 것)을 그대로 설치했다.
로컬 체크아웃을 빌드하면 태그와 다른 바이트가 되므로 — 이날 공유 체크아웃은 master와
앞뒤로 어긋나 있었다 — 산출물이 정본이다.

- **데몬**: `npx @agentdeck/setup@1.3.2 --yes`(저장소 밖에서). setup이 LaunchAgent를
  다시 써서 argv가 `~/Library/pnpm/agentdeck`(pnpm shim)에서 `/opt/homebrew/bin/agentdeck`로
  바뀌었다 — 따로 늙던 전역 진입점 둘이 하나로 수렴했다. 검증은 `/health.build` ↔
  설치본 `distBuildId()` 일치(`95307fb4b9a5`), pid 교체, 9121 잔존 리스너 0.
- **Mac 앱**: #314가 롤백 저장소에 보관한 `verified-Release-AgentDeck-1.3.0-6601.app`
  (스토어 소스 `04233b72`, 팀 서명, 56MB 유니버설 Release). 현재 앱을 이동(삭제 아님)
  후 `ditto`. 클라이언트 모드 확인 — 자체 리스너 없음, 9120은 Node가 유지.
- **Stream Deck**: `.streamDeckPlugin`을 풀어 dev 심볼릭 자리에 복사, `streamdeck restart`.
  옛 저장소 번들을 물고 launchd 직속으로 떠돌던 **고아 node 프로세스 2개**(9/11, 9/12
  부터)가 있었고, 이게 데몬의 유령 WS 클라이언트 2개였다. 종료하니 18→16.
- **Ulanzi**: GH zip과 #314의 CDN 제출 zip은 sha가 다르지만 **파일·CRC 전부 동일**
  (zip 메타데이터 차이). 기존 `.backup-<stamp>` 패턴으로 백업 후 교체, Studio 재시작.
- **Android(Lenovo)**: 서명 digest 동일 → `install -r`로 데이터 보존. Pantone6·Crema S는
  데몬에 대시보드로는 붙어 있으나 adb에 없어 미적용.
- **ESP32 9대 OTA**: `POST /esp32/ota {target, firmwarePath}`(라이브 WiFi WS). 한 대씩.
  86box 2.4분, ttgo_t_display(구형 ESP32) 7.5분, ips_10 4.3MB 4분. 나머지 1~2분.
- **ESP32 2대 USB**: nm_epd_420(단일 OTA 파티션), t_display_pro(WiFi 꺼짐) →
  `agentdeck esp32 flash <board> --tag esp32-v1.2.3 -p <port>`. lease·preflight·
  post-write reset·read-back이 전부 CLI 안에 있어 15.6s / 45.2s에 끝났다.

### 재확인된 함정 넷

1. **OTA 뒤 25초는 짧다.** ttgo_t_display는 시리얼로 t+15s에 1.2.3을 보고했지만 WiFi
   재등록은 t+45s. 검증은 "최대 90초 폴링, 시리얼 또는 WiFi 보고 인정"으로.
2. **시리얼 device_info 캐시 시드**가 최종 집계에서 또 걸렸다. round_amoled·lilygo_epd47이
   옛 버전으로 보였는데 uptime이 OTA 전 값(404,485s)에 얼어 있었다 — 같은 순간 WiFi 항목은
   1.2.3, lastSeen 6초 전. 집계 코드가 시리얼을 WiFi보다 우선한 게 원인. WiFi가 진실.
3. **inkdeck는 OTA 후 `trmnl_75`로 자기 id를 바꿔 보고한다.** 1.2.3 manifest의 legacy
   alias가 의도대로 동작한 것이고, OTA 타깃은 보드가 *지금* 보고하는 이름(`inkdeck`)이다.
4. **t_display_pro의 `usbPowered`는 읽기마다 뒤집힌다**(전원 경로 특성, 배터리 4.02V가
   붙어 있으면 안정). 플래시 전 판단 근거는 uptime 증가분과 lastReadSecondsAgo다.

### 남은 것

- Pantone6·Crema S 앱(USB 연결 필요).
- Mac 6601은 태그 기준이라 Swift 승인 생존자 수정(`0d128304`)이 없다. 클라이언트 모드에선
  그 코드가 돌지 않으므로 지금은 노출되지 않고, 다음 Apple 컷에서 닫힌다.
- master에 로컬에서만 재현되는 Swift 테스트 실패 1건
  (`CollaborationFeedTests.testRenderCollaborationHistoryAtRailWidth`, CI는 통과). 이슈감.
- SD 설치본이 릴리스 복사본이 됐다. 개발 재개 시 `cd plugin && streamdeck link …`.
