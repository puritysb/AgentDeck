# 2026-08-04 — managed PTY interactive prompt lifecycle (#68)

### 문제
Claude Code가 option/permission UI를 띄운 채 status spinner를 계속 redraw하면
`OutputParser`가 spinner를 새 processing 신호로 받아 AWAITING을 취소했다. 과거
시도처럼 append-only buffer에서 `❯ 1.`을 다시 찾거나 고정 시간창을 재무장하면,
사용자가 이미 답한 뒤에도 오래된 prompt가 실제 processing을 영구 차단한다.

### 해결
- 현재 PTY chunk의 확정적 증거(`❯ <number>`, permission, diff)로만
  `interactivePromptActive`를 arm한다. 누적 buffer는 lifecycle 근거로 쓰지 않는다.
- managed PTY의 입력 경로를 `PtyManager`의 `input` 이벤트로 단일화하고 Claude
  parser에 전달한다. navigable prompt는 Enter/Esc/Ctrl+C, shortcut prompt는 실제
  shortcut 입력에서 lifecycle을 해제한다. 방향키 이동은 prompt를 유지한다.
- lifecycle이 active인 동안 spinner-only redraw는 무시하되, spinner와 prompt가
  첫 chunk에 함께 온 경우 prompt parser까지 계속 진행한다. idle/reset도 lifecycle을
  명시적으로 정리한다.

### 회귀 가드
같은 첫 chunk의 spinner+prompt, 80회 spinner flood, 선택 직후 실제 spinner,
stale numbered prose 비무장을 추가했다. focused 387 tests, 전체 2,381 tests와
workspace TypeScript 검사가 통과했다.

---
