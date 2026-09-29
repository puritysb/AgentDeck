# 2026-07-17 — 세션 상태 오표시 2건: TTL 사다리에서 누락된 claude, 턴마다 지워진 opencode dedup

### 문제
데크가 실제와 반대되는 세션 상태를 보였다. 방향은 정반대인데 둘 다 "조용한 세션을 어떻게 해석하는가" 의 문제였다.

1. **활발히 작업 중인 standalone `claude` 세션이 "멈춤" 으로 표시**됐다가 잠시 뒤 되살아났다. 실측: 세션 `a690b039` 가 서브에이전트 3개를 기다리며 180 초 조용해지자 evict 됐고, 5 초 뒤 다음 `tool_start` 에서 부활했다.
2. **끝난 standalone `opencode` 세션이 "작업중" 으로 고착**돼 30 분 idle TTL 이 행을 걷어낼 때까지 풀리지 않았다. 실측: `ses_0929a5bc` 가 같은 초에 `opencode_stop` 과 `opencode_user_prompt_submit` 을 남기고 13 분간 무음 — 그동안 opencode 프로세스는 프롬프트에서 놀고 있는데 행은 processing 을 주장했다.

### 해결
- **claude 는 TTL 사다리의 어느 분기에도 걸리지 않았다** (2ea847ca). codex 는 `codexInteractiveIdleTTL` + tool-aware companion 창을, opencode 는 `openCodeIdleTTL` (d330778d) 을 받았지만 claude-code 만 매칭 없이 180 초 `pushedSessionStaleTTL` 로 떨어졌다 — 데몬이 그 판단 시점에 `state=processing`, `currentTool=Bash` 를 손에 쥐고 있는데도. Claude Code 는 훅을 SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/Notification/SessionEnd 에서만 쏘므로 **180 초보다 긴 툴 호출 하나면 그 사이 아무것도 emit 되지 않는다** (긴 빌드, 테스트 런, 서브에이전트 팬아웃). eviction 은 파괴적이다 — 합성 `chat_end` 로 열린 턴을 강제 종료하므로 타임라인이 "턴이 끝났다" 고 거짓 주장하고 모든 표면이 행을 떨군다. claude-code 에 동일한 30 분 interactive backstop 을 부여했다.
- **opencode 는 `session.idle` 핸들러가 자기가 필요로 할 dedup 엔트리를 지우고 있었다** (aa682120). `sendPrompt` 는 user messageID 로 `promptSent` dedup 하는데, settle 중인 세션의 바로 그 엔트리를 삭제했다. OpenCode 는 턴이 정착할 때 user message 의 `message.updated` 를 재발행하고, dedup 엔트리가 사라진 상태의 그 후행 업데이트가 `sendPrompt` 를 다시 불러 `opencode_user_prompt_submit` 을 재전송했다. 데몬은 이를 `state=processing` + phantom turn (`appendOpenCodeChatStart`) 으로 매핑한다. 세션은 이미 idle 이라 이를 닫아줄 `session.idle` 이 뒤따르지 않았고 행은 그대로 굳었다. messageID 는 재제출되지 않으므로 `userMsgs`/`promptSent` 는 순수 dedup 메모리이고 **턴보다 오래 살아야 한다** — 턴마다 비운 것이 버그였지 경계가 버그가 아니었다. `toolPhase` cap 을 미러해 추가 시점에 cap 한다.
- **TTL 추측의 근거였던 거짓 전제를 정정**했다 (040f8c2d, 주석 전용). `codexInteractiveIdleTTL` 주석은 샌드박스가 `ps` 를 막아 "Node 데몬과 달리 프로세스 테이블에 liveness 를 기댈 수 없다" 고 서술했다. 틀렸다 — 막히는 것은 `ps` **spawn** (서브프로세스, App Store 2.5.2) 뿐이고 sysctl 은 아니다. `ProcessEnumerator` 가 바로 이 데몬에서 이미 KERN_PROC_ALL + KERN_PROCARGS2 를 읽고 `LocalCodexAppObserver` 가 프로덕션에서 호출한다. 샌드박스 테스트 호스트에서 실측: **642 개 프로세스 열거, 모든 에이전트 CLI 가 pid·시작시각·argv 와 함께 보였다.**

### 검증
- ladder 순수 함수 테스트 8 종 신규 + macOS 전체 424 통과.
- opencode: 기존 테스트는 이벤트 **이름** 만 고정해 시퀀싱 버그를 원리적으로 못 잡으므로, 실제 플러그인 body 를 구동해 이벤트를 흘리는 커버리지를 새로 썼다. 수정 전 핸들러에 대해 먼저 **failing 확인** (user_prompt_submit 2 회 post, 기대 1 회).
- 두 버그 모두 로그 실측 세션 (`a690b039`, `ses_0929a5bc`) 에서 관측 후 수정.

### 핵심 설계 결정
- **새 에이전트를 붙일 때 TTL 사다리 분기는 필수다.** 이 버그의 형태는 "잘못된 값" 이 아니라 "분기 없음 → 조용한 fallback" 이었다. 매칭 실패가 가장 공격적인 창(180 초)으로 떨어지는 구조라 새 에이전트일수록 위험하다. 사다리를 순수 함수로 바꿔 **ORDER 자체를 테스트**한다 — awaiting 이 per-agent TTL 보다 계속 우선해야 하며, 안 그러면 권한 프롬프트가 사용자의 판단 도중에 evict 된다 (`awaitingHookStaleTTL` 이 존재하는 이유).
- **로그가 조사를 오도했다.** eviction 로그 줄이 `pushedSessionStaleTTL` 을 리터럴로 재진술해, 실제로는 30 분을 받은 opencode·interactive codex 행에도 "no hook in 180s" 를 찍었다. 이제 실제 적용된 TTL 과 agentType 을 보고한다. 이 낡은 줄이 이번 조사를 이미 적용되지 않는 창으로 몰아갔다.
- **opencode 는 데몬 측 settle 타이머가 아니라 플러그인에서 고쳤다.** 데몬은 놓친 stop 과 정당하게 긴 조용한 턴을 구별할 수 없고, 그 추측으로 행을 걷어내는 것이 이틀 전 d330778d 가 opencode 에 대해 고친 바로 그 실패다.
- **진짜 제약은 가시성이 아니라 귀속(attribution)이다.** 훅은 session_id 를 싣고 CLI 의 pid 는 절대 싣지 않으며, 동시 실행되는 claude 프로세스들은 argv 로 구분되지 않는다 (전부 argv0 == "claude"). 이를 해제할 조건($PPID 를 훅 스니펫이 싣는 것)까지 주석에 남겨, 다음 사람이 존재하지 않는 제약을 물려받지 않게 했다.
- **진짜 ghost 빈도는 아직 측정되지 않았다 — 출하 후로 미룬다.** 전체 집계는 eviction 175 회였으나 그 **대부분이 위에서 고친 false positive** 였다. (세션 중 "session_end 75 회이므로 ghost 는 드물다" 고 판단한 순간이 있었는데, 로그 tail 만 본 오판이었다.) 2ea847ca 이후로는 false positive 가 사라졌으므로 **이후 로그에 남는 eviction = 진짜 ghost** 다. 0.2.3 출하 후 `Evicted stale session` 을 distinct sid 대비 반복 횟수로 세어 유의미하면 $PPID 작업에 착수한다 — 단 $PPID 가 정말 claude pid 인지 (셸이 손자면 틀어진다) 검증이 선행돼야 한다. ⚠ "claude 프로세스 0 개면 evict" 대안은 `processSnapshots()` 가 **실패 시에도 `[]` 를 반환**하므로 살아있는 세션을 전부 지울 수 있다.
