# 2026-05-05 — E-ink Attention parity 응답 패널

### 2026-05-06 추가 — 실기기 설치 검증

- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`.
- ADB 설치 완료: Pantone6 (`AA007422R24C1300039`, `lastUpdateTime=2026-05-06 03:51:37`),
  CremaS (`CREMAA21W09235`, `lastUpdateTime=2026-05-06 03:52:40`),
  Lenovo TB-J606F (`HVA095B4`, `lastUpdateTime=2026-05-06 03:51:41`). 모두
  `versionCode=5`, `versionName=0.4.1`.
- Pantone6/CremaS 는 재설치 후 `android.permission.WRITE_SECURE_SETTINGS` grant 를 다시 적용했다.
- 세 기기 모두 `dev.agentdeck/.MainActivity` foreground 확인. 최근 logcat 에서 `AndroidRuntime` fatal/crash
  로그 없음.

### 문제

Android tablet/iOS Dashboard 는 어떤 세션이든 `awaiting_*` 상태가 되면 Attention theater 를 띄워
해당 session 을 focus 한 뒤 `select_option` 응답을 보낼 수 있었다. 반면 e-ink Dashboard 는 현재 focused
primary state 가 awaiting 일 때만 `EinkContextArea` 에 옵션을 보여 다중 세션에서 e-ink 단독 사용자가
tablet/iOS 와 같은 응답 경험을 얻지 못했다.

### 해결

- e-ink 전용 `EinkAttentionPanel` 을 추가해 landscape/portrait context band 에 awaiting session 을
  표시한다.
- focused awaiting session 은 live question/options/cursor 를 보여주고, 다른 awaiting session 은 tap 시
  `focus_session` 후 `select_option` 을 보내 tablet/iOS 의 라우팅 의미와 맞췄다.
- parser 가 옵션을 못 준 경우 e-ink permission/attention UI 모두 `Yes`/`No`/`Always` fallback 을 보여
  blank approval panel 이 생기지 않게 했다.
- `docs/android-ui.md` 에 e-ink Attention parity 계약을 추가했다.

### 검증

- `git diff --check` 성공.
- `./gradlew :app:compileDebugKotlin` 성공.
- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.ui.eink.EinkAttentionPanelTest` 성공.
- `./gradlew :app:testDebugUnitTest` 성공.

---
