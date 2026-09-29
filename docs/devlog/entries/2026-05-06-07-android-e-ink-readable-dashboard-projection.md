# 2026-05-06 — Android e-ink readable Dashboard projection

### 문제

e-ink 전용 `EinkMonitorScreen` 이 tablet Dashboard 와 별도 화면 구조를 유지하는 것은 유지보수 위험이지만,
tablet `MonitorScreen` 을 그대로 e-ink 에 얹으면 더 큰 문제가 생긴다. 실제 Crema screenshot 에서
투명 HUD, 작은 timeline 글자, 색상 기반 상태, 장식 배경 위 텍스트가 겹쳐 판독성이 크게 떨어졌다.
따라서 공통화 대상은 픽셀 배치가 아니라 Dashboard state/action 계약이어야 한다. 동시에 Android 는
Swift daemon 이 보내는 fractional millisecond `timeline_event.ts` 를 `Long` 으로만 decode 해 timeline
이벤트를 버리고 있었다.

### 해결

- Android e-ink 는 다시 `EinkMonitorScreen` projection 을 사용한다. 이는 별도 제품 UX 가 아니라
  공통 Dashboard state/action 을 읽기 쉬운 고대비 3-zone 레이아웃으로 투영하는 계층이다.
- e-ink projection 의 좌측 session rail 을 28% 로 키우고, aquarium 을 42% 로 줄였으며,
  status/context band 를 20-30% 로 키워 글자와 touch target 을 확보했다.
- e-ink 핵심 텍스트를 키웠다: session label/subline, status gauges/models, timeline, attention panel 을
  13-16sp 중심으로 올리고 letter spacing 을 제거했다.
- Android Topology rail 은 Claude 관련 세션/model/rate-limit 데이터가 없고 OAuth 도 연결되지 않은 경우
  Claude row 를 숨긴다. Codex/OpenClaw 작업 중 `Claude Not connected` 가 세션 장애처럼 보이는 혼선을 줄였다.
- Android timeline parser 에 flexible timestamp serializer 를 추가해 `1711100000000.75` 같은 fractional
  timestamp 를 정상 수신한다.
- `docs/android-ui.md` 를 “shared Dashboard model + readable e-ink projection” 방향으로 갱신했다.

### 검증

- `./gradlew :app:compileDebugKotlin --no-daemon` 성공.
- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.net.ProtocolTest --no-daemon` 성공.
- `./gradlew :app:testDebugUnitTest --no-daemon` 성공.
- `bash scripts/build-android-release.sh` 성공, `dist/agentdeck-v0.4.1.apk` 생성.
- Crema(`CREMAA21W09235`)와 Lenovo tablet(`HVA095B4`)에 release APK 재설치 후 foreground 실행 확인.
- 새 screenshot 기준 Crema 는 readable e-ink projection, Lenovo 는 tablet Dashboard 를 사용하는 것을 확인.
- 양쪽 logcat 에서 `AndroidRuntime` crash 와 `parseBridgeMessage failed` / fractional timestamp decode
  실패가 더 이상 발생하지 않음을 확인.

---
