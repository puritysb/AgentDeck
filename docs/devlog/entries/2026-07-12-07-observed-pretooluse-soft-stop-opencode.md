# 2026-07-12 — Observed 세션 스티어링: 정밀 PreToolUse 게이트 복원 + soft STOP + 턴엔드 지시 큐 + OpenCode 직접 스티어링

### 배경
observed(직접 `claude`/`codex`/`opencode`, PTY 없음) 세션에 디바이스가 작동하는 것처럼 보이는 제어 버튼을 노출하던 P1(명령 조용한 드롭)의 근본 해결. hook은 단방향 알림이 아니라 **Claude Code가 데몬에 열어주는 동기 RPC 채널**(PreToolUse curl은 이미 `--max-time 60`+응답 echo 형태로 설치돼 있었음)이라는 점을 이용해, PTY 없이 스티어링 사다리를 구축.

### 스티어링 프리미티브 (Claude observed)
- **디바이스 승인 게이트 복원**: `/hooks/PreToolUse` 응답을 hold → 디바이스 `permission_decision`(allow/deny) 또는 타임아웃(기본 25s, `AGENTDECK_APPROVAL_HOLD_MS`). **과거 제거 사유(오발+선택지 날조)를 설계로 해소**: ① 날조 금지 — TUI 프롬프트 미러링 대신 디바이스 고유 의미론("Allow Bash: git push…?" 2버튼), ② 오발 금지 — hold 조건 전부 보수적(`shouldGatePreToolUse` 모드 게이트 + never-prompt/prompt-prone 도구셋 + **allowlist 예측**(user/project settings 4파일+managed policy 병합, 파싱실패·판독불가=hold 안함) + MCP 도구 제외 + 접속 클라이언트 0이면 제외 + 세션당 동시 1홀드), ③ **자동승인 학습기** — 홀드가 undecided로 릴리즈된 뒤 permission_prompt Notification 없이 tool_end가 오면(세션 "always allow"였음) 해당 시그니처(Bash=명령 앞 2토큰) 세션 내 재홀드 금지, ④ 타임아웃 폴백을 `ask`→**빈 응답(pass)** 으로 — `ask`가 allowlist를 우회해 강제 프롬프트를 띄울 가능성 원천 차단. 킬스위치 `AGENTDECK_OBSERVED_APPROVAL=0`.
- **Soft STOP**: 디바이스 interrupt → stop 플래그 → 다음 PreToolUse에서 `deny`+정지 지시. Ctrl+C는 아니지만 다음 툴 경계에서 확정 정지. user_prompt_submit/턴종료 시 자동 해제, TTL 10분.
- **턴엔드 지시 큐**: Stop hook을 request-response로 전환(installer `--max-time 10`+echo, migration 5) → 큐에 GO ON/REVIEW/COMMIT이 있으면 `{decision:"block",reason:지시}` 로 턴 연장 배달. 큐 캡 3, 턴당 1개 드레인, 빈 큐는 항상 정상 종료(stop_hook_active 루프 불가). **reason은 지시 텍스트라 슬래시 명령 실행 불가** → observed 프리셋은 자연어만, /clear 제외.

### OpenCode observed = near-managed
observer 플러그인(v2)이 in-process SDK `client`를 보유 → 데몬 명령 큐(`GET /opencode/commands?sid=` long-poll 25s)를 드레인해 `session.abort`(즉시 interrupt)/**`session.promptAsync`**(idle에도 프롬프트 주입; `session.prompt`는 턴 전체를 블로킹하므로 폴백에서만 non-await — sst/opencode 소스 검증) 실행. Node `opencode-steering.ts` + Swift `OpenCodeCommandQueue` 양데몬 동일 엔드포인트.
- **OpenCode 승인 게이트(무예측·무오발)**: 플러그인이 `permission.asked`/`permission.replied` 이벤트를 `opencode_permission_*` 훅으로 전달(서버가 **실제로 물어볼 때만** 발화 — Claude 게이트와 달리 예측 불필요). Swift가 세션 행에 `requestId="ocperm:<rawSid>:<permId>"`+awaiting 오버레이 → 디바이스 ALLOW/DENY → `permission_decision`이 큐로 `permission_respond`(allow→"once", deny→"reject") 배달 → 플러그인이 `postSessionIdPermissionsPermissionId` 실행. `permission.ask` 훅은 미발화 버그(sst/opencode #7006/#19927/#22558)로 이벤트+respond 엔드포인트 경로 채택.
- **codex observed는 전면 inert**: codex 훅은 notify 전용이라 스티어링 경로 없음 — D200H/SD observed UI를 steerable(claude/opencode)로 게이팅해 작동 불가 버튼 노출 방지. OpenCode observed는 idle에서도 inject-now 프리셋 활성.

### 디바이스 UI (P1 수정 포함)
- shared `d200h-layout.ts` + SD `session-slot-manager.ts`: observed 세션 detail을 capability 사다리로 게이팅 — awaiting+requestId→ALLOW/DENY, awaiting only→"answer in terminal", processing→soft STOP+큐 프리셋("at turn end" 부제), **idle→작동 불가 버튼 전부 제거**(inert STOP, OBSERVED 안내 타일). SD plugin `sendFocusedSessionCommand`가 observed도 `session_command`로 래핑(구 bare-fallback 드롭 제거). observed 상태는 릴레이가 아닌 sessions_list 행에서 직접 파생.
- `SessionInfo` 신규 필드 `stopRequested`/`queuedDirectives`(+기존 requestId 활용), `pnpm generate-protocol` 재생성.

### Swift 데몬 패리티
`ObservedSteering.swift`(actor: 게이트 continuation hold/soft stop/큐/학습기/룰 예측기) + `DaemonServer` 배선(async 핸들러가 hold를 자연스럽게 suspend). hook 생성 세션 5곳에 `controlMode:"observed"` 태깅(디바이스 게이팅의 전제). **샌드박스 정밀도**: 룰 예측기는 `~/.claude`·`<cwd>/.claude` 디렉토리 리스팅이 성공해야만(양성 판독 증명) 게이트 활성 — App Store 샌드박스에서는 자동 비활성(soft STOP/큐/표시는 유지, 둘 다 사용자 개시라 오발 불가). `permission_decision`은 observed 게이트 우선→OpenClaw exec-approval 폴백. observed `session_command` 인터셉트는 gateway 소비 블록 **앞**에 배치.

### 검증
- vitest 97파일 1745/1745 (신규: `observed-steering.test.ts` 정밀도 스위트 — allowlist/모드/safe-tool/MCP/파싱실패/학습기 케이스 전수, `d200h-observed.test.ts` — codex-inert·opencode inject·ocperm 게이트 포함, `opencode-steering.test.ts`; `permission-resolver.test.ts`는 pass-through 신계약으로 갱신). 커버리지 임계 통과. OpenCode SDK 표면은 sst/opencode@dev(≈v1.17.x) 소스 대조 검증.
- `xcodebuild -scheme AgentDeck_macOS build` — BUILD SUCCEEDED.
- design lint 905 = 변경 전과 동일(신규 위반 0).
- 실기 디바이스(SD/D200H) 라이브 검증은 앱·플러그인 재시작 필요 — 미실시.
