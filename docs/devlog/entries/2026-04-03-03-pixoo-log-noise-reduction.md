# 2026-04-03 — Pixoo Log Noise Reduction

### 문제
- Pixoo render loop가 약 3 FPS로 돌아가면서 성공 push 로그를 매 tick마다 남겨, 실제 장애나 상태 전이 로그가 묻혔다.
- `Push OK -> ... picId=...`가 계속 반복되어 디버깅 가독성이 떨어졌다.

### 해결
- `PixooModule.swift`
  - 성공 push는 매번 찍지 않고 첫 성공, 복구 직후, 그리고 일정 주기 요약만 남기도록 조정
  - 실패는 첫 실패 / 5회 / 20회 단위와 실패 사유 변경 시만 에러 로그로 남기도록 압축
  - push loop 내부 HTTP 실패 로그는 중복 출력되지 않도록 억제
  - 복구 시 `Pixoo recovered on ... after N failed push(es)` 형태로 상태 전이를 명확히 기록

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataPixooLogs build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`
