# 2026-02-22 — iTerm Dial "No sessions" 순간 깜빡임 수정

### 문제

가끔 "No sessions"가 순간적으로 표시됨. 두 가지 원인:

1. **`updateItermDialState`가 매 state 업데이트마다 `currentLayout = ''` 리셋**
   → `ensurePixmapLayout()`이 항상 `setFeedbackLayout` 호출
   → SD 하드웨어가 레이아웃 전환 중 순간 클리어 → 빈 화면/No sessions 플래시

2. **`onWillAppear`에서 sessions 없는 상태로 즉시 render**
   → "No sessions" 첫 프레임 표시 후 fetch 완료 시 업데이트

### 수정

- `updateItermDialState`에서 `currentLayout = ''` 제거 — state 변경이 레이아웃을 바꾸지 않음
- `resetItermLayout()` 함수 추가 — encoder takeover exit 시에만 명시적 호출
- `encoder-takeover.ts` exit에서 `resetItermLayout()` 연결 (`resetEncoderLayouts()` 직후)
- `onWillAppear`: sessions 캐시 있으면 즉시 표시, 없으면 fetch 완료 후에만 render

### 핵심 패턴

레이아웃 리셋은 실제로 레이아웃이 변경되는 시점(takeover enter/exit)에만 수행해야 함. 일반 state 업데이트에서 레이아웃을 리셋하면 SD 하드웨어가 불필요한 레이아웃 전환을 수행해 깜빡임 발생.

### Files

| File | Action |
|------|--------|
| `plugin/src/actions/iterm-dial.ts` | Modified — currentLayout 리셋 제거, resetItermLayout 추가, onWillAppear 플래시 수정 |
| `plugin/src/encoder-takeover.ts` | Modified — resetItermLayout 연결 |

---
