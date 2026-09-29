# 2026-07-09 — Android LCD tablet display sleep sync (`f42c2c67`)

### 문제
macOS 키보드 단축키로 모니터를 끌 때 Lenovo Android tablet 화면이 계속 켜져 있을 수 있었다. 기존 `BrightnessController`는 host `display_state{displayOn:false}`에서 LCD brightness를 0으로 낮추고 `SCREEN_OFF_TIMEOUT`을 2초로 설정했지만, `MainActivity`가 `FLAG_KEEP_SCREEN_ON`을 계속 유지해 Activity window가 실제 화면 sleep을 막을 수 있었다.

### 해결
- `MainActivity.shouldKeepDashboardScreenOn()` 정책 추가: LCD tablet은 host display off + full-off dim(legacy `dim` 없음 포함)일 때 `FLAG_KEEP_SCREEN_ON`을 해제한다.
- `displaySleepDim.mode == "min"` 또는 dim disabled면 기존처럼 화면을 켜 둔다.
- E-ink/InkDeck 계열은 화면 자체를 끄지 않아도 되는 정책을 유지한다. Android e-ink는 계속 awake 상태로 두고 frontlight/backlight만 dim한다.
- 회귀 테스트 `MainActivityScreenPolicyTest` 추가(LCD full-off/legacy off/min dim/e-ink full-off).

### 검증
`./gradlew :app:testDebugUnitTest` green, `bash scripts/build-android-release.sh` green. `dist/agentdeck-v0.1.0.apk`를 Lenovo Tab `HVA095B4`에 설치/실행하고 `adb reverse tcp:9120 tcp:9120` 적용. 설치 상태 `versionName=0.1.0`, `versionCode=1` 확인.

---
