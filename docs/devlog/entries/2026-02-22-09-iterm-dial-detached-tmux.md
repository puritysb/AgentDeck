# 2026-02-22 — iTerm Dial: Detached Tmux 고스트 세션 버그 수정

### 문제
iTerm 다이얼(E3)에 실제 터미널 창보다 많은 세션이 표시됨. Bridge crash 후 sessions.json에 남은 stale 엔트리가 🔌 detached 항목으로 잘못 생성되고, tmux -CC 모드에서 TTY 매칭 실패로 attached 세션이 detached로 오판됨.

### 해결
3중 검증 추가:
1. **PID 검증** — `loadAgentDeckSessions()`에서 `process.kill(pid, 0)`으로 죽은 프로세스 필터링
2. **tmux 세션 실존 검증** — `getLiveTmuxSessionNames()` (`tmux list-sessions`)로 죽은 tmux 세션 제외
3. **tmux client 매칭** — `getTmuxSessionMap()`의 client TTY를 iTerm TTY와 교차 검증하여 attached 상태 정확히 판별

리뷰 후 `syncFromSystem()`에서 `getTmuxSessionMap`, `loadAgentDeckSessions`의 중복 호출 제거 — `appendDetachedTmux`를 순수 함수로 변경하고 상위에서 한 번만 fetch하여 context로 주입.

### 교훈
- Plugin 측에서도 sessions.json의 PID liveness를 검증해야 함 (bridge 측 pruning에만 의존 불가)
- 2초 폴링 함수에서 shell exec 중복은 누적 비용이 크므로 데이터를 한 번 fetch → 여러 곳에서 재사용하는 패턴 적용

### 후속: Ghost 세션 감지 및 re-attach (047a51d)
브릿지 종료 후 tmux 세션이 살아있으면 iTerm -CC 윈도우가 고스트로 잔류. `syncFromSystem()`에서 `bridgedTmuxNames`(살아있는 브릿지의 tmux 이름)와 비교하여 ghost 마킹(`⚠` prefix + `isGhost`/`tmuxName` 필드). Push 시 `attachTmuxInIterm()`으로 새 윈도우에서 re-attach.

---
