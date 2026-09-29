# 2026-07-11 — iOS idle Claude 세션을 SETUP 미완료로 오인

### 문제
iOS의 `SetupNeededCard`가 Mac 소유 상태인 Claude hook 설치 여부를 iOS 로컬 `AppPreferences.hooksInstalled`로 평가했다. 이 값은 iOS에서 채워지지 않으므로 Claude 세션이 없고 OAuth 신호도 없는 idle 구간에는 정상 설정된 환경도 `SETUP · Claude Code` 미완료로 표시됐다. 세션 존재는 설정 완료의 증거가 될 수 있지만 세션 부재는 설정 미완료의 증거가 아닌데 두 상태를 혼동한 것이다.

### 해결
- iOS SETUP 정책에서 Claude descriptor를 제외했다. iOS는 read-only 대시보드이며 Claude hook/OAuth 설정은 paired Mac이 소유하므로, wire protocol에 명시적인 hook-readiness 신호가 생기기 전에는 세션 유무로 설정 상태를 추론하지 않는다.
- daemon이 명시적이고 지속적인 `gatewayAuthStatus`를 보내는 OpenClaw SETUP 진단은 유지했다.
- `ProtocolTests.testIOSSetupPolicyDoesNotInferClaudeSetupFromSessionAbsence`로 iOS 정책에 Claude가 다시 들어오지 않도록 회귀 가드를 추가했다.

### 검증
`xcodebuild`로 `AgentDeck_iOS` generic-device Debug build 성공, macOS `ProtocolTests` 성공.

---
