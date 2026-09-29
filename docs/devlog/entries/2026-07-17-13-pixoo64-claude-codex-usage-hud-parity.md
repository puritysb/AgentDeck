# 2026-07-17 — Pixoo64 Claude/Codex usage HUD parity

### 문제
- Pixoo64는 Claude 한도만 하단 7px 숫자 HUD(사용률 배경 + 리셋 카운트다운)로 표현하고 Codex primary/secondary는 그 위 2개의 1px rail로 덧붙였다. 동일한 rate-limit 정보가 서로 다른 계층처럼 보여 출처와 의미가 불명확했고 Codex 리셋까지 남은 시간도 누락됐다.

### 해결
- 하단을 7px provider row 두 개로 통일했다. 문자 키 대신 `design/brand/*.svg`에서 생성된 공식 마스크를 9×7 크리처 실루엣으로 직접 축소해 출처를 표시하고, 두 행 모두 primary/5h 왼쪽·secondary/7d 오른쪽에 동일한 사용률 fill·퍼센트·reset countdown 문법을 쓴다. 한 provider만 있으면 맨 아래 한 행만 사용한다.
- 좁은 29px zone에서 `100%`와 시간이 충돌할 때만 `1h23`을 `1h`처럼 축약하며, 평소에는 기존 상세 카운트다운을 유지한다. Claude stale과 Codex window stale은 서로 독립적으로 숨겨 fresh provider까지 함께 사라지지 않게 했다.
- Node/Swift 렌더러와 creature simulator 입력을 같은 구조로 맞추고, 두 provider 행 모두에 reset-time 픽셀이 존재하는 회귀 테스트를 추가했다.
