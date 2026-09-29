# 2026-02-23 — Navigable Permission Prompt 다이얼 클릭 무반응

### 문제
Permission prompt에 `❯` 커서(navigable 모드)가 있을 때, 다이얼 회전(화살키)은 터미널에 반영되지만 다이얼 클릭(선택 확인)이 터미널에서 실행되지 않음. Stream Deck UI에서는 실행된 것으로 표시.

원인: `AWAITING_PERMISSION` 상태에서 다이얼 push → `respond` 커맨드로 shortcut 문자 전송 (e.g. `"y\r"`). Navigable TUI는 문자 입력을 받지 않고 Enter만 인식 → PTY가 `"y\r"` 무시. 하지만 브릿지 상태 머신은 `handleUserAction('respond')`로 즉시 PROCESSING 전환 → SD는 실행 완료로 표시 (상태 desync).

### 해결
Navigable permission/diff 프롬프트에서는 `respond`(shortcut 문자) 대신 `select_option`(화살키 + Enter) 사용:
1. **Plugin** (`option-dial.ts`): `handleTakeoverPush()` + `onDialDown()` — `navigable && AWAITING_PERMISSION/DIFF` 조건에서 `select_option` 전송
2. **Bridge** (`state-machine.ts`): `handleUserAction('select_option')` — AWAITING_PERMISSION/DIFF 상태도 처리
3. **Transitions** (`states.ts`): `user_selection` trigger에 AWAITING_PERMISSION/DIFF → PROCESSING 전이 추가

### 교훈
- **`respond` vs `select_option` 구분 기준**: 원래 permission=respond(shortcut), option=select_option(index)으로 구분했으나, 실제 구분 기준은 **navigable 여부**: navigable=select_option(Enter), non-navigable=respond(shortcut). Claude Code TUI가 `❯` 커서 모드를 더 넓은 범위의 프롬프트에 적용하면서 이 구분이 필요해짐
- **상태 desync 패턴**: PTY에 입력을 보내기 전에 상태 머신을 전환하면, PTY가 입력을 거부해도 UI는 이미 다음 상태. `respond`/`select_option` 모두 PTY write와 동시에 state transition하는 eager 패턴 — PTY 거부 시 stuck timeout이 복구 역할

---
