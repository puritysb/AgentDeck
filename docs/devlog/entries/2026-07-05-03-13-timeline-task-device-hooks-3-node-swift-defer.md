# 2026-07-05 — 라운드 13: timeline task 그룹핑을 device 표면에 노출 (데몬 /hooks/ 3중버그 + Node·Swift deferred emit parity)

### 증상 (사용자 관찰)
진행 중인 세션에 후속 프롬프트를 넣으면 timeline에 **매번 새 task처럼** 표시됨. 의도는 "완결성 있는 작업 단위로 묶여서" 보이는 것.

### 진단
- APME 데이터 모델(`apme.sqlite`)은 **의도대로 그룹핑 중**(후속 프롬프트 = 같은 task에 turn 추가, `/clear`·`session_end`에서만 분절). 실증: 한 task에 6턴.
- 그러나 사용자가 보는 device timeline(`timeline.json`)엔 task_start/task_end **0개, taskId 0개** — 그룹핑이 표면에 안 실림. `AGENTDECK_TIMELINE_PROJECTION`도 off(기본).
- 근본원인 3중(Node `daemon-server.ts` `/hooks/` 직접경로):
  1. **event name case mismatch(치명)**: collector `ingestHook`은 PascalCase `'UserPromptSubmit'` 매칭인데 데몬은 snake_case `mapped` 전달 → 턴오픈 영구 no-op → task 미생성.
  2. **단일 `'daemon-hook'` 버킷**: 모든 직접실행이 한 sessionId로 뭉침 → 동시세션 뒤섞임 + 한 세션 session_end가 남의 run 파괴.
  3. **openRun이 session_start에서만**: 누락/late 시 `ingestHook`이 run 없음으로 no-op.

### 수정 (Node)
- `collector.ts`: `normalizeHookEventName()`로 case-tolerant(snake↔Pascal). **deferred task_start** 이식 — 단발 Q&A엔 헤더 없음, 2번째 턴/첫 TodoWrite plan에 `emitDeferredTaskStartIfNeeded()` 승격(backdated). `ActiveTask.timelineEmitted` 플래그로 task_end emit 게이팅.
- `apme/index.ts`: `promotedTaskIds` Set로 sync/async(judge 재emit) task_end 게이팅 — 미승격 단발 task의 orphan end 방지, eval enqueue는 항상.
- `daemon-server.ts` `/hooks/`: real `json.session_id` 키잉 + lazy openRun(run 없고 event=session_start|user_prompt_submit일 때만; stray tool/stop hook은 phantom run 방지 제외) + `/clear`→`splitRun` + chat_start를 collector 처리 **후** `getActiveTaskId()`로 taskId 태깅.
- `fallback-task-timeline.ts`: `getActiveTaskId()` 추가.
- 관리 세션브리지는 `BridgeCore.setAttributor`(bridge-core.ts:230)가 이미 자동 taskId 태깅 → 무변경.

### 수정 (Swift parity — 이미 collector 포트+deferred emit 완비)
- `DaemonServer.swift`: `appendClaudeCodeChatStart`에 taskId(collector를 switch 전 hoist=`apmeHandledEarly`, 후 double-run skip).
- `ApmeCollector.swift`: **idleGapSec 90s→1800s** — 90초 idle 자동종료가 생각멈춤마다 task를 파편화(사용자 의도 정반대)했음. 30분 backstop은 abandoned 세션만 닫고 정상 세션은 안 건드림(Node는 idle-gap 없이 session_end까지 그룹). lazy openRun(user_prompt_submit 한정).

### 구조 원칙
task 그룹핑은 **UserPromptSubmit/SessionEnd/clear 훅으로만** 결정 — TTY 파싱 무의존(agent CLI TUI가 바뀌어도 안 흔들림). TTY 파싱은 Claude chat_response/chat_end 턴종료에만 load-bearing으로 잔존(Stop훅 ~18% 신뢰도). Swift는 TTY 파싱 전무.

### 검증
- Node: `pnpm build` 통과, vitest 1603 통과(+deferred/grouping/lazy-open 신규 3), 격리데몬(alt port+`AGENTDECK_DATA_DIR`)에 curl 훅 시퀀스 → WS `query_session_timeline`로 실측: multi-turn=`task_start`1개+chat 3개 동일 taskId+`task_end`, single-turn=헤더 없음. stray tool/stop hook이 phantom run 안 만듦 확인.
- Swift: macOS 타깃 `xcodebuild ... test` BUILD SUCCEEDED, ApmeTaskBoundaryTests 45 + CategoryE2E 58 + Timeline 3 통과(+lazy-open 신규).
- **적용**: 사용자 데몬은 재시작해야 새 빌드 반영(`agentdeck daemon stop && agentdeck daemon start` 또는 LaunchAgent 재시작).
