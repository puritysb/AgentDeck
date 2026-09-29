# 2026-05-05 — E-ink Dashboard parity 구현 및 Pantone 배포

### 2026-05-05 추가 — e-ink portrait/landscape 양방향 보장

- `MainActivity` 의 e-ink orientation 적용을 `applyOrientationPreference()` 로 통합했다. landscape/portrait
  는 `requestedOrientation` 과 Pantone/RK3566 `USER_ROTATION` fallback 을 함께 적용하고, `Auto` 는
  `ACCELEROMETER_ROTATION=1` 로 system auto-rotation 을 복원한다.
- e-ink rotate control 을 `Settings button` 표시 여부와 분리했다. Display panels 에서 settings button 을
  숨겨도 portrait/landscape 전환은 계속 가능하다.
- Pantone6 (`AA007422R24C1300039`) 실기기에서 portrait screenshot → rotate tap → landscape screenshot
  → rotate tap → portrait screenshot 순서로 검증했다. 설치된 APK 는 `versionName=0.4.1`,
  `lastUpdateTime=2026-05-05 14:50:21`; 최근 logcat 250라인에서 `AndroidRuntime`/`FATAL EXCEPTION`
  매치 없음.

### 문제

Dashboard UX parity 정렬 후에도 e-ink 화면은 새 방향성에 비해 덜 따라와 있었다. tablet/iOS 와
동일해야 하는 session focus, settings 구조, display panel 토글, downstream device 관계가 e-ink 에서는
부분적으로만 반영됐고, `Tank status`/`Device diagnostic` 토글도 실제 compact status 표시에 분리 적용되지
않았다.

### 해결

- e-ink landscape/portrait 모두 `Display panels` 선호도를 읽어 session list, tank status, device
  diagnostic, timeline, settings button 표시를 제어하도록 연결했다.
- e-ink session list row tap 이 tablet 과 동일하게 `focus_session` bridge command 를 보내도록 했다.
- e-ink settings overlay 를 Connection / Mac integrations(read-only) / Display panels / Display &
  sleep / Orientation 구조로 확장해 tablet/iOS 설정 의미와 맞췄다.
- `EinkStatusCompact` 에 downstream device summary 를 추가하고 `Tank status` 와 `Device diagnostic`
  토글을 각각 반영했다. `moduleHealth` 기반으로 Stream Deck, D200H, Pixoo, ESP32, Android/e-ink
  관계를 압축 표시한다.
- 공통 Connection panel 의 bridge URL 표시에서 `token=` 값을 redaction 하도록 해 Settings 에서 pairing
  token 이 그대로 노출되지 않게 했다.
- e-ink 전용 EPD refresh zone, color/grayscale renderer, 작은 화면 layout 제약은 그대로 보존했다.

### 검증

- `git diff --check` 성공.
- `./gradlew :app:compileDebugKotlin` 성공.
- `./gradlew :app:testDebugUnitTest` 성공.
- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`.
- ADB 설치 완료: Pantone6 (`AA007422R24C1300039`, `versionName=0.4.1`,
  `lastUpdateTime=2026-05-05 13:53:22`), Lenovo TB-J606F (`HVA095B4`,
  `lastUpdateTime=2026-05-05 13:56:16`).
- Pantone6 에서 `dev.agentdeck/.MainActivity` resumed 확인. 최근 logcat 250라인에서
  `AndroidRuntime`/`FATAL EXCEPTION` 매치 없음.
- Lenovo TB-J606F 에서도 `dev.agentdeck/.MainActivity` resumed 확인. 최근 logcat 은 정상 launch/draw
  로그만 확인되고 fatal crash 없음.
- Pantone6 screenshot 으로 Dashboard 의 `Devices: D200H, Pixoo` compact downstream 표시와 Settings
  overlay 의 Connection / Mac integrations / Display panels 렌더링, `token=redacted` 표시를 확인했다.

---
