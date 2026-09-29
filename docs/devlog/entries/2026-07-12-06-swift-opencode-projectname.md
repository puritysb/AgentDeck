# 2026-07-12 — Swift 데몬 opencode_* 인제스트 · projectName "/" 버그 수정

### 문제
- **OpenCode 미표시**: Swift 데몬만 실행 중일 때 standalone `opencode` TUI 세션이 대시보드에 안 보임. observer 플러그인(`agentdeck.js`)은 App Store 컨테이너 `daemon.json`+9120 폴백으로 Swift 데몬을 정상 발견해 `opencode_*`를 POST하고 있었으나(라이브 로그 194건 수신 확인) `DaemonServer.handleHookEvent`의 `if event.hasPrefix("opencode_") { return }` 드롭 필터가 유일 차단점. opt-in SSE observer(`openCodeMonitoringEnabled`, 기본 OFF)는 bare TUI의 ephemeral 포트를 발견할 수 없어(문서화된 한계) 훅이 유일한 신호였음. 필터 주석의 "PassiveSessionObserver가 커버" 주장은 오류 — Swift 트리에 그 컴포넌트 없음(Node 전용).
- **Codex App 프로젝트명 "/"**: Codex App **ambient/백그라운드 태스크**가 cwd `/`로 OTel 스팬을 보내면 `ProjectNameResolver.resolve`의 최종 폴백 `NSString.lastPathComponent`가 `/`를 그대로 반환(Node `basename('/')`→``''``→`'unknown'`과 발산) → 세션 행·타임라인 행에 리터럴 "/" 라벨(라이브 timeline.json 3건 확인). `ensureCodexSession` 업그레이드 경로가 "Codex App" 폴백명을 "/"로 덮어쓰기까지 함.

### 해결
- `ProjectNameResolver.resolve`: base=="/"면 "" 반환(미해결 취급) → 호출부 폴백("Codex App"/"OpenCode"/agent-tag)이 작동. Node와 라벨 발산 제거.
- `DaemonServer.handleHookEvent`: 드롭 필터 → `opencode_*` 인제스트로 교체. 세션 키 `opencode:<id>`(SSE observer와 동일 prefix로 수렴), switch 케이스 5종(session_start/user_prompt_submit/tool_start/tool_end/stop + forward-compat session_end), `openCodeTurnAnchors`(ChatTurnAnchorTracker 3번째 인스턴스) 기반 `appendOpenCodeChatStart/ToolEvent/ChatEnd` 타임라인 appender(agentType "opencode"), resurrection predicate(플러그인이 session_start를 프로세스당 1회만 announce하므로 mid-turn 훅도 재생성 허용 — Codex와 달리 companion-task 노이즈 없음), eviction 스윕 open-turn 강제 종료 분기. **APME collector 제외는 유지**(codex와 동일 — Claude-lifecycle 전용 모델).

### 검증
- `xcodebuild test -scheme AgentDeck_macOS -only-testing:ProjectNameResolverTests -only-testing:TerrariumCloudFoldTests` — 31/31 pass (신규: resolve("/")=="" · trailing-slash basename · opencode resurrection predicate).
