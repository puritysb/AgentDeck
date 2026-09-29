# 2026-03-10 — Usage API utilization 값 단위 불일치 수정

### 문제
LIMITS 게이지가 비정상 수치 표시. `extraUsageUtilization`이 84.47(%)인데 `* 100` → 8447%로 표시. Bridge `computeButtonState`에서도 `fiveHourPercent` 2(%)를 `* 100` → "200%" + 항상 빨간색(threshold `>= 0.9`).

### 해결
- `EinkStatusCompact.kt`: Extra 게이지 `extraPct * 100` → `extraPct` (이미 0-100 퍼센트)
- `bridge/index.ts` `computeButtonState`: `Math.round(pct * 100)` → `Math.round(pct)`, threshold `0.9/0.7` → `90/70`
- Plugin `usage-button.ts`는 원래 정상 (값을 직접 사용)

### 교훈 / 핵심 설계 결정
- **Anthropic OAuth Usage API `utilization` 필드는 0-100 퍼센트** (5h, 7d, extra 모두). 0-1 fraction이 아님
- **실제 API 응답을 확인하지 않고 코드 패턴만으로 단위를 추론하면 오류 발생** — bridge WS 캡처(`ws://127.0.0.1:{port}`)로 실측값 확인이 확실
- **`fiveHourPercent` 네이밍은 정확** — 이름대로 percent(0-100). `computeButtonState`가 이를 fraction(0-1)으로 잘못 취급한 것이 근본 원인

---
