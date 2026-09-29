# 2026-06-24 — Evaluation(APME) 재정의: 타임라인 분리 + turn→명시적 task + 스코어카드 추천 + tuner 제거

### 문제
원래 의도("특정 태스크를 어떤 에이전트/모델이 얼마나 잘 수행하는가"를 LLM-as-judge로 평가)가 노이즈에 묻힘. 3가지 근본 원인: ① 평가 단위(task)가 가장 불안정한 신호에 의존 — `todo_complete`(TodoWrite 전부완료) hook은 Claude Code v2.1에서 ~18%만 발화 + 발화해도 논리적 task를 파편화. 카테고리 분류는 async run 분류가 task 닫힌 뒤 도착해 `taskCategory=null`. ② 한 단위가 deterministic+turn+task+run = 최대 6개 `eval_result` row를 타임라인에 발행 → 활동 로그와 평가가 섞여 둘 다 더러움. ③ 페이오프 부재 — vibe 피드백(Stage 3)이 실사용에서 안 일어나 tuner·recommender가 死코드, "어느 모델이 뭘 잘하나" 결론을 아무도 소비 안 함.

### 해결 (4-phase, bridge Node + Swift 데몬 양쪽)
- **P1 타임라인 디노이즈**: `eval_result` 타임라인 row 발행 전부 제거(`daemon-server.ts` onResult 4블록 + `index.ts` 세션브리지 + Swift `handleApmeResult` appendEvalResultTimeline + 死헬퍼). **타임라인 = 활동 로그만(chat/tool/state).** eval은 `apme_eval` WS + SQLite/스코어카드로만. `broadcastApmeEval`/`updateTurn`은 보존.
- **P2 단위 재정의 (turn→명시적 task)**: `todo_complete`를 task 경계 → **non-segmenting soft hint 강등**(`state` sample 이벤트로만 기록). 이제 task는 명시적 경계(`/task close`·디바이스 버튼=manual, `/clear`)나 `session_end`에서만 분할. **카테고리를 closeTask에서 동기 확정**(`computeSignals`+`classify`, run.endedAt nil이라 duration은 task.startedAt에서 유도). `collector.ts` + Swift `ApmeCollector.swift` 미러.
- **P3 스코어카드 표면(페이오프)**: 추천기를 dashboard SPA에 **"Recommend" 탭**으로 연결 — `/apme/samples`(v_sample_scorecard: agent×model×category) 카테고리별 best 랭킹. 양 데몬이 `/apme` 서빙(WKWebView). vibe 👍/👎는 run detail에 이미 존재.
- **P4 死코드 정리**: tuner 완전 제거 — `tuner.ts`·`ApmeTuner.swift`·테스트 삭제, `/apme/tune` 라우트·CLI `apme tune`·`autoTune` 설정(Node+Swift)·DaemonServer retune 루프 제거.

### 핵심 설계 결정
- **타임라인 ≠ 평가 표면.** 평가를 활동 로그에서 완전히 분리하는 단 한 수가 "노이즈" 불만의 대부분을 해소. inert해진 `eval_result` 렌더러(tui/plugin/Apple/Android)는 타입 churn 회피 위해 남김(발행 0이라 무해).
- **신뢰 가능한 단위 우선.** turn(UserPromptSubmit→응답)이 시스템에서 가장 확실한 경계. task는 명시적·결정론적 경계로만. 불안정한 hook 의존 제거가 "태스크 단위 기록 부재"의 근본 해법.
- **Gotcha (CI 함정)**: `apple/AgentDeck/Resources/apme-dashboard.html`은 `dashboard-html.ts`의 raw 렌더가 **아니라** design-token-compliant 별도 미러(`verify-tokens-sync.py`가 css-root로 검사, body는 `var()`/`color-mix()`만). TS를 그대로 렌더하면 Design System CI가 깨짐 → 두 파일 각각 수정. xcodegen은 xcscheme도 재생성(downgrade)하니 scheme churn은 `git checkout HEAD`로 되돌릴 것.

---
