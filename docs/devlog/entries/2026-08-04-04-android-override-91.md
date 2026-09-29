# 2026-08-04 — Android 패널 override를 실행 중 정책과 토폴로지에 전파 (#91)

### 문제
`MainActivity`는 패널 override 변경 시 새 `DeviceProfile`로 재생성됐지만, 이미 실행
중인 `MonitorService`는 시작 때 만든 `BrightnessController`와 E-ink stay-on/wake
정책을 계속 사용했다. 열린 WebSocket도 `client_register`를 `onOpen`에서만 보내
데몬의 Android `kind`가 다음 재연결까지 이전 값으로 남았다.

### 해결
- `DeviceProfileHolder`가 실제 프로필 변경만 순서대로 알리고 동일 값 재설치는
  no-op이 되도록 했다. 서비스와 연결 계층은 `Build.*`를 재판정하지 않고 이 SSOT의
  결과만 구독한다.
- 서비스는 E-ink↔LCD 전환 시 진행 중 display 작업을 취소하고 이전 brightness·
  stay-on·keepalive 효과를 복원한 뒤 새 controller/preferences를 설치하고, 최신
  bridge 화면 상태를 즉시 다시 적용한다.
- WebSocket은 연결된 상태에서 display name 또는 `wireKind`가 바뀌면 Android
  dashboard 등록을 다시 보낸다. 마지막으로 성공한 identity를 기억해 동일 프로필
  설치와 동일 identity 변경은 중복 등록을 만들지 않는다.
- 양방향 서비스 정책 전환 순서, 동일 정책 no-op, 연결 중 `tablet`↔`eink` 재등록,
  연결 끊김 뒤 재시도, holder 중복 억제를 회귀 테스트로 고정했다.
- 검증: Android 단위 테스트 308개와 Debug APK 조립, 문서 88개 검사를 통과했다.
  Release APK 스크립트는 clean worktree에 비밀 `android/signing.properties`가 없어
  서명 전 단계에서 의도대로 중단됐다.

---
