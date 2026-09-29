# 2026-06-25 — macOS Attention 오발 + 선택지 불일치: permission_mode / notification_type 게이팅

### 문제
macOS Dashboard 가 observed direct-`claude` 세션에 대해 (1) 묻지도 않은 상황에서 "Attention" 카드를 띄우고, (2) 띄울 때 보여주는 선택지가 에이전트의 실제 요청과 안 맞았다. 근본은 PTY 없는 observed 세션의 awaiting-state·options 를 **coarse hook 신호로 합성**한 것 — Claude Code 가 실제로 주는 정밀 필드를 무시.

### 해결 (Swift 데몬 + Node 브리지 parity)
- **gate 가드 (오발 #1)**: `handlePreToolUseHook` 가 device-approval 게이트로 Bash/Write/Edit/MultiEdit/NotebookEdit 를 전부 hold 했는데 `permission_mode` 를 안 읽음. PreToolUse 는 **모든** tool 호출마다 발화(acceptEdits/bypass/dontAsk/plan/allowlisted 라 Claude 가 안 묻는 경우 포함). 새 공유 술어 `shouldGate(permissionMode, tool)`: bypassPermissions/dontAsk/plan 은 게이트 안 함, acceptEdits 는 edit-family 만 skip(Bash 는 게이트), default/auto/unknown 만 게이트. Swift `DaemonServer.shouldGate` + Node `awaiting-overlay.ts::shouldGatePreToolUse`.
- **notification_type (오발 #2)**: Notification awaiting 을 free-text `message` 정규식 대신 `notification_type == "permission_prompt"` 로 판정(`isPermissionNotification`, 정규식은 구버전 Claude fallback). idle_prompt/auth_success/elicitation_* 가 더 이상 attention 을 켜지 않음.
- **stale options (불일치)**: `attentionOptions`(MonitorScreen+ControlTowerPanel)가 비-gated 세션에 aggregate `stateHolder.state.options` 를 빌려와 무관한 옛 프롬프트의 선택지를 dead 버튼으로 렌더. 이제 awaiting `state_update` 가 그 세션에 attribute 된 경우(`state.sessionId == session.id`)만 빌림 — observed 세션은 질문 + "respond in terminal" fallback.

### 핵심 설계 결정
- **coarse 합성 < Claude 정밀 신호.** hook 스크립트가 stdin 을 `-d @-` 로 그대로 포워드하므로 `permission_mode`·`notification_type` 가 이미 daemon 에 도달 — 안 읽었을 뿐. (Gotcha: 탐색 subagent 가 "permission_mode 는 PreToolUse 에 없다"고 오답 — AgentDeck 가 extract 안 한 것과 Claude 가 send 안 한 것을 혼동.)
- **게이트 잔여 한계**: 순수 default 모드 + allowlisted tool 은 여전히 게이트됨 — hook 은 Claude 의 allowlist 를 못 보고 `permission_mode` 만 봄. gated 경로의 device 응답은 `permissionDecision: allow/deny/ask` 만 가능 → Claude 의 3지선다("don't ask again") 표현 불가(binary Allow/Deny 는 device 가 결정자라 faithful).
- 동시 세션이 같은 트리에서 MicroGlyphs 리팩터 진행 중 → macOS 풀빌드는 그쪽 미완성으로 red(내 Swift 파일은 무관·컴파일 통과). 커밋은 temp-index `commit-tree` 로 내 7파일만 격리(daemon-server.ts 는 concurrent autoDiscover hunk 제외, 내 3 hunk 만).

---
