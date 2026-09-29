# 2026-04-03 — Creature Layout and Swim Lane Stabilization

### 문제
- 다중 세션일 때 크리처가 바닥 위에서 자연스럽게 줄지어 서지 못하고, 격자형 슬롯 때문에 서로 겹치거나 HUD 패널과 과도하게 충돌했다.
- WORKING 상태의 waypoint가 전역 swim bounds만 기준으로 잡혀 여러 크리처가 한쪽으로 몰리거나, 수면/지면 경계 가까이 과하게 움직였다.
- Pixoo 렌더러는 별도 golden-ratio X 배치를 써서 일반 terrarium과 다른 밀집 패턴을 보였다.

### 해결
- `CreatureLayout.swift`, `CreatureLayout.kt`
  - octopus / cloud / opencode 공통 `layoutBand` 슬롯 생성기로 교체
  - 한 줄 또는 2~3줄 staggered band로 배치해 자연스럽게 나란히 서도록 조정
  - 왼쪽 세션 패널과 오른쪽 상태 패널을 덜 침범하도록 X 범위를 더 보수적으로 조정
- `OctopusCreature.swift`, `OctopusCreature.kt`
  - WORKING 상태 waypoint를 전역이 아니라 creature별 local swim lane 안에서만 선택하도록 변경
  - current position clamp도 local lane 기준으로 조정
- `JellyfishCreature.swift`, `OpenCodeCreature.swift`
  - idle / waiting / pulsing 높이를 home slot 기준으로 따라가게 조정
  - 과도한 좌우 drift를 줄이고 home 주변의 좁은 범위로 제한
- `CloudCreature.kt`, `OpenCodeCreature.kt`
  - Android 쪽도 동일하게 local swim lane 개념 반영
- `PixooRenderer.swift`
  - golden-ratio 임의 X 배치를 제거하고 creature type별 공통 슬롯 레이아웃 사용
  - state별 Y만 별도 보정하되 slot 기반 분산을 유지

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataCreatureLayout build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`
- `./gradlew :app:compileDebugKotlin`
- 결과: 이번 변경분 에러는 해소됨. 현재 남은 실패는 기존 `EinkRenderer.kt`의 `PathParser`/delegate 관련 선행 오류뿐
