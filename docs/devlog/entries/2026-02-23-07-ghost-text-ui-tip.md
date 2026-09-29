# 2026-02-23 — Ghost Text 오탐: UI 크롬(Tip/단축키)이 추천으로 표시

### 문제
E2 Response Dial에 실제 ghost text 추천("show me the current git diff") 대신 Claude Code UI 요소가 표시:
1. **"Tip: Did you know you..."** — Claude Code 팁 메시지가 ❯ 라인에서 회색으로 렌더 → ghost text로 오탐
2. **"(ctrl+o to expand)(1m..."** — 단축키 힌트 + 상태줄 파편이 회색 세그먼트로 감지

원인: `detectGhostText` Strategy 2가 ❯ 프롬프트 라인의 **모든** 회색 ANSI 세그먼트를 무조건 수집. Claude Code가 팁/힌트를 같은 라인에 회색으로 렌더하면 ghost text와 함께 수집됨. `scheduleSuggestion` 500ms 디바운스에서 후속 chunk의 UI 크롬이 올바른 추천을 덮어씀.

### 해결

**1. 세그먼트 레벨 UI 크롬 필터 (`isUiChrome` 함수)**
회색 ANSI 세그먼트 수집 시 알려진 UI 패턴을 즉시 제외:
- `Tip:`, `Did you know` — Claude Code 팁
- `ctrl+`, `ctrl-`, `shift+` — 단축키 힌트
- `(\d+[mhs]` — 상태줄 시간 파편
- `to expand`, `to cycle`, `to confirm`, `to exit`, `to edit in` — 동작 힌트
- `? for shortcuts` — 바로가기 안내

**2. `scheduleSuggestion` 방어 필터 보강**
세그먼트 필터링을 우회하는 엣지 케이스 대비 동일 패턴 이중 검증.

**3. Stacked ANSI 시퀀스 처리 (`ANSI_TEXT_RE` + `hasGrayForeground`)**
- `ANSI_SEGMENT_RE` → `ANSI_TEXT_RE`: 연속 SGR 이스케이프 처리 (예: `\x1b[38;2;r;g;bm\x1b[3m`)
- `isGrayForeground` → `hasGrayForeground`: 결합 SGR 파라미터 파싱 (예: `2;90` = dim+bright black)

**4. Cross-chunk 감지 (Strategy 3)**
❯ 프롬프트와 ghost text가 별도 PTY chunk로 도착하는 경우: 버퍼의 마지막 가시 라인이 ❯로 시작하면 후속 chunk의 회색 텍스트를 프롬프트 라인 연속으로 인식.

### 교훈
- **❯ 라인은 ghost text만 있지 않다**: Claude Code TUI는 프롬프트 라인에 추천 텍스트 + 팁 + 단축키 힌트를 모두 회색으로 렌더. 색상만으로 ghost text를 구분할 수 없으며 콘텐츠 기반 필터 필수
- **디바운스가 오탐을 악화**: 올바른 추천이 먼저 감지되어도, 500ms 이내 UI 크롬이 다시 감지되면 타이머가 리셋되어 잘못된 텍스트로 덮어씀. 세그먼트 레벨에서 UI 크롬을 사전 차단하는 것이 디바운스 로직 수정보다 효과적
- **회색 세그먼트 = 일급 파서 이벤트가 아님**: 회색이라고 무조건 ghost text가 아니라, "❯ 라인의 회색 + UI 크롬이 아닌 것"이 ghost text

---
